/// <reference path="./utils/native-struct.ts" />
/// <reference path="./config.ts" />
/// <reference path="./module.ts" />
/// <reference path="./errors.ts" />
/// <reference path="./marshal.ts" />
/// <reference path="./structs/object.ts" />
/// <reference path="./perform.ts" />
/// <reference path="./exec.ts" />
/// <reference path="./choose.ts" />
/// <reference path="./hook.ts" />

// Install the global. Consumers do `import "frida-python-bridge";` then use `Python.*`.
// `Python` is an ambient global namespace (declared across lib/*.ts), so a side-effect
// import brings both the runtime object and its TypeScript types into scope.
(globalThis as any).Python = Python;
