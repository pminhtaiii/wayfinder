process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import Stripe from 'stripe';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { DuffelOrderAdapter } from '@/supplier/order/duffel-order.adapter';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import {
  Prisma,
  PaymentStatus,
  BookingStatus,
  FlightOffer,
  BookingIntent,
  Payment,
} from '@prisma/client';
import * as crypto from 'crypto';

function assertDisposableDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    (!/(test|e2e|flight_booking)/i.test(databaseUrl) && process.env.NODE_ENV !== 'test')
  ) {
    throw new Error(
      'Refusing to run destructive E2E cleanup against non-test database. Ensure DATABASE_URL targets a test/e2e database or NODE_ENV is set to "test".',
    );
  }
}

interface MockDuffelOrder {
  id: string;
  booking_reference: string;
  slices: Array<{
    duration: string;
    segments: Array<{
      id: string;
      duration: string;
      departing_at: string;
      arriving_at: string;
      origin: {
        iata_code: string;
        name: string;
        city_name: string;
      };
      destination: {
        iata_code: string;
        name: string;
        city_name: string;
      };
      operating_carrier: {
        iata_code: string;
        name: string;
      };
      marketing_carrier: {
        iata_code: string;
        name: string;
      };
      marketing_carrier_flight_number: string;
      passengers: Array<{ cabin_class: string }>;
    }>;
  }>;
  passengers: Array<{
    id: string;
    type: string;
    given_name: string;
    family_name: string;
  }>;
}

describe('Payment Fulfillment (E2E Characterization)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let duffelOrderAdapter: DuffelOrderAdapter;
  let duffelCancellationService: DuffelCancellationService;
  let duffelRecoveryService: DuffelRecoveryService;
  let idempotencyService: PaymentIdempotencyService;
  let bookingLifecycleService: BookingLifecycleService;

  let testUser: { id: string; email: string };
  let testToken: string;

  beforeAll(async () => {
    assertDisposableDatabase();

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
    duffelCancellationService = moduleFixture.get<DuffelCancellationService>(DuffelCancellationService);
    duffelRecoveryService = moduleFixture.get<DuffelRecoveryService>(DuffelRecoveryService);
    idempotencyService = moduleFixture.get<PaymentIdempotencyService>(PaymentIdempotencyService);
    bookingLifecycleService = moduleFixture.get<BookingLifecycleService>(BookingLifecycleService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    assertDisposableDatabase();

    // Human approval 2026-10-02: supply the existing adult fixture at the new offer boundary.
    jest.spyOn(duffelOrderAdapter, 'getOfferById').mockResolvedValue({
      passengers: [{ id: 'pas_1', type: 'adult' }],
    });

    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
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

    const user = await prisma.user.create({
      data: {
        email: `fulfillment-test-${Date.now()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: user.id, email: user.email };
    testToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createFlightOffer(): Promise<FlightOffer> {
    return prisma.flightOffer.create({
      data: {
        searchHash: `search-${Date.now()}-${crypto.randomUUID()}`,
        supplierOfferId: `off_test_${Date.now()}_${crypto.randomUUID()}`,
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

  async function createBookingIntent(
    userId: string,
    flightOfferId: string,
  ): Promise<BookingIntent> {
    const now = new Date();
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId,
        supplierOfferId: `off_intent_${Date.now()}_${crypto.randomUUID()}`,
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

  async function createPaymentFixture(
    userId: string,
    intentId: string,
  ): Promise<Payment> {
    const createIdemKey = await prisma.idempotencyKey.create({
      data: {
        key: `idem-create-${crypto.randomUUID()}`,
        requestHash: 'seed-hash',
        customerId: userId,
        requestPath: '/api/bookings/payment/create',
        recoveryPoint: 'started',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    return prisma.payment.create({
      data: {
        bookingIntentId: intentId,
        attemptNumber: 1,
        idempotencyKeyId: createIdemKey.id,
        stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
        amount: 12550,
        currency: 'usd',
        status: PaymentStatus.CREATED,
        version: 0,
      },
    });
  }

  function getMockDuffelOrder(
    orderId = 'ord_char_200',
    reference = 'REF200',
  ): MockDuffelOrder {
    return {
      id: orderId,
      booking_reference: reference,
      slices: [
        {
          duration: 'PT2H0M',
          segments: [
            {
              id: 'seg_1',
              duration: 'PT2H0M',
              departing_at: '2026-08-01T10:00:00Z',
              arriving_at: '2026-08-01T12:00:00Z',
              origin: {
                iata_code: 'SGN',
                name: 'Tan Son Nhat International Airport',
                city_name: 'Ho Chi Minh City',
              },
              destination: {
                iata_code: 'HAN',
                name: 'Noi Bai International Airport',
                city_name: 'Hanoi',
              },
              operating_carrier: {
                iata_code: 'VN',
                name: 'Vietnam Airlines',
              },
              marketing_carrier: {
                iata_code: 'VN',
                name: 'Vietnam Airlines',
              },
              marketing_carrier_flight_number: 'VN123',
              passengers: [{ cabin_class: 'economy' }],
            },
          ],
        },
      ],
      passengers: [
        {
          id: 'pas_1',
          type: 'adult',
          given_name: 'John',
          family_name: 'Doe',
        },
      ],
    };
  }

  describe('Scenario 1: HTTP 200 Immediate Success', () => {
    it('successfully confirms payment, creates duffel order, captures payment intent and marks booking CONFIRMED', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_200', 'REF200');

      // Mock Stripe PaymentIntent with subset properties required by payment confirmation
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      // Mock Duffel createOrder and retrieveCompleteOrder with required slice/segment snapshot fields
      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REF200',
        duffelOrderId: 'ord_char_200',
      });

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  describe('Scenario 2: HTTP 202 Tier 2 Handoff', () => {
    it('returns HTTP 202 with PENDING status and polling URL when execution exceeds 25s threshold', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const paymentFixture = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_202', 'REF202');

      // Mock Stripe retrievePaymentIntent with requires_capture status
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: paymentFixture.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      // Mock Duffel retrieveCompleteOrder with required snapshot fields
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: paymentFixture.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const origSetTimeout = global.setTimeout;
      const timeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
          if (ms === 25000) {
            return origSetTimeout(fn, 10);
          }
          return origSetTimeout(fn, ms);
        });

      // Make createOrder hang for 50ms so the 10ms Tier-2 handoff threshold fires first
      jest.spyOn(duffelOrderAdapter, 'createOrder').mockImplementation(
        () =>
          new Promise((resolve) =>
            origSetTimeout(
              () => resolve(mockOrder),
              50,
            ),
          ),
      );

      try {
        const res = await request(app.getHttpServer())
          .post('/api/bookings/payment/confirm')
          .set('Authorization', `Bearer ${testToken}`)
          .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
          .send({ paymentId: paymentFixture.id, bookingId })
          .expect(202);

        expect(res.body).toEqual({
          status: 'PENDING',
          message: 'Booking is being confirmed. Please poll status.',
          pollUrl: expect.stringContaining(
            `/api/bookings/payment/${paymentFixture.id}/status`,
          ),
        });

        // Wait for background fulfillment to complete before teardown/restoring mocks
        let finalPayment: Payment | null = null;
        for (let i = 0; i < 100; i++) {
          finalPayment = await prisma.payment.findUnique({
            where: { id: paymentFixture.id },
          });
          if (finalPayment?.status === PaymentStatus.SUCCEEDED) {
            break;
          }
          await new Promise((resolve) => origSetTimeout(resolve, 50));
        }
        expect(finalPayment).not.toBeNull();
        expect(finalPayment?.status).toBe(PaymentStatus.SUCCEEDED);
        const canonicalBooking = await prisma.booking.findUnique({
          where: { id: bookingId },
        });
        expect(canonicalBooking?.status).toBe(BookingStatus.CONFIRMED);
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  describe('Scenario 3: Idempotency Replay Asymmetry', () => {
    it('replays cached HTTP 200 response without duplicating Stripe or Duffel calls', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_char_replay', 'REFREPLAY');
      const idempotencyKey = `idem-confirm-${crypto.randomUUID()}`;

      // Mock Stripe retrievePaymentIntent with requires_capture status
      const retrieveSpy = jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent);

      // Mock Duffel createOrder and retrieveCompleteOrder with required snapshot fields
      const createOrderSpy = jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);

      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      // Mock Stripe capturePaymentIntent with succeeded status
      const captureSpy = jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'succeeded',
        } as unknown as Stripe.PaymentIntent);

      const payload = { paymentId: payment.id, bookingId };

      // First call succeeds (HTTP 200)
      const firstRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(firstRes.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFREPLAY',
        duffelOrderId: 'ord_char_replay',
      });

      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);

      // Replay call with identical Idempotency-Key and request payload
      const secondRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(secondRes.body).toEqual(firstRes.body);

      // Assert no second Stripe/Duffel calls
      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);
    });

    it('replays a completed failure with HTTP 200 and preserved failure body', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-confirm-fail-${crypto.randomUUID()}`;

      // Mock Stripe retrievePaymentIntent with requires_capture status
      const retrieveSpy = jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent);

      const duffelSpy = jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockRejectedValue(new Error('Duffel booking failed'));

      const cancelSpy = jest
        .spyOn(stripeService, 'cancelPaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'canceled',
        } as unknown as Stripe.PaymentIntent);

      const payload = { paymentId: payment.id, bookingId };

      // Initial request fails with HTTP 502 and saves responseCode: 502 in idempotency key
      const initialRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(502);

      expect(initialRes.body).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Duffel booking failed'),
        }),
      );

      const storedKey = await prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      expect(storedKey).not.toBeNull();
      expect(storedKey?.responseCode).toBe(502);
      expect(storedKey?.recoveryPoint).toBe('completed');

      // Replay call with exact request returns HTTP 200 (stored response code does not control replay status in existing controller)
      const replayRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(replayRes.body).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Duffel booking failed'),
        }),
      );

      // Assert no second downstream calls were made on replay
      expect(retrieveSpy).toHaveBeenCalledTimes(1);
      expect(duffelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it('reconstructs legacy completed success row without cached responseBody with HTTP 200', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-legacy-success-${crypto.randomUUID()}`;
      const payload = { paymentId: payment.id, bookingId };

      // Payment is SUCCEEDED
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCEEDED },
      });

      // PaymentEvent has duffel_order_created
      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'duffel_order_created',
          previousStatus: 'AUTHORIZED',
          newStatus: 'AUTHORIZED',
          amount: payment.amount,
          source: 'API',
          metadata: {
            id: 'ord_legacy_succ',
            booking_reference: 'REF_LEGACY_SUCC',
          },
          createdBy: testUser.id,
        },
      });

      // IdempotencyKey has recoveryPoint: 'completed' and responseBody: null
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: idempotencyService.computeHash(payload),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'completed',
          responseBody: Prisma.DbNull,
          responseCode: null,
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REF_LEGACY_SUCC',
        duffelOrderId: 'ord_legacy_succ',
      });

      const updatedKey = await prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      expect(updatedKey?.responseCode).toBe(200);
      expect(updatedKey?.responseBody).toEqual(
        expect.objectContaining({
          success: true,
          status: 'SUCCEEDED',
          bookingReference: 'REF_LEGACY_SUCC',
          duffelOrderId: 'ord_legacy_succ',
        }),
      );
    });

    it('reconstructs legacy completed failure row without cached responseBody with HTTP 200', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-legacy-fail-${crypto.randomUUID()}`;
      const payload = { paymentId: payment.id, bookingId };

      // Payment is CANCELLED
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.CANCELLED },
      });

      // IdempotencyKey has recoveryPoint: 'completed' and responseBody: null
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: idempotencyService.computeHash(payload),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'completed',
          responseBody: Prisma.DbNull,
          responseCode: null,
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(res.body).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Payment hold released'),
        }),
      );

      const updatedKey = await prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      expect(updatedKey?.responseCode).toBe(502);
      expect(updatedKey?.responseBody).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Payment hold released'),
        }),
      );
    });
  });

  describe('Scenario 4: Validation Rejection', () => {
    it('rejects with 400 when Idempotency-Key header is missing', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(400);

      expect(res.body.message).toContain('Idempotency-Key header is required');
    });

    it('rejects with 400 when request payload is invalid or missing paymentId', async () => {
      const bookingId = crypto.randomUUID();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ bookingId })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });
  });

  describe('Scenario 5: Controlled Compensation', () => {
    it('cancels Stripe hold, sets payment CANCELLED and booking FAILED on Duffel order failure', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();

      // Mock Stripe retrievePaymentIntent with requires_capture status
      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockRejectedValue(new Error('Duffel booking failed'));

      // Mock Stripe cancelPaymentIntent on Duffel failure compensation
      const cancelSpy = jest
        .spyOn(stripeService, 'cancelPaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'canceled',
        } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-confirm-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith(
        payment.stripePaymentIntentId,
        `${payment.stripePaymentIntentId}-stripe-void`,
      );

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.FAILED);
    });
  });

  describe('Scenario 6: Fenced Checkpoint Resumption', () => {
    it('resumes from CHECKPOINT_AUTHORIZED (stripe_authorized): skips hold authorization and proceeds to Duffel order, Stripe capture, and confirmation', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = `idem-resume-auth-${crypto.randomUUID()}`;
      const bookingId = crypto.randomUUID();
      const payload = { paymentId: '', bookingId };

      const idemKey = await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: 'pending-hash',
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'stripe_authorized',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKey.id,
          stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      payload.paymentId = payment.id;
      await prisma.idempotencyKey.update({
        where: { id: idemKey.id },
        data: { requestHash: idempotencyService.computeHash(payload) },
      });

      const mockOrder = getMockDuffelOrder('ord_resume_auth', 'REFAUTH');

      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent');
      const createOrderSpy = jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);
      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFAUTH',
        duffelOrderId: 'ord_resume_auth',
      });

      // Assert hold authorization is skipped on resumption
      expect(retrieveSpy).toHaveBeenCalledTimes(0);
      expect(createOrderSpy).toHaveBeenCalledTimes(1);
      expect(captureSpy).toHaveBeenCalledTimes(1);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);

      const updatedKey = await prisma.idempotencyKey.findUnique({ where: { id: idemKey.id } });
      expect(updatedKey?.recoveryPoint).toBe('completed');
    });

    it('resumes from CHECKPOINT_ORDER_CREATED (duffel_order_created): skips hold auth and Duffel order, proceeds to capture and confirmation', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = `idem-resume-order-${crypto.randomUUID()}`;
      const bookingId = crypto.randomUUID();
      const payload = { paymentId: '', bookingId };

      const idemKey = await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: 'pending-hash',
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'duffel_order_created',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKey.id,
          stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      payload.paymentId = payment.id;
      await prisma.idempotencyKey.update({
        where: { id: idemKey.id },
        data: { requestHash: idempotencyService.computeHash(payload) },
      });

      const mockOrder = getMockDuffelOrder('ord_resume_created', 'REFORDER');

      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'duffel_order_created',
          previousStatus: 'AUTHORIZED',
          newStatus: 'AUTHORIZED',
          amount: payment.amount,
          source: 'API',
          metadata: mockOrder as unknown as Prisma.InputJsonValue,
          createdBy: testUser.id,
        },
      });

      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent');
      const createOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);
      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFORDER',
        duffelOrderId: 'ord_resume_created',
      });

      // Assert both hold auth and order creation are skipped
      expect(retrieveSpy).toHaveBeenCalledTimes(0);
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(captureSpy).toHaveBeenCalledTimes(1);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);

      const updatedKey = await prisma.idempotencyKey.findUnique({ where: { id: idemKey.id } });
      expect(updatedKey?.recoveryPoint).toBe('completed');
    });

    it('resumes from CHECKPOINT_CAPTURED (captured): completes canonical confirmation without re-invoking capture or Duffel order', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = `idem-resume-captured-${crypto.randomUUID()}`;
      const bookingId = crypto.randomUUID();
      const payload = { paymentId: '', bookingId };

      const idemKey = await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: 'pending-hash',
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'captured',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKey.id,
          stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      payload.paymentId = payment.id;
      await prisma.idempotencyKey.update({
        where: { id: idemKey.id },
        data: { requestHash: idempotencyService.computeHash(payload) },
      });

      const mockOrder = getMockDuffelOrder('ord_resume_cap', 'REFCAP');

      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'duffel_order_created',
          previousStatus: 'AUTHORIZED',
          newStatus: 'AUTHORIZED',
          amount: payment.amount,
          source: 'API',
          metadata: mockOrder as unknown as Prisma.InputJsonValue,
          createdBy: testUser.id,
        },
      });

      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent');
      const createOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent');

      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFCAP',
        duffelOrderId: 'ord_resume_cap',
      });

      // Assert zero duplicate remote effects
      expect(retrieveSpy).toHaveBeenCalledTimes(0);
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(captureSpy).toHaveBeenCalledTimes(0);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);

      const ledgerEntries = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
      expect(ledgerEntries.length).toBe(2);

      const updatedKey = await prisma.idempotencyKey.findUnique({ where: { id: idemKey.id } });
      expect(updatedKey?.recoveryPoint).toBe('completed');
    });
  });

  describe('Scenario 7: Duplicate Remote Effects & Replay Invariants', () => {
    it('returns 409 Conflict when payment confirmation is already in-flight under active lease without duplicate provider calls', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-inflight-${crypto.randomUUID()}`;
      const payload = { paymentId: payment.id, bookingId };

      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: idempotencyService.computeHash(payload),
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'started',
          lockedAt: new Date(Date.now() - 30 * 1000), // active lease (30s old < 5m)
          responseBody: Prisma.DbNull,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent');
      const createOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(409);

      expect(res.body.message).toContain('Request is already in progress');
      expect(retrieveSpy).toHaveBeenCalledTimes(0);
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(captureSpy).toHaveBeenCalledTimes(0);
    });
  });

  describe('Scenario 8: Atomic Completion & Transaction Rollback', () => {
    it('verifies that Booking CONFIRMED, Payment SUCCEEDED, and balanced ledger entries commit atomically in one transaction', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_atomic_succ', 'REFATOMIC');

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-atomic-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(200);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);
      expect(dbBooking?.pnrReference).toBe('REFATOMIC');
      expect(dbBooking?.supplierOrderId).toBe('ord_atomic_succ');

      const dbIntent = await prisma.bookingIntent.findUnique({ where: { id: intent.id } });
      expect(dbIntent?.status).toBe('CONFIRMED');

      const capturedEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'payment_captured' },
      });
      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent?.newStatus).toBe('SUCCEEDED');

      const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
      expect(ledgers.length).toBe(2);
      const debit = ledgers.find((l) => l.entryType === 'DEBIT');
      const credit = ledgers.find((l) => l.entryType === 'CREDIT');
      expect(debit).toBeDefined();
      expect(credit).toBeDefined();
      expect(debit?.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(credit?.accountId).toBe('PLATFORM_REVENUE');
      expect(debit?.amount.toString()).toBe(payment.amount.toString());
      expect(credit?.amount.toString()).toBe(payment.amount.toString());
      expect(debit?.transactionId).toBe(credit?.transactionId);
    });

    it('rolls back completely on DB failure during post-capture confirmation without canceling payment or order', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_atomic_fail', 'REFFAIL');
      const idempotencyKey = `idem-rollback-${crypto.randomUUID()}`;

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      const origTransaction = prisma.$transaction.bind(prisma);
      jest.spyOn(prisma, '$transaction').mockImplementation(async (cb: any, ...args: any[]) => {
        if (typeof cb === 'function') {
          return origTransaction(async (tx: any) => {
            let isConfirmationTx = false;
            const origCreateMany = tx.ledgerEntry?.createMany?.bind(tx.ledgerEntry);
            if (origCreateMany) {
              tx.ledgerEntry.createMany = async (...ledgerArgs: any[]) => {
                isConfirmationTx = true;
                return origCreateMany(...ledgerArgs);
              };
            }
            await cb(tx);
            if (isConfirmationTx) {
              // At this point in tx:
              // 1. tx.payment.updateMany (status: SUCCEEDED)
              // 2. tx.paymentEvent.create (payment_captured)
              // 3. tx.bookingIntent.update (status: CONFIRMED)
              // 4. bookingLifecycleService.updateToConfirmed (real booking update to CONFIRMED with PNR)
              // 5. tx.ledgerEntry.createMany (real creation of debit/credit ledger rows)
              // Now throw to force full PostgreSQL transaction rollback:
              throw new Error('Simulated DB constraint/deadlock during confirmation commit');
            }
          }, ...args);
        }
        return origTransaction(cb, ...args);
      });

      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');
      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder');

      await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ paymentId: payment.id, bookingId })
        .expect(500);

      // Verify transaction rollback:
      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).not.toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).not.toBe(BookingStatus.CONFIRMED);

      const dbBookingIntent = await prisma.bookingIntent.findUnique({ where: { id: intent.id } });
      expect(dbBookingIntent?.status).not.toBe('CONFIRMED');

      const paymentEvents = await prisma.paymentEvent.findMany({
        where: { paymentId: payment.id, eventType: 'payment_captured' },
      });
      expect(paymentEvents.length).toBe(0);

      const ledgers = await prisma.ledgerEntry.findMany({ where: { paymentId: payment.id } });
      expect(ledgers.length).toBe(0);

      // STRICT INVARIANT: Known capture NEVER cancels order or payment hold!
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);
      expect(cancelOrderSpy).toHaveBeenCalledTimes(0);

      // Checkpoint was advanced to captured so state remains recoverable
      const storedKey = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      expect(storedKey?.recoveryPoint).toBe('captured');
    });
  });

  describe('Scenario 9: Stale Owner Takeover & CAS Eviction', () => {
    it('aborts and prevents provider call when ownership is lost before hold authorization', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-cas-auth-${crypto.randomUUID()}`;

      // Hook getResumePoint to simulate concurrent lease takeover in PostgreSQL before authorizeHold
      jest.spyOn(idempotencyService, 'getResumePoint').mockImplementation(async (key: string) => {
        await prisma.idempotencyKey.update({
          where: { key },
          data: { lockedAt: new Date(Date.now() + 60000) },
        });
        return 'started';
      });

      const retrieveSpy = jest.spyOn(stripeService, 'retrievePaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ paymentId: payment.id, bookingId })
        .expect(409);

      expect(res.body.message).toContain('Idempotency key ownership lost');
      expect(retrieveSpy).toHaveBeenCalledTimes(0);
    });

    it('aborts and prevents Duffel order creation when ownership is lost before createOrder', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = `idem-cas-order-${crypto.randomUUID()}`;
      const bookingId = crypto.randomUUID();
      const payload = { paymentId: '', bookingId };

      const idemKey = await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: 'pending-hash',
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'stripe_authorized',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKey.id,
          stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      payload.paymentId = payment.id;
      await prisma.idempotencyKey.update({
        where: { id: idemKey.id },
        data: { requestHash: idempotencyService.computeHash(payload) },
      });

      const origFindUnique = prisma.bookingIntent.findUnique.bind(prisma.bookingIntent);
      jest.spyOn(prisma.bookingIntent as any, 'findUnique').mockImplementation(async (args: any) => {
        const result = await origFindUnique(args);
        if (args?.where?.id === intent.id) {
          await prisma.idempotencyKey.update({
            where: { key: idempotencyKey },
            data: { lockedAt: new Date(Date.now() + 60000) },
          });
        }
        return result;
      });

      const createOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(409);

      expect(res.body.message).toContain('Idempotency key ownership lost');
      expect(createOrderSpy).toHaveBeenCalledTimes(0);
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.AUTHORIZED);
    });

    it('aborts and prevents Stripe capture when ownership is lost before capturePayment', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = `idem-cas-cap-${crypto.randomUUID()}`;
      const bookingId = crypto.randomUUID();
      const payload = { paymentId: '', bookingId };

      const idemKey = await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: 'pending-hash',
          customerId: testUser.id,
          requestPath: '/api/bookings/payment/confirm',
          recoveryPoint: 'duffel_order_created',
          lockedAt: null,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intent.id,
          attemptNumber: 1,
          idempotencyKeyId: idemKey.id,
          stripePaymentIntentId: `pi_test_${crypto.randomUUID()}`,
          amount: 12550,
          currency: 'usd',
          status: PaymentStatus.AUTHORIZED,
          version: 0,
        },
      });

      payload.paymentId = payment.id;
      await prisma.idempotencyKey.update({
        where: { id: idemKey.id },
        data: { requestHash: idempotencyService.computeHash(payload) },
      });

      const mockOrder = getMockDuffelOrder('ord_cas_cap', 'REFCASCAP');
      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'duffel_order_created',
          previousStatus: 'AUTHORIZED',
          newStatus: 'AUTHORIZED',
          amount: payment.amount,
          source: 'API',
          metadata: mockOrder as unknown as Prisma.InputJsonValue,
          createdBy: testUser.id,
        },
      });

      jest.spyOn(idempotencyService, 'getResumePoint').mockImplementation(async (key: string) => {
        await prisma.idempotencyKey.update({
          where: { key },
          data: { lockedAt: new Date(Date.now() + 60000) },
        });
        return 'duffel_order_created';
      });

      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send(payload)
        .expect(409);

      expect(res.body.message).toContain('Idempotency key ownership lost');
      expect(captureSpy).toHaveBeenCalledTimes(0);
    });

    it('aborts compensation and prevents voidHold when ownership is lost during compensation', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-cas-comp-${crypto.randomUUID()}`;

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest.spyOn(duffelOrderAdapter, 'createOrder').mockImplementation(async () => {
        await prisma.idempotencyKey.update({
          where: { key: idempotencyKey },
          data: { lockedAt: new Date(Date.now() + 60000) },
        });
        throw new Error('Duffel failure triggering compensation');
      });

      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ paymentId: payment.id, bookingId })
        .expect(409);

      expect(res.body.message).toContain('Idempotency key ownership lost');
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.AUTHORIZED);
    });

    it('aborts gracefully in background execution after 25s handoff when ownership is taken over', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const idempotencyKey = `idem-cas-bg-${crypto.randomUUID()}`;
      const mockOrder = getMockDuffelOrder('ord_cas_bg', 'REFBG');

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      const origSetTimeout = global.setTimeout;
      const timeoutSpy = jest
        .spyOn(global, 'setTimeout')
        .mockImplementation((fn: Parameters<typeof setTimeout>[0], ms?: number) => {
          if (ms === 25000) {
            return origSetTimeout(fn, 10);
          }
          return origSetTimeout(fn, ms);
        });

      let orderStolenPromise: Promise<void>;
      let resolveOrderStolen: () => void;
      orderStolenPromise = new Promise((resolve) => {
        resolveOrderStolen = resolve;
      });

      jest.spyOn(duffelOrderAdapter, 'createOrder').mockImplementation(
        () =>
          new Promise((resolve) => {
            origSetTimeout(async () => {
              try {
                await prisma.idempotencyKey.updateMany({
                  where: { key: idempotencyKey },
                  data: { lockedAt: new Date(Date.now() + 60000) },
                });
              } catch {
                // Ignore teardown races
              } finally {
                resolveOrderStolen();
                resolve(mockOrder);
              }
            }, 50);
          }),
      );

      const captureSpy = jest.spyOn(stripeService, 'capturePaymentIntent');

      try {
        const res = await request(app.getHttpServer())
          .post('/api/bookings/payment/confirm')
          .set('Authorization', `Bearer ${testToken}`)
          .set('Idempotency-Key', idempotencyKey)
          .send({ paymentId: payment.id, bookingId })
          .expect(202);

        expect(res.body.status).toBe('PENDING');

        await orderStolenPromise;
        await new Promise((resolve) => origSetTimeout(resolve, 200));

        expect(captureSpy).toHaveBeenCalledTimes(0);

        const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
        expect(dbPayment?.status).not.toBe(PaymentStatus.SUCCEEDED);
      } finally {
        timeoutSpy.mockRestore();
      }
    });
  });

  describe('Scenario 10: Capture Throw Matrix', () => {
    it('proceeds to complete canonical booking when capture throws but subsequent status check reveals captured (succeeded)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_throw_succeeded', 'REFTHROWSUCC');

      jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent)
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'succeeded',
        } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockRejectedValue(new Error('Network socket hangup during capture'));

      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');
      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-throw-succ-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(200);

      expect(res.body).toEqual({
        success: true,
        status: 'SUCCEEDED',
        paymentId: payment.id,
        bookingReference: 'REFTHROWSUCC',
        duffelOrderId: 'ord_throw_succeeded',
      });

      // Strict Invariant: Known capture NEVER cancels!
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);
      expect(cancelOrderSpy).toHaveBeenCalledTimes(0);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.CONFIRMED);
    });

    it('cancels Duffel order, voids hold, and marks booking FAILED when capture throws and subsequent status check reveals authorized (requires_capture)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_throw_auth', 'REFTHROWAUTH');

      jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent)
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockRejectedValue(new Error('Card declined on capture'));

      // Human approval 2026-10-02: return an explicit provider confirmation for the successful-cancellation assertions.
      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder').mockResolvedValue({
        id: 'cancel_confirmed',
        status: 'confirmed',
      });
      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'canceled',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-throw-auth-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Duffel order cancelled and hold released');

      expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
      expect(cancelHoldSpy).toHaveBeenCalledTimes(1);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.FAILED);
    });

    it('cancels Duffel order, voids hold, and marks booking FAILED when capture throws and subsequent status check reveals voided (canceled)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_throw_void', 'REFTHROWVOID');

      jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent)
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'canceled',
        } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockRejectedValue(new Error('Card declined on capture'));

      // Human approval 2026-10-02: return an explicit provider confirmation for the successful-cancellation assertions.
      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder').mockResolvedValue({
        id: 'cancel_confirmed',
        status: 'confirmed',
      });
      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'canceled',
      } as unknown as Stripe.PaymentIntent);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-throw-void-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Duffel order cancelled and hold released');

      expect(cancelOrderSpy).toHaveBeenCalledTimes(1);
      expect(cancelHoldSpy).toHaveBeenCalledTimes(1);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.FAILED);
    });

    it('leaves state recoverable without canceling order or payment when capture throws and status check is unavailable', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_throw_unavail', 'REFTHROWN');

      jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValueOnce({
          id: payment.stripePaymentIntentId,
          status: 'requires_capture',
        } as unknown as Stripe.PaymentIntent)
        .mockRejectedValueOnce(new Error('Stripe API unavailable during status check'));

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);

      jest
        .spyOn(stripeService, 'capturePaymentIntent')
        .mockRejectedValue(new Error('Capture socket dropped'));

      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder');
      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-throw-unavail-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body).toEqual(
        expect.objectContaining({
          success: false,
          error: 'Stripe capture outcome is unknown. Retry payment confirmation.',
          bookingStatus: 'PROCESSING',
        }),
      );

      // Strict Invariant: Unknown capture outcome MUST NOT cancel order or hold!
      expect(cancelOrderSpy).toHaveBeenCalledTimes(0);
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.AUTHORIZED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).not.toBe(BookingStatus.FAILED);
    });
  });

  describe('Scenario 11: Failed Compensation & DB Failure Handling', () => {
    it('safely handles failed hold voiding during Duffel failure compensation without leaking internal stack traces', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockRejectedValue(new Error('Duffel route unavailable'));

      jest
        .spyOn(stripeService, 'cancelPaymentIntent')
        .mockRejectedValue(new Error('Stripe cancel error 500'));

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `idem-fail-comp-${crypto.randomUUID()}`)
        .send({ paymentId: payment.id, bookingId })
        .expect(502);

      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Duffel booking failed');
      expect(res.body.error).not.toContain('Stripe cancel error 500');

      const dbPayment = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(dbPayment?.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking?.status).toBe(BookingStatus.FAILED);
    });

    it('preserves capture and does not cancel payment when post-capture DB confirmation fails', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payment = await createPaymentFixture(testUser.id, intent.id);
      const bookingId = crypto.randomUUID();
      const mockOrder = getMockDuffelOrder('ord_db_fail', 'REFDBFAIL');
      const idempotencyKey = `idem-db-fail-${crypto.randomUUID()}`;

      jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'requires_capture',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockResolvedValue(mockOrder);
      jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValue(mockOrder);
      jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
        id: payment.stripePaymentIntentId,
        status: 'succeeded',
      } as unknown as Stripe.PaymentIntent);

      jest
        .spyOn(bookingLifecycleService, 'updateToConfirmed')
        .mockRejectedValue(new Error('Disk I/O failure during updateToConfirmed'));

      const cancelHoldSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');
      const cancelOrderSpy = jest.spyOn(duffelCancellationService, 'cancelOrder');

      await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ paymentId: payment.id, bookingId })
        .expect(500);

      // Known capture NEVER cancels:
      expect(cancelHoldSpy).toHaveBeenCalledTimes(0);
      expect(cancelOrderSpy).toHaveBeenCalledTimes(0);

      const keyRecord = await prisma.idempotencyKey.findUnique({ where: { key: idempotencyKey } });
      expect(keyRecord?.recoveryPoint).toBe('captured');
    });
  });
});
