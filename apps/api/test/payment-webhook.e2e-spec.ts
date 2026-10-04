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
import { PaymentWebhookService } from '@/payment/payment-webhook.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { PaymentStatus, Prisma } from '@prisma/client';

describe('Payment Webhook (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
  });

  async function createTestUser(overrides: { role?: string; status?: string } = {}) {
    const unique = Date.now() + Math.random();
    return prisma.user.create({
      data: {
        email: `webhook-test-${unique}@example.com`,
        password: 'Password123!',
        status: (overrides.status as any) || 'ACTIVE',
        role: (overrides.role as any) || 'USER',
      },
    });
  }

  async function createFlightOffer() {
    return prisma.flightOffer.create({
      data: {
        searchHash: 'test-search-hash',
        supplierOfferId: `off_${Date.now()}`,
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
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId,
        supplierOfferId: `off_${Date.now()}`,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal(100.0),
        confirmedPrice: new Prisma.Decimal(100.0),
        currency: 'USD',
        priceChanged: false,
        pricedAt: new Date(),
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
        paymentAttemptCount: 0,
      },
    });
  }

  async function createIdempotencyKey(userId: string) {
    return prisma.idempotencyKey.create({
      data: {
        key: `webhook-test-${Date.now()}-${Math.random()}`,
        requestHash: 'test-hash',
        customerId: userId,
        requestPath: '/api/bookings/payment/create',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  }

  async function createPayment(
    bookingIntentId: string,
    idempotencyKeyId: string,
    overrides: Partial<{
      stripePaymentIntentId: string;
      amount: number;
      currency: string;
      status: PaymentStatus;
    }> = {},
  ) {
    return prisma.payment.create({
      data: {
        bookingIntentId,
        attemptNumber: 1,
        idempotencyKeyId,
        stripePaymentIntentId: `pi_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        amount: 10000,
        currency: 'usd',
        status: PaymentStatus.CREATED,
        version: 0,
        ...overrides,
      },
    });
  }

  describe('POST /api/payments/webhook', () => {
    it('rejects webhook with invalid signature (400)', async () => {
      const spy = jest.spyOn(stripeService, 'constructWebhookEvent').mockImplementation(() => {
        throw new Error('Webhook signature verification failed');
      });

      const res = await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'invalid_sig')
        .send({ type: 'payment_intent.succeeded', data: { object: {} } })
        .expect(400);

      expect(res.body.message).toContain('signature verification failed');
      spy.mockRestore();
    });

    it('deduplicates webhook events — second delivery is silently handled', async () => {
      const user = await createTestUser();
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(user.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(user.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.AUTHORIZED,
      });

      const stripeEventId = `evt_dedup_${Date.now()}`;
      const mockEvent = {
        id: stripeEventId,
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
      };

      const spy = jest
        .spyOn(stripeService, 'constructWebhookEvent')
        .mockReturnValue(mockEvent as any);

      // First delivery
      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent)
        .expect(200);

      // Second delivery — same event ID
      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent)
        .expect(200);

      spy.mockRestore();

      // Verify only one PaymentEvent record for this stripeEventId
      const events = await prisma.paymentEvent.findMany({
        where: { stripeEventId },
      });
      expect(events).toHaveLength(1);
    });

    it('payment_intent.succeeded — transitions AUTHORIZED to SUCCEEDED', async () => {
      const user = await createTestUser();
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(user.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(user.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.AUTHORIZED,
      });

      const stripeEventId = `evt_succeeded_${Date.now()}`;
      const mockEvent = {
        id: stripeEventId,
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
      };

      const spy = jest
        .spyOn(stripeService, 'constructWebhookEvent')
        .mockReturnValue(mockEvent as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent)
        .expect(200);

      spy.mockRestore();

      // Verify Payment status updated
      const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated!.status).toBe(PaymentStatus.SUCCEEDED);

      // Verify PaymentEvent created
      const event = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'payment_intent.succeeded' },
      });
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe(PaymentStatus.AUTHORIZED);
      expect(event!.newStatus).toBe(PaymentStatus.SUCCEEDED);
      expect(event!.stripeEventId).toBe(stripeEventId);
    });

    it('payment_intent.payment_failed — transitions CREATED to FAILED', async () => {
      const user = await createTestUser();
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(user.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(user.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.CREATED,
      });

      const stripeEventId = `evt_failed_${Date.now()}`;
      const mockEvent = {
        id: stripeEventId,
        type: 'payment_intent.payment_failed',
        data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
      };

      const spy = jest
        .spyOn(stripeService, 'constructWebhookEvent')
        .mockReturnValue(mockEvent as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent)
        .expect(200);

      spy.mockRestore();

      const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated!.status).toBe(PaymentStatus.FAILED);

      const event = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'payment_intent.payment_failed' },
      });
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe(PaymentStatus.CREATED);
      expect(event!.newStatus).toBe(PaymentStatus.FAILED);
    });

    it('payment_intent.canceled — transitions AUTHORIZED to CANCELLED', async () => {
      const user = await createTestUser();
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(user.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(user.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.AUTHORIZED,
      });

      const stripeEventId = `evt_canceled_${Date.now()}`;
      const mockEvent = {
        id: stripeEventId,
        type: 'payment_intent.canceled',
        data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
      };

      const spy = jest
        .spyOn(stripeService, 'constructWebhookEvent')
        .mockReturnValue(mockEvent as any);

      await request(app.getHttpServer())
        .post('/api/payments/webhook')
        .set('stripe-signature', 'sig_valid')
        .send(mockEvent)
        .expect(200);

      spy.mockRestore();

      const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
      expect(updated!.status).toBe(PaymentStatus.CANCELLED);

      const event = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'payment_intent.canceled' },
      });
      expect(event).toBeDefined();
      expect(event!.previousStatus).toBe(PaymentStatus.AUTHORIZED);
      expect(event!.newStatus).toBe(PaymentStatus.CANCELLED);
    });
  });
});
