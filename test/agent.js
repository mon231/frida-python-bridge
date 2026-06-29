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
    // Readiness probe: true once the interpreter is initialized (CI runners can be slow
    // to finish Py_Initialize after spawn/resume). The harness polls this before run().
    ready() {
        try {
            return Python.available === true;
        } catch (e) {
            return false;
        }
    },
    // Run only the tests with index in [lo, hi). The suite is sharded across several
    // fresh injections (see conftest) to bound per-GumJS-script cumulative state, which
    // otherwise accumulates enough to destabilize Frida's QuickJS over ~50+ operations.
    run(lo, hi, experimental) {
        const results = [];
        let idx = 0;
        const t = (name, fn) => {
            const i = idx++;
            if (i < lo || i >= hi) return; // not in this shard
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

            // ---- v2 features ------------------------------------------------

            t("implementation is cpython", () => assertEq(Python.version.implementation, "cpython"));

            t("vectorcall no-arg / one-arg", () => {
                assertEq(Python.use("builtins.list")().$len(), 0); // no-arg fast path
                assertEq(Python.builtins.len([1, 2]).$toJS(), 2); // one-arg fast path
            });

            // richer marshalling
            t("marshal set", () => assertJson(Python.eval("{3, 1, 2}", { toJS: true }).sort(), [1, 2, 3]));
            t("marshal frozenset", () => assertJson(Python.eval("frozenset([2, 1])", { toJS: true }).sort(), [1, 2]));
            t("marshal complex", () => assertJson(Python.eval("complex(1, 2)", { toJS: true }), { real: 1, imag: 2 }));
            t("marshal bytearray", () => {
                const buf = Python.eval('bytearray(b"ab")', { toJS: true });
                assertJson(Array.from(new Uint8Array(buf)), [97, 98]);
            });
            t("buffer protocol", () => {
                const buf = Python.eval('bytearray(b"hi")').$buffer();
                assertJson(Array.from(new Uint8Array(buf)), [104, 105]);
            });
            t("slice", () => assertJson(Python.eval("[0, 1, 2, 3, 4]").$item(Python.slice(1, 3)).$toJS(), [1, 2]));

            // capture
            t("capture stdout", () => {
                const cap = Python.capture(() => Python.exec('print("hi")'));
                assertEq(cap.stdout, "hi\n");
            });
            t("capture stderr", () => {
                const cap = Python.capture(() => Python.exec("import sys; sys.stderr.write('err')"));
                assertEq(cap.stderr, "err");
            });

            // backtrace: current Python call stack (empty when no Python frame runs).
            t("backtrace shape", () => {
                const bt = Python.backtrace();
                assert(Array.isArray(bt));
                bt.forEach(f => assert(typeof f.name === "string" && typeof f.lineno === "number"));
            });

            // sub-interpreter enumeration
            t("interpreters lists main", () => {
                const is = Python.interpreters();
                assert(is.length >= 1 && is.some(i => i.isMain));
            });

            // Experimental instrumentation: per-thread tracing/profiling and PEP 523
            // frame-eval hooking. These fire JS callbacks during interpreter execution
            // and, combined with the rest of the suite, can destabilize Frida's QuickJS
            // (crash/hang). They work for normal single use; opt in with experimental=true.
            if (experimental) {
            // profiling
            t("setProfile observes calls", () => {
                                const names = [];
                try {
                    Python.setProfile(e => {
                        if (e.what === "call") names.push(e.funcName);
                    });
                    Python.exec("def __pf():\n    return 42\n__pf()");
                } finally {
                    Python.unsetProfile();
                }
                assert(names.indexOf("__pf") >= 0);
            });

            // tracing
            t("setTrace observes events", () => {
                                let events = 0;
                try {
                    Python.setTrace(() => {
                        events += 1;
                    });
                    Python.exec("def __tr():\n    x = 1\n    return x\n__tr()");
                } finally {
                    Python.unsetTrace();
                }
                assert(events > 0);
            });

            // PEP 523 frame-eval hooking (capability-gated)
            t("frame-eval hook", () => {
                if (!Python.canHookFrames()) return; // unavailable on this build -> pass
                let count = 0;
                try {
                    Python.setFrameHook(() => {
                        count += 1;
                    });
                    Python.exec("def __fe():\n    return sum(range(3))\n__fe()");
                } finally {
                    Python.unsetFrameHook();
                }
                assert(count > 0);
            });
            } // end experimental

            // refcount: retain takes an extra ref
            t("retain increments refcount", () => {
                const sys = Python.import("sys");
                const obj = Python.eval("object()");
                const before = sys.getrefcount(obj).$toJS();
                const r = obj.$retain();
                const after = sys.getrefcount(obj).$toJS();
                r.$dispose();
                assert(after > before);
            });

            // long-tail marshalling
            t("marshal datetime", () => {
                const d = Python.eval("__import__('datetime').datetime(2021, 6, 28, 1, 2, 3)", { toJS: true });
                assert(d instanceof Date && d.getFullYear() === 2021);
            });
            t("marshal date", () => {
                const d = Python.eval("__import__('datetime').date(2021, 6, 28)", { toJS: true });
                assert(d instanceof Date);
            });
            t("marshal Decimal", () => {
                assertEq(Python.eval("__import__('decimal').Decimal('1.5')", { toJS: true }), 1.5);
            });
            t("dict $entries preserves non-str keys", () => {
                const entries = Python.eval("{1: 'a', 2: 'b'}").$entries();
                entries.sort((x, y) => x[0] - y[0]);
                assertJson(entries, [[1, "a"], [2, "b"]]);
            });

            // deterministic no-leak check: disposed retains drain at the perform boundary
            t("no refcount leak after dispose+drain", () => {
                const sys = Python.import("sys");
                const target = Python.eval("object()");
                const base = sys.getrefcount(target).$toJS();
                const retained = [];
                for (let i = 0; i < 50; i++) retained.push(target.$retain());
                const high = sys.getrefcount(target).$toJS();
                // performNow drains queued decrefs at its boundary.
                Python.performNow(() => retained.forEach(r => r.$dispose()));
                const after = sys.getrefcount(target).$toJS();
                assertEq(high - base, 50);
                assertEq(after, base);
            });
        });

        return { results, total: idx };
    },
};
