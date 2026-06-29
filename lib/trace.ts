namespace Python {
    // Py_tracefunc 'what' codes -> names.
    const WHAT_NAMES = ["call", "exception", "line", "return", "c_call", "c_exception", "c_return", "opcode"];

    export interface TraceEvent {
        /** One of: call, exception, line, return, c_call, c_exception, c_return, opcode. */
        what: string;
        /** Raw frame pointer (opaque on 3.11+); use for identity. */
        frame: NativePointer;
        /** `co_name` of the frame's code object (best-effort). */
        funcName: string;
    }

    export type TraceHandler = (event: TraceEvent) => void;

    // Keep callbacks alive while installed.
    let _profileCb: any = null;
    let _traceCb: any = null;

    function makeTraceCallback(handler: TraceHandler): any {
        return new NativeCallback(
            ((_obj: NativePointer, frame: NativePointer, what: number, _arg: NativePointer): number => {
                // CPython disables tracing while a C trace func runs, so re-entrancy is safe.
                try {
                    const api = getApi();
                    let funcName = "<unknown>";
                    if (api.PyFrame_GetCode !== undefined && !frame.isNull()) {
                        const code = api.PyFrame_GetCode(frame) as NativePointer;
                        if (!code.isNull()) {
                            const c = new PyObject(code, { owned: true });
                            try {
                                funcName = c.$get("co_name").$str();
                            } catch (_e) {
                                api.PyErr_Clear();
                            }
                        }
                    }
                    handler({ what: WHAT_NAMES[what] ?? String(what), frame, funcName });
                } catch (_e) {
                    /* a trace func must never raise */
                }
                return 0;
            }) as any,
            "int",
            ["pointer", "pointer", "int", "pointer"]
        );
    }

    /**
     * Install a per-thread profile function (fires on call/return and C call/return).
     * Affects only the current thread state; pair with {@link unsetProfile}.
     */
    export function setProfile(handler: TraceHandler): void {
        const api = getApi();
        _profileCb = makeTraceCallback(handler);
        api.PyEval_SetProfile(_profileCb, NULL);
    }

    /** Remove the profile function from the current thread. */
    export function unsetProfile(): void {
        getApi().PyEval_SetProfile(NULL, NULL);
        _profileCb = null;
    }

    /**
     * Install a per-thread trace function (adds per-line events on top of profile
     * events). Higher overhead than {@link setProfile}; pair with {@link unsetTrace}.
     */
    export function setTrace(handler: TraceHandler): void {
        const api = getApi();
        _traceCb = makeTraceCallback(handler);
        api.PyEval_SetTrace(_traceCb, NULL);
    }

    /** Remove the trace function from the current thread. */
    export function unsetTrace(): void {
        getApi().PyEval_SetTrace(NULL, NULL);
        _traceCb = null;
    }
}
