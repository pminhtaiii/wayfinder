process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { EncryptionService } from '@/common/encryption.service';
import { ProfileService } from '@/profile/profile.service';
import { AuditService } from '@/audit/audit.service';
import { AirportsService } from '@/airports/airports.service';
import { PassengerType, Prisma } from '@prisma/client';

type BootedApp = {
  app: INestApplication;
  prisma: PrismaService;
  jwtService: JwtService;
  duffel: Duffel;
  encryptionService: EncryptionService;
  profileService: ProfileService;
  auditService: AuditService;
  airportsService: AirportsService;
};

type AuthUser = {
  id: string;
  email: string;
  token: string;
};

type ReadinessPassenger =
  | {
      offerPassengerId: string;
      passengerType: PassengerType;
      source: {
        type: 'traveler_profile';
        travelerProfileId: string;
      };
    }
  | {
      offerPassengerId: string;
      passengerType: PassengerType;
      source: {
        type: 'inline';
        givenName?: string;
        middleName?: string | null;
        familyName?: string;
        dateOfBirth?: string;
        gender?: string;
        title?: string;
        email?: string;
        phoneCountryCode?: string;
        phoneNumber?: string;
        documentType?: string;
        passportNumber?: string;
        passportExpiry?: string;
        issuingCountry?: string;
        nationality?: string;
      };
    };

async function bootstrapReadinessApp(featureFlag: 'true' | 'false'): Promise<BootedApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ConfigService)
    .useValue({
      get: (key: string, defaultValue?: unknown) => {
        if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
          return featureFlag;
        }

        return process.env[key] ?? defaultValue;
      },
    })
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.setGlobalPrefix('api', { exclude: ['health'] });
  await app.init();

  return {
    app,
    prisma: moduleFixture.get(PrismaService),
    jwtService: moduleFixture.get(JwtService),
    duffel: moduleFixture.get<Duffel>(DUFFEL_SDK),
    encryptionService: moduleFixture.get(EncryptionService),
    profileService: moduleFixture.get(ProfileService),
    auditService: moduleFixture.get(AuditService),
    airportsService: moduleFixture.get(AirportsService),
  };
}

async function clearApiState(prisma: PrismaService): Promise<void> {
  await prisma.chatHandoff.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.cancellationRefundObligation.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.paymentMethod.deleteMany({});
  await prisma.bookingIntentPassenger.deleteMany({});
  await prisma.bookingIntent.deleteMany({});
  await prisma.itineraryRevisionSegment.deleteMany({});
  await prisma.itineraryRevision.deleteMany({});
  await prisma.disruptionAuditEvent.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.travelerProfile.deleteMany({});
  await prisma.offerRecovery.deleteMany({});
  await prisma.flightOffer.deleteMany({});
  await prisma.searchHistory.deleteMany({});
  await prisma.airport.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({});
}

async function createUser(
  prisma: PrismaService,
  jwtService: JwtService,
  email: string,
): Promise<AuthUser> {
  const user = await prisma.user.create({
    data: {
      email,
      password: 'Password123!',
      status: 'ACTIVE',
    },
  });

  return {
    id: user.id,
    email: user.email,
    token: jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' }),
  };
}

async function seedAirport(
  prisma: PrismaService,
  iataCode: string,
  country: string,
): Promise<void> {
  await prisma.airport.create({
    data: {
      iataCode,
      icaoCode: `${iataCode}X`,
      name: `${iataCode} Test Airport`,
      city: `${iataCode} City`,
      country,
      region: 'TEST',
      latitude: 10,
      longitude: 10,
      elevation: 0,
      type: 'LARGE_AIRPORT',
      timezone: 'UTC',
    },
  });
}

async function seedReadinessOffer(
  prisma: PrismaService,
  overrides: Partial<Prisma.FlightOfferCreateInput> = {},
): Promise<{ id: string }> {
  const uniqueId = require('crypto').randomUUID();
  const offer = await prisma.flightOffer.create({
    data: {
      searchHash: overrides.searchHash ?? `booking-readiness-search-hash-${uniqueId}`,
      supplierOfferId: overrides.supplierOfferId ?? `off_readiness_${uniqueId}`,
      rawOffer: {
        expires_at: '2030-08-25T10:00:00Z',
        passengers: [{ id: 'pas_001', type: 'adult' }],
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                arriving_at: '2030-08-20T09:30:00Z',
              },
            ],
          },
        ],
      },
      origin: 'SGN',
      destination: 'HAN',
      departureDate: new Date('2030-08-20T00:00:00.000Z'),
      adults: 1,
      children: 0,
      infants: 0,
      cabinClass: 'economy',
      price: new Prisma.Decimal(120),
      currency: 'USD',
      ...overrides,
    },
    select: { id: true },
  });

  return offer;
}

async function seedTravelerProfile(
  prisma: PrismaService,
  encryptionService: EncryptionService,
  userId: string,
  overrides: Partial<Prisma.TravelerProfileCreateInput> = {},
): Promise<{ id: string; revision: number }> {
  const profile = await prisma.travelerProfile.create({
    data: {
      user: { connect: { id: userId } },
      givenName: 'Ada',
      middleName: null,
      familyName: 'Lovelace',
      dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      gender: 'female',
      title: 'Ms',
      email: 'ada@example.com',
      phoneCountryCode: '+84',
      phoneNumber: '987654321',
      documentType: 'passport',
      passportNumber: `v1:${encryptionService.encrypt('P1234567')}`,
      passportExpiry: new Date('2035-12-31T00:00:00.000Z'),
      passportExpiryCiphertext: encryptionService.encrypt('2035-12-31'),
      issuingCountry: 'VN',
      nationality: 'VN',
      revision: 3,
      ...overrides,
    },
    select: {
      id: true,
      revision: true,
    },
  });

  return profile;
}

function readinessPayload(flightOfferId: string, passengers: ReadinessPassenger[]) {
  return {
    flightOfferId,
    passengers,
  };
}

function ownedProfilePassenger(travelerProfileId: string): ReadinessPassenger {
  return {
    offerPassengerId: 'pas_001',
    passengerType: PassengerType.ADULT,
    source: {
      type: 'traveler_profile',
      travelerProfileId,
    },
  };
}

type InlineReadinessPassenger = Extract<ReadinessPassenger, { source: { type: 'inline' } }>;
type InlinePassengerOverrides = Partial<Omit<InlineReadinessPassenger, 'source'>> & {
  source?: Partial<InlineReadinessPassenger['source']> & Record<string, unknown>;
};

function inlinePassenger(overrides: InlinePassengerOverrides = {}): InlineReadinessPassenger {
  const { source: sourceOverrides, ...passengerOverrides } = overrides;

  return {
    offerPassengerId: 'pas_001',
    passengerType: PassengerType.ADULT,
    source: {
      givenName: 'Inline',
      middleName: null,
      familyName: 'Traveler',
      dateOfBirth: '1992-03-04',
      gender: 'male',
      title: 'Mr',
      email: 'inline@example.com',
      phoneCountryCode: '+1',
      phoneNumber: '5551112222',
      documentType: 'passport',
      passportNumber: 'X1234567',
      passportExpiry: '2034-04-01',
      issuingCountry: 'US',
      nationality: 'US',
      ...(sourceOverrides ?? {}),
      type: 'inline',
    },
    ...passengerOverrides,
  };
}

function extractStructuredLogPayloads(spy: jest.SpyInstance): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => call[1])
    .filter((payload): payload is string => typeof payload === 'string')
    .map((payload) => {
      try {
        return JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

function expectNoPiiLeak(surface: string, forbiddenValues: Array<string | null | undefined>): void {
  for (const forbiddenValue of forbiddenValues) {
    if (!forbiddenValue) {
      continue;
    }

    expect(surface).not.toContain(forbiddenValue);
  }
}

async function assertPersistedAuditSurfaceIsPiiSafe(
  prisma: PrismaService,
  forbiddenValues: string[],
  traceId?: string,
  correlationId?: string,
): Promise<void> {
  const auditLogs = await prisma.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
  });

  for (const auditLog of auditLogs) {
    const persistedSurface = JSON.stringify({
      action: auditLog.action,
      resourceType: auditLog.resourceType,
      resourceId: auditLog.resourceId,
      metadata: auditLog.metadata,
      traceId: auditLog.traceId,
      correlationId: auditLog.correlationId,
    });

    expectNoPiiLeak(persistedSurface, forbiddenValues);

    if (
      traceId &&
      correlationId &&
      (auditLog.action.toLowerCase().includes('readiness') ||
        auditLog.resourceType.toLowerCase().includes('readiness'))
    ) {
      expect(auditLog.traceId).toBe(traceId);
      expect(auditLog.correlationId).toBe(correlationId);
      expect((auditLog.metadata as Record<string, unknown>)?.traceId).toBe(traceId);
      expect((auditLog.metadata as Record<string, unknown>)?.correlationId).toBe(correlationId);
    }
  }
}

describe('Booking Readiness (E2E RED)', () => {
  jest.setTimeout(30000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('feature disabled', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;
    let profileService: ProfileService;

    beforeAll(async () => {
      const booted = await bootstrapReadinessApp('false');
      app = booted.app;
      prisma = booted.prisma;
      jwtService = booted.jwtService;
      profileService = booted.profileService;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await clearApiState(prisma);
    });

    it('returns 404 FEATURE_DISABLED before touching data reads', async () => {
      const user = await createUser(prisma, jwtService, 'disabled-readiness@example.com');
      const flightOfferFindUniqueSpy = jest.spyOn(prisma.flightOffer, 'findUnique');
      const airportFindManySpy = jest.spyOn(prisma.airport, 'findMany');
      const airportFindUniqueSpy = jest.spyOn(prisma.airport, 'findUnique');
      const profileGetSpy = jest.spyOn(profileService, 'getProfile');

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${user.token}`)
        .set('x-trace-id', 'trace-disabled-red')
        .set('x-correlation-id', 'corr-disabled-red')
        .send(readinessPayload('11111111-1111-4111-8111-111111111111', [inlinePassenger()]));

      expect(response.status).toBe(404);
      expect(response.body).toEqual(
        expect.objectContaining({
          code: 'FEATURE_DISABLED',
        }),
      );
      expect(flightOfferFindUniqueSpy).not.toHaveBeenCalled();
      expect(airportFindManySpy).not.toHaveBeenCalled();
      expect(airportFindUniqueSpy).not.toHaveBeenCalled();
      expect(profileGetSpy).not.toHaveBeenCalled();
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
    });
  });

  describe('feature enabled', () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let jwtService: JwtService;
    let duffel: Duffel;
    let encryptionService: EncryptionService;
    let auditService: AuditService;
    let primaryUser: AuthUser;
    let foreignUser: AuthUser;

    beforeAll(async () => {
      const booted = await bootstrapReadinessApp('true');
      app = booted.app;
      prisma = booted.prisma;
      jwtService = booted.jwtService;
      duffel = booted.duffel;
      encryptionService = booted.encryptionService;
      auditService = booted.auditService;
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(async () => {
      await clearApiState(prisma);
      primaryUser = await createUser(prisma, jwtService, 'readiness-owner@example.com');
      foreignUser = await createUser(prisma, jwtService, 'readiness-foreign@example.com');
    });

    it('returns a complete domestic readiness result with no-store headers, no writes, and no Duffel calls', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);
      const profile = await seedTravelerProfile(prisma, encryptionService, primaryUser.id);
      const duffelSpy = jest.spyOn(duffel.offers, 'get');
      const auditCreateLogSpy = jest.spyOn(auditService, 'createLog');
      const loggerWarnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const traceId = 'trace-domestic-red';
      const correlationId = 'corr-domestic-red';

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .set('x-trace-id', traceId)
        .set('x-correlation-id', correlationId)
        .send(readinessPayload(offer.id, [ownedProfilePassenger(profile.id)]));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store, private');
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'DOMESTIC',
          ready: true,
          passengers: [
            expect.objectContaining({
              passengerOrdinal: 1,
              passengerType: PassengerType.ADULT,
              profileRevision: profile.revision,
              ready: true,
            }),
          ],
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain(profile.id);
      expect(JSON.stringify(response.body)).not.toContain('Ada');
      expect(JSON.stringify(response.body)).not.toContain(traceId);
      expect(JSON.stringify(response.body)).not.toContain(correlationId);
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
      expect(duffelSpy).not.toHaveBeenCalled();

      const auditLogCalls = auditCreateLogSpy.mock.calls;
      for (const call of auditLogCalls) {
        const auditPayload = call[1] as {
          traceId?: string;
          correlationId?: string;
          metadata?: unknown;
          resourceId?: string | null;
        };
        expect(auditPayload.traceId).toBe(traceId);
        expect(auditPayload.correlationId).toBe(correlationId);
        expectNoPiiLeak(JSON.stringify(auditPayload), [
          profile.id,
          offer.id,
          'Ada',
          'Lovelace',
          '1990-01-01',
          'ada@example.com',
          '+84',
          '987654321',
          'P1234567',
          '2035-12-31',
          'VN',
        ]);
      }

      const logPayloads = extractStructuredLogPayloads(loggerWarnSpy);
      for (const logPayload of logPayloads) {
        if (logPayload.service === 'api' && logPayload.metadata) {
          expectNoPiiLeak(JSON.stringify(logPayload), [
            profile.id,
            offer.id,
            'Ada',
            'Lovelace',
            '1990-01-01',
            'ada@example.com',
            '+84',
            '987654321',
            'P1234567',
            '2035-12-31',
          ]);
        }
      }

      await assertPersistedAuditSurfaceIsPiiSafe(
        prisma,
        [
          profile.id,
          offer.id,
          'Ada',
          'Lovelace',
          '1990-01-01',
          'ada@example.com',
          '+84',
          '987654321',
          'P1234567',
          '2035-12-31',
        ],
        traceId,
        correlationId,
      );
    });

    it('returns an international readiness result with blocking document gaps and advisory passport warnings', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'NRT', 'JP');
      const offer = await seedReadinessOffer(prisma, {
        destination: 'NRT',
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'NRT' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(
          readinessPayload(offer.id, [
            inlinePassenger({
              source: {
                documentType: 'passport',
                passportNumber: 'X1234567',
                passportExpiry: '2030-08-21',
                issuingCountry: '',
                nationality: '',
              },
            }),
          ]),
        );

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'INTERNATIONAL',
          ready: false,
          passengers: [
            expect.objectContaining({
              passengerOrdinal: 1,
              ready: false,
              sections: expect.arrayContaining([
                expect.objectContaining({
                  name: 'travel_document',
                  fields: expect.arrayContaining([
                    expect.objectContaining({
                      name: 'passportExpiry',
                      status: 'warning',
                      reason: 'PASSPORT_VALIDITY_REQUIRES_VERIFICATION',
                      blocking: false,
                    }),
                    expect.objectContaining({
                      name: 'issuingCountry',
                      status: 'missing',
                      reason: 'REQUIRED',
                      blocking: true,
                    }),
                    expect.objectContaining({
                      name: 'nationality',
                      status: 'missing',
                      reason: 'REQUIRED',
                      blocking: true,
                    }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain('Inline');
      expect(JSON.stringify(response.body)).not.toContain('Traveler');
      expect(JSON.stringify(response.body)).not.toContain('1992-03-04');
      expect(JSON.stringify(response.body)).not.toContain('inline@example.com');
      expect(JSON.stringify(response.body)).not.toContain('5551112222');
      expect(JSON.stringify(response.body)).not.toContain('X1234567');
      expect(JSON.stringify(response.body)).not.toContain('2030-08-21');
    });

    it('returns 200 UNKNOWN when airport-country reference data is missing and still creates no rows', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      const offer = await seedReadinessOffer(prisma, {
        destination: 'XXX',
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'XXX' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(offer.id, [inlinePassenger()]));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'UNKNOWN',
          ready: false,
          passengers: [
            expect.objectContaining({
              sections: expect.arrayContaining([
                expect.objectContaining({
                  name: 'itinerary',
                  fields: expect.arrayContaining([
                    expect.objectContaining({
                      name: 'scope',
                      status: 'unknown',
                      reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
                      blocking: true,
                    }),
                  ]),
                }),
              ]),
            }),
          ],
        }),
      );
      expect(await prisma.bookingIntent.count()).toBe(0);
      expect(await prisma.bookingIntentPassenger.count()).toBe(0);
    });

    it('rejects foreign profiles and invalid passenger mappings with safe 422 responses', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);
      const foreignProfile = await seedTravelerProfile(prisma, encryptionService, foreignUser.id);

      const foreignProfileResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(offer.id, [ownedProfilePassenger(foreignProfile.id)]));

      expect(foreignProfileResponse.status).toBe(422);
      expect(foreignProfileResponse.body).toEqual(
        expect.objectContaining({
          code: 'PASSENGER_MAPPING_INVALID',
        }),
      );
      expect(JSON.stringify(foreignProfileResponse.body)).not.toContain(foreignProfile.id);

      const invalidMappingResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(
          readinessPayload(offer.id, [
            {
              offerPassengerId: 'pas_missing',
              passengerType: PassengerType.ADULT,
              source: inlinePassenger().source,
            },
          ]),
        );

      expect(invalidMappingResponse.status).toBe(422);
      expect(invalidMappingResponse.body).toEqual(
        expect.objectContaining({
          code: 'PASSENGER_MAPPING_INVALID',
        }),
      );
    });

    it('maps missing offers, expired offers, and malformed stored offers to safe HTTP outcomes', async () => {
      const loggerWarnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const loggerErrorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const traceId = 'trace-error-red';
      const correlationId = 'corr-error-red';
      const missingOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .set('x-trace-id', traceId)
        .set('x-correlation-id', correlationId)
        .send(readinessPayload('11111111-1111-4111-8111-111111111111', [inlinePassenger()]));

      expect(missingOfferResponse.status).toBe(404);
      expect(missingOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'OFFER_NOT_FOUND',
        }),
      );

      const expiredOffer = await seedReadinessOffer(prisma, {
        rawOffer: {
          expires_at: '2026-08-02T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2030-08-20T09:30:00Z',
                },
              ],
            },
          ],
        },
      });

      const expiredOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .set('x-trace-id', traceId)
        .set('x-correlation-id', correlationId)
        .send(readinessPayload(expiredOffer.id, [inlinePassenger()]));

      expect(expiredOfferResponse.status).toBe(409);
      expect(expiredOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'OFFER_EXPIRED',
        }),
      );

      const malformedOffer = await seedReadinessOffer(prisma, {
        rawOffer: {
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
          slices: [{ segments: [{ origin: null, destination: null, arriving_at: null }] }],
        },
      });

      const malformedOfferResponse = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .set('x-trace-id', traceId)
        .set('x-correlation-id', correlationId)
        .send(readinessPayload(malformedOffer.id, [inlinePassenger()]));

      expect(malformedOfferResponse.status).toBe(503);
      expect(malformedOfferResponse.body).toEqual(
        expect.objectContaining({
          code: 'READINESS_DEPENDENCY_UNAVAILABLE',
        }),
      );

      const logPayloads = [
        ...extractStructuredLogPayloads(loggerWarnSpy),
        ...extractStructuredLogPayloads(loggerErrorSpy),
      ];
      expect(logPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            service: 'api',
            trace_id: traceId,
            correlation_id: correlationId,
          }),
        ]),
      );

      for (const logPayload of logPayloads) {
        expectNoPiiLeak(JSON.stringify(logPayload), [
          primaryUser.id,
          'Inline',
          'Traveler',
          '1992-03-04',
          'inline@example.com',
          '+1',
          '5551112222',
          'X1234567',
          '2034-04-01',
          'US',
        ]);
      }

      await assertPersistedAuditSurfaceIsPiiSafe(prisma, [
        primaryUser.id,
        'Inline',
        'Traveler',
        '1992-03-04',
        'inline@example.com',
        '+1',
        '5551112222',
        'X1234567',
        '2034-04-01',
      ]);
    });

    it('evaluates inline passengers without returning profile-backed metadata or echoing inline source payloads', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send(readinessPayload(offer.id, [inlinePassenger()]));

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          passengers: [
            expect.objectContaining({
              passengerOrdinal: 1,
              passengerType: PassengerType.ADULT,
              profileRevision: null,
            }),
          ],
        }),
      );

      const responseSurface = JSON.stringify(response.body);
      expect(response.body.passengers[0]).not.toHaveProperty('source');
      expect(responseSurface).not.toContain('traveler_profile');
      expect(responseSurface).not.toContain('inline');
      expect(responseSurface).not.toContain('Inline');
      expect(responseSurface).not.toContain('Traveler');
      expect(responseSurface).not.toContain('1992-03-04');
      expect(responseSurface).not.toContain('inline@example.com');
      expect(responseSurface).not.toContain('+1');
      expect(responseSurface).not.toContain('5551112222');
      expect(responseSurface).not.toContain('X1234567');
      expect(responseSurface).not.toContain('2034-04-01');
      expect(responseSurface).not.toContain('US');
    });

    it('returns a complete domestic readiness result using only a handoff token', async () => {
      await seedAirport(prisma, 'SGN', 'VN');
      await seedAirport(prisma, 'HAN', 'VN');
      const offer = await seedReadinessOffer(prisma);
      const profile = await seedTravelerProfile(prisma, encryptionService, primaryUser.id);

      const session = await prisma.chatSession.create({
        data: { userId: primaryUser.id },
      });
      const validHandoffToken = 'chk_handoff_v1_valid-token-123';
      const tokenHash = require('crypto')
        .createHash('sha256')
        .update(validHandoffToken)
        .digest('hex');
      const handoff = await prisma.chatHandoff.create({
        data: {
          userId: primaryUser.id,
          chatSessionId: session.id,
          flightOfferId: offer.id,
          supplierOfferIdHash: 'testhash',
          snapshotVersion: 1,
          snapshotFingerprint: 'test',
          selectionAttestationHash: 'test_v1_payload.sig',
          selectedOfferIndex: 1,
          tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idemp-hash-1',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send({
          handoffToken: validHandoffToken,
          passengers: [ownedProfilePassenger(profile.id)],
        });

      expect(response.status).toBe(200);
      expect(response.body).toEqual(
        expect.objectContaining({
          scope: 'DOMESTIC',
          ready: true,
        }),
      );
    });

    it('rejects readiness request when both flightOfferId and handoffToken are provided', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send({
          flightOfferId: '11111111-1111-4111-8111-111111111111',
          handoffToken: 'valid-handoff-token-123',
          passengers: [inlinePassenger()],
        });

      expect(response.status).toBe(400); // Bad Request from class-validator
      expect(response.body.message).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Exactly one of flightOfferId or handoffToken must be provided'),
        ]),
      );
    });

    it('keeps existing singular booking intent routes functional while the canonical readiness route is added', async () => {
      const singularOffer = await seedReadinessOffer(prisma);
      const duffelSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: 'off_readiness_123',
          total_amount: '120.00',
          total_currency: 'USD',
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_001', type: 'adult' }],
        },
        // The SDK response fixture includes only fields consumed by offer normalization.
      } as never);

      const createResponse = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${primaryUser.token}`)
        .send({
          flightOfferId: singularOffer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Legacy',
              familyName: 'Traveler',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
            },
          ],
        });

      if (createResponse.status !== 201) console.log(createResponse.body);
      expect(createResponse.status).toBe(201);
      expect(createResponse.body).toEqual(
        expect.objectContaining({
          intentId: expect.any(String),
          status: 'PENDING',
        }),
      );

      const getResponse = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createResponse.body.intentId}`)
        .set('Authorization', `Bearer ${primaryUser.token}`);

      expect(getResponse.status).toBe(200);

      const prefillResponse = await request(app.getHttpServer())
        .get('/api/bookings/intent/prefill')
        .set('Authorization', `Bearer ${primaryUser.token}`);

      expect(prefillResponse.status).toBe(200);
      duffelSpy.mockRestore();
    });
  });
});
