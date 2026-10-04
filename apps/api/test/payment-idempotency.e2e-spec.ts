process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { DuffelOrderAdapter } from '@/supplier/order/duffel-order.adapter';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma, PaymentStatus } from '@prisma/client';
import * as crypto from 'crypto';

describe('Payment Idempotency (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let duffelOrderAdapter: DuffelOrderAdapter;
  let duffelRecoveryService: DuffelRecoveryService;

  let testUser: { id: string; email: string };
  let testToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    stripeService = moduleFixture.get<StripeService>(StripeService);
    duffelOrderAdapter = moduleFixture.get<DuffelOrderAdapter>(DuffelOrderAdapter);
    duffelRecoveryService = moduleFixture.get<DuffelRecoveryService>(DuffelRecoveryService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Human approval 2026-10-02: supply the existing adult fixture at the new offer boundary.
    jest.spyOn(duffelOrderAdapter, 'getOfferById').mockResolvedValue({
      passengers: [{ id: 'pas_1', type: 'adult' }],
    });

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

    const u = await prisma.user.create({
      data: {
        email: 'idempotency-test@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: u.id, email: u.email };
    testToken = jwtService.sign({ id: u.id, email: u.email }, { expiresIn: '24h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createFlightOffer() {
    return prisma.flightOffer.create({
      data: {
        searchHash: 'idem-search-hash',
        supplierOfferId: `off_idem_${Date.now()}`,
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100.0),
        currency: 'USD',
      },
    });
  }

  async function createBookingIntent(userId: string, flightOfferId: string) {
    const now = new Date();
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId,
        supplierOfferId: `off_idem_${Date.now()}`,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal(100.0),
        confirmedPrice: new Prisma.Decimal(125.5),
        currency: 'USD',
        priceChanged: false,
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2026-08-01T12:00:00Z',
                  operating_carrier: { iata_code: 'VN' },
                  marketing_carrier: { iata_code: 'VN' },
                  operating_carrier_flight_number: '123',
                },
              ],
            },
          ],
        },
        intentExpiresAt: new Date(now.getTime() + 3600 * 1000),
        paymentAttemptCount: 0,
        passengers: {
          create: [
            {
              position: 0,
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: new Date('1990-01-01'),
              gender: 'male',
              title: 'mr',
              email: 'john.doe@example.com',
              phoneCountryCode: '+1',
              phoneNumber: '5551234567',
            },
          ],
        },
      },
    });
  }

  function mockStripeCreate() {
    jest.spyOn(stripeService, 'createCustomer').mockResolvedValue({
      id: 'cus_idem_mock',
      email: 'idempotency-test@example.com',
    } as any);

    jest.spyOn(stripeService, 'createPaymentIntent').mockResolvedValue({
      id: 'pi_idem_mock',
      client_secret: 'pi_idem_mock_secret',
      status: 'requires_payment_method',
    } as any);
  }

  function computeHash(body: Record<string, unknown>): string {
    const sorted = sortKeys(body);
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  }

  function sortKeys(obj: unknown): unknown {
    if (Array.isArray(obj)) return obj.map(sortKeys);
    if (obj !== null && typeof obj === 'object') {
      return Object.keys(obj as Record<string, unknown>)
        .sort()
        .reduce(
          (acc, key) => {
            (acc as Record<string, unknown>)[key] = sortKeys((obj as Record<string, unknown>)[key]);
            return acc;
          },
          {} as Record<string, unknown>,
        );
    }
    return obj;
  }

  describe('POST /api/bookings/payment/create - Idempotency', () => {
    it('replays cached response when same idempotency key is used (only 1 Payment in DB)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      mockStripeCreate();

      const key = 'idem-replay-test-001';

      const first = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      expect(first.body.paymentId).toBeDefined();
      expect(first.body.clientSecret).toBe('pi_idem_mock_secret');

      // Second request with same key should replay
      const second = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      expect(second.body.paymentId).toBe(first.body.paymentId);
      expect(second.body.clientSecret).toBe(first.body.clientSecret);

      // Only one Payment in DB
      const payments = await prisma.payment.findMany({
        where: { bookingIntentId: intent.id },
      });
      expect(payments.length).toBe(1);

      // Stripe should only have been called once
      expect(stripeService.createPaymentIntent).toHaveBeenCalledTimes(1);
    });

    it('returns 422 when same key is used with different payload', async () => {
      const offer = await createFlightOffer();
      const intentA = await createBookingIntent(testUser.id, offer.id);

      // Create a second booking intent with a different offer
      const offer2 = await prisma.flightOffer.create({
        data: {
          searchHash: 'idem-search-hash-2',
          supplierOfferId: `off_idem_2_${Date.now()}`,
          rawOffer: {},
          origin: 'SGN',
          destination: 'DAD',
          departureDate: new Date('2026-08-15'),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(200.0),
          currency: 'USD',
        },
      });
      const intentB = await createBookingIntent(testUser.id, offer2.id);

      mockStripeCreate();

      const key = 'idem-hash-mismatch-002';

      // First request succeeds
      await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send({ bookingIntentId: intentA.id, saveCard: false })
        .expect(201);

      // Second request with same key but different payload → 422
      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send({ bookingIntentId: intentB.id, saveCard: false })
        .expect(422);

      expect(res.body.message).toContain('Idempotency key reuse with different payload');
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);

      await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(400);
    });
  });

  describe('Recovery point resumption - POST /api/bookings/payment/confirm', () => {
    it('resumes from stripe_authorized recovery point', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);

      // Create idempotency key with recoveryPoint = stripe_authorized
      const idemKeyRecord = await prisma.idempotencyKey.create({
        data: {
          key: 'idem-recovery-resume-003',
          requestHash: computeHash({ paymentId: 'will-be-set', bookingId: 'will-be-set' }),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'stripe_authorized',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      // Create a Payment in AUTHORIZED status
      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKeyRecord.id,
          stripePaymentIntentId: `pi_recovery_${Date.now()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      // Update idempotency key hash to match the confirm request body
      const confirmBody = { paymentId: payment.id, bookingId: intent.id };
      await prisma.idempotencyKey.update({
        where: { id: idemKeyRecord.id },
        data: { requestHash: computeHash(confirmBody) },
      });

      // Mock Stripe capture + Duffel order for the resume flow
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as any);

      jest.spyOn(duffelOrderAdapter, 'createOrder').mockResolvedValue({
        id: `order_${Date.now()}`,
        booking_reference: 'ABC123',
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: '2026-08-01T10:00:00Z',
                arriving_at: '2026-08-01T12:00:00Z',
                operating_carrier: { iata_code: 'VN' },
                marketing_carrier: { iata_code: 'VN' },
                operating_carrier_flight_number: '123',
              },
            ],
          },
        ],
      } as any);

      jest.spyOn(duffelRecoveryService, 'retrieveCompleteOrder').mockResolvedValue({
        id: `order_${Date.now()}`,
        booking_reference: 'ABC123',
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: '2026-08-01T10:00:00Z',
                arriving_at: '2026-08-01T12:00:00Z',
                operating_carrier: { iata_code: 'VN' },
                marketing_carrier: { iata_code: 'VN' },
                operating_carrier_flight_number: '123',
              },
            ],
          },
        ],
        passengers: [],
      } as any);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', 'idem-recovery-resume-003')
        .send(confirmBody);

      // Should succeed or return 202 (pending background work)
      expect([200, 202]).toContain(res.status);

      // Verify recovery point advanced beyond stripe_authorized
      const updatedKey = await prisma.idempotencyKey.findUnique({
        where: { id: idemKeyRecord.id },
      });
      expect(updatedKey).toBeDefined();
      const advancedPoints = ['duffel_order_created', 'captured', 'completed'];
      expect(advancedPoints).toContain(updatedKey?.recoveryPoint);
    });

    it('replays completed result without calling Stripe or Duffel again', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);

      // Create a completed Payment
      const idemKey = `idem-completed-${Date.now()}`;
      const idemKeyRecord = await prisma.idempotencyKey.create({
        data: {
          key: idemKey,
          requestHash: computeHash({ paymentId: 'temp', bookingId: intent.id }),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'completed',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
          responseBody: JSON.stringify({
            success: true,
            paymentId: 'dummy-payment-id',
            status: 'SUCCEEDED',
            bookingReference: 'REPLAY123',
            duffelOrderId: 'order_replay_xyz',
          }),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKeyRecord.id,
          stripePaymentIntentId: `pi_done_${Date.now()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.SUCCEEDED,
          version: 0,
        },
      });

      const confirmBody = { paymentId: payment.id, bookingId: intent.id };
      await prisma.idempotencyKey.update({
        where: { id: idemKeyRecord.id },
        data: {
          requestHash: computeHash(confirmBody),
          responseBody: JSON.stringify({
            success: true,
            paymentId: payment.id,
            status: 'SUCCEEDED',
            bookingReference: 'REPLAY123',
            duffelOrderId: 'order_replay_xyz',
          }),
        },
      });

      const stripeSpy = jest.spyOn(stripeService, 'capturePaymentIntent');
      const duffelSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idemKey)
        .send(confirmBody)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.bookingReference).toBe('REPLAY123');

      // Neither external service should have been called
      expect(stripeSpy).not.toHaveBeenCalled();
      expect(duffelSpy).not.toHaveBeenCalled();
    });
  });

  describe('Acquisition Edge Cases and Stale Lock CAS Eviction', () => {
    it('returns 409 Conflict when request is actively in progress within 5-minute lease', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const key = `idem-active-lock-${Date.now()}`;
      const payload = { bookingIntentId: intent.id, saveCard: false };

      await prisma.idempotencyKey.create({
        data: {
          key,
          requestHash: computeHash(payload),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/create',
          recoveryPoint: 'started',
          lockedAt: new Date(Date.now() - 30 * 1000),
          responseBody: Prisma.DbNull,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(409);

      expect(res.body.message).toContain('Request is already in progress');
    });

    it('successfully acquires and takes over stale lock when existing lockedAt is older than 5 minutes', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const key = `idem-stale-takeover-${Date.now()}`;
      const payload = { bookingIntentId: intent.id, saveCard: false };
      const staleTimestamp = new Date(Date.now() - 6 * 60 * 1000);

      await prisma.idempotencyKey.create({
        data: {
          key,
          requestHash: computeHash(payload),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/create',
          recoveryPoint: 'started',
          lockedAt: staleTimestamp,
          responseBody: Prisma.DbNull,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      mockStripeCreate();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(201);

      expect(res.body.paymentId).toBeDefined();

      const updatedKey = await prisma.idempotencyKey.findUnique({
        where: { key },
      });
      expect(updatedKey?.responseCode).toBe(201);
      expect(updatedKey?.responseBody).not.toBeNull();
    });

    it('returns 409 Conflict when key is used across different customers (customerId mismatch)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const key = `idem-scope-mismatch-${Date.now()}`;
      const payload = { bookingIntentId: intent.id, saveCard: false };

      const otherUser = await prisma.user.create({
        data: {
          email: `other-user-${Date.now()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      await prisma.idempotencyKey.create({
        data: {
          key,
          requestHash: computeHash(payload),
          customerId: otherUser.id,
          requestPath: '/api/bookings/payment/create',
          recoveryPoint: 'started',
          lockedAt: null,
          responseBody: Prisma.DbNull,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', key)
        .send(payload)
        .expect(409);

      expect(res.body.message).toContain('Idempotency key is not valid for this request');
    });
  });
});
