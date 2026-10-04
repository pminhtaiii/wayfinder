import {
  BadRequestException,
  ConflictException,
  GoneException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import {
  FLIGHT_SEARCH_PORT,
  type FlightSearchPort,
  type FlightSegment,
} from '@/supplier/search/flight-search.port';
import { complementStoredOfferPayload } from '@/supplier/search/stored-offer-payload.helper';
import {
  createChatTelemetryEvent,
  emitChatTelemetry,
  type ChatTelemetryContext,
  type ChatTelemetryOperation,
} from '@/common/observability/chat-observability';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { ChatHandoffResponseDto, ChatHandoffDisplayDto } from './dto/chat-handoff-response.dto';
import { ChatHandoffTokenService } from './chat-handoff-token.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { FlightOffer, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

function resolveLastSegment(offer: {
  readonly segments: readonly FlightSegment[];
  readonly returnSegments?: readonly FlightSegment[] | null;
}): FlightSegment | undefined {
  if (offer.returnSegments && offer.returnSegments.length > 0) {
    return offer.returnSegments[offer.returnSegments.length - 1];
  }
  return offer.segments[offer.segments.length - 1];
}

type JsonRecord = Record<string, unknown>;

type InFlightReservation = {
  reservationId: string;
  expiresAt: number;
};

type ClaimedHandoffRow = {
  id: string;
  userId: string;
  chatSessionId: string;
  flightOfferId: string;
  tokenHash: string;
  tokenKeyVersion: number;
  expiresAt: Date;
  consumedAt: Date | null;
};

export type ResolvedChatHandoff = Prisma.ChatHandoffGetPayload<{
  include: {
    chatSession: {
      select: {
        userId: true;
        deletedAt: true;
      };
    };
  };
}>;

export type AttestationOffer = {
  flightOfferId: string;
  duffelOfferId: string;
  expires_at?: string;
  expiresAt?: string;
  airline?: string;
  origin?: string;
  destination?: string;
  departureAt?: string;
  arrivalAt?: string;
  price?: string | number;
  currency?: string;
  [key: string]: unknown;
};

export type AttestationPayload = {
  userId: string;
  sessionId: string;
  version: number;
  expiresAt: string;
  offers: AttestationOffer[];
};

export type ChatHandoffSafeResolveResponse = {
  status: 'ACTIVE' | 'CLAIMED' | 'CONSUMED';
  expiresAt: string;
  offer: {
    airline: string;
    origin: string;
    destination: string;
    departureAt: string;
    arrivalAt: string;
    price: string;
    currency: string;
    adults: number;
    children: number;
    infants: number;
  };
  passengers?: Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>;
};

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoDateValue(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

export function firstFlightSegment(rawOffer: unknown): JsonRecord | null {
  if (!isJsonRecord(rawOffer) || !Array.isArray(rawOffer.slices)) {
    return null;
  }

  const firstSlice = rawOffer.slices[0];
  if (!isJsonRecord(firstSlice) || !Array.isArray(firstSlice.segments)) {
    return null;
  }

  const firstSegment = firstSlice.segments[0];
  return isJsonRecord(firstSegment) ? firstSegment : null;
}

export function lastFlightSegment(rawOffer: unknown): JsonRecord | null {
  if (!isJsonRecord(rawOffer) || !Array.isArray(rawOffer.slices)) {
    return null;
  }

  const lastSlice = rawOffer.slices[rawOffer.slices.length - 1];
  if (!isJsonRecord(lastSlice) || !Array.isArray(lastSlice.segments)) {
    return null;
  }

  const lastSegment = lastSlice.segments[lastSlice.segments.length - 1];
  return isJsonRecord(lastSegment) ? lastSegment : null;
}

export function handoffPassengers(
  rawOffer: JsonRecord | null,
): Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }> | null {
  if (!rawOffer || !Array.isArray(rawOffer.passengers)) return null;
  const passengers = rawOffer.passengers.map((passenger) => {
    if (!isJsonRecord(passenger)) return null;
    const id = stringValue(passenger.id);
    const type = stringValue(passenger.type)?.toUpperCase();
    return id && (type === 'ADULT' || type === 'CHILD' || type === 'INFANT') ? { id, type } : null;
  });
  return passengers.every((passenger) => passenger !== null)
    ? (passengers as Array<{ id: string; type: 'ADULT' | 'CHILD' | 'INFANT' }>)
    : null;
}

/**
 * ChatHandoffService — implementation.
 */
@Injectable()
export class ChatHandoffService {
  private readonly logger = new Logger(ChatHandoffService.name);
  private readonly activeClaimAttempts = new Map<
    string,
    Promise<{ handoff: ResolvedChatHandoff; claimToken: string }>
  >();
  private readonly claimedTokens = new Map<string, number>();
  private readonly inFlightClaims = new Map<string, InFlightReservation>();
  private readonly flightOfferCache = new Map<string, FlightOffer>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly tokenService: ChatHandoffTokenService,
    private readonly selectionAttestationService: SelectionAttestationService,
    @Inject(FLIGHT_SEARCH_PORT) private readonly flightSearchPort: FlightSearchPort,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  isClaimed(token: string, userId?: string): boolean {
    if (!token || typeof token !== 'string' || !token.startsWith('chk_handoff_')) return false;
    const tokenHash = this.tokenService.hashToken(token);
    const attemptKey = userId ? `${userId}:${tokenHash}` : tokenHash;
    const claimedUntil =
      this.claimedTokens.get(attemptKey) ??
      (userId ? this.claimedTokens.get(tokenHash) : undefined);
    const inFlight =
      this.inFlightClaims.get(attemptKey) ??
      (userId ? this.inFlightClaims.get(tokenHash) : undefined);
    return (
      (claimedUntil !== undefined && claimedUntil > Date.now()) ||
      (inFlight !== undefined && inFlight.expiresAt > Date.now()) ||
      this.activeClaimAttempts.has(attemptKey)
    );
  }

  private setCachedFlightOffer(id: string, offer: FlightOffer): void {
    if (this.flightOfferCache.size >= 500) {
      const firstKey = this.flightOfferCache.keys().next().value;
      if (firstKey) this.flightOfferCache.delete(firstKey);
    }
    this.flightOfferCache.set(id, offer);
  }

  tryAcquireInFlight(token: string, userId?: string, ttlMs = 30000): string | null {
    if (!token || typeof token !== 'string' || !token.startsWith('chk_handoff_'))
      return crypto.randomUUID();
    const tokenHash = this.tokenService.hashToken(token);
    const attemptKey = userId ? `${userId}:${tokenHash}` : tokenHash;
    const now = Date.now();
    const claimedUntil =
      this.claimedTokens.get(attemptKey) ??
      (userId ? this.claimedTokens.get(tokenHash) : undefined);
    const inFlight =
      this.inFlightClaims.get(attemptKey) ??
      (userId ? this.inFlightClaims.get(tokenHash) : undefined);

    if (
      (claimedUntil !== undefined && claimedUntil > now) ||
      (inFlight !== undefined && inFlight.expiresAt > now) ||
      this.activeClaimAttempts.has(attemptKey) ||
      (userId && this.activeClaimAttempts.has(tokenHash))
    ) {
      return null;
    }

    if (this.inFlightClaims.size >= 1000) {
      for (const [key, val] of this.inFlightClaims.entries()) {
        if (val.expiresAt <= now) this.inFlightClaims.delete(key);
      }
    }
    if (this.claimedTokens.size >= 1000) {
      for (const [key, val] of this.claimedTokens.entries()) {
        if (val <= now) this.claimedTokens.delete(key);
      }
    }

    const reservationId = crypto.randomUUID();
    const reservation = { reservationId, expiresAt: now + ttlMs };
    this.inFlightClaims.set(attemptKey, reservation);
    if (userId) {
      this.inFlightClaims.set(tokenHash, reservation);
    }
    return reservationId;
  }

  releaseInFlight(token: string, userId: string | undefined, reservationId: string): void {
    if (!token || typeof token !== 'string') return;
    const tokenHash = this.tokenService.hashToken(token);
    const keys = userId ? [`${userId}:${tokenHash}`, tokenHash] : [tokenHash];
    for (const key of keys) {
      const reservation = this.inFlightClaims.get(key);
      if (reservation?.reservationId === reservationId) {
        this.inFlightClaims.delete(key);
      }
    }
  }

  /**
   * Creates a new chat handoff claim record (alias for create).
   */
  async createHandoffToken(
    dto: CreateChatHandoffDto,
    context: ChatTelemetryContext = {},
    expectedUserId?: string,
  ): Promise<ChatHandoffResponseDto> {
    return this.create(dto, context, expectedUserId);
  }

  /**
   * Creates a new chat handoff claim record.
   */
  async create(
    dto: CreateChatHandoffDto,
    context: ChatTelemetryContext = {},
    expectedUserId?: string,
  ): Promise<ChatHandoffResponseDto> {
    const startedAt = Date.now();
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ISSUE') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException('Chat handoff issuance is disabled');
    }

    const rawAttestation = dto.selectionAttestationHash ?? dto.attestation;
    if (!rawAttestation || typeof rawAttestation !== 'string') {
      throw new UnauthorizedException('Invalid attestation format');
    }

    const parts = rawAttestation.split('_v1_');
    if (parts.length !== 2) throw new UnauthorizedException('Invalid attestation format');
    const [payloadBase64, signature] = parts[1].split('.');
    if (!payloadBase64 || !signature) throw new UnauthorizedException('Invalid attestation format');
    let payloadStr: string;
    try {
      payloadStr = Buffer.from(payloadBase64, 'base64url').toString('utf8');
    } catch (err) {
      this.logger.warn(
        `[create] Invalid attestation payload base64: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid attestation payload');
    }
    let payload: AttestationPayload;
    try {
      payload = JSON.parse(payloadStr) as AttestationPayload;
    } catch (err) {
      this.logger.warn(
        `[create] Invalid attestation payload JSON: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new UnauthorizedException('Invalid attestation payload');
    }
    const {
      userId,
      sessionId: chatSessionId,
      version: snapshotVersion,
      expiresAt: attestationExpiresAt,
      offers,
    } = payload;
    if (!offers || !Array.isArray(offers))
      throw new UnauthorizedException('Invalid attestation offers');
    if (
      typeof dto.selectedOfferIndex !== 'number' ||
      dto.selectedOfferIndex < 1 ||
      dto.selectedOfferIndex > offers.length
    ) {
      throw new UnauthorizedException('Selected offer index out of bounds');
    }

    if (expectedUserId && expectedUserId !== userId) {
      throw new UnauthorizedException('User claim does not match attestation user');
    }

    await this.selectionAttestationService.verifySelectionAttestation(
      rawAttestation,
      userId,
      chatSessionId,
      snapshotVersion,
      offers,
    );

    if (this.prisma.chatSession) {
      const activeSession = await this.prisma.chatSession.findFirst({
        where: { id: chatSessionId, userId, deletedAt: null },
      });
      if (activeSession === null) {
        throw new NotFoundException('Active chat session not found');
      }
    }

    const selectedOffer = offers[dto.selectedOfferIndex - 1];
    const flightOfferId = selectedOffer.flightOfferId;
    const supplierOfferIdHash = this.tokenService.hashToken(selectedOffer.duffelOfferId);
    const snapshotFingerprint = this.tokenService.hashToken(JSON.stringify(offers));

    const idempotencyHash = this.tokenService.deriveIdempotencyHash(
      rawAttestation,
      dto.selectedOfferIndex,
    );

    let flightOffer = this.flightOfferCache.get(flightOfferId) ?? null;
    if (!flightOffer && this.prisma.flightOffer) {
      try {
        const lookup = await this.prisma.flightOffer.findUnique({ where: { id: flightOfferId } });
        if (lookup) {
          flightOffer = lookup;
          this.setCachedFlightOffer(flightOfferId, lookup);
        }
      } catch (err) {
        this.logger.warn(
          `[create] chat_handoff_offer_lookup_failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    if (!flightOffer) {
      throw new NotFoundException({
        code: 'FLIGHT_OFFER_NOT_FOUND',
        message: 'Flight offer not found or unavailable',
      });
    }

    const computedSupplierOfferIdHash = this.tokenService.hashToken(flightOffer.supplierOfferId);
    if (computedSupplierOfferIdHash !== supplierOfferIdHash) {
      throw new NotFoundException({
        code: 'FLIGHT_OFFER_NOT_FOUND',
        message: 'Flight offer not found or unavailable',
      });
    }

    const rawOffer = isJsonRecord(flightOffer.rawOffer) ? flightOffer.rawOffer : null;
    const rawOfferExpiryStr = isoDateValue(rawOffer?.expires_at);
    const selectedOfferExpiryStr = selectedOffer.expires_at ?? selectedOffer.expiresAt;
    const effectiveOfferExpiryStr = rawOfferExpiryStr ?? selectedOfferExpiryStr;
    if (!effectiveOfferExpiryStr) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Handoff offer expiration missing',
      });
    }
    const offerExpiry = new Date(effectiveOfferExpiryStr);
    if (!Number.isFinite(offerExpiry.getTime()) || offerExpiry <= new Date()) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Handoff offer is stale',
      });
    }

    const attestationExpiry = new Date(attestationExpiresAt);
    if (!Number.isFinite(attestationExpiry.getTime()) || attestationExpiry <= new Date()) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Attestation is expired',
      });
    }

    const maxTtlTime = Date.now() + 15 * 60 * 1000;
    const effectiveExpiryTime = Math.min(
      attestationExpiry.getTime(),
      offerExpiry.getTime(),
      maxTtlTime,
    );
    const expiresAt = new Date(effectiveExpiryTime);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Handoff offer is stale',
      });
    }

    const display = this.buildOfferDisplay(flightOffer, selectedOffer);

    // Active-retry convergence: check if an active valid credential already exists
    const existing = await this.prisma.chatHandoff.findUnique({
      where: { idempotencyKeyHash: idempotencyHash },
    });
    if (existing) {
      if (existing.consumedAt || existing.expiresAt <= new Date()) {
        throw new GoneException({
          code: 'HANDOFF_EXPIRED',
          message: 'Handoff expired or already consumed',
        });
      }
      const { token } = await this.tokenService.generateToken(
        existing.id,
        existing.idempotencyKeyHash,
      );
      await this.recordTelemetry(
        'handoff_replay',
        'replayed',
        Date.now() - startedAt,
        context,
        userId,
        { outcome: 'idempotent_retry', retry: true },
      );
      return {
        token,
        handoffToken: token,
        expiresAt: existing.expiresAt.toISOString(),
        ...(display ? { display } : {}),
      };
    }

    try {
      const id = crypto.randomUUID();
      const { token, tokenHash, keyVersion } = await this.tokenService.generateToken(
        id,
        idempotencyHash,
      );
      const selectionAttestationHash = this.tokenService.hashToken(rawAttestation);

      const record = await this.prisma.chatHandoff.create({
        data: {
          id,
          userId,
          chatSessionId,
          flightOfferId,
          supplierOfferIdHash,
          selectionAttestationHash,
          selectedOfferIndex: dto.selectedOfferIndex,
          snapshotVersion,
          snapshotFingerprint,
          tokenHash,
          tokenKeyVersion: keyVersion,
          idempotencyKeyHash: idempotencyHash,
          expiresAt,
        },
      });

      await this.recordTelemetry(
        'handoff_create',
        'created',
        Date.now() - startedAt,
        context,
        userId,
        { outcome: 'created' },
      );

      return {
        token,
        handoffToken: token,
        expiresAt: record.expiresAt.toISOString(),
        ...(display ? { display } : {}),
      };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existingRecord = await this.prisma.chatHandoff.findUnique({
          where: { idempotencyKeyHash: idempotencyHash },
        });
        if (!existingRecord) {
          throw new ConflictException('Idempotency collision but record not found');
        }
        if (existingRecord.consumedAt || existingRecord.expiresAt <= new Date()) {
          throw new GoneException({
            code: 'HANDOFF_EXPIRED',
            message: 'Handoff expired or already consumed',
          });
        }

        const { token } = await this.tokenService.generateToken(
          existingRecord.id,
          existingRecord.idempotencyKeyHash,
        );

        await this.recordTelemetry(
          'handoff_replay',
          'replayed',
          Date.now() - startedAt,
          context,
          userId,
          { outcome: 'idempotent_retry', retry: true },
        );

        return {
          token,
          handoffToken: token,
          expiresAt: existingRecord.expiresAt.toISOString(),
          ...(display ? { display } : {}),
        };
      }
      throw error;
    }
  }

  private buildOfferDisplay(
    flightOffer: FlightOffer | null,
    selectedOffer: AttestationOffer,
  ): ChatHandoffDisplayDto | undefined {
    const payload = complementStoredOfferPayload(flightOffer?.rawOffer, flightOffer);
    const normalizedOffer = payload
      ? this.flightSearchPort.normalizeStoredOffer(payload)
      : null;

    const firstSegment = normalizedOffer?.segments[0];
    const lastSegment = normalizedOffer ? resolveLastSegment(normalizedOffer) : null;

    const airline =
      firstSegment?.operatingCarrier ||
      normalizedOffer?.airline ||
      stringValue(selectedOffer?.airline) ||
      'Unknown Airline';

    const origin =
      normalizedOffer?.departureAirport ||
      flightOffer?.origin ||
      stringValue(selectedOffer?.origin);

    const destination =
      normalizedOffer?.arrivalAirport ||
      flightOffer?.destination ||
      stringValue(selectedOffer?.destination);

    const departureAt =
      firstSegment?.departureTime ||
      stringValue(selectedOffer?.departureAt);

    const arrivalAt =
      lastSegment?.arrivalTime ||
      stringValue(selectedOffer?.arrivalAt);

    const price =
      normalizedOffer?.totalAmount ??
      (flightOffer
        ? String(flightOffer.price)
        : selectedOffer?.price !== undefined
          ? String(selectedOffer.price)
          : undefined);

    const currency =
      normalizedOffer?.currency ??
      flightOffer?.currency ??
      stringValue(selectedOffer?.currency);

    if (!origin && !destination && !departureAt) {
      return undefined;
    }

    return {
      airline,
      origin: origin ?? '',
      destination: destination ?? '',
      departureAt: departureAt ?? '',
      arrivalAt: arrivalAt ?? '',
      price: price ?? '',
      currency: currency ?? '',
    };
  }

  /**
   * Resolves a handoff token (alias for resolve).
   */
  async resolveHandoffToken(
    token: string,
    userId: string,
    context: ChatTelemetryContext = {},
  ): Promise<ResolvedChatHandoff> {
    return this.resolve(token, userId, context);
  }

  /**
   * Resolves a handoff token, binding it to an authenticated user.
   */
  async resolve(
    token: string,
    userId: string,
    context: ChatTelemetryContext = {},
  ): Promise<ResolvedChatHandoff> {
    const startedAt = Date.now();
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException({
        code: 'CHAT_HANDOFF_DISABLED',
        message: 'Chat handoff acceptance is disabled',
      });
    }

    const tokenHash = this.tokenService.hashToken(token);

    const record = await this.prisma.chatHandoff.findUnique({
      where: { tokenHash },
      include: {
        chatSession: {
          select: {
            userId: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!record) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (
      record.userId !== userId ||
      record.chatSession.userId !== userId ||
      record.chatSession.deletedAt !== null
    ) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (record.expiresAt < new Date()) {
      throw new GoneException({
        code: 'HANDOFF_EXPIRED',
        message: 'Handoff expired',
      });
    }

    const isValid = await this.tokenService.verifyToken(
      token,
      record.tokenHash,
      record.tokenKeyVersion,
    );
    if (!isValid) {
      throw new BadRequestException({
        code: 'HANDOFF_TOKEN_INVALID',
        message: 'Invalid handoff token',
      });
    }

    const operation: ChatTelemetryOperation = record.consumedAt
      ? 'handoff_replay'
      : 'handoff_resolve';
    await this.recordTelemetry(
      operation,
      record.consumedAt ? 'replayed' : 'resolved',
      Date.now() - startedAt,
      context,
      userId,
      { outcome: record.consumedAt ? 'already_consumed' : 'resolved' },
    );

    return record;
  }

  async resolveSafe(
    token: string,
    userId: string,
    context: ChatTelemetryContext = {},
  ): Promise<ChatHandoffSafeResolveResponse> {
    const handoff: unknown = await this.resolve(token, userId, context);
    if (!isJsonRecord(handoff)) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff not found',
      });
    }

    if (handoff.consumedAt !== null && handoff.consumedAt !== undefined) {
      throw new ConflictException({
        code: 'HANDOFF_ALREADY_CONSUMED',
        message: 'Handoff already consumed',
      });
    }

    const now = new Date();
    const claimExpiresAt = isoDateValue(handoff.claimExpiresAt);
    const claimRecoverAfter = isoDateValue(handoff.claimRecoverAfter);
    if (
      (claimExpiresAt && new Date(claimExpiresAt) > now) ||
      (claimRecoverAfter && new Date(claimRecoverAfter) > now)
    ) {
      throw new ConflictException({
        code: 'HANDOFF_IN_PROGRESS',
        message: 'Handoff in progress',
      });
    }

    const flightOfferId = stringValue(handoff.flightOfferId);
    const supplierOfferIdHash = stringValue(handoff.supplierOfferIdHash);
    const expiresAt = isoDateValue(handoff.expiresAt);
    if (!flightOfferId || !supplierOfferIdHash || !expiresAt) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const flightOffer = await this.prisma.flightOffer.findUnique({
      where: { id: flightOfferId },
      select: {
        supplierOfferId: true,
        origin: true,
        destination: true,
        adults: true,
        children: true,
        infants: true,
        price: true,
        currency: true,
        rawOffer: true,
      },
    });
    if (!flightOffer) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const computedSupplierOfferIdHash = this.tokenService.hashToken(flightOffer.supplierOfferId);
    if (computedSupplierOfferIdHash !== supplierOfferIdHash) {
      throw new NotFoundException({
        code: 'HANDOFF_NOT_FOUND',
        message: 'Handoff offer unavailable',
      });
    }

    const hadOriginalPassengers =
      isJsonRecord(flightOffer.rawOffer) &&
      Array.isArray((flightOffer.rawOffer as Record<string, unknown>).passengers) &&
      ((flightOffer.rawOffer as Record<string, unknown>).passengers as unknown[]).length > 0;
    const payload = complementStoredOfferPayload(flightOffer.rawOffer, flightOffer);
    const normalizedOffer = this.flightSearchPort.normalizeStoredOffer(payload);
    if (
      !normalizedOffer ||
      !normalizedOffer.offerExpiresAt ||
      new Date(normalizedOffer.offerExpiresAt) <= new Date()
    ) {
      throw new GoneException({
        code: 'HANDOFF_OFFER_STALE',
        message: 'Handoff offer is stale',
      });
    }

    const firstSegment = normalizedOffer.segments[0];
    const lastSegment = resolveLastSegment(normalizedOffer);

    if (!firstSegment || !lastSegment) {
      throw new NotFoundException('Handoff offer unavailable');
    }

    const departureAt = firstSegment.departureTime;
    const arrivalAt = lastSegment.arrivalTime;
    if (!departureAt || !arrivalAt) {
      throw new NotFoundException('Handoff offer unavailable');
    }

    const airline =
      firstSegment.operatingCarrier ||
      normalizedOffer.airline ||
      'Unknown Airline';

    const origin = normalizedOffer.departureAirport || flightOffer.origin;
    const destination = normalizedOffer.arrivalAirport || flightOffer.destination;

    const passengers = normalizedOffer.passengers.map((p) => ({
      id: p.supplierPassengerId,
      type: p.type,
    }));

    return {
      status: 'ACTIVE',
      expiresAt,
      offer: {
        airline,
        origin,
        destination,
        departureAt,
        arrivalAt,
        price: String(flightOffer.price),
        currency: flightOffer.currency,
        adults: flightOffer.adults,
        children: flightOffer.children,
        infants: flightOffer.infants,
      },
      ...(hadOriginalPassengers && passengers.length > 0 ? { passengers } : {}),
    };
  }

  /**
   * Resolves and claims a handoff for canonical intent creation without
   * producing a durable resolve event for each losing concurrent request.
   */
  async resolveAndAcquireClaim(
    token: string,
    userId: string,
    ttlMs: number,
    context: ChatTelemetryContext = {},
  ): Promise<{ handoff: ResolvedChatHandoff; claimToken: string }> {
    const isEnabled = this.configService.get<string>('FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') === 'true';
    if (!isEnabled) {
      throw new ServiceUnavailableException({
        code: 'CHAT_HANDOFF_DISABLED',
        message: 'Chat handoff acceptance is disabled',
      });
    }

    const tokenHash = token.startsWith('chk_handoff_') ? this.tokenService.hashToken(token) : token;

    const attemptKey = `${userId}:${tokenHash}`;
    const claimedUntil = this.claimedTokens.get(attemptKey);
    if ((claimedUntil && claimedUntil > Date.now()) || this.activeClaimAttempts.has(attemptKey)) {
      throw new ConflictException({ code: 'HANDOFF_IN_PROGRESS', message: 'Handoff in progress' });
    }

    const attempt = this.resolveAndAcquireClaimOnce(tokenHash, userId, ttlMs, context);
    attempt.catch((err) =>
      this.logger.warn(
        `[resolveAndAcquireClaim] In-flight attempt failed: ${err instanceof Error ? err.message : 'unknown'}`,
      ),
    );
    this.activeClaimAttempts.set(attemptKey, attempt);
    try {
      const result = await attempt;
      this.claimedTokens.set(attemptKey, Date.now() + ttlMs);
      return result;
    } finally {
      if (this.activeClaimAttempts.get(attemptKey) === attempt) {
        this.activeClaimAttempts.delete(attemptKey);
      }
    }
  }

  private async resolveAndAcquireClaimOnce(
    tokenHash: string,
    userId: string,
    ttlMs: number,
    context: ChatTelemetryContext,
  ): Promise<{ handoff: ResolvedChatHandoff; claimToken: string }> {
    const startedAt = Date.now();
    const claimToken = crypto.randomUUID();
    const claimTokenHash = this.tokenService.hashToken(claimToken);
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttlMs);
    const claimRecoverAfter = new Date(now.getTime() + ttlMs + 5000);

    let claimed: ClaimedHandoffRow | null = null;
    try {
      const claimedRows = await this.prisma.$queryRaw<ClaimedHandoffRow[]>`
        UPDATE "chat_handoffs"
        SET "claimedAt" = ${now},
            "claimTokenHash" = ${claimTokenHash},
            "claimExpiresAt" = ${claimExpiresAt},
            "claimRecoverAfter" = ${claimRecoverAfter}
        WHERE "tokenHash" = ${tokenHash}
          AND "userId" = ${userId}
          AND "consumedAt" IS NULL
          AND "expiresAt" > ${now}
          AND ("claimRecoverAfter" IS NULL OR "claimRecoverAfter" <= ${now})
          AND EXISTS (
            SELECT 1
            FROM "chat_sessions"
            WHERE "chat_sessions"."id" = "chat_handoffs"."chatSessionId"
              AND "chat_sessions"."userId" = ${userId}
              AND "chat_sessions"."deletedAt" IS NULL
          )
        RETURNING "id", "userId", "chatSessionId", "flightOfferId", "tokenHash", "tokenKeyVersion", "expiresAt", "consumedAt"
      `;
      if (claimedRows.length > 0) {
        claimed = claimedRows[0];
      }
    } catch (error) {
      this.logger.error(
        `[resolveAndAcquireClaimOnce] chat_handoff_claim_query_failed: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      throw error;
    }

    if (!claimed) {
      void this.recordTelemetry(
        'handoff_claim_conflict',
        'conflict',
        Date.now() - startedAt,
        context,
        userId,
        { outcome: 'conflict' },
      ).catch(() => {});
      const handoffRecord = await this.prisma.chatHandoff.findFirst({
        where: { tokenHash, userId },
        include: { chatSession: { select: { deletedAt: true } } },
      });
      if (handoffRecord?.chatSession?.deletedAt) {
        throw new ConflictException({
          code: 'CHAT_SESSION_DELETED',
          message: 'Chat session was deleted',
        });
      }
      throw new ConflictException({ code: 'HANDOFF_IN_PROGRESS', message: 'Handoff in progress' });
    }

    let flightOffer = this.flightOfferCache.get(claimed.flightOfferId);
    if (!flightOffer) {
      try {
        const loadedFlightOffer = await this.prisma.flightOffer.findUnique({
          where: { id: claimed.flightOfferId },
        });
        if (loadedFlightOffer) {
          flightOffer = loadedFlightOffer;
          this.setCachedFlightOffer(claimed.flightOfferId, loadedFlightOffer);
        }
      } catch (err) {
        this.logger.warn(
          `[resolveAndAcquireClaimOnce] chat_handoff_offer_lookup_failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }

    const handoff = {
      ...claimed,
      ...(flightOffer ? { flightOffer } : {}),
      chatSession: { userId, deletedAt: null },
    } as unknown as ResolvedChatHandoff;

    this.recordTelemetry('handoff_resolve', 'resolved', Date.now() - startedAt, context, userId, {
      outcome: 'resolved',
    }).catch((err) =>
      this.logger.warn(
        `[resolveAndAcquireClaimOnce] chat_handoff_telemetry_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      ),
    );

    return { handoff, claimToken };
  }

  private async recordTelemetry(
    operation: ChatTelemetryOperation,
    status: string,
    latencyMs: number,
    context: ChatTelemetryContext,
    userId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      const event = createChatTelemetryEvent(operation, status, latencyMs, context, metadata);
      emitChatTelemetry(this.logger, event);

      if (this.auditService) {
        const auditWrite = this.auditService.createLog(null, {
          userId,
          action:
            operation === 'handoff_create'
              ? 'chat_handoff_created'
              : operation === 'handoff_resolve'
                ? 'chat_handoff_resolved'
                : operation === 'handoff_claim_conflict'
                  ? 'chat_handoff_conflict'
                  : 'chat_handoff_replay',
          resourceType: 'ChatHandoff',
          resourceId: null,
          metadata: {
            operation: event.operation,
            metric: event.metric,
            status: event.status,
            latency_ms: event.latency_ms,
            ...event.metadata,
          },
          traceId: event.trace_id,
          correlationId: event.correlation_id,
        });
        void Promise.resolve(auditWrite).catch((err) => {
          this.logger.warn(
            `[recordTelemetry] chat_handoff_telemetry_failed: ${err instanceof Error ? err.message : 'unknown'}`,
          );
        });
      }
    } catch (err) {
      // Telemetry must never change the handoff result or expose raw failures.
      this.logger.warn(
        `[recordTelemetry] chat_handoff_telemetry_failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  /**
   * Acquires a temporary claim over a handoff record to prevent concurrent checkouts.
   */
  async acquireClaim(
    handoffId: string,
    userId: string,
    ttlMs: number,
    context: ChatTelemetryContext = {},
  ): Promise<string> {
    const claimToken = await this.tryAcquireClaim(handoffId, userId, ttlMs);
    if (!claimToken) {
      void this.recordTelemetry('handoff_claim_conflict', 'conflict', 0, context, userId, {
        outcome: 'conflict',
      }).catch(() => {});
      throw new ConflictException('Failed to acquire handoff claim');
    }
    return claimToken;
  }

  private async tryAcquireClaim(
    handoffId: string,
    userId: string,
    ttlMs: number,
  ): Promise<string | null> {
    const claimToken = crypto.randomUUID();
    const claimTokenHash = this.tokenService.hashToken(claimToken);
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttlMs);
    const claimRecoverAfter = new Date(now.getTime() + ttlMs + 5000); // 5s recovery buffer

    const claimed = await this.prisma.$transaction(async (tx) => {
      const unlockedHandoffs = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "chat_handoffs"
        WHERE "id" = ${handoffId}
          AND "userId" = ${userId}
          AND "consumedAt" IS NULL
          AND "expiresAt" > ${now}
          AND ("claimRecoverAfter" IS NULL OR "claimRecoverAfter" <= ${now})
          AND EXISTS (
            SELECT 1
            FROM "chat_sessions"
            WHERE "chat_sessions"."id" = "chat_handoffs"."chatSessionId"
              AND "chat_sessions"."userId" = ${userId}
              AND "chat_sessions"."deletedAt" IS NULL
          )
        FOR UPDATE SKIP LOCKED
      `;

      if (unlockedHandoffs.length === 0) {
        return false;
      }

      const result = await tx.chatHandoff.updateMany({
        where: {
          id: handoffId,
          userId,
          consumedAt: null,
          expiresAt: { gt: now },
          OR: [{ claimRecoverAfter: null }, { claimRecoverAfter: { lte: now } }],
        },
        data: {
          claimedAt: now,
          claimTokenHash,
          claimExpiresAt,
          claimRecoverAfter,
        },
      });

      return result.count === 1;
    });

    return claimed ? claimToken : null;
  }

  /**
   * Refreshes an existing claim to extend its TTL.
   */
  async refreshClaim(handoffId: string, claimToken: string, ttlMs: number): Promise<void> {
    const claimTokenHash = this.tokenService.hashToken(claimToken);
    const now = new Date();
    const claimExpiresAt = new Date(now.getTime() + ttlMs);
    const claimRecoverAfter = new Date(now.getTime() + ttlMs + 5000);

    const result = await this.prisma.chatHandoff.updateMany({
      where: {
        id: handoffId,
        claimTokenHash,
        consumedAt: null,
        claimExpiresAt: { gt: now },
      },
      data: {
        claimExpiresAt,
        claimRecoverAfter,
      },
    });

    if (result.count === 0) {
      throw new ConflictException('Claim lost or expired');
    }
  }

  /**
   * Releases an existing claim, making the handoff available for others.
   */
  async releaseClaim(handoffId: string, claimToken: string, maxRetries = 3): Promise<void> {
    const claimTokenHash = this.tokenService.hashToken(claimToken);
    const now = new Date();

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const handoff = await this.prisma.chatHandoff.findUnique({
          where: { id: handoffId },
          select: { userId: true, tokenHash: true },
        });

        const result = await this.prisma.chatHandoff.updateMany({
          where: {
            id: handoffId,
            claimTokenHash,
            consumedAt: null,
            claimExpiresAt: { gt: now },
          },
          data: {
            claimedAt: null,
            claimTokenHash: null,
            claimExpiresAt: null,
            claimRecoverAfter: null,
          },
        });

        if (handoff && result.count > 0) {
          const attemptKey = `${handoff.userId}:${handoff.tokenHash}`;
          this.claimedTokens.delete(attemptKey);
          this.claimedTokens.delete(handoff.tokenHash);
        }
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
}
