namespace Python {
    export interface CaptureResult<T> {
        stdout: string;
        stderr: string;
        result: T;
    }

    /**
     * Run `fn` with the interpreter's `sys.stdout` / `sys.stderr` redirected to in-memory
     * buffers, returning the captured text alongside `fn`'s result. Restores the originals
     * even if `fn` throws. Must be called inside `perform()`/`performNow()` (GIL held).
     *
     * @example
     * Python.perform(() => {
     *   const cap = Python.capture(() => Python.exec('print("hi"); print("there")'));
     *   console.log(cap.stdout); // "hi\nthere\n"
     * });
     */
    export function capture<T>(fn: () => T): CaptureResult<T> {
        const io = importModule("io") as any;
        const sys = importModule("sys") as any;

        const outBuf = io.StringIO();
        const errBuf = io.StringIO();
        const savedOut = sys.stdout;
        const savedErr = sys.stderr;

        sys.stdout = outBuf;
        sys.stderr = errBuf;
        let result: T;
        try {
            result = fn();
        } finally {
            sys.stdout = savedOut;
            sys.stderr = savedErr;
        }

        return {
            result,
            stdout: outBuf.getvalue().$toJS(),
            stderr: errBuf.getvalue().$toJS(),
        };
    }
}
