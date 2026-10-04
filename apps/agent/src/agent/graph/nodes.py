import inspect
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
from langchain_core.runnables import RunnableConfig

from agent.agents.chat_agent import get_chat_model
from agent.agents.travel_assistant import TRAVEL_PROMPT
from agent.config import get_settings
from agent.graph.state import AgentState
from agent.guardrails.base import GUARDRAIL_TOOL_SCHEMA, TurnCapabilities
from agent.guardrails.gateway import GuardrailGateway
from agent.guardrails.output_pipeline import approved_model_content, payload_free_config
from agent.tools.base import get_nestjs_client
from agent.tools.registry import get_tool_by_name
from agent.trusted_search_snapshot import (
    AttestedSearchEnvelope,
    ResolvedOfferSelection,
    SnapshotOwner,
    TrustedSearchResult,
    TrustedSearchSnapshot,
    TrustedSearchSnapshotLifecycle,
)

logger = logging.getLogger("agent.graph.nodes")


async def final_answer_node(state: AgentState, config: RunnableConfig) -> dict:
    """Call the LLM without tools bound to provide a final summary answer when iteration limit is reached."""
    model = get_chat_model()

    messages = list(state.get("messages", []))
    has_system = any(isinstance(m, SystemMessage) for m in messages)
    if not has_system:
        messages.insert(0, SystemMessage(content=TRAVEL_PROMPT))

    instruction = (
        "\n[System Note: The tool calling limit has been reached. Please provide a final response summarizing "
        "what you have found so far, or politely state that you cannot complete the operation or retrieve "
        "further information at this time.]"
    )
    messages.append(HumanMessage(content=instruction))

    response = await model.ainvoke(messages, config=payload_free_config(config))
    return (
        {"messages": [response]}
        if await approved_model_content(response.content, config)
        else {"messages": []}
    )


async def custom_tool_node(state: AgentState, config: RunnableConfig) -> dict:
    """Execute an authorized batch and publish only gateway-validated tool results."""
    current_iter = state.get("iteration_count") or 0
    update_dict = {"iteration_count": current_iter + 1}

    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    gateway = configurable.get("guardrail_gateway") if isinstance(configurable, dict) else None
    capabilities = state.get("turn_capabilities")
    messages_in = state.get("messages", [])
    calls = list(getattr(messages_in[-1], "tool_calls", []) or []) if messages_in else []
    if not isinstance(gateway, GuardrailGateway) or not isinstance(capabilities, TurnCapabilities):
        update_dict["tool_blocked"] = True
        update_dict["tool_block_response_key"] = GUARDRAIL_TOOL_SCHEMA
        return update_dict
    if not calls:
        return update_dict

    safe_config = payload_free_config(config)
    pending_snapshot_stages: dict[str, dict[str, Any]] = {}

    def build_invoke(call: Any, stage_key: str):
        async def invoke() -> Any:
            name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
            tool = get_tool_by_name(str(name))
            raw_args = call.get("args", {}) if isinstance(call, dict) else getattr(call, "args", {})
            tool_args = dict(raw_args) if isinstance(raw_args, dict) else {}
            model_fields = getattr(getattr(tool, "args_schema", None), "model_fields", {})
            if "state" in model_fields:
                tool_args["state"] = dict(state)
            tool_config = dict(safe_config)
            tool_config["configurable"] = {
                **safe_config.get("configurable", {}),
                "trusted_snapshot": state.get("trusted_snapshot"),
                "_snapshot_staging": pending_snapshot_stages,
                "_snapshot_stage_key": stage_key,
            }
            return await tool.ainvoke(tool_args, config=tool_config)

        return invoke

    decision = await gateway.execute_tool_batch(
        capabilities,
        calls,
        [build_invoke(call, str(index)) for index, call in enumerate(calls)],
    )
    if decision.status != "PASS" or decision.validated_data is None:
        pending_snapshot_stages.clear()
        update_dict["tool_blocked"] = True
        update_dict["tool_block_response_key"] = decision.response_key or GUARDRAIL_TOOL_SCHEMA
        return update_dict

    try:
        latest_by_owner: dict[
            tuple[str, str],
            tuple[TrustedSearchSnapshotLifecycle, SnapshotOwner, AttestedSearchEnvelope],
        ] = {}
        for staged in pending_snapshot_stages.values():
            lifecycle = staged.get("lifecycle")
            owner = staged.get("owner")
            envelope = staged.get("envelope")
            if not isinstance(lifecycle, TrustedSearchSnapshotLifecycle):
                raise ValueError("Invalid trusted snapshot lifecycle")
            if not isinstance(owner, SnapshotOwner) or not isinstance(
                envelope, AttestedSearchEnvelope
            ):
                raise ValueError("Invalid trusted snapshot stage")
            latest_by_owner[(owner.user_id, owner.chat_session_id)] = (
                lifecycle,
                owner,
                envelope,
            )

        if len(latest_by_owner) > 1:
            raise ValueError("Trusted snapshot batch spans multiple owners")
        if latest_by_owner:
            lifecycle, owner, envelope = next(iter(latest_by_owner.values()))
            committed = lifecycle.commit_next(owner, envelope)
            if inspect.isawaitable(committed):
                committed = await committed
            if not isinstance(committed, TrustedSearchSnapshot):
                raise ValueError("Invalid committed trusted snapshot")
            update_dict["trusted_snapshot"] = committed.model_dump(mode="json")
    except Exception:
        logger.warning("trusted_search_snapshot_batch_commit_failed")
        pending_snapshot_stages.clear()
        update_dict["tool_blocked"] = True
        update_dict["tool_block_response_key"] = GUARDRAIL_TOOL_SCHEMA
        return update_dict
    pending_snapshot_stages.clear()

    messages = []
    for call, validated in zip(calls, decision.validated_data):
        data = validated.data
        content = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False)
        call_id = call.get("id", "") if isinstance(call, dict) else getattr(call, "id", "")
        messages.append(
            ToolMessage(
                content=content,
                tool_call_id=call_id,
                name=validated.tool_name,
                additional_kwargs={"guardrail_validated": True},
            )
        )
    update_dict["messages"] = messages

    for msg, validated in zip(messages, decision.validated_data):
        if validated.tool_name != "signal_checkout_intent" or not isinstance(msg.content, str):
            continue
        try:
            from agent.guardrails.schemas.tools import SignalCheckoutIntentToolResult

            parsed = SignalCheckoutIntentToolResult.model_validate(json.loads(msg.content))
        except (TypeError, ValueError, json.JSONDecodeError):
            continue
        if parsed.signal is not None:
            update_dict["signal"] = parsed.signal.model_dump()
            msg.content = "Checkout intent registered successfully."

    return update_dict


_ALLOWLISTED_DISPLAY_FIELDS = (
    "airline",
    "origin",
    "destination",
    "departureAt",
    "arrivalAt",
    "price",
    "currency",
)


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


def _extract_display_info(
    offer: TrustedSearchResult | None = None,
    upstream_display: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Extract allowlisted display fields from offer and upstream response."""
    display_info: dict[str, Any] = {}

    if offer is not None:
        for field in _ALLOWLISTED_DISPLAY_FIELDS:
            val = getattr(offer, field, None)
            if val is not None:
                if isinstance(val, datetime):
                    if val.tzinfo == timezone.utc or val.utcoffset() == timedelta(0):
                        display_info[field] = val.strftime("%Y-%m-%dT%H:%M:%SZ")
                    else:
                        display_info[field] = val.isoformat()
                elif field == "price":
                    display_info[field] = str(val)
                else:
                    display_info[field] = val

    if isinstance(upstream_display, dict):
        for field in _ALLOWLISTED_DISPLAY_FIELDS:
            if field in upstream_display:
                val = upstream_display[field]
                if isinstance(val, datetime):
                    if val.tzinfo == timezone.utc or val.utcoffset() == timedelta(0):
                        display_info[field] = val.strftime("%Y-%m-%dT%H:%M:%SZ")
                    else:
                        display_info[field] = val.isoformat()
                elif field == "price":
                    display_info[field] = str(val)
                else:
                    display_info[field] = val

    return display_info if display_info else None


async def validate_handoff(state: AgentState, config: RunnableConfig) -> dict:
    """Validate snapshot and signal before creating handoff."""
    norm_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(dict(state) if state else {})
    signal = norm_state.get("signal")
    if not signal or not isinstance(signal, dict):
        logger.info("validate_handoff_missing_signal")
        return {"action": {"error": "Missing checkout signal."}}

    offer_index = (
        signal.get("offer_index")
        if signal.get("offer_index") is not None
        else signal.get("selected_index")
    )
    if (
        offer_index is None
        or isinstance(offer_index, bool)
        or not isinstance(offer_index, int)
        or offer_index < 1
    ):
        logger.info("validate_handoff_invalid_offer_index")
        return {"action": {"error": "Missing checkout signal."}}

    configurable = config.get("configurable", {}) if isinstance(config, dict) else {}
    repository = (
        configurable.get("trusted_snapshot_repository") if isinstance(configurable, dict) else None
    )
    has_config_snapshot = isinstance(configurable, dict) and "trusted_snapshot" in configurable
    snapshot = norm_state.get("trusted_snapshot")
    if repository is not None:
        user_id = configurable.get("user_id")
        session_id = configurable.get("thread_id")
        get_snapshot = getattr(repository, "get_snapshot", None)
        if (
            not isinstance(user_id, str)
            or not user_id
            or not isinstance(session_id, str)
            or not session_id
            or not callable(get_snapshot)
        ):
            logger.info("validate_handoff_missing_snapshot_owner")
            return {"action": {"error": "Missing or invalid trusted snapshot."}}
        try:
            active_snapshot = await get_snapshot(user_id, session_id)
        except Exception:
            logger.warning("validate_handoff_snapshot_read_failed")
            active_snapshot = None
        if active_snapshot is None:
            logger.info("validate_handoff_snapshot_owner_mismatch")
            return {"action": {"error": "Missing or invalid trusted snapshot."}}
        snapshot = active_snapshot
    elif has_config_snapshot:
        snapshot = configurable.get("trusted_snapshot")
        if snapshot is None:
            logger.info("validate_handoff_missing_loaded_snapshot")
            return {"action": {"error": "Missing or invalid trusted snapshot."}}
    if hasattr(snapshot, "model_dump"):
        snapshot = snapshot.model_dump(mode="json")

    if not snapshot or not isinstance(snapshot, dict):
        logger.info("validate_handoff_missing_snapshot")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    if repository is not None or has_config_snapshot:
        expected_user = configurable.get("user_id")
        expected_session = configurable.get("thread_id")
        if (
            isinstance(expected_user, str)
            and isinstance(expected_session, str)
            and (
                snapshot.get("userId") != expected_user
                or snapshot.get("sessionId") != expected_session
            )
        ):
            logger.info("validate_handoff_snapshot_owner_mismatch")
            return {"action": {"error": "Missing or invalid trusted snapshot."}}

    version = (
        snapshot.get("snapshotVersion")
        if snapshot.get("snapshotVersion") is not None
        else snapshot.get("version")
    )
    if version is None or isinstance(version, bool) or not isinstance(version, int) or version < 1:
        logger.info("validate_handoff_invalid_snapshot_version")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    attestation = snapshot.get("selectionAttestation") or snapshot.get("attestation")
    if not attestation or not isinstance(attestation, str) or not attestation.strip():
        logger.info("validate_handoff_invalid_snapshot_attestation")
        return {"action": {"error": "Missing or invalid trusted snapshot."}}

    results = (
        snapshot.get("results") if snapshot.get("results") is not None else snapshot.get("offers")
    )
    if not isinstance(results, list) or len(results) == 0:
        logger.info("validate_handoff_missing_results")
        return {"action": {"error": "Missing or invalid search results in snapshot."}}

    if not (1 <= offer_index <= len(results)):
        logger.info("validate_handoff_offer_index_out_of_bounds")
        return {"action": {"error": "Selected offer index is out of bounds."}}

    expires_at_raw = snapshot.get("expiresAt") or snapshot.get("snapshotExpiresAt")
    if expires_at_raw:
        try:
            if isinstance(expires_at_raw, datetime):
                expires_dt = expires_at_raw
            elif isinstance(expires_at_raw, str):
                expires_dt = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            else:
                expires_dt = None

            if expires_dt:
                if expires_dt.tzinfo is None:
                    expires_dt = expires_dt.replace(tzinfo=timezone.utc)
                if expires_dt <= datetime.now(timezone.utc):
                    logger.info("validate_handoff_snapshot_expired")
                    return {
                        "action": {"error": "Search snapshot has expired. Please search again."}
                    }
        except (ValueError, TypeError):
            logger.info("validate_handoff_snapshot_expiry_parse_error")
            return {"action": {"error": "Search snapshot has expired. Please search again."}}

    return {"trusted_snapshot": snapshot} if repository is not None or has_config_snapshot else {}


async def create_handoff_token(state: AgentState, config: RunnableConfig) -> dict:
    """Create a handoff token using NestJSClient and emit action."""
    if not get_settings().FEATURE_FLAG_CHAT_HANDOFF_ISSUE:
        logger.info("create_handoff_token_disabled")
        return {"action": {"error": "Chat handoff issuance is disabled."}}

    norm_state = TrustedSearchSnapshotLifecycle.normalize_graph_state(dict(state) if state else {})
    signal = norm_state.get("signal")
    snapshot_raw = norm_state.get("trusted_snapshot")

    if (
        not signal
        or not isinstance(signal, dict)
        or snapshot_raw is None
        or (
            not isinstance(snapshot_raw, dict)
            and not isinstance(snapshot_raw, TrustedSearchSnapshot)
        )
    ):
        logger.info("create_handoff_token_invalid_state")
        return {"action": {"error": "Invalid state for handoff creation."}}

    offer_index = (
        signal.get("offer_index")
        if signal.get("offer_index") is not None
        else signal.get("selected_index")
    )
    if (
        offer_index is None
        or isinstance(offer_index, bool)
        or not isinstance(offer_index, int)
        or offer_index < 1
    ):
        logger.info("create_handoff_token_invalid_offer_index")
        return {"action": {"error": "Invalid state for handoff creation."}}

    try:
        if isinstance(snapshot_raw, TrustedSearchSnapshot):
            snapshot_obj = snapshot_raw
        else:
            raw_results = snapshot_raw.get("results") or snapshot_raw.get("offers")
            if not isinstance(raw_results, list) or len(raw_results) == 0:
                logger.info("create_handoff_token_missing_results")
                return {"action": {"error": "Invalid state for handoff creation."}}

            results_list: list[TrustedSearchResult] = []
            for i, item in enumerate(raw_results, 1):
                if isinstance(item, TrustedSearchResult):
                    results_list.append(item)
                elif isinstance(item, dict):
                    flight_offer_id = item.get("flightOfferId")
                    supplier_offer_id = item.get("supplierOfferId")
                    if (
                        "duffelOfferId" in item
                        or not flight_offer_id
                        or not isinstance(supplier_offer_id, str)
                        or not supplier_offer_id.strip()
                    ):
                        logger.info("create_handoff_token_missing_offer_ids")
                        return {"action": {"error": "Invalid state for handoff creation."}}

                    dep_val = item.get("departureAt") or item.get("departureTime")
                    arr_val = item.get("arrivalAt") or item.get("arrivalTime")
                    if not dep_val or not arr_val:
                        logger.info("create_handoff_token_missing_timestamps")
                        return {"action": {"error": "Invalid state for handoff creation."}}

                    dep_dt = _to_utc_datetime(dep_val)
                    arr_dt = _to_utc_datetime(arr_val)

                    results_list.append(
                        TrustedSearchResult(
                            offerIndex=item.get("offerIndex", i),
                            flightOfferId=str(flight_offer_id),
                            supplierOfferId=supplier_offer_id,
                            airline=str(item.get("airline") or ""),
                            origin=str(item.get("origin") or item.get("departureAirport") or ""),
                            destination=str(
                                item.get("destination") or item.get("arrivalAirport") or ""
                            ),
                            departureAt=dep_dt,
                            arrivalAt=arr_dt,
                            price=str(item.get("price", "0.0")),
                            currency=str(item.get("currency", "USD")),
                        )
                    )
                else:
                    logger.info("create_handoff_token_invalid_result_item")
                    return {"action": {"error": "Invalid state for handoff creation."}}

            created_at_raw = snapshot_raw.get("createdAt")
            created_at = (
                _to_utc_datetime(created_at_raw) if created_at_raw else datetime.now(timezone.utc)
            )

            expires_at_raw = snapshot_raw.get("expiresAt") or snapshot_raw.get("snapshotExpiresAt")
            if expires_at_raw:
                expires_at = _to_utc_datetime(expires_at_raw)
            else:
                expires_at = created_at + timedelta(minutes=15)

            attestation = snapshot_raw.get("selectionAttestation") or snapshot_raw.get(
                "attestation"
            )
            if not attestation or not isinstance(attestation, str) or not attestation.strip():
                logger.info("create_handoff_token_missing_attestation")
                return {"action": {"error": "Invalid state for handoff creation."}}

            fingerprint = snapshot_raw.get("fingerprint") or attestation
            if not fingerprint or not isinstance(fingerprint, str) or not fingerprint.strip():
                logger.info("create_handoff_token_missing_fingerprint")
                return {"action": {"error": "Invalid state for handoff creation."}}

            version = (
                snapshot_raw.get("snapshotVersion")
                if snapshot_raw.get("snapshotVersion") is not None
                else snapshot_raw.get("version")
            )
            if (
                version is None
                or isinstance(version, bool)
                or not isinstance(version, int)
                or version < 1
            ):
                version = 1

            snapshot_obj = TrustedSearchSnapshot(
                schemaVersion=snapshot_raw.get("schemaVersion", 1),
                snapshotVersion=version,
                userId=str(snapshot_raw.get("userId") or "user"),
                sessionId=str(snapshot_raw.get("sessionId") or "session"),
                createdAt=created_at,
                expiresAt=expires_at,
                fingerprint=fingerprint,
                selectionAttestation=attestation,
                results=results_list,
            )

        lifecycle = TrustedSearchSnapshotLifecycle(None)
        resolved_selection: ResolvedOfferSelection = await lifecycle.select(
            snapshot_obj, offer_index
        )

        client = get_nestjs_client(config)
        response = await client.create_handoff_token(
            attestation=resolved_selection.selection_attestation,
            selected_offer_index=resolved_selection.offer_index,
            fingerprint=snapshot_obj.fingerprint,
        )

        if not isinstance(response, dict) or "error" in response:
            logger.error("create_handoff_token_upstream_error")
            return {"action": {"error": "Checkout handoff could not be created."}}

        handoff_token = response.get("handoffToken") or response.get("token")
        expires_at_token = response.get("expiresAt")

        if not handoff_token:
            logger.error("create_handoff_token_missing_token")
            return {"action": {"error": "Checkout handoff could not be created."}}

        display_info = _extract_display_info(
            offer=resolved_selection.offer,
            upstream_display=response.get("display")
            if isinstance(response.get("display"), dict)
            else None,
        )

        return {
            "action": {
                "action": "begin_checkout",
                "handoffToken": handoff_token,
                "expiresAt": expires_at_token,
                "display": display_info,
            }
        }
    except Exception:
        logger.error("create_handoff_token_failed")
        return {"action": {"error": "Checkout handoff could not be created."}}


create_handoff_token_node = create_handoff_token
