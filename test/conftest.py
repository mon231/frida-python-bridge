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


def _run_suite():
    if "results" in _cache:
        return _cache["results"]

    try:
        import frida
    except ImportError as exc:  # pragma: no cover
        raise pytest.UsageError("the `frida` Python package is required: pip install frida") from exc

    agent_source = _build_agent()
    code = "import sys; sys.path.insert(0, r'{}'); import app; app.main()".format(FIXTURES)

    device = frida.get_local_device()
    pid = device.spawn([sys.executable, "-c", code])

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
        # Let the interpreter finish initializing and create instances.
        time.sleep(2.0)
        exports = getattr(script, "exports_sync", None) or script.exports
        results = exports.run()
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

    _cache["results"] = results
    return results


def pytest_generate_tests(metafunc):
    """Turn each in-interpreter assertion into its own test case (id = its name)."""
    if "case" in metafunc.fixturenames:
        results = _run_suite()
        metafunc.parametrize("case", results, ids=[r["name"] for r in results])
