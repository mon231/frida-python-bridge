namespace Python {
    // CPython start tokens.
    const Py_single_input = 256;
    const Py_file_input = 257;
    const Py_eval_input = 258;

    let _builtins: PyObject | undefined;

    /** Borrowed `__main__` globals dict. */
    function mainDict(): NativePointer {
        const api = getApi();
        const mod = api.PyImport_AddModule(Memory.allocUtf8String("__main__")) as NativePointer;
        return api.PyModule_GetDict(mod) as NativePointer;
    }

    /** Import a module, returning a wrapped PyObject. */
    export function importModule(name: string): PyObject {
        const api = getApi();
        const ret = api.PyImport_ImportModule(Memory.allocUtf8String(name)) as NativePointer;
        checkError();
        if (ret.isNull()) throw new Error(`could not import '${name}'`);
        return wrap(new PyObject(ret, { owned: true }));
    }

    /** Try to import a module; return its raw handle (owned) or null without throwing. */
    function tryImport(name: string): NativePointer | null {
        const api = getApi();
        const ret = api.PyImport_ImportModule(Memory.allocUtf8String(name)) as NativePointer;
        if (ret.isNull()) {
            api.PyErr_Clear();
            return null;
        }
        return ret;
    }

    /** The wrapped `builtins` module (cached). */
    export function getBuiltins(): PyObject {
        if (_builtins === undefined) {
            const api = getApi();
            const ret = api.PyImport_ImportModule(Memory.allocUtf8String("builtins")) as NativePointer;
            checkError();
            _builtins = new PyObject(ret, { owned: true });
        }
        return wrap(_builtins);
    }

    /**
     * Resolve a dotted path to a class/callable/value, like `Java.use`. Imports the
     * longest importable module prefix, then walks attributes for the remainder.
     */
    export function use(dottedName: string): PyObject {
        const parts = dottedName.split(".");

        let baseHandle: NativePointer | null = null;
        let baseOwned = false;
        let consumed = 0;

        for (let i = parts.length; i >= 1; i--) {
            const h = tryImport(parts.slice(0, i).join("."));
            if (h !== null) {
                baseHandle = h;
                baseOwned = true;
                consumed = i;
                break;
            }
        }

        if (baseHandle === null) {
            // Not a module path; resolve from builtins (e.g. Python.use("len")).
            const api = getApi();
            const b = api.PyImport_ImportModule(Memory.allocUtf8String("builtins")) as NativePointer;
            checkError();
            baseHandle = b;
            baseOwned = true;
            consumed = 0;
        }

        let current = new PyObject(baseHandle, { owned: baseOwned });
        for (let j = consumed; j < parts.length; j++) {
            const next = current.$get(parts[j]);
            current.$dispose();
            current = next;
        }
        return wrap(current);
    }

    /** Evaluate a single expression; returns a wrapped PyObject (or JS value if toJS). */
    export function evalExpression(expr: string, opts?: { toJS?: boolean }): any {
        const api = getApi();
        const g = mainDict();
        let ret: NativePointer;
        if (api.PyRun_StringFlags !== undefined) {
            ret = api.PyRun_StringFlags(Memory.allocUtf8String(expr), Py_eval_input, g, g, NULL) as NativePointer;
        } else {
            ret = evalViaBuiltins(expr).handle;
        }
        checkError();
        if (ret.isNull()) throw new Error("eval failed");
        const obj = new PyObject(ret, { owned: true });
        if (opts && opts.toJS) {
            const v = obj.$toJS();
            obj.$dispose();
            return v;
        }
        return wrap(obj);
    }

    /** Execute statements (no value returned). Runs in `__main__` unless `globals` given. */
    export function exec(code: string, globals?: PyObject): void {
        const api = getApi();
        const g = globals !== undefined ? unwrap(globals).handle : mainDict();
        if (api.PyRun_StringFlags !== undefined) {
            const ret = api.PyRun_StringFlags(Memory.allocUtf8String(code), Py_file_input, g, g, NULL) as NativePointer;
            checkError();
            if (!ret.isNull()) api.Py_DecRef(ret);
            return;
        }
        // Compile + eval fallback.
        const codeObj = api.Py_CompileStringExFlags(
            Memory.allocUtf8String(code),
            Memory.allocUtf8String("<frida>"),
            Py_file_input,
            NULL,
            -1
        ) as NativePointer;
        checkError();
        if (codeObj.isNull()) throw new Error("compile failed");
        const ret = api.PyEval_EvalCode(codeObj, g, g) as NativePointer;
        api.Py_DecRef(codeObj);
        checkError();
        if (!ret.isNull()) api.Py_DecRef(ret);
    }

    /** Portable eval path for stable-ABI/limited hosts lacking PyRun_*. */
    function evalViaBuiltins(expr: string): PyObject {
        const api = getApi();
        const builtins = getBuiltins();
        const g = mainDict();
        const gWrapped = new PyObject(g, { owned: false });
        const result = (builtins as any).eval(expr, gWrapped);
        return unwrap(result);
    }

    /**
     * Raise KeyboardInterrupt in the interpreter at the next signal check (abort a
     * runaway eval). Requires PyErr_SetInterruptEx (3.10+).
     */
    export function interrupt(): void {
        const api = getApi();
        if (api.PyErr_SetInterruptEx !== undefined) {
            api.PyErr_SetInterruptEx(2 /* SIGINT */);
        } else {
            throw new Error("frida-python-bridge: interrupt() requires CPython >= 3.10");
        }
    }

    // Facade aliases.
    Object.defineProperty(Python, "builtins", { get: () => getBuiltins(), configurable: true, enumerable: true });
    (Python as any).eval = evalExpression;
    (Python as any).import = importModule;
}

declare namespace Python {
    /** The wrapped `builtins` module. */
    const builtins: PyObject;
    /** Evaluate a single expression. Alias of {@link evalExpression}. */
    function eval(expr: string, opts?: { toJS?: boolean }): any;
}
