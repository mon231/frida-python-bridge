namespace Python {
    export interface Interpreter {
        /** Interpreter id (`PyInterpreterState_GetID`); the main interpreter is 0. */
        id: number;
        /** True for the main interpreter. */
        isMain: boolean;
    }

    /** Walk the interpreter chain head→tail (head is newest, tail is main). */
    function interpChain(): NativePointer[] {
        const api = getApi();
        if (api.PyInterpreterState_Head === undefined || api.PyInterpreterState_Next === undefined) {
            return [];
        }
        const chain: NativePointer[] = [];
        let interp = api.PyInterpreterState_Head() as NativePointer;
        while (!interp.isNull()) {
            chain.push(interp);
            interp = api.PyInterpreterState_Next(interp) as NativePointer;
        }
        return chain;
    }

    /** Resolve an interpreter id to its `PyInterpreterState *`, or null if absent. */
    function interpStateById(id: number): NativePointer | null {
        const api = getApi();
        const chain = interpChain();
        if (chain.length === 0) return null;
        for (let i = 0; i < chain.length; i++) {
            const p = chain[i];
            const pid =
                api.PyInterpreterState_GetID !== undefined
                    ? (api.PyInterpreterState_GetID(p) as Int64).toNumber()
                    : chain.length - 1 - i; // fallback: tail(main)=0
            if (pid === id) return p;
        }
        return null;
    }

    /**
     * Enumerate the interpreters in the process (PEP 684 sub-interpreters). Most
     * processes have exactly one (the main interpreter). Must be called under the GIL.
     */
    export function interpreters(): Interpreter[] {
        const api = getApi();
        const chain = interpChain();
        // head is the most-recently-created interpreter; main is the tail.
        return chain.map((p, idx) => ({
            id:
                api.PyInterpreterState_GetID !== undefined
                    ? (api.PyInterpreterState_GetID(p) as Int64).toNumber()
                    : chain.length - 1 - idx,
            isMain: idx === chain.length - 1,
        }));
    }

    /**
     * Run `block` with the calling thread switched to interpreter `id`'s thread state
     * (via `PyThreadState_Swap`), then switch back. Assumes the GIL is already held
     * (call it from inside `perform`/`performNow`). `block` must be synchronous and must
     * not retain wrapped objects across interpreters.
     *
     * ⚠️ Under a per-interpreter GIL (3.12+ `Py_NewInterpreterFromConfig` with own GIL)
     * a bare swap is unsafe; this targets the common single-GIL case. Objects must not
     * cross interpreters.
     */
    function runInInterpreter<T>(id: number, block: () => T): T {
        const api = getApi();
        const target = interpStateById(id);
        if (target === null) {
            throw new Error(`frida-python-bridge: no interpreter with id ${id}`);
        }

        // Determine the current thread state's interpreter to skip a needless swap.
        const current = api.PyThreadState_Get() as NativePointer;
        let currentInterp: NativePointer | null = null;
        if (api.PyThreadState_GetInterpreter !== undefined && !current.isNull()) {
            currentInterp = api.PyThreadState_GetInterpreter(current) as NativePointer;
        } else if (api.PyInterpreterState_Get !== undefined) {
            currentInterp = api.PyInterpreterState_Get() as NativePointer;
        }
        if (currentInterp !== null && currentInterp.equals(target)) {
            return block(); // already executing in the target interpreter
        }

        if (api.PyThreadState_New === undefined || api.PyThreadState_Swap === undefined) {
            throw new Error(
                "frida-python-bridge: sub-interpreter targeting unavailable on this build " +
                    "(missing PyThreadState_New/Swap)"
            );
        }

        // Prefer an existing thread state for the target interpreter; create a transient
        // one only if none exists (and dispose it afterwards).
        let ts: NativePointer = NULL;
        let created = false;
        if (api.PyInterpreterState_ThreadHead !== undefined) {
            ts = api.PyInterpreterState_ThreadHead(target) as NativePointer;
        }
        if (ts.isNull()) {
            ts = api.PyThreadState_New(target) as NativePointer;
            if (ts.isNull()) {
                throw new Error(`frida-python-bridge: PyThreadState_New failed for interpreter ${id}`);
            }
            created = true;
        }

        const old = api.PyThreadState_Swap(ts) as NativePointer;
        try {
            return block();
        } finally {
            api.PyThreadState_Swap(old);
            if (created) {
                // GIL still held here; clear+delete the transient (non-current) state.
                if (api.PyThreadState_Clear !== undefined) api.PyThreadState_Clear(ts);
                if (api.PyThreadState_Delete !== undefined) api.PyThreadState_Delete(ts);
            }
        }
    }

    /**
     * Like {@link perform}, but executes `block` against a chosen interpreter (by id from
     * {@link interpreters}). `block` must be synchronous. See {@link runInInterpreter} caveats.
     */
    export async function performInInterpreter<T>(id: number, block: () => T): Promise<T> {
        return perform(() => runInInterpreter(id, block));
    }

    /** Synchronous variant of {@link performInInterpreter}. */
    export function performInInterpreterNow<T>(id: number, block: () => T): T {
        return performNow(() => runInInterpreter(id, block));
    }
}
