#!/usr/bin/env python3
"""frida-python-bridge CLI.

A thin wrapper around Frida that injects the bridge and drives a live CPython
interpreter from the command line.

  frida-python-bridge -n python.exe info
  frida-python-bridge -p 1234 eval "sys.version"
  frida-python-bridge -n python dump collections.OrderedDict

  # spawn a target: -f PROGRAM, with each child arg as a separate --arg (no shell quoting).
  # On Windows especially, prefer --arg over packing args into the -f string.
  frida-python-bridge -f python --arg=-c --arg="import time;\nwhile 1: time.sleep(1)" repl

Requires the `frida` Python package (pip install frida).
"""

import argparse
import os
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Bridge agent + a small rpc driver appended below it.
DRIVER = r"""
function safeJS(o) {
    try {
        const v = o.$toJS();
        if (v !== null && typeof v === "object" && v.__pyobject) return undefined;
        return v;
    } catch (e) {
        return undefined;
    }
}
rpc.exports = {
    info() {
        return Python.perform(() => ({
            version: Python.version.toString(),
            implementation: Python.version.implementation,
            available: Python.available,
            interpreters: Python.interpreters().length,
        }));
    },
    evalExpr(expr) {
        return Python.perform(() => {
            const o = Python.eval(expr);
            return { repr: o.$repr(), js: safeJS(o) };
        });
    },
    execCode(code) {
        return Python.perform(() => {
            Python.exec(code);
            return true;
        });
    },
    dump(type, limit) {
        return Python.perform(() => {
            const xs = Python.choose(type);
            return { count: xs.length, samples: xs.slice(0, limit).map(x => x.$repr()) };
        });
    },
};
"""


def build_agent():
    dist = os.path.join(ROOT, "dist", "index.js")
    if not os.path.exists(dist):
        sys.exit("dist/index.js not found - build the package first (npm run build).")
    with open(dist, encoding="utf-8") as f:
        return f.read() + "\n" + DRIVER


def attach(args):
    import frida

    device = frida.get_local_device()
    spawned_pid = None
    spawned_proc = None
    frida_spawned = False
    if args.spawn:
        # Prefer explicit --arg tokens (no shell quoting); else shlex-split the program string.
        if args.arg:
            argv = [args.spawn, *args.arg]
        else:
            argv = shlex.split(args.spawn, posix=(os.name != "nt"))
        if sys.platform == "darwin":
            # frida's spawn-then-attach-while-suspended path has public crash reports during
            # the target's own dyld/CoreFoundation bootstrap on recent macOS (frida/frida-core
            # #519, #524). Launch normally and attach once it's already running instead of
            # spawn-gating + resume. Keep the Popen handle: device.kill() on a pid frida
            # never spawned itself doesn't reliably return on macOS, so teardown needs to
            # go through the process handle instead (see main()'s finally block).
            spawned_proc = subprocess.Popen(argv, env=dict(os.environ))
            time.sleep(0.3)  # let dyld finish its own bootstrap before frida attaches
            spawned_pid = spawned_proc.pid
        else:
            spawned_pid = device.spawn(argv, env=dict(os.environ))
            frida_spawned = True
        session = device.attach(spawned_pid)
    elif args.pid is not None:
        session = device.attach(args.pid)
    elif args.name is not None:
        session = device.attach(args.name)
    else:
        sys.exit("specify a target: -n NAME, -p PID, or -f 'PROGRAM ARGS'")

    script = session.create_script(build_agent())
    script.on("message", (lambda m, d: sys.stderr.write("[agent] %s\n" % (m.get("stack") or m.get("description")))
              if m["type"] == "error" else None))
    script.load()
    if frida_spawned:
        device.resume(spawned_pid)

    exports = getattr(script, "exports_sync", None) or script.exports

    # Wait until the interpreter is initialized (esp. for freshly spawned hosts).
    for _ in range(50):
        try:
            if exports.info()["available"]:
                break
        except Exception:
            pass
        time.sleep(0.1)

    return device, spawned_pid, spawned_proc, script, exports


def cmd_info(exports, args):
    info = exports.info()
    print("CPython {} ({}), available={}, interpreters={}".format(
        info["version"], info["implementation"], info["available"], info["interpreters"]))


def cmd_eval(exports, args):
    r = exports.eval_expr(args.expr)
    print(r["repr"])


def cmd_exec(exports, args):
    exports.exec_code(args.code)


def cmd_dump(exports, args):
    r = exports.dump(args.type, args.limit)
    print("{} instance(s) of {}".format(r["count"], args.type))
    for s in r["samples"]:
        print("  " + s)


def cmd_repl(exports, args):
    print("frida-python-bridge REPL - type Python expressions, or :exec <stmt>, Ctrl-D to exit")
    while True:
        try:
            line = input(">>> ")
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not line.strip():
            continue
        try:
            if line.startswith(":exec "):
                exports.exec_code(line[len(":exec "):])
            else:
                print(exports.eval_expr(line)["repr"])
        except Exception as e:
            print("error:", e)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="frida-python-bridge", description=__doc__)
    parser.add_argument("-n", "--name", help="attach by process name")
    parser.add_argument("-p", "--pid", type=int, help="attach by pid")
    parser.add_argument("-f", "--spawn", help="spawn PROGRAM (a path, or a quoted 'PROGRAM ARGS' string)")
    parser.add_argument("--arg", action="append", help="a spawn argument (repeatable; avoids shell quoting)")

    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("info", help="show interpreter version / availability")
    p_eval = sub.add_parser("eval", help="evaluate an expression")
    p_eval.add_argument("expr")
    p_exec = sub.add_parser("exec", help="execute statements")
    p_exec.add_argument("code")
    p_dump = sub.add_parser("dump", help="list live instances of a type (choose)")
    p_dump.add_argument("type")
    p_dump.add_argument("--limit", type=int, default=10)
    sub.add_parser("repl", help="interactive REPL")

    args = parser.parse_args(argv)

    device, spawned_pid, spawned_proc, script, exports = attach(args)
    try:
        {
            "info": cmd_info,
            "eval": cmd_eval,
            "exec": cmd_exec,
            "dump": cmd_dump,
            "repl": cmd_repl,
        }[args.command](exports, args)
    finally:
        if spawned_proc is not None:
            # We own this process and are about to hard-kill it regardless, so there's
            # no benefit to unloading the script first - and on macOS, script.unload()
            # has been observed to hang here for minutes (frida's teardown handshake
            # with the target, rather than anything actually still running).
            try:
                spawned_proc.kill()
            except Exception:
                pass
            try:
                spawned_proc.wait(timeout=5)
            except Exception:
                pass
        else:
            try:
                script.unload()
            except Exception:
                pass
            if spawned_pid is not None:
                try:
                    device.kill(spawned_pid)
                except Exception:
                    pass


if __name__ == "__main__":
    main()
