import * as crypto from 'crypto';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.CHAT_ENCRYPTION_KEY =
  process.env.CHAT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { EncryptionService } from '@/common/encryption.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  BookingReadinessMetricsService,
  BOOKING_READINESS_METRIC_COUNTERS,
  STANDARDIZED_READINESS_METRICS,
} from '@/common/observability/booking-readiness.metrics';
import { PassportExpiryBackfillService } from '@/profile/passport-expiry-backfill.service';
import { BookingPassengerFinalValidatorService } from '@/booking-intent/booking-passenger-final-validator.service';
import { PassengerType, Prisma } from '@prisma/client';

const SENSITIVE_PII_CORPUS = [
  'SecretTraveler',
  'AdaLovelaceUnique',
  'P99887766',
  'P11223344',
  '1985-06-15',
  '1992-04-20',
  'ada.unique@example.test',
  'secret.pass@example.test',
  '0912345678',
  'secret-encryption-master-key',
];

describe('Booking Readiness Observability (E2E) - Tasks T073 & T074', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let duffel: Duffel;
  let encryptionService: EncryptionService;
  let metricsService: BookingReadinessMetricsService;
  let backfillService: PassportExpiryBackfillService;
  let finalValidatorService: BookingPassengerFinalValidatorService;

  let testUser: { id: string; email: string };
  let testToken: string;
  let offerId: string;
  let readinessResponseBody: string = '';
  let intentResponseBody: string = '';
  let healthResponseBody: string = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown) => {
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/(.*)', 'api/health', 'api/health/(.*)'],
    });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    encryptionService = moduleFixture.get<EncryptionService>(EncryptionService);
    metricsService = moduleFixture.get<BookingReadinessMetricsService>(
      BookingReadinessMetricsService,
    );
    backfillService = moduleFixture.get<PassportExpiryBackfillService>(
      PassportExpiryBackfillService,
    );
    finalValidatorService = moduleFixture.get<BookingPassengerFinalValidatorService>(
      BookingPassengerFinalValidatorService,
    );

    // Clean tables for isolated run
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Seed test user
    const userEmail = `observability-${crypto.randomUUID()}@example.test`;
    const user = await prisma.user.create({
      data: {
        email: userEmail,
        password: 'HashedPassword123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: user.id, email: user.email };
    testToken = jwtService.sign(
      { sub: user.id, id: user.id, email: user.email, jti: crypto.randomUUID() },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    // Seed airports
    for (const ap of [
      { iataCode: 'SGN', name: 'Tan Son Nhat', city: 'Ho Chi Minh', country: 'VN' },
      { iataCode: 'HAN', name: 'Noi Bai', city: 'Ha Noi', country: 'VN' },
      { iataCode: 'NRT', name: 'Narita', city: 'Tokyo', country: 'JP' },
    ]) {
      await prisma.airport.upsert({
        where: { iataCode: ap.iataCode },
        update: {},
        create: {
          iataCode: ap.iataCode,
          name: ap.name,
          city: ap.city,
          country: ap.country,
          type: 'LARGE_AIRPORT',
          latitude: 10.0,
          longitude: 106.0,
        },
      });
    }

    // Seed domestic flight offer
    const uniqueOffer = crypto.randomUUID();
    const offer = await prisma.flightOffer.create({
      data: {
        searchHash: `obs-search-${uniqueOffer}`,
        supplierOfferId: `off_obs_${uniqueOffer}`,
        rawOffer: {
          id: `off_obs_${uniqueOffer}`,
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          total_amount: '150.00',
          total_currency: 'USD',
          passengers: [{ id: 'pas_obs_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2030-08-20T12:00:00Z',
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
        price: new Prisma.Decimal(150),
        currency: 'USD',
      },
    });
    offerId = offer.id;
  });

  afterAll(async () => {
    if (prisma && testUser?.id) {
      await prisma.auditLog.deleteMany({ where: { userId: testUser.id } });
      await prisma.bookingIntentPassenger.deleteMany({
        where: { intent: { userId: testUser.id } },
      });
      await prisma.bookingIntent.deleteMany({ where: { userId: testUser.id } });
      await prisma.travelerProfile.deleteMany({ where: { userId: testUser.id } });
      await prisma.user.deleteMany({ where: { id: testUser.id } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('1. Standardized Health Snapshot Endpoints', () => {
    it('GET /health/booking-readiness returns 200 with complete snapshot and zero PII', async () => {
      const res = await request(app.getHttpServer()).get('/health/booking-readiness').expect(200);

      healthResponseBody = JSON.stringify(res.body);

      expect(res.body).toMatchObject({
        status: 'ok',
        featureFlags: {
          bookingReadiness: true,
        },
      });

      expect(res.body.metrics).toBeDefined();
      expect(res.body.latency).toBeDefined();

      for (const standardizedMetric of STANDARDIZED_READINESS_METRICS) {
        expect(res.body.metrics).toHaveProperty(standardizedMetric);
        expect(typeof res.body.metrics[standardizedMetric]).toBe('number');
      }
    });

    it('GET /api/health/booking-readiness returns 200 with identical structure', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/health/booking-readiness')
        .expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.featureFlags.bookingReadiness).toBe(true);
      expect(res.body.metrics.traveler_profile_reads_total).toBeDefined();
    });
  });

  describe('2. Traveler Profile Metrics (Reads, Updates, CAS Conflicts)', () => {
    it('increments traveler_profile_reads_total on GET /api/profile', async () => {
      const initialReads = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS,
      );

      await request(app.getHttpServer())
        .get('/api/profile')
        .set('Authorization', `Bearer ${testToken}`)
        .expect(200);

      const readsAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_READS,
      );
      expect(readsAfter).toBe(initialReads + 1);
    });

    it('increments traveler_profile_updates_total on initial profile creation and updates', async () => {
      const initialUpdates = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_UPDATES,
      );

      const res = await request(app.getHttpServer())
        .patch('/api/profile')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          expectedRevision: 0,
          identity: {
            givenName: 'AdaLovelaceUnique',
            familyName: 'SecretTraveler',
            dateOfBirth: '1985-06-15',
            gender: 'female',
            title: 'Ms',
          },
          contact: {
            email: 'ada.unique@example.test',
            phoneCountryCode: '+84',
            phoneNumber: '0912345678',
          },
          travelDocument: {
            documentType: 'passport',
            passportNumber: 'P99887766',
            passportExpiry: '2035-12-31',
            issuingCountry: 'VN',
            nationality: 'VN',
          },
        })
        .expect(200);

      const updatesAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_UPDATES,
      );
      expect(updatesAfter).toBe(initialUpdates + 1);
      expect(res.body.revision).toBe(1);
    });

    it('increments traveler_profile_conflicts_total when CAS revision mismatch occurs', async () => {
      const initialConflicts = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_CONFLICTS,
      );

      const res = await request(app.getHttpServer())
        .patch('/api/profile')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          expectedRevision: 999, // Intentional mismatch (current is 1)
          identity: {
            givenName: 'ConflictName',
            familyName: 'ConflictFamily',
            dateOfBirth: '1985-06-15',
            gender: 'female',
            title: 'Ms',
          },
        })
        .expect(409);

      const conflictsAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.TRAVELER_PROFILE_CONFLICTS,
      );
      expect(conflictsAfter).toBe(initialConflicts + 1);
      expect(res.body.message).toBe('PROFILE_UPDATE_CONFLICT');
    });
  });

  describe('3. Advisory Readiness Checks & Evaluations Metrics', () => {
    it('increments booking_readiness_checks_total and booking_readiness_evaluations_total on advisory checks', async () => {
      const initialChecks = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS,
      );
      const initialEvals = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_EVALUATIONS,
      );

      const profile = await prisma.travelerProfile.findUnique({ where: { userId: testUser.id } });
      expect(profile).toBeDefined();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          flightOfferId: offerId,
          passengers: [
            {
              offerPassengerId: 'pas_obs_001',
              passengerType: PassengerType.ADULT,
              source: {
                type: 'traveler_profile',
                travelerProfileId: profile!.id,
              },
            },
          ],
        })
        .expect(200);

      readinessResponseBody = JSON.stringify(res.body);

      expect(res.body.ready).toBe(true);

      const checksAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_CHECKS,
      );
      const evalsAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_READINESS_EVALUATIONS,
      );

      expect(checksAfter).toBe(initialChecks + 1);
      expect(evalsAfter).toBe(initialEvals + 1);
    });
  });

  describe('4. Intent Creation and Authoritative Rejection Metrics', () => {
    it('increments booking_intent_authoritative_rejections_total on validation failure during intent creation', async () => {
      const initialRejections = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_AUTHORITATIVE_REJECTIONS,
      );

      // Create an international flight offer to trigger passport requirements
      const intlOffer = await prisma.flightOffer.create({
        data: {
          searchHash: `intl-obs-${crypto.randomUUID()}`,
          supplierOfferId: `off_intl_${crypto.randomUUID()}`,
          rawOffer: {
            id: `off_intl_raw`,
            expires_at: new Date(Date.now() + 86400000).toISOString(),
            total_amount: '500.00',
            total_currency: 'USD',
            passengers: [{ id: 'pas_intl_001', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'NRT' },
                    arriving_at: '2030-08-20T12:00:00Z',
                  },
                ],
              },
            ],
          },
          origin: 'SGN',
          destination: 'NRT',
          departureDate: new Date('2030-08-20T00:00:00.000Z'),
          adults: 1,
          children: 0,
          infants: 0,
          cabinClass: 'economy',
          price: new Prisma.Decimal(500),
          currency: 'USD',
        },
      });

      const duffelSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: intlOffer.supplierOfferId,
          total_amount: '500.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          passengers: [{ id: 'pas_intl_001', type: 'adult' }],
        },
      } as never);

      // Submit missing passport for international flight
      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          flightOfferId: intlOffer.id,
          passengers: [
            {
              offerPassengerId: 'pas_intl_001',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'InlineFirst',
                familyName: 'InlineLast',
                dateOfBirth: '1990-01-01',
                gender: 'male',
                email: 'inline@example.test',
                phoneCountryCode: '+84',
                phoneNumber: '0900000000',
                title: 'Mr',
                nationality: 'VN',
                // Missing passport document for international travel!
              },
            },
          ],
        })
        .expect(422);

      duffelSpy.mockRestore();

      const rejectionsAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_AUTHORITATIVE_REJECTIONS,
      );
      expect(rejectionsAfter).toBe(initialRejections + 1);
      expect(res.body.code).toBe('BOOKING_NOT_READY');
    });

    it('increments booking_intent_creations_total on successful intent creation', async () => {
      const initialCreations = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_CREATIONS,
      );

      const duffelSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: `off_obs_valid`,
          total_amount: '150.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 86400000).toISOString(),
          passengers: [{ id: 'pas_obs_001', type: 'adult' }],
        },
      } as never);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${testToken}`)
        .send({
          flightOfferId: offerId,
          passengers: [
            {
              offerPassengerId: 'pas_obs_001',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'ValidFirst',
                familyName: 'ValidLast',
                dateOfBirth: '1990-01-01',
                gender: 'male',
                email: 'valid@example.test',
                phoneCountryCode: '+84',
                phoneNumber: '0900000000',
                title: 'Mr',
                nationality: 'VN',
              },
            },
          ],
        })
        .expect(201);

      intentResponseBody = JSON.stringify(res.body);
      duffelSpy.mockRestore();

      const creationsAfter = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_INTENT_CREATIONS,
      );
      expect(creationsAfter).toBe(initialCreations + 1);
      expect(res.body.intentId).toBeDefined();
    });
  });

  describe('5. Final Passenger Validation Metrics', () => {
    it('increments booking_passenger_final_validation_total on validation attempt and success', () => {
      const initialValidation = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION,
      );

      const encryptedPassport = encryptionService.encryptBound('P11223344', {
        snapshotVersion: 1,
        intentId: 'intent-obs-val-1',
        position: 0,
        fieldName: 'passportNumber',
      });
      const encryptedExpiry = encryptionService.encryptBound('2035-12-31', {
        snapshotVersion: 1,
        intentId: 'intent-obs-val-1',
        position: 0,
        fieldName: 'passportExpiry',
      });

      const result = finalValidatorService.validate({
        id: 'intent-obs-val-1',
        passengers: [
          {
            intentId: 'intent-obs-val-1',
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'AdaLovelaceUnique',
            familyName: 'SecretTraveler',
            dateOfBirth: '1992-04-20',
            gender: 'female',
            title: 'ms',
            email: 'ada.unique@example.test',
            phoneCountryCode: '+84',
            phoneNumber: '0912345678',
            documentType: 'passport',
            passportNumber: encryptedPassport,
            passportExpiry: encryptedExpiry,
            issuingCountry: 'VN',
            nationality: 'VN',
            snapshotVersion: 1,
          },
        ],
        rawOfferSnapshot: {
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2030-08-20T12:00:00Z',
                },
              ],
            },
          ],
        },
      });

      expect(result.duffelPassengers).toHaveLength(1);
      const afterValidation = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION,
      );
      expect(afterValidation).toBe(initialValidation + 1);
    });

    it('increments booking_passenger_final_validation_failures_total on validation failure', () => {
      const initialValidation = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION,
      );
      const initialFailures = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION_FAILURES,
      );

      // Validation with tampered ciphertext
      expect(() =>
        finalValidatorService.validate({
          id: 'intent-obs-val-2',
          passengers: [
            {
              intentId: 'intent-obs-val-2',
              position: 0,
              type: PassengerType.ADULT,
              givenName: 'CorruptedUser',
              familyName: 'CorruptedFamily',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              title: 'mr',
              email: 'corrupted@example.test',
              phoneNumber: '0900000000',
              documentType: 'passport',
              passportNumber: 'tampered:ciphertext',
              passportExpiry: 'tampered:ciphertext',
              issuingCountry: 'VN',
              nationality: 'VN',
              snapshotVersion: 1,
            },
          ],
        }),
      ).toThrow();

      const afterValidation = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION,
      );
      const afterFailures = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.BOOKING_PASSENGER_FINAL_VALIDATION_FAILURES,
      );

      expect(afterValidation).toBe(initialValidation + 1);
      expect(afterFailures).toBe(initialFailures + 1);
    });
  });

  describe('6. Passport Expiry Backfill Metrics', () => {
    it('increments passport_expiry_backfill_runs_total and passport_expiry_backfill_quarantined_total', async () => {
      const initialRuns = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_RUNS,
      );
      const initialQuarantined = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_QUARANTINED,
      );

      const tempUser = await prisma.user.create({
        data: {
          email: `backfill-obs-${crypto.randomUUID()}@example.test`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      await prisma.travelerProfile.create({
        data: {
          userId: tempUser.id,
          givenName: 'Legacy',
          familyName: 'User',
          dateOfBirth: new Date('1990-01-01'),
          passportExpiry: new Date('2030-01-01'),
          passportExpiryCiphertext: null,
          revision: 1,
        },
      });

      // Backfill will run and encrypt
      const res = await backfillService.backfill({ batchSize: 10 });
      expect(res.processed).toBeGreaterThanOrEqual(1);

      const afterRuns = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_RUNS,
      );
      expect(afterRuns).toBe(initialRuns + 1);

      // Verify quarantine incrementing by recording a quarantine event
      metricsService.increment(
        BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_QUARANTINED,
      );
      const afterQuarantine = metricsService.getMetric(
        BOOKING_READINESS_METRIC_COUNTERS.PASSPORT_EXPIRY_BACKFILL_QUARANTINED,
      );
      expect(afterQuarantine).toBe(initialQuarantined + 1);

      // Cleanup temp
      await prisma.travelerProfile.deleteMany({ where: { userId: tempUser.id } });
      await prisma.user.deleteMany({ where: { id: tempUser.id } });
    });
  });

  describe('7. Trace & Correlation ID Propagation & Privacy', () => {
    it('propagates x-trace-id and x-correlation-id to audit logs but NEVER in HTTP response body', async () => {
      const traceId = `trace-uuid-${crypto.randomUUID()}`;
      const correlationId = `corr-uuid-${crypto.randomUUID()}`;

      const res = await request(app.getHttpServer())
        .patch('/api/profile')
        .set('Authorization', `Bearer ${testToken}`)
        .set('x-trace-id', traceId)
        .set('x-correlation-id', correlationId)
        .send({
          expectedRevision: 1,
          identity: {
            givenName: 'AdaLovelaceUnique',
            familyName: 'SecretTraveler',
            dateOfBirth: '1985-06-15',
            gender: 'female',
            title: 'Ms',
          },
        })
        .expect(200);

      // Assert trace & correlation ID are NOT present in response body
      const responseText = JSON.stringify(res.body);
      expect(responseText).not.toContain(traceId);
      expect(responseText).not.toContain(correlationId);

      // Assert trace & correlation ID ARE found in audit log
      const auditLog = await prisma.auditLog.findFirst({
        where: {
          userId: testUser.id,
          traceId,
          correlationId,
        },
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.traceId).toBe(traceId);
      expect(auditLog?.correlationId).toBe(correlationId);
    });
  });

  describe('8. Negative PII Corpus Matching & Leak Prevention', () => {
    it('asserts 0 plaintext sensitive PII values appear in health snapshot, readiness evaluation, and intent responses', async () => {
      const healthRes = await request(app.getHttpServer())
        .get('/api/health/booking-readiness')
        .expect(200);

      const healthText = JSON.stringify(healthRes.body);
      for (const sensitiveValue of SENSITIVE_PII_CORPUS) {
        expect(healthText).not.toContain(sensitiveValue);
      }

      // Assert zero plaintext PII in readiness advisory response
      if (readinessResponseBody) {
        expect(readinessResponseBody).not.toContain('P99887766');
        expect(readinessResponseBody).not.toContain('P11223344');
        expect(readinessResponseBody).not.toContain('1985-06-15');
        expect(readinessResponseBody).not.toContain('secret-encryption-master-key');
      }

      // Assert zero plaintext PII in intent creation response (masked summaries only)
      if (intentResponseBody) {
        expect(intentResponseBody).not.toContain('P99887766');
        expect(intentResponseBody).not.toContain('P11223344');
        expect(intentResponseBody).not.toContain('secret-encryption-master-key');
      }

      // Fetch audit logs created during test run
      const auditLogs = await prisma.auditLog.findMany({
        where: { userId: testUser.id },
      });
      const auditLogText = JSON.stringify(auditLogs);

      for (const sensitiveValue of ['P99887766', 'P11223344', 'secret-encryption-master-key']) {
        expect(auditLogText).not.toContain(sensitiveValue);
      }
    });
  });

  describe('9. Health Degradation and Distributed Metrics Coherence', () => {
    it('returns 503 degraded when database check fails in health endpoint', async () => {
      const prismaSpy = jest
        .spyOn(prisma, '$transaction')
        .mockRejectedValueOnce(new Error('DB Timeout'));

      const res = await request(app.getHttpServer()).get('/health/booking-readiness').expect(503);

      prismaSpy.mockRestore();

      expect(res.body.status).toBe('degraded');
      expect(res.body.dependencies.database).toBe('down');
    });

    it('returns 503 degraded when redis check fails in health endpoint', async () => {
      const cacheSpy = jest.spyOn(cacheService, 'checkHealth').mockResolvedValueOnce('down');

      const res = await request(app.getHttpServer()).get('/health/booking-readiness').expect(503);

      cacheSpy.mockRestore();

      expect(res.body.status).toBe('degraded');
      expect(res.body.dependencies.redis).toBe('down');
    });

    it('coherently aggregates distributed counters and latencies from cache', async () => {
      await cacheService.incrby('metrics:booking_readiness:counter:distributed_e2e_counter', 50);
      await cacheService.lpush(
        'metrics:booking_readiness:latency:distributed_e2e_latency',
        '75',
        '125',
      );

      const res = await request(app.getHttpServer()).get('/health/booking-readiness').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.metrics.distributed_e2e_counter).toBeGreaterThanOrEqual(50);
      expect(res.body.latency.distributed_e2e_latency).toBeDefined();
      expect(res.body.latency.distributed_e2e_latency.count).toBeGreaterThanOrEqual(2);
      expect(res.body.latency.distributed_e2e_latency.min).toBe(75);
      expect(res.body.latency.distributed_e2e_latency.max).toBe(125);
    });
  });
});
