namespace Python {
    let chooseFactoryInstalled = false;

    /** Install the Python-side filter helper (filters in-interpreter for speed). */
    function ensureChooseFactory(): void {
        if (chooseFactoryInstalled) return;
        exec(
            [
                "def __frida_choose(_t):",
                "    import gc",
                "    return [o for o in gc.get_objects() if _t is None or isinstance(o, _t)]",
                "",
            ].join("\n")
        );
        chooseFactoryInstalled = true;
    }

    /**
     * Enumerate live instances, the analog of `Java.choose`, via `gc.get_objects()`.
     * Type filtering runs *inside* the interpreter (a list comprehension) so only the
     * matching objects cross into JS.
     *
     * @param predicate Optional filter: a dotted type name (e.g. "app.Greeter"), a type
     *   PyObject, or a JS predicate `(o: PyObject) => boolean`. Omit to return everything.
     *
     * NOTE: only GC-*tracked* objects are visible (containers and user-defined instances).
     * Atomic/immutable scalars (int, str, empty dict) are NOT tracked and won't appear.
     */
    export function choose(predicate?: string | PyObject | ((o: PyObject) => boolean)): PyObject[] {
        ensureChooseFactory();

        let typeObj: PyObject | null = null;
        let jsPredicate: ((o: PyObject) => boolean) | null = null;

        if (typeof predicate === "string") {
            typeObj = use(predicate);
        } else if (typeof predicate === "function") {
            jsPredicate = predicate;
        } else if (predicate !== undefined) {
            typeObj = predicate;
        }

        const factory = evalExpression("__frida_choose") as any;
        const listWrapped = factory(typeObj !== null ? typeObj : null);

        const result: PyObject[] = [];
        for (const obj of listWrapped as Iterable<PyObject>) {
            if (jsPredicate === null || jsPredicate(obj)) result.push(obj);
        }
        return result;
    }
}
