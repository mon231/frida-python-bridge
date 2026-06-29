namespace Python {
    export interface Interpreter {
        /** Interpreter id (`PyInterpreterState_GetID`); the main interpreter is 0. */
        id: number;
        /** True for the main interpreter. */
        isMain: boolean;
    }

    /**
     * Enumerate the interpreters in the process (PEP 684 sub-interpreters). Most
     * processes have exactly one (the main interpreter). Must be called under the GIL.
     *
     * NOTE: `PyGILState_*` (and thus `Python.perform`) always attach the **main**
     * interpreter; per-interpreter targeting is not yet supported (see PLAN.md).
     */
    export function interpreters(): Interpreter[] {
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

        // The list head is the most-recently-created interpreter; main is the tail.
        return chain.map((p, idx) => ({
            id:
                api.PyInterpreterState_GetID !== undefined
                    ? (api.PyInterpreterState_GetID(p) as Int64).toNumber()
                    : chain.length - 1 - idx,
            isMain: idx === chain.length - 1,
        }));
    }
}
