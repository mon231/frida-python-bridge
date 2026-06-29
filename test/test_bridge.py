"""End-to-end tests against a live CPython interpreter.

Each ``case`` is one assertion executed *inside* the target by test/agent.js
(marshalling, eval/exec, import/use/builtins, the object protocol, finding
instances + class names via choose, and installing/reverting hooks). The suite is
injected once (see conftest.py) and fanned out into one test per assertion.

Run with: ``npm run build`` then ``pytest`` (or ``npm test``).
"""


def test_case(case):
    assert case["ok"], case.get("message")
