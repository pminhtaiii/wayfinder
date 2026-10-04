"""Minimized, strict schemas at the public LangChain tool boundary."""

from typing import Annotated, Any, Literal, TypeVar

from langgraph.prebuilt import InjectedState
from pydantic import BaseModel, ConfigDict, Field, model_validator


class _ToolSchema(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class _UpstreamProjection(BaseModel):
    """Private, allowlisted source projection; unmodelled provider data is discarded."""

    model_config = ConfigDict(extra="ignore", strict=True)


Projection = TypeVar("Projection", bound=_UpstreamProjection)


def project_upstream(model: type[Projection], raw: Any) -> Projection:
    """Validate only the source fields this tool is explicitly permitted to consume."""
    return model.model_validate(raw)


class SearchFlightsToolInput(_ToolSchema):
    origin: str
    destination: str
    date: str
    passengers: int = Field(default=1, gt=0)


class FlightSearchResult(_ToolSchema):
    flight_id: str
    airline: str
    price: float = Field(gt=0)
    origin: str
    destination: str
    date: str | None = None
    currency: str | None = None
    policy: str | None = None
    seat_available: str | None = None


class SearchFlightsToolResult(_ToolSchema):
    narration: str | None = None
    flights: list[FlightSearchResult] | None = None

    @model_validator(mode="after")
    def require_one_public_result(self) -> "SearchFlightsToolResult":
        if (self.narration is None) == (self.flights is None):
            raise ValueError("search results require exactly one public result shape")
        return self


class MatchExplanationProjection(_UpstreamProjection):
    key: str
    params: dict[str, str | int | float] = Field(default_factory=dict)


class MatchViolationProjection(_UpstreamProjection):
    explanation: str | MatchExplanationProjection | None = None


class MatchEligibilityProjection(_UpstreamProjection):
    violations: list[MatchViolationProjection] = Field(default_factory=list)


class MatchBreakdownProjection(_UpstreamProjection):
    dimension: str | None = None
    explanation: str | MatchExplanationProjection | None = None


class MatchResultProjection(_UpstreamProjection):
    score: int | float | None = None
    matchLevel: str | None = None
    eligibility: MatchEligibilityProjection | None = None
    breakdown: list[MatchBreakdownProjection] = Field(default_factory=list)
    explanations: list[str | MatchExplanationProjection] = Field(default_factory=list)


class SearchFlightUpstreamProjection(_UpstreamProjection):
    flightOfferId: str
    duffelOfferId: str | None = None
    airline: str | None = None
    departureAirport: str | None = None
    arrivalAirport: str | None = None
    origin: str | None = None
    destination: str | None = None
    departureTime: str | None = None
    departureAt: str | None = None
    arrivalTime: str | None = None
    arrivalAt: str | None = None
    duration: int | float | str | None = None
    stops: int | None = None
    price: int | float | str | None = None
    currency: str | None = None
    baggageAllowance: str | None = None
    baggage: str | None = None
    matchResult: MatchResultProjection | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_unsigned_supplier_identity(cls, value: object) -> object:
        if isinstance(value, dict) and "supplierOfferId" in value:
            raise ValueError("supplierOfferId is not accepted in gateway search results")
        return value

    @model_validator(mode="after")
    def require_snapshot_times(self) -> "SearchFlightUpstreamProjection":
        if not (self.departureTime or self.departureAt) or not (self.arrivalTime or self.arrivalAt):
            raise ValueError("flight snapshot times are required")
        return self


class SearchFlightsUpstreamProjection(_UpstreamProjection):
    snapshotVersion: int
    snapshotExpiresAt: str | None = None
    expiresAt: str | None = None
    selectionAttestation: str | None = None
    attestation: str | None = None
    fingerprint: str | None = None
    mode: str | None = None
    results: list[SearchFlightUpstreamProjection]

    @model_validator(mode="after")
    def require_private_snapshot_values(self) -> "SearchFlightsUpstreamProjection":
        if not (self.snapshotExpiresAt or self.expiresAt):
            raise ValueError("snapshot expiry is required")
        if not (self.selectionAttestation or self.attestation):
            raise ValueError("selection attestation is required")
        return self


class GetPreferencesToolInput(_ToolSchema):
    pass


class GetPreferencesToolResult(_ToolSchema):
    narration: str


class PreferencesUpstreamProjection(_UpstreamProjection):
    seatPreference: str | None = None
    classPreference: str | None = None
    preferredAirlines: list[str] = Field(default_factory=list)
    blacklistedAirlines: list[str] = Field(default_factory=list)
    dietaryNeeds: str | None = None


class BookingSummariesToolInput(_ToolSchema):
    pass


class BookingSummariesToolResult(_ToolSchema):
    narration: str


class BookingSummaryUpstreamProjection(_UpstreamProjection):
    bookingReference: str | None = None
    agentReference: str | None = None
    status: str | None = None
    airline: str | None = None
    origin: str | None = None
    destination: str | None = None
    departureTime: str | None = None
    departureAt: str | None = None
    arrivalTime: str | None = None
    arrivalAt: str | None = None
    durationMinutes: int = 0
    stops: int | None = None
    stopCount: int | None = None


class BookingSummariesUpstreamProjection(_UpstreamProjection):
    bookings: list[BookingSummaryUpstreamProjection] | None = None
    summaries: list[BookingSummaryUpstreamProjection] | None = None

    @model_validator(mode="after")
    def require_one_summary_collection(self) -> "BookingSummariesUpstreamProjection":
        if self.bookings is None and self.summaries is None:
            raise ValueError("booking summaries are required")
        return self


class BookingDetailToolInput(_ToolSchema):
    booking_reference: str


class BookingDetailToolResult(_ToolSchema):
    narration: str


class BookingDetailUpstreamProjection(_UpstreamProjection):
    bookingReference: str | None = None
    status: str | None = None
    airline: str | None = None
    origin: str | None = None
    destination: str | None = None
    departureTime: str | None = None
    departureAt: str | None = None
    arrivalTime: str | None = None
    arrivalAt: str | None = None
    flightNumber: str | None = None
    durationMinutes: int = 0
    stops: int | None = None
    stopCount: int | None = None
    baggageAllowance: str | None = None
    baggageSummary: str | None = None
    refundable: bool | None = None
    changeable: bool | None = None


class PassengerToolInput(_ToolSchema):
    passengerType: Literal["ADULT", "CHILD", "INFANT"]
    passengerOrdinal: int = Field(gt=0)
    sourceType: Literal["traveler_profile", "inline"]


class ReadinessIssueResult(_ToolSchema):
    section: Literal[
        "itinerary",
        "identity",
        "contact",
        "travel_document",
        "entry_eligibility",
    ]
    name: Literal[
        "scope",
        "destinationEntryEligibility",
        "givenName",
        "middleName",
        "familyName",
        "dateOfBirth",
        "gender",
        "title",
        "nationality",
        "email",
        "phoneCountryCode",
        "phoneNumber",
        "documentType",
        "passportNumber",
        "passportExpiry",
        "issuingCountry",
    ]
    status: Literal["filled", "missing", "invalid", "warning", "unknown"]
    reason: (
        Literal[
            "REQUIRED",
            "PASSPORT_VALIDITY_REQUIRES_VERIFICATION",
            "UNSUPPORTED_DOCUMENT_TYPE",
            "EXPIRED",
            "AIRPORT_COUNTRY_UNAVAILABLE",
            "PROFILE_CHANGED",
            "READINESS_DEPENDENCY_UNAVAILABLE",
            "ENTRY_ELIGIBILITY_UNKNOWN",
            "INVALID_COUNTRY",
            "INVALID_DATE",
            "INVALID_DOCUMENT_NUMBER",
            "INVALID_EMAIL",
            "INVALID_GENDER",
            "INVALID_PHONE",
            "INVALID_TITLE",
            "ITINERARY_UNAVAILABLE",
            "TRIP_COMPLETION_UNAVAILABLE",
        ]
        | None
    )


class ReadinessFieldUpstreamProjection(_UpstreamProjection):
    name: Literal[
        "scope",
        "destinationEntryEligibility",
        "givenName",
        "middleName",
        "familyName",
        "dateOfBirth",
        "gender",
        "title",
        "nationality",
        "email",
        "phoneCountryCode",
        "phoneNumber",
        "documentType",
        "passportNumber",
        "passportExpiry",
        "issuingCountry",
    ]
    status: Literal["filled", "missing", "invalid", "warning", "unknown"]
    reason: (
        Literal[
            "REQUIRED",
            "PASSPORT_VALIDITY_REQUIRES_VERIFICATION",
            "UNSUPPORTED_DOCUMENT_TYPE",
            "EXPIRED",
            "AIRPORT_COUNTRY_UNAVAILABLE",
            "PROFILE_CHANGED",
            "READINESS_DEPENDENCY_UNAVAILABLE",
            "ENTRY_ELIGIBILITY_UNKNOWN",
            "INVALID_COUNTRY",
            "INVALID_DATE",
            "INVALID_DOCUMENT_NUMBER",
            "INVALID_EMAIL",
            "INVALID_GENDER",
            "INVALID_PHONE",
            "INVALID_TITLE",
            "ITINERARY_UNAVAILABLE",
            "TRIP_COMPLETION_UNAVAILABLE",
        ]
        | None
    )


class ReadinessSectionUpstreamProjection(_UpstreamProjection):
    name: Literal[
        "itinerary",
        "identity",
        "contact",
        "travel_document",
        "entry_eligibility",
    ]
    fields: list[ReadinessFieldUpstreamProjection]


class PassengerReadinessResult(_ToolSchema):
    passengerType: Literal["ADULT", "CHILD", "INFANT"]
    passengerOrdinal: int = Field(gt=0)
    issues: list[ReadinessIssueResult]


class PassengerReadinessUpstreamProjection(_UpstreamProjection):
    passengerType: Literal["ADULT", "CHILD", "INFANT"]
    passengerOrdinal: int = Field(gt=0)
    issues: list[ReadinessIssueResult] | None = None
    sections: list[ReadinessSectionUpstreamProjection] | None = None


class CheckBookingReadinessToolInput(_ToolSchema):
    flight_offer_id: str
    passengers: list[PassengerToolInput]


class CheckBookingReadinessToolResult(_ToolSchema):
    scope: Literal["DOMESTIC", "INTERNATIONAL", "UNKNOWN"] | None = None
    ready: bool | None = None
    passengers: list[PassengerReadinessResult] | None = None
    nextAction: Literal["COMPLETE_PROFILE", "CONTINUE_CHECKOUT"] | None = None
    error: str | None = None

    @model_validator(mode="after")
    def validate_result_shape(self) -> "CheckBookingReadinessToolResult":
        if self.error is not None:
            if any(
                value is not None
                for value in (self.scope, self.ready, self.passengers, self.nextAction)
            ):
                raise ValueError("readiness errors cannot include readiness data")
            return self
        if any(
            value is None for value in (self.scope, self.ready, self.passengers, self.nextAction)
        ):
            raise ValueError("readiness results require all public fields")
        return self


class BookingReadinessUpstreamProjection(_UpstreamProjection):
    scope: Literal["DOMESTIC", "INTERNATIONAL", "UNKNOWN"]
    ready: bool
    passengers: list[PassengerReadinessUpstreamProjection]
    nextAction: Literal["COMPLETE_PROFILE", "CONTINUE_CHECKOUT"]


def project_booking_readiness_upstream(raw: Any) -> CheckBookingReadinessToolResult:
    source = project_upstream(BookingReadinessUpstreamProjection, raw)
    passengers = []
    for passenger in source.passengers:
        if passenger.issues is not None:
            issues = [
                ReadinessIssueResult(
                    section=issue.section,
                    name=issue.name,
                    status=issue.status,
                    reason=issue.reason,
                )
                for issue in passenger.issues
            ]
        elif passenger.sections is not None:
            issues = [
                ReadinessIssueResult(
                    section=section.name,
                    name=field.name,
                    status=field.status,
                    reason=field.reason,
                )
                for section in passenger.sections
                for field in section.fields
            ]
        else:
            issues = []
        passengers.append(
            PassengerReadinessResult(
                passengerType=passenger.passengerType,
                passengerOrdinal=passenger.passengerOrdinal,
                issues=issues,
            )
        )
    return CheckBookingReadinessToolResult(
        scope=source.scope,
        ready=source.ready,
        passengers=passengers,
        nextAction=source.nextAction,
    )


class SignalCheckoutIntentToolInput(_ToolSchema):
    offer_index: int | None = Field(default=None, gt=0)
    selected_index: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def require_offer_index(self) -> "SignalCheckoutIntentToolInput":
        if self.offer_index is None and self.selected_index is None:
            raise ValueError("an offer index is required")
        return self


class SignalCheckoutIntentInvocation(_ToolSchema):
    """Internal invocation shape. ToolNode replaces this injected field before validation."""

    offer_index: int | None = Field(default=None, gt=0)
    selected_index: int | None = Field(default=None, gt=0)
    state: Annotated[dict, InjectedState]

    @model_validator(mode="after")
    def require_offer_index(self) -> "SignalCheckoutIntentInvocation":
        if self.offer_index is None and self.selected_index is None:
            raise ValueError("an offer index is required")
        return self


class CheckoutSignalResult(_ToolSchema):
    intent: Literal["checkout"]
    offer_index: int = Field(gt=0)
    selected_index: int = Field(gt=0)


class SignalCheckoutIntentToolResult(_ToolSchema):
    signal: CheckoutSignalResult | None = None
    error: str | None = None

    @model_validator(mode="after")
    def require_signal_or_error(self) -> "SignalCheckoutIntentToolResult":
        if (self.signal is None) == (self.error is None):
            raise ValueError("checkout signal results require exactly one result shape")
        return self


TOOL_INPUT_SCHEMAS: dict[str, type[_ToolSchema]] = {
    "search_flights": SearchFlightsToolInput,
    "get_user_preferences": GetPreferencesToolInput,
    "list_user_booking_summaries": BookingSummariesToolInput,
    "get_booking_detail": BookingDetailToolInput,
    "check_booking_readiness": CheckBookingReadinessToolInput,
    "signal_checkout_intent": SignalCheckoutIntentToolInput,
}

TOOL_RESULT_SCHEMAS: dict[str, type[_ToolSchema]] = {
    "search_flights": SearchFlightsToolResult,
    "get_user_preferences": GetPreferencesToolResult,
    "list_user_booking_summaries": BookingSummariesToolResult,
    "get_booking_detail": BookingDetailToolResult,
    "check_booking_readiness": CheckBookingReadinessToolResult,
    "signal_checkout_intent": SignalCheckoutIntentToolResult,
}
