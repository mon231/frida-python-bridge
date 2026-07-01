# frida-python-bridge

A [Frida](https://frida.re) module to **introspect and drive a live CPython interpreter** at
runtime — the CPython analog of [`frida-il2cpp-bridge`](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
(IL2Cpp/Unity) and [`frida-java-bridge`](https://github.com/frida/frida-java-bridge) (`Java.use`/`Java.perform`).

It lets you attach to any process that embeds CPython 3.6+ and, from a Frida agent, call into the
interpreter with a small ergonomic API: evaluate code, import modules, construct objects, read and
set attributes, call methods, **find live instances**, read **class names**, and **install hooks**
on Python functions and methods.

```ts
import "frida-python-bridge";

Python.perform(() => {
  const os = Python.import("os");
  console.log(os.getcwd().$str());

  const Counter = Python.use("collections.Counter");        // Java.use-style
  const c = Counter([1, 1, 2, 3]);
  console.log(c.most_common(2).$repr());

  console.log(Python.eval("sum(range(10))", { toJS: true })); // 45

  for (const o of Python.choose("collections.Counter"))       // Java.choose-style
    console.log("live Counter:", o.$repr());
});
```

> Status: **working** on CPython 3.6–3.13, Windows/Linux/macOS. CPython only (PyPy/Jython/GraalPy
> are detected and refused). Includes method/function hooking, per-thread tracing/profiling, PEP 523
> frame-eval hooking, stdout/stderr capture, frame/stack introspection, and sub-interpreter
> enumeration. See [PLAN.md](./PLAN.md) for the remaining roadmap.

## How it works

Frida 17's GumJS resolves CPython's exported C-API functions from the loaded `libpython` /
`python3X.dll` / framework / static host, wraps them as `NativeFunction`s, and the bridge calls
them with the **GIL held** (`PyGILState_Ensure`/`Release`). `PyObject` handles are wrapped in a JS
`Proxy` for ergonomic access. References use **deferred decref**: a wrapper's GC/`$dispose`
finalizer enqueues its handle and the actual `Py_DecRef` runs at `perform()` boundaries (GIL held,
guarded against interpreter finalization), so a decref never fires mid-operation under the
nondeterministic GC.

## Install

```sh
npm install frida-python-bridge
npm install -D @types/frida-gum frida-compile
```

Write an agent that imports the package (a side-effect import that installs the global `Python`),
then bundle it with `frida-compile`:

```ts
// agent.ts
import "frida-python-bridge";
Python.perform(() => { /* ... */ });
```

```sh
npx frida-compile agent.ts -o agent.js
frida -f /usr/bin/python3 -l agent.js     # or: frida -n python.exe -l agent.js
```

A runnable example lives in [`example/`](./example).

## API

Everything hangs off the global `Python` namespace.

### Entry & discovery
| Member | Description |
|---|---|
| `Python.available` | `true` when CPython is found, initialized, and not finalizing |
| `Python.version` | `{ major, minor, micro, hex, isFreeThreaded, implementation }` |
| `Python.perform(fn)` | Acquire the GIL, run `fn`, release. **Wrap all interpreter access in this.** Returns a `Promise`. |
| `Python.performNow(fn)` | Synchronous variant (returns `fn`'s value) |
| `Python.$config` | `{ moduleName?, exports }` overrides for stripped/static/embedded hosts |
| `Python.interpreters()` | Enumerate interpreters (PEP 684); `[{ id, isMain }]` |
| `Python.performInInterpreter(id, fn)` / `...Now(id, fn)` | Run `fn` against a chosen interpreter (by id) via `PyThreadState_Swap`. `fn` must be synchronous. ⚠️ single-GIL targeting; objects must not cross interpreters |

### Code & objects
| Member | Description |
|---|---|
| `Python.eval(expr, { toJS? })` | Evaluate an expression → wrapped `PyObject` (or JS value if `toJS`) |
| `Python.exec(code, globals?)` | Run statements (no return value) |
| `Python.capture(fn)` | Run `fn` with stdout/stderr redirected → `{ stdout, stderr, result }` |
| `Python.importModule(name)` / `Python.import(name)` | Import a module |
| `Python.use(dotted)` | Resolve a dotted class/callable, e.g. `Python.use("app.Greeter")` |
| `Python.builtins` | The `builtins` module |
| `Python.choose(predicate?)` | Enumerate live instances via `gc.get_objects()`; `predicate` is a dotted type name, a type, or `(o) => boolean` |
| `Python.countInstances(type?)` | Fast heap-wide instance **count** (CModule; counts in C, wraps nothing). `type` is a dotted name or type; omit to count all GC-tracked objects. No JS-predicate form |
| `Python.kw({ ... })` | Wrap keyword arguments for a call |
| `Python.slice(start?, stop?, step?)` | Build a Python `slice` (for `$item`) |
| `Python.intercept(target, name, handler)` | Hook `target.name`; returns `{ original, revert() }` |
| `Python.interrupt()` | Raise `KeyboardInterrupt` (abort a runaway eval; 3.10+) |

### Tracing & stacks
| Member | Description |
|---|---|
| `Python.backtrace(limit?)` | Current Python call stack → `[{ name, filename, lineno }]` (innermost first) |
| `Python.setProfile(fn)` / `Python.unsetProfile()` | Per-thread profile hook (call/return events). **Experimental** ¹ |
| `Python.setTrace(fn)` / `Python.unsetTrace()` | Per-thread trace hook (adds line events). **Experimental** ¹ |
| `Python.canHookFrames()` | Whether PEP 523 frame-eval hooking is available |
| `Python.setFrameHook(fn)` / `Python.unsetFrameHook()` | PEP 523 eval-frame hook (every frame). **Experimental / high-overhead** ¹ — handler must be cheap and not call into Python |

¹ These fire JS callbacks during interpreter execution; fine for targeted single use, but heavy
sustained use can destabilize Frida's QuickJS. They're excluded from the default test suite (run
them with `FPB_EXPERIMENTAL=1`).

### `PyObject` (wrapped)
Ergonomic Proxy access plus explicit `$`-prefixed methods (which never collide with Python
attribute names):

`obj.attr` / `obj.attr = v` (attribute get/set) · `obj(...args)` (call) · `for (const x of obj)`
(iterate) · `$get`/`$set`/`$call`/`$item`/`$setItem` · `$entries` (mapping pairs, preserves
non-string keys) · `$str`/`$repr`/`$type`/`$className`/`$dir`/`$len` · `$toJS` · `$buffer` (buffer
protocol → `ArrayBuffer`) · `$equals`/`$hash` · `$retain`/`$dispose`.

Pass a trailing `Python.kw({...})` to `$call`/`obj(...)` for keyword arguments. Python exceptions
surface as `Python.PythonException` (`.pythonType`, `.message`, `.traceback`).

**Marshalling** (`$toJS` / `toJS`): `int`/`float`/`bool`/`str`/`None` ↔ JS primitives, big ints →
`BigInt`, `bytes`/`bytearray` → `ArrayBuffer`, `list`/`tuple`/`set`/`frozenset` → array,
`dict` → object (use `$entries()` for non-string keys), `complex` → `{ real, imag }`,
`datetime`/`date` → `Date`, `Decimal` → number; anything else stays a wrapped `PyObject`.

## Hooking

```ts
Python.perform(() => {
  const app = Python.import("app");

  // Observe + pass through (return undefined -> call original):
  const h1 = Python.intercept(app, "greet", (args) => {
    console.log("greet:", args[0].$str());
  });

  // Override the return value:
  const h2 = Python.intercept(app, "add", (args) => args[0].$toJS() + args[1].$toJS() + 100);

  // Hook an instance method (self is args[0]); call through with `original`:
  const Greeter = Python.use("app.Greeter");
  const h3 = Python.intercept(Greeter, "hello", (args, original) => {
    console.log("hello on", args[0].name.$str());
    return original(...args);
  });

  // h1.revert(); h2.revert(); h3.revert();
});
```

## Tracing & capturing output

```ts
Python.perform(() => {
  // Capture stdout/stderr from injected code.
  const cap = Python.capture(() => Python.exec('print("hello")'));
  console.log(cap.stdout); // "hello\n"

  // Profile every Python call on this thread.
  const calls = [];
  Python.setProfile((e) => { if (e.what === "call") calls.push(e.funcName); });
  Python.exec("def f():\n    return 1\nf()");
  Python.unsetProfile();
  console.log(calls); // [..., "f"]

  // Read the current call stack from inside a hook.
  Python.intercept(Python.use("app.Greeter"), "hello", (args, original) => {
    console.log(Python.backtrace().map((f) => f.name));
    return original(...args);
  });
});
```

## CLI

A small `frida`-wrapping CLI ships with the package (`bin: frida-python-bridge`, requires
`pip install frida`):

```sh
# attach to a running interpreter...
frida-python-bridge -n python.exe info
frida-python-bridge -p 1234 eval "sys.version"
frida-python-bridge -n python dump collections.OrderedDict   # list live instances

# ...or spawn one (-f PROGRAM, with each child arg as a --arg to avoid shell quoting)
frida-python-bridge -f /usr/bin/python3 --arg=myscript.py repl
```

Subcommands: `info`, `eval <expr>`, `exec <code>`, `dump <dotted.Type>`, `repl`.

## Develop / build / test

```sh
npm install
npm run build                       # tsc -> dist/index.js + dist/index.d.ts
pip install -r requirements-dev.txt # frida + pytest
pytest                              # or: npm test  (which builds first)
```

The [pytest](https://pytest.org) suite ([`test/`](./test)) spawns the current Python interpreter
running [`test/fixtures/app.py`](./test/fixtures/app.py), injects `dist/index.js` +
[`test/agent.js`](./test/agent.js), and runs in-interpreter assertions for marshalling, calls,
introspection, `choose`, and hooking — each surfaced as its own test case. It runs on
**Windows, Linux and macOS**; on Linux self-injection needs `sudo sysctl kernel.yama.ptrace_scope=0`.
[`test/manual.py`](./test/manual.py) is a lighter human-readable demo.

## Tests

Every assertion inside a live interpreter ([`test/agent.js`](./test/agent.js)) is surfaced as its
own `pytest` case (`test_case[<name>]`), so `pytest -v` or `-k` targets a single behavior directly.
The table below is at the level of test *files* — what each one is actually checking, and which
{OS × Python} combinations run it in CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)).
"Runs" means the assertions execute for real and must pass; `xfail` means the test executes but a
known, tracked failure is tolerated (a pass is fine too — `strict=False` — but a red is not).

| Test file | What it covers | Ubuntu | macOS | Windows |
|---|---|---|---|---|
| [`test_bridge.py`](./test/test_bridge.py) — parametrized cases | Core API: discovery, `eval`/`exec`/`import`/`use`/`builtins`, the `PyObject` proxy (attrs, calls, vectorcall, iteration, subscript/slice, repr/dir/len/equals/hash), marshalling (int/float/bool/str/bytes/bytearray/None/list/tuple/set/frozenset/dict/complex/datetime/date/Decimal/bigint), `choose`/`countInstances`, hooking (`intercept`), `PythonException`, buffer protocol, stdout/stderr capture, backtrace, sub-interpreters (`interpreters`/`performInInterpreter`), retain/dispose + no-leak guarantee, free-threaded-safety markers (`isFreeThreaded`, exported-symbol-only refcounting, 3.9+ frame accessors) | 3.8–3.14 | 3.10–3.14 | 3.8–3.14 |
| `test_bridge.py` — `test_perform_from_setTimeout_thread`, `test_perform_from_recv_thread` | `Python.perform`/`performNow` GIL-attach safety from the `setTimeout` and `recv` GumJS thread contexts (`rpc` coverage is implicit in every case above) — see [Execution thread safety](#execution-thread-safety) | 3.8–3.14 | 3.10–3.14 | 3.8–3.14 |
| [`test_cli.py`](./test/test_cli.py) | The `cli/main.py` CLI: `-f` spawn + `info`/`dump`/`eval` | 3.8–3.14 | *skipped* — `-f` spawn hangs on process exit; tracked | 3.8–3.14 |
| [`test_embedded.py`](./test/test_embedded.py) | Discovery when the host executable is *not* `python(.exe)` — a small C program dynamically embedding `libpythonX.Y` | 3.8–3.14 | 3.10–3.14 | *skipped* — needs `cc`/`python3-config`, Linux/macOS only |
| [`test_pyinstaller.py`](./test/test_pyinstaller.py) | Discovery inside a PyInstaller `--onefile` bundle, incl. locating the real Python process when the bootloader re-execs into a child | 3.8–3.14 (`xfail`: known glibc/stack crash) | 3.10–3.14 | 3.8–3.14 |
| [`test_static_host.py`](./test/test_static_host.py) | A **statically-linked** interpreter (`-Wl,--export-dynamic`: `Py_GetVersion` lives in the main executable, not a separate module) and a **fully stripped** static binary (no exported or symbol-table name survives at all) — proves auto-discovery works for the first and fails cleanly for the second, and that the `Python.$config.moduleName`/`$config.exports` escape hatch recovers it | 3.12 only, dedicated `static-host` job (needs a from-source `--disable-shared` CPython build) | — | — |
| `test_bridge.py` (subset) via `legacy-targets` job | Same core suite, injected into an **EOL** target interpreter from a modern frida host (frida itself no longer installs on 3.6/3.7) | 3.6, 3.7 (target; host 3.11) | — | — |
| Whole suite via `freethreaded` job | Free-threaded (PEP 703) build safety | 3.13t — currently always a no-op: frida has no free-threaded wheel yet, so the job installs, sees `import frida` fail, and skips with a notice instead of going red | — | — |
| Trace/profile/frame-eval cases in `agent.js` (`setProfile`/`setTrace`/`setFrameHook`) | Per-thread tracing/profiling, PEP 523 frame-eval hooking | **not run in any default CI job** — gated behind `FPB_EXPERIMENTAL=1` (opt-in locally); see [PLAN.md](./PLAN.md) for why | | |
| `typecheck` job | `npx tsc --noEmit` — not a pytest test | ubuntu-only | — | — |

## CI / publishing

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — matrix of {Ubuntu, macOS, Windows} ×
  Python {3.8 … 3.14}, a `legacy-targets` job that injects into 3.6/3.7 interpreters from a
  modern frida host, a free-threaded `3.13t` lane, a `static-host` job (Linux/3.12 only — see
  [Tests](#tests)), and a typecheck job.
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) — on a `v*` tag: build, test,
  then `npm publish --provenance`. Requires an `NPM_TOKEN` repo secret (npm *Automation* token).
  Release with `npm version <patch|minor|major>` then `git push --follow-tags`.

## Execution thread safety

Frida runs your agent in a single JavaScript thread (the GumJS script thread). All callbacks —
**rpc exports**, **`setTimeout`/`setInterval`** timers, and **`recv`** message handlers — execute
on that same thread. From CPython's perspective this is a *GIL-less thread* (one that has never
registered as a Python thread). `Python.perform`/`performNow` call `PyGILState_Ensure` on entry,
which creates a `PyThreadState` for the caller on the first call and re-acquires the GIL on every
subsequent call, then calls `PyGILState_Release` on exit. This is exactly how
[`frida-java-bridge`](https://github.com/frida/frida-java-bridge) attaches JNI threads.

All three contexts are therefore safe without any extra setup:

```ts
// 1. rpc export (most common)
rpc.exports = {
  query() { return Python.performNow(() => Python.eval("sys.version", { toJS: true })); },
};

// 2. setTimeout / setInterval
setTimeout(() => Python.perform(() => { Python.exec("import gc; gc.collect()"); }), 1000);

// 3. recv message handler
recv("trigger", (_msg) => Python.perform(() => { Python.exec("do_something()"); }));
```

CPython documents `PyGILState_Ensure` for exactly this use-case:
<https://docs.python.org/3/c-api/init.html#c.PyGILState_Ensure>.

Confirmed directly against frida-gum's own API surface (`@types/frida-gum`), not just assumed:
`setTimeout`/`setImmediate` are documented as running "on **Frida's JavaScript thread**" (singular,
definite article) — the same thread `rpc.exports` handlers and `recv` callbacks run on, since a
GumJS script instance has exactly one JavaScript thread/event loop, not one per callback kind.
`test_perform_from_setTimeout_thread` / `test_perform_from_recv_thread`
([`test/test_bridge.py`](./test/test_bridge.py)) exercise all three contexts explicitly against a
live interpreter rather than relying on this by inference alone.

The only constraint is not holding the GIL across an `await` inside the `perform` async form when
other Python threads need to run; use `performNow` (synchronous, GIL held for the entire block) or
release the GIL between awaits via `Python.exec("pass")` at a safe point.

## Notes & limitations

- **GIL safety:** never touch the interpreter outside `Python.perform`/`performNow`.
- **`Python.choose`** only sees GC-tracked objects (containers, user-defined instances); bare
  `int`/`str`/empty `dict` are invisible — same as `gc.get_objects()`.
- **Code execution is unsafe** by nature: injected `eval`/`exec` runs with full interpreter
  privileges and can crash or hang the host. Use `Python.interrupt()` to abort.
- **Free-threaded (3.13t)** and **sub-interpreters (PEP 684)** are best-effort; see PLAN.md.
- **CPython only.** Non-CPython runtimes are detected and refused.

## License

MIT © Ariel Tubul
