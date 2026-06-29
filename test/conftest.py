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


# Tests per fresh injection. The agent runs in Frida's QuickJS; accumulating many
# instrumentation operations (wrappers/bindWeak/hooks/trace) in a single long-lived
# script eventually destabilizes the runtime, so we shard the suite across several
# fresh injections to keep per-script cumulative state low.
_SHARD = 10


def _inject_and_run(lo, hi):
    """Spawn a fresh CPython host, inject the agent, run tests [lo, hi). Returns
    {results, total}. Raises on a crash / agent error so the caller can retry."""
    import frida

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

        out = exports.run(lo, hi)
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

    results = []
    lo = 0
    total = None
    while total is None or lo < total:
        # Each shard runs in its own process; retry a shard a few times if the QuickJS
        # script is torn down mid-run (a rare environmental flake).
        last_err = None
        for _attempt in range(4):
            try:
                out = _inject_and_run(lo, lo + _SHARD)
                results.extend(out["results"])
                total = out["total"]
                last_err = None
                break
            except Exception as exc:
                last_err = exc
                time.sleep(0.5)
        if last_err is not None:
            raise last_err
        lo += _SHARD

    _cache["results"] = results
    return results


def pytest_generate_tests(metafunc):
    """Turn each in-interpreter assertion into its own test case (id = its name)."""
    if "case" in metafunc.fixturenames:
        results = _run_suite()
        metafunc.parametrize("case", results, ids=[r["name"] for r in results])
