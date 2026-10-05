import 'reflect-metadata';
import { PassengerType } from '@prisma/client';
import { EncryptionService } from '@/common/encryption.service';
import { BookingReadinessObservability } from './booking-readiness.observability';
import { BookingReadinessOperation } from '@/common/observability/booking-readiness-observability.types';
import type { FlightSearchPort } from '@/supplier/search/flight-search.port';
import { normalizeStoredOfferFacts as normalizeSupplierStoredOfferFacts } from '@/supplier/search/flight-offer.normalizer';
import {
  BookingPassengerFinalValidatorService,
  BookingIntentPassengerRecord,
  BookingIntentForValidation,
} from './booking-passenger-final-validator.service';

// Approved 2026-10-03: fixtures model the neutral Prisma passenger identity while preserving the Duffel DTO id assertion.
// User approved 2026-10-04: typed supplier-port wiring preserves partial snapshot coverage and assertions.

const INTENT_ID = 'intent-val-123';
const ENCRYPTION_KEY = 'a'.repeat(64);

function buildDomesticPassenger(
  overrides: Partial<BookingIntentPassengerRecord> = {},
): BookingIntentPassengerRecord {
  return {
    intentId: INTENT_ID,
    position: 0,
    type: PassengerType.ADULT,
    givenName: 'Grace',
    familyName: 'Hopper',
    middleName: 'Brewster',
    dateOfBirth: '1906-12-09',
    gender: 'female',
    title: 'ms',
    email: 'grace.hopper@navy.mil',
    phoneCountryCode: '+1',
    phoneNumber: '2025550199',
    documentType: null,
    passportNumber: null,
    passportExpiry: null,
    issuingCountry: null,
    nationality: 'US',
    travelerProfileId: null,
    supplierPassengerId: 'pas_duffel_001',
    snapshotVersion: 1,
    ...overrides,
  };
}

function buildInternationalPassenger(
  encryption: EncryptionService,
  options: {
    intentId?: string;
    position?: number;
    snapshotVersion?: number;
    passportNumberPlain?: string;
    passportExpiryPlain?: string;
    overrides?: Partial<BookingIntentPassengerRecord>;
  } = {},
): BookingIntentPassengerRecord {
  const intentId = options.intentId ?? INTENT_ID;
  const position = options.position ?? 0;
  const snapshotVersion = options.snapshotVersion ?? 1;
  const passportNumberPlain = options.passportNumberPlain ?? 'P98765432';
  const passportExpiryPlain = options.passportExpiryPlain ?? '2035-06-30';

  const passportNumber = encryption.encryptBound(passportNumberPlain, {
    snapshotVersion,
    intentId,
    position,
    fieldName: 'passportNumber',
  });

  const passportExpiry = encryption.encryptBound(passportExpiryPlain, {
    snapshotVersion,
    intentId,
    position,
    fieldName: 'passportExpiry',
  });

  return {
    intentId,
    position,
    type: PassengerType.ADULT,
    givenName: 'Ada',
    familyName: 'Lovelace',
    middleName: null,
    dateOfBirth: '1815-12-10',
    gender: 'female',
    title: 'ms',
    email: 'ada@lovelace.test',
    phoneCountryCode: '+44',
    phoneNumber: '7911123456',
    documentType: 'passport',
    passportNumber,
    passportExpiry,
    issuingCountry: 'GB',
    nationality: 'GB',
    travelerProfileId: 'profile-ada-1',
    supplierPassengerId: 'pas_duffel_002',
    snapshotVersion,
    ...(options.overrides ?? {}),
  };
}

function buildValidIntent(
  passengers: BookingIntentPassengerRecord[],
  overrides: Partial<BookingIntentForValidation> = {},
): BookingIntentForValidation {
  return {
    id: INTENT_ID,
    snapshotVersion: 1,
    passengers,
    rawOfferSnapshot: {
      id: 'off_test_1',
      expires_at: '2099-01-01T00:00:00.000Z',
      slices: [
        {
          segments: [
            {
              origin: { iata_code: 'LHR', iata_country_code: 'GB' },
              destination: { iata_code: 'JFK', iata_country_code: 'US' },
              arriving_at: '2026-09-01T12:00:00',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe('BookingPassengerFinalValidatorService', () => {
  let service: BookingPassengerFinalValidatorService;
  let encryptionService: EncryptionService;
  let observability: BookingReadinessObservability;
  let flightSearchPort: FlightSearchPort;
  let recordOutcomeSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
    encryptionService = new EncryptionService();
    observability = new BookingReadinessObservability();
    recordOutcomeSpy = jest.spyOn(observability, 'recordOutcome').mockImplementation();
    flightSearchPort = {
      search: async () => ({ offers: [], searchHash: '', cached: false }),
      getOfferById: async () => {
        throw new Error('Unexpected live offer lookup');
      },
      normalizeStoredOffer: () => null,
      normalizeStoredOfferFacts: jest.fn((rawOffer: unknown) =>
        normalizeSupplierStoredOfferFacts(rawOffer),
      ),
      // Approved 2026-10-04 per T061: passenger-only tests provide the required snapshot port method.
      normalizeStoredFlightSnapshot: () => null,
    };
    service = new BookingPassengerFinalValidatorService(
      encryptionService,
      observability,
      flightSearchPort,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('AAD bound decryption', () => {
    it('decrypts valid ciphertext bound to { snapshotVersion, intentId, position, fieldName } successfully', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        intentId: INTENT_ID,
        position: 0,
        snapshotVersion: 1,
        passportNumberPlain: 'UK998877A',
        passportExpiryPlain: '2033-11-20',
      });
      const intent = buildValidIntent([passenger]);

      const result = service.validate(intent, {
        now: new Date('2026-08-18T00:00:00.000Z'),
        tripCompletionDate: '2026-09-01',
      });

      expect(result.duffelPassengers).toHaveLength(1);
      const duffelPassenger = result.duffelPassengers[0];
      expect(duffelPassenger.identity_documents).toHaveLength(1);
      expect(duffelPassenger.identity_documents[0]).toEqual({
        type: 'passport',
        unique_identifier: 'UK998877A',
        expires_on: '2033-11-20',
        issuing_country_code: 'GB',
      });
    });

    it('rejects tampered ciphertext with SNAPSHOT_INTEGRITY_FAILURE', () => {
      const passenger = buildInternationalPassenger(encryptionService);
      passenger.passportNumber = 'v1:corrupted:tag:ciphertext';
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
        }),
      );
    });

    it('rejects ciphertext with swapped position with SNAPSHOT_INTEGRITY_FAILURE', () => {
      const passengerPosition0 = buildInternationalPassenger(encryptionService, { position: 0 });
      const passengerPosition1 = buildInternationalPassenger(encryptionService, { position: 1 });

      // Swapping ciphertexts between position 0 and position 1
      passengerPosition0.passportNumber = passengerPosition1.passportNumber;
      const intent = buildValidIntent([passengerPosition0]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
        }),
      );
    });

    it('rejects ciphertext with swapped intentId with SNAPSHOT_INTEGRITY_FAILURE', () => {
      const passengerOtherIntent = buildInternationalPassenger(encryptionService, {
        intentId: 'other-intent-999',
        position: 0,
      });
      const intent = buildValidIntent([passengerOtherIntent]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
        }),
      );
    });

    it('rejects ciphertext with swapped snapshotVersion with SNAPSHOT_INTEGRITY_FAILURE', () => {
      const passengerV2 = buildInternationalPassenger(encryptionService, {
        snapshotVersion: 2,
        position: 0,
      });
      // Declaring passenger snapshotVersion as 1 while ciphertext was encrypted with version 2
      passengerV2.snapshotVersion = 1;
      const intent = buildValidIntent([passengerV2]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
        }),
      );
    });
  });

  describe('Decrypt-then-expiry ordering', () => {
    it('fails with SNAPSHOT_INTEGRITY_FAILURE before checking document or offer expiry when ciphertext is corrupted', () => {
      const passenger = buildInternationalPassenger(encryptionService);
      passenger.passportNumber = 'v1:badiv:badtag:badpayload';
      // Provide an expired offer and expired trip completion date
      const intent = buildValidIntent([passenger], {
        rawOfferSnapshot: {
          expires_at: '2020-01-01T00:00:00.000Z',
        },
      });

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INTEGRITY_FAILURE' }),
        }),
      );
      expect(flightSearchPort.normalizeStoredOfferFacts).not.toHaveBeenCalled();
    });
  });

  describe('Live clock and trip completion date expiry', () => {
    it('rejects passport expiry before trip completion date with DOCUMENT_EXPIRED', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        passportExpiryPlain: '2026-08-30', // Before trip completion 2026-09-01
      });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'DOCUMENT_EXPIRED' }),
        }),
      );
    });

    it('uses normalized trip completion date instead of an earlier raw arrival', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        passportExpiryPlain: '2026-09-05',
      });
      const intent = buildValidIntent([passenger], {
        rawOfferSnapshot: {
          slices: [{
            segments: [{
              origin: { countryCode: 'US' },
              destination: { countryCode: 'US' },
              arrivalDate: '2026-09-01T12:00:00',
            }],
          }],
        },
      });
      jest.spyOn(flightSearchPort, 'normalizeStoredOfferFacts').mockReturnValue({
        travelScope: 'INTERNATIONAL',
        tripCompletionDate: '2026-09-10',
        offerExpiresAt: null,
      });

      expect(() =>
        service.validate(intent, { now: new Date('2026-08-18T00:00:00.000Z') }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'DOCUMENT_EXPIRED' }),
        }),
      );
    });

    it('rejects passport expiry on or before live current date with DOCUMENT_EXPIRED', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        passportExpiryPlain: '2026-08-17', // Yesterday relative to 2026-08-18
      });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-08-17',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'DOCUMENT_EXPIRED' }),
        }),
      );
    });
  });

  describe('Offer expiry in rawOfferSnapshot', () => {
    it('rejects expired offer in rawOfferSnapshot with OFFER_EXPIRED and 409 status', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        passportExpiryPlain: '2030-01-01',
      });
      const intent = buildValidIntent([passenger], {
        rawOfferSnapshot: {
          id: 'off_expired',
          expires_at: '2026-08-18T08:00:00.000Z', // Before now 10:00:00
        },
      });

      expect(() =>
        service.validate(intent, {
          now: new Date('2026-08-18T10:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          response: expect.objectContaining({ code: 'OFFER_EXPIRED' }),
        }),
      );
    });

    it('rejects expired offer when offerExpiresAt is in the past', () => {
      const passenger = buildDomesticPassenger();
      const intent = buildValidIntent([passenger], {
        offerExpiresAt: new Date('2026-08-18T08:00:00.000Z'),
        rawOfferSnapshot: {},
      });

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T10:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'OFFER_EXPIRED' }),
        }),
      );
    });

    it('rejects expired normalized stored expiry when raw evidence has only a future expiry', () => {
      const passenger = buildDomesticPassenger();
      const intent = buildValidIntent([passenger], {
        offerExpiresAt: null,
        rawOfferSnapshot: { expires_at: '2099-01-01T00:00:00.000Z' },
      });
      jest.spyOn(flightSearchPort, 'normalizeStoredOfferFacts').mockReturnValue({
        travelScope: null,
        tripCompletionDate: null,
        offerExpiresAt: '2026-08-18T08:00:00.000Z',
      });

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T10:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          status: 409,
          response: expect.objectContaining({ code: 'OFFER_EXPIRED' }),
        }),
      );
      expect(flightSearchPort.normalizeStoredOfferFacts).toHaveBeenCalledTimes(1);
    });
  });

  describe('Domestic vs International scope', () => {
    it('validates domestic snapshot without passport documents and returns empty identity_documents', () => {
      const passenger = buildDomesticPassenger({
        passportNumber: null,
        passportExpiry: null,
        documentType: null,
        issuingCountry: null,
      });
      const intent = buildValidIntent([passenger], {
        rawOfferSnapshot: {
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'LAX', iata_country_code: 'US' },
                  destination: { iata_code: 'JFK', iata_country_code: 'US' },
                  arriving_at: '2026-09-01T12:00:00',
                },
              ],
            },
          ],
        },
      });

      const result = service.validate(intent, {
        now: new Date('2026-08-18T00:00:00.000Z'),
      });

      expect(result.scope).toBe('DOMESTIC');
      expect(result.duffelPassengers).toHaveLength(1);
      expect(result.duffelPassengers[0]).toEqual(
        expect.objectContaining({
          given_name: 'Grace',
          family_name: 'Hopper',
          identity_documents: [],
        }),
      );
    });

    it('uses normalized international scope when raw route facts appear domestic', () => {
      const passenger = buildDomesticPassenger();
      const intent = buildValidIntent([passenger], {
        rawOfferSnapshot: {
          slices: [{
            segments: [{
              origin: { countryCode: 'US' },
              destination: { countryCode: 'US' },
              arrivalDate: '2026-09-01T12:00:00',
            }],
          }],
        },
      });
      jest.spyOn(flightSearchPort, 'normalizeStoredOfferFacts').mockReturnValue({
        travelScope: 'INTERNATIONAL',
        tripCompletionDate: '2026-09-10',
        offerExpiresAt: null,
      });

      expect(() =>
        service.validate(intent, { now: new Date('2026-08-18T00:00:00.000Z') }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
        }),
      );
    });

    it('rejects international snapshot when travel document fields are missing with SNAPSHOT_INCOMPLETE', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        overrides: {
          issuingCountry: null, // missing issuing country
        },
      });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          scope: 'INTERNATIONAL',
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
        }),
      );
    });
  });

  describe('Incomplete snapshot and Date of Birth validation', () => {
    it('rejects missing identity fields with SNAPSHOT_INCOMPLETE', () => {
      const passenger = buildDomesticPassenger({ givenName: '' });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
        }),
      );
    });

    it('rejects missing contact fields with SNAPSHOT_INCOMPLETE', () => {
      const passenger = buildDomesticPassenger({ email: null });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
        }),
      );
    });

    it('rejects empty passenger list with SNAPSHOT_INCOMPLETE', () => {
      const intent = buildValidIntent([]);

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'SNAPSHOT_INCOMPLETE' }),
        }),
      );
    });

    it('rejects date of birth in future relative to live clock with INVALID_DATE_OF_BIRTH', () => {
      const passenger = buildDomesticPassenger({
        dateOfBirth: '2030-01-01', // Future date
      });
      const intent = buildValidIntent([passenger]);

      expect(() =>
        service.validate(intent, {
          scope: 'DOMESTIC',
          now: new Date('2026-08-18T00:00:00.000Z'),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: expect.stringMatching(/^(INVALID_DATE_OF_BIRTH|SNAPSHOT_INCOMPLETE)$/),
          }),
        }),
      );
    });
  });

  describe('Ephemeral Duffel Passenger DTO generation', () => {
    it('returns valid ephemeral in-memory Duffel passenger DTO structure', () => {
      const passenger = buildInternationalPassenger(encryptionService, {
        passportNumberPlain: 'P55443322',
        passportExpiryPlain: '2034-10-15',
      });
      const intent = buildValidIntent([passenger]);

      const result = service.validate(intent, {
        now: new Date('2026-08-18T00:00:00.000Z'),
        tripCompletionDate: '2026-09-01',
      });

      expect(result.duffelPassengers).toEqual([
        {
          id: 'pas_duffel_002',
          type: 'adult',
          given_name: 'Ada',
          family_name: 'Lovelace',
          born_on: '1815-12-10',
          gender: 'f',
          title: 'ms',
          email: 'ada@lovelace.test',
          phone_number: '+447911123456',
          identity_documents: [
            {
              type: 'passport',
              unique_identifier: 'P55443322',
              expires_on: '2034-10-15',
              issuing_country_code: 'GB',
            },
          ],
        },
      ]);
    });
  });

  describe('Privacy and PII-Safe observability', () => {
    it('ensures zero plaintext PII in thrown exceptions or error payloads', () => {
      const secretPassport = 'SECRET_PASSPORT_999';
      const passenger = buildInternationalPassenger(encryptionService, {
        passportNumberPlain: secretPassport,
      });
      passenger.passportNumber = 'v1:bad:bad:bad';
      const intent = buildValidIntent([passenger]);

      let caughtError: unknown;
      try {
        service.validate(intent, {
          now: new Date('2026-08-18T00:00:00.000Z'),
          tripCompletionDate: '2026-09-01',
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      const stringified = JSON.stringify(caughtError);
      expect(stringified).not.toContain(secretPassport);
      expect(stringified).not.toContain('ada@lovelace.test');
      expect(stringified).not.toContain('7911123456');
    });

    it('records structured PII-safe outcomes via BookingReadinessObservability', () => {
      const passenger = buildInternationalPassenger(encryptionService);
      const intent = buildValidIntent([passenger]);
      const context = { traceId: 'trace-123', correlationId: 'corr-456' };

      service.validate(intent, {
        now: new Date('2026-08-18T00:00:00.000Z'),
        tripCompletionDate: '2026-09-01',
        context,
      });

      expect(recordOutcomeSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: BookingReadinessOperation.FINAL_PASSENGER_VALIDATION,
          status: 'valid',
          context,
          metadata: expect.objectContaining({
            scope: 'INTERNATIONAL',
            passengerCount: 1,
          }),
        }),
      );
    });
  });
});
