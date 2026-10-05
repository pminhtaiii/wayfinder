import { HttpException, HttpStatus, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassengerType } from '@prisma/client';
import { AirportsService } from '@/airports/airports.service';
import { ProfileService } from '@/profile/profile.service';
import { PrismaService } from '@/prisma/prisma.service';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
} from '@/common/observability/booking-readiness.metrics';
import {
  BookingReadinessInlineSourceDto,
  BookingReadinessPassengerDto,
  BookingReadinessRequestDto,
  BookingReadinessResponseDto,
  BookingReadinessTravelerProfileSourceDto,
} from './dto/booking-readiness.dto';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { FLIGHT_SEARCH_PORT, type FlightSearchPort } from '@/supplier/search/flight-search.port';
import { complementStoredOfferPayload } from '@/supplier/search/stored-offer-payload.helper';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessOperation } from '../common/observability/booking-readiness-observability.types';
import { parseBookingReadinessConfig } from './booking-readiness.config';
import { BookingReadinessEvaluator } from './booking-readiness.evaluator';
import type {
  BookingReadinessEvaluationInput,
  BookingReadinessPassengerInput,
  BookingReadinessSegmentInput,
} from './booking-readiness.types';
import type { ResolvedPassenger } from './passenger-source-resolver.service';

type ReadinessContext = {
  traceId?: string;
  correlationId?: string;
};

type RawRecord = Record<string, unknown>;

export type StoredOfferPassenger = {
  id: string;
  type: PassengerType;
};

export type NormalizedOffer = {
  passengers: StoredOfferPassenger[];
  segments: BookingReadinessSegmentInput[];
  airportCodes: string[];
  tripCompletionDate: string;
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpError(code: string, message: string, status: HttpStatus): HttpException {
  return new HttpException({ code, message }, status);
}

function currentDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

function profilePassenger(
  source: BookingReadinessTravelerProfileSourceDto,
  profile: RawRecord,
  passenger: BookingReadinessPassengerDto,
  passengerOrdinal: number,
): BookingReadinessPassengerInput {
  const identity = isRecord(profile.identity) ? profile.identity : null;
  const contact = isRecord(profile.contact) ? profile.contact : null;
  const travelDocument = isRecord(profile.travelDocument) ? profile.travelDocument : null;
  const revision =
    typeof profile.revision === 'number' && Number.isInteger(profile.revision)
      ? profile.revision
      : null;

  return {
    passengerType: passenger.passengerType,
    passengerOrdinal,
    profileRevision: revision,
    givenName: typeof identity?.givenName === 'string' ? identity.givenName : null,
    middleName: typeof identity?.middleName === 'string' ? identity.middleName : null,
    familyName: typeof identity?.familyName === 'string' ? identity.familyName : null,
    dateOfBirth: typeof identity?.dateOfBirth === 'string' ? identity.dateOfBirth : null,
    gender: typeof identity?.gender === 'string' ? identity.gender : null,
    title: typeof identity?.title === 'string' ? identity.title : null,
    email: typeof contact?.email === 'string' ? contact.email : null,
    phoneCountryCode:
      typeof contact?.phoneCountryCode === 'string' ? contact.phoneCountryCode : null,
    phoneNumber: typeof contact?.phoneNumber === 'string' ? contact.phoneNumber : null,
    documentType:
      typeof travelDocument?.documentType === 'string' ? travelDocument.documentType : null,
    passportNumber:
      typeof travelDocument?.passportNumber === 'string' ? travelDocument.passportNumber : null,
    passportExpiry:
      typeof travelDocument?.passportExpiry === 'string' ? travelDocument.passportExpiry : null,
    issuingCountry:
      typeof travelDocument?.issuingCountry === 'string' ? travelDocument.issuingCountry : null,
    nationality:
      typeof travelDocument?.nationality === 'string' ? travelDocument.nationality : null,
  };
}

function inlinePassenger(
  source: BookingReadinessInlineSourceDto,
  passenger: BookingReadinessPassengerDto,
  passengerOrdinal: number,
): BookingReadinessPassengerInput {
  return {
    passengerType: passenger.passengerType,
    passengerOrdinal,
    profileRevision: null,
    givenName: source.givenName,
    middleName: source.middleName,
    familyName: source.familyName,
    dateOfBirth: source.dateOfBirth,
    gender: source.gender,
    title: source.title,
    email: source.email,
    phoneCountryCode: source.phoneCountryCode,
    phoneNumber: source.phoneNumber,
    documentType: source.documentType,
    passportNumber: source.passportNumber,
    passportExpiry: source.passportExpiry,
    issuingCountry: source.issuingCountry,
    nationality: source.nationality,
  };
}

@Injectable()
export class BookingReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profileService: ProfileService,
    private readonly airportsService: AirportsService,
    private readonly bookingReadinessEvaluator: BookingReadinessEvaluator,
    private readonly bookingReadinessObservability: BookingReadinessObservability,
    private readonly configService: ConfigService,
    private readonly chatHandoffService: ChatHandoffService,
    @Inject(FLIGHT_SEARCH_PORT) private readonly flightSearchPort: FlightSearchPort,
    @Optional() private readonly metricsService?: BookingReadinessMetricsService,
  ) {}

  async getAdvisoryReadiness(
    userId: string,
    dto: BookingReadinessRequestDto,
    context?: ReadinessContext,
  ): Promise<BookingReadinessResponseDto> {
    const startedAt = Date.now();
    this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS);
    this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_EVALUATIONS);

    try {
      this.assertFeatureEnabled();

      let flightOfferId = dto.flightOfferId;
      if (dto.handoffToken) {
        const handoff = await this.chatHandoffService.resolve(dto.handoffToken, userId);
        flightOfferId = handoff.flightOfferId;
      }

      const flightOffer = await this.prisma.flightOffer.findUnique({
        where: { id: flightOfferId },
      });

      if (!flightOffer) {
        throw httpError('OFFER_NOT_FOUND', 'Flight offer not found', HttpStatus.NOT_FOUND);
      }

      this.assertOfferNotExpired(flightOffer.rawOffer, flightOffer);
      const normalizedOffer = this.normalizeStoredOffer(flightOffer.rawOffer, flightOffer);
      this.validatePassengerMappings(dto.passengers, normalizedOffer.passengers);

      const passengers = await this.resolvePassengers(
        dto.passengers,
        normalizedOffer.passengers,
        userId,
      );
      const countries = await this.airportsService.findCountriesByIataCodes(
        normalizedOffer.airportCodes,
      );
      if (!(countries instanceof Map)) {
        throw new Error('Airport country lookup returned an invalid result');
      }

      const configValue = this.configService.get<string>('PASSPORT_ADVISORY_BUFFER_DAYS');
      const readinessConfig = parseBookingReadinessConfig({
        PASSPORT_ADVISORY_BUFFER_DAYS: configValue,
      });
      const evaluationInput: BookingReadinessEvaluationInput = {
        passengers,
        segments: normalizedOffer.segments.map((segment) => ({
          ...segment,
          originCountryCode: segment.originCountryCode
            ? (countries.get(segment.originCountryCode) ?? null)
            : null,
          destinationCountryCode: segment.destinationCountryCode
            ? (countries.get(segment.destinationCountryCode) ?? null)
            : null,
        })),
        tripCompletionDate: normalizedOffer.tripCompletionDate,
        supportedDocumentTypes: ['passport'],
        advisoryBufferDays: readinessConfig.passportAdvisoryBufferDays,
        currentDate: currentDateOnly(),
        entryEligibility: {
          include: true,
          result: {
            status: 'unknown',
            reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
            blocking: false,
          },
        },
      };

      const result = this.bookingReadinessEvaluator.evaluate(evaluationInput);
      this.recordOutcome(
        {
          status: result.ready ? 'ready' : 'not_ready',
          metadata: {
            scope: result.scope,
            passengerCount: result.passengers.length,
          },
        },
        context,
        startedAt,
      );

      return result;
    } catch (error) {
      const mappedError = this.mapError(error);
      this.recordOutcome(
        {
          status: this.errorCode(mappedError),
          error: mappedError.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
          metadata: { reasonCode: this.errorCode(mappedError) },
        },
        context,
        startedAt,
      );
      throw mappedError;
    }
  }

  /**
   * Runs the same deterministic evaluator used by the advisory endpoint after
   * the authoritative create flow has resolved every passenger source. This
   * method performs no persistence and intentionally accepts only server-owned
   * offer data plus detached passenger values.
   */
  async evaluateAuthoritativeReadiness(
    rawOffer: unknown,
    passengers: readonly ResolvedPassenger[],
    context?: ReadinessContext,
    flightOffer?: {
      supplierOfferId?: string | null;
      price?: unknown;
      currency?: string | null;
      departureDate?: Date | string | null;
      adults?: number | null;
      children?: number | null;
      infants?: number | null;
    } | null,
  ): Promise<BookingReadinessResponseDto> {
    const startedAt = Date.now();
    this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS);
    this.metricsService?.increment(BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_EVALUATIONS);

    try {
      this.assertFeatureEnabled();
      const normalizedOffer = this.normalizeStoredOffer(rawOffer, flightOffer);
      const storedById = new Map(
        normalizedOffer.passengers.map((passenger) => [passenger.id, passenger]),
      );

      const evaluationPassengers: BookingReadinessPassengerInput[] = passengers.map((passenger) => {
        const storedPassenger = storedById.get(passenger.offerPassengerId);
        if (!storedPassenger || storedPassenger.type !== passenger.type) {
          throw httpError(
            'PASSENGER_MAPPING_INVALID',
            'Passenger mapping is invalid',
            HttpStatus.UNPROCESSABLE_ENTITY,
          );
        }

        return {
          passengerType: passenger.type,
          passengerOrdinal:
            normalizedOffer.passengers.findIndex((item) => item.id === passenger.offerPassengerId) +
            1,
          profileRevision: passenger.profileRevision,
          givenName: passenger.givenName,
          middleName: passenger.middleName,
          familyName: passenger.familyName,
          dateOfBirth: passenger.dateOfBirth,
          gender: passenger.gender,
          title: passenger.title,
          email: passenger.email,
          phoneCountryCode: passenger.phoneCountryCode,
          phoneNumber: passenger.phoneNumber,
          documentType: passenger.documentType,
          passportNumber: passenger.passportNumber,
          passportExpiry: passenger.passportExpiry,
          issuingCountry: passenger.issuingCountry,
          nationality: passenger.nationality,
        };
      });

      const countries = await this.airportsService.findCountriesByIataCodes(
        normalizedOffer.airportCodes,
      );
      if (!(countries instanceof Map)) {
        throw new Error('Airport country lookup returned an invalid result');
      }

      const configValue = this.configService.get<string>('PASSPORT_ADVISORY_BUFFER_DAYS');
      const readinessConfig = parseBookingReadinessConfig({
        PASSPORT_ADVISORY_BUFFER_DAYS: configValue,
      });
      const result = this.bookingReadinessEvaluator.evaluate({
        passengers: evaluationPassengers,
        segments: normalizedOffer.segments.map((segment) => ({
          ...segment,
          originCountryCode: segment.originCountryCode
            ? (countries.get(segment.originCountryCode) ?? null)
            : null,
          destinationCountryCode: segment.destinationCountryCode
            ? (countries.get(segment.destinationCountryCode) ?? null)
            : null,
        })),
        tripCompletionDate: normalizedOffer.tripCompletionDate,
        supportedDocumentTypes: ['passport'],
        advisoryBufferDays: readinessConfig.passportAdvisoryBufferDays,
        currentDate: currentDateOnly(),
        entryEligibility: {
          include: true,
          result: {
            status: 'unknown',
            reason: 'ENTRY_ELIGIBILITY_UNKNOWN',
            blocking: false,
          },
        },
      });

      this.recordOutcome(
        {
          status: result.ready ? 'ready' : 'not_ready',
          operation: BookingReadinessOperation.INTENT_AUTHORITATIVE_VALIDATION,
          metadata: {
            scope: result.scope,
            passengerCount: result.passengers.length,
          },
        },
        context,
        startedAt,
      );

      return result;
    } catch (error) {
      const mappedError = this.mapError(error);
      this.recordOutcome(
        {
          status: this.errorCode(mappedError),
          operation: BookingReadinessOperation.INTENT_AUTHORITATIVE_VALIDATION,
          error: mappedError.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR,
          metadata: { reasonCode: this.errorCode(mappedError) },
        },
        context,
        startedAt,
      );
      throw mappedError;
    }
  }

  private assertFeatureEnabled(): void {
    if (this.configService.get<string>('FEATURE_FLAG_BOOKING_READINESS') !== 'true') {
      throw new NotFoundException({
        code: 'FEATURE_DISABLED',
        message: 'Booking readiness is unavailable',
      });
    }
  }

  normalizeStoredOffer(
    rawOffer: unknown,
    flightOffer?: {
      supplierOfferId?: string | null;
      price?: unknown;
      currency?: string | null;
      departureDate?: Date | string | null;
      adults?: number | null;
      children?: number | null;
      infants?: number | null;
    } | null,
  ): NormalizedOffer {
    const payload = complementStoredOfferPayload(rawOffer, flightOffer);
    const normalized = this.flightSearchPort.normalizeStoredOffer(payload);
    if (!normalized) {
      throw new Error('Stored offer data is malformed');
    }

    const passengers: StoredOfferPassenger[] = normalized.passengers.map((p) => {
      let type: PassengerType = PassengerType.ADULT;
      if (p.type === 'CHILD') type = PassengerType.CHILD;
      else if (p.type === 'INFANT') type = PassengerType.INFANT;
      return {
        id: p.supplierPassengerId,
        type,
      };
    });

    if (passengers.length === 0) {
      throw new Error('Stored offer passengers are malformed');
    }

    const allSegments = [
      ...normalized.segments,
      ...(normalized.returnSegments ?? []),
    ];

    if (allSegments.length === 0) {
      throw new Error('Stored offer contains no segments');
    }

    const segments: BookingReadinessSegmentInput[] = allSegments.map((s) => ({
      originCountryCode: s.departureAirport,
      destinationCountryCode: s.arrivalAirport,
      arrivalDate: s.arrivalTime.slice(0, 10),
    }));

    const airportCodes = [
      ...new Set(
        segments
          .flatMap((segment) => [segment.originCountryCode, segment.destinationCountryCode])
          .filter((code): code is string => typeof code === 'string' && code.length > 0),
      ),
    ];

    const tripCompletionDate = segments.reduce<string | null>((latest, segment) => {
      if (!segment.arrivalDate) {
        return latest;
      }
      return latest === null || segment.arrivalDate > latest ? segment.arrivalDate : latest;
    }, null);

    if (!tripCompletionDate) {
      throw new Error('Stored offer trip completion is unavailable');
    }

    return { passengers, segments, airportCodes, tripCompletionDate };
  }

  private assertOfferNotExpired(
    rawOffer: unknown,
    flightOffer?: {
      supplierOfferId?: string | null;
      price?: unknown;
      currency?: string | null;
      departureDate?: Date | string | null;
      adults?: number | null;
      children?: number | null;
      infants?: number | null;
    } | null,
  ): void {
    const payload = complementStoredOfferPayload(rawOffer, flightOffer);
    const normalized = this.flightSearchPort.normalizeStoredOffer(payload);
    if (normalized?.offerExpiresAt) {
      const expiresAt = new Date(normalized.offerExpiresAt);
      if (Number.isNaN(expiresAt.getTime())) {
        throw new Error('Stored offer expiry is malformed');
      }
      if (expiresAt.getTime() <= Date.now()) {
        throw httpError('OFFER_EXPIRED', 'Flight offer has expired', HttpStatus.CONFLICT);
      }
    }
  }

  private validatePassengerMappings(
    requestedPassengers: readonly BookingReadinessPassengerDto[],
    storedPassengers: readonly StoredOfferPassenger[],
  ): void {
    const adultCount = requestedPassengers.filter(
      (passenger) => passenger.passengerType === PassengerType.ADULT,
    ).length;
    const infantCount = requestedPassengers.filter(
      (passenger) => passenger.passengerType === PassengerType.INFANT,
    ).length;
    const requestedIds = requestedPassengers.map((passenger) => passenger.offerPassengerId);
    const storedById = new Map(storedPassengers.map((passenger) => [passenger.id, passenger]));

    if (
      requestedPassengers.length < 1 ||
      requestedPassengers.length > 9 ||
      requestedPassengers.length !== storedPassengers.length ||
      adultCount < 1 ||
      infantCount > adultCount ||
      new Set(requestedIds).size !== requestedIds.length
    ) {
      throw httpError(
        'PASSENGER_MAPPING_INVALID',
        'Passenger mapping is invalid',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    for (const requestedPassenger of requestedPassengers) {
      const storedPassenger = storedById.get(requestedPassenger.offerPassengerId);
      if (!storedPassenger || storedPassenger.type !== requestedPassenger.passengerType) {
        throw httpError(
          'PASSENGER_MAPPING_INVALID',
          'Passenger mapping is invalid',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
    }
  }

  private async resolvePassengers(
    requestedPassengers: readonly BookingReadinessPassengerDto[],
    storedPassengers: readonly StoredOfferPassenger[],
    userId: string,
  ): Promise<BookingReadinessPassengerInput[]> {
    let profile: RawRecord | null = null;
    const passengers: BookingReadinessPassengerInput[] = [];

    for (const passenger of requestedPassengers) {
      const passengerOrdinal =
        storedPassengers.findIndex((p) => p.id === passenger.offerPassengerId) + 1;
      const source = passenger.source;
      if (source.type === 'inline') {
        passengers.push(inlinePassenger(source, passenger, passengerOrdinal));
        continue;
      }

      if (profile === null) {
        try {
          profile = (await this.profileService.getProfile(userId)) as unknown as RawRecord;
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === HttpStatus.NOT_FOUND) {
            throw httpError(
              'PASSENGER_MAPPING_INVALID',
              'Passenger mapping is invalid',
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          throw error;
        }
      }

      if (!isRecord(profile) || profile.profileId !== source.travelerProfileId) {
        throw httpError(
          'PASSENGER_MAPPING_INVALID',
          'Passenger mapping is invalid',
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }

      passengers.push(profilePassenger(source, profile, passenger, passengerOrdinal));
    }

    return passengers;
  }

  private mapError(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    return httpError(
      'READINESS_DEPENDENCY_UNAVAILABLE',
      'Booking readiness dependency unavailable',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private errorCode(error: HttpException): string {
    const response = error.getResponse();
    if (isRecord(response) && typeof response.code === 'string') {
      return response.code;
    }
    return 'READINESS_REQUEST_FAILED';
  }

  private recordOutcome(
    event: {
      status: string;
      metadata?: Record<string, unknown>;
      error?: boolean;
      operation?: BookingReadinessOperation;
    },
    context: ReadinessContext | undefined,
    startedAt: number,
  ): void {
    try {
      this.bookingReadinessObservability.recordOutcome({
        ...event,
        context,
        latencyMs: Date.now() - startedAt,
      });
    } catch {
      // Observability must never change the advisory endpoint outcome.
    }
  }
}
