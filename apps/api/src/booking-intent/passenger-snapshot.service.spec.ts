// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
// User approved 2026-10-04: canonical supplier identity fixture adaptation; persistence and ciphertext assertions remain unchanged.
import 'reflect-metadata';
import { PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import {
  PassengerSnapshotService,
  ResolvedPassengerForSnapshot,
} from './passenger-snapshot.service';

const INTENT_ID = 'intent-1';

function passenger(
  overrides: Partial<ResolvedPassengerForSnapshot> = {},
): ResolvedPassengerForSnapshot {
  return {
    offerPassengerId: 'pas_001',
    type: PassengerType.ADULT,
    givenName: 'Ada',
    familyName: 'Lovelace',
    middleName: null,
    dateOfBirth: '1815-12-10',
    gender: 'female',
    nationality: 'GB',
    title: 'MS',
    email: 'ada@example.test',
    phoneCountryCode: '+44',
    phoneNumber: '7000000000',
    documentType: null,
    passportNumber: null,
    passportExpiry: null,
    issuingCountry: null,
    travelerProfileId: null,
    profileRevision: null,
    sourceType: 'inline',
    supplierPassengerId: 'supplier_pas_001',
    ...overrides,
  };
}

function internationalPassenger(overrides: Partial<ResolvedPassengerForSnapshot> = {}) {
  return passenger({
    documentType: 'passport',
    passportNumber: 'P1234567',
    passportExpiry: '2032-12-31',
    issuingCountry: 'GB',
    nationality: 'GB',
    ...overrides,
  });
}

describe('PassengerSnapshotService', () => {
  let service: PassengerSnapshotService;
  let encryption: EncryptionService;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    encryption = new EncryptionService();
    service = new PassengerSnapshotService(encryption);
  });

  it('builds a complete domestic snapshot with zero-based positions', () => {
    const result = service.buildSnapshotData({
      intentId: INTENT_ID,
      scope: 'DOMESTIC',
      passengers: [passenger()],
    });

    expect(result.persistenceInput).toHaveLength(1);
    expect(result.persistenceInput[0]).toEqual(
      expect.objectContaining({
        intentId: INTENT_ID,
        position: 0,
        type: PassengerType.ADULT,
        givenName: 'Ada',
        familyName: 'Lovelace',
        dateOfBirth: new Date('1815-12-10T00:00:00.000Z'),
        title: 'MS',
        email: 'ada@example.test',
        phoneCountryCode: '+44',
        phoneNumber: '7000000000',
        passportNumber: null,
        passportExpiry: null,
        travelerProfileId: null,
        supplierPassengerId: 'supplier_pas_001',
        snapshotVersion: 1,
      }),
    );
  });

  it('builds a complete international atomic document group and bound ciphertext', () => {
    const result = service.buildSnapshotData({
      intentId: INTENT_ID,
      scope: 'INTERNATIONAL',
      snapshotVersion: 7,
      passengers: [
        internationalPassenger({
          travelerProfileId: 'profile-1',
          sourceType: 'traveler_profile',
          profileRevision: 4,
        }),
      ],
    });
    const row = result.persistenceInput[0];

    expect(row).toEqual(
      expect.objectContaining({ snapshotVersion: 7, travelerProfileId: 'profile-1' }),
    );
    expect(row.passportNumber).toMatch(/^v1:/);
    expect(row.passportExpiry).toMatch(/^v1:/);
    expect(
      encryption.decryptBound(row.passportNumber as string, {
        snapshotVersion: 7,
        intentId: INTENT_ID,
        position: 0,
        fieldName: 'passportNumber',
      }),
    ).toBe('P1234567');
    expect(
      encryption.decryptBound(row.passportExpiry as string, {
        snapshotVersion: 7,
        intentId: INTENT_ID,
        position: 0,
        fieldName: 'passportExpiry',
      }),
    ).toBe('2032-12-31');
  });

  it('rejects incomplete identity/contact data and partial document groups', () => {
    expect(() =>
      service.buildSnapshotData({ intentId: INTENT_ID, passengers: [passenger({ email: '' })] }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
      }),
    );
    expect(() =>
      service.buildSnapshotData({
        intentId: INTENT_ID,
        scope: 'INTERNATIONAL',
        passengers: [internationalPassenger({ passportExpiry: null })],
      }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
      }),
    );
    expect(() =>
      service.buildSnapshotData({
        intentId: INTENT_ID,
        scope: 'INTERNATIONAL',
        passengers: [internationalPassenger({ issuingCountry: null })],
      }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
      }),
    );
  });

  it('binds ciphertext to intent, position, field name, and snapshot version', () => {
    const row = service.buildSnapshotData({
      intentId: INTENT_ID,
      scope: 'INTERNATIONAL',
      passengers: [internationalPassenger()],
    }).persistenceInput[0];
    const ciphertext = row.passportNumber as string;
    const attempts = [
      { intentId: 'other-intent', position: 0, snapshotVersion: 1, fieldName: 'passportNumber' },
      { intentId: INTENT_ID, position: 1, snapshotVersion: 1, fieldName: 'passportNumber' },
      { intentId: INTENT_ID, position: 0, snapshotVersion: 1, fieldName: 'passportExpiry' },
      { intentId: INTENT_ID, position: 0, snapshotVersion: 2, fieldName: 'passportNumber' },
    ];

    for (const context of attempts) {
      expect(() => encryption.decryptBound(ciphertext, context)).toThrow();
    }
  });

  it('returns masked projections without sensitive values or profile IDs', () => {
    const result = service.buildSnapshotData({
      intentId: INTENT_ID,
      scope: 'INTERNATIONAL',
      passengers: [
        internationalPassenger({
          travelerProfileId: 'profile-secret',
          sourceType: 'traveler_profile',
        }),
      ],
    });

    expect(result.maskedPassengers[0]).toEqual(
      expect.objectContaining({
        passengerType: PassengerType.ADULT,
        passengerOrdinal: 1,
        preFilledFromProfile: true,
      }),
    );
    const serialized = JSON.stringify(result.maskedPassengers[0]);
    expect(serialized).not.toContain('P1234567');
    expect(serialized).not.toContain('2032-12-31');
    expect(serialized).not.toContain('ada@example.test');
    expect(serialized).not.toContain('7000000000');
    expect(serialized).not.toContain('profile-secret');
  });

  it('keeps each snapshot independent after profile provenance is removed', () => {
    const result = service.buildSnapshotData({
      intentId: INTENT_ID,
      scope: 'INTERNATIONAL',
      passengers: [
        internationalPassenger({ travelerProfileId: 'profile-1', sourceType: 'traveler_profile' }),
      ],
    });

    expect(result.persistenceInput[0].travelerProfileId).toBe('profile-1');
    expect(result.persistenceInput[0].passportNumber).toMatch(/^v1:/);
    expect(result.persistenceInput[0].passportExpiry).toMatch(/^v1:/);
  });

  it('maps encryption failures to a safe integrity error without plaintext', () => {
    const encryptBound = jest.spyOn(encryption, 'encryptBound').mockImplementation(() => {
      throw new Error('P1234567 leaked crypto detail');
    });

    expect(() =>
      service.buildSnapshotData({
        intentId: INTENT_ID,
        scope: 'INTERNATIONAL',
        passengers: [internationalPassenger()],
      }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
      }),
    );
    expect(() =>
      service.buildSnapshotData({
        intentId: INTENT_ID,
        scope: 'INTERNATIONAL',
        passengers: [internationalPassenger()],
      }),
    ).toThrow(expect.not.objectContaining({ message: expect.stringContaining('P1234567') }));
    encryptBound.mockRestore();
  });
});
