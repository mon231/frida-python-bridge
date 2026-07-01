"""Embedded-host test: build a tiny C program that embeds CPython, inject the bridge,
and verify discovery/introspection works when the host executable is *not* ``python``.

Builds with ``python3-config --embed`` on Linux/macOS; skips on Windows or when no C
compiler / config is available (so it never breaks the cross-platform suite)."""

import os
import shutil
import subprocess
import sys
import time

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
HOST_C = os.path.join(HERE, "host", "embed.c")


def _config_flags():
    vi = sys.version_info
    candidates = [
        "python3-config",
        "python{}.{}-config".format(vi.major, vi.minor),
        os.path.basename(sys.executable) + "-config",
        os.path.join(os.path.dirname(sys.executable), "python3-config"),
    ]
    cfg = next((c for c in (shutil.which(x) or (x if os.path.exists(x) else None) for x in candidates) if c), None)
    if cfg is None:
        return None

    def run(*extra):
        try:
            return subprocess.check_output([cfg, *extra], text=True).split()
        except subprocess.CalledProcessError:
            return None

    cflags = run("--cflags", "--embed") or run("--cflags")
    ldflags = run("--ldflags", "--embed") or run("--ldflags")
    if cflags is None or ldflags is None:
        return None
    return cflags, ldflags


@pytest.fixture(scope="module")
def embed_host(tmp_path_factory):
    if sys.platform == "win32":
        pytest.skip("embedded-host test is Linux/macOS only")
    if sys.platform == "darwin":
        pytest.skip("macOS frida injection not supported in CI yet")
    cc = os.environ.get("CC") or shutil.which("cc") or shutil.which("gcc") or shutil.which("clang")
    if cc is None:
        pytest.skip("no C compiler available")
    flags = _config_flags()
    if flags is None:
        pytest.skip("python3-config not available")
    if not os.path.exists(os.path.join(ROOT, "dist", "index.js")):
        pytest.skip("dist/index.js not found - run `npm run build` first")

    cflags, ldflags = flags
    out = str(tmp_path_factory.mktemp("embed") / "embed_host")
    try:
        subprocess.check_call([cc, HOST_C, *cflags, *ldflags, "-o", out])
    except subprocess.CalledProcessError as exc:
        pytest.skip("failed to build embedded host: %s" % exc)
    return out


def test_embedded_discovery(embed_host):
    import frida

    with open(os.path.join(ROOT, "dist", "index.js"), encoding="utf-8") as f:
        bridge = f.read()
    agent_source = bridge + r"""
rpc.exports = { run() { return Python.perform(() => ({
    available: Python.available,
    impl: Python.version.implementation,
    greeters: Python.choose("app.Greeter").length,
})); } };
"""

    device = frida.get_local_device()
    env = dict(os.environ, FRIDA_FIXTURES=FIXTURES)
    pid = device.spawn([embed_host], env=env)

    script = None
    try:
        session = device.attach(pid)
        script = session.create_script(agent_source)
        script.load()
        device.resume(pid)
        exports = getattr(script, "exports_sync", None) or script.exports
        # Poll run() until the embedded interpreter is initialized.
        res = None
        for _ in range(300):  # up to ~30s
            try:
                res = exports.run()
                if res.get("available"):
                    break
            except Exception:
                pass
            time.sleep(0.1)
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

    assert res is not None, "embedded interpreter did not become available within 30s"
    assert res["available"] is True
    assert res["impl"] == "cpython"
    assert res["greeters"] >= 2
