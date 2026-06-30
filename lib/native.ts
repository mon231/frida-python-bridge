namespace Python {
    // A CModule hot-loop helper. For large object-graph sweeps (e.g. counting live
    // instances of a type across the whole heap), crossing the JS<->native boundary once
    // per object is the bottleneck. This walks the `gc.get_objects()` list and applies the
    // isinstance test entirely in C (one bridge call total), wrapping nothing.
    //
    // TinyCC cannot include <Python.h>, so the CPython entry points are passed in via the
    // CModule `symbols` map (each declared `extern` with a matched, header-free signature).
    // Py_ssize_t is pointer-width, so `ptrdiff_t` is used (NOT `long`, which is 32-bit on
    // 64-bit Windows and would truncate large heaps).

    let _countModule: { fpb_count: NativePointer } | null = null;
    let _countFn: NativeFunction<UInt64, [NativePointerValue, NativePointerValue]> | null = null;

    function getCountFn(): NativeFunction<UInt64, [NativePointerValue, NativePointerValue]> {
        if (_countFn !== null) return _countFn;

        const source = `
#include <stddef.h>

extern ptrdiff_t py_list_size(void *list);
extern void *py_list_getitem(void *list, ptrdiff_t i);
extern int py_isinstance(void *obj, void *type);

/* Count items of \`list\` that are instances of \`type\` (type==NULL counts all). */
size_t fpb_count(void *list, void *type) {
    ptrdiff_t n = py_list_size(list);
    if (n < 0) return 0;
    size_t c = 0;
    for (ptrdiff_t i = 0; i < n; i++) {
        void *item = py_list_getitem(list, i); /* borrowed */
        if (item == 0) continue;
        if (type == 0) { c++; continue; }
        if (py_isinstance(item, type) == 1) c++;
    }
    return c;
}
`;
        const cm = new CModule(source, {
            py_list_size: symbolAddress("PyList_Size"),
            py_list_getitem: symbolAddress("PyList_GetItem"),
            py_isinstance: symbolAddress("PyObject_IsInstance"),
        });
        _countModule = cm as unknown as { fpb_count: NativePointer };
        _countFn = new NativeFunction(cm.fpb_count, "size_t", ["pointer", "pointer"], {
            exceptions: "propagate",
        });
        return _countFn;
    }

    /**
     * Count live instances of a type across the heap, the fast analog of
     * `Python.choose(type).length`. The whole `gc.get_objects()` sweep + isinstance test
     * runs in a CModule (one native call), so — unlike {@link choose} — nothing is wrapped
     * or marshalled per object. Must be called under the GIL (inside `perform`).
     *
     * @param predicate A dotted type name ("app.Greeter"), a type `PyObject`, or omit to
     *   count every GC-tracked object. (A JS predicate is not supported here: it can't run
     *   in C — use {@link choose} for that.)
     */
    export function countInstances(predicate?: string | PyObject): number {
        const api = getApi();

        let typeHandle: NativePointer = NULL;
        let typeObj: PyObject | null = null;
        if (typeof predicate === "string") {
            typeObj = unwrap(use(predicate));
            typeHandle = typeObj.handle;
        } else if (predicate !== undefined) {
            typeObj = unwrap(predicate);
            typeHandle = typeObj.handle;
        }

        const gc = importModule("gc");
        const objs = (gc as any).get_objects();
        const listObj = unwrap(objs);
        try {
            const n = getCountFn()(listObj.handle, typeHandle) as unknown as UInt64;
            api.PyErr_Clear(); // a borderline isinstance() may have set (and we ignored) an error
            return (n as UInt64).toNumber();
        } finally {
            listObj.$dispose();
            unwrap(gc).$dispose();
            if (typeObj !== null) typeObj.$dispose();
        }
    }
}
