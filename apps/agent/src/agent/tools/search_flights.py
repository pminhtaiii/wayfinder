import inspect
import logging
from datetime import datetime, timezone
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool

from agent.guardrails.schemas.tools import (
    SearchFlightsToolInput,
    SearchFlightsToolResult,
    SearchFlightsUpstreamProjection,
    project_upstream,
)
from agent.infrastructure.redis import get_redis_client
from agent.tools.base import get_nestjs_client
from agent.tools.flight_match_projection import project_flight_search_for_narration
from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshotLifecycle,
    TrustedSnapshotRepository,
)

logger = logging.getLogger(__name__)


def _narration(value: str) -> str:
    return SearchFlightsToolResult(narration=value).narration


def _get_snapshot_lifecycle() -> TrustedSearchSnapshotLifecycle:
    redis_client = get_redis_client()
    repo = TrustedSnapshotRepository(redis_client)
    return TrustedSearchSnapshotLifecycle(repo)


def _to_utc_datetime(val: Any) -> datetime:
    if isinstance(val, datetime):
        if val.tzinfo is None:
            return val.replace(tzinfo=timezone.utc)
        return val.astimezone(timezone.utc)
    if not val or not isinstance(val, str):
        raise ValueError(f"Invalid datetime value: {val}")
    dt = datetime.fromisoformat(val.strip().replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


@tool("search_flights", args_schema=SearchFlightsToolInput)
async def search_flights(
    origin: str, destination: str, date: str, passengers: int = 1, config: RunnableConfig = None
) -> str:
    """Search for available flights between two airports on a specific date. Returns the top 5 matching flights with airline, times, price, and baggage information. Use this when the user asks to find, search, or look up flights."""
    try:
        client = get_nestjs_client(config)
    except Exception:
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    configurable = (
        config.get("configurable", {})
        if isinstance(config, dict)
        else getattr(config, "configurable", {})
        if config
        else {}
    )
    thread_id = configurable.get("thread_id") or "default_thread"
    user_id = configurable.get("user_id") or "default_user"

    owner = SnapshotOwner(user_id=user_id, chat_session_id=thread_id)
    snapshot_staging = configurable.get("_snapshot_staging")
    snapshot_stage_key = configurable.get("_snapshot_stage_key")
    defer_snapshot_persistence = isinstance(snapshot_staging, dict) and isinstance(
        snapshot_stage_key, str
    )
    try:
        lifecycle = _get_snapshot_lifecycle()
    except Exception as e:
        logger.error("Could not initialize snapshot lifecycle: %s", str(e))
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    proposed_version = 1
    if defer_snapshot_persistence:
        existing_snapshot = configurable.get("trusted_snapshot")
        if isinstance(existing_snapshot, dict):
            existing_version = existing_snapshot.get("snapshotVersion") or existing_snapshot.get(
                "version"
            )
            if (
                isinstance(existing_version, int)
                and not isinstance(existing_version, bool)
                and existing_version > 0
            ):
                proposed_version = existing_version + 1
    else:
        try:
            res = lifecycle.next_version(owner)
            allocated = await res if inspect.isawaitable(res) else res
            if isinstance(allocated, int) and not isinstance(allocated, bool) and allocated > 0:
                proposed_version = allocated
        except Exception as e:
            logger.warning("Could not allocate snapshot version: %s", str(e))
            proposed_version = 1

    try:
        search_call = getattr(client, "post_gateway_flights_search_v2", None) or getattr(
            client, "search_flights_v2", None
        )
        if not search_call:
            return _narration(
                "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
            )

        call_res = search_call(
            chat_session_id=thread_id,
            proposed_snapshot_version=proposed_version,
            origin=origin,
            destination=destination,
            date=date,
            passengers=passengers,
        )
        data = await call_res if inspect.isawaitable(call_res) else call_res
    except Exception as e:
        logger.warning("Error calling flight search v2: %s", str(e))
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    if not isinstance(data, dict):
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    if "error" in data:
        error = data["error"]
        if isinstance(error, str) and error == (
            "I can currently only search economy class for adult passengers. For other cabin classes "
            "or passenger types, please use the search page."
        ):
            return _narration(error)
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    raw_results = data.get("results", [])
    if not raw_results or not isinstance(raw_results, list):
        return _narration(f"Found 0 flights from {origin} to {destination} on {date}.")

    try:
        data = project_upstream(SearchFlightsUpstreamProjection, data).model_dump(exclude_none=True)
    except Exception:
        return _narration(
            "I couldn't search for flights right now. The flight search service is temporarily unavailable. Please try again in a moment."
        )

    results = data.get("results", [])

    try:
        snapshot_results = []
        for idx, flight in enumerate(results[:5], 1):
            flight_offer_id = flight.get("flightOfferId")
            supplier_offer_id = flight.get("duffelOfferId")
            if (
                not flight_offer_id
                or not isinstance(supplier_offer_id, str)
                or not supplier_offer_id.strip()
            ):
                logger.error("Flight result missing required offer ID")
                return _narration(
                    "I encountered an error preparing your search results. Please try again."
                )

            dep_time_val = flight.get("departureTime") or flight.get("departureAt")
            arr_time_val = flight.get("arrivalTime") or flight.get("arrivalAt")
            if not dep_time_val or not arr_time_val:
                logger.error("Flight result missing departure or arrival time")
                return _narration(
                    "I encountered an error preparing your search results. Please try again."
                )

            snapshot_results.append(
                TrustedSearchResult(
                    offerIndex=idx,
                    flightOfferId=str(flight_offer_id),
                    supplierOfferId=str(supplier_offer_id),
                    airline=str(flight.get("airline") or ""),
                    origin=str(flight.get("departureAirport") or flight.get("origin") or origin),
                    destination=str(
                        flight.get("arrivalAirport") or flight.get("destination") or destination
                    ),
                    departureAt=_to_utc_datetime(dep_time_val),
                    arrivalAt=_to_utc_datetime(arr_time_val),
                    price=str(flight.get("price", "0.0")),
                    currency=str(flight.get("currency", "USD")),
                )
            )

        now_dt = datetime.now(timezone.utc)
        expires_at_raw = data.get("snapshotExpiresAt") or data.get("expiresAt")
        if not expires_at_raw:
            logger.error("Gateway flight search response missing snapshot expiry")
            return _narration(
                "I encountered an error preparing your search results. Please try again."
            )

        exp_dt = _to_utc_datetime(expires_at_raw)
        if exp_dt <= now_dt:
            logger.error(
                "Gateway flight search response has expired snapshot: %s <= %s", exp_dt, now_dt
            )
            return _narration("The flight search results have expired. Please search again.")

        selection_attestation = data.get("selectionAttestation") or data.get("attestation")
        if (
            not selection_attestation
            or not isinstance(selection_attestation, str)
            or not selection_attestation.strip()
        ):
            logger.error("Gateway flight search response missing selectionAttestation")
            return _narration(
                "I encountered an error preparing your search results. Please try again."
            )

        fingerprint = data.get("fingerprint")
        if not fingerprint or not isinstance(fingerprint, str) or not fingerprint.strip():
            fingerprint = selection_attestation

        snapshot_version = data.get("snapshotVersion") or proposed_version
        if (
            isinstance(snapshot_version, bool)
            or not isinstance(snapshot_version, int)
            or snapshot_version < 1
        ):
            logger.error(
                "Gateway flight search response invalid snapshotVersion: %s", snapshot_version
            )
            return _narration(
                "I encountered an error preparing your search results. Please try again."
            )

        envelope = AttestedSearchEnvelope(
            schemaVersion=1,
            snapshotVersion=snapshot_version,
            expiresAt=exp_dt,
            fingerprint=fingerprint,
            selectionAttestation=selection_attestation,
            results=snapshot_results,
        )

        if defer_snapshot_persistence:
            snapshot_staging[snapshot_stage_key] = {
                "lifecycle": lifecycle,
                "owner": owner,
                "envelope": envelope,
            }
        else:
            create_res = lifecycle.create_or_replace(owner, envelope)
            if inspect.isawaitable(create_res):
                await create_res
    except Exception as e:
        logger.error("Failed to save trusted snapshot: %s", str(e), exc_info=True)
        return _narration("I encountered an error preparing your search results. Please try again.")

    return _narration(project_flight_search_for_narration(data))
