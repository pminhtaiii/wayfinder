import { createHash, randomUUID } from 'crypto';
import {
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { FlightOffer, Prisma, PassengerType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  FLIGHT_SEARCH_PORT,
  type FlightSearchPort,
  type FlightOfferPassenger,
} from '@/supplier/search/flight-search.port';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { CreateIntentDto } from './dto/create-intent.dto';
import {
  BookingReadinessRequestDto,
  BookingReadinessResponseDto,
} from './dto/booking-readiness.dto';
import { BookingReadinessService } from './booking-readiness.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import {
  PassengerSourceResolverService,
  type PassengerSourceRequest,
  type ResolvedPassenger,
} from './passenger-source-resolver.service';
import { PassengerSnapshotService } from './passenger-snapshot.service';
import type { MaskedPassengerSummary } from './passenger-snapshot.service';
import {
  createChatTelemetryEvent,
  emitChatTelemetry,
  type ChatTelemetryOperation,
} from '@/common/observability/chat-observability';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
} from '@/common/observability/booking-readiness.metrics';
import {
  BookingIntentPrefillResponseDto,
  CreateBookingIntentResponseDto,
  GetBookingIntentResponseDto,
} from './dto/intent-response.dto';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessOperation } from '@/common/observability/booking-readiness-observability.types';

type LegacyIntentPassenger = {
  type: PassengerType;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  gender: string;
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  useProfile?: boolean;
};

type ResolvedIntentPassenger = LegacyIntentPassenger & {
  travelerProfileId?: string;
  profileRevision?: number;
};

type HandoffFastFailReservation = {
  token: string;
  reservationId: string;
};

type ClaimedHandoffForIntent = {
  id: string;
  chatSessionId: string;
  flightOfferId: string;
  flightOffer?: FlightOffer;
};

@Injectable()
export class BookingIntentService {
  private readonly logger = new Logger(BookingIntentService.name);
  private readonly flightOfferCache = new Map<string, FlightOffer>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FLIGHT_SEARCH_PORT) private readonly flightSearchPort: FlightSearchPort,
    private readonly auditService: AuditService,
    private readonly encryptionService: EncryptionService,
    @Optional() private readonly bookingReadinessService?: BookingReadinessService,
    @Optional() private readonly passengerSourceResolver?: PassengerSourceResolverService,
    @Optional() private readonly passengerSnapshotService?: PassengerSnapshotService,
    @Optional() private readonly chatHandoffService?: ChatHandoffService,
    @Optional() private readonly bookingReadinessObservability?: BookingReadinessObservability,
    @Optional() private readonly metricsService?: BookingReadinessMetricsService,
  ) {}

  async getAdvisoryReadiness(
    userId: string,
    dto: BookingReadinessRequestDto,
    context?: { traceId?: string; correlationId?: string },
  ): Promise<BookingReadinessResponseDto> {
    if (!this.bookingReadinessService) {
      throw new ServiceUnavailableException({
        code: 'FEATURE_DISABLED',
        message: 'Booking readiness service is unavailable',
      });
    }

    return this.bookingReadinessService.getAdvisoryReadiness(userId, dto, context);
  }

  async createIntent(
    userId: string,
    dto: CreateIntentDto,
    context?: {
      ipAddress?: string;
      traceId?: string;
      correlationId?: string;
      allowLegacy?: boolean;
      handoffFastFailReservation?: HandoffFastFailReservation;
    },
  ): Promise<CreateBookingIntentResponseDto> {
    const startedAt = Date.now();
    let targetFlightOfferId = dto.flightOfferId;
    let handoff: ClaimedHandoffForIntent | null = null;
    let claimToken: string | null = null;
    let claimTokenHash: string | null = null;
    let claimWatchdog: NodeJS.Timeout | null = null;
    let claimLost = false;
    const fastFailReservation = context?.handoffFastFailReservation;

    if (dto.handoffToken) {
      if (!this.chatHandoffService) {
        throw new HttpException(
          { code: 'FEATURE_DISABLED', message: 'Chat handoff is disabled' },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      const ttlMs = 30000;
      if (typeof this.chatHandoffService.resolveAndAcquireClaim === 'function') {
        const claimedHandoff = await this.chatHandoffService.resolveAndAcquireClaim(
          dto.handoffToken,
          userId,
          ttlMs,
          {
            traceId: context?.traceId,
            correlationId: context?.correlationId,
          },
        );
        handoff = claimedHandoff.handoff;
        targetFlightOfferId = handoff.flightOfferId;
        claimToken = claimedHandoff.claimToken;
        claimTokenHash = createHash('sha256').update(claimToken).digest('hex');
      } else {
        handoff = await this.chatHandoffService.resolve(dto.handoffToken, userId, {
          traceId: context?.traceId,
          correlationId: context?.correlationId,
        });
        targetFlightOfferId = handoff.flightOfferId;

        claimToken = await this.chatHandoffService.acquireClaim(handoff.id, userId, ttlMs);
        claimTokenHash = createHash('sha256').update(claimToken).digest('hex');
      }

      const claimedHandoffId = handoff.id;

      claimWatchdog = setInterval(async () => {
        try {
          if (!claimLost) {
            await this.chatHandoffService!.refreshClaim(claimedHandoffId, claimToken!, ttlMs);
          }
        } catch {
          claimLost = true;
          if (claimWatchdog) clearInterval(claimWatchdog);
        }
      }, 10000);
      claimWatchdog.unref?.();
    }

    let isSuccess = false;
    try {
      if (!targetFlightOfferId) {
        throw new HttpException(
          {
            code: 'OFFER_NOT_FOUND',
            message: 'Flight offer id or handoff token is required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      let flightOffer = handoff?.flightOffer ?? this.flightOfferCache.get(targetFlightOfferId);
      if (!flightOffer) {
        const loadedFlightOffer = await this.prisma.flightOffer.findUnique({
          where: { id: targetFlightOfferId },
        });
        if (loadedFlightOffer) {
          flightOffer = loadedFlightOffer;
          if (this.flightOfferCache.size >= 500) {
            const firstKey = this.flightOfferCache.keys().next().value;
            if (firstKey) this.flightOfferCache.delete(firstKey);
          }
          this.flightOfferCache.set(targetFlightOfferId, loadedFlightOffer);
        }
      }

      if (!flightOffer) {
        throw new HttpException(
          {
            code: 'OFFER_NOT_FOUND',
            message: 'Flight offer not found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      const canonicalPassengerCount = dto.passengers.filter(
        (passenger) => passenger.source != null,
      ).length;
      if (canonicalPassengerCount > 0 && canonicalPassengerCount < dto.passengers.length) {
        throw new HttpException(
          {
            code: 'PASSENGER_SOURCE_INVALID',
            message: 'Passenger source is invalid',
          },
          HttpStatus.BAD_REQUEST,
        );
      }
      const hasCanonicalSources = canonicalPassengerCount === dto.passengers.length;
      const allowLegacy = context?.allowLegacy !== false;

      if (!hasCanonicalSources && !allowLegacy) {
        throw new HttpException(
          {
            code: 'PASSENGER_SOURCE_INVALID',
            message: 'Canonical passenger sources are required',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (
        dto.passengers.some((passenger) => passenger.useProfile !== undefined) &&
        hasCanonicalSources
      ) {
        throw new HttpException(
          {
            code: 'PASSENGER_SOURCE_CONFLICT',
            message: 'Passenger source conflicts with legacy profile selection',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      let canonicalPassengers: ResolvedPassenger[] | null = null;
      let legacyPassengers: ResolvedIntentPassenger[] | null = null;
      if (hasCanonicalSources) {
        if (
          !this.passengerSourceResolver ||
          !this.passengerSnapshotService ||
          !this.bookingReadinessService
        ) {
          throw new HttpException(
            {
              code: 'READINESS_DEPENDENCY_UNAVAILABLE',
              message: 'Booking readiness dependencies are unavailable',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        }

        canonicalPassengers = await this.passengerSourceResolver.resolve(
          userId,
          dto.passengers.map((passenger) => ({
            offerPassengerId: passenger.offerPassengerId,
            type: passenger.type,
            source: passenger.source,
          })) as PassengerSourceRequest[],
        );
      } else {
        const legacyInputPassengers = dto.passengers as unknown as LegacyIntentPassenger[];
        if (
          legacyInputPassengers.some(
            (passenger, index) =>
              passenger.useProfile === true &&
              (index !== 0 || passenger.type !== PassengerType.ADULT),
          )
        ) {
          throw new HttpException(
            {
              code: 'LEGACY_PROFILE_SOURCE_UNSUPPORTED',
              message: 'Legacy profile selection is supported only for the primary adult',
            },
            HttpStatus.BAD_REQUEST,
          );
        }
        legacyPassengers = await this.applyPrimaryPassengerPrefill(userId, legacyInputPassengers);
      }

      const passengersForValidation = canonicalPassengers ?? legacyPassengers ?? [];
      this.validatePassengerCountAgainstOffer(passengersForValidation, {
        adults: flightOffer.adults,
        children: flightOffer.children,
        infants: flightOffer.infants,
      });

      if (claimLost) {
        throw new ConflictException({ code: 'CLAIM_LOST', message: 'Handoff claim was lost' });
      }

      const liveOfferPromise = this.fetchLiveOffer(flightOffer.supplierOfferId, 25000);
      const readinessPromise = canonicalPassengers
        ? this.bookingReadinessService!.evaluateAuthoritativeReadiness(
            flightOffer.rawOffer,
            canonicalPassengers,
            {
              traceId: context?.traceId,
              correlationId: context?.correlationId,
            },
            flightOffer,
          )
        : Promise.resolve(null);

      const [liveOffer, authoritativeReadiness] = await Promise.all([
        liveOfferPromise,
        readinessPromise,
      ]);

      if (authoritativeReadiness && !authoritativeReadiness.ready) {
        this.metricsService?.increment(
          BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_AUTHORITATIVE_REJECTIONS,
        );
        throw new HttpException(
          {
            code: 'BOOKING_NOT_READY',
            message: 'Booking is not ready',
            ...authoritativeReadiness,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      const confirmedPrice = Number(liveOffer.totalAmount);
      const originalPrice = Number(flightOffer.price);
      const now = new Date();
      const parsedTtl = Number(process.env.BOOKING_INTENT_TTL_MINUTES);
      const ttlMinutes =
        isNaN(parsedTtl) || !process.env.BOOKING_INTENT_TTL_MINUTES ? 30 : parsedTtl;
      const intentExpiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);

      const supplierPassengerIds = this.extractSupplierPassengerIds(
        liveOffer.passengers,
        passengersForValidation,
      );

      const canonicalSnapshotPassengers = canonicalPassengers?.map((passenger, index) => ({
        ...passenger,
        supplierPassengerId: supplierPassengerIds[index],
        position: index,
      }));

      const readinessScope = authoritativeReadiness
        ? authoritativeReadiness.scope === 'INTERNATIONAL'
          ? 'INTERNATIONAL'
          : 'DOMESTIC'
        : 'DOMESTIC';

      let maskedPassengers: MaskedPassengerSummary[] | null = null;
      const intentId = randomUUID();
      const snapshotData = canonicalSnapshotPassengers
        ? this.passengerSnapshotService!.buildSnapshotData({
            intentId,
            passengers: canonicalSnapshotPassengers,
            scope: readinessScope,
          })
        : null;
      maskedPassengers = snapshotData?.maskedPassengers ?? null;

      const created = await this.prisma.$transaction(
        async (tx) => {
          if (canonicalPassengers && canonicalPassengers.some((p) => p.travelerProfileId)) {
            await this.assertCanonicalProfileRevisions(tx, userId, canonicalPassengers);
          }

          const intent = await tx.bookingIntent.create({
            data: {
              id: intentId,
              userId,
              flightOfferId: flightOffer.id,
              supplierOfferId: flightOffer.supplierOfferId,
              originalPrice: flightOffer.price,
              confirmedPrice: new Prisma.Decimal(confirmedPrice),
              currency: liveOffer.currency,
              priceChanged: originalPrice !== confirmedPrice,
              pricedAt: now,
              origin: flightOffer.origin,
              destination: flightOffer.destination,
              departureDate: flightOffer.departureDate,
              returnDate: flightOffer.returnDate,
              cabinClass: flightOffer.cabinClass,
              adults: flightOffer.adults,
              children: flightOffer.children,
              infants: flightOffer.infants,
              rawOfferSnapshot: this.toInputJsonValue(liveOffer.raw),
              intentExpiresAt,
              offerExpiresAt: liveOffer.offerExpiresAt,
            },
          });

          const createPassengersPromise = snapshotData
            ? (async () => {
                if (tx.bookingIntentPassenger.createMany) {
                  await tx.bookingIntentPassenger.createMany({
                    data: snapshotData.persistenceInput,
                  });
                  return snapshotData.persistenceInput.map((input, index) => ({
                    id: `p_${intent.id}_${index}`,
                    ...input,
                  }));
                }
                return Promise.all(
                  snapshotData.persistenceInput.map((data) =>
                    tx.bookingIntentPassenger.create({ data }),
                  ),
                );
              })()
            : Promise.all(
                (legacyPassengers ?? []).map((passenger, index) =>
                  tx.bookingIntentPassenger.create({
                    data: {
                      intentId: intent.id,
                      position: index,
                      type: passenger.type,
                      givenName: passenger.givenName,
                      familyName: passenger.familyName,
                      dateOfBirth: this.asDate(passenger.dateOfBirth),
                      gender: passenger.gender.toLowerCase(),
                      nationality: passenger.nationality
                        ? passenger.nationality.toUpperCase()
                        : null,
                      passportNumber: passenger.passportNumber
                        ? this.encryptionService.encrypt(passenger.passportNumber)
                        : null,
                      passportExpiry: passenger.passportExpiry
                        ? this.encryptionService.encrypt(passenger.passportExpiry)
                        : null,
                      travelerProfileId: passenger.travelerProfileId || null,
                      supplierPassengerId: supplierPassengerIds[index],
                    },
                  }),
                ),
              );

          const updateHandoffPromise = (async () => {
            if (handoff && claimTokenHash) {
              if (claimLost) {
                try {
                  const conflictEvent = createChatTelemetryEvent(
                    'handoff_claim_conflict',
                    'conflict',
                    Date.now() - startedAt,
                    { traceId: context?.traceId, correlationId: context?.correlationId },
                    { outcome: 'conflict' },
                  );
                  emitChatTelemetry(this.logger, conflictEvent);
                } catch (_) {}
                throw new ConflictException({
                  code: 'CLAIM_LOST',
                  message: 'Handoff claim was lost',
                });
              }

              const updateResult = await tx.chatHandoff.updateMany({
                where: {
                  id: handoff.id,
                  userId,
                  chatSessionId: handoff.chatSessionId,
                  claimTokenHash: claimTokenHash,
                  consumedAt: null,
                  claimExpiresAt: { gt: new Date() },
                  expiresAt: { gt: new Date() },
                  chatSession: {
                    userId,
                    deletedAt: null,
                  },
                },
                data: {
                  consumedAt: new Date(),
                  consumedByBookingIntentId: intent.id,
                  updatedAt: new Date(),
                },
              });

              if (updateResult.count === 0) {
                try {
                  const conflictEvent = createChatTelemetryEvent(
                    'handoff_claim_conflict',
                    'conflict',
                    Date.now() - startedAt,
                    { traceId: context?.traceId, correlationId: context?.correlationId },
                    { outcome: 'conflict' },
                  );
                  emitChatTelemetry(this.logger, conflictEvent);
                } catch (_) {}
                throw new ConflictException('Claim lost or expired before completion');
              }
            }
          })();

          const [passengers] = await Promise.all([createPassengersPromise, updateHandoffPromise]);

          const telemetryOperation: ChatTelemetryOperation = handoff
            ? 'handoff_consume'
            : 'intent_create';
          const telemetryEvent = createChatTelemetryEvent(
            telemetryOperation,
            'created',
            Date.now() - startedAt,
            {
              traceId: context?.traceId,
              correlationId: context?.correlationId,
            },
            {
              outcome: handoff ? 'consumed' : 'created',
              price_changed: originalPrice !== confirmedPrice,
            },
          );
          if (this.auditService) {
            await this.auditService.createLog(tx, {
              userId,
              action: handoff ? 'chat_handoff_consumed' : 'booking_intent_created',
              resourceType: handoff ? 'ChatHandoff' : 'BookingIntent',
              resourceId: handoff ? null : intent.id,
              ipAddress: context?.ipAddress,
              traceId: telemetryEvent.trace_id,
              correlationId: telemetryEvent.correlation_id,
              metadata: {
                operation: telemetryEvent.operation,
                metric: telemetryEvent.metric,
                status: telemetryEvent.status,
                latency_ms: telemetryEvent.latency_ms,
                ...telemetryEvent.metadata,
              },
            });
          }

          return { intent, passengers, maskedPassengers, telemetryEvent };
        },
        {
          maxWait: 10000,
          timeout: 15000,
        },
      );

      try {
        emitChatTelemetry(this.logger, created.telemetryEvent);
      } catch {
        try {
          this.logger.warn('Chat telemetry emission failed');
        } catch (_) {
          // Swallow error to prevent crash if logger sink throws
        }
      }

      if (this.bookingReadinessObservability) {
        try {
          this.bookingReadinessObservability.recordOutcome({
            operation: BookingReadinessOperation.INTENT_CREATE,
            status: 'created',
            latencyMs: Date.now() - startedAt,
            metadata: {
              scope: readinessScope,
              passengerCount: (canonicalPassengers ?? legacyPassengers ?? []).length,
              status: 'created',
            },
            context: {
              traceId: context?.traceId,
              correlationId: context?.correlationId,
            },
          });
        } catch {
          try {
            this.logger.warn('Booking readiness observability emission failed');
          } catch (_) {
            // Swallow error to prevent crash if logger sink throws
          }
        }
      }

      isSuccess = true;
      this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_CREATIONS);
      return {
        intentId: created.intent.id,
        status: created.intent.status,
        originalPrice,
        confirmedPrice,
        priceChanged: created.intent.priceChanged,
        currency: created.intent.currency,
        pricedAt: created.intent.pricedAt.toISOString(),
        intentExpiresAt: created.intent.intentExpiresAt.toISOString(),
        offerExpiresAt: created.intent.offerExpiresAt
          ? created.intent.offerExpiresAt.toISOString()
          : null,
        passengers: (
          created.maskedPassengers ??
          created.passengers
            .sort((a, b) => a.position - b.position)
            .map((passenger, index) => this.toSafePassengerSummary(passenger, index))
        ).map((passenger, index) => ({
          ...passenger,
          id: created.passengers[index]?.id ?? `${created.intent.id}-${passenger.passengerOrdinal}`,
          passportNumber: null,
          passportExpiry: null,
        })),
        flight: {
          origin: created.intent.origin,
          destination: created.intent.destination,
          departureDate: this.toDateOnly(created.intent.departureDate),
          returnDate: created.intent.returnDate ? this.toDateOnly(created.intent.returnDate) : null,
          cabinClass: created.intent.cabinClass,
        },
      };
    } finally {
      if (claimWatchdog) clearInterval(claimWatchdog);
      if (fastFailReservation && this.chatHandoffService) {
        this.chatHandoffService.releaseInFlight(
          fastFailReservation.token,
          userId,
          fastFailReservation.reservationId,
        );
      }
      if (!isSuccess && handoff && claimToken && this.chatHandoffService) {
        try {
          await this.chatHandoffService.releaseClaim(handoff.id, claimToken);
        } catch {
          this.logger.error('chat_handoff_claim_release_failed');
        }
      }
    }
  }

  async getIntent(userId: string, intentId: string): Promise<GetBookingIntentResponseDto> {
    const intent = await this.prisma.bookingIntent.findUnique({
      where: { id: intentId },
      include: {
        passengers: {
          orderBy: {
            position: 'asc',
          },
        },
      },
    });

    if (!intent) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Booking intent not found',
      });
    }

    if (intent.userId !== userId) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'You do not have access to this booking intent',
      });
    }

    if (intent.status === 'EXPIRED') {
      throw new GoneException({
        code: 'INTENT_EXPIRED',
        message: 'This booking intent has expired',
      });
    }

    return {
      intentId: intent.id,
      status: intent.status,
      originalPrice: Number(intent.originalPrice),
      confirmedPrice: Number(intent.confirmedPrice),
      priceChanged: intent.priceChanged,
      currency: intent.currency,
      pricedAt: intent.pricedAt.toISOString(),
      intentExpiresAt: intent.intentExpiresAt.toISOString(),
      offerExpiresAt: intent.offerExpiresAt ? intent.offerExpiresAt.toISOString() : null,
      createdAt: intent.createdAt.toISOString(),
      passengers: intent.passengers.map((passenger, index) => ({
        ...this.toSafePassengerSummary(
          {
            ...passenger,
            intentId: passenger.intentId ?? intent.id,
          },
          index,
        ),
        type: passenger.type,
        givenName: passenger.givenName,
        familyName: passenger.familyName,
        gender: passenger.gender,
        nationality: passenger.nationality,
        passportNumber: null,
        passportExpiry: null,
      })),
      flight: {
        origin: intent.origin,
        destination: intent.destination,
        departureDate: this.toDateOnly(intent.departureDate),
        returnDate: intent.returnDate ? this.toDateOnly(intent.returnDate) : null,
        cabinClass: intent.cabinClass,
        adults: intent.adults,
        children: intent.children,
        infants: intent.infants,
      },
    };
  }

  async getPrefill(userId: string): Promise<BookingIntentPrefillResponseDto> {
    const profile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
      select: {
        seatPreference: true,
        classPreference: true,
        nationality: true,
        passportNumber: true,
        passportExpiry: true,
      },
    });

    if (!profile) {
      return {
        hasProfile: false,
        passenger: null,
        missingFields: [],
      };
    }

    const passportNumber = this.decryptProfileField(profile.passportNumber);
    const passportExpiry = profile.passportExpiry ? this.toDateOnly(profile.passportExpiry) : null;

    const passenger = {
      givenName: null,
      familyName: null,
      dateOfBirth: null,
      gender: null,
      nationality: profile.nationality || null,
      passportNumber,
      passportExpiry,
      seatPreference: profile.seatPreference || null,
      classPreference: profile.classPreference || null,
    };

    const missingFields = Object.entries(passenger)
      .filter((entry) => {
        const [key, value] = entry;
        if (key === 'seatPreference' || key === 'classPreference') {
          return false;
        }
        return value === null;
      })
      .map(([key]) => key);

    return {
      hasProfile: true,
      passenger,
      missingFields,
    };
  }

  private async applyPrimaryPassengerPrefill(
    userId: string,
    passengers: LegacyIntentPassenger[],
  ): Promise<ResolvedIntentPassenger[]> {
    const merged: ResolvedIntentPassenger[] = passengers.map((passenger) => ({ ...passenger }));

    if (
      merged.length === 0 ||
      merged[0].type !== PassengerType.ADULT ||
      merged[0].useProfile !== true
    ) {
      return merged;
    }

    const profile = await this.prisma.travelerProfile.findUnique({
      where: { userId },
      select: {
        id: true,
        nationality: true,
        passportNumber: true,
        passportExpiry: true,
      },
    });

    if (!profile) {
      return merged;
    }

    const primary = merged[0];
    const resolvedPassport = this.decryptProfileField(profile.passportNumber);
    const resolvedPassportExpiry = profile.passportExpiry
      ? this.toDateOnly(profile.passportExpiry)
      : null;

    merged[0] = {
      ...primary,
      nationality: (primary.nationality || profile.nationality || undefined)?.toUpperCase(),
      passportNumber: primary.passportNumber || resolvedPassport || undefined,
      passportExpiry: primary.passportExpiry || resolvedPassportExpiry || undefined,
      travelerProfileId: profile.id,
    };

    return merged;
  }

  private validatePassengerCountAgainstOffer(
    passengers: readonly { type: PassengerType }[],
    offerBreakdown: { adults: number; children: number; infants: number },
  ): void {
    const counts = passengers.reduce(
      (acc, passenger) => {
        if (passenger.type === PassengerType.ADULT) acc.adults += 1;
        if (passenger.type === PassengerType.CHILD) acc.children += 1;
        if (passenger.type === PassengerType.INFANT) acc.infants += 1;
        return acc;
      },
      { adults: 0, children: 0, infants: 0 },
    );

    if (
      counts.adults !== offerBreakdown.adults ||
      counts.children !== offerBreakdown.children ||
      counts.infants !== offerBreakdown.infants
    ) {
      throw new HttpException(
        {
          code: 'PASSENGER_COUNT_MISMATCH',
          message: 'Passenger details count must match the declared passenger breakdown',
        },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private async assertCanonicalProfileRevisions(
    tx: Prisma.TransactionClient,
    userId: string,
    passengers: readonly ResolvedPassenger[],
  ): Promise<void> {
    const checkedProfiles = new Set<string>();

    for (const passenger of passengers) {
      if (
        !passenger.travelerProfileId ||
        passenger.profileRevision === null ||
        passenger.profileRevision === undefined ||
        checkedProfiles.has(passenger.travelerProfileId)
      ) {
        continue;
      }

      checkedProfiles.add(passenger.travelerProfileId);
      const currentProfile = await tx.travelerProfile.findFirst({
        where: { id: passenger.travelerProfileId, userId },
        select: { revision: true },
      });

      if (!currentProfile || currentProfile.revision !== passenger.profileRevision) {
        throw new ConflictException({
          code: 'PROFILE_CHANGED',
          message: 'Traveler profile changed',
        });
      }
    }
  }

  private async fetchLiveOffer(
    duffelOfferId: string,
    timeoutMs: number = 4500,
  ): Promise<{
    totalAmount: string;
    currency: string;
    offerExpiresAt: Date | null;
    raw: unknown;
    passengers: readonly FlightOfferPassenger[];
  }> {
    let supplierRequestPending = true;
    try {
      const offer = await this.flightSearchPort.getOfferById(duffelOfferId, timeoutMs);
      supplierRequestPending = false;

      if (
        !offer ||
        !offer.totalAmount ||
        typeof offer.totalAmount !== 'string' ||
        isNaN(Number(offer.totalAmount)) ||
        Number(offer.totalAmount) <= 0
      ) {
        throw new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      return {
        totalAmount: offer.totalAmount,
        currency: offer.currency || 'USD',
        offerExpiresAt: offer.offerExpiresAt ? new Date(offer.offerExpiresAt) : null,
        raw: offer.rawSupplierPayload,
        passengers: offer.passengers ?? [],
      };
    } catch (error: unknown) {
      if (
        error instanceof HttpException &&
        typeof error.getResponse() === 'object' &&
        error.getResponse() !== null &&
        'code' in (error.getResponse() as Record<string, unknown>)
      ) {
        const res = error.getResponse() as Record<string, unknown>;
        if (
          res.code === 'UPSTREAM_UNAVAILABLE' ||
          res.code === 'UPSTREAM_TIMEOUT' ||
          res.code === 'OFFER_EXPIRED' ||
          res.code === 'UPSTREAM_RATE_LIMITED'
        ) {
          throw error;
        }
      }

      const status =
        error instanceof HttpException
          ? error.getStatus()
          : typeof (error as Record<string, unknown>)?.status === 'number'
          ? (error as { status: number }).status
          : typeof (error as Record<string, unknown>)?.statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : undefined;

      const message =
        error instanceof Error
          ? error.message
          : typeof (error as Record<string, unknown>)?.message === 'string'
          ? (error as { message: string }).message
          : '';

      const name = error instanceof Error ? error.name : '';

      const isTimeout =
        status === 504 ||
        name.toLowerCase().includes('timeout') ||
        message.toLowerCase().includes('timeout') ||
        message.toLowerCase().includes('timed out') ||
        (error as Record<string, unknown>)?.code === 'DUFFEL_TIMEOUT';

      if (isTimeout) {
        throw new HttpException(
          {
            code: 'UPSTREAM_TIMEOUT',
            message: 'Timed out while confirming live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }

      const supplierCode = (error as Record<string, unknown>)?.code;
      const isExpired =
        status === 404 ||
        status === 410 ||
        supplierCode === 'OFFER_EXPIRED' ||
        supplierCode === 'offer_expired' ||
        supplierCode === 'not_found' ||
        (supplierRequestPending && /not found|expired|gone|no longer available/i.test(message));

      if (isExpired) {
        throw new HttpException(
          {
            code: 'OFFER_EXPIRED',
            message: 'Offer no longer available',
          },
          HttpStatus.GONE,
        );
      }

      if (status === 429) {
        throw new HttpException(
          {
            code: 'UPSTREAM_RATE_LIMITED',
            message: 'API rate limit exceeded',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof HttpException) {
        throw error;
      }

      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message: 'Failed to confirm live offer pricing',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private extractSupplierPassengerIds(
    supplierPassengers: readonly FlightOfferPassenger[],
    passengers: readonly { type: PassengerType }[],
  ): string[] {
    const remaining = supplierPassengers.map((passenger) => {
      if (
        !passenger ||
        typeof passenger !== 'object' ||
        typeof passenger.supplierPassengerId !== 'string' ||
        passenger.supplierPassengerId.length === 0 ||
        (passenger.type !== 'ADULT' && passenger.type !== 'CHILD' && passenger.type !== 'INFANT')
      ) {
        return null;
      }
      return { id: passenger.supplierPassengerId, type: passenger.type };
    });

    if (remaining.some((passenger) => passenger === null)) {
      throw new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Offer passenger identities are unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }

    const validSupplierPassengers = remaining.filter((passenger) => passenger !== null);
    const mappedPassengerIds: string[] = [];
    for (const passenger of passengers) {
      const index = validSupplierPassengers.findIndex(
        (supplier) => supplier.type === passenger.type,
      );
      if (index < 0) {
        throw new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Offer passenger identities do not match the booking intent',
          },
          HttpStatus.BAD_GATEWAY,
        );
      }
      mappedPassengerIds.push(validSupplierPassengers.splice(index, 1)[0].id);
    }

    return mappedPassengerIds;
  }

  async expireExpiredIntents(now: Date = new Date()): Promise<{ expiredCount: number }> {
    const updateResult = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bookingIntent.updateMany({
        where: {
          status: 'PENDING',
          intentExpiresAt: {
            lt: now,
          },
        },
        data: {
          status: 'EXPIRED',
        },
      });

      if (result.count > 0) {
        await this.auditService.createLog(tx, {
          userId: null,
          action: 'booking_intent_expired',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: result.count,
          },
        });
      }

      return result;
    });

    return { expiredCount: updateResult.count };
  }

  async deleteExpiredIntents(now: Date = new Date()): Promise<{ deletedCount: number }> {
    const rawGrace = process.env.BOOKING_INTENT_GRACE_HOURS;
    let graceHours = 24;
    if (rawGrace !== undefined && rawGrace !== null && rawGrace !== '') {
      const parsedGrace = Number(rawGrace);
      if (Number.isFinite(parsedGrace) && parsedGrace > 0) {
        graceHours = parsedGrace;
      }
    }
    const cutoff = new Date(now.getTime() - graceHours * 60 * 60 * 1000);

    const deleteResult = await this.prisma.$transaction(async (tx) => {
      const result = await tx.bookingIntent.deleteMany({
        where: {
          status: 'EXPIRED',
          updatedAt: {
            lt: cutoff,
          },
        },
      });

      if (result.count > 0) {
        await this.auditService.createLog(tx, {
          userId: null,
          action: 'booking_intent_deleted',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: result.count,
          },
        });
      }

      return result;
    });

    return { deletedCount: deleteResult.count };
  }

  private toSafePassengerSummary(
    passenger: {
      id: string;
      position?: number;
      snapshotVersion?: number;
      intentId?: string;
      type: PassengerType;
      givenName: string;
      familyName: string;
      documentType?: string | null;
      issuingCountry?: string | null;
      passportNumber?: string | null;
      passportExpiry?: string | null;
      email?: string | null;
      phoneCountryCode?: string | null;
      phoneNumber?: string | null;
      travelerProfileId?: string | null;
    },
    fallbackPosition = 0,
  ): MaskedPassengerSummary & { id: string } {
    const passengerOrdinal = Number.isFinite(passenger.position)
      ? (passenger.position as number) + 1
      : fallbackPosition + 1;

    const hasPassport = Boolean(passenger.passportNumber || passenger.passportExpiry);
    const maskedPassportSummary = this.maskPassportSummary(passenger, fallbackPosition);
    const emailMasked = this.maskEmail(passenger.email ?? null);
    const phoneMasked = this.maskPhone(
      passenger.phoneCountryCode ?? null,
      passenger.phoneNumber ?? null,
    );
    const maskedContactSummary =
      [emailMasked, phoneMasked].filter(Boolean).join(' ').trim() || null;

    return {
      id: passenger.id,
      passengerType: passenger.type,
      passengerOrdinal,
      nameSummary: `${this.maskName(passenger.givenName)} ${this.maskName(passenger.familyName)}`,
      documentSummary: {
        documentType: passenger.documentType ?? null,
        issuingCountry: passenger.issuingCountry ?? null,
        hasPassport,
        maskedPassportSummary,
      },
      contactSummary: {
        email: emailMasked,
        phone: phoneMasked,
        maskedContactSummary,
      },
      preFilledFromProfile:
        passenger.travelerProfileId !== null && passenger.travelerProfileId !== undefined,
      maskedPassportSummary,
      maskedContactSummary,
    };
  }

  private maskPassportSummary(
    passenger: {
      passportNumber?: string | null;
      passportExpiry?: string | null;
      intentId?: string | null;
      position?: number | null;
      snapshotVersion?: number | null;
    },
    fallbackPosition = 0,
  ): string | null {
    if (!passenger.passportNumber && !passenger.passportExpiry) {
      return null;
    }
    if (passenger.passportNumber) {
      try {
        const position =
          typeof passenger.position === 'number' ? passenger.position : fallbackPosition;
        const snapshotVersion =
          typeof passenger.snapshotVersion === 'number' ? passenger.snapshotVersion : 1;
        const intentId = passenger.intentId;
        if (intentId) {
          const decrypted = this.encryptionService.decryptBound(passenger.passportNumber, {
            snapshotVersion,
            intentId,
            position,
            fieldName: 'passportNumber',
          });
          return '•••• ' + decrypted.slice(-4);
        }
        const decrypted = this.encryptionService.decrypt(passenger.passportNumber);
        return '•••• ' + decrypted.slice(-4);
      } catch {
        if (!passenger.passportNumber.includes(':')) {
          return '•••• ' + passenger.passportNumber.slice(-4);
        }
        return '•••• ••••';
      }
    }
    return '•••• ••••';
  }

  private maskName(value: string): string {
    return value.length > 0 ? `${value[0]}•••` : '•••';
  }

  private maskEmail(value: string | null): string | null {
    if (!value) return null;
    const at = value.indexOf('@');
    return at > 0 ? `${value[0]}•••${value.slice(at)}` : '•••';
  }

  private maskPhone(countryCode: string | null, value: string | null): string | null {
    if (!value) return null;
    return `${countryCode ?? ''}••••${value.slice(-2)}`;
  }

  private decryptProfileField(value: string | null): string | null {
    if (!value) {
      return null;
    }

    // TravelerProfile rows can contain either plaintext legacy values or encrypted payloads.
    const marker = 'v1:';
    if (!value.startsWith(marker)) {
      return value;
    }

    try {
      const encryptedValue = value.substring(marker.length);
      return this.encryptionService.decrypt(encryptedValue);
    } catch {
      return null;
    }
  }

  private asDate(input: string): Date {
    return new Date(`${input}T00:00:00.000Z`);
  }

  private toDateOnly(input: Date): string {
    return input.toISOString().slice(0, 10);
  }

  private toInputJsonValue(value: unknown): Prisma.InputJsonValue {
    // Prisma InputJsonValue requires JSON-serializable values, so we normalize unknown data.
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  }
}
