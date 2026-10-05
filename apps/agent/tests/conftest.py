import os
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent.queue.message_queue import SessionLockRepository

CI_REQUIRE_REDIS_TESTS = os.environ.get("CI_REQUIRE_REDIS_TESTS") == "1"
CI_REQUIRE_PERFORMANCE_TESTS = os.environ.get("CI_REQUIRE_PERFORMANCE_TESTS") == "1"
CI_VALIDATE_TEST_PARTITIONS = os.environ.get("CI_VALIDATE_TEST_PARTITIONS") == "1"

# Set environment variables before importing any application code
os.environ["JWT_SECRET"] = "testsecret_must_be_at_least_32_bytes_long_for_security_reasons"
os.environ["NESTJS_API_URL"] = "http://localhost:3001/api"
os.environ["AGENT_SERVICE_API_KEY"] = "mock_agent_key"
os.environ["CLAIM_TOKEN_SECRET"] = "mock_claim_secret_must_be_long_enough_for_security"
os.environ["OUTPUT_GUARDRAIL_ENABLED"] = "false"
os.environ["FEATURE_FLAG_BOOKING_READINESS"] = "true"


def pytest_collection_modifyitems(items):
    """Assign each test to exactly one primary CI lane."""
    for item in items:
        if "redis_client" in item.fixturenames or "t098_redis_client" in item.fixturenames:
            item.add_marker(pytest.mark.redis_integration)
        if item.get_closest_marker("performance"):
            item.add_marker(pytest.mark.agent_performance)
        elif item.get_closest_marker("redis_integration"):
            item.add_marker(pytest.mark.agent_redis)
        else:
            item.add_marker(pytest.mark.agent_unit)


def pytest_collection_finish(session):
    """Check lane membership and required lane coverage after test collection."""
    lanes = ("agent_unit", "agent_redis", "agent_performance")
    lane_counts = {
        lane: sum(item.get_closest_marker(lane) is not None for item in session.items)
        for lane in lanes
    }
    if any(
        sum(item.get_closest_marker(lane) is not None for lane in lanes) != 1
        for item in session.items
    ):
        pytest.exit("Every test must belong to exactly one agent CI lane", returncode=1)
    if CI_VALIDATE_TEST_PARTITIONS and sum(lane_counts.values()) != len(session.items):
        pytest.exit("Agent CI lane union does not cover every collected test", returncode=1)
    if CI_REQUIRE_REDIS_TESTS and not lane_counts["agent_redis"]:
        pytest.exit(
            "CI_REQUIRE_REDIS_TESTS=1 requires at least one redis_integration test",
            returncode=1,
        )
    if CI_REQUIRE_PERFORMANCE_TESTS and not lane_counts["agent_performance"]:
        pytest.exit(
            "CI_REQUIRE_PERFORMANCE_TESTS=1 requires at least one performance test",
            returncode=1,
        )


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    """Turn an unavailable required Redis service from a skip into a failure."""
    outcome = yield
    report = outcome.get_result()
    required_redis = (CI_REQUIRE_REDIS_TESTS and item.get_closest_marker("agent_redis")) or (
        CI_REQUIRE_PERFORMANCE_TESTS
        and item.get_closest_marker("agent_performance")
        and item.get_closest_marker("redis_integration")
    )
    if (
        required_redis
        and item.get_closest_marker("redis_integration")
        and report.when in {"setup", "call"}
        and report.skipped
    ):
        report.outcome = "failed"
        report.longrepr = (
            "Redis integration test skipped while Redis-backed CI coverage is required"
        )


@pytest.fixture(autouse=True)
def setup_env(monkeypatch):
    monkeypatch.setattr(
        "agent.tools.nestjs_client.NestJSClient.check_user_access",
        AsyncMock(return_value={"allowed": True}),
    )

    import agent.infrastructure.redis

    mock_redis = MagicMock()
    mock_redis.get = AsyncMock(return_value=None)
    mock_redis.set = AsyncMock(return_value=True)
    mock_redis.eval = AsyncMock(return_value=[1, "ok"])
    mock_redis.ping = AsyncMock(return_value=True)
    mock_redis.aclose = AsyncMock()

    monkeypatch.setattr("agent.infrastructure.redis.init_redis", AsyncMock())
    monkeypatch.setattr("agent.infrastructure.redis.close_redis", AsyncMock())

    agent.infrastructure.redis._redis_client = mock_redis

    from agent.guardrails.gateway import GuardrailGateway
    from agent.main import app

    app.state.guardrail_gateway = GuardrailGateway()

    # Keep variables set, but yield for test duration
    yield
    agent.infrastructure.redis._redis_client = None


@pytest.fixture(autouse=True)
def mock_session_lock_repo(monkeypatch):
    _locks = set()

    async def mock_acquire_lock(user_id, session_id, req_id, ttl_ms=None):
        if session_id in _locks:
            return None
        _locks.add(session_id)
        return 1

    async def mock_release_lock(user_id, session_id, req_id, fence):
        _locks.discard(session_id)
        return True

    mock_repo = MagicMock(spec=SessionLockRepository)
    mock_repo.acquire_lock = mock_acquire_lock
    mock_repo.release_lock = mock_release_lock
    mock_repo.refresh_lock = AsyncMock(return_value=True)
    mock_repo.validate_fence = AsyncMock(return_value=True)
    monkeypatch.setattr(
        "agent.queue.message_queue.SessionLockRepository", lambda *args, **kwargs: mock_repo
    )
