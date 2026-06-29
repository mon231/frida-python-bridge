"""pytest harness for frida-python-bridge.

Injects the built bridge (dist/index.js) plus the assertion agent (agent.js) into a
live CPython host (the current interpreter running test/fixtures/app.py), runs the
in-interpreter assertion suite once, and exposes each assertion as a parametrized
test case.

Requires a prior ``npm run build``. Cross-platform (Windows / Linux / macOS); on
Linux, self-injection needs ``sysctl kernel.yama.ptrace_scope=0``.
"""

import os
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")

# Cache the (expensive) injection so the suite runs a single time per session.
_cache = {}


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
    pid = device.spawn([target_python, "-c", code], env=env)

    script = None
    errors = []
    try:
        session = device.attach(pid)
        script = session.create_script(agent_source)
        script.on(
            "message",
            lambda message, data: errors.append(message.get("stack") or message.get("description"))
            if message["type"] == "error"
            else None,
        )
        script.load()
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
            raise RuntimeError("interpreter did not become available within 30s")
        time.sleep(0.3)

        experimental = os.environ.get("FPB_EXPERIMENTAL") == "1"
        out = exports.run(lo, hi, experimental)
    finally:
        try:
            if script is not None:
                script.unload()
        except Exception:
            pass
        try:
            device.kill(pid)
        except Exception:
            pass

    if errors:
        raise RuntimeError("frida agent reported errors: " + "; ".join(str(e) for e in errors))
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
    if "case" in metafunc.fixturenames:
        results = _run_suite()
        metafunc.parametrize("case", results, ids=[r["name"] for r in results])
