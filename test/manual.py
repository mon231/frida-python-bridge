#!/usr/bin/env python3
"""Manual test: spawn a CPython host, inject the bridge agent, verify that
finding instances / class-names / hooking all work against a live interpreter."""

import os
import sys
import json
import time

import frida

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIXTURES = os.path.join(HERE, "fixtures")


def build_agent():
    with open(os.path.join(ROOT, "dist", "index.js"), encoding="utf-8") as f:
        bridge = f.read()
    with open(os.path.join(HERE, "manual_agent.js"), encoding="utf-8") as f:
        driver = f.read()
    return bridge + "\n" + driver


def main():
    code = "import sys; sys.path.insert(0, r'{}'); import app; app.main()".format(FIXTURES)

    device = frida.get_local_device()
    pid = device.spawn([sys.executable, "-c", code])
    session = device.attach(pid)
    script = session.create_script(build_agent())

    messages = []

    def on_message(message, data):
        if message["type"] == "send":
            print("[send]", message["payload"])
            messages.append(message["payload"])
        elif message["type"] == "error":
            print("[error]", message.get("stack") or message.get("description"))

    script.on("message", on_message)
    script.load()
    device.resume(pid)

    # Let the interpreter initialize and the app loop create instances.
    time.sleep(2.5)

    exports = getattr(script, "exports_sync", None) or script.exports
    result = exports.run()

    print("=== run() result ===")
    print(json.dumps(result, indent=2, default=str))

    print("=== observing hooks for 4s ===")
    time.sleep(4)

    script.unload()
    device.kill(pid)

    hook_targets = {m.get("target") for m in messages if isinstance(m, dict)}
    checks = {
        "available": result.get("available") is True,
        "sum==45": result.get("sum") == 45,
        "add==5": result.get("add") == 5,
        "found >=2 greeters": result.get("greeterCount", 0) >= 2,
        "class name Greeter": "Greeter" in (result.get("classNames") or []),
        "use()+method hello": result.get("helloNew") == "Hello from frida",
        "use()+method shout": result.get("shout") == "HI!",
        "greet hook fired": "greet" in hook_targets,
        "hello hook fired": "Greeter.hello" in hook_targets,
    }

    print("=== checks ===")
    for name, passed in checks.items():
        print(("  PASS " if passed else "  FAIL ") + name)

    ok = all(checks.values())
    print("RESULT:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
