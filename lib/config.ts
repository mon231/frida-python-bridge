namespace Python {
    /**
     * User-overridable configuration. Mirrors frida-il2cpp-bridge's `Il2Cpp.$config`.
     *
     * @example
     * // Point the bridge at a non-standard / statically-linked / stripped host,
     * // or supply manually-resolved addresses (DebugSymbol / pattern scan).
     * Python.$config.moduleName = "my_embedded_app.exe";
     * Python.$config.exports["PyGILState_Ensure"] = () => ptr("0x7ff6...");
     */
    export interface Config {
        /** Force a specific module name to resolve libpython from. */
        moduleName?: string;
        /** Per-symbol address overrides; the resolver tries these first. */
        exports: Record<string, () => NativePointer>;
    }

    export const $config: Config = {
        moduleName: undefined,
        exports: {},
    };
}
