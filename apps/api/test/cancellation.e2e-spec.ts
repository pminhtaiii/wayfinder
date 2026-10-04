process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { StripeService } from '@/common/stripe.service';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { PaymentCronService } from '@/payment/payment-cron.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';

type TestUser = {
  id: string;
  email: string;
  token: string;
};

type CancellationBooking = {
  id: string;
  paymentId: string;
  quoteId: string;
};

describe('Cancellation and refund recovery (E2E)', () => {
  jest.setTimeout(30_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let duffelCancellationService: DuffelCancellationService;
  let duffelRecoveryService: DuffelRecoveryService;
  let stripeService: StripeService;
  let paymentCronService: PaymentCronService;
  let owner: TestUser;
  let otherUser: TestUser;

  beforeAll(async (): Promise<void> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });

    await app.init();

    // Stop all cron jobs registered with the SchedulerRegistry to avoid background scheduler races
    const schedulerRegistry = moduleFixture.get<SchedulerRegistry>(SchedulerRegistry);
    schedulerRegistry.getCronJobs().forEach((job) => job.stop());

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffelCancellationService = moduleFixture.get<DuffelCancellationService>(DuffelCancellationService);
    duffelRecoveryService = moduleFixture.get<DuffelRecoveryService>(DuffelRecoveryService);
    stripeService = moduleFixture.get<StripeService>(StripeService);
    paymentCronService = moduleFixture.get<PaymentCronService>(PaymentCronService);
  });

  afterAll(async (): Promise<void> => {
    await app.close();
  });

  beforeEach(async (): Promise<void> => {
    const suffix = crypto.randomUUID();
    owner = await createUser(`cancellation-owner-${suffix}@example.com`);
    otherUser = await createUser(`cancellation-other-${suffix}@example.com`);
  });

  afterEach(async (): Promise<void> => {
    jest.restoreAllMocks();
    const userIds = [owner.id, otherUser.id];
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

  async function createUser(email: string): Promise<TestUser> {
    const user = await prisma.user.create({
      data: { email, password: 'Password123!', status: 'ACTIVE' },
    });
    return {
      id: user.id,
      email: user.email,
      token: jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '1h' }),
    };
  }

  async function createCancellationBooking(
    userId: string,
    overrides: Partial<{
      status: BookingStatus;
      deadline: Date;
      quoteId: string;
      refundAmount: string;
    }> = {},
  ): Promise<CancellationBooking> {
    const now = new Date();
    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        // Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
        supplierOfferId: `off-${crypto.randomUUID()}`,
        status: 'CONFIRMED',
        originalPrice: new Prisma.Decimal('125.50'),
        confirmedPrice: new Prisma.Decimal('125.50'),
        currency: 'USD',
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-12-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });
    const paymentKey = await prisma.idempotencyKey.create({
      data: {
        key: `payment-${crypto.randomUUID()}`,
        requestHash: crypto.randomUUID(),
        customerId: userId,
        requestPath: '/api/bookings/payment/confirm',
        expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingIntentId: intent.id,
        attemptNumber: 1,
        idempotencyKeyId: paymentKey.id,
        stripePaymentIntentId: `pi-${crypto.randomUUID()}`,
        amount: 12_550,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
      },
    });
    const quoteId = overrides.quoteId ?? `quote-${crypto.randomUUID()}`;
    const booking = await prisma.booking.create({
      data: {
        userId,
        bookingIntentId: intent.id,
        paymentId: payment.id,
        totalAmount: new Prisma.Decimal('125.50'),
        currency: 'USD',
        status: overrides.status ?? BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
        // Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
        supplierOrderId: `ord-${crypto.randomUUID()}`,
        supplierCancellationQuoteId: quoteId,
        cancellationDeadline: overrides.deadline ?? new Date(Date.now() + 60 * 60 * 1000),
        cancellationRefundable: true,
        customerRefundAmount: new Prisma.Decimal(overrides.refundAmount ?? '100.00'),
      },
    });
    return { id: booking.id, paymentId: payment.id, quoteId };
  }

  async function createScheduledRefund(
    booking: CancellationBooking,
    keyCreatedAt: Date,
  ): Promise<string> {
    const obligation = await prisma.cancellationRefundObligation.upsert({
      where: { bookingId: booking.id },
      update: {},
      create: {
        bookingId: booking.id,
        paymentId: booking.paymentId,
        totalAmount: 10_000,
        airlineRefundAmount: 10_000,
        currency: 'USD',
      },
    });
    const refundKey = await prisma.idempotencyKey.create({
      data: {
        key: `cancellation-refund:${booking.id}`,
        requestHash: crypto.randomUUID(),
        customerId: owner.id,
        requestPath: `/api/bookings/${booking.id}/cancellation`,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    const refund = await prisma.refund.create({
      data: {
        paymentId: booking.paymentId,
        idempotencyKeyId: refundKey.id,
        cancellationRefundObligationId: obligation.id,
        amount: 10_000,
        currency: 'USD',
        triggerType: 'SYSTEM_AUTOMATED',
        status: RefundStatus.REFUND_RETRY_SCHEDULED,
        nextRetryAt: new Date(Date.now() - 1_000),
        idempotencyKeyCreatedAt: keyCreatedAt,
      },
    });
    return refund.id;
  }

  it('enforces ownership and missing-booking boundaries for quote and status reads', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation/quote`)
      .set('Authorization', `Bearer ${otherUser.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${otherUser.token}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/bookings/${crypto.randomUUID()}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(404);
  });

  it('returns a stored valid quote without calling Duffel and rejects an expired quote before supplier work', async (): Promise<void> => {
    const validBooking = await createCancellationBooking(owner.id);
    const quoteSpy = jest.spyOn(duffelCancellationService, 'createCancellationQuote');

    const quoteResponse = await request(app.getHttpServer())
      .post(`/api/bookings/${validBooking.id}/cancellation/quote`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(201);

    expect(quoteResponse.body).toMatchObject({
      bookingId: validBooking.id,
      quoteId: validBooking.quoteId,
      refundAmount: '100',
      refundable: true,
    });
    expect(quoteSpy).not.toHaveBeenCalled();

    const expiredBooking = await createCancellationBooking(owner.id, {
      deadline: new Date(Date.now() - 1_000),
    });
    const confirmSpy = jest.spyOn(duffelCancellationService, 'confirmCancellationQuote');
    await request(app.getHttpServer())
      .post(`/api/bookings/${expiredBooking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: expiredBooking.quoteId })
      .expect(400);
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('converges concurrent cancellation confirmations on one supplier cancellation and refund', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);
    const retrieveSpy = jest
      .spyOn(duffelRecoveryService, 'retrieveOrder')
      .mockResolvedValue({
        id: 'ord-id',
        order_id: 'ord-id',
        status: 'ACTIVE',
        cancelled_at: null,
        cancellation_id: null,
      });
    const confirmSpy = jest.spyOn(duffelCancellationService, 'confirmCancellationQuote').mockResolvedValue({
      id: `cancel-${crypto.randomUUID()}`,
      order_id: `order-${crypto.randomUUID()}`,
      status: 'CONFIRMED',
      refund_amount: '100.00',
      refund_currency: 'USD',
      refundable: true,
      confirmed_at: new Date().toISOString(),
    });
    const stripeSpy = jest
      .spyOn(stripeService, 'createRefund')
      .mockResolvedValue({ id: `re-${crypto.randomUUID()}` } as never);

    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/cancellation`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ quoteId: booking.quoteId }),
      request(app.getHttpServer())
        .post(`/api/bookings/${booking.id}/cancellation`)
        .set('Authorization', `Bearer ${owner.token}`)
        .send({ quoteId: booking.quoteId }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 201]);
    for (const res of responses) {
      expect([
        BookingStatus.CANCELLATION_PENDING,
        BookingStatus.CANCELLED_PENDING_REFUND,
        BookingStatus.CANCELLED_AND_REFUNDED,
      ]).toContain(res.body.bookingStatus);
      expect([
        BookingStatus.CANCELLATION_PENDING,
        BookingStatus.CANCELLED_PENDING_REFUND,
        BookingStatus.CANCELLED_AND_REFUNDED,
      ]).toContain(res.body.cancellationStatus);
      expect(['PENDING', 'SUCCEEDED']).toContain(res.body.refundStatus);
      expect(Number(res.body.refundAmount)).toBe(100);
    }
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(retrieveSpy).toHaveBeenCalledTimes(1);
    expect(stripeSpy).toHaveBeenCalledTimes(1);
    const persisted = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { cancellationRefundObligation: { include: { refunds: true } } },
    });
    expect(persisted.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
    expect(persisted.cancellationRefundObligation?.refunds[0]?.status).toBe(RefundStatus.SUCCEEDED);
  });

  it('records a zero-value cancellation obligation and one PII-safe audit without creating a provider refund', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id, { refundAmount: '0.00' });
    const supplierCancellation = {
      id: `cancel-${crypto.randomUUID()}`,
      order_id: `order-${crypto.randomUUID()}`,
      status: 'CONFIRMED' as const,
      refund_amount: '0.00',
      refund_currency: 'USD',
      refundable: false,
      confirmed_at: new Date().toISOString(),
    };
    jest.spyOn(duffelRecoveryService, 'retrieveOrder').mockResolvedValue({
      id: booking.id,
      order_id: booking.id,
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: null,
    });
    jest.spyOn(duffelCancellationService, 'confirmCancellationQuote').mockResolvedValue(supplierCancellation);
    const stripeSpy = jest.spyOn(stripeService, 'createRefund');

    const response = await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(201);

    expect(response.body).toMatchObject({
      bookingId: booking.id,
      bookingStatus: BookingStatus.CANCELLED_NO_REFUND,
      cancellationStatus: BookingStatus.CANCELLED_NO_REFUND,
      refundStatus: 'NOT_REQUIRED',
      refundAmount: '0.00',
    });
    expect(stripeSpy).not.toHaveBeenCalled();

    const obligation = await prisma.cancellationRefundObligation.findUniqueOrThrow({
      where: { bookingId: booking.id },
      include: { refunds: true },
    });
    expect(obligation).toMatchObject({
      bookingId: booking.id,
      paymentId: booking.paymentId,
      totalAmount: 0,
      airlineRefundAmount: 0,
      currency: 'USD',
    });
    expect(obligation.refunds).toHaveLength(0);

    const audits = await prisma.auditLog.findMany({
      where: {
        resourceType: 'CancellationRefundObligation',
        resourceId: obligation.id,
        action: 'cancellation_refund_obligation_upserted',
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      userId: owner.id,
      traceId: `cancellation-obligation:${booking.id}`,
      correlationId: `cancellation-obligation:${booking.id}`,
      metadata: {
        operation: 'CREATED',
        totalAmountMinorUnits: 0,
        airlineRefundAmountMinorUnits: 0,
        currency: 'USD',
      },
    });
    expect(JSON.stringify(audits[0])).not.toContain(supplierCancellation.id);
    expect(JSON.stringify(audits[0])).not.toContain(supplierCancellation.order_id);
  });

  it('uses remote supplier state during recovery instead of confirming the quote again', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);
    jest
      .spyOn(duffelRecoveryService, 'retrieveOrder')
      .mockResolvedValue({
        id: 'ord-id',
        order_id: 'ord-id',
        status: 'CANCELLED',
        cancelled_at: new Date().toISOString(),
        cancellation_id: `cancel-${crypto.randomUUID()}`,
      });
    const confirmSpy = jest.spyOn(duffelCancellationService, 'confirmCancellationQuote');
    jest
      .spyOn(stripeService, 'createRefund')
      .mockResolvedValue({ id: `re-${crypto.randomUUID()}` } as never);

    const response = await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(201);

    expect(response.body).toMatchObject({ bookingId: booking.id, refundStatus: 'SUCCEEDED' });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.CANCELLED_AND_REFUNDED,
    );
  });

  it('does not start a Stripe refund when supplier cancellation cannot be confirmed', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);
    jest
      .spyOn(duffelRecoveryService, 'retrieveOrder')
      .mockResolvedValue({
        id: 'ord-id',
        order_id: 'ord-id',
        status: 'ACTIVE',
        cancelled_at: null,
        cancellation_id: null,
      });
    jest
      .spyOn(duffelCancellationService, 'confirmCancellationQuote')
      .mockRejectedValue({ statusCode: 400, code: 'QUOTE_INVALID' });
    const stripeSpy = jest.spyOn(stripeService, 'createRefund');

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(502);

    expect(stripeSpy).not.toHaveBeenCalled();
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.CANCELLATION_PENDING,
    );
  });

  it('retries a transient Stripe failure and settles the cancellation exactly once', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);
    jest
      .spyOn(duffelRecoveryService, 'retrieveOrder')
      .mockResolvedValue({
        id: 'ord-id',
        order_id: 'ord-id',
        status: 'ACTIVE',
        cancelled_at: null,
        cancellation_id: null,
      });
    jest.spyOn(duffelCancellationService, 'confirmCancellationQuote').mockResolvedValue({
      id: `cancel-${crypto.randomUUID()}`,
      order_id: `order-${crypto.randomUUID()}`,
      status: 'CONFIRMED',
      refund_amount: '100.00',
      refund_currency: 'USD',
      refundable: true,
      confirmed_at: new Date().toISOString(),
    });
    const stripeSpy = jest
      .spyOn(stripeService, 'createRefund')
      .mockRejectedValueOnce({ statusCode: 503, code: 'UPSTREAM_UNAVAILABLE' })
      .mockResolvedValueOnce({ id: `re-${crypto.randomUUID()}` } as never);

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(201);

    expect(stripeSpy).toHaveBeenCalledTimes(2);
    const [refund, persistedBooking] = await Promise.all([
      prisma.refund.findFirstOrThrow({
        where: { cancellationRefundObligation: { bookingId: booking.id } },
      }),
      prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }),
    ]);
    expect(refund.status).toBe(RefundStatus.SUCCEEDED);
    expect(persistedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
  });

  it('CAS-claims due retries once and escalates a 22-hour-old refund without another Stripe call', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id, {
      status: BookingStatus.CANCELLED_PENDING_REFUND,
    });
    const refundId = await createScheduledRefund(
      booking,
      new Date(Date.now() - 22 * 60 * 60 * 1_000 - 1),
    );
    const stripeSpy = jest.spyOn(stripeService, 'createRefund');

    await Promise.all([
      paymentCronService.handleCancellationRefundRecovery(),
      paymentCronService.handleCancellationRefundRecovery(),
    ]);

    expect(stripeSpy).not.toHaveBeenCalled();
    const [refund, persistedBooking] = await Promise.all([
      prisma.refund.findUniqueOrThrow({ where: { id: refundId } }),
      prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }),
    ]);
    expect(refund.status).toBe(RefundStatus.REFUND_FAILED_NEEDS_ATTENTION);
    expect(refund.lastErrorCode).toBe('IDEMPOTENCY_KEY_SAFETY_WINDOW');
    expect(persistedBooking.status).toBe(BookingStatus.REFUND_FAILED_NEEDS_ATTENTION);
  });

  it('resolves disruption and writes audit log when cancellation completes successfully', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);

    // Set disruption status on the booking to verify it gets resolved
    await prisma.booking.update({
      where: { id: booking.id },
      data: { disruptionStatus: 'DETECTED' },
    });

    jest
      .spyOn(duffelRecoveryService, 'retrieveOrder')
      .mockResolvedValue({
        id: 'ord-id',
        order_id: 'ord-id',
        status: 'ACTIVE',
        cancelled_at: null,
        cancellation_id: null,
      });
    jest.spyOn(duffelCancellationService, 'confirmCancellationQuote').mockResolvedValue({
      id: `cancel-${crypto.randomUUID()}`,
      order_id: `order-${crypto.randomUUID()}`,
      status: 'CONFIRMED',
      refund_amount: '100.00',
      refund_currency: 'USD',
      refundable: true,
      confirmed_at: new Date().toISOString(),
    });
    jest
      .spyOn(stripeService, 'createRefund')
      .mockResolvedValue({ id: `re-${crypto.randomUUID()}` } as never);

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(201);

    const persisted = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(persisted.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
    expect(persisted.disruptionStatus).toBe('RESOLVED');
    expect(persisted.disruptionResolvedReason).toBe('BOOKING_CANCELLED');
    expect(persisted.disruptionResolvedByType).toBe('TRAVELLER');
    expect(persisted.disruptionResolvedById).toBe(owner.id);

    const auditEvent = await prisma.disruptionAuditEvent.findFirst({
      where: { bookingId: booking.id, action: 'BOOKING_CANCELLED' },
    });
    expect(auditEvent).toBeDefined();
    expect(auditEvent?.actorType).toBe('TRAVELLER');
    expect(auditEvent?.actorId).toBe(owner.id);
  });

  it('does not allow a post-cancellation sync to modify/create revisions or change state', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id, {
      status: BookingStatus.CANCELLED_AND_REFUNDED,
    });

    const response = await request(app.getHttpServer())
      .post(`/api/disruptions/sync/${booking.id}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(200);

    expect(response.body.status).toBe('SKIPPED_INELIGIBLE');

    const revisionsCount = await prisma.itineraryRevision.count({
      where: { bookingId: booking.id },
    });
    expect(revisionsCount).toBe(0);
  });

  it('returns 404 Not Found for legacy sibling paths', async (): Promise<void> => {
    const booking = await createCancellationBooking(owner.id);

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancellation-quote`)
      .set('Authorization', `Bearer ${owner.token}`)
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/bookings/${booking.id}/cancel`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ quoteId: booking.quoteId })
      .expect(404);
  });
});
