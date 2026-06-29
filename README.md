# frida-python-bridge

A [Frida](https://frida.re) module to **introspect and drive a live CPython interpreter** at
runtime — the CPython analog of [`frida-il2cpp-bridge`](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
(IL2Cpp/Unity) and [`frida-java-bridge`](https://github.com/frida/frida-java-bridge) (`Java.use`/`Java.perform`).

It lets you attach to any process that embeds CPython 3.8+ and, from a Frida agent, call into the
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

> Status: **working** on CPython 3.8–3.13, Windows/Linux/macOS. CPython only (PyPy/Jython/GraalPy
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

## CI / publishing

- [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) — matrix of {Ubuntu, macOS, Windows} ×
  Python {3.8 … 3.13}, plus a free-threaded `3.13t` lane and a typecheck job.
- [`.github/workflows/release.yml`](./.github/workflows/release.yml) — on a `v*` tag: build, test,
  then `npm publish --provenance`. Requires an `NPM_TOKEN` repo secret (npm *Automation* token).
  Release with `npm version <patch|minor|major>` then `git push --follow-tags`.

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
