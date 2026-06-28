namespace Python {
    /** Handle for an installed interception; call {@link PythonHook.revert} to remove it. */
    export interface PythonHook {
        /** The original (unhooked) callable, wrapped. */
        readonly original: PyObject;
        /** Restore the original callable. Idempotent. */
        revert(): void;
    }

    /** A handler invoked when a hooked callable is called. */
    export type HookHandler = (args: PyObject[], original: PyObject) => any;

    const METH_VARARGS = 0x0001;

    // Keep trampolines/method-defs alive while installed (prevents GC of NativeCallback).
    const activeHooks = new Set<object>();
    let factoryInstalled = false;

    /** Install the Python-side wrapper factory in __main__ (once). */
    function ensureFactory(): void {
        if (factoryInstalled) return;
        exec(
            [
                "def __frida_make_hook(_t, _orig):",
                "    def __frida_wrapper(*a, **k):",
                "        return _t(_orig, a, k)",
                "    try:",
                "        import functools",
                "        __frida_wrapper = functools.wraps(_orig)(__frida_wrapper)",
                "    except Exception:",
                "        pass",
                "    return __frida_wrapper",
                "",
            ].join("\n")
        );
        factoryInstalled = true;
    }

    /** Borrowed lookup of a name in the __main__ dict. */
    function mainDictGet(name: string): NativePointer {
        const api = getApi();
        const mod = api.PyImport_AddModule(Memory.allocUtf8String("__main__")) as NativePointer;
        const dict = api.PyModule_GetDict(mod) as NativePointer;
        return api.PyDict_GetItemString(dict, Memory.allocUtf8String(name)) as NativePointer;
    }

    /**
     * Replace `target.name` with an interceptor that invokes `handler(args, original)`.
     * Works for module functions, class (instance) methods, and static/class methods.
     *
     * - Return a value (or PyObject) from the handler to override the result.
     * - Return `undefined` to transparently call the original with the same args.
     *
     * @example
     * Python.perform(() => {
     *   const app = Python.import("app");
     *   const h = Python.intercept(app, "greet", (args, original) => {
     *     console.log("greet called with", args[0].$str());
     *     return original(...args);            // call through
     *   });
     *   // ... later: h.revert();
     * });
     */
    export function intercept(target: PyObject, name: string, handler: HookHandler): PythonHook {
        const api = getApi();
        ensureFactory();

        const targetObj = unwrap(target);
        const original = targetObj.$get(name); // owned wrapper

        // Build the native trampoline (called by Python as a builtin function).
        const callback = new NativeCallback(
            ((_self: NativePointer, args: NativePointer): NativePointer => {
                try {
                    const origH = api.PyTuple_GetItem(args, 0) as NativePointer; // borrowed
                    const callArgs = api.PyTuple_GetItem(args, 1) as NativePointer; // borrowed tuple
                    const callKwargs = api.PyTuple_GetItem(args, 2) as NativePointer; // borrowed dict

                    const argc = (api.PyTuple_Size(callArgs) as Int64 | number) as any;
                    const n = typeof argc === "number" ? argc : (argc as Int64).toNumber();
                    const jsArgs: PyObject[] = [];
                    for (let i = 0; i < n; i++) {
                        const item = api.PyTuple_GetItem(callArgs, i) as NativePointer; // borrowed
                        jsArgs.push(wrap(new PyObject(item, { owned: false })));
                    }
                    const origWrapped = wrap(new PyObject(origH, { owned: false }));

                    const result = handler(jsArgs, origWrapped);

                    if (result === undefined) {
                        // Transparent pass-through to the original.
                        return api.PyObject_Call(origH, callArgs, callKwargs) as NativePointer;
                    }
                    if (result != null && (result as any).__pyobject instanceof PyObject) {
                        const h = (result as any).__pyobject.handle as NativePointer;
                        api.Py_IncRef(h);
                        return h;
                    }
                    if (result instanceof PyObject) {
                        api.Py_IncRef(result.handle);
                        return result.handle;
                    }
                    return toPyHandle(result);
                } catch (e: any) {
                    const msg = `frida-python-bridge hook error: ${e && e.message ? e.message : String(e)}`;
                    api.PyErr_SetString(api.PyExc_RuntimeError, Memory.allocUtf8String(msg));
                    return NULL;
                }
            }) as any,
            "pointer",
            ["pointer", "pointer"]
        );

        // PyMethodDef { ml_name, ml_meth, ml_flags, ml_doc }.
        const namePtr = Memory.allocUtf8String(`frida_hook_${name}`);
        const methodDef = Memory.alloc(Process.pointerSize * 4);
        methodDef.writePointer(namePtr);
        methodDef.add(Process.pointerSize).writePointer(callback);
        methodDef.add(Process.pointerSize * 2).writeInt(METH_VARARGS);
        methodDef.add(Process.pointerSize * 3).writePointer(NULL);

        const trampoline = api.PyCFunction_NewEx(methodDef, NULL, NULL) as NativePointer;
        checkError();

        // wrapper = __frida_make_hook(trampoline, original)
        const factory = mainDictGet("__frida_make_hook");
        api.Py_IncRef(original.handle);
        const argsTuple = tupleFromHandles([trampoline, original.handle]); // steals both
        const wrapperH = api.PyObject_CallObject(factory, argsTuple) as NativePointer;
        api.Py_DecRef(argsTuple);
        checkError();

        // setattr(target, name, wrapper)  -- use the real attribute name, not the C method name
        const rc = api.PyObject_SetAttrString(targetObj.handle, Memory.allocUtf8String(name), wrapperH) as number;
        api.Py_DecRef(wrapperH);
        if (rc !== 0) checkError();

        // Keep native resources alive for the lifetime of the hook.
        const keepAlive = { callback, methodDef, namePtr, original };
        activeHooks.add(keepAlive);

        let reverted = false;
        return {
            original: wrap(original),
            revert() {
                if (reverted) return;
                reverted = true;
                performNow(() => {
                    const setRc = api.PyObject_SetAttrString(
                        targetObj.handle,
                        Memory.allocUtf8String(name),
                        original.handle
                    ) as number;
                    if (setRc !== 0) checkError();
                });
                activeHooks.delete(keepAlive);
            },
        };
    }
}
