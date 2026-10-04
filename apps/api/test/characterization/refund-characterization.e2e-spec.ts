process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';
import { PaymentWebhookService } from '@/payment/payment-webhook.service';
import { PaymentCronService } from '@/payment/payment-cron.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  BookingStatus,
  PaymentStatus,
  RefundStatus,
  RefundTriggerType,
  Prisma,
} from '@prisma/client';
import * as crypto from 'crypto';

describe('Refund Characterization (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let paymentRefundService: PaymentRefundService;
  let paymentWebhookService: PaymentWebhookService;
  let paymentCronService: PaymentCronService;

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
    paymentRefundService = moduleFixture.get<PaymentRefundService>(PaymentRefundService);
    paymentWebhookService = moduleFixture.get<PaymentWebhookService>(PaymentWebhookService);
    paymentCronService = moduleFixture.get<PaymentCronService>(PaymentCronService);
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

    const admin = await prisma.user.create({
      data: {
        email: `admin-refund-char-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
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
        email: `user-refund-char-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
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
        searchHash: `search-${crypto.randomUUID()}`,
        supplierOfferId: `off_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-08-01'),
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
        supplierOfferId: `off_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        status: 'CONFIRMED',
        originalPrice: new Prisma.Decimal(100.0),
        confirmedPrice: new Prisma.Decimal(100.0),
        currency: 'USD',
        priceChanged: false,
        pricedAt: new Date(),
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-08-01'),
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

  async function createIdempotencyKey(userId: string, keyPrefix = 'char-refund') {
    return prisma.idempotencyKey.create({
      data: {
        key: `${keyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        requestHash: crypto.randomBytes(16).toString('hex'),
        customerId: userId,
        requestPath: '/api/bookings/payment/refund',
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
        stripePaymentIntentId: `pi_char_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        amount: 10000,
        currency: 'usd',
        status: PaymentStatus.SUCCEEDED,
        version: 0,
        ...overrides,
      },
    });
  }

  async function createBooking(
    userId: string,
    bookingIntentId: string,
    paymentId: string,
    overrides: Partial<{
      status: BookingStatus;
      totalAmount: string;
      currency: string;
    }> = {},
  ) {
    return prisma.booking.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        bookingIntentId,
        paymentId,
        totalAmount: new Prisma.Decimal(100.0),
        currency: 'USD',
        status: BookingStatus.PROCESSING,
        ...overrides,
      },
    });
  }

  async function createCancellationRefundObligation(bookingId: string, paymentId: string) {
    return prisma.cancellationRefundObligation.create({
      data: {
        bookingId,
        paymentId,
        totalAmount: 10000,
        airlineRefundAmount: 10000,
        currency: 'USD',
      },
    });
  }

  describe('Trigger 1: Inline Cancellation Refund (processCancellationRefund)', () => {
    it('executes full cancellation refund, creating balanced ledger entries and terminal transitions', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_inline_char_1' } as any);

      const result = await paymentRefundService.processCancellationRefund({
        bookingId: booking.id,
        paymentId: payment.id,
        amount: 10000,
        currency: 'usd',
      });

      stripeRefundSpy.mockRestore();

      expect(result.refundStatus).toBe('SUCCEEDED');
      expect(result.refundAmount).toBe('100.00');

      // Verify Payment terminal status
      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);

      // Verify Booking terminal status
      const updatedBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(updatedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // Verify Refund record
      const refund = await prisma.refund.findFirst({
        where: {
          cancellationRefundObligation: {
            bookingId: booking.id,
          },
        },
      });
      expect(refund).toBeDefined();
      expect(refund!.status).toBe(RefundStatus.SUCCEEDED);
      expect(refund!.stripeRefundId).toBe('re_inline_char_1');
      expect(refund!.amount).toBe(10000);
      expect(refund!.triggerType).toBe(RefundTriggerType.SYSTEM_AUTOMATED);

      // Verify Balanced Double-Entry Ledger
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries).toHaveLength(2);

      const debitEntry = ledgerEntries.find((l) => l.entryType === 'DEBIT');
      const creditEntry = ledgerEntries.find((l) => l.entryType === 'CREDIT');

      expect(debitEntry).toBeDefined();
      expect(debitEntry!.accountId).toBe('PLATFORM_REVENUE');
      expect(debitEntry!.amount).toBe(10000);

      expect(creditEntry).toBeDefined();
      expect(creditEntry!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(creditEntry!.amount).toBe(10000);

      expect(debitEntry!.transactionId).toBe(creditEntry!.transactionId);

      // Verify PaymentEvent
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_succeeded' },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUNDED);
    });

    it('duplicate replay of inline refund produces zero duplicate ledger records (idempotency)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      await createCancellationRefundObligation(booking.id, payment.id);

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_inline_replay_1' } as any);

      // First execution
      await paymentRefundService.processCancellationRefund({
        bookingId: booking.id,
        paymentId: payment.id,
        amount: 10000,
        currency: 'usd',
      });

      const initialLedgerCount = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(initialLedgerCount).toBe(2);

      // Duplicate replay
      const replayResult = await paymentRefundService.processCancellationRefund({
        bookingId: booking.id,
        paymentId: payment.id,
        amount: 10000,
        currency: 'usd',
      });

      stripeRefundSpy.mockRestore();

      expect(replayResult.refundStatus).toBe('SUCCEEDED');
      expect(replayResult.refundAmount).toBe('100.00');

      const postReplayLedgerCount = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(postReplayLedgerCount).toBe(2); // No new ledger records
    });
  });

  describe('Trigger 2: Stripe Webhook (handleWebhookEvent charge.refunded)', () => {
    it('processes charge.refunded webhook, transitioning Payment to REFUNDED with balanced ledger entries', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      // Initiate refund putting Payment into REFUND_PENDING and creating Refund record
      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_wh_char_1' } as any);

      const refundResponse = await paymentRefundService.initiateRefund(
        payment.id,
        { amount: 10000, reason: 'customer_request' },
        `wh-key-${Date.now()}`,
        regularUser.id,
        'USER',
      );
      stripeRefundSpy.mockRestore();

      expect(refundResponse.status).toBe('REFUND_PENDING');

      // Bind the Stripe identity and cancellation obligation to simulate Stripe's immediate return.
      await prisma.refund.update({
        where: { id: refundResponse.refundId },
        data: {
          stripeRefundId: 're_wh_char_1',
          cancellationRefundObligationId: obligation.id,
        },
      });

      // Deliver charge.refunded webhook event
      const stripeEventId = `evt_char_${Date.now()}`;
      const webhookEvent = {
        id: stripeEventId,
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: payment.stripePaymentIntentId,
            amount_refunded: 10000,
            refunds: {
              data: [{ id: 're_wh_char_1', amount: 10000 }],
            },
          },
        },
      };

      const processed = await paymentWebhookService.handleWebhookEvent(webhookEvent);
      expect(processed).toBe(true);

      // Verify Payment terminal status
      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);

      // Verify Booking terminal status
      const updatedBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(updatedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // Verify Refund record status
      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refundResponse.refundId },
      });
      expect(updatedRefund.status).toBe(RefundStatus.SUCCEEDED);

      // Verify Balanced Ledger Entries
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries).toHaveLength(2);

      const debit = ledgerEntries.find((l) => l.entryType === 'DEBIT');
      const credit = ledgerEntries.find((l) => l.entryType === 'CREDIT');

      expect(debit).toBeDefined();
      expect(debit!.accountId).toBe('PLATFORM_REVENUE');
      expect(debit!.amount).toBe(10000);

      expect(credit).toBeDefined();
      expect(credit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(credit!.amount).toBe(10000);

      expect(debit!.transactionId).toBe(credit!.transactionId);

      // Verify PaymentEvent recorded
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { stripeEventId },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.eventType).toBe('charge.refunded');
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUNDED);
    });

    it('partial refund webhook transitions Payment to PARTIALLY_REFUNDED with matched ledger amount', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_wh_partial_1' } as any);

      const refundResponse = await paymentRefundService.initiateRefund(
        payment.id,
        { amount: 4000, reason: 'partial_service_issue' },
        `partial-key-${Date.now()}`,
        regularUser.id,
        'USER',
      );
      stripeRefundSpy.mockRestore();

      await prisma.refund.update({
        where: { id: refundResponse.refundId },
        data: { stripeRefundId: 're_wh_partial_1' },
      });

      const webhookEvent = {
        id: `evt_partial_${Date.now()}`,
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: payment.stripePaymentIntentId,
            amount_refunded: 4000,
            refunds: {
              data: [{ id: 're_wh_partial_1', amount: 4000 }],
            },
          },
        },
      };

      await paymentWebhookService.handleWebhookEvent(webhookEvent);

      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);

      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries).toHaveLength(2);
      expect(ledgerEntries[0].amount).toBe(4000);
      expect(ledgerEntries[1].amount).toBe(4000);
    });

    it('duplicate webhook delivery drops event and creates zero duplicate ledger records', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_wh_dedup_1' } as any);

      const refundResponse = await paymentRefundService.initiateRefund(
        payment.id,
        { amount: 10000, reason: 'customer_request' },
        `dedup-key-${Date.now()}`,
        regularUser.id,
        'USER',
      );
      stripeRefundSpy.mockRestore();

      await prisma.refund.update({
        where: { id: refundResponse.refundId },
        data: { stripeRefundId: 're_wh_dedup_1' },
      });

      const stripeEventId = `evt_dedup_${Date.now()}`;
      const webhookEvent = {
        id: stripeEventId,
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: payment.stripePaymentIntentId,
            amount_refunded: 10000,
            refunds: {
              data: [{ id: 're_wh_dedup_1', amount: 10000 }],
            },
          },
        },
      };

      // First webhook delivery
      await paymentWebhookService.handleWebhookEvent(webhookEvent);
      const initialLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(initialLedgers).toBe(2);

      // Duplicate webhook delivery with same stripeEventId
      const replayProcessed = await paymentWebhookService.handleWebhookEvent(webhookEvent);
      expect(replayProcessed).toBe(true);

      const postReplayLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(postReplayLedgers).toBe(2);
    });
  });

  describe('Trigger 3: Background Sweeper (PaymentCronService.handleCancellationRefundRecovery)', () => {
    it('recovers scheduled cancellation refund, transitioning Payment to REFUNDED and Booking to CANCELLED_AND_REFUNDED', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      // Create Refund in REFUND_RETRY_SCHEDULED with past nextRetryAt
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: idempotencyKey.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_RETRY_SCHEDULED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation.id,
          retryCount: 1,
          nextRetryAt: new Date(Date.now() - 60000), // 1 minute in past
          idempotencyKeyCreatedAt: new Date(),
        },
      });

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_cron_char_1' } as any);

      // Trigger background recovery sweep
      await paymentCronService.handleCancellationRefundRecovery();

      stripeRefundSpy.mockRestore();

      // Verify Refund record
      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(updatedRefund.status).toBe(RefundStatus.SUCCEEDED);
      expect(updatedRefund.stripeRefundId).toBe('re_cron_char_1');
      expect(updatedRefund.nextRetryAt).toBeNull();

      // Verify Payment status
      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);

      // Verify Booking status
      const updatedBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(updatedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // Verify Balanced Ledger Entries
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries).toHaveLength(2);

      const debit = ledgerEntries.find((l) => l.entryType === 'DEBIT');
      const credit = ledgerEntries.find((l) => l.entryType === 'CREDIT');

      expect(debit).toBeDefined();
      expect(debit!.accountId).toBe('PLATFORM_REVENUE');
      expect(debit!.amount).toBe(10000);

      expect(credit).toBeDefined();
      expect(credit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(credit!.amount).toBe(10000);

      expect(debit!.transactionId).toBe(credit!.transactionId);

      // Verify PaymentEvent
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_recovered' },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUNDED);
    });

    it('subsequent sweeper run produces zero duplicate ledger records', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: idempotencyKey.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_RETRY_SCHEDULED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation.id,
          retryCount: 1,
          nextRetryAt: new Date(Date.now() - 60000),
          idempotencyKeyCreatedAt: new Date(),
        },
      });

      const stripeRefundSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_cron_run2_1' } as any);

      // First run
      await paymentCronService.handleCancellationRefundRecovery();
      const initialLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(initialLedgers).toBe(2);

      // Second run
      await paymentCronService.handleCancellationRefundRecovery();
      stripeRefundSpy.mockRestore();

      const postSecondRunLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(postSecondRunLedgers).toBe(2);
    });
  });

  describe('Trigger 4: Admin Manual Resolution (AdminRefundController.resolveRefund)', () => {
    it('admin resolves escalated refund with MARK_RESOLVED_MANUALLY, transitioning terminal states with balanced ledger entries', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      // Create Refund in REFUND_FAILED_NEEDS_ATTENTION
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: idempotencyKey.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation.id,
          retryCount: 3,
          lastErrorCode: 'card_declined',
          lastErrorAt: new Date(),
        },
      });

      const res = await request(app.getHttpServer())
        .post(`/api/admin/refunds/${refund.id}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'MARK_RESOLVED_MANUALLY' })
        .expect(201);

      expect(res.body.refundId).toBe(refund.id);
      expect(res.body.refundStatus).toBe(RefundStatus.SUCCEEDED);
      expect(res.body.bookingStatus).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // Verify DB terminal states
      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(updatedRefund.status).toBe(RefundStatus.SUCCEEDED);

      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);

      const updatedBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(updatedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // Verify Balanced Ledger Entries
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries).toHaveLength(2);

      const debit = ledgerEntries.find((l) => l.entryType === 'DEBIT');
      const credit = ledgerEntries.find((l) => l.entryType === 'CREDIT');

      expect(debit).toBeDefined();
      expect(debit!.accountId).toBe('PLATFORM_REVENUE');
      expect(debit!.amount).toBe(10000);

      expect(credit).toBeDefined();
      expect(credit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(credit!.amount).toBe(10000);

      expect(debit!.transactionId).toBe(credit!.transactionId);

      // Verify PaymentEvent
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_manually_resolved' },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUNDED);
    });

    it('rejects replay on already-resolved refund (409 Conflict) and produces zero duplicate ledger records', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: idempotencyKey.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation.id,
          retryCount: 3,
        },
      });

      // First resolution
      await request(app.getHttpServer())
        .post(`/api/admin/refunds/${refund.id}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'MARK_RESOLVED_MANUALLY' })
        .expect(201);

      const initialLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(initialLedgers).toBe(2);

      // Second resolution attempt -> 409 Conflict
      await request(app.getHttpServer())
        .post(`/api/admin/refunds/${refund.id}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'MARK_RESOLVED_MANUALLY' })
        .expect(409);

      const postReplayLedgers = await prisma.ledgerEntry.count({
        where: { paymentId: payment.id },
      });
      expect(postReplayLedgers).toBe(2);
    });

    it('blocks non-admin user from manual refund resolution (403 Forbidden)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(regularUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(regularUser.id);
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking = await createBooking(regularUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation = await createCancellationRefundObligation(booking.id, payment.id);

      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: idempotencyKey.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation.id,
          retryCount: 3,
        },
      });

      await request(app.getHttpServer())
        .post(`/api/admin/refunds/${refund.id}/resolve`)
        .set('Authorization', `Bearer ${regularToken}`)
        .send({ action: 'MARK_RESOLVED_MANUALLY' })
        .expect(403);
    });
  });

  describe('Invariant Verification Across All 4 Triggers', () => {
    it('guarantees balanced ledger invariant: sum(DEBIT) === sum(CREDIT) and exact terminal state consistency', async () => {
      // Create 4 distinct scenarios, each using one of the triggers
      // Trigger 1 (Inline)
      const offer1 = await createFlightOffer();
      const intent1 = await createBookingIntent(regularUser.id, offer1.id);
      const key1 = await createIdempotencyKey(regularUser.id, 'inv1');
      const payment1 = await createPayment(intent1.id, key1.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });
      const booking1 = await createBooking(regularUser.id, intent1.id, payment1.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      await createCancellationRefundObligation(booking1.id, payment1.id);

      const stripeSpy = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_inv_1' } as any);
      await paymentRefundService.processCancellationRefund({
        bookingId: booking1.id,
        paymentId: payment1.id,
        amount: 10000,
        currency: 'usd',
      });
      stripeSpy.mockRestore();

      // Trigger 2 (Webhook)
      const offer2 = await createFlightOffer();
      const intent2 = await createBookingIntent(regularUser.id, offer2.id);
      const key2 = await createIdempotencyKey(regularUser.id, 'inv2');
      const payment2 = await createPayment(intent2.id, key2.id, {
        amount: 10000,
        status: PaymentStatus.SUCCEEDED,
      });
      const booking2 = await createBooking(regularUser.id, intent2.id, payment2.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation2 = await createCancellationRefundObligation(booking2.id, payment2.id);
      const stripeSpy2 = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_inv_2' } as any);
      const ref2 = await paymentRefundService.initiateRefund(
        payment2.id,
        { amount: 10000, reason: 'customer_request' },
        `inv-wh-${Date.now()}`,
        regularUser.id,
        'USER',
      );
      stripeSpy2.mockRestore();
      await prisma.refund.update({
        where: { id: ref2.refundId },
        data: {
          stripeRefundId: 're_inv_2',
          cancellationRefundObligationId: obligation2.id,
        },
      });
      await paymentWebhookService.handleWebhookEvent({
        id: `evt_inv_2_${Date.now()}`,
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: payment2.stripePaymentIntentId,
            amount_refunded: 10000,
            refunds: { data: [{ id: 're_inv_2', amount: 10000 }] },
          },
        },
      });

      // Trigger 3 (Sweeper)
      const offer3 = await createFlightOffer();
      const intent3 = await createBookingIntent(regularUser.id, offer3.id);
      const key3 = await createIdempotencyKey(regularUser.id, 'inv3');
      const payment3 = await createPayment(intent3.id, key3.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking3 = await createBooking(regularUser.id, intent3.id, payment3.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation3 = await createCancellationRefundObligation(booking3.id, payment3.id);
      await prisma.refund.create({
        data: {
          paymentId: payment3.id,
          idempotencyKeyId: key3.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_RETRY_SCHEDULED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation3.id,
          retryCount: 1,
          nextRetryAt: new Date(Date.now() - 60000),
          idempotencyKeyCreatedAt: new Date(),
        },
      });
      const stripeSpy3 = jest
        .spyOn(stripeService, 'createRefund')
        .mockResolvedValue({ id: 're_inv_3' } as any);
      await paymentCronService.handleCancellationRefundRecovery();
      stripeSpy3.mockRestore();

      // Trigger 4 (Admin)
      const offer4 = await createFlightOffer();
      const intent4 = await createBookingIntent(regularUser.id, offer4.id);
      const key4 = await createIdempotencyKey(regularUser.id, 'inv4');
      const payment4 = await createPayment(intent4.id, key4.id, {
        amount: 10000,
        status: PaymentStatus.REFUND_PENDING,
      });
      const booking4 = await createBooking(regularUser.id, intent4.id, payment4.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
      });
      const obligation4 = await createCancellationRefundObligation(booking4.id, payment4.id);
      const refund4 = await prisma.refund.create({
        data: {
          paymentId: payment4.id,
          idempotencyKeyId: key4.id,
          amount: 10000,
          currency: 'usd',
          status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          cancellationRefundObligationId: obligation4.id,
          retryCount: 3,
        },
      });
      await request(app.getHttpServer())
        .post(`/api/admin/refunds/${refund4.id}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ action: 'MARK_RESOLVED_MANUALLY' })
        .expect(201);

      // Verify all 4 payments are REFUNDED
      const allPayments = await prisma.payment.findMany({
        where: { id: { in: [payment1.id, payment2.id, payment3.id, payment4.id] } },
      });
      for (const p of allPayments) {
        expect(p.status).toBe(PaymentStatus.REFUNDED);
      }

      // Verify all 4 bookings are CANCELLED_AND_REFUNDED
      const allBookings = await prisma.booking.findMany({
        where: { id: { in: [booking1.id, booking2.id, booking3.id, booking4.id] } },
      });
      expect(allBookings).toHaveLength(4);
      for (const b of allBookings) {
        expect(b.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
      }

      // Verify all ledger entries across all 4 payments are perfectly balanced
      const allLedgers = await prisma.ledgerEntry.findMany({
        where: { paymentId: { in: [payment1.id, payment2.id, payment3.id, payment4.id] } },
      });
      expect(allLedgers).toHaveLength(8); // 2 per trigger

      const totalDebit = allLedgers
        .filter((l) => l.entryType === 'DEBIT')
        .reduce((sum, l) => sum + l.amount, 0);
      const totalCredit = allLedgers
        .filter((l) => l.entryType === 'CREDIT')
        .reduce((sum, l) => sum + l.amount, 0);

      expect(totalDebit).toBe(40000);
      expect(totalCredit).toBe(40000);
      expect(totalDebit).toBe(totalCredit);
    });
  });
});
