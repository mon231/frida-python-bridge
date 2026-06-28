namespace Python {
    /** True when a CPython runtime is loaded, initialized, and not finalizing. */
    export function isLive(): boolean {
        try {
            const api = getApi();
            return (api.Py_IsInitialized() as number) !== 0 && (api.Py_IsFinalizing() as number) === 0;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Acquire the GIL, run `block`, release the GIL. The mandatory entry point for any
     * interaction with the interpreter from a Frida thread. Mirrors `Il2Cpp.perform` /
     * `Java.perform`, with `PyGILState_Ensure/Release` replacing thread-attach.
     */
    export async function perform<T>(block: () => T | Promise<T>): Promise<T> {
        if (!isLive()) {
            throw new Error(
                "frida-python-bridge: CPython is not available (not found / not initialized / finalizing)"
            );
        }
        const api = getApi();
        const state = api.PyGILState_Ensure() as number;
        try {
            const result = block();
            return result instanceof Promise ? await result : result;
        } catch (e) {
            Script.nextTick(_e => {
                throw _e;
            }, e);
            throw e;
        } finally {
            api.PyGILState_Release(state);
        }
    }

    /** Synchronous variant for callers that need a value back immediately (still GIL-safe). */
    export function performNow<T>(block: () => T): T {
        if (!isLive()) {
            throw new Error("frida-python-bridge: CPython is not available");
        }
        const api = getApi();
        const state = api.PyGILState_Ensure() as number;
        try {
            return block();
        } finally {
            api.PyGILState_Release(state);
        }
    }

    // Dynamic facade getters (namespaces can't declare get-accessors directly).
    Object.defineProperty(Python, "available", { get: () => isLive(), configurable: true, enumerable: true });
    Object.defineProperty(Python, "initialized", {
        get: () => {
            try {
                return (getApi().Py_IsInitialized() as number) !== 0;
            } catch (_e) {
                return false;
            }
        },
        configurable: true,
        enumerable: true,
    });
    Object.defineProperty(Python, "version", { get: () => getVersion(), configurable: true, enumerable: true });
    Object.defineProperty(Python, "api", { get: () => getApi(), configurable: true, enumerable: true });
    Object.defineProperty(Python, "module", { get: () => getModule(), configurable: true, enumerable: true });
}

// Ambient declarations for the dynamic getters above.
declare namespace Python {
    /** True when a CPython runtime is loaded, initialized, and not finalizing. */
    const available: boolean;
    /** `Py_IsInitialized()`. */
    const initialized: boolean;
    /** Detected CPython version. */
    const version: Version;
    /** The raw resolved C-API table (escape hatch). */
    const api: Api;
    /** The resolved libpython / host module (escape hatch). */
    const module: Module;
}
