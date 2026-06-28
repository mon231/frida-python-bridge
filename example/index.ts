// Side-effect import installs the global `Python`.
import "frida-python-bridge";

Python.perform(() => {
    console.log(`Hello from CPython ${Python.version}`);

    // Call into the standard library.
    const os = Python.import("os");
    console.log("cwd:", os.getcwd().$str());

    // Resolve + construct a class, call a method (Java.use-style).
    const Counter = Python.use("collections.Counter");
    const c = Counter([1, 1, 2, 3, 3, 3]);
    console.log("most_common:", c.most_common(2).$repr());

    // Find live instances of a type (Java.choose-style).
    for (const obj of Python.choose("collections.Counter")) {
        console.log("found a live Counter:", obj.$repr());
    }

    // Install a hook on a Python callable.
    const builtins = Python.import("builtins");
    const hook = Python.intercept(builtins, "print", (args, original) => {
        console.log("[hooked print] called with", args.length, "arg(s)");
        return original(...args);
    });
    Python.eval('print("through the hook")');
    hook.revert();
});
