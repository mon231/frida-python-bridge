/*
 * Minimal host that embeds CPython into a non-"python" executable. Used by
 * test/test_embedded.py to verify the bridge discovers libpython by symbol even when
 * the main module is not the interpreter binary.
 *
 * Build (Linux/macOS): cc embed.c $(python3-config --cflags --embed --ldflags) -o embed_host
 * Run:  FRIDA_FIXTURES=/path/to/test/fixtures ./embed_host
 */
#include <Python.h>

int main(void) {
    Py_Initialize();

    /* Run the fixture's main loop on a daemon thread so this host keeps the interpreter
     * alive while the loop releases the GIL via time.sleep (lets Frida acquire it). */
    PyRun_SimpleString(
        "import os, sys, threading\n"
        "sys.path.insert(0, os.environ.get('FRIDA_FIXTURES', ''))\n"
        "import app\n"
        "threading.Thread(target=app.main, daemon=True).start()\n"
    );

    /* Keep the interpreter alive; sleeping in Python releases the GIL each second. */
    PyRun_SimpleString("import time\nwhile True:\n    time.sleep(1)\n");
    return 0;
}
