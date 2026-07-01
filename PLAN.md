# frida-python-bridge — Roadmap (remaining work)

The bridge is implemented, tested, and documented — see [`README.md`](./README.md) for the
API/usage and [`lib/`](./lib) for the code. Implemented and covered by the pytest suite
(validated on CPython 3.10.7 x64 / Frida 17.9.1 / Windows; supports CPython 3.6+; CI across
3.8–3.14 × {Ubuntu, macOS, Windows}, a `3.13t` free-threaded lane, a `legacy-targets` job for
3.6/3.7, and a `static-host` job — see README's [Tests](./README.md#tests) table for the full
per-file {OS × Python} breakdown):

- discovery (incl. non-`python` host executables, statically-linked hosts built with
  `-export-dynamic`, and the `$config.moduleName`/`$config.exports` escape hatch for fully
  stripped binaries where no exported or symbol-table name survives at all — see
  [`test_static_host.py`](./test/test_static_host.py)), GIL-safe `perform`/`performNow` with
  deferred decref + finalization guard + thread warm-up, non-CPython detection/refusal;
- `eval`/`exec`/`import`/`use`/`builtins`/`interrupt`, stdout/stderr `capture`;
- the `PyObject` Proxy wrapper (attributes, calls + vectorcall fast paths, iteration, subscript +
  `slice`, repr/str/type/className/dir/len/equals/hash, `$entries`, `$buffer` buffer protocol,
  retain/dispose with a verified no-leak guarantee);
- marshalling for int/float/bool/str/bytes/bytearray/None/list/tuple/set/frozenset/dict/complex/
  datetime/date/Decimal (+ big ints → `BigInt`);
- `PythonException`, `choose`, function/method **hooking** (`intercept`);
- **frame/stack introspection** (`backtrace`), **sub-interpreter enumeration + targeting**
  (`interpreters`, `performInInterpreter`/`...Now` via `PyThreadState_Swap`);
- a **CModule** hot-loop counter (`countInstances` — heap-wide instance count entirely in C,
  wrapping nothing);
- a **Python CLI** (`cli/main.py`, `bin`) with `info`/`eval`/`exec`/`dump`/`repl`;
- **execution-thread safety** (`rpc`/`setTimeout`/`recv` all GIL-attach safely — confirmed against
  frida-gum's own API docs, not just assumed; see README's
  [Execution thread safety](./README.md#execution-thread-safety));
- struct-offset safety: exported-symbol-only refcounting (no raw `ob_refcnt` writes) and 3.9+ frame
  accessor exports (no raw frame-struct reads), both verified by dedicated test cases rather than
  just claimed — see `test/agent.js`'s `isFreeThreaded`/`Py_IncRef and Py_DecRef are exported`/
  `backtrace uses accessor exports on 3.9+` cases.

**⚠️ Experimental (gated, not in default CI):** per-thread **tracing/profiling**
(`setProfile`/`setTrace`) and **PEP 523 frame-eval hooking** (`setFrameHook`). They work for normal
single use but fire JS callbacks during interpreter execution; combined at scale they can
destabilize Frida's QuickJS (crash/hang). Their tests run only with `FPB_EXPERIMENTAL=1`. A future
hardening pass should move the callback bodies into a `CModule` (no JS marshalling per event) to
make them robust enough for the default suite.

This document tracks only **what is not yet built**. Items marked **⚠️** are verified hazards.

## TODOs

- **⚠️ Free-threaded (3.13t/3.14t) — blocked upstream, not by us.** `PyGILState_Ensure/Release` and
  the exported `Py_IncRef`/`Py_DecRef` path should hold (no raw refcount-field reads in the hot
  path), and `version.isFreeThreaded` exists precisely so any future raw read can be gated on it —
  but this can't actually be *verified* on a real `3.13t`/`3.14t` build yet: the `freethreaded` CI
  job installs `frida` on `3.13t` and it fails (`error: metadata-generation-failed` — no
  free-threaded wheel exists), so the job notices and skips rather than running anything. Nothing
  to implement here until frida itself ships a free-threaded wheel; re-check periodically. An
  imported C-extension lacking `Py_mod_gil` can also re-enable the GIL mid-session regardless.

- **macOS `cli -f` spawn hangs on process exit.** `cli/main.py`'s own work completes correctly
  every time (captured stdout has had the exact right output in every observed run), but the
  spawned process then doesn't exit — reproduced past even a 120s budget, survived skipping
  `script.unload()` before the kill. Not yet root-caused; `test_cli.py` skips on macOS
  (`sys.platform == "darwin"`) until it is. The rest of the suite's launch-then-attach approach
  (see `conftest.py`'s `_launch_target`) does work reliably on macOS, so this is scoped
  specifically to the CLI's own spawn path, not the bridge's discovery/injection.

## References

- frida-il2cpp-bridge: <https://github.com/vfsfitvnm/frida-il2cpp-bridge>
- frida-java-bridge: <https://github.com/frida/frida-java-bridge>
- CPython C-API: threads/GIL <https://docs.python.org/3/c-api/threads.html> · init
  <https://docs.python.org/3/c-api/init.html> · veryhigh (eval) <https://docs.python.org/3/c-api/veryhigh.html>
- PEP 523 frame eval: <https://peps.python.org/pep-0523/> · eval-frame signature change
  <https://github.com/python/cpython/issues/141518>
- Free-threading: PEP 703 <https://peps.python.org/pep-0703/> ·
  <https://docs.python.org/3/howto/free-threading-extensions.html>
- Sub-interpreters: PEP 684 <https://peps.python.org/pep-0684/>
- Fresh-thread first-`Ensure` deadlock: <https://github.com/python/cpython/issues/96071>
- Frida 17 release / JS API: <https://frida.re/news/2025/05/17/frida-17-0-0-released/> ·
  <https://frida.re/docs/javascript-api/>
