#!/usr/bin/env python3
"""Print ``{symbol: module-relative offset}`` for a fixed set of CPython C-API symbols in
an ELF binary, as JSON on stdout.

The offset is computed as ``(symbol vaddr) - (first PT_LOAD segment's vaddr)`` - the same
"module base + offset" addressing Frida uses for ``Module.base``, so it's correct whether
the binary is PIE or not. Run this *before* stripping (so the symbol names still exist);
the static/stripped-host test then reconstructs each address at runtime as
``Process.mainModule.base.add(offset)`` via ``Python.$config.exports``, after the binary
has been stripped of those very names.

Usage: dump_offsets.py <path-to-binary>
"""
import json
import re
import subprocess
import sys

# The minimum set Python.available (isLive()) touches: Py_GetVersion (module discovery
# sentinel + version string), Py_IsInitialized, Py_IsFinalizing.
SYMBOLS = ["Py_GetVersion", "Py_IsInitialized", "Py_IsFinalizing"]


def _first_load_vaddr(binary):
    out = subprocess.check_output(["readelf", "-lW", binary], text=True)
    for line in out.splitlines():
        parts = line.split()
        if parts and parts[0] == "LOAD":
            return int(parts[2], 16)  # VirtAddr column
    raise RuntimeError("no LOAD segment found in %s" % binary)


def _symbol_addrs(binary):
    out = subprocess.check_output(["nm", "-n", binary], text=True)
    addrs = {}
    for line in out.splitlines():
        m = re.match(r"^([0-9a-fA-F]+)\s+\S+\s+(\S+)$", line)
        if m and m.group(2) in SYMBOLS:
            addrs[m.group(2)] = int(m.group(1), 16)
    return addrs


def main():
    binary = sys.argv[1]
    base = _first_load_vaddr(binary)
    addrs = _symbol_addrs(binary)
    missing = [s for s in SYMBOLS if s not in addrs]
    if missing:
        raise SystemExit("missing symbols (unresolved in %s): %s" % (binary, missing))
    print(json.dumps({name: addr - base for name, addr in addrs.items()}))


if __name__ == "__main__":
    main()
