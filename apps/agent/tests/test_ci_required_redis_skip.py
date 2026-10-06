from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from types import SimpleNamespace

import pytest

conftest_path = Path(__file__).with_name("conftest.py")
conftest_spec = spec_from_file_location("_agent_test_conftest", conftest_path)
assert conftest_spec is not None and conftest_spec.loader is not None
conftest = module_from_spec(conftest_spec)
conftest_spec.loader.exec_module(conftest)


@pytest.mark.parametrize("phase", ["setup", "call"])
@pytest.mark.parametrize(
    ("required_flag", "lane"),
    [
        ("CI_REQUIRE_REDIS_TESTS", "agent_redis"),
        ("CI_REQUIRE_PERFORMANCE_TESTS", "agent_performance"),
    ],
)
def test_required_redis_skip_fails_in_setup_and_call_phases(
    monkeypatch, phase, required_flag, lane
):
    monkeypatch.setattr(conftest, required_flag, True)
    markers = {lane, "redis_integration"}
    item = SimpleNamespace(get_closest_marker=lambda name: object() if name in markers else None)
    report = SimpleNamespace(when=phase, skipped=True, outcome="skipped", longrepr="unavailable")
    hook = conftest.pytest_runtest_makereport(item, None)

    next(hook)
    with pytest.raises(StopIteration):
        hook.send(SimpleNamespace(get_result=lambda: report))

    assert report.outcome == "failed"
    assert "Redis-backed CI coverage is required" in report.longrepr
