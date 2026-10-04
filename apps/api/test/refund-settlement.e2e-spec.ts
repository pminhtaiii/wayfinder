process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, BadRequestException } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { RefundTransactionService } from '@/refund/refund-transaction.service';
import { RefundSettlementService } from '@/refund-settlement/refund-settlement.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  BookingStatus,
  LedgerEntryType,
  PaymentStatus,
  RefundStatus,
  RefundTriggerType,
  Prisma,
} from '@prisma/client';
import * as crypto from 'crypto';

describe('Refund Settlement & Transaction Lifecycle (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let refundTransactionService: RefundTransactionService;
  let refundSettlementService: RefundSettlementService;

  let testUser: { id: string; email: string };

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
    refundTransactionService =
      moduleFixture.get<RefundTransactionService>(RefundTransactionService);
    refundSettlementService = moduleFixture.get<RefundSettlementService>(RefundSettlementService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.seatSelection.deleteMany({});
    await prisma.baggageSelectionSegment.deleteMany({});
    await prisma.baggageSelection.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.ancillarySelection.deleteMany({});
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
        email: `user-settlement-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    testUser = { id: user.id, email: user.email };
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

  async function createIdempotencyKey(userId: string, keyPrefix = 'settlement-e2e') {
    return prisma.idempotencyKey.create({
      data: {
        key: `${keyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        requestHash: crypto.randomBytes(16).toString('hex'),
        customerId: userId,
        requestPath: '/api/refund/reserve',
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
      preDisputeStatus: PaymentStatus | null;
    }> = {},
  ) {
    return prisma.payment.create({
      data: {
        bookingIntentId,
        attemptNumber: 1,
        idempotencyKeyId,
        stripePaymentIntentId: `pi_settle_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        amount: 10000,
        currency: 'USD',
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
      totalAmount: Prisma.Decimal;
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
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        ...overrides,
      },
    });
  }

  async function createObligation(
    bookingId: string,
    paymentId: string,
    overrides: Partial<{
      totalAmount: number;
      airlineRefundAmount: number;
      currency: string;
    }> = {},
  ) {
    return prisma.cancellationRefundObligation.create({
      data: {
        bookingId,
        paymentId,
        totalAmount: 10000,
        airlineRefundAmount: 10000,
        currency: 'USD',
        ...overrides,
      },
    });
  }

  describe('Requirement 1a: Single Full Refund E2E', () => {
    it('reserves refund and settles verified SUCCEEDED outcome, producing balanced ledger entries, terminal states, and audit trail', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'single-full-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        totalAmount: new Prisma.Decimal(100.0),
      });
      const obligation = await createObligation(booking.id, payment.id, {
        totalAmount: 10000,
        airlineRefundAmount: 10000,
        currency: 'USD',
      });

      // 1. Reserve refund transaction
      const refund = await refundTransactionService.reserveTransaction({
        kind: 'CANCELLATION',
        paymentId: payment.id,
        cancellationRefundObligationId: obligation.id,
        cancellationBookingId: booking.id,
        amount: 10000,
        currency: 'USD',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `single-full-ref-${crypto.randomUUID()}`,
      });

      expect(refund).toBeDefined();
      expect(refund.status).toBe(RefundStatus.REFUND_PENDING);
      expect(refund.amount).toBe(10000);
      expect(refund.currency).toBe('USD');
      expect(refund.paymentId).toBe(payment.id);
      expect(refund.cancellationRefundObligationId).toBe(obligation.id);

      // 2. Settle verified outcome (SUCCEEDED)
      const settlementResult = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_stripe_full_123',
          occurredAt: new Date().toISOString(),
        },
        provenance: {
          source: 'INLINE',
          actorId: testUser.id,
          metadata: { note: 'full cancellation settlement' },
        },
      });

      expect(settlementResult).toEqual({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      // 3. Verify DB state
      // Refund
      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(updatedRefund.status).toBe(RefundStatus.SUCCEEDED);
      expect(updatedRefund.stripeRefundId).toBe('re_stripe_full_123');

      // LedgerEntry: exactly 2 balanced rows linked to refundTransactionId
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: refund.id },
      });
      expect(ledgerEntries).toHaveLength(2);

      const debit = ledgerEntries.find((l) => l.entryType === LedgerEntryType.DEBIT);
      const credit = ledgerEntries.find((l) => l.entryType === LedgerEntryType.CREDIT);

      expect(debit).toBeDefined();
      expect(debit!.accountId).toBe('PLATFORM_REVENUE');
      expect(debit!.amount).toBe(10000);
      expect(debit!.currency).toBe('USD');
      expect(debit!.paymentId).toBe(payment.id);

      expect(credit).toBeDefined();
      expect(credit!.accountId).toBe('CUSTOMER_RECEIVABLE');
      expect(credit!.amount).toBe(10000);
      expect(credit!.currency).toBe('USD');
      expect(credit!.paymentId).toBe(payment.id);

      expect(debit!.transactionId).toBe(credit!.transactionId);

      // Payment terminal state
      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.REFUNDED);

      // Booking terminal state
      const updatedBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
      });
      expect(updatedBooking.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      // PaymentEvent
      const paymentEvent = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_succeeded' },
      });
      expect(paymentEvent).toBeDefined();
      expect(paymentEvent!.newStatus).toBe(PaymentStatus.REFUNDED);
      expect(paymentEvent!.amount).toBe(10000);

      // AuditLog
      const auditLog = await prisma.auditLog.findFirst({
        where: { resourceType: 'Refund', resourceId: refund.id, action: 'refund_settled' },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.userId).toBe(testUser.id);
    });
  });

  describe('Requirement 1b: Multi-Transaction Partial Refund E2E', () => {
    it('handles multi-transaction partial refunds ($500 payment, $300 obligation with 3x $100 refunds, capacity enforcement on 4th and 5th transactions)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'multi-partial-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 50000, // $500
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        totalAmount: new Prisma.Decimal(500.0),
      });
      const obligation = await createObligation(booking.id, payment.id, {
        totalAmount: 30000, // $300
        airlineRefundAmount: 30000,
        currency: 'USD',
      });

      // Tx 1: Reserve $100 -> Settle SUCCEEDED -> Payment PARTIALLY_REFUNDED, Booking CANCELLED_PENDING_REFUND
      const refund1 = await refundTransactionService.reserveTransaction({
        kind: 'CANCELLATION',
        paymentId: payment.id,
        cancellationRefundObligationId: obligation.id,
        cancellationBookingId: booking.id,
        amount: 10000,
        currency: 'USD',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `multi-ref-1-${crypto.randomUUID()}`,
      });

      const res1 = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund1.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_partial_1',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'INLINE', actorId: testUser.id },
      });

      expect(res1.applied).toBe(true);
      expect(res1.transactionStatus).toBe('SUCCEEDED');
      expect(res1.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(res1.bookingStatus).toBe(BookingStatus.CANCELLED_PENDING_REFUND);

      let bookingDb = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(bookingDb.status).toBe(BookingStatus.CANCELLED_PENDING_REFUND);

      // Tx 2: Reserve $100 -> Settle SUCCEEDED -> Payment PARTIALLY_REFUNDED, Booking CANCELLED_PENDING_REFUND
      const refund2 = await refundTransactionService.reserveTransaction({
        kind: 'CANCELLATION',
        paymentId: payment.id,
        cancellationRefundObligationId: obligation.id,
        cancellationBookingId: booking.id,
        amount: 10000,
        currency: 'USD',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `multi-ref-2-${crypto.randomUUID()}`,
      });

      const res2 = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund2.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_partial_2',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'INLINE', actorId: testUser.id },
      });

      expect(res2.applied).toBe(true);
      expect(res2.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(res2.bookingStatus).toBe(BookingStatus.CANCELLED_PENDING_REFUND);

      bookingDb = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(bookingDb.status).toBe(BookingStatus.CANCELLED_PENDING_REFUND);

      // Tx 3: Reserve $100 -> Settle SUCCEEDED -> Payment PARTIALLY_REFUNDED (30000/50000), Booking CANCELLED_AND_REFUNDED (30000/30000)
      const refund3 = await refundTransactionService.reserveTransaction({
        kind: 'CANCELLATION',
        paymentId: payment.id,
        cancellationRefundObligationId: obligation.id,
        cancellationBookingId: booking.id,
        amount: 10000,
        currency: 'USD',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `multi-ref-3-${crypto.randomUUID()}`,
      });

      const res3 = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund3.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_partial_3',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'INLINE', actorId: testUser.id },
      });

      expect(res3.applied).toBe(true);
      expect(res3.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(res3.bookingStatus).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      bookingDb = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      expect(bookingDb.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      const paymentDb = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(paymentDb.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);

      // Tx 4: Attempt to reserve $100 against obligation -> rejected with BadRequestException because obligation capacity is 0
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'CANCELLATION',
          paymentId: payment.id,
          cancellationRefundObligationId: obligation.id,
          cancellationBookingId: booking.id,
          amount: 10000,
          currency: 'USD',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: `multi-ref-4-${crypto.randomUUID()}`,
        }),
      ).rejects.toThrow(BadRequestException);

      // Tx 5: Reserve $100 against Payment directly (no obligation) -> succeeds (payment remaining capacity is $200)
      const refund5 = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 10000,
        currency: 'USD',
        reason: 'Direct payment refund',
        triggerType: RefundTriggerType.USER,
        actorId: testUser.id,
        idempotencyKey: `multi-ref-5-${crypto.randomUUID()}`,
      });

      expect(refund5).toBeDefined();
      expect(refund5.cancellationRefundObligationId).toBeNull();
      expect(refund5.amount).toBe(10000);

      const res5 = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund5.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_partial_5',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'ADMIN', actorId: testUser.id },
      });

      expect(res5.applied).toBe(true);
      expect(res5.paymentStatus).toBe(PaymentStatus.PARTIALLY_REFUNDED);
      expect(res5.bookingStatus).toBeUndefined();

      // Total ledger entries for payment should be 8 (4 succeeded refunds * 2 entries)
      const allLedgers = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(allLedgers).toHaveLength(8);
    });
  });

  describe('Requirement 1c: Capacity Limits & Over-Refund Prevention', () => {
    it('rejects refund reservation exceeding payment capacity with BadRequestException', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'over-cap-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 50000, // $500
        currency: 'USD',
      });

      // Attempt $600 on $500 payment
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'DIRECT',
          paymentId: payment.id,
          amount: 60000,
          currency: 'USD',
          reason: 'Excessive refund',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: `over-cap-ref-${crypto.randomUUID()}`,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund reservation on currency mismatch with payment or obligation with BadRequestException', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'cur-mis-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id);
      const obligation = await createObligation(booking.id, payment.id, {
        totalAmount: 10000,
        currency: 'USD',
      });

      // Currency mismatch with payment
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'DIRECT',
          paymentId: payment.id,
          amount: 5000,
          currency: 'EUR',
          reason: 'Currency mismatch payment',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: `cur-mis-ref-1-${crypto.randomUUID()}`,
        }),
      ).rejects.toThrow(BadRequestException);

      // Currency mismatch with obligation (payment is USD, input is USD, but obligation is EUR)
      const intent2 = await createBookingIntent(testUser.id, offer.id);
      const payIdem2 = await createIdempotencyKey(testUser.id, 'cur-mis-pay-2');
      const payment2 = await createPayment(intent2.id, payIdem2.id, {
        amount: 10000,
        currency: 'USD',
      });
      const booking2 = await createBooking(testUser.id, intent2.id, payment2.id);
      const eurObligation = await prisma.cancellationRefundObligation.create({
        data: {
          bookingId: booking2.id,
          paymentId: payment2.id,
          totalAmount: 10000,
          airlineRefundAmount: 10000,
          currency: 'EUR',
        },
      });

      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'CANCELLATION',
          paymentId: payment2.id,
          cancellationRefundObligationId: eurObligation.id,
          cancellationBookingId: booking2.id,
          amount: 5000,
          currency: 'USD',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: `cur-mis-ref-2-${crypto.randomUUID()}`,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refund reservation when obligation does not belong to specified payment with BadRequestException', async () => {
      const offer = await createFlightOffer();
      const intent1 = await createBookingIntent(testUser.id, offer.id);
      const intent2 = await createBookingIntent(testUser.id, offer.id);
      const payIdem1 = await createIdempotencyKey(testUser.id, 'ob-mis-pay-1');
      const payIdem2 = await createIdempotencyKey(testUser.id, 'ob-mis-pay-2');

      const payment1 = await createPayment(intent1.id, payIdem1.id);
      const payment2 = await createPayment(intent2.id, payIdem2.id);

      const booking1 = await createBooking(testUser.id, intent1.id, payment1.id);
      const obligation1 = await createObligation(booking1.id, payment1.id);

      // Attempt to reserve for payment2 using obligation1 (which belongs to payment1)
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'CANCELLATION',
          paymentId: payment2.id,
          cancellationRefundObligationId: obligation1.id,
          cancellationBookingId: booking1.id,
          amount: 5000,
          currency: 'USD',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: `ob-mis-ref-${crypto.randomUUID()}`,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('Requirement 1d: Idempotency & Replay Protection', () => {
    it('reserving with same idempotencyKey reuses existing active Refund row without duplicate creation', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'idem-reserve-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 20000,
        currency: 'USD',
      });

      const sharedKey = `shared-idem-key-${crypto.randomUUID()}`;

      // First reservation
      const refund1 = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 5000,
        currency: 'USD',
        reason: 'First reservation',
        triggerType: RefundTriggerType.USER,
        actorId: testUser.id,
        idempotencyKey: sharedKey,
      });

      // Duplicate reservation with same key and same payload
      const refund2 = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 5000,
        currency: 'USD',
        reason: 'First reservation',
        triggerType: RefundTriggerType.USER,
        actorId: testUser.id,
        idempotencyKey: sharedKey,
      });

      expect(refund1.id).toBe(refund2.id);

      const allRefunds = await prisma.refund.findMany({
        where: { paymentId: payment.id },
      });
      expect(allRefunds).toHaveLength(1);
    });

    it('rejects reservation reuse with different payload (amount, reason, currency, or payment) with BadRequestException', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'idem-mismatch-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 20000,
        currency: 'USD',
      });

      const sharedKey = `shared-mismatch-key-${crypto.randomUUID()}`;

      await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 5000,
        currency: 'USD',
        reason: 'Initial reservation payload',
        triggerType: RefundTriggerType.USER,
        actorId: testUser.id,
        idempotencyKey: sharedKey,
      });

      // Attempt reuse with different amount
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'DIRECT',
          paymentId: payment.id,
          amount: 6000,
          currency: 'USD',
          reason: 'Initial reservation payload',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: sharedKey,
        }),
      ).rejects.toThrow(BadRequestException);

      // Attempt reuse with different reason
      await expect(
        refundTransactionService.reserveTransaction({
          kind: 'DIRECT',
          paymentId: payment.id,
          amount: 5000,
          currency: 'USD',
          reason: 'Different reason payload',
          triggerType: RefundTriggerType.USER,
          actorId: testUser.id,
          idempotencyKey: sharedKey,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('settling an already SUCCEEDED refund returns applied: false without creating duplicate ledger or payment event records', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'idem-settle-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id);
      const obligation = await createObligation(booking.id, payment.id);

      const refund = await refundTransactionService.reserveTransaction({
        kind: 'CANCELLATION',
        paymentId: payment.id,
        cancellationRefundObligationId: obligation.id,
        cancellationBookingId: booking.id,
        amount: 10000,
        currency: 'USD',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `idem-settle-ref-${crypto.randomUUID()}`,
      });

      const settlementInput = {
        transactionId: refund.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED' as const,
          providerReference: 're_idem_test_1',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'INLINE' as const, actorId: testUser.id },
      };

      // First settlement
      const firstResult = await refundSettlementService.settleVerifiedOutcome(settlementInput);
      expect(firstResult.applied).toBe(true);

      const initialLedgers = await prisma.ledgerEntry.count({
        where: { refundTransactionId: refund.id },
      });
      expect(initialLedgers).toBe(2);

      const initialEvents = await prisma.paymentEvent.count({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_succeeded' },
      });
      expect(initialEvents).toBe(1);

      const initialAudits = await prisma.auditLog.count({
        where: { resourceId: refund.id, action: 'refund_settled' },
      });
      expect(initialAudits).toBe(1);

      // Second (duplicate) settlement replay
      const replayResult = await refundSettlementService.settleVerifiedOutcome(settlementInput);
      expect(replayResult.applied).toBe(false);
      expect(replayResult.transactionStatus).toBe('SUCCEEDED');
      expect(replayResult.paymentStatus).toBe(PaymentStatus.REFUNDED);
      expect(replayResult.bookingStatus).toBe(BookingStatus.CANCELLED_AND_REFUNDED);

      const postReplayLedgers = await prisma.ledgerEntry.count({
        where: { refundTransactionId: refund.id },
      });
      expect(postReplayLedgers).toBe(2);

      const postReplayEvents = await prisma.paymentEvent.count({
        where: { paymentId: payment.id, eventType: 'cancellation_refund_succeeded' },
      });
      expect(postReplayEvents).toBe(1);

      const postReplayAudits = await prisma.auditLog.count({
        where: { resourceId: refund.id, action: 'refund_settled' },
      });
      expect(postReplayAudits).toBe(1);
    });
  });

  describe('Requirement 1e: Terminal Failure Handling', () => {
    it('settling with FAILED outcome marks Refund as FAILED, restores Payment status to SUCCEEDED, and creates 0 ledger entries', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'fail-test-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.REFUND_PENDING,
      });

      const refund = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 10000,
        currency: 'USD',
        reason: 'Refund failure test',
        triggerType: RefundTriggerType.USER,
        actorId: testUser.id,
        idempotencyKey: `fail-ref-${crypto.randomUUID()}`,
      });

      const result = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'FAILED',
          errorCode: 'CARD_EXPIRED',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'ADMIN', actorId: testUser.id },
      });

      expect(result.applied).toBe(true);
      expect(result.transactionStatus).toBe('FAILED');
      expect(result.paymentStatus).toBe(PaymentStatus.SUCCEEDED);

      // Verify DB state
      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(updatedRefund.status).toBe(RefundStatus.FAILED);
      expect(updatedRefund.lastErrorCode).toBe('CARD_EXPIRED');

      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.SUCCEEDED);

      // Verify 0 ledger entries
      const ledgers = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: refund.id },
      });
      expect(ledgers).toHaveLength(0);

      // Verify payment event for failure
      const event = await prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'refund_failed' },
      });
      expect(event).toBeDefined();
      expect(event!.newStatus).toBe(PaymentStatus.SUCCEEDED);
    });

    it('settling with ATTENTION error code marks Refund as REFUND_FAILED_NEEDS_ATTENTION', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'attention-test-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.REFUND_PENDING,
      });

      const refund = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 10000,
        currency: 'USD',
        reason: 'Refund needs attention test',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `attention-ref-${crypto.randomUUID()}`,
      });

      const result = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'FAILED',
          errorCode: 'STRIPE_REQUIRES_ATTENTION',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'CRON' },
      });

      expect(result.applied).toBe(true);
      expect(result.transactionStatus).toBe('REFUND_FAILED_NEEDS_ATTENTION');

      const updatedRefund = await prisma.refund.findUniqueOrThrow({
        where: { id: refund.id },
      });
      expect(updatedRefund.status).toBe(RefundStatus.REFUND_FAILED_NEEDS_ATTENTION);
      expect(updatedRefund.lastErrorCode).toBe('STRIPE_REQUIRES_ATTENTION');
    });
  });

  describe('Requirement 1f: Dispute Overlay Handling', () => {
    it('settling SUCCEEDED refund on DISPUTED payment preserves status as DISPUTED and sets preDisputeStatus', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'dispute-overlay-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 20000,
        currency: 'USD',
        status: PaymentStatus.DISPUTED,
        preDisputeStatus: PaymentStatus.SUCCEEDED,
      });

      const refund = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 20000,
        currency: 'USD',
        reason: 'Dispute refund',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        actorId: testUser.id,
        idempotencyKey: `dispute-ref-${crypto.randomUUID()}`,
      });

      const result = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: 20000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_dispute_123',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'WEBHOOK', externalEventId: 'evt_dispute_1' },
      });

      expect(result.applied).toBe(true);
      expect(result.paymentStatus).toBe(PaymentStatus.DISPUTED);

      const updatedPayment = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(updatedPayment.status).toBe(PaymentStatus.DISPUTED);
      expect(updatedPayment.preDisputeStatus).toBe(PaymentStatus.REFUNDED);
    });
  });

  describe('Requirement 1g: Non-cancellation Refund (no obligation)', () => {
    it('reserves and settles refund without cancellation obligation, leaving bookingStatus undefined and creating 2 balanced ledger entries', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'no-ob-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
      });

      const refund = await refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId: payment.id,
        amount: 10000,
        currency: 'USD',
        reason: 'Direct goodwill refund',
        triggerType: RefundTriggerType.ADMIN,
        actorId: testUser.id,
        idempotencyKey: `no-ob-ref-${crypto.randomUUID()}`,
      });

      expect(refund.cancellationRefundObligationId).toBeNull();

      const result = await refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: 10000, currency: 'USD' },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 're_no_ob_123',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'ADMIN', actorId: testUser.id },
      });

      expect(result.applied).toBe(true);
      expect(result.transactionStatus).toBe('SUCCEEDED');
      expect(result.paymentStatus).toBe(PaymentStatus.REFUNDED);
      expect(result.bookingStatus).toBeUndefined();

      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: refund.id },
      });
      expect(ledgerEntries).toHaveLength(2);
      const debit = ledgerEntries.find((l) => l.entryType === LedgerEntryType.DEBIT);
      const credit = ledgerEntries.find((l) => l.entryType === LedgerEntryType.CREDIT);
      expect(debit?.amount).toBe(10000);
      expect(credit?.amount).toBe(10000);
      expect(debit?.transactionId).toBe(credit?.transactionId);
    });
  });
});
