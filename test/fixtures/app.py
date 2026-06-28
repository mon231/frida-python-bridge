"""Test fixture exercised by the frida-python-bridge manual + CI tests.

Run as a module so the running objects live in the importable module ``app``
(``Python.import("app")`` then resolves the SAME namespace the loop uses):

    python -c "import sys; sys.path.insert(0, '<dir>'); import app; app.main()"
"""

import time

# A module-global container so instances are reachable and GC-tracked.
GLOBAL_GREETERS = []


def add(a, b):
    """Plain module function (used to test calling + hooking)."""
    return a + b


def greet(name):
    """Module function the main loop calls every tick (hook target)."""
    return "Hello, " + str(name) + "!"


class Greeter:
    """A user-defined class with instance state (choose / class-name target)."""

    population = 0

    def __init__(self, name):
        self.name = name
        Greeter.population += 1
        GLOBAL_GREETERS.append(self)

    def hello(self):
        return "Hello from " + self.name

    def shout(self, text):
        return text.upper() + "!"


class Calculator:
    def __init__(self, base=0):
        self.base = base

    def add(self, x):
        return self.base + x

    def mul(self, x, y=2):
        return x * y


# Seed a couple of instances at import time so introspection has something to find
# even immediately after attach.
SEED = [Greeter("alpha"), Greeter("beta")]


def main():
    i = 0
    while True:
        g = Greeter("world-{}".format(i))
        # Look up module globals each tick so installed hooks are observed.
        _ = greet("loop-{}".format(i))
        _ = g.hello()
        i += 1
        time.sleep(1)


if __name__ == "__main__":
    main()
