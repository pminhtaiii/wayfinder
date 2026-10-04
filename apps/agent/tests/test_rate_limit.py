import os
import time
from unittest.mock import AsyncMock, MagicMock

import httpx
import jwt
import pytest
import redis.asyncio as redis
from fastapi import FastAPI

from agent.config import get_settings
from agent.middleware.auth import JWTAuthMiddleware
from agent.middleware.rate_limit import RateLimitMiddleware

settings = get_settings()
SECRET = settings.JWT_SECRET
ISSUER = getattr(settings, "JWT_ISSUER", "booking-systems-api")
AUDIENCE = getattr(settings, "JWT_AUDIENCE", "booking-systems-clients")


def make_token(user_id="user-rate-1"):
    payload = {
        "id": user_id,
        "sub": user_id,
        "jti": f"jti-{user_id}",
        "iss": ISSUER,
        "aud": AUDIENCE,
        "exp": int(time.time()) + 3600,
    }
    return jwt.encode(payload, SECRET, algorithm="HS256")


@pytest.fixture
async def real_redis():
    redis_url = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
    client = redis.Redis.from_url(redis_url, decode_responses=True)
    try:
        await client.ping()
        yield client
    except (redis.ConnectionError, OSError):
        pytest.skip("Redis is not available")
    finally:
        await client.aclose()


# ---------------------------------------------------------------------------
# T026: Two-instance burst limit test
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_two_instance_burst_limit_shared(real_redis):
    user_id = f"user_burst_{int(time.time())}"
    token = make_token(user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # Instance 1 with limit=5, window=60
    app1 = FastAPI()
    app1.add_middleware(RateLimitMiddleware, limit=5, window=60, redis_client=real_redis)
    app1.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app1.get("/test")
    async def endpoint1():
        return {"instance": 1}

    # Instance 2 sharing the same Redis client & limits
    app2 = FastAPI()
    app2.add_middleware(RateLimitMiddleware, limit=5, window=60, redis_client=real_redis)
    app2.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app2.get("/test")
    async def endpoint2():
        return {"instance": 2}

    async with (
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app1), base_url="http://test"
        ) as client1,
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app2), base_url="http://test"
        ) as client2,
    ):
        # 3 requests to Instance 1 -> HTTP 200
        for _ in range(3):
            res = await client1.get("/test", headers=headers)
            assert res.status_code == 200

        # 2 requests to Instance 2 -> HTTP 200 (Total = 5, burst limit reached)
        for _ in range(2):
            res = await client2.get("/test", headers=headers)
            assert res.status_code == 200

        # 6th request to Instance 1 -> Must fail with 429 and CHAT_BURST_LIMIT_EXCEEDED
        res_rejected1 = await client1.get("/test", headers=headers)
        assert res_rejected1.status_code == 429
        body1 = res_rejected1.json()
        assert body1.get("code") == "CHAT_BURST_LIMIT_EXCEEDED"

        # 7th request to Instance 2 -> Must also fail with 429 and CHAT_BURST_LIMIT_EXCEEDED
        res_rejected2 = await client2.get("/test", headers=headers)
        assert res_rejected2.status_code == 429
        body2 = res_rejected2.json()
        assert body2.get("code") == "CHAT_BURST_LIMIT_EXCEEDED"


# ---------------------------------------------------------------------------
# T026: Two-instance daily limit test
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_two_instance_daily_limit_shared(real_redis):
    user_id = f"user_daily_{int(time.time())}"
    token = make_token(user_id)
    headers = {"Authorization": f"Bearer {token}"}

    # App 1 with daily_limit=5, burst_limit=10
    app1 = FastAPI()
    app1.add_middleware(
        RateLimitMiddleware, limit=10, daily_limit=5, window=60, redis_client=real_redis
    )
    app1.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app1.get("/test")
    async def endpoint1():
        return {"ok": True}

    # App 2 sharing same Redis
    app2 = FastAPI()
    app2.add_middleware(
        RateLimitMiddleware, limit=10, daily_limit=5, window=60, redis_client=real_redis
    )
    app2.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app2.get("/test")
    async def endpoint2():
        return {"ok": True}

    async with (
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app1), base_url="http://test") as c1,
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app2), base_url="http://test") as c2,
    ):
        # Alternate 5 accepted requests across instances
        assert (await c1.get("/test", headers=headers)).status_code == 200
        assert (await c2.get("/test", headers=headers)).status_code == 200
        assert (await c1.get("/test", headers=headers)).status_code == 200
        assert (await c2.get("/test", headers=headers)).status_code == 200
        assert (await c1.get("/test", headers=headers)).status_code == 200  # 5th request

        # 6th request to App 1 -> 429 CHAT_DAILY_QUOTA_EXCEEDED
        res6_1 = await c1.get("/test", headers=headers)
        assert res6_1.status_code == 429
        assert res6_1.json().get("code") == "CHAT_DAILY_QUOTA_EXCEEDED"

        # 7th request to App 2 -> 429 CHAT_DAILY_QUOTA_EXCEEDED
        res7_2 = await c2.get("/test", headers=headers)
        assert res7_2.status_code == 429
        assert res7_2.json().get("code") == "CHAT_DAILY_QUOTA_EXCEEDED"


# ---------------------------------------------------------------------------
# T026: Accepted-only non-charging test
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_accepted_only_non_charging(real_redis, monkeypatch: pytest.MonkeyPatch):
    user_id = f"user_noncharge_{int(time.time())}"
    token = make_token(user_id)
    headers = {"Authorization": f"Bearer {token}"}
    fixed_now = time.time()
    # User approved on 2026-10-03: pin this fixed-window test to one burst bucket.
    monkeypatch.setattr("agent.middleware.rate_limit.time.time", lambda: fixed_now)

    app = FastAPI()
    app.add_middleware(
        RateLimitMiddleware, limit=3, daily_limit=5, window=60, redis_client=real_redis
    )
    app.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app.get("/test")
    async def endpoint():
        return {"ok": True}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        # 3 accepted requests
        for _ in range(3):
            res = await c.get("/test", headers=headers)
            assert res.status_code == 200

        # 10 rejected requests (burst limit reached)
        for _ in range(10):
            res = await c.get("/test", headers=headers)
            assert res.status_code == 429

        # Verify Redis counter for daily/burst is still exactly 3, not 13
        now_date = time.strftime("%Y-%m-%d", time.gmtime())
        daily_key = f"chat:budget:{user_id}:{now_date}"
        daily_val = int(await real_redis.get(daily_key) or 0)
        assert daily_val == 3


# ---------------------------------------------------------------------------
# T026: Redis fail-closed (503 CHAT_CONTROL_PLANE_UNAVAILABLE)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_redis_unavailable_fail_closed():
    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=redis.RedisError("Connection lost"))

    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, limit=5, window=60, redis_client=mock_redis)
    app.add_middleware(JWTAuthMiddleware, secret=SECRET)

    @app.get("/test")
    async def endpoint():
        return {"ok": True}

    token = make_token("user-fail-1")
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        res = await c.get("/test", headers={"Authorization": f"Bearer {token}"})
        assert res.status_code == 503
        body = res.json()
        assert body.get("code") == "CHAT_CONTROL_PLANE_UNAVAILABLE"


# ---------------------------------------------------------------------------
# T026: Excluded paths and preflight (OPTIONS & /health)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_options_and_health_bypass_rate_limit():
    mock_redis = MagicMock()
    mock_redis.eval = AsyncMock(side_effect=redis.RedisError("Should not be called"))

    app = FastAPI()
    app.add_middleware(RateLimitMiddleware, limit=5, window=60, redis_client=mock_redis)

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.options("/health")
    async def health_options():
        return {"status": "ok"}

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        # /health should bypass rate limit without touching Redis
        res = await c.get("/health")
        assert res.status_code == 200

        # OPTIONS request should bypass rate limit
        res_opt = await c.options("/health")
        assert res_opt.status_code == 200
