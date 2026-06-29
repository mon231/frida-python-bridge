namespace Python {
    /** Marker wrapping keyword arguments for {@link PyObject.$call}. */
    export class KwArgs {
        readonly map: Record<string, any>;
        constructor(map: Record<string, any>) {
            this.map = map;
        }
    }

    /** Wrap a plain object as keyword arguments: `fn(a, b, Python.kw({ key: v }))`. */
    export function kw(map: Record<string, any>): KwArgs {
        return new KwArgs(map);
    }

    /** Read the `ob_type` pointer of a live PyObject (offset = pointerSize). */
    function typeOf(handle: NativePointer): NativePointer {
        return handle.add(Process.pointerSize).readPointer();
    }

    /** Extract UTF-8 text from a `str` PyObject (assumes GIL held). */
    export function utf8Of(handle: NativePointer): string {
        const api = getApi();
        if (api.PyUnicode_AsUTF8AndSize !== undefined) {
            const p = api.PyUnicode_AsUTF8AndSize(handle, NULL) as NativePointer;
            if (p.isNull()) {
                api.PyErr_Clear();
                return "";
            }
            return p.readUtf8String() ?? "";
        }
        const bytes = api.PyUnicode_AsUTF8String(handle) as NativePointer;
        if (bytes.isNull()) {
            api.PyErr_Clear();
            return "";
        }
        const out = Memory.alloc(Process.pointerSize);
        const len = Memory.alloc(Process.pointerSize);
        let s = "";
        if ((api.PyBytes_AsStringAndSize(bytes, out, len) as number) === 0) {
            s = out.readPointer().readUtf8String() ?? "";
        }
        api.Py_DecRef(bytes);
        return s;
    }

    /**
     * Convert a JS value to a NEW (owned) PyObject reference. Caller owns the result.
     * Must be called with the GIL held.
     */
    export function toPyHandle(value: any): NativePointer {
        const api = getApi();

        if (value === null || value === undefined) {
            api.Py_IncRef(api.Py_None);
            return api.Py_None;
        }
        // A Proxy-wrapped PyObject (callable target carrying __pyobject).
        if (value.__pyobject instanceof PyObject) {
            api.Py_IncRef(value.__pyobject.handle);
            return value.__pyobject.handle;
        }
        if (typeof value === "boolean") {
            return api.PyBool_FromLong(value ? 1 : 0) as NativePointer;
        }
        if (typeof value === "number") {
            if (Number.isInteger(value)) {
                return api.PyLong_FromLongLong(value) as NativePointer;
            }
            return api.PyFloat_FromDouble(value) as NativePointer;
        }
        if (typeof value === "bigint") {
            const s = Memory.allocUtf8String(value.toString());
            return api.PyLong_FromString(s, NULL, 10) as NativePointer;
        }
        if (typeof value === "string") {
            return api.PyUnicode_FromString(Memory.allocUtf8String(value)) as NativePointer;
        }
        if (value instanceof NativeStruct) {
            api.Py_IncRef(value.handle);
            return value.handle;
        }
        if (value instanceof KwArgs) {
            return toPyHandle(value.map);
        }
        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array((value as ArrayBufferView).buffer);
            const mem = Memory.alloc(bytes.length || 1);
            if (bytes.length > 0) mem.writeByteArray(bytes.buffer as ArrayBuffer);
            return api.PyBytes_FromStringAndSize(mem, bytes.length) as NativePointer;
        }
        if (Array.isArray(value)) {
            const list = api.PyList_New(0) as NativePointer;
            for (const item of value) {
                const h = toPyHandle(item);
                api.PyList_Append(list, h);
                api.Py_DecRef(h);
            }
            return list;
        }
        if (typeof value === "object") {
            const dict = api.PyDict_New() as NativePointer;
            for (const key of Object.keys(value)) {
                const h = toPyHandle(value[key]);
                api.PyDict_SetItemString(dict, Memory.allocUtf8String(key), h);
                api.Py_DecRef(h);
            }
            return dict;
        }

        // Fallback: None.
        api.Py_IncRef(api.Py_None);
        return api.Py_None;
    }

    /** Convert a JS value to a wrapped (owned) {@link PyObject}. GIL must be held. */
    export function toPy(value: any): PyObject {
        if (value instanceof PyObject) return value;
        if (value != null && value.__pyobject instanceof PyObject) return value.__pyobject;
        return new PyObject(toPyHandle(value), { owned: true });
    }

    /** Build a NEW tuple from owned handles. Steals each handle (do not DecRef them). */
    export function tupleFromHandles(handles: NativePointer[]): NativePointer {
        const api = getApi();
        const tuple = api.PyTuple_New(handles.length) as NativePointer;
        handles.forEach((h, i) => api.PyTuple_SetItem(tuple, i, h));
        return tuple;
    }

    /**
     * Convert a live PyObject to a JS value where the type is known (int/float/str/
     * bool/bytes/list/tuple/dict/None); otherwise return a wrapped {@link PyObject}.
     * Does NOT consume `handle` (reads only / takes its own ref for wrappers).
     * GIL must be held.
     */
    export function toJS(handle: NativePointer): any {
        const api = getApi();
        if (handle.isNull()) return null;

        if (handle.equals(api.Py_None)) return null;
        if (handle.equals(api.Py_True)) return true;
        if (handle.equals(api.Py_False)) return false;

        const type = typeOf(handle);

        if (type.equals(api.PyLong_Type)) {
            const overflow = Memory.alloc(Process.pointerSize);
            const ll = api.PyLong_AsLongLongAndOverflow(handle, overflow) as Int64;
            if (overflow.readInt() !== 0) return BigInt(display(handle));
            const n = ll.toNumber();
            return Number.isSafeInteger(n) ? n : BigInt(ll.toString());
        }
        if (type.equals(api.PyFloat_Type)) {
            return api.PyFloat_AsDouble(handle) as number;
        }
        if (type.equals(api.PyBool_Type)) {
            return (api.PyObject_IsTrue(handle) as number) !== 0;
        }
        if (type.equals(api.PyUnicode_Type)) {
            return utf8Of(handle);
        }
        if (type.equals(api.PyBytes_Type)) {
            const out = Memory.alloc(Process.pointerSize);
            const len = Memory.alloc(Process.pointerSize);
            if ((api.PyBytes_AsStringAndSize(handle, out, len) as number) === 0) {
                const n = len.readPointer().toInt32();
                return n > 0 ? out.readPointer().readByteArray(n) : new ArrayBuffer(0);
            }
            api.PyErr_Clear();
            return new ArrayBuffer(0);
        }
        if (
            type.equals(api.PyList_Type) ||
            type.equals(api.PyTuple_Type) ||
            type.equals(api.PySet_Type) ||
            type.equals(api.PyFrozenSet_Type)
        ) {
            return iterableToArray(handle);
        }
        if (type.equals(api.PyComplex_Type)) {
            return {
                real: api.PyComplex_RealAsDouble(handle) as number,
                imag: api.PyComplex_ImagAsDouble(handle) as number,
            };
        }
        if (type.equals(api.PyByteArray_Type)) {
            return bufferOf(handle);
        }
        if (type.equals(api.PyDict_Type)) {
            const result: Record<string, any> = {};
            const pos = Memory.alloc(Process.pointerSize);
            pos.writePointer(NULL);
            const keySlot = Memory.alloc(Process.pointerSize);
            const valSlot = Memory.alloc(Process.pointerSize);
            while ((api.PyDict_Next(handle, pos, keySlot, valSlot) as number) !== 0) {
                const k = keySlot.readPointer();
                const v = valSlot.readPointer();
                const keyStr = typeOf(k).equals(api.PyUnicode_Type) ? utf8Of(k) : display(k);
                result[keyStr] = toJS(v);
            }
            return result;
        }

        // datetime.datetime / datetime.date -> JS Date (via isoformat()). Raw calls only
        // (no PyObject wrappers) to avoid per-call bindWeak/GC churn during marshalling.
        if (type.equals(typeHandle("datetime", "datetime")) || type.equals(typeHandle("datetime", "date"))) {
            const method = api.PyObject_GetAttrString(handle, Memory.allocUtf8String("isoformat")) as NativePointer;
            if (!method.isNull()) {
                const ret = api.PyObject_CallObject(method, NULL) as NativePointer;
                api.Py_DecRef(method);
                if (!ret.isNull()) {
                    const iso = utf8Of(ret);
                    api.Py_DecRef(ret);
                    const d = new Date(iso);
                    return isNaN(d.getTime()) ? iso : d;
                }
            }
            api.PyErr_Clear();
        }
        // decimal.Decimal -> JS number (precision may be lost; read $str() for exact).
        if (type.equals(typeHandle("decimal", "Decimal"))) {
            return parseFloat(display(handle));
        }

        // Unknown / user-defined type: return a wrapper that owns its own reference.
        return new PyObject(handle, { owned: false });
    }

    // Cache of `module.name` type objects (kept alive so their addresses stay valid).
    const _typeCache: Record<string, PyObject> = {};

    /** Resolve and cache a type object's handle (e.g. ("datetime","datetime")). GIL held. */
    function typeHandle(moduleName: string, typeName: string): NativePointer {
        const key = `${moduleName}.${typeName}`;
        let cached = _typeCache[key];
        if (cached === undefined) {
            try {
                cached = (importModule(moduleName) as any)[typeName].__pyobject as PyObject;
            } catch (_e) {
                getApi().PyErr_Clear();
                cached = new PyObject(NULL, { owned: true }); // sentinel; never matches a live type
            }
            _typeCache[key] = cached;
        }
        return cached.handle;
    }

    /** Iterate any Python iterable into a JS array (each item via toJS). GIL held. */
    function iterableToArray(handle: NativePointer): any[] {
        const api = getApi();
        const result: any[] = [];
        const iter = api.PyObject_GetIter(handle) as NativePointer;
        if (!iter.isNull()) {
            let item = api.PyIter_Next(iter) as NativePointer;
            while (!item.isNull()) {
                result.push(toJS(item));
                api.Py_DecRef(item);
                item = api.PyIter_Next(iter) as NativePointer;
            }
            api.Py_DecRef(iter);
            api.PyErr_Clear();
        }
        return result;
    }

    /** Read a buffer-protocol object (bytes/bytearray/memoryview/...) as an ArrayBuffer. */
    export function bufferOf(handle: NativePointer): ArrayBuffer {
        const api = getApi();
        const view = Memory.alloc(0x100); // Py_buffer is ~80 bytes; over-allocate
        if ((api.PyObject_GetBuffer(handle, view, 0 /* PyBUF_SIMPLE */) as number) !== 0) {
            api.PyErr_Clear();
            return new ArrayBuffer(0);
        }
        try {
            const buf = view.readPointer(); // Py_buffer.buf  (offset 0)
            const len = (view.add(Process.pointerSize * 2).readS64() as Int64).toNumber(); // .len (after buf, obj)
            return len > 0 ? buf.readByteArray(len) ?? new ArrayBuffer(0) : new ArrayBuffer(0);
        } finally {
            api.PyBuffer_Release(view);
        }
    }

    /** Build a Python `slice(start, stop, step)` as a wrapped PyObject. GIL held. */
    export function slice(start?: any, stop?: any, step?: any): PyObject {
        const api = getApi();
        const s = toPyHandle(start ?? null);
        const e = toPyHandle(stop ?? null);
        const t = toPyHandle(step ?? null);
        const sl = api.PySlice_New(s, e, t) as NativePointer;
        api.Py_DecRef(s);
        api.Py_DecRef(e);
        api.Py_DecRef(t);
        checkError();
        return wrap(new PyObject(sl, { owned: true }));
    }

    /** Internal str() helper available to marshalling (mirrors errors.display). */
    function display(handle: NativePointer): string {
        const api = getApi();
        const strObj = api.PyObject_Str(handle) as NativePointer;
        if (strObj.isNull()) {
            api.PyErr_Clear();
            return "";
        }
        const s = utf8Of(strObj);
        api.Py_DecRef(strObj);
        return s;
    }
}
