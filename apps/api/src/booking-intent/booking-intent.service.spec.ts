import 'reflect-metadata';
// User approved 2026-10-04: additive public booking-boundary regression preserving existing binding coverage.
import { BookingIntentService } from './booking-intent.service';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  ForbiddenException,
  GoneException,
  Logger,
} from '@nestjs/common';
import { PassengerSnapshotService } from './passenger-snapshot.service';
import { PassengerSourceResolverService } from './passenger-source-resolver.service';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { FLIGHT_SEARCH_PORT } from '@/supplier/search/flight-search.port';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { BookingReadinessService } from './booking-readiness.service';
import { PassengerType } from '@prisma/client';

type MockEncryptionService = {
  encrypt: jest.Mock;
  decrypt: jest.Mock;
  encryptBound: jest.Mock;
  decryptBound: jest.Mock;
};

type MockFlightSearchPort = {
  getOfferById: jest.Mock;
  search: jest.Mock;
  normalizeStoredOffer: jest.Mock;
};

type MockPrismaService = {
  bookingIntent: {
    findMany: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
    findUnique: jest.Mock;
  };
  $transaction: jest.Mock;
};

type MockAuditService = {
  createLog: jest.Mock;
};

type TestableService = {
  decryptProfileField(value: string | null): string | null;
  fetchLiveOffer(supplierOfferId: string): Promise<{
    totalAmount: string;
    currency: string;
    offerExpiresAt: Date | null;
    raw: unknown;
    passengers: readonly import('@/supplier/search/flight-search.port').FlightOfferPassenger[];
  }>;
  extractSupplierPassengerIds(
    supplierPassengers: readonly import('@/supplier/search/flight-search.port').FlightOfferPassenger[],
    bookingPassengers: Array<{ type: import('@prisma/client').PassengerType }>,
  ): string[];
};

type CanonicalPrismaMock = {
  flightOffer: { findUnique: jest.Mock };
  travelerProfile: { findFirst: jest.Mock; findUnique?: jest.Mock };
  bookingIntent: {
    create: jest.Mock;
    findUnique?: jest.Mock;
    findMany?: jest.Mock;
    updateMany?: jest.Mock;
    deleteMany?: jest.Mock;
  };
  bookingIntentPassenger: { create: jest.Mock; createMany?: jest.Mock };
  $transaction: jest.Mock;
};

describe('BookingIntentService Refinements', () => {
  let testable: TestableService;
  let mockEncryptionService: MockEncryptionService;
  let mockFlightSearchPort: MockFlightSearchPort;

  beforeEach(() => {
    mockEncryptionService = {
      encrypt: jest.fn(),
      decrypt: jest.fn((val: string) => `decrypted-${val}`),
      encryptBound: jest.fn((val: string) => `bound-${val}`),
      decryptBound: jest.fn(),
    };

    mockFlightSearchPort = {
      getOfferById: jest.fn(),
      search: jest.fn(),
      normalizeStoredOffer: jest.fn(),
    };

    const service = new BookingIntentService(
      {} as never,
      mockFlightSearchPort as never,
      {} as never,
      mockEncryptionService as never,
    );
    testable = service as unknown as TestableService;
  });

  describe('decryptProfileField', () => {
    it('returns null if value is null', () => {
      const result = testable.decryptProfileField(null);
      expect(result).toBeNull();
    });

    it('returns legacy plaintext as-is even if it contains colons', () => {
      const legacyValue = 'plain:text:with:colons';
      const result = testable.decryptProfileField(legacyValue);
      expect(result).toBe(legacyValue);
      expect(mockEncryptionService.decrypt).not.toHaveBeenCalled();
    });

    it('decrypts value if it starts with recognized marker v1:', () => {
      const encryptedValue = 'v1:ciphertext-here';
      const result = testable.decryptProfileField(encryptedValue);
      expect(result).toBe('decrypted-ciphertext-here');
      expect(mockEncryptionService.decrypt).toHaveBeenCalledWith('ciphertext-here');
    });

    it('returns null if decryption throws error', () => {
      mockEncryptionService.decrypt.mockImplementationOnce(() => {
        throw new Error('decryption failed');
      });
      const result = testable.decryptProfileField('v1:bad-cipher');
      expect(result).toBeNull();
    });
  });

  describe('canonical passenger persistence', () => {
    it('does not recover missing normalized passenger identities from opaque supplier evidence', async () => {
      const flightOfferId = '11111111-1111-4111-8111-111111111111';
      const intentCreate = jest.fn().mockResolvedValue({
        id: 'intent-1',
        status: 'PENDING',
        priceChanged: false,
        currency: 'USD',
        pricedAt: new Date('2026-08-01T00:00:00.000Z'),
        intentExpiresAt: new Date('2026-08-01T00:30:00.000Z'),
        offerExpiresAt: null,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-10T00:00:00.000Z'),
        returnDate: null,
        cabinClass: 'ECONOMY',
      });
      const passengerCreate = jest.fn().mockResolvedValue({ id: 'passenger-1' });
      const transactionClient = {
        bookingIntent: { create: intentCreate },
        bookingIntentPassenger: { create: passengerCreate },
        travelerProfile: { findFirst: jest.fn() },
      };
      const prisma = {
        flightOffer: {
          findUnique: jest.fn().mockResolvedValue({
            id: flightOfferId,
            supplierOfferId: 'supplier-offer-1',
            price: 150,
            origin: 'SGN',
            destination: 'HAN',
            departureDate: new Date('2026-08-10T00:00:00.000Z'),
            returnDate: null,
            cabinClass: 'ECONOMY',
            adults: 1,
            children: 0,
            infants: 0,
          }),
        },
        $transaction: jest.fn(
          async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
            callback(transactionClient),
        ),
      };
      const supplier = {
        getOfferById: jest.fn().mockResolvedValue({
          id: 'offer-1',
          supplierOfferId: 'supplier-offer-1',
          totalAmount: '150.00',
          currency: 'USD',
          offerExpiresAt: null,
          passengers: [],
          rawSupplierPayload: {
            passengers: [{ id: 'pas_opaque_1', type: 'adult' }],
          },
        }),
        search: jest.fn(),
        normalizeStoredOffer: jest.fn(),
      };
      const encryption = {
        encrypt: jest.fn(),
        decrypt: jest.fn(),
        encryptBound: jest.fn(),
        decryptBound: jest.fn(),
      };
      const readiness = {
        evaluateAuthoritativeReadiness: jest
          .fn()
          .mockResolvedValue({ ready: true, scope: 'DOMESTIC' }),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          BookingIntentService,
          PassengerSourceResolverService,
          PassengerSnapshotService,
          { provide: PrismaService, useValue: prisma },
          { provide: FLIGHT_SEARCH_PORT, useValue: supplier },
          { provide: AuditService, useValue: { createLog: jest.fn() } },
          { provide: EncryptionService, useValue: encryption },
          { provide: BookingReadinessService, useValue: readiness },
        ],
      }).compile();

      try {
        const service = moduleRef.get(BookingIntentService);

        await expect(
          service.createIntent('user-1', {
            flightOfferId,
            passengers: [
              {
                offerPassengerId: 'pas_001',
                type: PassengerType.ADULT,
                source: {
                  type: 'inline',
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
              },
            ],
          }),
        ).rejects.toMatchObject({ response: { code: 'UPSTREAM_UNAVAILABLE' } });

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(intentCreate).not.toHaveBeenCalled();
        expect(passengerCreate).not.toHaveBeenCalled();
      } finally {
        await moduleRef.close();
      }
    });

    it('resolves an inline source before persisting the immutable passenger snapshot', async () => {
      const offerId = 'offer-1';
      const prisma = {} as CanonicalPrismaMock;
      prisma.flightOffer = {
        findUnique: jest.fn().mockResolvedValue({
          id: offerId,
          supplierOfferId: 'duffel-offer-1',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        }),
      };
      prisma.travelerProfile = { findFirst: jest.fn() };
      prisma.bookingIntent = {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'intent-1', status: 'PENDING', ...data }),
          ),
      };
      prisma.bookingIntentPassenger = {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'snapshot-passenger-1', ...data }),
          ),
      };
      prisma.$transaction = jest.fn(
        async (callback: (tx: CanonicalPrismaMock) => Promise<unknown>) => callback(prisma),
      );
      const duffel = {
        getOfferById: jest.fn().mockResolvedValue({
          id: 'offer-1',
          supplierOfferId: 'duffel-offer-1',
          totalAmount: '150.00',
          price: 150,
          currency: 'USD',
          offerExpiresAt: null,
          passengers: [{ supplierPassengerId: 'duffel-passenger-1', type: 'ADULT' }],
          rawSupplierPayload: {
            passengers: [{ id: 'duffel-passenger-1', type: 'adult' }],
          },
        }),
        search: jest.fn(),
        normalizeStoredOffer: jest.fn(),
      };
      const audit = { createLog: jest.fn() };
      const encryption = {
        encrypt: jest.fn(),
        decrypt: jest.fn(),
        encryptBound: jest.fn(),
        decryptBound: jest.fn(),
      };
      const resolver = new PassengerSourceResolverService(prisma as never, encryption as never);
      const snapshot = new PassengerSnapshotService(encryption as never);
      const readiness = {
        evaluateAuthoritativeReadiness: jest
          .fn()
          .mockResolvedValue({ ready: true, scope: 'DOMESTIC' }),
      };
      const Service = BookingIntentService as unknown as new (
        ...args: unknown[]
      ) => BookingIntentService;
      const service = new Service(prisma, duffel, audit, encryption, readiness, resolver, snapshot);

      const result = await service.createIntent('user-1', {
        flightOfferId: offerId,
        passengers: [
          {
            offerPassengerId: 'pas_001',
            type: 'ADULT',
            source: {
              type: 'inline',
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
          },
        ],
      } as never);

      expect(result.passengers[0]).toEqual(
        expect.objectContaining({
          passengerType: 'ADULT',
          passengerOrdinal: 1,
          nameSummary: expect.stringMatching(/^G/),
          documentSummary: {
            documentType: null,
            issuingCountry: null,
            hasPassport: false,
            maskedPassportSummary: null,
          },
          contactSummary: {
            email: expect.stringMatching(/^g/),
            phone: expect.stringMatching(/^\+1/),
            maskedContactSummary: expect.stringMatching(/^g.* \+1/),
          },
          maskedPassportSummary: null,
          maskedContactSummary: expect.stringMatching(/^g.* \+1/),
          passportNumber: null,
          passportExpiry: null,
          preFilledFromProfile: false,
        }),
      );
      expect(result.passengers[0]).not.toHaveProperty('givenName');
      expect(prisma.bookingIntentPassenger.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          intentId: expect.any(String),
          givenName: 'Grace',
          familyName: 'Hopper',
          gender: 'female',
          email: 'grace@example.test',
          travelerProfileId: null,
          supplierPassengerId: 'duffel-passenger-1',
          snapshotVersion: 1,
        }),
      });
      const createdIntentId = (prisma.bookingIntent.create as jest.Mock).mock.calls[0][0].data.id;
      const snapshotIntentId = (prisma.bookingIntentPassenger.create as jest.Mock).mock.calls[0][0]
        .data.intentId;
      expect(snapshotIntentId).toBe(createdIntentId);

      const auditMetadata = JSON.stringify(audit.createLog.mock.calls[0][1].metadata);
      expect(auditMetadata).toContain('intent_create');
      expect(auditMetadata).not.toContain('user-1');
      expect(auditMetadata).not.toContain('offer-1');
      expect(auditMetadata).not.toContain('intent-1');
    });

    it('rejects a traveler profile source that changes before the create transaction commits', async () => {
      const prisma = {} as CanonicalPrismaMock;
      prisma.flightOffer = {
        findUnique: jest.fn().mockResolvedValue({
          id: 'offer-1',
          supplierOfferId: 'duffel-offer-1',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        }),
      };
      const profile = {
        id: 'profile-1',
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
        documentType: null,
        issuingCountry: null,
        passportNumber: null,
        passportExpiry: null,
        passportExpiryCiphertext: null,
      };
      prisma.travelerProfile = {
        findFirst: jest.fn().mockResolvedValueOnce(profile).mockResolvedValueOnce({ revision: 4 }),
      };
      prisma.bookingIntent = {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 'intent-1', status: 'PENDING', ...data }),
          ),
      };
      prisma.bookingIntentPassenger = {
        create: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ id: 'passenger-1', ...data })),
      };
      prisma.$transaction = jest.fn(
        async (callback: (tx: CanonicalPrismaMock) => Promise<unknown>) => callback(prisma),
      );

      const duffel = {
        getOfferById: jest.fn().mockResolvedValue({
          id: 'offer-1',
          supplierOfferId: 'duffel-offer-1',
          totalAmount: '150.00',
          price: 150,
          currency: 'USD',
          offerExpiresAt: null,
          passengers: [{ supplierPassengerId: 'duffel-passenger-1', type: 'ADULT' }],
          rawSupplierPayload: {
            passengers: [{ id: 'duffel-passenger-1', type: 'adult' }],
          },
        }),
        search: jest.fn(),
        normalizeStoredOffer: jest.fn(),
      };
      const encryption = {
        encrypt: jest.fn(),
        decrypt: jest.fn(),
        encryptBound: jest.fn(),
        decryptBound: jest.fn(),
      };
      const resolver = new PassengerSourceResolverService(prisma as never, encryption as never);
      const snapshot = new PassengerSnapshotService(encryption as never);
      const readiness = {
        evaluateAuthoritativeReadiness: jest
          .fn()
          .mockResolvedValue({ ready: true, scope: 'DOMESTIC' }),
      };
      const service = new (BookingIntentService as unknown as new (
        ...args: unknown[]
      ) => BookingIntentService)(
        prisma,
        duffel,
        { createLog: jest.fn() },
        encryption,
        readiness,
        resolver,
        snapshot,
      );

      await expect(
        service.createIntent('user-1', {
          flightOfferId: 'offer-1',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'traveler_profile',
                travelerProfileId: 'profile-1',
                expectedProfileRevision: 3,
              },
            },
          ],
        } as never),
      ).rejects.toMatchObject({ response: { code: 'PROFILE_CHANGED' } });
      expect(prisma.bookingIntent.create).not.toHaveBeenCalled();
    });
  });

  describe('Authoritative intent creation and zero-write transactions', () => {
    let prisma: CanonicalPrismaMock;
    let duffel: MockFlightSearchPort;
    let audit: { createLog: jest.Mock };
    let encryption: MockEncryptionService;
    let readinessService: { evaluateAuthoritativeReadiness: jest.Mock };
    let readinessObservability: { recordOutcome: jest.Mock };
    let resolver: PassengerSourceResolverService;
    let snapshot: PassengerSnapshotService;
    let service: BookingIntentService;

    beforeEach(() => {
      prisma = {
        flightOffer: { findUnique: jest.fn() },
        travelerProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
        bookingIntent: {
          create: jest
            .fn()
            .mockImplementation(({ data }) =>
              Promise.resolve({ id: data.id || 'intent-1', status: 'PENDING', ...data }),
            ),
          findUnique: jest.fn(),
        },
        bookingIntentPassenger: {
          create: jest
            .fn()
            .mockImplementation(({ data }) =>
              Promise.resolve({ id: `passenger-${Math.random()}`, ...data }),
            ),
        },
        $transaction: jest.fn(async (callback: (tx: CanonicalPrismaMock) => Promise<unknown>) =>
          callback(prisma),
        ),
      };

      duffel = {
        getOfferById: jest.fn().mockResolvedValue({
          id: 'offer-intl-1',
          supplierOfferId: 'duffel-intl-1',
          totalAmount: '350.00',
          price: 350,
          currency: 'USD',
          offerExpiresAt: null,
          passengers: [
            { supplierPassengerId: 'duffel-pas-1', type: 'ADULT' },
            { supplierPassengerId: 'duffel-pas-2', type: 'CHILD' },
          ],
          rawSupplierPayload: {
            passengers: [
              { id: 'duffel-pas-1', type: 'adult' },
              { id: 'duffel-pas-2', type: 'child' },
            ],
          },
        }),
        search: jest.fn(),
        normalizeStoredOffer: jest.fn(),
      };

      audit = { createLog: jest.fn().mockResolvedValue({ id: 'log-1' }) };

      encryption = {
        encrypt: jest.fn((val: string) => `enc-${val}`),
        decrypt: jest.fn((val: string) => `dec-${val}`),
        encryptBound: jest.fn(
          (val: string, ctx: Record<string, unknown>) => `bound-enc-${val}-${ctx.fieldName}`,
        ),
        decryptBound: jest.fn((val: string) => `bound-dec-${val}`),
      };

      readinessService = {
        evaluateAuthoritativeReadiness: jest.fn().mockResolvedValue({
          ready: true,
          scope: 'INTERNATIONAL',
          passengers: [],
          tripCompletionDate: '2026-08-10',
          advisoryBufferDays: 180,
        }),
      };

      readinessObservability = {
        recordOutcome: jest.fn(),
      };

      resolver = new PassengerSourceResolverService(prisma as never, encryption as never);
      snapshot = new PassengerSnapshotService(encryption as never);
      const Service = BookingIntentService as unknown as new (
        ...args: unknown[]
      ) => BookingIntentService;
      service = new Service(
        prisma as never,
        duffel as never,
        audit as never,
        encryption as never,
        readinessService as never,
        resolver,
        snapshot,
        undefined,
        readinessObservability as never,
      );
    });

    describe('Evaluator Parity & Zero-Write', () => {
      it('throws 422 BOOKING_NOT_READY and executes 0 database writes when passenger travel documents are invalid or expired for international flight', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-intl-1',
          supplierOfferId: 'duffel-intl-1',
          price: 500,
          origin: 'SGN',
          destination: 'NRT',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: new Date('2026-08-10T00:00:00.000Z'),
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
          rawOffer: {
            passengers: [{ id: 'duffel-pas-1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'NRT' },
                    arriving_at: '2026-08-01T10:00:00Z',
                  },
                ],
              },
            ],
          },
        });

        readinessService.evaluateAuthoritativeReadiness.mockResolvedValueOnce({
          ready: false,
          scope: 'INTERNATIONAL',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerOrdinal: 1,
              status: 'INVALID_DOCUMENT',
              missingFields: [],
              invalidFields: ['passportExpiry'],
            },
          ],
          tripCompletionDate: '2026-08-10',
          advisoryBufferDays: 180,
        });

        const callPromise = service.createIntent('user-1', {
          flightOfferId: 'offer-intl-1',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'inline',
                givenName: 'Alan',
                familyName: 'Turing',
                dateOfBirth: '1912-06-23',
                gender: 'male',
                nationality: 'GB',
                documentType: 'passport',
                passportNumber: 'GB12345678',
                passportExpiry: '2020-01-01',
                issuingCountry: 'GB',
                email: 'alan@turing.test',
                phoneCountryCode: '+44',
                phoneNumber: '7000000001',
                title: 'MR',
              },
            },
          ],
        } as never);

        await expect(callPromise).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            code: 'BOOKING_NOT_READY',
            ready: false,
            scope: 'INTERNATIONAL',
          }),
        });

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.bookingIntent.create).not.toHaveBeenCalled();
        expect(prisma.bookingIntentPassenger.create).not.toHaveBeenCalled();
      });

      it('throws 422 BOOKING_NOT_READY and executes 0 database writes when required domestic contact or identity fields are missing', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-dom-missing',
          supplierOfferId: 'duffel-dom-missing',
          price: 120,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
          rawOffer: {
            passengers: [{ id: 'duffel-pas-1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    arriving_at: '2026-08-01T10:00:00Z',
                  },
                ],
              },
            ],
          },
        });

        readinessService.evaluateAuthoritativeReadiness.mockResolvedValueOnce({
          ready: false,
          scope: 'DOMESTIC',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerOrdinal: 1,
              status: 'INCOMPLETE',
              missingFields: ['email', 'phoneNumber'],
              invalidFields: [],
            },
          ],
          tripCompletionDate: '2026-08-01',
          advisoryBufferDays: 180,
        });

        const callPromise = service.createIntent('user-1', {
          flightOfferId: 'offer-dom-missing',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'inline',
                givenName: 'Claude',
                familyName: 'Shannon',
                dateOfBirth: '1916-04-30',
                gender: 'male',
                nationality: 'US',
                title: 'MR',
              },
            },
          ],
        } as never);

        await expect(callPromise).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            code: 'BOOKING_NOT_READY',
            ready: false,
            scope: 'DOMESTIC',
          }),
        });

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.bookingIntent.create).not.toHaveBeenCalled();
        expect(prisma.bookingIntentPassenger.create).not.toHaveBeenCalled();
      });
    });

    describe('Profile Revision Race', () => {
      it('aborts transaction and throws 409 ConflictException (PROFILE_CHANGED) writing 0 rows when profile revision advances before commit', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-race-1',
          supplierOfferId: 'duffel-race-1',
          price: 200,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const initialProfile = {
          id: 'profile-race-1',
          revision: 2,
          givenName: 'Katherine',
          middleName: null,
          familyName: 'Johnson',
          dateOfBirth: new Date('1918-08-26T00:00:00.000Z'),
          gender: 'female',
          title: 'DR',
          email: 'katherine@nasa.test',
          phoneCountryCode: '+1',
          phoneNumber: '5550001111',
          nationality: 'US',
          documentType: 'passport',
          issuingCountry: 'US',
          passportNumber: 'v1:enc-passport',
          passportExpiry: new Date('2030-01-01T00:00:00.000Z'),
          passportExpiryCiphertext: null,
        };

        // First call during resolver resolution returns revision 2;
        // Second call inside transaction in assertCanonicalProfileRevisions returns revision 3 (advancement race)
        prisma.travelerProfile.findFirst = jest
          .fn()
          .mockResolvedValueOnce(initialProfile)
          .mockResolvedValueOnce({ revision: 3 });

        const callPromise = service.createIntent('user-1', {
          flightOfferId: 'offer-race-1',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'traveler_profile',
                travelerProfileId: 'profile-race-1',
                expectedProfileRevision: 2,
              },
            },
          ],
        } as never);

        await expect(callPromise).rejects.toMatchObject({
          response: { code: 'PROFILE_CHANGED' },
        });

        // Zero-write assertion: bookingIntent and passenger creation never occurred because revision check failed at top of transaction
        expect(prisma.bookingIntent.create).not.toHaveBeenCalled();
        expect(prisma.bookingIntentPassenger.create).not.toHaveBeenCalled();
      });
    });

    describe('Multi-Passenger Pre-Validation & Atomic Persistence', () => {
      it('fails multi-passenger intent pre-validation with 422 and 0 writes if any passenger source is invalid', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-multi-1',
          supplierOfferId: 'duffel-multi-1',
          price: 450,
          origin: 'SGN',
          destination: 'NRT',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 1,
          infants: 0,
          rawOffer: {
            passengers: [
              { id: 'duffel-pas-1', type: 'adult' },
              { id: 'duffel-pas-2', type: 'child' },
            ],
            slices: [],
          },
        });

        readinessService.evaluateAuthoritativeReadiness.mockResolvedValueOnce({
          ready: false,
          scope: 'INTERNATIONAL',
          passengers: [
            {
              offerPassengerId: 'pas_adult_1',
              passengerOrdinal: 1,
              status: 'READY',
              missingFields: [],
              invalidFields: [],
            },
            {
              offerPassengerId: 'pas_child_1',
              passengerOrdinal: 2,
              status: 'INCOMPLETE',
              missingFields: ['passportNumber'],
              invalidFields: [],
            },
          ],
          tripCompletionDate: '2026-08-10',
          advisoryBufferDays: 180,
        });

        const callPromise = service.createIntent('user-1', {
          flightOfferId: 'offer-multi-1',
          passengers: [
            {
              offerPassengerId: 'pas_adult_1',
              type: 'ADULT',
              source: {
                type: 'inline',
                givenName: 'John',
                familyName: 'VonNeumann',
                dateOfBirth: '1903-12-28',
                gender: 'male',
                nationality: 'US',
                documentType: 'passport',
                passportNumber: 'US99887766',
                passportExpiry: '2030-01-01',
                issuingCountry: 'US',
                email: 'john@princeton.test',
                phoneCountryCode: '+1',
                phoneNumber: '5551112222',
                title: 'MR',
              },
            },
            {
              offerPassengerId: 'pas_child_1',
              type: 'CHILD',
              source: {
                type: 'inline',
                givenName: 'Marina',
                familyName: 'VonNeumann',
                dateOfBirth: '2015-05-15',
                gender: 'female',
                nationality: 'US',
                documentType: 'passport',
                passportNumber: '',
                passportExpiry: '2030-01-01',
                issuingCountry: 'US',
                email: 'marina@princeton.test',
                phoneCountryCode: '+1',
                phoneNumber: '5551112222',
                title: 'MISS',
              },
            },
          ],
        } as never);

        await expect(callPromise).rejects.toMatchObject({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          response: expect.objectContaining({
            code: 'BOOKING_NOT_READY',
            ready: false,
          }),
        });

        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.bookingIntent.create).not.toHaveBeenCalled();
        expect(prisma.bookingIntentPassenger.create).not.toHaveBeenCalled();
      });

      it('atomically creates multi-passenger intent, snapshots with bound AAD encryption, and audit record when all passengers are valid', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-multi-valid',
          supplierOfferId: 'duffel-multi-valid',
          price: 450,
          origin: 'SGN',
          destination: 'NRT',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 1,
          infants: 0,
          rawOffer: {
            passengers: [
              { id: 'duffel-pas-1', type: 'adult' },
              { id: 'duffel-pas-2', type: 'child' },
            ],
            slices: [],
          },
        });

        readinessService.evaluateAuthoritativeReadiness.mockResolvedValueOnce({
          ready: true,
          scope: 'INTERNATIONAL',
          passengers: [
            {
              offerPassengerId: 'pas_adult_1',
              passengerOrdinal: 1,
              status: 'READY',
              missingFields: [],
              invalidFields: [],
            },
            {
              offerPassengerId: 'pas_child_1',
              passengerOrdinal: 2,
              status: 'READY',
              missingFields: [],
              invalidFields: [],
            },
          ],
          tripCompletionDate: '2026-08-10',
          advisoryBufferDays: 180,
        });
        const traceId = 'chat_0123456789abcdef0123456789abcdef';
        const correlationId = 'chat_fedcba9876543210fedcba9876543210';

        const result = await service.createIntent(
          'user-1',
          {
            flightOfferId: 'offer-multi-valid',
            passengers: [
              {
                offerPassengerId: 'pas_adult_1',
                type: 'ADULT',
                source: {
                  type: 'inline',
                  givenName: 'John',
                  familyName: 'VonNeumann',
                  dateOfBirth: '1903-12-28',
                  gender: 'male',
                  nationality: 'US',
                  documentType: 'passport',
                  passportNumber: 'US99887766',
                  passportExpiry: '2030-01-01',
                  issuingCountry: 'US',
                  email: 'john@princeton.test',
                  phoneCountryCode: '+1',
                  phoneNumber: '5551112222',
                  title: 'MR',
                },
              },
              {
                offerPassengerId: 'pas_child_1',
                type: 'CHILD',
                source: {
                  type: 'inline',
                  givenName: 'Marina',
                  familyName: 'VonNeumann',
                  dateOfBirth: '2015-05-15',
                  gender: 'female',
                  nationality: 'US',
                  documentType: 'passport',
                  passportNumber: 'US33445566',
                  passportExpiry: '2030-01-01',
                  issuingCountry: 'US',
                  email: 'marina@princeton.test',
                  phoneCountryCode: '+1',
                  phoneNumber: '5551112222',
                  title: 'MISS',
                },
              },
            ],
          } as never,
          { traceId, correlationId, ipAddress: '10.0.0.1' },
        );

        expect(result.intentId).toBeDefined();
        expect(result.passengers).toHaveLength(2);
        expect(result.passengers[0].passengerType).toBe('ADULT');
        expect(result.passengers[1].passengerType).toBe('CHILD');

        // Verify atomic transaction was executed
        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(prisma.bookingIntent.create).toHaveBeenCalledTimes(1);
        expect(prisma.bookingIntentPassenger.create).toHaveBeenCalledTimes(2);

        // Verify bound AAD encryption calls for each passenger
        expect(encryption.encryptBound).toHaveBeenCalledWith(
          'US99887766',
          expect.objectContaining({
            snapshotVersion: 1,
            intentId: result.intentId,
            position: 0,
            fieldName: 'passportNumber',
          }),
        );
        expect(encryption.encryptBound).toHaveBeenCalledWith(
          'US33445566',
          expect.objectContaining({
            snapshotVersion: 1,
            intentId: result.intentId,
            position: 1,
            fieldName: 'passportNumber',
          }),
        );

        // Verify audit log creation inside transaction
        expect(audit.createLog).toHaveBeenCalledTimes(1);
        expect(audit.createLog).toHaveBeenCalledWith(
          prisma,
          expect.objectContaining({
            userId: 'user-1',
            action: 'booking_intent_created',
            resourceType: 'BookingIntent',
            resourceId: result.intentId,
            traceId,
            correlationId,
          }),
        );
      });
    });

    describe('Snapshot Immutability', () => {
      it('persisted passenger snapshots retain exact captured data independently of subsequent TravelerProfile changes or deletion', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-snap-1',
          supplierOfferId: 'duffel-snap-1',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const originalProfile = {
          id: 'profile-snap-1',
          revision: 1,
          givenName: 'Margaret',
          middleName: 'Hamilton',
          familyName: 'Heafield',
          dateOfBirth: new Date('1936-08-17T00:00:00.000Z'),
          gender: 'female',
          title: 'MS',
          email: 'margaret@apollo.test',
          phoneCountryCode: '+1',
          phoneNumber: '5559998888',
          nationality: 'US',
          documentType: 'passport',
          issuingCountry: 'US',
          passportNumber: 'v1:encrypted-apollo-passport',
          passportExpiry: new Date('2032-01-01T00:00:00.000Z'),
          passportExpiryCiphertext: null,
        };

        prisma.travelerProfile.findFirst = jest.fn().mockResolvedValue(originalProfile);

        const createResult = await service.createIntent('user-1', {
          flightOfferId: 'offer-snap-1',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'traveler_profile',
                travelerProfileId: 'profile-snap-1',
                expectedProfileRevision: 1,
              },
            },
          ],
        } as never);

        // Verify the created passenger snapshot payload passed to DB create
        const snapshotCreateCall = (prisma.bookingIntentPassenger.create as jest.Mock).mock
          .calls[0][0].data;
        expect(snapshotCreateCall).toEqual(
          expect.objectContaining({
            givenName: 'Margaret',
            familyName: 'Heafield',
            middleName: 'Hamilton',
            gender: 'female',
            email: 'margaret@apollo.test',
            travelerProfileId: 'profile-snap-1',
            snapshotVersion: 1,
          }),
        );

        // Now simulate TravelerProfile being updated to completely different values or deleted
        prisma.travelerProfile.findFirst = jest.fn().mockResolvedValue({
          id: 'profile-snap-1',
          revision: 5,
          givenName: 'Tampered',
          familyName: 'Profile',
          email: 'tampered@evil.test',
        });

        // Query intent via getIntent - which reads directly from bookingIntent + bookingIntentPassenger
        (prisma.bookingIntent.findUnique as jest.Mock) = jest.fn().mockResolvedValue({
          id: createResult.intentId,
          userId: 'user-1',
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 150,
          priceChanged: false,
          currency: 'USD',
          pricedAt: new Date('2026-08-01T10:00:00Z'),
          intentExpiresAt: new Date('2026-08-01T10:30:00Z'),
          offerExpiresAt: null,
          createdAt: new Date('2026-08-01T09:50:00Z'),
          passengers: [
            {
              id: 'snapshot-row-1',
              position: 0,
              type: 'ADULT',
              givenName: snapshotCreateCall.givenName,
              familyName: snapshotCreateCall.familyName,
              dateOfBirth: snapshotCreateCall.dateOfBirth,
              gender: snapshotCreateCall.gender,
              nationality: snapshotCreateCall.nationality,
              passportNumber: snapshotCreateCall.passportNumber,
              passportExpiry: snapshotCreateCall.passportExpiry,
              email: snapshotCreateCall.email,
              phoneCountryCode: snapshotCreateCall.phoneCountryCode,
              phoneNumber: snapshotCreateCall.phoneNumber,
              travelerProfileId: snapshotCreateCall.travelerProfileId,
            },
          ],
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const fetched = await service.getIntent('user-1', createResult.intentId);
        expect(fetched.passengers[0].nameSummary).toMatch(/^M/);
        expect(fetched.passengers[0].preFilledFromProfile).toBe(true);
        expect(fetched.passengers[0].contactSummary.email).toMatch(/^m/);
      });
    });

    describe('PII-Safe Audit Logging', () => {
      it('emits structured audit log inside transaction with traceId/correlationId and zero PII in metadata', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-audit-1',
          supplierOfferId: 'duffel-audit-1',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const traceId = 'chat_11111111111111111111111111111111';
        const correlationId = 'chat_22222222222222222222222222222222';

        await service.createIntent(
          'user-1',
          {
            flightOfferId: 'offer-audit-1',
            passengers: [
              {
                offerPassengerId: 'pas_001',
                type: 'ADULT',
                source: {
                  type: 'inline',
                  givenName: 'Barbara',
                  familyName: 'Liskov',
                  dateOfBirth: '1939-11-07',
                  gender: 'female',
                  nationality: 'US',
                  documentType: 'passport',
                  passportNumber: 'US987654321',
                  passportExpiry: '2030-01-01',
                  issuingCountry: 'US',
                  email: 'barbara.liskov@mit.test',
                  phoneCountryCode: '+1',
                  phoneNumber: '6175551234',
                  title: 'PROF',
                },
              },
            ],
          } as never,
          {
            traceId,
            correlationId,
            ipAddress: '192.168.1.50',
          },
        );

        expect(audit.createLog).toHaveBeenCalledTimes(1);
        const [txArg, auditPayload] = audit.createLog.mock.calls[0];
        expect(txArg).toBe(prisma);
        expect(auditPayload).toEqual(
          expect.objectContaining({
            userId: 'user-1',
            action: 'booking_intent_created',
            resourceType: 'BookingIntent',
            resourceId: expect.any(String),
            ipAddress: '192.168.1.50',
            traceId,
            correlationId,
          }),
        );

        // Validate metadata allowlist keys
        const metadata = auditPayload.metadata;
        const allowedMetadataKeys = new Set([
          'operation',
          'metric',
          'status',
          'latency_ms',
          'outcome',
          'price_changed',
        ]);
        for (const key of Object.keys(metadata)) {
          expect(allowedMetadataKeys.has(key)).toBe(true);
        }

        // Validate metadata strictly contains NO PII
        const metadataString = JSON.stringify(metadata);
        expect(metadataString).not.toContain('Barbara');
        expect(metadataString).not.toContain('Liskov');
        expect(metadataString).not.toContain('1939-11-07');
        expect(metadataString).not.toContain('US987654321');
        expect(metadataString).not.toContain('barbara.liskov@mit.test');
        expect(metadataString).not.toContain('6175551234');
        expect(metadataString).not.toContain('user-1');
        expect(metadataString).not.toContain('offer-audit-1');
      });
    });

    describe('Booking Readiness Observability', () => {
      it('emits BookingReadinessObservability event for INTENT_CREATE with zero PII', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-obs-1',
          supplierOfferId: 'duffel-obs-1',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const traceId = 'chat_33333333333333333333333333333333';
        const correlationId = 'chat_44444444444444444444444444444444';

        await service.createIntent(
          'user-1',
          {
            flightOfferId: 'offer-obs-1',
            passengers: [
              {
                offerPassengerId: 'pas_001',
                type: 'ADULT',
                source: {
                  type: 'inline',
                  givenName: 'Dorothy',
                  familyName: 'Vaughan',
                  dateOfBirth: '1910-09-20',
                  gender: 'female',
                  nationality: 'US',
                  documentType: 'passport',
                  passportNumber: 'US123123123',
                  passportExpiry: '2030-01-01',
                  issuingCountry: 'US',
                  email: 'dorothy@nasa.test',
                  phoneCountryCode: '+1',
                  phoneNumber: '5552223333',
                  title: 'MS',
                },
              },
            ],
          } as never,
          {
            traceId,
            correlationId,
            ipAddress: '192.168.1.51',
          },
        );

        expect(readinessObservability.recordOutcome).toHaveBeenCalledTimes(1);
        const eventArg = readinessObservability.recordOutcome.mock.calls[0][0];
        expect(eventArg).toEqual(
          expect.objectContaining({
            operation: 'intent_create',
            status: 'created',
            context: {
              traceId,
              correlationId,
            },
            metadata: expect.objectContaining({
              scope: 'INTERNATIONAL',
              passengerCount: 1,
              status: 'created',
            }),
          }),
        );

        const metadataString = JSON.stringify(eventArg.metadata);
        expect(metadataString).not.toContain('Dorothy');
        expect(metadataString).not.toContain('Vaughan');
        expect(metadataString).not.toContain('1910-09-20');
        expect(metadataString).not.toContain('US123123123');
        expect(metadataString).not.toContain('dorothy@nasa.test');
        expect(metadataString).not.toContain('user-1');
        expect(metadataString).not.toContain('offer-obs-1');
      });

      it('does not abort transaction when observability recordOutcome throws', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-obs-fail',
          supplierOfferId: 'duffel-obs-fail',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        readinessObservability.recordOutcome.mockImplementationOnce(() => {
          throw new Error('Observability sink down');
        });

        const result = await service.createIntent('user-1', {
          flightOfferId: 'offer-obs-fail',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: 'ADULT',
              source: {
                type: 'inline',
                givenName: 'Dorothy',
                familyName: 'Vaughan',
                dateOfBirth: '1910-09-20',
                gender: 'female',
                nationality: 'US',
                documentType: 'passport',
                passportNumber: 'US123123123',
                passportExpiry: '2030-01-01',
                issuingCountry: 'US',
                email: 'dorothy@nasa.test',
                phoneCountryCode: '+1',
                phoneNumber: '5552223333',
                title: 'MS',
              },
            },
          ],
        } as never);

        expect(result.intentId).toBeDefined();
        expect(prisma.bookingIntent.create).toHaveBeenCalled();
      });

      it('does not emit created telemetry or observability event when transaction rolls back', async () => {
        prisma.flightOffer.findUnique.mockResolvedValue({
          id: 'offer-obs-rollback',
          supplierOfferId: 'duffel-obs-rollback',
          price: 150,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01T00:00:00.000Z'),
          returnDate: null,
          cabinClass: 'ECONOMY',
          adults: 1,
          children: 0,
          infants: 0,
        });

        prisma.bookingIntent.create.mockRejectedValueOnce(new Error('DB transaction error'));

        await expect(
          service.createIntent('user-1', {
            flightOfferId: 'offer-obs-rollback',
            passengers: [
              {
                offerPassengerId: 'pas_001',
                type: 'ADULT',
                source: {
                  type: 'inline',
                  givenName: 'Dorothy',
                  familyName: 'Vaughan',
                  dateOfBirth: '1910-09-20',
                  gender: 'female',
                  nationality: 'US',
                  documentType: 'passport',
                  passportNumber: 'US123123123',
                  passportExpiry: '2030-01-01',
                  issuingCountry: 'US',
                  email: 'dorothy@nasa.test',
                  phoneCountryCode: '+1',
                  phoneNumber: '5552223333',
                  title: 'MS',
                },
              },
            ],
          } as never),
        ).rejects.toThrow('DB transaction error');

        expect(readinessObservability.recordOutcome).not.toHaveBeenCalled();
      });
    });
  });

  it('does not log raw claim-release exceptions', async () => {
    const prisma = {
      flightOffer: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const releaseError = new Error('request failed at https://internal.test/handoff?token=secret');
    const chatHandoff = {
      resolve: jest.fn().mockResolvedValue({ id: 'handoff-1', flightOfferId: 'offer-1' }),
      acquireClaim: jest.fn().mockResolvedValue('claim-secret'),
      refreshClaim: jest.fn(),
      releaseClaim: jest.fn().mockRejectedValue(releaseError),
    };
    const loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const Service = BookingIntentService as unknown as new (
      ...args: unknown[]
    ) => BookingIntentService;
    const service = new Service(prisma, {}, {}, {}, undefined, undefined, undefined, chatHandoff);

    await expect(
      service.createIntent('user-1', { handoffToken: 'handoff-token', passengers: [] } as never),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });

    expect(loggerError).toHaveBeenCalledWith('chat_handoff_claim_release_failed');
    expect(JSON.stringify(loggerError.mock.calls)).not.toContain('internal.test');
    loggerError.mockRestore();
  });

  it('releases only the request-owned fast-fail reservation when intent validation fails', async () => {
    const prisma = {
      flightOffer: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const chatHandoff = {
      releaseInFlight: jest.fn(),
    };
    const Service = BookingIntentService as unknown as new (
      ...args: unknown[]
    ) => BookingIntentService;
    const service = new Service(
      prisma,
      {} as never,
      { createLog: jest.fn() },
      {} as never,
      undefined,
      undefined,
      undefined,
      chatHandoff,
    );

    await expect(
      service.createIntent('user-1', { flightOfferId: 'missing-offer', passengers: [] } as never, {
        handoffFastFailReservation: {
          token: 'chk_handoff_v1_token',
          reservationId: 'reservation-1',
        },
      }),
    ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });

    expect(chatHandoff.releaseInFlight).toHaveBeenCalledWith(
      'chk_handoff_v1_token',
      'user-1',
      'reservation-1',
    );
  });

  describe('fetchLiveOffer', () => {
    it('rejects offer with missing totalAmount', async () => {
      mockFlightSearchPort.getOfferById.mockResolvedValueOnce({
        currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it('rejects offer with non-numeric totalAmount', async () => {
      mockFlightSearchPort.getOfferById.mockResolvedValueOnce({
        totalAmount: 'invalid-price',
        currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it('rejects offer with non-positive totalAmount', async () => {
      mockFlightSearchPort.getOfferById.mockResolvedValueOnce({
        totalAmount: '-10.00',
        currency: 'USD',
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it('returns pricing if totalAmount is a valid positive number string', async () => {
      const mockRawPayload = {
        passengers: [{ id: 'pas_1', type: 'adult' }],
      };
      const mockPassengers = [{ supplierPassengerId: 'pas_1', type: 'ADULT' as const }];
      const mockOffer = {
        id: 'offer-123',
        supplierOfferId: 'off_123',
        totalAmount: '150.00',
        price: 150.0,
        currency: 'USD',
        offerExpiresAt: '2026-07-15T00:00:00Z',
        rawSupplierPayload: mockRawPayload,
        passengers: mockPassengers,
      };
      mockFlightSearchPort.getOfferById.mockResolvedValueOnce(mockOffer);

      const result = await testable.fetchLiveOffer('offer-123');
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
      expect(result).toEqual({
        totalAmount: '150.00',
        currency: 'USD',
        offerExpiresAt: new Date('2026-07-15T00:00:00Z'),
        raw: mockRawPayload,
        passengers: mockPassengers,
      });
    });

    it('throws UPSTREAM_TIMEOUT on timeout error', async () => {
      mockFlightSearchPort.getOfferById.mockRejectedValueOnce(
        new Error('Request timed out while contacting upstream'),
      );

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_TIMEOUT',
            message: 'Timed out while confirming live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it('throws OFFER_EXPIRED on 404 or 410 or expired error message', async () => {
      mockFlightSearchPort.getOfferById.mockRejectedValueOnce(
        new NotFoundException('Offer not found'),
      );

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'OFFER_EXPIRED',
            message: 'Offer no longer available',
          },
          HttpStatus.GONE,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it.each([
      { status: 410 },
      { code: 'offer_expired' },
      { code: 'not_found' },
      new Error('Offer no longer available'),
    ])('classifies supplier expiry errors: %p', async (error) => {
      mockFlightSearchPort.getOfferById.mockRejectedValueOnce(error);

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toMatchObject({
        response: { code: 'OFFER_EXPIRED' },
      });
    });

    it('does not classify an internal expired-message error as OFFER_EXPIRED', async () => {
      mockFlightSearchPort.getOfferById.mockResolvedValueOnce({
        totalAmount: '150.00',
        currency: 'USD',
        get offerExpiresAt() {
          throw new Error('Internal metadata expired');
        },
      });

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toMatchObject({
        response: { code: 'UPSTREAM_UNAVAILABLE' },
      });
    });

    it('throws UPSTREAM_RATE_LIMITED on status 429', async () => {
      mockFlightSearchPort.getOfferById.mockRejectedValueOnce(
        new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Upstream rate limited',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_RATE_LIMITED',
            message: 'API rate limit exceeded',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });

    it('throws UPSTREAM_UNAVAILABLE on unknown upstream failure', async () => {
      mockFlightSearchPort.getOfferById.mockRejectedValueOnce(new Error('Connection reset'));

      await expect(testable.fetchLiveOffer('offer-123')).rejects.toThrow(
        new HttpException(
          {
            code: 'UPSTREAM_UNAVAILABLE',
            message: 'Failed to confirm live offer pricing',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );
      expect(mockFlightSearchPort.getOfferById).toHaveBeenCalledWith('offer-123', 4500);
    });
  });

  describe('extractSupplierPassengerIds', () => {
    it('maps supplier passengers by type and ordinal for new booking intents', () => {
      const result = testable.extractSupplierPassengerIds(
        [
          { supplierPassengerId: 'pas_adult_1', type: 'ADULT' },
          { supplierPassengerId: 'pas_child_1', type: 'CHILD' },
          { supplierPassengerId: 'pas_adult_2', type: 'ADULT' },
        ],
        [{ type: 'ADULT' }, { type: 'CHILD' }, { type: 'ADULT' }],
      );

      expect(result).toEqual(['pas_adult_1', 'pas_child_1', 'pas_adult_2']);
    });

    it('rejects a supplier passenger list that cannot map every local passenger', () => {
      expect(() =>
        testable.extractSupplierPassengerIds(
          [{ supplierPassengerId: 'pas_adult_1', type: 'ADULT' }],
          [
            { type: 'ADULT' },
            { type: 'CHILD' },
          ],
        ),
      ).toThrow(HttpException);
    });
  });

  describe('Cron Cleanup Methods', () => {
    let service: BookingIntentService;
    let mockPrisma: MockPrismaService;
    let mockAudit: MockAuditService;
    let snapshotEncryption: { decrypt: jest.Mock; decryptBound: jest.Mock };
    const originalGraceHours = process.env.BOOKING_INTENT_GRACE_HOURS;

    beforeEach(() => {
      mockPrisma = {
        bookingIntent: {
          findMany: jest.fn(),
          updateMany: jest.fn(),
          deleteMany: jest.fn(),
          findUnique: jest.fn(),
        },
        $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      } as unknown as MockPrismaService;

      mockAudit = {
        createLog: jest.fn(),
      } as unknown as MockAuditService;

      snapshotEncryption = {
        decrypt: jest.fn((val: string) => `decrypted-${val}`),
        decryptBound: jest.fn((val: string) => `bound-decrypted-${val}`),
      };

      service = new BookingIntentService(
        mockPrisma as unknown as import('../prisma/prisma.service').PrismaService,
        {} as import('@/supplier/search/flight-search.port').FlightSearchPort,
        mockAudit as unknown as import('../audit/audit.service').AuditService,
        snapshotEncryption as unknown as import('../common/encryption.service').EncryptionService,
      );
    });

    afterEach(() => {
      if (originalGraceHours === undefined) {
        delete process.env.BOOKING_INTENT_GRACE_HOURS;
      } else {
        process.env.BOOKING_INTENT_GRACE_HOURS = originalGraceHours;
      }
    });

    describe('expireExpiredIntents', () => {
      it('returns 0 if no intents were updated', async () => {
        mockPrisma.bookingIntent.updateMany.mockResolvedValueOnce({ count: 0 });

        const result = await service.expireExpiredIntents(new Date());
        expect(result).toEqual({ expiredCount: 0 });
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('expires intents and creates audit log if expired intents are updated', async () => {
        mockPrisma.bookingIntent.updateMany.mockResolvedValueOnce({ count: 2 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.expireExpiredIntents(now);

        expect(result).toEqual({ expiredCount: 2 });
        expect(mockPrisma.bookingIntent.updateMany).toHaveBeenCalledWith({
          where: {
            status: 'PENDING',
            intentExpiresAt: { lt: now },
          },
          data: { status: 'EXPIRED' },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_expired',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: 2,
          },
        });
      });
    });

    describe('deleteExpiredIntents', () => {
      it('returns 0 if no intents were deleted', async () => {
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const result = await service.deleteExpiredIntents(new Date());
        expect(result).toEqual({ deletedCount: 0 });
        expect(mockAudit.createLog).not.toHaveBeenCalled();
      });

      it('deletes expired intents and creates audit log if intents are past grace period', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = '12';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 1 });

        const now = new Date('2026-07-11T12:00:00Z');
        const result = await service.deleteExpiredIntents(now);

        expect(result).toEqual({ deletedCount: 1 });

        const expectedCutoff = new Date(now.getTime() - 12 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
        expect(mockAudit.createLog).toHaveBeenCalledWith(mockPrisma, {
          userId: null,
          action: 'booking_intent_deleted',
          resourceType: 'BookingIntent',
          resourceId: null,
          metadata: {
            count: 1,
          },
        });
      });

      it('defaults to 24 hours if grace period configuration is non-finite', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = 'Infinity';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const now = new Date('2026-07-11T12:00:00Z');
        await service.deleteExpiredIntents(now);

        const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
      });

      it('defaults to 24 hours if grace period configuration is less than or equal to zero', async () => {
        process.env.BOOKING_INTENT_GRACE_HOURS = '-5';
        mockPrisma.bookingIntent.deleteMany.mockResolvedValueOnce({ count: 0 });

        const now = new Date('2026-07-11T12:00:00Z');
        await service.deleteExpiredIntents(now);

        const expectedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        expect(mockPrisma.bookingIntent.deleteMany).toHaveBeenCalledWith({
          where: {
            status: 'EXPIRED',
            updatedAt: { lt: expectedCutoff },
          },
        });
      });
    });

    describe('getIntent', () => {
      it('throws NotFoundException if intent does not exist', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce(null);

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(NotFoundException);
      });

      it('throws ForbiddenException if intent does not belong to the user', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-2',
          status: 'PENDING',
        });

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(ForbiddenException);
      });

      it('throws GoneException if intent status is EXPIRED', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-1',
          status: 'EXPIRED',
        });

        await expect(service.getIntent('user-1', 'intent-1')).rejects.toThrow(GoneException);
      });

      it('returns mapped intent DTO on success', async () => {
        const mockPricedAt = new Date('2026-07-26T10:00:00Z');
        const mockExpiresAt = new Date('2026-07-26T10:30:00Z');
        const mockCreatedAt = new Date('2026-07-26T09:50:00Z');
        const mockDob = new Date('1990-01-01');

        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          originalPrice: 150.0,
          confirmedPrice: 160.0,
          priceChanged: true,
          currency: 'USD',
          pricedAt: mockPricedAt,
          intentExpiresAt: mockExpiresAt,
          offerExpiresAt: null,
          createdAt: mockCreatedAt,
          passengers: [
            {
              id: 'p1',
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: mockDob,
              gender: 'male',
              nationality: 'US',
              passportNumber: 'v1:encrypted-passport',
              passportExpiry: 'v1:encrypted-expiry',
              travelerProfileId: 'profile-1',
            },
          ],
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01'),
          returnDate: null,
          cabinClass: 'economy',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const result = await service.getIntent('user-1', 'intent-1');

        expect(result).toEqual({
          intentId: 'intent-1',
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 160,
          priceChanged: true,
          currency: 'USD',
          pricedAt: mockPricedAt.toISOString(),
          intentExpiresAt: mockExpiresAt.toISOString(),
          offerExpiresAt: null,
          createdAt: mockCreatedAt.toISOString(),
          passengers: [
            {
              id: 'p1',
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              nameSummary: expect.stringMatching(/^J/),
              documentSummary: {
                documentType: null,
                issuingCountry: null,
                hasPassport: true,
                maskedPassportSummary: '•••• port',
              },
              contactSummary: {
                email: null,
                phone: null,
                maskedContactSummary: null,
              },
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              gender: 'male',
              nationality: 'US',
              passportNumber: null,
              passportExpiry: null,
              preFilledFromProfile: true,
              maskedPassportSummary: '•••• port',
              maskedContactSummary: null,
            },
          ],
          flight: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2026-08-01',
            returnDate: null,
            cabinClass: 'economy',
            adults: 1,
            children: 0,
            infants: 0,
          },
        });
      });

      it('safely decrypts bound passport numbers on read to construct masked summary without exposing plaintext fields', async () => {
        mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
          id: 'intent-1',
          userId: 'user-1',
          status: 'PENDING',
          originalPrice: 150,
          confirmedPrice: 150,
          priceChanged: false,
          currency: 'USD',
          pricedAt: new Date('2026-07-26T10:00:00Z'),
          intentExpiresAt: new Date('2026-07-26T10:30:00Z'),
          offerExpiresAt: null,
          createdAt: new Date('2026-07-26T09:50:00Z'),
          passengers: [
            {
              id: 'p1',
              position: 0,
              snapshotVersion: 1,
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: new Date('1990-01-01'),
              gender: 'male',
              nationality: 'US',
              passportNumber: 'v1:iv:tag:bound-passport',
              passportExpiry: 'v1:iv:tag:bound-expiry',
              travelerProfileId: null,
            },
          ],
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-08-01'),
          returnDate: null,
          cabinClass: 'economy',
          adults: 1,
          children: 0,
          infants: 0,
        });

        const result = await service.getIntent('user-1', 'intent-1');

        expect(snapshotEncryption.decryptBound).toHaveBeenCalledWith('v1:iv:tag:bound-passport', {
          snapshotVersion: 1,
          intentId: 'intent-1',
          position: 0,
          fieldName: 'passportNumber',
        });
        expect(result.passengers[0]).toEqual(
          expect.objectContaining({
            passportNumber: null,
            passportExpiry: null,
            maskedPassportSummary: '•••• port',
            documentSummary: expect.objectContaining({
              hasPassport: true,
              maskedPassportSummary: '•••• port',
            }),
          }),
        );
      });
    });
  });
});
