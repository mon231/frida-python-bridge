"""Exercise the cli/main.py CLI against a spawned CPython host."""

import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")
CLI = os.path.join(ROOT, "cli", "main.py")


def _run(*cli_args):
    if not os.path.exists(os.path.join(ROOT, "dist", "index.js")):
        pytest.skip("dist/index.js not found - run `npm run build` first")

    # Spawn the fixture; FIXTURES is on PYTHONPATH so `import app` works in the child.
    env = dict(os.environ, PYTHONPATH=FIXTURES + os.pathsep + os.environ.get("PYTHONPATH", ""))
    cmd = [
        sys.executable, CLI,
        "-f", sys.executable, "--arg=-c", "--arg=import app; app.main()",
        *cli_args,
    ]
    return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=60)


def test_cli_info():
    r = _run("info")
    assert r.returncode == 0, r.stderr
    assert "CPython" in r.stdout
    assert "cpython" in r.stdout


def test_cli_dump():
    r = _run("dump", "app.Greeter")
    assert r.returncode == 0, r.stderr
    assert "instance(s) of app.Greeter" in r.stdout
    # The fixture seeds >= 2 Greeter instances.
    count = int(r.stdout.split()[0])
    assert count >= 2


def test_cli_eval():
    r = _run("eval", "1 + 2")
    assert r.returncode == 0, r.stderr
    assert r.stdout.strip() == "3"
