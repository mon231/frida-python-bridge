"""End-to-end tests against a live CPython interpreter.

Each ``case`` is one assertion executed *inside* the target by test/agent.js
(marshalling, eval/exec, import/use/builtins, the object protocol, finding
instances + class names via choose, and installing/reverting hooks). The suite is
injected once (see conftest.py) and fanned out into one test per assertion.

Run with: ``npm run build`` then ``pytest`` (or ``npm test``).
"""

import time


def test_case(case):
    assert case["ok"], case.get("message")


# ---------------------------------------------------------------------------
# Execution-thread tests (rpc / setTimeout / recv)
#
# All three Frida callback contexts share the same GumJS script thread, which
# starts with no Python thread state.  Python.perform / performNow calls
# PyGILState_Ensure on that thread, creating a PyThreadState and acquiring the
# GIL — the same mechanism Java.perform uses for JNI threads.  These tests
# confirm each context works explicitly rather than just relying on the implicit
# rpc coverage from the parametrised suite above.
# ---------------------------------------------------------------------------


def test_perform_from_setTimeout_thread(live_session):
    """Python.perform works when called from a Frida setTimeout callback."""
    exports, _script = live_session
    result = exports.test_set_timeout_thread()
    assert result["ok"], result.get("message")
    assert result["value"] == 42


def test_perform_from_recv_thread(live_session):
    """Python.perform works when called from a Frida recv message handler."""
    exports, script = live_session
    exports.setup_recv_thread()
    script.post({"type": "fpb_test_ping"})
    # The recv handler fires asynchronously in the GumJS event loop; poll for it.
    result = None
    for _ in range(50):
        result = exports.get_recv_thread_result()
        if result is not None:
            break
        time.sleep(0.1)
    assert result is not None, "recv handler did not fire within 5s"
    assert result["ok"], result.get("message")
    assert result["value"] == 42
