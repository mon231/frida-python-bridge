// Manual-test driver. Loaded AFTER dist/index.js (which installs globalThis.Python).
// Exposes run() over rpc; the Python runner calls it once the interpreter is live.

rpc.exports = {
    run() {
        return Python.perform(() => {
            const r = { logs: [] };

            r.version = Python.version.toString();
            r.available = Python.available;

            // --- marshalling / eval ---
            r.sum = Python.eval("sum(range(10))", { toJS: true });
            r.strRoundTrip = Python.eval("'abc'.upper()", { toJS: true });

            // --- the running module ---
            const app = Python.import("app");

            // --- call a module function ---
            r.add = app.add(2, 3).$toJS();

            // --- find instances + class names ---
            const greeters = Python.choose("app.Greeter");
            r.greeterCount = greeters.length;
            r.classNames = greeters.slice(0, 3).map(g => g.$className());
            r.firstName = greeters.length ? greeters[0].name.$toJS() : null;

            // --- construct a new instance via use() and call methods ---
            const Greeter = Python.use("app.Greeter");
            const g = Greeter("frida");
            r.helloNew = g.hello().$toJS();
            r.shout = g.shout("hi").$toJS();
            r.newClassName = g.$className();

            // --- install hooks (observed by the loop's subsequent calls) ---
            Python.intercept(app, "greet", args => {
                send({ type: "hook", target: "greet", arg: args[0].$str() });
                // return undefined -> transparently call the original
            });

            const GreeterCls = Python.use("app.Greeter");
            Python.intercept(GreeterCls, "hello", (args, original) => {
                const name = args[0].name.$str();
                send({ type: "hook", target: "Greeter.hello", name });
                return original(...args); // call through
            });

            r.hooksInstalled = true;
            return r;
        });
    },
};
