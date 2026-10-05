// User approved 2026-10-04: add canonical supplier identity expectations while retaining source-resolution coverage.
import 'reflect-metadata';
import { UnprocessableEntityException } from '@nestjs/common';
import { PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import { PassengerSourceResolverService } from './passenger-source-resolver.service';

const USER_ID = 'user-1';
const PROFILE_ID = 'profile-1';

function profile(overrides: Record<string, unknown> = {}) {
  return {
    id: PROFILE_ID,
    userId: USER_ID,
    revision: 3,
    givenName: 'Ada',
    middleName: null,
    familyName: 'Lovelace',
    dateOfBirth: new Date('1815-12-10T00:00:00.000Z'),
    gender: 'female',
    title: 'MS',
    email: 'ada@example.test',
    phoneCountryCode: '+44',
    phoneNumber: '7000000000',
    nationality: 'GB',
    documentType: 'passport',
    issuingCountry: 'GB',
    passportNumber: null,
    passportExpiry: new Date('2030-01-01T00:00:00.000Z'),
    passportExpiryCiphertext: null,
    ...overrides,
  };
}

function inlinePassenger() {
  return {
    offerPassengerId: 'pas_002',
    type: PassengerType.CHILD,
    supplierPassengerId: 'supplier_child_001',
    source: {
      type: 'inline' as const,
      givenName: 'Grace',
      familyName: 'Hopper',
      dateOfBirth: '1906-12-09',
      gender: 'female',
      nationality: 'US',
      email: 'grace@example.test',
      phoneCountryCode: '+1',
      phoneNumber: '5550000000',
      title: 'MS',
    },
  };
}

describe('PassengerSourceResolverService', () => {
  let service: PassengerSourceResolverService;
  let prisma: { travelerProfile: { findFirst: jest.Mock } };
  let encryption: { decryptBound: jest.Mock; decrypt: jest.Mock };

  beforeEach(() => {
    prisma = { travelerProfile: { findFirst: jest.fn() } };
    encryption = { decryptBound: jest.fn(), decrypt: jest.fn() };
    service = new PassengerSourceResolverService(
      prisma as never,
      encryption as unknown as EncryptionService,
    );
  });

  it('resolves an owned profile source and retains provenance/revision', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(profile());

    const [resolved] = await service.resolve(USER_ID, [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        supplierPassengerId: 'supplier_pas_001',
        source: {
          type: 'traveler_profile',
          travelerProfileId: PROFILE_ID,
          expectedProfileRevision: 3,
        },
      },
    ]);

    expect(prisma.travelerProfile.findFirst).toHaveBeenCalledWith({
      where: { id: PROFILE_ID, userId: USER_ID },
    });
    expect(resolved).toEqual(
      expect.objectContaining({
        givenName: 'Ada',
        familyName: 'Lovelace',
        dateOfBirth: '1815-12-10',
        travelerProfileId: PROFILE_ID,
        profileRevision: 3,
        sourceType: 'traveler_profile',
        supplierPassengerId: 'supplier_pas_001',
      }),
    );
    expect(resolved).not.toHaveProperty('source');
  });

  it('fails missing or foreign profiles without revealing whether they exist', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(null);

    const error = await service
      .resolve(USER_ID, [
        {
          offerPassengerId: 'pas_001',
          type: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: 'foreign-profile',
            expectedProfileRevision: 1,
          },
        },
      ])
      .catch((value: unknown) => value);

    expect(error).toEqual(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PASSENGER_SOURCE_INVALID' }),
      }),
    );
    expect(JSON.stringify(error)).not.toContain('foreign-profile');
    expect(prisma.travelerProfile.findFirst).toHaveBeenCalledWith({
      where: { id: 'foreign-profile', userId: USER_ID },
    });
  });

  it('rejects stale revisions with PROFILE_CHANGED', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(profile({ revision: 4 }));

    await expect(
      service.resolve(USER_ID, [
        {
          offerPassengerId: 'pas_001',
          type: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: PROFILE_ID,
            expectedProfileRevision: 3,
          },
        },
      ]),
    ).rejects.toEqual(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PROFILE_CHANGED' }),
      }),
    );
  });

  it('resolves mixed profile and inline passengers independently without merging values', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(profile());

    const resolved = await service.resolve(USER_ID, [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        supplierPassengerId: 'supplier_pas_001',
        source: {
          type: 'traveler_profile',
          travelerProfileId: PROFILE_ID,
          expectedProfileRevision: 3,
        },
      },
      inlinePassenger(),
    ]);

    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toEqual(
      expect.objectContaining({ givenName: 'Ada', travelerProfileId: PROFILE_ID }),
    );
    expect(resolved[1]).toEqual(
      expect.objectContaining({
        givenName: 'Grace',
        travelerProfileId: null,
        sourceType: 'inline',
        supplierPassengerId: 'supplier_child_001',
      }),
    );
    expect(resolved[1]).not.toHaveProperty('passportNumber', expect.anything());
  });

  it('never falls back to inline values for an invalid profile source', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(null);

    await expect(
      service.resolve(USER_ID, [
        {
          offerPassengerId: 'pas_001',
          type: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: PROFILE_ID,
            expectedProfileRevision: 3,
          },
        },
      ]),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('resolves all sources before returning and performs no writes or side effects', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(profile());
    const result = await service.resolve(USER_ID, [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        source: {
          type: 'traveler_profile',
          travelerProfileId: PROFILE_ID,
          expectedProfileRevision: 3,
        },
      },
      inlinePassenger(),
    ]);

    expect(result).toHaveLength(2);
    expect(Object.keys(prisma)).toEqual(['travelerProfile']);
    expect(Object.keys(prisma.travelerProfile)).toEqual(['findFirst']);
    expect(encryption.decrypt).not.toHaveBeenCalled();
  });

  it('detaches normalized values from later profile edits or deletion', async () => {
    const source = profile();
    prisma.travelerProfile.findFirst.mockResolvedValue(source);

    const [resolved] = await service.resolve(USER_ID, [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        source: {
          type: 'traveler_profile',
          travelerProfileId: PROFILE_ID,
          expectedProfileRevision: 3,
        },
      },
    ]);
    source.givenName = 'Changed';
    (source as { familyName: string | null }).familyName = null;

    expect(resolved.givenName).toBe('Ada');
    expect(resolved.familyName).toBe('Lovelace');
  });

  it('maps crypto failures to the same safe source error without exposing plaintext', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(profile({ passportNumber: 'v1:bad' }));
    encryption.decryptBound.mockImplementation(() => {
      throw new Error('secret plaintext failure');
    });

    await expect(
      service.resolve(USER_ID, [
        {
          offerPassengerId: 'pas_001',
          type: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: PROFILE_ID,
            expectedProfileRevision: 3,
          },
        },
      ]),
    ).rejects.toEqual(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'PASSENGER_SOURCE_INVALID' }),
      }),
    );
  });

  it('supports passport expiry ciphertext created by the profile backfill context', async () => {
    prisma.travelerProfile.findFirst.mockResolvedValue(
      profile({ passportExpiryCiphertext: 'v1:backfilled-expiry' }),
    );
    encryption.decryptBound.mockImplementation(
      (_value: string, context: Record<string, string>) => {
        if (context.userId) {
          throw new Error('user context does not match backfill ciphertext');
        }
        return '2030-01-01T00:00:00.000Z';
      },
    );

    const [resolved] = await service.resolve(USER_ID, [
      {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        source: {
          type: 'traveler_profile',
          travelerProfileId: PROFILE_ID,
          expectedProfileRevision: 3,
        },
      },
    ]);

    expect(resolved.passportExpiry).toBe('2030-01-01');
    expect(encryption.decryptBound).toHaveBeenNthCalledWith(1, 'v1:backfilled-expiry', {
      userId: USER_ID,
      fieldName: 'passportExpiry',
    });
    expect(encryption.decryptBound).toHaveBeenNthCalledWith(2, 'v1:backfilled-expiry', {
      travelerProfileId: PROFILE_ID,
      fieldName: 'passportExpiry',
    });
  });
});
