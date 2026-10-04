import {
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import {
  BookingReadinessObservability,
  BookingReadinessObservabilityContext,
} from './booking-readiness.observability';
import { BookingReadinessOperation } from '@/common/observability/booking-readiness-observability.types';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
} from '@/common/observability/booking-readiness.metrics';

export type DuffelIdentityDocument = {
  type: string;
  unique_identifier: string;
  expires_on: string;
  issuing_country_code: string;
};

export type DuffelPassengerDto = {
  id?: string;
  type: string;
  given_name: string;
  family_name: string;
  born_on: string;
  gender: string;
  title: string;
  email: string;
  phone_number: string;
  identity_documents: DuffelIdentityDocument[];
};

export type BookingIntentPassengerRecord = {
  id?: string;
  intentId: string;
  position: number;
  type: PassengerType | string;
  givenName: string;
  familyName: string;
  middleName?: string | null;
  dateOfBirth: Date | string;
  gender: string;
  nationality?: string | null;
  passportNumber?: string | null;
  passportExpiry?: string | null;
  travelerProfileId?: string | null;
  supplierPassengerId?: string | null;
  title?: string | null;
  email?: string | null;
  phoneCountryCode?: string | null;
  phoneNumber?: string | null;
  documentType?: string | null;
  issuingCountry?: string | null;
  snapshotVersion?: number;
};

export type BookingIntentForValidation = {
  id: string;
  passengers: readonly BookingIntentPassengerRecord[];
  rawOfferSnapshot?: unknown;
  offerExpiresAt?: Date | string | null;
  snapshotVersion?: number;
};

export type FinalPassengerValidationOptions = {
  scope?: 'DOMESTIC' | 'INTERNATIONAL';
  tripCompletionDate?: string;
  now?: Date;
  context?: BookingReadinessObservabilityContext;
};

export type FinalPassengerValidationResult = {
  duffelPassengers: DuffelPassengerDto[];
  scope: 'DOMESTIC' | 'INTERNATIONAL';
  passengerCount: number;
  auditMetadata: {
    scope: 'DOMESTIC' | 'INTERNATIONAL';
    passengerCount: number;
    reasonCode: string | null;
    status: 'valid' | 'invalid';
  };
};

type DecryptedPassenger = {
  record: BookingIntentPassengerRecord;
  decryptedPassportNumber: string | null;
  decryptedPassportExpiry: string | null;
};

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatDateOnly(value: Date | string): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    const candidate = value.slice(0, 10);
    return isValidDateOnly(candidate) ? candidate : null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class BookingPassengerFinalValidatorService {
  constructor(
    private readonly encryptionService: EncryptionService,
    private readonly observability: BookingReadinessObservability,
    @Optional() private readonly metricsService?: BookingReadinessMetricsService,
  ) {}

  validateAndMapPassengers(
    intent: BookingIntentForValidation,
    options?: {
      traceId?: string;
      correlationId?: string;
      scope?: 'DOMESTIC' | 'INTERNATIONAL';
      tripCompletionDate?: string;
      now?: Date;
    },
  ): DuffelPassengerDto[] {
    const result = this.validate(intent, {
      scope: options?.scope,
      tripCompletionDate: options?.tripCompletionDate,
      now: options?.now,
      context:
        options?.traceId || options?.correlationId
          ? {
              traceId: options?.traceId,
              correlationId: options?.correlationId,
            }
          : undefined,
    });
    return result.duffelPassengers;
  }

  validate(
    intent: BookingIntentForValidation,
    options?: FinalPassengerValidationOptions,
  ): FinalPassengerValidationResult {
    const startedAt = Date.now();
    this.metricsService?.increment(
      BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION,
    );
    const now = options?.now ?? new Date();
    const passengers = intent.passengers ?? [];
    const passengerCount = passengers.length;

    let derivedScope: 'DOMESTIC' | 'INTERNATIONAL' = options?.scope ?? 'DOMESTIC';
    let derivedTripCompletionDate: string | null = options?.tripCompletionDate ?? null;

    try {
      if (!intent.id || passengerCount === 0) {
        throw this.incompleteSnapshot();
      }

      // Step 1: Authenticate & decrypt bound ciphertext fields first (Decrypt-then-validate)
      const decryptedPassengers = this.decryptPassengerSnapshots(intent, passengers);

      // Step 2: Check offer expiry
      this.assertOfferNotExpired(intent, now);

      // Step 3: Determine scope & trip completion date from rawOfferSnapshot if not provided
      const offerAnalysis = this.analyzeOfferSnapshot(intent.rawOfferSnapshot);
      if (!options?.scope && offerAnalysis.scope) {
        derivedScope = offerAnalysis.scope;
      }
      if (!derivedTripCompletionDate && offerAnalysis.tripCompletionDate) {
        derivedTripCompletionDate = offerAnalysis.tripCompletionDate;
      }

      // If any passenger has passport data populated, elevate scope to INTERNATIONAL if not explicitly domestic
      if (
        !options?.scope &&
        derivedScope === 'DOMESTIC' &&
        decryptedPassengers.some(
          (p) =>
            p.decryptedPassportNumber ||
            p.decryptedPassportExpiry ||
            p.record.documentType ||
            p.record.issuingCountry,
        )
      ) {
        derivedScope = 'INTERNATIONAL';
      }

      // Step 4: Revalidate passenger completeness, DOB, and live clock / trip completion date document expiry
      const duffelPassengers = this.validateAndBuildDuffelPassengers(
        decryptedPassengers,
        derivedScope,
        now,
        derivedTripCompletionDate,
      );

      const latencyMs = Date.now() - startedAt;
      this.observability.recordOutcome({
        operation: BookingReadinessOperation.FINAL_PASSENGER_VALIDATION,
        status: 'valid',
        latencyMs,
        metadata: {
          scope: derivedScope,
          passengerCount,
        },
        context: options?.context,
      });

      return {
        duffelPassengers,
        scope: derivedScope,
        passengerCount,
        auditMetadata: {
          scope: derivedScope,
          passengerCount,
          reasonCode: null,
          status: 'valid',
        },
      };
    } catch (error) {
      this.metricsService?.increment(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION_FAILURES,
      );
      const latencyMs = Date.now() - startedAt;
      const reasonCode =
        (error instanceof HttpException &&
          (error.getResponse() as Record<string, unknown>)?.code) ||
        'FINAL_VALIDATION_ERROR';

      this.observability.recordOutcome({
        operation: BookingReadinessOperation.FINAL_PASSENGER_VALIDATION,
        status: 'invalid',
        error: true,
        latencyMs,
        metadata: {
          scope: derivedScope,
          passengerCount,
          reasonCode: typeof reasonCode === 'string' ? reasonCode : null,
        },
        context: options?.context,
      });

      throw error;
    }
  }

  private decryptPassengerSnapshots(
    intent: BookingIntentForValidation,
    passengers: readonly BookingIntentPassengerRecord[],
  ): DecryptedPassenger[] {
    const decryptedList: DecryptedPassenger[] = [];

    for (let index = 0; index < passengers.length; index++) {
      const passenger = passengers[index];
      const position = passenger.position ?? index;
      const snapshotVersion = passenger.snapshotVersion ?? intent.snapshotVersion ?? 1;
      const intentId = intent.id;

      let decryptedPassportNumber: string | null = null;
      let decryptedPassportExpiry: string | null = null;

      try {
        if (passenger.passportNumber) {
          decryptedPassportNumber = this.encryptionService.decryptBound(passenger.passportNumber, {
            snapshotVersion,
            intentId,
            position,
            fieldName: 'passportNumber',
          });
        }

        if (passenger.passportExpiry) {
          decryptedPassportExpiry = this.encryptionService.decryptBound(passenger.passportExpiry, {
            snapshotVersion,
            intentId,
            position,
            fieldName: 'passportExpiry',
          });
        }
      } catch {
        throw new UnprocessableEntityException({
          code: 'SNAPSHOT_INTEGRITY_FAILURE',
          message: 'Passenger snapshot integrity failure',
        });
      }

      decryptedList.push({
        record: passenger,
        decryptedPassportNumber,
        decryptedPassportExpiry,
      });
    }

    return decryptedList;
  }

  private assertOfferNotExpired(intent: BookingIntentForValidation, now: Date): void {
    if (intent.offerExpiresAt) {
      const expiresAt = new Date(intent.offerExpiresAt);
      if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
        throw new HttpException(
          {
            code: 'OFFER_EXPIRED',
            message: 'Flight offer has expired',
          },
          HttpStatus.CONFLICT,
        );
      }
    }

    const rawOffer = intent.rawOfferSnapshot;
    if (isRecord(rawOffer)) {
      const expiresAtRaw = rawOffer.expires_at ?? rawOffer.expiresAt;
      if (typeof expiresAtRaw === 'string') {
        const expiresAt = new Date(expiresAtRaw);
        if (!Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= now.getTime()) {
          throw new HttpException(
            {
              code: 'OFFER_EXPIRED',
              message: 'Flight offer has expired',
            },
            HttpStatus.CONFLICT,
          );
        }
      }
    }
  }

  private analyzeOfferSnapshot(rawOffer: unknown): {
    scope: 'DOMESTIC' | 'INTERNATIONAL' | null;
    tripCompletionDate: string | null;
  } {
    if (!isRecord(rawOffer) || !Array.isArray(rawOffer.slices)) {
      return { scope: null, tripCompletionDate: null };
    }

    let isInternational = false;
    let latestArrival: string | null = null;

    for (const slice of rawOffer.slices) {
      if (!isRecord(slice) || !Array.isArray(slice.segments)) {
        continue;
      }
      for (const segment of slice.segments) {
        if (!isRecord(segment)) continue;

        let originCountry: string | null = null;
        let destCountry: string | null = null;

        if (isRecord(segment.origin)) {
          originCountry =
            (segment.origin.iata_country_code as string) ??
            (segment.origin.countryCode as string) ??
            null;
        }
        if (isRecord(segment.destination)) {
          destCountry =
            (segment.destination.iata_country_code as string) ??
            (segment.destination.countryCode as string) ??
            null;
        }

        if (originCountry && destCountry && originCountry !== destCountry) {
          isInternational = true;
        }

        const arrivalRaw = segment.arriving_at ?? segment.arrivalDate ?? segment.arrivingAt;
        if (typeof arrivalRaw === 'string') {
          const dateOnly = arrivalRaw.slice(0, 10);
          if (isValidDateOnly(dateOnly)) {
            if (!latestArrival || dateOnly > latestArrival) {
              latestArrival = dateOnly;
            }
          }
        }
      }
    }

    return {
      scope: isInternational ? 'INTERNATIONAL' : 'DOMESTIC',
      tripCompletionDate: latestArrival,
    };
  }

  private validateAndBuildDuffelPassengers(
    decryptedPassengers: DecryptedPassenger[],
    scope: 'DOMESTIC' | 'INTERNATIONAL',
    now: Date,
    tripCompletionDate: string | null,
  ): DuffelPassengerDto[] {
    const todayDateOnly = now.toISOString().slice(0, 10);
    const duffelPassengers: DuffelPassengerDto[] = [];

    for (const {
      record,
      decryptedPassportNumber,
      decryptedPassportExpiry,
    } of decryptedPassengers) {
      // 1. Validate identity fields
      const givenName = this.requiredString(record.givenName);
      const familyName = this.requiredString(record.familyName);
      const title = this.requiredString(record.title).toLowerCase();
      const genderRaw = this.requiredString(record.gender).toLowerCase();
      const gender = genderRaw.startsWith('m') ? 'm' : genderRaw.startsWith('f') ? 'f' : 'u';

      // 2. Validate date of birth
      const bornOn = formatDateOnly(record.dateOfBirth);
      if (!bornOn) {
        throw new UnprocessableEntityException({
          code: 'INVALID_DATE_OF_BIRTH',
          message: 'Date of birth is invalid',
        });
      }
      if (bornOn > todayDateOnly) {
        throw new UnprocessableEntityException({
          code: 'INVALID_DATE_OF_BIRTH',
          message: 'Date of birth cannot be in the future',
        });
      }

      // 3. Validate contact fields
      const email = this.requiredString(record.email);
      const phoneNumberRaw = this.requiredString(record.phoneNumber);
      const phoneCountryCode = record.phoneCountryCode?.trim() ?? '';
      const phoneNumber =
        phoneNumberRaw.startsWith('+') || !phoneCountryCode
          ? phoneNumberRaw
          : `${phoneCountryCode}${phoneNumberRaw}`;

      // 4. Validate document fields for international scope or if document group is present
      const identityDocuments: DuffelIdentityDocument[] = [];
      const hasDocumentGroup = Boolean(
        record.documentType ||
        decryptedPassportNumber ||
        decryptedPassportExpiry ||
        record.issuingCountry,
      );

      if (scope === 'INTERNATIONAL' || hasDocumentGroup) {
        const documentType = this.requiredString(record.documentType ?? 'passport');
        const passportNumber = this.requiredString(decryptedPassportNumber);
        const passportExpiry = this.requiredString(decryptedPassportExpiry);
        const issuingCountry = this.requiredString(record.issuingCountry);
        this.requiredString(record.nationality);

        if (!isValidDateOnly(passportExpiry)) {
          throw this.incompleteSnapshot();
        }

        // Live clock and trip completion date expiry check
        if (passportExpiry <= todayDateOnly) {
          throw new UnprocessableEntityException({
            code: 'DOCUMENT_EXPIRED',
            message: 'Travel document has expired',
          });
        }
        if (tripCompletionDate && passportExpiry < tripCompletionDate) {
          throw new UnprocessableEntityException({
            code: 'DOCUMENT_EXPIRED',
            message: 'Travel document expires before trip completion date',
          });
        }

        identityDocuments.push({
          type: documentType,
          unique_identifier: passportNumber,
          expires_on: passportExpiry,
          issuing_country_code: issuingCountry,
        });
      }

      // 5. Map Duffel passenger type
      const duffelType = this.mapPassengerType(record.type);

      const duffelDto: DuffelPassengerDto = {
        type: duffelType,
        given_name: givenName,
        family_name: familyName,
        born_on: bornOn,
        gender,
        title,
        email,
        phone_number: phoneNumber,
        identity_documents: identityDocuments,
      };

      if (record.supplierPassengerId) {
        duffelDto.id = record.supplierPassengerId;
      }

      duffelPassengers.push(duffelDto);
    }

    return duffelPassengers;
  }

  private mapPassengerType(type: PassengerType | string): string {
    const normalized = String(type).toLowerCase();
    if (normalized === 'adult') return 'adult';
    if (normalized === 'child') return 'child';
    if (normalized === 'infant') return 'infant_without_seat';
    return normalized;
  }

  private requiredString(value: string | null | undefined): string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw this.incompleteSnapshot();
    }
    return value.trim();
  }

  private incompleteSnapshot(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'SNAPSHOT_INCOMPLETE',
      message: 'Passenger snapshot is incomplete',
    });
  }
}
