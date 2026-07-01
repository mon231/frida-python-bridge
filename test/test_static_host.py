"""Static/stripped-host coverage for the discovery fallback chain (PLAN.md TODO).

Every other test in this suite sees CPython as a *dynamically loaded* module (a plain
python.exe, or embed_host in test_embedded.py linking libpythonX.Y.so) - Py_GetVersion is
always found via a normal shared-library export table. Two scenarios PLAN.md calls out are
otherwise uncovered:

1. A statically-linked interpreter built with ``-Wl,--export-dynamic``: Py_GetVersion lives
   in the *main executable itself*, exercising ``locate()``'s ``Module.findGlobalExportByName``
   fallback (module.ts steps 3/4) rather than the "separate module" path.
2. The same interpreter, statically linked *without* ``--export-dynamic`` and then
   ``strip --strip-all``'d: no exported or symbol-table name survives at all. Auto-discovery
   must fail cleanly, and the documented escape hatch (``Python.$config.moduleName`` /
   ``$config.exports``, addresses supplied as module-base + a precomputed offset) must
   recover it.

Gated on env vars set only by the ``static-host`` CI job (Linux x86_64, Python 3.12 - see
.github/workflows/ci.yml), which builds both hosts from a from-source ``--disable-shared``
CPython build; skipped everywhere else (including plain local development).
"""

import json
import os
import subprocess
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")

DYNAMIC_HOST = os.environ.get("FPB_STATIC_HOST_DYNAMIC")
STRIPPED_HOST = os.environ.get("FPB_STATIC_HOST_STRIPPED")
STRIPPED_OFFSETS = os.environ.get("FPB_STATIC_HOST_STRIPPED_OFFSETS")

pytestmark = pytest.mark.skipif(
    not (DYNAMIC_HOST and STRIPPED_HOST and STRIPPED_OFFSETS),
    reason="static/stripped host binaries not built - set FPB_STATIC_HOST_DYNAMIC / "
    "_STRIPPED / _STRIPPED_OFFSETS (see the static-host CI job); this needs a from-source "
    "static CPython build, so it only runs there, not in normal local/CI runs",
)


def _bridge_source():
    with open(os.path.join(ROOT, "dist", "index.js"), encoding="utf-8") as f:
        return f.read()


def _inject(host_path, agent_suffix):
    """Launch host_path, inject bridge+agent_suffix. Returns ``(exports, teardown_fn)``.

    Uses subprocess.Popen + device.attach() rather than device.spawn()+resume(): the
    export-dynamic host was observed hanging with Py_IsInitialized() stuck at 0 forever
    under spawn+resume, while running the *same* binary standalone (no frida at all)
    completes Py_Initialize() immediately with no error - i.e. frida's spawn-suspend-resume
    sequence itself was the problem for this binary, not anything about the build or the
    bridge. Attaching to an already-running process sidesteps that entirely, same fix as
    conftest.py's _launch_target uses for macOS (frida-core#519/#524) - the two are
    different platforms hitting the same class of spawn-gating fragility.
    """
    import frida

    agent_source = _bridge_source() + agent_suffix
    env = dict(os.environ, FRIDA_FIXTURES=FIXTURES)
    proc = subprocess.Popen([host_path], env=env)
    device = frida.get_local_device()
    session = device.attach(proc.pid)
    script = session.create_script(agent_source)
    script.load()
    exports = getattr(script, "exports_sync", None) or script.exports

    def teardown():
        # Don't unload the script first - we're about to hard-kill our own process
        # regardless, and unload-before-kill has hung for minutes in this exact
        # situation on macOS (see cli/main.py's finally block for the full story).
        try:
            proc.kill()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    return exports, teardown


def test_static_export_dynamic_host_discovers_automatically():
    """Py_GetVersion lives in the main exe; locate() must find it there with no $config."""
    # Deliberately doesn't go through Python.available for the diagnostic fields: isLive()
    # swallows its own exceptions internally, so a getModule() failure would otherwise be
    # indistinguishable from "not initialized yet" - call Python.module directly so a
    # discovery failure surfaces as a real, inspectable error.
    agent = r"""
rpc.exports = { run() {
    const d = {};
    try { d.moduleName = Python.module.name; d.mainExeName = Process.mainModule.name; }
    catch (e) { d.moduleError = String(e); }
    try { d.hasPyIsInitialized = Python.hasExport("Py_IsInitialized"); } catch (e) { d.hasExportError = String(e); }
    try { d.py_IsInitialized = Python.api.Py_IsInitialized(); } catch (e) { d.callError = String(e); }
    try { d.available = Python.available === true; } catch (e) { d.availError = String(e); }
    if (d.available) {
        try {
            d.impl = Python.version.implementation;
            d.evalOk = Python.eval("1 + 2", { toJS: true }) === 3;
        } catch (e) { d.evalError = String(e); }
    }
    return d;
} };
"""
    exports, teardown = _inject(DYNAMIC_HOST, agent)
    try:
        res = None
        for _ in range(300):  # up to ~30s
            try:
                res = exports.run()
                if res.get("available"):
                    break
            except Exception:
                pass
            time.sleep(0.1)
        assert res is not None and res.get("available"), "never became available: %r" % (res,)
        assert res["impl"] == "cpython"
        assert res["moduleName"] == res["mainExeName"], "Py_GetVersion should resolve to the main executable itself"
        assert res["evalOk"] is True
    finally:
        teardown()


def test_static_stripped_host_fails_without_config():
    """A fully stripped binary must not be auto-discoverable - no name survives to find."""
    agent = r"""
rpc.exports = { run() {
    try { return { available: Python.available === true }; }
    catch (e) { return { available: false, error: String(e) }; }
} };
"""
    exports, teardown = _inject(STRIPPED_HOST, agent)
    try:
        # No polling-until-true here - poll for a while (giving Py_Initialize a real
        # chance to finish) and require every observation to stay False throughout, so a
        # transient false (not yet initialized) can't be mistaken for a real failure to
        # discover the symbol.
        seen = []
        for _ in range(30):  # ~3s
            seen.append(exports.run())
            time.sleep(0.1)
        assert all(r.get("available") is False for r in seen), (
            "should never auto-discover Py_GetVersion in a fully stripped binary: %r" % (seen,)
        )
    finally:
        teardown()


def test_static_stripped_host_recovers_with_config():
    """The documented $config.moduleName/$config.exports escape hatch must recover it."""
    with open(STRIPPED_OFFSETS, encoding="utf-8") as f:
        offsets = json.load(f)

    agent = r"""
rpc.exports = { run() {
    const offsets = %s;
    const base = Process.mainModule.base;
    Python.$config.moduleName = Process.mainModule.name;
    for (const name of Object.keys(offsets)) {
        Python.$config.exports[name] = () => base.add(offsets[name]);
    }
    try { return { available: Python.available === true }; }
    catch (e) { return { available: false, error: String(e) }; }
} };
""" % json.dumps(offsets)

    exports, teardown = _inject(STRIPPED_HOST, agent)
    try:
        res = None
        for _ in range(300):  # up to ~30s
            try:
                res = exports.run()
                if res.get("available"):
                    break
            except Exception:
                pass
            time.sleep(0.1)
        assert res is not None and res.get("available"), (
            "$config.moduleName/$config.exports should recover discovery: %r" % (res,)
        )
    finally:
        teardown()
