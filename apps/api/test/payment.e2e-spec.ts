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
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma } from '@prisma/client';

describe('Payment (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;

  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;

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
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean tables in FK-dependency order
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatMessage.deleteMany({});
    await prisma.chatSession.deleteMany({});
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

    // Create test users
    const uA = await prisma.user.create({
      data: {
        email: 'usera@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userA = { id: uA.id, email: uA.email };
    tokenA = jwtService.sign({ id: uA.id, email: uA.email }, { expiresIn: '24h' });

    const uB = await prisma.user.create({
      data: {
        email: 'userb@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userB = { id: uB.id, email: uB.email };
    tokenB = jwtService.sign({ id: uB.id, email: uB.email }, { expiresIn: '24h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createMockFlightOffer(data: Partial<Prisma.FlightOfferCreateInput> = {}) {
    return prisma.flightOffer.create({
      data: {
        searchHash: 'test-search-hash',
        supplierOfferId: 'off_duffel_123',
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100.0),
        currency: 'USD',
        ...data,
      },
    });
  }

  async function createBookingIntent(
    userId: string,
    offerId: string,
    overrides: Partial<{
      status: string;
      paymentAttemptCount: number;
    }> = {},
  ) {
    const now = new Date();
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId: offerId,
        supplierOfferId: 'off_duffel_123',
        status: (overrides.status as any) || 'AWAITING_PAYMENT',
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
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(now.getTime() + 3600 * 1000),
        paymentAttemptCount: overrides.paymentAttemptCount ?? 0,
        passengers: {
          create: [
            {
              position: 0,
              type: 'ADULT',
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: new Date('1990-01-01'),
              gender: 'male',
            },
          ],
        },
      },
    });
  }

  function mockStripeCreate() {
    jest.spyOn(stripeService, 'createCustomer').mockResolvedValue({
      id: 'cus_mock_123',
      email: 'usera@example.com',
    } as any);

    jest.spyOn(stripeService, 'createPaymentIntent').mockResolvedValue({
      id: 'pi_mock_456',
      client_secret: 'pi_mock_456_secret_abc',
      status: 'requires_payment_method',
    } as any);
  }

  describe('POST /api/bookings/payment/create', () => {
    it('creates payment with valid booking intent (201)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);
      mockStripeCreate();

      const idempotencyKey = 'idem-key-create-001';
      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      expect(res.body.paymentId).toBeDefined();
      expect(res.body.clientSecret).toBe('pi_mock_456_secret_abc');
      expect(res.body.status).toBe('CREATED');

      // Verify Payment record in DB
      const payment = await prisma.payment.findUnique({
        where: { id: res.body.paymentId },
      });
      expect(payment).toBeDefined();
      expect(payment!.bookingIntentId).toBe(intent.id);
      expect(payment!.stripePaymentIntentId).toBe('pi_mock_456');
      expect(payment!.amount).toBe(12550); // 125.50 * 100
      expect(payment!.currency).toBe('usd');
      expect(payment!.status).toBe('CREATED');
      expect(payment!.attemptNumber).toBe(1);

      // Verify PaymentEvent created
      const events = await prisma.paymentEvent.findMany({
        where: { paymentId: res.body.paymentId },
      });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.eventType === 'payment_created')).toBe(true);

      // Verify Stripe was called with correct params
      expect(stripeService.createCustomer).toHaveBeenCalledWith(
        'usera@example.com',
        undefined,
        expect.stringContaining('customer-create:'),
      );
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        12550, // amount in cents
        'USD',
        'cus_mock_123',
        { bookingIntentId: intent.id },
        expect.stringContaining('-stripe-intent'),
        undefined,
        undefined,
      );
    });

    it('returns 400 when Idempotency-Key header is missing', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);

      await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(400);
    });

    it('returns 403 when booking intent belongs to another user', async () => {
      const offer = await createMockFlightOffer();
      // Create intent owned by userB
      const intent = await createBookingIntent(userB.id, offer.id);
      mockStripeCreate();

      await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idem-key-forbidden-002')
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(403);
    });

    it('returns 400 when payment attempts are exhausted', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id, {
        paymentAttemptCount: 2,
      });
      mockStripeCreate();

      const res = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idem-key-exhausted-003')
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(400);

      expect(res.body.message).toContain('Payment attempts exhausted');
    });

    it('replays response for the same idempotency key', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);
      mockStripeCreate();

      const idempotencyKey = 'idem-key-replay-004';

      const first = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      // Replay same request
      const second = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', idempotencyKey)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      expect(second.body.paymentId).toBe(first.body.paymentId);
      expect(second.body.clientSecret).toBe(first.body.clientSecret);

      // Only one payment should exist
      const payments = await prisma.payment.findMany({
        where: { bookingIntentId: intent.id },
      });
      expect(payments.length).toBe(1);
    });

    it('reuses existing Stripe customer when user already has stripeCustomerId', async () => {
      // Pre-set stripeCustomerId on user
      await prisma.user.update({
        where: { id: userA.id },
        data: { stripeCustomerId: 'cus_existing_789' },
      });

      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);

      // Mock createCustomer — if the service incorrectly calls it, we'll see it
      const createCustomerSpy = jest.spyOn(stripeService, 'createCustomer').mockResolvedValue({
        id: 'cus_should_not_be_called',
        email: 'usera@example.com',
      } as any);

      const createPaymentIntentSpy = jest
        .spyOn(stripeService, 'createPaymentIntent')
        .mockResolvedValue({
          id: 'pi_existing_cust',
          client_secret: 'pi_existing_cust_secret',
          status: 'requires_payment_method',
        } as any);

      await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idem-key-existing-cust-005')
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      // Should NOT have called createCustomer
      expect(createCustomerSpy).not.toHaveBeenCalled();

      // Should have used existing customer ID
      expect(createPaymentIntentSpy).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(String),
        'cus_existing_789',
        expect.any(Object),
        expect.any(String),
        undefined,
        undefined,
      );
    });
  });

  describe('GET /api/bookings/payment/:paymentId/status', () => {
    it('returns payment status for own payment (200)', async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);
      mockStripeCreate();

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idem-key-status-006')
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/bookings/payment/${createRes.body.paymentId}/status`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.paymentId).toBe(createRes.body.paymentId);
      expect(res.body.status).toBe('CREATED');
      expect(res.body.amount).toBe(12550);
      expect(res.body.currency).toBe('usd');
      expect(res.body.bookingIntentStatus).toBe('AWAITING_PAYMENT');
      expect(res.body.attemptNumber).toBe(1);
    });

    it('returns 404 when payment does not exist', async () => {
      await request(app.getHttpServer())
        .get('/api/bookings/payment/nonexistent-id/status')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it("returns 403 when querying another user's payment", async () => {
      const offer = await createMockFlightOffer();
      const intent = await createBookingIntent(userA.id, offer.id);
      mockStripeCreate();

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('Idempotency-Key', 'idem-key-status-forbidden-007')
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/bookings/payment/${createRes.body.paymentId}/status`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(403);
    });
  });

  describe('GET /api/bookings/payment/methods', () => {
    it('returns empty list when user has no saved methods (200)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bookings/payment/methods')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.methods).toEqual([]);
      expect(res.body.hasStripeCustomer).toBe(false);
    });

    it('returns hasStripeCustomer: true when user has a Stripe customer ID', async () => {
      await prisma.user.update({
        where: { id: userA.id },
        data: { stripeCustomerId: 'cus_has_stripe' },
      });

      const res = await request(app.getHttpServer())
        .get('/api/bookings/payment/methods')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.methods).toEqual([]);
      expect(res.body.hasStripeCustomer).toBe(true);
    });
  });

  describe('DELETE /api/bookings/payment/methods/:methodId', () => {
    it('returns 404 when payment method does not exist', async () => {
      await request(app.getHttpServer())
        .delete('/api/bookings/payment/methods/nonexistent-method-id')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(404);
    });

    it("returns 403 when trying to delete another user's payment method", async () => {
      // Create a payment method for userB
      const method = await prisma.paymentMethod.create({
        data: {
          userId: userB.id,
          stripeCustomerId: 'cus_userb',
          stripePaymentMethodId: 'pm_userb_card',
          cardBrand: 'visa',
          cardLast4: '4242',
          savedWithConsent: true,
        },
      });

      // Try to delete with userA's token
      await request(app.getHttpServer())
        .delete(`/api/bookings/payment/methods/${method.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(403);
    });

    it('deletes own payment method (204)', async () => {
      const method = await prisma.paymentMethod.create({
        data: {
          userId: userA.id,
          stripeCustomerId: 'cus_usera',
          stripePaymentMethodId: 'pm_usera_card',
          cardBrand: 'mastercard',
          cardLast4: '1234',
          savedWithConsent: true,
        },
      });

      const detachSpy = jest
        .spyOn(stripeService, 'detachPaymentMethod')
        .mockResolvedValue({} as any);

      await request(app.getHttpServer())
        .delete(`/api/bookings/payment/methods/${method.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // Verify method is deleted from DB
      const deleted = await prisma.paymentMethod.findUnique({
        where: { id: method.id },
      });
      expect(deleted).toBeNull();

      expect(detachSpy).toHaveBeenCalledWith('pm_usera_card');
    });

    it('still deletes locally even if Stripe detach fails', async () => {
      const method = await prisma.paymentMethod.create({
        data: {
          userId: userA.id,
          stripeCustomerId: 'cus_usera',
          stripePaymentMethodId: 'pm_detach_fail',
          cardBrand: 'visa',
          cardLast4: '9999',
          savedWithConsent: true,
        },
      });

      jest
        .spyOn(stripeService, 'detachPaymentMethod')
        .mockRejectedValue(new Error('Stripe API error'));

      await request(app.getHttpServer())
        .delete(`/api/bookings/payment/methods/${method.id}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(204);

      // Verify method is still deleted from DB
      const deleted = await prisma.paymentMethod.findUnique({
        where: { id: method.id },
      });
      expect(deleted).toBeNull();
    });
  });
});
