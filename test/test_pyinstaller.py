"""Integration test: build a PyInstaller bundle and verify the bridge can inject into it.

Tests the "PyInstaller / py2exe binaries" scenario from PLAN.md — the host executable is
a PyInstaller ``--onefile`` bundle rather than a plain ``python.exe``.  The bridge must
discover the embedded CPython runtime (``python*.dll`` / ``libpythonX.Y.so``) that
PyInstaller loads into the process.

PyInstaller's ``--onefile`` mode on Windows and macOS spawns a *child* process that runs
the actual Python code (the parent is just a bootloader that extracts and re-launches).
On Linux, the parent process runs Python directly.  We track the child on platforms that
need it and attach Frida to the correct process.

Skips automatically when:
- ``PyInstaller`` is not installed (``pip install pyinstaller``)
- The platform is macOS (Frida injection not supported in CI yet)
- ``dist/index.js`` has not been built (``npm run build``)
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

# Minimal script to bundle: stays alive long enough for injection + assertions.
_BUNDLE_SCRIPT = """\
import time
while True:
    time.sleep(0.5)
"""

# Appended to dist/index.js to form the agent source for this test.
_AGENT_SUFFIX = r"""
rpc.exports = {
    ready() { try { return Python.available === true; } catch (e) { return false; } },
    diag()  {
        const d = {};
        try { d.initialized = Python.initialized; } catch (e) { d.initErr = String(e); }
        try { d.available  = Python.available;   } catch (e) { d.availErr = String(e); }
        try { d.version    = Python.version.toString(); } catch (e) { d.verErr = String(e); }
        try { d.module     = Python.module && Python.module.name; } catch (e) { d.moduleErr = String(e); }
        return d;
    },
    run()   {
        return Python.perform(() => ({
            available: Python.available,
            impl:      Python.version.implementation,
            version:   Python.version.toString(),
            evalOk:    Python.eval("1 + 2", { toJS: true }) === 3,
        }));
    },
};
"""


def _cleanup_frida_tmp():
    """Remove Frida temp files left in %LOCALAPPDATA%\\tmp (Windows) or /tmp (others)."""
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


def _find_python_pid(parent_proc, exe_name, timeout=30.0):
    """Return the PID of the process that actually runs Python inside the bundle.

    PyInstaller ``--onefile`` re-execs itself from the extracted temp directory on all
    platforms (Windows: CreateProcess; Linux/macOS: fork-exec).  The original parent process
    is only the bootloader; the re-exec'd child runs Python.  We use psutil to locate that
    child.  If no child appears within ``child_grace`` seconds and the parent is still alive,
    we assume this platform keeps a single process (some distro+version combos do).  Falls
    back to the parent PID when psutil is unavailable.
    """
    try:
        import psutil
    except ImportError:
        return parent_proc.pid

    parent_pid = parent_proc.pid
    start = time.monotonic()
    child_grace = 10.0  # seconds to wait before assuming no child will appear
    deadline = start + timeout

    while time.monotonic() < deadline:
        try:
            parent = psutil.Process(parent_pid)
            # Check for a child / grandchild with the same bundle name (re-exec'd from temp).
            for c in parent.children(recursive=True):
                try:
                    if os.path.basename(c.exe()).lower() == exe_name.lower():
                        return c.pid
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            # Parent still alive but no child found yet.
            # After child_grace seconds assume this platform doesn't spawn a child.
            if time.monotonic() - start >= child_grace:
                return parent_pid
        except psutil.NoSuchProcess:
            # Parent exited: scan the whole process table for the re-exec'd binary.
            for p in psutil.process_iter(["pid", "exe"]):
                try:
                    if (
                        os.path.basename(p.info["exe"] or "").lower() == exe_name.lower()
                        and p.pid != parent_pid
                    ):
                        return p.pid
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            break  # parent gone, nothing found
        time.sleep(0.2)

    return parent_pid  # best-effort fallback


@pytest.fixture(scope="module")
def pyinstaller_exe(tmp_path_factory):
    """Build a PyInstaller ``--onefile`` bundle; yield the path to the executable."""
    if sys.platform == "darwin":
        pytest.skip("macOS frida injection not supported yet")

    try:
        import PyInstaller  # noqa: F401
    except ImportError:
        pytest.skip("PyInstaller not installed (pip install pyinstaller)")

    dist_js = os.path.join(ROOT, "dist", "index.js")
    if not os.path.exists(dist_js):
        pytest.skip("dist/index.js not found — run `npm run build` first")

    tmp = tmp_path_factory.mktemp("pyinstaller")
    script_path = tmp / "fpb_bundle_target.py"
    script_path.write_text(_BUNDLE_SCRIPT)

    dist_dir = str(tmp / "dist")
    build_dir = str(tmp / "build")

    try:
        subprocess.check_call(
            [
                sys.executable, "-m", "PyInstaller",
                "--onefile",
                "--distpath", dist_dir,
                "--workpath", build_dir,
                "--specpath", str(tmp),
                "--log-level", "WARN",
                str(script_path),
            ],
            timeout=300,
        )
    except subprocess.CalledProcessError as exc:
        pytest.skip("PyInstaller build failed: %s" % exc)
    except subprocess.TimeoutExpired:
        pytest.skip("PyInstaller build timed out after 300 s")

    exe_name = "fpb_bundle_target.exe" if sys.platform == "win32" else "fpb_bundle_target"
    exe = os.path.join(dist_dir, exe_name)
    if not os.path.exists(exe):
        pytest.skip("PyInstaller output not found at %s" % exe)

    return exe


@pytest.mark.xfail(
    sys.platform == "linux",
    reason="Frida injection into PyInstaller bundles can crash (glibc/stack conflict) on Linux; tracked for future fix",
    strict=False,
)
def test_pyinstaller_discovery(pyinstaller_exe):
    """Bridge discovers and drives the CPython runtime embedded in a PyInstaller bundle.

    On Windows/macOS, PyInstaller --onefile spawns a child process for Python; we locate
    and attach to that child.  On Linux we attach to the parent (which runs Python directly).
    """
    import frida

    exe_name = os.path.basename(pyinstaller_exe)

    with open(os.path.join(ROOT, "dist", "index.js"), encoding="utf-8") as fh:
        bridge = fh.read()
    agent_source = bridge + "\n" + _AGENT_SUFFIX

    # Launch the bundle as a normal process (no Frida spawn-gating).
    parent_proc = subprocess.Popen([pyinstaller_exe])

    script = None
    res = None
    attach_pid = None
    try:
        # On Windows PyInstaller --onefile creates a child process for the Python runtime.
        # Poll psutil for the child; on Linux the parent IS the Python process.
        attach_pid = _find_python_pid(parent_proc, exe_name, timeout=60.0)

        device = frida.get_local_device()
        session = device.attach(attach_pid)
        script = session.create_script(agent_source)
        script.load()

        exports = getattr(script, "exports_sync", None) or script.exports

        # Poll up to 60 s for the Python runtime to be available (extraction + Py_Initialize).
        ready = False
        for _ in range(600):
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
            except Exception as exc:
                diag = {"diagError": str(exc)}
            pytest.fail(
                "PyInstaller bundle (pid=%s): CPython not available within 60 s; diag=%r"
                % (attach_pid, diag)
            )

        res = exports.run()
    finally:
        try:
            if script is not None:
                script.unload()
        except Exception:
            pass
        try:
            parent_proc.kill()
        except Exception:
            pass
        try:
            parent_proc.wait(timeout=5)
        except Exception:
            pass
        _cleanup_frida_tmp()

    assert res is not None
    assert res["available"] is True, "Python.available was not True inside the bundle"
    assert res["impl"] == "cpython", "unexpected implementation: %s" % res.get("impl")
    assert res["evalOk"] is True, "eval('1 + 2') did not return 3 inside the bundle"
