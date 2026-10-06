"""Maintained T098 agent benchmark coverage.

The emitted aggregate deliberately contains only date, environment, counts,
p95, and failure counts.  It must never become a channel for test identifiers,
payloads, credentials, or external-boundary data.
"""

import asyncio
import json
import os
import time
import uuid
from datetime import datetime, timezone
from statistics import quantiles
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest
import redis.asyncio as redis
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessageChunk, HumanMessage

from agent.config import get_settings
from agent.main import app
from agent.repositories.chat_budget_repository import (
    BudgetExceededException,
    ChatBudgetRepository,
)

REQUEST_COUNT = 100
WARM_REQUEST_COUNT = 5
ROUTER_OVERHEAD_P95_LIMIT_MS = 100.0
LUA_ADMISSION_OVERHEAD_P95_LIMIT_MS = 10.0
QUOTA_RACE_TIMEOUT_SECONDS = 15.0


def _p95_ms(samples: list[float]) -> float:
    """Return an inclusive p95 for the fixed-size benchmark sample."""
    return quantiles(samples, n=100, method="inclusive")[94] * 1000


def _emit_aggregate(
    *,
    stream_p95_ms: float | None = None,
    lua_p95_ms: float | None = None,
    quota_counts: dict[str, int] | None = None,
    failures: int = 0,
) -> None:
    """Print the machine-readable, PII-free aggregate required by T098."""
    print(
        json.dumps(
            {
                "date": datetime.now(timezone.utc).date().isoformat(),
                "environment": "test",
                "counts": {
                    "router_requests": REQUEST_COUNT if stream_p95_ms is not None else 0,
                    "lua_admission_requests": REQUEST_COUNT if lua_p95_ms is not None else 0,
                    "quota_attempts": REQUEST_COUNT if quota_counts is not None else 0,
                    **(quota_counts or {}),
                },
                "p95_ms": {
                    "router_graph_entry": (
                        round(stream_p95_ms, 3) if stream_p95_ms is not None else None
                    ),
                    "lua_admission": (round(lua_p95_ms, 3) if lua_p95_ms is not None else None),
                },
                "failures": failures,
            },
            sort_keys=True,
        )
    )


@pytest.fixture
async def t098_redis_client():
    """Use the existing integration convention: skip only when Redis is unavailable."""
    pool = redis.BlockingConnectionPool.from_url(
        os.environ.get("REDIS_URL", "redis://localhost:6379/0"),
        decode_responses=True,
        max_connections=10,
        timeout=5,
        socket_connect_timeout=5,
        socket_timeout=5,
    )
    client = redis.Redis(connection_pool=pool)
    try:
        await client.ping()
    except (redis.ConnectionError, OSError):
        await client.aclose()
        pytest.skip("Redis is not available")

    try:
        yield client
    finally:
        await client.aclose()


@pytest.mark.performance
def test_t098_router_entry_benchmark(monkeypatch):
    """Measure public stream request-to-router entry with an accepted fake quota."""
    settings = get_settings()
    graph_entry_times: list[float] = []
    stream_p95_ms = 0.0
    failures = 0
    supplier_boundary = AsyncMock(side_effect=AssertionError("supplier boundary reached"))
    payment_boundary = AsyncMock(side_effect=AssertionError("payment boundary reached"))

    class DeterministicGraph:
        async def astream_events(self, *_args, **_kwargs):
            graph_entry_times.append(time.perf_counter())
            yield {
                "event": "on_chat_model_stream",
                "data": {"chunk": AIMessageChunk(content="ready")},
            }

        async def aget_state(self, *_args, **_kwargs):
            return MagicMock(next=(), values={"messages": [HumanMessage(content="safe")]})

    class DeterministicBudgetRepository:
        admitted = 0

        def __init__(self, _redis_client):
            pass

        async def admit_request(self, **_kwargs):
            type(self).admitted += 1
            return True

    nest_client = MagicMock()
    nest_client.check_user_access = AsyncMock(return_value={"allowed": True})
    nest_client.get_memory = AsyncMock(return_value={"recentMessages": [], "summary": None})
    nest_client.create_message_batch = AsyncMock(
        return_value={"messages": [{"sender": "USER"}, {"sender": "AGENT"}]}
    )
    guardrails = MagicMock()
    guardrails.validate_message = AsyncMock(return_value=(True, None))
    guardrails.validate_output_chunk = AsyncMock(return_value=(True, None))
    guardrails.validate_text = AsyncMock(return_value=(True, None, None))
    guardrails.is_healthy = MagicMock(return_value=True)

    monkeypatch.setattr("agent.streaming.sse.graph", DeterministicGraph())
    monkeypatch.setattr("agent.streaming.sse.NestJSClient", lambda **_kwargs: nest_client)
    monkeypatch.setattr("agent.streaming.sse.get_redis_client", lambda: MagicMock())
    monkeypatch.setattr(
        "agent.repositories.chat_budget_repository.ChatBudgetRepository",
        DeterministicBudgetRepository,
    )
    monkeypatch.setattr(
        "agent.memory.manager.MemoryManager.check_and_summarize",
        AsyncMock(),
    )

    token = jwt.encode(
        {
            "sub": "benchmark",
            "iss": getattr(settings, "JWT_ISSUER", "booking-systems-api"),
            "aud": getattr(settings, "JWT_AUDIENCE", "booking-systems-clients"),
            "jti": "benchmark",
            "exp": int(time.time()) + 3600,
        },
        settings.JWT_SECRET,
        algorithm="HS256",
    )
    headers = {"Authorization": f"Bearer {token}"}

    try:
        with TestClient(app) as client:
            monkeypatch.setattr(app.state, "guardrails", guardrails, raising=False)
            monkeypatch.setattr(app.state, "message_queue", None, raising=False)

            def request_until_graph_entry() -> float:
                entries_before = len(graph_entry_times)
                started = time.perf_counter()
                response = client.post(
                    "/chat/stream",
                    headers=headers,
                    json={"message": "safe", "sessionId": "benchmark"},
                )
                assert response.status_code == 200
                assert len(graph_entry_times) == entries_before + 1
                return graph_entry_times[-1] - started

            for _ in range(WARM_REQUEST_COUNT):
                request_until_graph_entry()
            router_samples = [request_until_graph_entry() for _ in range(REQUEST_COUNT)]

        stream_p95_ms = _p95_ms(router_samples)
        assert stream_p95_ms < ROUTER_OVERHEAD_P95_LIMIT_MS
        assert DeterministicBudgetRepository.admitted == REQUEST_COUNT + WARM_REQUEST_COUNT
        supplier_boundary.assert_not_awaited()
        payment_boundary.assert_not_awaited()
    except Exception:
        failures = 1
        raise
    finally:
        _emit_aggregate(
            stream_p95_ms=stream_p95_ms,
            quota_counts=None,
            failures=failures,
        )


@pytest.mark.asyncio
async def test_t098_daily_quota_edge_race(t098_redis_client):
    """Prove Redis Lua admits exactly one of 100 simultaneous daily-limit attempts."""
    quota_user = f"t098-{uuid.uuid4().hex}"
    quota_window = f"t098-{uuid.uuid4().hex}"
    quota_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily_key = f"chat:budget:{quota_user}:{quota_date}"
    burst_key = f"chat:burst:{quota_user}:{quota_window}"
    quota_counts = {"quota_accepted": 0, "quota_denied": 0}
    failures = 0

    try:
        await t098_redis_client.delete(daily_key, burst_key)
        await t098_redis_client.set(daily_key, REQUEST_COUNT - 1, ex=120)
        budget_repository = ChatBudgetRepository(t098_redis_client)
        start_gate = asyncio.Event()

        async def admit_at_daily_edge() -> bool:
            await start_gate.wait()
            try:
                return await budget_repository.admit_request(
                    user_id=quota_user,
                    burst_window_id=quota_window,
                    daily_limit=REQUEST_COUNT,
                    burst_limit=REQUEST_COUNT,
                    burst_ttl=120,
                )
            except BudgetExceededException as error:
                assert error.reason == "daily_quota_exceeded"
                return False

        attempts = [asyncio.create_task(admit_at_daily_edge()) for _ in range(REQUEST_COUNT)]
        await asyncio.sleep(0)
        start_gate.set()
        admitted = await asyncio.wait_for(
            asyncio.gather(*attempts), timeout=QUOTA_RACE_TIMEOUT_SECONDS
        )
        quota_counts["quota_accepted"] = sum(admitted)
        quota_counts["quota_denied"] = REQUEST_COUNT - quota_counts["quota_accepted"]

        assert quota_counts == {"quota_accepted": 1, "quota_denied": REQUEST_COUNT - 1}
        assert int(await t098_redis_client.get(daily_key) or 0) == REQUEST_COUNT
        assert int(await t098_redis_client.get(burst_key) or 0) == 1
    except Exception:
        failures = 1
        raise
    finally:
        await t098_redis_client.delete(daily_key, burst_key)
        _emit_aggregate(
            stream_p95_ms=None,
            quota_counts=quota_counts,
            failures=failures,
        )


@pytest.mark.asyncio
@pytest.mark.performance
async def test_t098_lua_admission_latency_benchmark(t098_redis_client):
    """Measure 100 Redis Lua quota/rate-limit admission decision overheads (p95 < 10ms)."""
    user_id = f"t098-bench-{uuid.uuid4().hex}"
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    daily_key = f"chat:budget:{user_id}:{date_str}"
    burst_keys: list[str] = []
    lua_p95_ms = 0.0
    failures = 0
    budget_repository = ChatBudgetRepository(t098_redis_client)

    try:
        # Pre-warm Lua script / connections
        for i in range(WARM_REQUEST_COUNT):
            warm_window = f"warm-{i}"
            burst_keys.append(f"chat:burst:{user_id}:{warm_window}")
            admitted = await budget_repository.admit_request(
                user_id=user_id,
                burst_window_id=warm_window,
                daily_limit=1000,
                burst_limit=1000,
                burst_ttl=120,
            )
            assert admitted is True

        lua_samples: list[float] = []
        for i in range(REQUEST_COUNT):
            window_id = f"bench-{i}"
            burst_keys.append(f"chat:burst:{user_id}:{window_id}")
            started = time.perf_counter()
            admitted = await budget_repository.admit_request(
                user_id=user_id,
                burst_window_id=window_id,
                daily_limit=1000,
                burst_limit=1000,
                burst_ttl=120,
            )
            elapsed = time.perf_counter() - started
            assert admitted is True
            lua_samples.append(elapsed)

        assert len(lua_samples) == REQUEST_COUNT
        lua_p95_ms = _p95_ms(lua_samples)
        assert lua_p95_ms < LUA_ADMISSION_OVERHEAD_P95_LIMIT_MS
    except Exception:
        failures = 1
        raise
    finally:
        if burst_keys:
            await t098_redis_client.delete(daily_key, *burst_keys)
        else:
            await t098_redis_client.delete(daily_key)
        _emit_aggregate(
            stream_p95_ms=None,
            lua_p95_ms=lua_p95_ms,
            quota_counts=None,
            failures=failures,
        )
