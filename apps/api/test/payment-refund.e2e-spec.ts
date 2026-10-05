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

describe('Payment Refund (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;

  let adminUser: { id: string; email: string };
  let adminToken: string;
  let regularUser: { id: string; email: string };
  let regularToken: string;

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

    // Create admin and regular users
    const admin = await prisma.user.create({
      data: {
        email: `admin-refund-${Date.now()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'ADMIN',
      },
    });
    adminUser = { id: admin.id, email: admin.email };
    adminToken = jwtService.sign(
      { id: admin.id, email: admin.email, role: 'ADMIN' },
      { expiresIn: '24h' },
    );

    const regular = await prisma.user.create({
      data: {
        email: `user-refund-${Date.now()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    regularUser = { id: regular.id, email: regular.email };
    regularToken = jwtService.sign(
      { id: regular.id, email: regular.email, role: 'USER' },
      { expiresIn: '24h' },
    );
  });

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
        status: 'CONFIRMED',
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
        paymentAttemptCount: 1,
      },
    });
  }

  async function createIdempotencyKey(userId: string) {
    return prisma.idempotencyKey.create({
      data: {
        key: `refund-test-${Date.now()}-${Math.random()}`,
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
        status: PaymentStatus.SUCCEEDED,
        version: 0,
        ...overrides,
      },
    });
  }

  describe('POST /api/bookings/payment/:paymentId/refund', () => {
    it('admin triggers full refund successfully (201)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(adminUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(adminUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.SUCCEEDED,
      });

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: `re_test_${Date.now()}` } as any);

      const idempotencyKeyValue = `refund-key-${Date.now()}`;

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/payment/${payment.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', idempotencyKeyValue)
        .send({ amount: 10000, reason: 'customer_request' })
        .expect(201);

      stripeRefundSpy.mockRestore();

      expect(res.body.refundId).toBeDefined();
      expect(res.body.amount).toBe(10000);
      expect(res.body.currency).toBe('usd');
      expect(res.body.status).toBe('REFUND_PENDING');

      // Verify Refund record created in DB
      const refund = await prisma.refund.findUnique({
        where: { id: res.body.refundId },
      });
      expect(refund).toBeDefined();
      expect(refund!.amount).toBe(10000);
      expect(refund!.status).toBe('REFUND_PENDING');
      expect(refund!.triggeredByUserId).toBe(adminUser.id);

      // Verify Payment status updated to REFUND_PENDING
      const updatedPayment = await prisma.payment.findUnique({
        where: { id: payment.id },
      });
      expect(updatedPayment!.status).toBe(PaymentStatus.REFUND_PENDING);

      // Verify PaymentEvent created
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'refund_initiated' },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.previousStatus).toBe(PaymentStatus.SUCCEEDED);
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUND_PENDING);
    });

    it('non-admin user is blocked from refunding (403)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(adminUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(adminUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.SUCCEEDED,
      });

      await request(app.getHttpServer())
        .post(`/api/bookings/payment/${payment.id}/refund`)
        .set('Authorization', `Bearer ${regularToken}`)
        .set('Idempotency-Key', `refund-key-${Date.now()}`)
        .send({ amount: 10000, reason: 'customer_request' })
        .expect(403);
    });

    it('rejects refund on non-refundable payment status (400)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(adminUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(adminUser.id);
      // CREATED status cannot transition to REFUND_PENDING (only SUCCEEDED can)
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.CREATED,
      });

      const res = await request(app.getHttpServer())
        .post(`/api/bookings/payment/${payment.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', `refund-key-${Date.now()}`)
        .send({ amount: 10000, reason: 'customer_request' })
        .expect(400);

      expect(res.body.message).toContain('Invalid payment status transition');
    });

    it('rejects refund amount exceeding remaining refundable amount (400)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(adminUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(adminUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.SUCCEEDED,
        amount: 10000,
      });

      // Create a prior succeeded refund for 8000 cents
      const refundIdempotencyKey = await prisma.idempotencyKey.create({
        data: {
          key: `prior-refund-${Date.now()}`,
          requestHash: 'hash',
          customerId: adminUser.id,
          requestPath: '/api/bookings/payment/refund',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: refundIdempotencyKey.id,
          stripeRefundId: `re_prior_${Date.now()}`,
          amount: 8000,
          currency: 'usd',
          reason: 'partial_refund',
          triggerType: 'ADMIN',
          triggeredByUserId: adminUser.id,
          status: 'SUCCEEDED',
        },
      });

      // Try to refund 5000 — only 2000 remaining (10000 - 8000)
      const res = await request(app.getHttpServer())
        .post(`/api/bookings/payment/${payment.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .set('Idempotency-Key', `refund-key-${Date.now()}`)
        .send({ amount: 5000, reason: 'exceeding_refund' })
        .expect(400);

      expect(res.body.message).toContain('exceeds remaining');
    });

    it('rejects refund when Idempotency-Key header is missing (400)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(adminUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(adminUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        status: PaymentStatus.SUCCEEDED,
      });

      await request(app.getHttpServer())
        .post(`/api/bookings/payment/${payment.id}/refund`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ amount: 10000, reason: 'customer_request' })
        .expect(400);
    });
  });
});
