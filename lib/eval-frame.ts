namespace Python {
    export type FrameHookHandler = (frame: NativePointer, throwflag: number) => void;

    let _evalFrameCb: any = null;
    let _frameHookInstalled = false;
    // Retain every eval-frame callback for the lifetime of the script. The eval-frame
    // function is process-wide, so other threads may still be executing inside our
    // callback when we restore the default; letting it be GC'd would be a use-after-free.
    const _keptFrameCbs: any[] = [];

    function currentInterp(): NativePointer {
        const api = getApi();
        if (api.PyInterpreterState_Get !== undefined) return api.PyInterpreterState_Get() as NativePointer;
        const ts = api.PyThreadState_Get() as NativePointer;
        return api.PyThreadState_GetInterpreter !== undefined
            ? (api.PyThreadState_GetInterpreter(ts) as NativePointer)
            : ts;
    }

    /** Whether PEP 523 frame-eval hooking is available (internal API + CPython >= 3.9). */
    export function canHookFrames(): boolean {
        const api = getApi();
        return (
            getVersion().minor >= 9 &&
            api._PyInterpreterState_SetEvalFrameFunc !== undefined &&
            api._PyEval_EvalFrameDefault !== undefined
        );
    }

    /**
     * Install a PEP 523 eval-frame hook: `handler(frame, throwflag)` runs for EVERY
     * Python frame evaluation, then the default evaluator executes the frame.
     *
     * EXPERIMENTAL / high-overhead: the handler fires for every frame, must be cheap, and
     * must NOT call back into the interpreter (the frame is mid-evaluation; on 3.11+ the
     * pointer is an opaque `_PyInterpreterFrame*`). Always pair with {@link unsetFrameHook}.
     * Requires the internal eval-frame API (`canHookFrames()`).
     */
    export function setFrameHook(handler: FrameHookHandler): void {
        const api = getApi();
        if (!canHookFrames()) {
            throw new Error("frida-python-bridge: PEP 523 frame-eval hooking is unavailable on this runtime");
        }
        if (_frameHookInstalled) unsetFrameHook();

        const evalDefault = api._PyEval_EvalFrameDefault;
        _evalFrameCb = new NativeCallback(
            ((tstate: NativePointer, frame: NativePointer, throwflag: number): NativePointer => {
                try {
                    handler(frame, throwflag);
                } catch (_e) {
                    /* never break the interpreter */
                }
                return evalDefault(tstate, frame, throwflag) as NativePointer;
            }) as any,
            "pointer",
            ["pointer", "pointer", "int"]
        );
        _keptFrameCbs.push(_evalFrameCb);

        api._PyInterpreterState_SetEvalFrameFunc(currentInterp(), _evalFrameCb);
        _frameHookInstalled = true;
    }

    /** Restore the default frame evaluator. Idempotent. */
    export function unsetFrameHook(): void {
        const api = getApi();
        if (!_frameHookInstalled) return;
        api._PyInterpreterState_SetEvalFrameFunc(currentInterp(), api._PyEval_EvalFrameDefault);
        _evalFrameCb = null;
        _frameHookInstalled = false;
    }
}
