namespace Python {
    /**
     * A live `PyObject *` handle. Owns exactly one reference: it takes/holds a ref on
     * construction and releases it (`Py_DecRef`, under the GIL) when GC'd, on script
     * unload, or via {@link PyObject.$dispose}.
     *
     * Prefer the Proxy-wrapped form (returned by `Python.eval/use/import/...`) for
     * ergonomic attribute access and calling; the `$`-prefixed methods are the explicit
     * API and never collide with real Python attribute names.
     */
    export class PyObject extends NativeStruct {
        private weakId = -1;
        private disposed = false;

        constructor(handle: NativePointer, opts?: { owned?: boolean }) {
            super(handle);
            if (!handle.isNull()) {
                const api = getApi();
                if (!(opts && opts.owned)) api.Py_IncRef(handle);
                this.weakId = Script.bindWeak(this, makeFinalizer(handle));
            }
        }

        /** Get an attribute (`getattr`). Returns a raw owned PyObject. */
        $get(name: string): PyObject {
            const api = getApi();
            const ret = api.PyObject_GetAttrString(this.handle, Memory.allocUtf8String(name)) as NativePointer;
            checkError();
            if (ret.isNull()) throw new Error(`attribute '${name}' is null`);
            return new PyObject(ret, { owned: true });
        }

        /** Set an attribute (`setattr`). */
        $set(name: string, value: any): void {
            const api = getApi();
            const h = toPyHandle(value);
            const rc = api.PyObject_SetAttrString(this.handle, Memory.allocUtf8String(name), h) as number;
            api.Py_DecRef(h);
            if (rc !== 0) checkError();
        }

        /** Whether the attribute exists (`hasattr`). */
        $hasAttr(name: string): boolean {
            const api = getApi();
            return (api.PyObject_HasAttrString(this.handle, Memory.allocUtf8String(name)) as number) !== 0;
        }

        /** Call this object. A trailing {@link KwArgs} (from `Python.kw`) becomes kwargs. */
        $call(...args: any[]): PyObject {
            const api = getApi();
            if ((api.PyCallable_Check(this.handle) as number) === 0) {
                throw new Error("PyObject is not callable");
            }
            let kwargs: NativePointer = NULL;
            let positional = args;
            if (args.length > 0 && args[args.length - 1] instanceof KwArgs) {
                kwargs = toPyHandle((args[args.length - 1] as KwArgs).map);
                positional = args.slice(0, -1);
            }
            const tuple = tupleFromHandles(positional.map(a => toPyHandle(a)));
            const ret = api.PyObject_Call(this.handle, tuple, kwargs) as NativePointer;
            api.Py_DecRef(tuple);
            if (!kwargs.isNull()) api.Py_DecRef(kwargs);
            checkError();
            if (ret.isNull()) throw new Error("call returned null");
            return new PyObject(ret, { owned: true });
        }

        /** Subscript get (`self[key]`). */
        $item(key: any): PyObject {
            const api = getApi();
            const k = toPyHandle(key);
            const ret = api.PyObject_GetItem(this.handle, k) as NativePointer;
            api.Py_DecRef(k);
            checkError();
            return new PyObject(ret, { owned: true });
        }

        /** Subscript set (`self[key] = value`). */
        $setItem(key: any, value: any): void {
            const api = getApi();
            const k = toPyHandle(key);
            const v = toPyHandle(value);
            const rc = api.PyObject_SetItem(this.handle, k, v) as number;
            api.Py_DecRef(k);
            api.Py_DecRef(v);
            if (rc !== 0) checkError();
        }

        /** `repr(self)`. */
        $repr(): string {
            return strLike(getApi().PyObject_Repr(this.handle) as NativePointer);
        }

        /** `str(self)`. */
        $str(): string {
            return strLike(getApi().PyObject_Str(this.handle) as NativePointer);
        }

        /** The type object (`type(self)`). */
        $type(): PyObject {
            const ret = getApi().PyObject_Type(this.handle) as NativePointer;
            checkError();
            return new PyObject(ret, { owned: true });
        }

        /** The type's `__name__` (the class name). */
        $className(): string {
            const api = getApi();
            const type = api.PyObject_Type(this.handle) as NativePointer;
            if (type.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            const nameAttr = api.PyObject_GetAttrString(type, Memory.allocUtf8String("__name__")) as NativePointer;
            api.Py_DecRef(type);
            if (nameAttr.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            const s = utf8Of(nameAttr);
            api.Py_DecRef(nameAttr);
            return s;
        }

        /** `dir(self)`. */
        $dir(): string[] {
            const api = getApi();
            const ret = api.PyObject_Dir(this.handle) as NativePointer;
            checkError();
            const list = new PyObject(ret, { owned: true });
            const out = list.$toJS() as any[];
            list.$dispose();
            return out.map(String);
        }

        /** `len(self)`. */
        $len(): number {
            const n = getApi().PyObject_Length(this.handle) as Int64 | number;
            checkError();
            return typeof n === "number" ? n : (n as Int64).toNumber();
        }

        /** Marshal to a native JS value (primitives/containers) or return self. */
        $toJS(): any {
            return toJS(this.handle);
        }

        /** Python `==` comparison. */
        $equals(other: PyObject | NativePointer): boolean {
            const h = other instanceof NativeStruct ? other.handle : other;
            const rc = getApi().PyObject_RichCompareBool(this.handle, h, 2 /* Py_EQ */) as number;
            checkError();
            return rc === 1;
        }

        /** `hash(self)`. */
        $hash(): number {
            const n = getApi().PyObject_Hash(this.handle) as Int64 | number;
            checkError();
            return typeof n === "number" ? n : (n as Int64).toNumber();
        }

        /** Take an extra owned reference and return a fresh wrapper. */
        $retain(): PyObject {
            return new PyObject(this.handle, { owned: false });
        }

        /** Deterministically release this wrapper's reference. Idempotent. */
        $dispose(): void {
            if (this.disposed) return;
            this.disposed = true;
            if (this.weakId !== -1) {
                Script.unbindWeak(this.weakId);
                this.weakId = -1;
            }
        }

        toString(): string {
            return this.$str();
        }

        *[Symbol.iterator](): IterableIterator<PyObject> {
            const api = getApi();
            const iter = api.PyObject_GetIter(this.handle) as NativePointer;
            if (iter.isNull()) {
                checkError();
                return;
            }
            try {
                for (;;) {
                    const item = api.PyIter_Next(iter) as NativePointer;
                    if (item.isNull()) {
                        checkError();
                        break;
                    }
                    yield wrap(new PyObject(item, { owned: true }));
                }
            } finally {
                api.Py_DecRef(iter);
            }
        }
    }

    /** Build a finalizer that decrefs `handle` under the GIL (guards finalization). */
    function makeFinalizer(handle: NativePointer): () => void {
        return () => {
            const api = getApi();
            if ((api.Py_IsFinalizing() as number) !== 0) return; // interpreter tearing down
            const st = api.PyGILState_Ensure();
            try {
                api.Py_DecRef(handle);
            } finally {
                api.PyGILState_Release(st);
            }
        };
    }

    /** str()/repr() result -> JS string, releasing the temporary. */
    function strLike(strObj: NativePointer): string {
        const api = getApi();
        if (strObj.isNull()) {
            checkError();
            return "";
        }
        const s = utf8Of(strObj);
        api.Py_DecRef(strObj);
        return s;
    }

    const proxyHandler: ProxyHandler<any> = {
        get(target, prop) {
            const obj: PyObject = target.__pyobject;
            if (prop === "__pyobject") return obj;
            if (prop === "then") return undefined; // never look thenable
            if (typeof prop === "symbol") {
                if (prop === Symbol.iterator) return obj[Symbol.iterator].bind(obj);
                if (prop === Symbol.toPrimitive) {
                    return (hint: string) => (hint === "number" ? obj.$toJS() : obj.$str());
                }
                return (obj as any)[prop];
            }
            if (prop[0] === "$" || prop in obj) {
                const v = (obj as any)[prop];
                return typeof v === "function" ? v.bind(obj) : v;
            }
            return wrap(obj.$get(prop));
        },
        set(target, prop, value) {
            const obj: PyObject = target.__pyobject;
            if (typeof prop === "string" && prop[0] !== "$" && !(prop in obj)) {
                obj.$set(prop, value);
                return true;
            }
            (obj as any)[prop] = value;
            return true;
        },
        has(target, prop) {
            const obj: PyObject = target.__pyobject;
            if (typeof prop === "string" && prop[0] !== "$" && !(prop in obj)) {
                return obj.$hasAttr(prop);
            }
            return prop in obj;
        },
        apply(target, _thisArg, args) {
            const obj: PyObject = target.__pyobject;
            return wrap(obj.$call(...args));
        },
    };

    /** Wrap a {@link PyObject} in an ergonomic Proxy (callable, attribute access). */
    export function wrap(obj: PyObject): PyObject {
        const target: any = function () {};
        target.__pyobject = obj;
        return new Proxy(target, proxyHandler) as unknown as PyObject;
    }

    /** Unwrap a Proxy (or pass through a raw PyObject). */
    export function unwrap(value: any): PyObject {
        if (value instanceof PyObject) return value;
        if (value != null && value.__pyobject instanceof PyObject) return value.__pyobject;
        throw new Error("expected a PyObject");
    }
}
