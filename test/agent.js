// CI test agent. Loaded AFTER dist/index.js (which installs globalThis.Python).
// Runs an assertion suite inside the target interpreter and returns the results
// over rpc; the Python runner (test/run) aggregates pass/fail and sets the exit code.

function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(actual, expected) {
    if (actual !== expected) {
        throw new Error(`expected ${String(expected)}, got ${String(actual)}`);
    }
}

function assertJson(actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(`expected ${e}, got ${a}`);
}

rpc.exports = {
    run() {
        const results = [];
        const t = (name, fn) => {
            send({ progress: name });
            let r;
            try {
                fn();
                r = { name, ok: true };
            } catch (e) {
                r = { name, ok: false, message: (e && e.message) || String(e) };
            }
            results.push(r);
            send({ done: r });
        };

        Python.perform(() => {
            t("available", () => assert(Python.available === true));
            t("version is 3.x", () => assert(Python.version.major === 3));

            // marshalling / eval
            t("eval int", () => assertEq(Python.eval("1 + 2", { toJS: true }), 3));
            t("eval float", () => assertEq(Python.eval("1.5 * 2", { toJS: true }), 3.0));
            t("eval str", () => assertEq(Python.eval('"a" + "b"', { toJS: true }), "ab"));
            t("eval bool true", () => assertEq(Python.eval("True", { toJS: true }), true));
            t("eval none", () => assertEq(Python.eval("None", { toJS: true }), null));
            t("eval list", () => assertJson(Python.eval("[1, 2, 3]", { toJS: true }), [1, 2, 3]));
            t("eval tuple", () => assertJson(Python.eval("(1, 2)", { toJS: true }), [1, 2]));
            t("eval dict", () => assertJson(Python.eval('{"x": 1, "y": 2}', { toJS: true }), { x: 1, y: 2 }));
            // NB: avoid `2n ** 70n` here -- BigInt exponentiation crashes Frida's QuickJS.
            t("eval bigint", () =>
                assertEq(String(Python.eval("2 ** 70", { toJS: true })), "1180591620717411303424"));
            t("eval bytes", () => {
                const buf = Python.eval('b"hi"', { toJS: true });
                assertJson(Array.from(new Uint8Array(buf)), [104, 105]);
            });

            // exec
            t("exec sets global", () => {
                Python.exec("__frida_test_v = 41 + 1");
                assertEq(Python.eval("__frida_test_v", { toJS: true }), 42);
            });

            // import / use / builtins
            t("import os", () => assert(typeof Python.import("os").getcwd().$toJS() === "string"));
            t("use builtins.len", () => assertEq(Python.use("builtins.len")([1, 2, 3, 4]).$toJS(), 4));
            t("builtins.abs", () => assertEq(Python.builtins.abs(-5).$toJS(), 5));

            // object protocol
            t("attr get/set", () => {
                const g = Python.use("app.Greeter")("x");
                g.name = "y";
                assertEq(g.name.$toJS(), "y");
            });
            t("call instance method", () => {
                const g = Python.use("app.Greeter")("z");
                assertEq(g.hello().$toJS(), "Hello from z");
            });
            t("className", () => assertEq(Python.use("app.Greeter")("z").$className(), "Greeter"));
            t("repr contains type", () => assert(Python.use("app.Greeter")("z").$repr().indexOf("Greeter") >= 0));
            t("iterate", () => {
                let sum = 0;
                for (const x of Python.eval("[1, 2, 3, 4]")) sum += x.$toJS();
                assertEq(sum, 10);
            });
            t("subscript get", () => assertEq(Python.eval('{"k": 7}').$item("k").$toJS(), 7));
            t("len", () => assertEq(Python.eval("[1, 2, 3]").$len(), 3));
            t("equals", () => assert(Python.eval("1").$equals(Python.eval("1"))));
            t("dir non-empty", () => assert(Python.eval("[]").$dir().length > 0));
            t("kwargs", () => {
                const c = Python.use("app.Calculator")();
                assertEq(c.mul(3, Python.kw({ y: 4 })).$toJS(), 12);
            });

            // errors
            t("exception -> PythonException", () => {
                let ok = false;
                try {
                    Python.eval("1 / 0");
                } catch (e) {
                    ok = e instanceof Python.PythonException && e.pythonType === "ZeroDivisionError";
                }
                assert(ok);
            });

            // choose (finding instances) + class names
            t("choose finds Greeters", () => assert(Python.choose("app.Greeter").length >= 2));
            t("choose class names", () => {
                const gs = Python.choose("app.Greeter");
                assert(gs.every(g => g.$className() === "Greeter"));
            });
            t("choose predicate", () => {
                const named = Python.choose("app.Greeter").filter(g => g.name.$toJS() === "alpha");
                assert(named.length >= 1);
            });

            // hooking
            t("hook override + revert", () => {
                const app = Python.import("app");
                const h = Python.intercept(app, "add", args => args[0].$toJS() + args[1].$toJS() + 100);
                const hooked = app.add(1, 2).$toJS();
                h.revert();
                const restored = app.add(1, 2).$toJS();
                assertEq(hooked, 103);
                assertEq(restored, 3);
            });
            t("hook passthrough observes call", () => {
                const app = Python.import("app");
                let fired = 0;
                const h = Python.intercept(app, "greet", () => {
                    fired += 1;
                });
                const out = app.greet("zz").$toJS();
                h.revert();
                assertEq(out, "Hello, zz!");
                assertEq(fired, 1);
            });
            t("hook instance method", () => {
                const Greeter = Python.use("app.Greeter");
                let seen = null;
                const h = Python.intercept(Greeter, "hello", (args, original) => {
                    seen = args[0].name.$toJS();
                    return original(...args);
                });
                const g = Greeter("hooked");
                const out = g.hello().$toJS();
                h.revert();
                assertEq(out, "Hello from hooked");
                assertEq(seen, "hooked");
            });
        });

        return results;
    },
};
