namespace Python {
    /**
     * Base class for every wrapper that is a typed view over a single `NativePointer`.
     * Mirrors frida-il2cpp-bridge's `NativeStruct`.
     */
    export abstract class NativeStruct {
        /** The backing native pointer (a `PyObject *` for {@link PyObject}). */
        readonly handle: NativePointer;

        constructor(handle: NativePointer) {
            this.handle = handle;
        }

        /** True when the backing pointer is NULL. */
        isNull(): boolean {
            return this.handle.isNull();
        }

        /** Pointer-identity comparison (Python `is`). */
        equals(other: NativeStruct | NativePointer): boolean {
            const otherHandle = other instanceof NativeStruct ? other.handle : other;
            return this.handle.equals(otherHandle);
        }
    }
}
