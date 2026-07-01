"""pytest harness for frida-python-bridge.

Injects the built bridge (dist/index.js) plus the assertion agent (agent.js) into a
live CPython host (the current interpreter running test/fixtures/app.py), runs the
in-interpreter assertion suite once, and exposes each assertion as a parametrized
test case.

Requires a prior ``npm run build``. Cross-platform (Windows / Linux / macOS); on
Linux, self-injection needs ``sysctl kernel.yama.ptrace_scope=0``.
"""

import glob as _glob
import os
import shutil
import subprocess
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")

# Cache the (expensive) injection so the suite runs a single time per session.
_cache = {}


def _launch_target(device, target_python, code, env):
    """Start the quiet target host. Returns ``(pid, proc)``; ``proc`` is the
    ``subprocess.Popen`` handle on macOS, ``None`` elsewhere (frida-spawned).

    macOS: frida's spawn-then-attach-while-suspended path has repeated public crash
    reports during the target's *own* dyld/CoreFoundation bootstrap (frida-core#519:
    EXC_BAD_ACCESS in __CFInitialize; frida-core#524: EXC_GUARD/task_for_pid) - i.e.
    the crash is in frida injecting into a process that hasn't finished starting yet,
    not in anything this bridge does. Sidestep it by launching normally and attaching
    only once the process is already alive and idling in its own event loop, instead of
    frida spawn-gating + resume.
    """
    if sys.platform == "darwin":
        proc = subprocess.Popen([target_python, "-c", code], env=env)
        # Give dyld a moment to finish the process's own early bootstrap before frida
        # attaches - attaching immediately has intermittently raised
        # frida.NotSupportedError("unable to read from process memory"), consistent
        # with the same early-startup fragility as #519/#524 above, just probabilistic
        # under load rather than deterministic.
        time.sleep(0.3)
        return proc.pid, proc
    return device.spawn([target_python, "-c", code], env=env), None


def _teardown_target(device, pid, proc):
    if proc is not None:
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
    else:
        try:
            device.kill(pid)
        except Exception:
            pass


def _cleanup_frida_tmp():
    """Remove Frida's per-run temp files (Windows: %LOCALAPPDATA%\\tmp\\frida-*; others: /tmp/frida-*)."""
    if sys.platform == "win32":
        base = os.path.join(os.environ.get("LOCALAPPDATA", ""), "tmp")
    else:
        base = "/tmp"
    if not os.path.isdir(base):
        return
    for path in _glob.glob(os.path.join(base, "frida-*")):
        try:
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.unlink(path)
        except Exception:
            pass


def _build_agent():
    dist = os.path.join(ROOT, "dist", "index.js")
    if not os.path.exists(dist):
        raise pytest.UsageError("dist/index.js not found - run `npm run build` first")
    with open(dist, encoding="utf-8") as f:
        bridge = f.read()
    with open(os.path.join(HERE, "agent.js"), encoding="utf-8") as f:
        agent = f.read()
    return bridge + "\n" + agent


def _inject_and_run(lo, hi):
    """Spawn a fresh CPython host, inject the agent, run tests [lo, hi). Returns
    {results, total}. Raises on a crash / agent error so the caller can retry."""
    import frida

    agent_source = _build_agent()
    # Quiet host: just keep the interpreter alive. The fixtures dir is on PYTHONPATH so the
    # tests can `import app` on demand (no busy background thread to churn objects / fight
    # the GIL). The fixture seeds Greeter instances at import time, so choose() finds them.
    code = "import time\nwhile True: time.sleep(0.5)"
    env = dict(os.environ, PYTHONPATH=FIXTURES + os.pathsep + os.environ.get("PYTHONPATH", ""))

    # The TARGET interpreter may differ from the host running pytest/frida: frida injects
    # the bridge into any CPython (3.6+) regardless of its version, so we can exercise old
    # interpreters from a modern frida host. Set FPB_TARGET_PYTHON to a 3.6/3.7 binary.
    target_python = os.environ.get("FPB_TARGET_PYTHON") or sys.executable

    device = frida.get_local_device()
    pid, proc = _launch_target(device, target_python, code, env)

    script = None
    errors = []
    detach_info = []
    try:
        session = device.attach(pid)
        # If the target dies outright (segfault/abort), every later RPC call just raises
        # "script has been destroyed" with no clue why. `detached` fires with the *reason*
        # and, when the process actually crashed, a CrashInfo (report/summary) - capture it
        # so a CI failure says *why* the process died instead of just "it went quiet".
        session.on(
            "detached",
            lambda reason, crash=None: detach_info.append(
                {"reason": str(reason), "crash": getattr(crash, "report", None) or str(crash) if crash else None}
            ),
        )
        script = session.create_script(agent_source)
        script.on(
            "message",
            lambda message, data: errors.append(message.get("stack") or message.get("description"))
            if message["type"] == "error"
            else None,
        )
        script.load()
        if proc is None:  # frida-spawned (suspended); a plain Popen target is already running
            device.resume(pid)

        exports = getattr(script, "exports_sync", None) or script.exports

        # Wait until the interpreter is initialized (CI runners can be slow).
        ready = False
        for _ in range(300):  # up to ~30s
            try:
                if exports.ready():
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.1)
        if not ready:
            diag = None
            try:
                diag = exports.diag()
            except Exception as exc:  # noqa: BLE001
                diag = {"diagError": str(exc)}
            raise RuntimeError(
                "interpreter did not become available within 30s; diag=%r; detach=%r"
                % (diag, detach_info)
            )
        time.sleep(0.3)

        experimental = os.environ.get("FPB_EXPERIMENTAL") == "1"
        out = exports.run(lo, hi, experimental)
    finally:
        if proc is None:  # frida-spawned: unload before device.kill()
            try:
                if script is not None:
                    script.unload()
            except Exception:
                pass
        # else: we own this process and are about to hard-kill it regardless, so skip
        # unload - it has been observed to hang for minutes on macOS (cli/main.py hit
        # the same thing; see its finally block for the full rationale).
        _teardown_target(device, pid, proc)

    if errors:
        raise RuntimeError("frida agent reported errors: " + "; ".join(str(e) for e in errors))
    _cleanup_frida_tmp()
    return out


def _run_suite():
    if "results" in _cache:
        return _cache["results"]

    try:
        import frida  # noqa: F401
    except ImportError as exc:  # pragma: no cover
        raise pytest.UsageError("the `frida` Python package is required: pip install frida") from exc

    # The whole suite runs in one injection. The assertions are deterministic; the only
    # flake is that Frida's QuickJS occasionally tears the script down mid-run under heavy
    # instrumentation churn ("script has been destroyed"), so retry the injection.
    last_err = None
    for _attempt in range(6):
        try:
            out = _inject_and_run(0, 1 << 30)
            _cache["results"] = out["results"]
            return out["results"]
        except Exception as exc:
            last_err = exc
            time.sleep(1.0)
    raise last_err


def pytest_generate_tests(metafunc):
    """Turn each in-interpreter assertion into its own test case (id = its name)."""
    if "case" not in metafunc.fixturenames:
        return
    results = _run_suite()
    metafunc.parametrize("case", results, ids=[r["name"] for r in results])


def _setup_live_session(device, target_python, code, env, agent_source):
    """One attempt at launching + attaching + waiting for readiness.

    Returns ``(pid, proc, script, exports)`` on success. On any failure, tears down
    whatever got created and re-raises, so the caller can retry cleanly.
    """
    pid, proc = _launch_target(device, target_python, code, env)
    script = None
    try:
        session = device.attach(pid)
        script = session.create_script(agent_source)
        script.load()
        if proc is None:
            device.resume(pid)
        exports = getattr(script, "exports_sync", None) or script.exports
        ready = False
        for _ in range(300):  # up to ~30s
            try:
                if exports.ready():
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.1)
        if not ready:
            raise RuntimeError("interpreter did not become available within 30s")
        return pid, proc, script, exports
    except Exception:
        if proc is None:
            try:
                if script is not None:
                    script.unload()
            except Exception:
                pass
        _teardown_target(device, pid, proc)
        raise


@pytest.fixture(scope="module")
def live_session():
    """A persistent live Frida session (exports, script) for non-parametrised tests.

    Yields ``(exports, script)`` with the target interpreter already initialised.
    The session is torn down (script unloaded, process killed, Frida tmp cleaned) at
    module scope so all tests sharing this fixture reuse the same injection.
    """
    try:
        import frida  # noqa: F401
    except ImportError as exc:
        pytest.skip("frida not installed: %s" % exc)

    agent_source = _build_agent()
    code = "import time\nwhile True: time.sleep(0.5)"
    env = dict(os.environ, PYTHONPATH=FIXTURES + os.pathsep + os.environ.get("PYTHONPATH", ""))
    target_python = os.environ.get("FPB_TARGET_PYTHON") or sys.executable

    import frida

    device = frida.get_local_device()
    # Injection is occasionally flaky (see _run_suite's retry loop for the same reason);
    # this fixture previously had no retry at all, so any transient failure here (e.g. an
    # attach racing the target process's own startup) failed the whole module outright.
    last_err = None
    result = None
    for _attempt in range(3):
        try:
            result = _setup_live_session(device, target_python, code, env, agent_source)
            break
        except Exception as exc:
            last_err = exc
            time.sleep(1.0)
    if result is None:
        raise last_err
    pid, proc, script, exports = result

    try:
        yield exports, script
    finally:
        if proc is None:  # frida-spawned: unload before device.kill()
            try:
                script.unload()
            except Exception:
                pass
        # else: about to hard-kill our own process regardless - see _inject_and_run's
        # finally block for why we skip unload there on macOS.
        _teardown_target(device, pid, proc)
        _cleanup_frida_tmp()
