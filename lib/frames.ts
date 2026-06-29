namespace Python {
    export interface Frame {
        /** Code object name (`co_name`), e.g. the function name. */
        name: string;
        /** Source filename (`co_filename`). */
        filename: string;
        /** Current line number. */
        lineno: number;
    }

    /** Extract {name, filename, lineno} from a (borrowed) frame pointer. */
    function frameInfo(frame: NativePointer): Frame {
        const api = getApi();
        let name = "<unknown>";
        let filename = "<unknown>";
        if (api.PyFrame_GetCode !== undefined) {
            const code = api.PyFrame_GetCode(frame) as NativePointer; // new ref
            if (!code.isNull()) {
                const codeObj = new PyObject(code, { owned: true });
                try {
                    name = codeObj.$get("co_name").$str();
                    filename = codeObj.$get("co_filename").$str();
                } catch (_e) {
                    api.PyErr_Clear();
                }
            }
        }
        return { name, filename, lineno: api.PyFrame_GetLineNumber(frame) as number };
    }

    /**
     * Capture the current Python call stack (innermost frame first). Returns an empty
     * array if no Python frame is currently executing on this thread. Must be called
     * under the GIL (e.g. inside an intercept handler or `perform()`).
     */
    export function backtrace(limit = 64): Frame[] {
        const api = getApi();
        const frames: Frame[] = [];

        let frame = api.PyEval_GetFrame() as NativePointer; // borrowed
        if (frame.isNull() || api.PyFrame_GetBack === undefined) return frames;

        api.Py_IncRef(frame); // own it so the GetBack walk is uniform
        while (!frame.isNull() && frames.length < limit) {
            frames.push(frameInfo(frame));
            const back = api.PyFrame_GetBack(frame) as NativePointer; // new ref or NULL
            api.Py_DecRef(frame);
            frame = back;
        }
        if (!frame.isNull()) api.Py_DecRef(frame);
        return frames;
    }
}
