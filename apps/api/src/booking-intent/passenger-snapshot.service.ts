import {
  Injectable,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import type { ResolvedPassenger } from './passenger-source-resolver.service';

export type ResolvedPassengerForSnapshot = ResolvedPassenger;

export type SnapshotScope = 'DOMESTIC' | 'INTERNATIONAL';

export type MaskedPassengerSummary = {
  passengerType: PassengerType;
  passengerOrdinal: number;
  nameSummary: string;
  documentSummary: {
    documentType: string | null;
    issuingCountry: string | null;
    hasPassport: boolean;
    maskedPassportSummary?: string | null;
  };
  contactSummary: {
    email: string | null;
    phone: string | null;
    maskedContactSummary?: string | null;
  };
  preFilledFromProfile: boolean;
  maskedPassportSummary?: string | null;
  maskedContactSummary?: string | null;
};

export type PassengerSnapshotBuildInput = {
  intentId: string;
  passengers: readonly ResolvedPassengerForSnapshot[];
  scope?: SnapshotScope;
  snapshotVersion?: number;
};

export type PassengerSnapshotBuildResult = {
  persistenceInput: Prisma.BookingIntentPassengerCreateManyInput[];
  maskedPassengers: MaskedPassengerSummary[];
};

@Injectable()
export class PassengerSnapshotService {
  constructor(private readonly encryptionService: EncryptionService) {}

  buildSnapshotData(input: PassengerSnapshotBuildInput): PassengerSnapshotBuildResult {
    const snapshotVersion = input.snapshotVersion ?? 1;
    if (!input.intentId || !Number.isInteger(snapshotVersion) || snapshotVersion < 1) {
      throw this.incompleteSnapshot();
    }

    const positionedPassengers = input.passengers.map((passenger, position) => ({
      passenger,
      position,
    }));
    const persistenceInput: Prisma.BookingIntentPassengerCreateManyInput[] = [];
    const maskedPassengers: MaskedPassengerSummary[] = [];

    for (const { passenger, position } of positionedPassengers) {
      this.validateCompletePassenger(passenger, input.scope ?? 'DOMESTIC');
      const row = this.toPersistenceInput(input.intentId, snapshotVersion, passenger, position);
      persistenceInput.push(row);
      maskedPassengers.push(this.toMaskedSummary(passenger, position));
    }

    return { persistenceInput, maskedPassengers };
  }

  private validateCompletePassenger(
    passenger: ResolvedPassengerForSnapshot,
    scope: SnapshotScope,
  ): void {
    const requiredValues = [
      passenger.givenName,
      passenger.familyName,
      passenger.dateOfBirth,
      passenger.gender,
      passenger.title,
      passenger.email,
      passenger.phoneCountryCode,
      passenger.phoneNumber,
    ];

    if (requiredValues.some((value) => typeof value !== 'string' || value.trim() === '')) {
      throw this.incompleteSnapshot();
    }
    const dateOfBirth = passenger.dateOfBirth;
    if (
      typeof dateOfBirth !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) ||
      Number.isNaN(this.toDate(dateOfBirth).getTime())
    ) {
      throw this.incompleteSnapshot();
    }

    const hasAnyDocumentField = [
      passenger.documentType,
      passenger.passportNumber,
      passenger.passportExpiry,
      passenger.issuingCountry,
    ].some((value) => value !== null && value !== undefined && value !== '');

    if (scope === 'INTERNATIONAL' || hasAnyDocumentField) {
      const documentValues = [
        passenger.documentType,
        passenger.passportNumber,
        passenger.passportExpiry,
        passenger.issuingCountry,
        passenger.nationality,
      ];
      if (documentValues.some((value) => typeof value !== 'string' || value.trim() === '')) {
        throw this.incompleteSnapshot();
      }
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(passenger.passportExpiry as string) ||
        Number.isNaN(this.toDate(passenger.passportExpiry as string).getTime())
      ) {
        throw this.incompleteSnapshot();
      }
    }
  }

  private toPersistenceInput(
    intentId: string,
    snapshotVersion: number,
    passenger: ResolvedPassengerForSnapshot,
    position: number,
  ): Prisma.BookingIntentPassengerCreateManyInput {
    const context = (fieldName: 'passportNumber' | 'passportExpiry') => ({
      snapshotVersion,
      intentId,
      position,
      fieldName,
    });

    let passportNumber: string | null = null;
    let passportExpiry: string | null = null;
    try {
      passportNumber = passenger.passportNumber
        ? this.encryptionService.encryptBound(passenger.passportNumber, context('passportNumber'))
        : null;
      passportExpiry = passenger.passportExpiry
        ? this.encryptionService.encryptBound(passenger.passportExpiry, context('passportExpiry'))
        : null;
    } catch {
      throw new InternalServerErrorException({
        code: 'SNAPSHOT_INTEGRITY_FAILURE',
        message: 'Passenger snapshot could not be secured',
      });
    }

    return {
      intentId,
      position,
      type: passenger.type,
      givenName: this.requiredValue(passenger.givenName),
      familyName: this.requiredValue(passenger.familyName),
      middleName: passenger.middleName,
      dateOfBirth: this.toDate(this.requiredValue(passenger.dateOfBirth)),
      gender: this.requiredValue(passenger.gender),
      nationality: passenger.nationality,
      title: this.requiredValue(passenger.title),
      email: this.requiredValue(passenger.email),
      phoneCountryCode: this.requiredValue(passenger.phoneCountryCode),
      phoneNumber: this.requiredValue(passenger.phoneNumber),
      documentType: passenger.documentType,
      passportNumber,
      passportExpiry,
      issuingCountry: passenger.issuingCountry,
      travelerProfileId: passenger.travelerProfileId,
      supplierPassengerId: passenger.duffelPassengerId,
      snapshotVersion,
    };
  }

  private toMaskedSummary(
    passenger: ResolvedPassengerForSnapshot,
    position: number,
  ): MaskedPassengerSummary {
    const maskedPassportSummary = passenger.passportNumber
      ? '•••• ' + passenger.passportNumber.slice(-4)
      : null;
    const maskedContactSummary =
      `${this.maskEmail(passenger.email)} ${this.maskPhone(passenger.phoneCountryCode, passenger.phoneNumber)}`.trim() ||
      null;

    return {
      passengerType: passenger.type,
      passengerOrdinal: position + 1,
      nameSummary: `${this.maskName(passenger.givenName ?? '')} ${this.maskName(passenger.familyName ?? '')}`,
      documentSummary: {
        documentType: passenger.documentType,
        issuingCountry: passenger.issuingCountry,
        hasPassport: Boolean(passenger.passportNumber || passenger.passportExpiry),
        maskedPassportSummary,
      },
      contactSummary: {
        email: this.maskEmail(passenger.email),
        phone: this.maskPhone(passenger.phoneCountryCode, passenger.phoneNumber),
        maskedContactSummary,
      },
      preFilledFromProfile: passenger.travelerProfileId !== null,
      maskedPassportSummary,
      maskedContactSummary,
    };
  }

  private maskName(value: string): string {
    return value.length > 0 ? `${value[0]}•••` : '•••';
  }

  private maskEmail(value: string | null): string | null {
    if (!value) return null;
    const at = value.indexOf('@');
    if (at <= 0) return '•••';
    return `${value[0]}•••${value.slice(at)}`;
  }

  private maskPhone(countryCode: string | null, value: string | null): string | null {
    if (!value) return null;
    const suffix = value.slice(-2);
    return `${countryCode ?? ''}••••${suffix}`;
  }

  private requiredValue(value: string | null): string {
    if (!value || value.trim() === '') {
      throw this.incompleteSnapshot();
    }
    return value;
  }

  private toDate(dateOnly: string): Date {
    return new Date(`${dateOnly}T00:00:00.000Z`);
  }

  private incompleteSnapshot(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'SNAPSHOT_INCOMPLETE',
      message: 'Passenger snapshot is incomplete',
    });
  }
}
