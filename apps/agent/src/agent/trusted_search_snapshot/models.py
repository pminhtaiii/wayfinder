"""Strict, canonical models for the trusted search snapshot lifecycle."""

from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def _validate_utc_datetime(value: datetime) -> datetime:
    """Reject timestamps that are naïve or have an offset other than UTC."""

    if value.tzinfo is None or value.utcoffset() != timedelta(0):
        raise ValueError("timestamp must be an aware UTC datetime")
    return value


def _validate_strict_positive_integer(value: object) -> object:
    """Prevent Pydantic's normal ``bool``-to-``int`` coercion at trust boundaries."""

    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError("value must be a strict positive integer")
    return value


class SnapshotOwner(BaseModel):
    """The owner scope used for all trusted snapshot Redis operations."""

    user_id: str = Field(min_length=1)
    chat_session_id: str = Field(min_length=1)

    model_config = ConfigDict(extra="forbid", frozen=True)


class TrustedSearchResult(BaseModel):
    """A provider-backed offer retained only inside a trusted snapshot."""

    offerIndex: int = Field(gt=0, strict=True)
    flightOfferId: str = Field(min_length=1)
    supplierOfferId: str = Field(min_length=1)
    airline: str
    origin: str
    destination: str
    departureAt: datetime
    arrivalAt: datetime
    price: str
    currency: str

    model_config = ConfigDict(extra="forbid")

    @field_validator("offerIndex", mode="before")
    @classmethod
    def validate_strict_offer_index(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)

    @field_validator("departureAt", "arrivalAt")
    @classmethod
    def validate_utc_timestamps(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)


class AttestedSearchEnvelope(BaseModel):
    """Validated gateway search payload before an owner is attached."""

    schemaVersion: Literal[1]
    snapshotVersion: int = Field(gt=0, strict=True)
    expiresAt: datetime
    fingerprint: str = Field(min_length=1)
    selectionAttestation: str = Field(min_length=1)
    results: list[TrustedSearchResult] = Field(min_length=1, max_length=5)

    model_config = ConfigDict(extra="forbid")

    @field_validator("schemaVersion", mode="before")
    @classmethod
    def validate_strict_schema_version(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)

    @field_validator("snapshotVersion", mode="before")
    @classmethod
    def validate_strict_snapshot_version(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)

    @field_validator("expiresAt")
    @classmethod
    def validate_utc_expiry(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)

    @model_validator(mode="after")
    def validate_results_indexes(self) -> "AttestedSearchEnvelope":
        indexes = [result.offerIndex for result in self.results]
        expected = list(range(1, len(self.results) + 1))
        if indexes != expected:
            raise ValueError("Result indexes must be unique and contiguous from 1")
        return self


class TrustedSearchSnapshot(AttestedSearchEnvelope):
    """An owner-scoped, attested search result set held in Redis."""

    userId: str = Field(min_length=1)
    sessionId: str = Field(min_length=1)
    createdAt: datetime

    model_config = ConfigDict(extra="forbid")

    @field_validator("createdAt")
    @classmethod
    def validate_utc_created_at(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)

    @model_validator(mode="after")
    def validate_snapshot_interval(self) -> "TrustedSearchSnapshot":
        if self.createdAt >= self.expiresAt:
            raise ValueError("createdAt must be before expiresAt")
        return self


class ResolvedOfferSelection(BaseModel):
    """Internal-only result of resolving a trusted offer index."""

    offer_index: int = Field(gt=0, strict=True)
    offer: TrustedSearchResult
    selection_attestation: str = Field(min_length=1)
    expires_at: datetime

    model_config = ConfigDict(extra="forbid", frozen=True)

    @field_validator("expires_at")
    @classmethod
    def validate_utc_expiry(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)

    @field_validator("offer_index", mode="before")
    @classmethod
    def validate_strict_offer_index(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)

    @model_validator(mode="after")
    def validate_offer_matches_index(self) -> "ResolvedOfferSelection":
        if self.offer_index != self.offer.offerIndex:
            raise ValueError("offer_index must match offer.offerIndex")
        return self

    @property
    def offerIndex(self) -> int:
        """Legacy-style read alias for internal callers during migration."""

        return self.offer_index


class SafeSearchResult(BaseModel):
    """Allowlisted LLM projection of a trusted search result."""

    index: int = Field(gt=0, strict=True)
    airline: str
    origin: str
    destination: str
    departure_at: datetime = Field(
        validation_alias="departureAt", serialization_alias="departureAt"
    )
    arrival_at: datetime = Field(validation_alias="arrivalAt", serialization_alias="arrivalAt")
    price: str
    currency: str

    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, serialize_by_alias=True
    )

    @field_validator("departure_at", "arrival_at")
    @classmethod
    def validate_utc_timestamps(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)

    @field_validator("index", mode="before")
    @classmethod
    def validate_strict_index(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)


class SafeFlightResult(BaseModel):
    """Allowlisted browser/SSE projection of a trusted search result."""

    index: int = Field(gt=0, strict=True)
    airline: str
    origin: str
    destination: str
    departureAt: datetime
    arrivalAt: datetime
    price: str
    currency: str

    model_config = ConfigDict(extra="forbid", frozen=True)

    @field_validator("departureAt", "arrivalAt")
    @classmethod
    def validate_utc_timestamps(cls, value: datetime) -> datetime:
        return _validate_utc_datetime(value)

    @field_validator("index", mode="before")
    @classmethod
    def validate_strict_index(cls, value: object) -> object:
        return _validate_strict_positive_integer(value)
