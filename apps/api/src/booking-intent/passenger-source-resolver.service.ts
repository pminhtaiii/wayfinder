import { ConflictException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import { PrismaService } from '@/prisma/prisma.service';

export type TravelerProfilePassengerSource = {
  type: 'traveler_profile';
  travelerProfileId: string;
  expectedProfileRevision: number;
};

export type InlinePassengerSource = {
  type: 'inline';
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  gender: string;
  nationality?: string;
  passportNumber?: string;
  passportExpiry?: string;
  email: string;
  phoneCountryCode: string;
  phoneNumber: string;
  title: string;
  middleName?: string;
  documentType?: string;
  issuingCountry?: string;
};

export type PassengerSource = TravelerProfilePassengerSource | InlinePassengerSource;

export type PassengerSourceRequest = {
  offerPassengerId: string;
  type: PassengerType;
  source: PassengerSource;
  supplierPassengerId?: string | null;
  position?: number;
};

export type ResolvedPassenger = {
  offerPassengerId: string;
  type: PassengerType;
  givenName: string | null;
  familyName: string | null;
  middleName: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  nationality: string | null;
  title: string | null;
  email: string | null;
  phoneCountryCode: string | null;
  phoneNumber: string | null;
  documentType: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  issuingCountry: string | null;
  travelerProfileId: string | null;
  profileRevision: number | null;
  sourceType: PassengerSource['type'];
  supplierPassengerId: string | null;
  position?: number;
};

type ProfileRecord = {
  id: string;
  revision: number;
  givenName: string | null;
  middleName: string | null;
  familyName: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  title: string | null;
  email: string | null;
  phoneCountryCode: string | null;
  phoneNumber: string | null;
  nationality: string | null;
  documentType: string | null;
  issuingCountry: string | null;
  passportNumber: string | null;
  passportExpiry: Date | null;
  passportExpiryCiphertext: string | null;
};

type EncryptionContext = Record<string, string | number>;

@Injectable()
export class PassengerSourceResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async resolve(
    userId: string,
    passengers: readonly PassengerSourceRequest[],
  ): Promise<ResolvedPassenger[]> {
    const resolved: ResolvedPassenger[] = [];

    for (const passenger of passengers) {
      if (passenger.source.type === 'inline') {
        resolved.push(
          this.normalizeInline(
            passenger as PassengerSourceRequest & { source: InlinePassengerSource },
          ),
        );
        continue;
      }

      resolved.push(
        await this.resolveProfile(
          userId,
          passenger as PassengerSourceRequest & { source: TravelerProfilePassengerSource },
        ),
      );
    }

    return resolved;
  }

  private async resolveProfile(
    userId: string,
    passenger: PassengerSourceRequest & { source: TravelerProfilePassengerSource },
  ): Promise<ResolvedPassenger> {
    const profile = (await this.prisma.travelerProfile.findFirst({
      where: {
        id: passenger.source.travelerProfileId,
        userId,
      },
    })) as ProfileRecord | null;

    if (!profile) {
      throw this.invalidSource();
    }

    if (profile.revision !== passenger.source.expectedProfileRevision) {
      throw new ConflictException({
        code: 'PROFILE_CHANGED',
        message: 'Traveler profile changed',
      });
    }

    let passportNumber: string | null = null;
    let passportExpiry: string | null = null;
    try {
      passportNumber = this.decryptProfileField(profile.passportNumber, [
        { userId, fieldName: 'passportNumber' },
      ]);
      if (profile.passportExpiryCiphertext) {
        const decryptedExpiry = this.decryptProfileField(profile.passportExpiryCiphertext, [
          { userId, fieldName: 'passportExpiry' },
          { travelerProfileId: profile.id, fieldName: 'passportExpiry' },
        ]);
        passportExpiry = decryptedExpiry === null ? null : this.toDateOnlyString(decryptedExpiry);
      } else {
        passportExpiry = this.toDateOnly(profile.passportExpiry);
      }
    } catch {
      throw this.invalidSource();
    }

    return {
      offerPassengerId: passenger.offerPassengerId,
      type: passenger.type,
      givenName: profile.givenName ?? null,
      familyName: profile.familyName ?? null,
      middleName: profile.middleName ?? null,
      dateOfBirth: this.toDateOnly(profile.dateOfBirth),
      gender: profile.gender?.toLowerCase() ?? null,
      nationality: profile.nationality?.toUpperCase() ?? null,
      title: profile.title ?? null,
      email: profile.email ?? null,
      phoneCountryCode: profile.phoneCountryCode ?? null,
      phoneNumber: profile.phoneNumber ?? null,
      documentType: profile.documentType ?? null,
      passportNumber,
      passportExpiry,
      issuingCountry: profile.issuingCountry ?? null,
      travelerProfileId: profile.id,
      profileRevision: profile.revision,
      sourceType: 'traveler_profile',
      supplierPassengerId: passenger.supplierPassengerId ?? null,
      position: passenger.position,
    };
  }

  private normalizeInline(
    passenger: PassengerSourceRequest & { source: InlinePassengerSource },
  ): ResolvedPassenger {
    const source = passenger.source;
    return {
      offerPassengerId: passenger.offerPassengerId,
      type: passenger.type,
      givenName: source.givenName,
      familyName: source.familyName,
      middleName: source.middleName ?? null,
      dateOfBirth: source.dateOfBirth,
      gender: source.gender.toLowerCase(),
      nationality: source.nationality?.toUpperCase() ?? null,
      title: source.title,
      email: source.email,
      phoneCountryCode: source.phoneCountryCode,
      phoneNumber: source.phoneNumber,
      documentType: source.documentType ?? null,
      passportNumber: source.passportNumber ?? null,
      passportExpiry: source.passportExpiry ?? null,
      issuingCountry: source.issuingCountry?.toUpperCase() ?? null,
      travelerProfileId: null,
      profileRevision: null,
      sourceType: 'inline',
      supplierPassengerId: passenger.supplierPassengerId ?? null,
      position: passenger.position,
    };
  }

  private decryptProfileField(
    value: string | null,
    contexts: readonly EncryptionContext[],
  ): string | null {
    if (!value) return null;
    if (value.startsWith('v1:')) {
      let lastError: unknown;
      for (const context of contexts) {
        try {
          return this.encryptionService.decryptBound(value, context);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error('Unable to decrypt profile field');
    }
    return this.encryptionService.decrypt(value);
  }

  private toDateOnlyString(value: string): string {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error('Invalid passport expiry');
    }
    return parsed.toISOString().slice(0, 10);
  }

  private toDateOnly(value: Date | null): string | null {
    return value ? value.toISOString().slice(0, 10) : null;
  }

  private invalidSource(): UnprocessableEntityException {
    return new UnprocessableEntityException({
      code: 'PASSENGER_SOURCE_INVALID',
      message: 'Passenger source is invalid',
    });
  }
}
