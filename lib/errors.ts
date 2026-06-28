namespace Python {
    /** A Python exception surfaced as a JS error. */
    export class PythonException extends Error {
        /** Fully-qualified Python exception type name (e.g. "ValueError"). */
        readonly pythonType: string;
        /** Formatted Python traceback, when available. */
        readonly traceback: string;

        constructor(pythonType: string, message: string, traceback: string) {
            super(`${pythonType}: ${message}`);
            this.name = "PythonException";
            this.pythonType = pythonType;
            this.traceback = traceback;
        }
    }

    /** Extract a `str`/any object's text via str() without touching the error indicator. */
    function display(handle: NativePointer): string {
        const api = getApi();
        if (handle.isNull()) return "";
        const strObj = api.PyObject_Str(handle) as NativePointer;
        if (strObj.isNull()) {
            api.PyErr_Clear();
            return "";
        }
        try {
            if (api.PyUnicode_AsUTF8AndSize !== undefined) {
                const p = api.PyUnicode_AsUTF8AndSize(strObj, NULL) as NativePointer;
                return p.isNull() ? "" : p.readUtf8String() ?? "";
            }
            const bytes = api.PyUnicode_AsUTF8String(strObj) as NativePointer;
            if (bytes.isNull()) return "";
            const out = Memory.alloc(Process.pointerSize);
            const len = Memory.alloc(Process.pointerSize);
            if ((api.PyBytes_AsStringAndSize(bytes, out, len) as number) === 0) {
                const s = out.readPointer().readUtf8String() ?? "";
                api.Py_DecRef(bytes);
                return s;
            }
            api.Py_DecRef(bytes);
            return "";
        } finally {
            api.Py_DecRef(strObj);
        }
    }

    /** Best-effort `traceback.format_exception(...)` join; never itself raises. */
    function formatTraceback(t: NativePointer, v: NativePointer, tb: NativePointer): string {
        const api = getApi();
        try {
            const mod = api.PyImport_ImportModule(Memory.allocUtf8String("traceback")) as NativePointer;
            if (mod.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            const func = api.PyObject_GetAttrString(mod, Memory.allocUtf8String("format_exception")) as NativePointer;
            api.Py_DecRef(mod);
            if (func.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            const args = api.PyTuple_New(3) as NativePointer;
            api.Py_IncRef(t);
            api.PyTuple_SetItem(args, 0, t);
            api.Py_IncRef(v);
            api.PyTuple_SetItem(args, 1, v);
            const tbArg = tb.isNull() ? api.Py_None : tb;
            api.Py_IncRef(tbArg);
            api.PyTuple_SetItem(args, 2, tbArg);
            const lines = api.PyObject_CallObject(func, args) as NativePointer;
            api.Py_DecRef(func);
            api.Py_DecRef(args);
            if (lines.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            // Join the list of strings.
            const sep = api.PyUnicode_FromString(Memory.allocUtf8String("")) as NativePointer;
            const joinName = Memory.allocUtf8String("join");
            const joinFn = api.PyObject_GetAttrString(sep, joinName) as NativePointer;
            const jArgs = api.PyTuple_New(1) as NativePointer;
            api.Py_IncRef(lines);
            api.PyTuple_SetItem(jArgs, 0, lines);
            const joined = api.PyObject_CallObject(joinFn, jArgs) as NativePointer;
            api.Py_DecRef(sep);
            api.Py_DecRef(joinFn);
            api.Py_DecRef(jArgs);
            api.Py_DecRef(lines);
            if (joined.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            const s = display(joined);
            api.Py_DecRef(joined);
            return s;
        } catch (_e) {
            api.PyErr_Clear();
            return "";
        }
    }

    /**
     * If a Python error is pending, consume it and throw a {@link PythonException}.
     * MUST be called with the GIL held (i.e. inside perform()/a hook).
     */
    export function checkError(): void {
        const api = getApi();
        if ((api.PyErr_Occurred() as NativePointer).isNull()) return;

        const tSlot = Memory.alloc(Process.pointerSize);
        const vSlot = Memory.alloc(Process.pointerSize);
        const tbSlot = Memory.alloc(Process.pointerSize);
        api.PyErr_Fetch(tSlot, vSlot, tbSlot);
        api.PyErr_NormalizeException(tSlot, vSlot, tbSlot);

        const t = tSlot.readPointer();
        const v = vSlot.readPointer();
        const tb = tbSlot.readPointer();

        let typeName = "Exception";
        if (!t.isNull()) {
            const nameAttr = api.PyObject_GetAttrString(t, Memory.allocUtf8String("__name__")) as NativePointer;
            if (!nameAttr.isNull()) {
                typeName = display(nameAttr);
                api.Py_DecRef(nameAttr);
            } else {
                api.PyErr_Clear();
            }
        }
        const message = v.isNull() ? "" : display(v);
        const traceback = formatTraceback(t, v, tb);

        if (!t.isNull()) api.Py_DecRef(t);
        if (!v.isNull()) api.Py_DecRef(v);
        if (!tb.isNull()) api.Py_DecRef(tb);

        throw new PythonException(typeName, message, traceback);
    }
}
