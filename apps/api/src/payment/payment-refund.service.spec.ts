import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, PaymentStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { RefundTransactionService } from '../refund/refund-transaction.service';
import { RefundSettlementService } from '../refund-settlement/refund-settlement.service';
import { PaymentRefundService } from './payment-refund.service';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import {
  BookingEventPublisherService,
  BookingRefundUpdatedEvent,
} from '@/domain-events';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';

describe('PaymentRefundService', () => {
  let service: PaymentRefundService;
  const prisma = {
    payment: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    booking: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    cancellationRefundObligation: { findUnique: jest.fn() },
    refund: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    idempotencyKey: { findUnique: jest.fn(), create: jest.fn() },
    paymentEvent: { create: jest.fn() },
    ledgerEntry: { createMany: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const stripe = { createRefund: jest.fn() };
  const idempotency = {
    acquireOrReplay: jest.fn(),
    completeKey: jest.fn(),
  };
  const audit = { createLog: jest.fn() };
  const refundTransactionService = { reserveTransaction: jest.fn() };
  const refundSettlementService = { settleVerifiedOutcome: jest.fn() };
  const publisher = {
    createContext: jest.fn(),
    publish: jest.fn(),
  };
  const bookingLifecycleService = {
    updateBookingRefundStatus: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    publisher.createContext.mockImplementation((tx) => ({ tx, events: [] }));
    publisher.publish.mockResolvedValue(undefined);
    bookingLifecycleService.updateBookingRefundStatus.mockImplementation(
      async (bookingId, targetStatus, refundStatus, reason, tx, context) => {
        if (context) {
          context.events.push(
            new BookingRefundUpdatedEvent({
              bookingId,
              eventId: 'mock-event-id',
              sourceVersion: 2,
              status: targetStatus,
              refundStatus,
              reason,
              timestamp: new Date(),
            }),
          );
        }
        return { count: 1, updatedBooking: { id: bookingId, status: targetStatus, version: 2 } };
      },
    );
    idempotency.acquireOrReplay.mockResolvedValue({ status: 'acquired' });
    idempotency.completeKey.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    prisma.payment.findUnique.mockResolvedValue({
      id: 'payment-1',
      stripePaymentIntentId: 'pi_1',
      status: PaymentStatus.SUCCEEDED,
      currency: 'usd',
      amount: 12_500,
      bookingIntent: { userId: 'user-1' },
    });
    prisma.booking.findUnique.mockResolvedValue({
      id: 'booking-1',
      paymentId: 'payment-1',
      status: BookingStatus.CANCELLED_PENDING_REFUND,
    });
    prisma.cancellationRefundObligation.findUnique.mockResolvedValue({
      id: 'obligation-1',
      bookingId: 'booking-1',
      paymentId: 'payment-1',
    });
    prisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'key-1' });
    prisma.refund.findFirst.mockResolvedValue(null);
    prisma.refund.create.mockResolvedValue({ id: 'refund-1' });
    prisma.payment.updateMany.mockResolvedValue({ count: 1 });
    prisma.refund.updateMany.mockResolvedValue({ count: 1 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentRefundService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: stripe },
        { provide: PaymentIdempotencyService, useValue: idempotency },
        { provide: AuditService, useValue: audit },
        { provide: RefundTransactionService, useValue: refundTransactionService },
        { provide: RefundSettlementService, useValue: refundSettlementService },
        { provide: BookingEventPublisherService, useValue: publisher },
        { provide: BookingLifecycleService, useValue: bookingLifecycleService },
      ],
    }).compile();
    service = module.get(PaymentRefundService);
  });

  describe('initiateRefund', () => {
    it('reserves transaction and settles verified outcome on success', async () => {
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-1',
        paymentId: 'payment-1',
        amount: 5000,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockResolvedValue({ id: 're_stripe_1' });
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.PARTIALLY_REFUNDED,
      });

      const res = await service.initiateRefund(
        'payment-1',
        { amount: 5000, reason: 'customer_request' },
        'idem-key-1',
        'user-1',
        'USER',
      );

      expect(refundTransactionService.reserveTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'DIRECT',
          paymentId: 'payment-1',
          amount: 5000,
          currency: 'usd',
          reason: 'customer_request',
          triggerType: RefundTriggerType.USER,
          actorId: 'user-1',
          idempotencyKey: 'refund:payment-1:idem-key-1',
        }),
      );
      expect(stripe.createRefund).toHaveBeenCalledWith(
        'pi_1',
        5000,
        'customer_request',
        'idem-key-1-stripe-refund',
      );
      expect(prisma.refund.update).toHaveBeenCalledWith({
        where: { id: 'refund-1' },
        data: { stripeRefundId: 're_stripe_1' },
      });
      expect(res).toEqual({
        refundId: 'refund-1',
        paymentId: 'payment-1',
        amount: 5000,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
        triggerType: RefundTriggerType.USER,
      });
    });

    it('keeps a refund pending without invoking Stripe when the payment intent ID is missing', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'payment-1',
        stripePaymentIntentId: null,
        status: PaymentStatus.SUCCEEDED,
        currency: 'usd',
        amount: 12_500,
        bookingIntent: { userId: 'user-1' },
      });
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-pending-1',
        paymentId: 'payment-1',
        amount: 5_000,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockResolvedValue({ id: 're_unused' });

      const result = await service.initiateRefund(
        'payment-1',
        { amount: 5_000, reason: 'customer_request' },
        'idem-key-missing-pi',
        'user-1',
        'USER',
      );

      expect(result).toEqual({
        refundId: 'refund-pending-1',
        paymentId: 'payment-1',
        amount: 5_000,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
        triggerType: RefundTriggerType.USER,
      });
      expect(stripe.createRefund).not.toHaveBeenCalled();
      expect(prisma.refund.update).not.toHaveBeenCalled();
    });
    it('rejects if non-admin user does not own the payment', async () => {
      await expect(
        service.initiateRefund(
          'payment-1',
          { amount: 5000, reason: 'customer_request' },
          'idem-key-1',
          'other-user',
          'USER',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('settles failure outcome if Stripe call throws', async () => {
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-1',
        amount: 5000,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockRejectedValue(new Error('Stripe card declined'));
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'FAILED',
        paymentStatus: PaymentStatus.SUCCEEDED,
      });

      await expect(
        service.initiateRefund(
          'payment-1',
          { amount: 5000, reason: 'customer_request' },
          'idem-key-1',
          'user-1',
          'USER',
        ),
      ).rejects.toThrow('Stripe card declined');

      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          outcome: expect.objectContaining({
            status: 'FAILED',
          }),
          provenance: expect.objectContaining({
            source: 'INLINE',
            actorId: 'user-1',
          }),
        }),
      );
    });
  });

  describe('triggerAutomatedRefund', () => {
    it('reserves and settles automated refund cleanly', async () => {
      prisma.refund.findMany.mockResolvedValue([]);
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-auto-1',
        amount: 12_500,
        currency: 'usd',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockResolvedValue({ id: 're_auto_1' });
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
      });

      const res = await service.triggerAutomatedRefund('payment-1', 'duffel_booking_failed');

      expect(refundTransactionService.reserveTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'DIRECT',
          paymentId: 'payment-1',
          amount: 12_500,
          currency: 'usd',
          reason: 'duffel_booking_failed',
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          idempotencyKey: 'refund:payment-1:duffel_booking_failed:1',
        }),
      );
      expect(res.status).toBe('SUCCEEDED');
    });
  });

  describe('processCancellationRefund', () => {
    it('rejects a cancellation refund when the booking has no refund obligation', async () => {
      prisma.cancellationRefundObligation.findUnique.mockResolvedValue(null);

      await expect(
        service.processCancellationRefund({
          bookingId: 'booking-1',
          paymentId: 'payment-1',
          amount: 12_500,
          currency: 'usd',
        }),
      ).rejects.toThrow('Cancellation refund obligation not found');

      expect(refundTransactionService.reserveTransaction).not.toHaveBeenCalled();
    });

    it('reserves transaction and settles verified outcome on Stripe success', async () => {
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockResolvedValue({ id: 're_1' });
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      const result = await service.processCancellationRefund({
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        amount: 12_500,
        currency: 'usd',
      });

      expect(result).toEqual({ refundStatus: 'SUCCEEDED', refundAmount: '125.00' });
      expect(refundTransactionService.reserveTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'CANCELLATION',
          paymentId: 'payment-1',
          cancellationRefundObligationId: 'obligation-1',
          cancellationBookingId: 'booking-1',
          amount: 12_500,
          currency: 'usd',
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
          idempotencyKey: 'cancellation-refund:obligation-1:1',
        }),
      );
      expect(stripe.createRefund).toHaveBeenCalledWith(
        'pi_1',
        12_500,
        'requested_by_customer',
        'cancellation-refund:obligation-1:1',
      );
      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          money: { amount: 12_500, currency: 'usd' },
          outcome: expect.objectContaining({
            status: 'SUCCEEDED',
            providerReference: 're_1',
          }),
          provenance: expect.objectContaining({
            source: 'INLINE',
          }),
        }),
      );
    });

    it('schedules retry when transient retries are exhausted', async () => {
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund
        .mockRejectedValueOnce({ statusCode: 503, message: 'upstream unavailable' })
        .mockRejectedValueOnce({ statusCode: 429, message: 'rate limited' })
        .mockRejectedValueOnce({ statusCode: 500, message: 'upstream unavailable' })
        .mockRejectedValueOnce({ statusCode: 503, message: 'upstream unavailable' });
      jest
        .spyOn(service as unknown as { delay: (milliseconds: number) => Promise<void> }, 'delay')
        .mockResolvedValue();

      const result = await service.processCancellationRefund({
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        amount: 12_500,
        currency: 'usd',
      });

      expect(result.refundStatus).toBe('REFUND_RETRY_SCHEDULED');
      expect(result.nextRetryAt).toEqual(expect.any(String));
      expect(stripe.createRefund).toHaveBeenCalledTimes(4);
      expect(prisma.refund.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'refund-1', status: RefundStatus.REFUND_PENDING },
          data: expect.objectContaining({ status: RefundStatus.REFUND_RETRY_SCHEDULED }),
        }),
      );
      expect(refundSettlementService.settleVerifiedOutcome).not.toHaveBeenCalled();
    });

    it('settles failure outcome on non-transient Stripe failure and throws', async () => {
      refundTransactionService.reserveTransaction.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PENDING,
      });
      stripe.createRefund.mockRejectedValue({ statusCode: 400, message: 'invalid request' });

      await expect(
        service.processCancellationRefund({
          bookingId: 'booking-1',
          paymentId: 'payment-1',
          amount: 12_500,
          currency: 'usd',
        }),
      ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }));

      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          outcome: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'REFUND_FAILED_NEEDS_ATTENTION',
          }),
          provenance: expect.objectContaining({ source: 'INLINE' }),
        }),
      );
    });
  });

  describe('recoverScheduledCancellationRefund', () => {
    it('escalates unsafe idempotency key to failed settlement without calling Stripe', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PROCESSING,
        cancellationRefundObligationId: 'obligation-1',
        paymentId: 'payment-1',
        retryCount: 0,
        amount: 12_500,
        currency: 'usd',
        idempotencyKeyCreatedAt: new Date(Date.now() - 23 * 60 * 60 * 1000),
        payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1', currency: 'usd' },
        idempotencyKey: { key: 'cancellation-refund:obligation-1:1' },
      });

      await service.recoverScheduledCancellationRefund('refund-1');

      expect(stripe.createRefund).not.toHaveBeenCalled();
      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          outcome: expect.objectContaining({
            status: 'FAILED',
            errorCode: 'IDEMPOTENCY_KEY_SAFETY_WINDOW',
          }),
          provenance: expect.objectContaining({ source: 'CRON' }),
        }),
      );
    });

    it('settles success outcome via CRON provenance after Stripe succeeds', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PROCESSING,
        cancellationRefundObligationId: 'obligation-1',
        paymentId: 'payment-1',
        retryCount: 1,
        amount: 12_500,
        currency: 'usd',
        idempotencyKeyCreatedAt: new Date(),
        payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1', currency: 'usd' },
        idempotencyKey: { key: 'cancellation-refund:obligation-1:1' },
      });
      stripe.createRefund.mockResolvedValue({ id: 're_cron_1' });

      await service.recoverScheduledCancellationRefund('refund-1');

      expect(stripe.createRefund).toHaveBeenCalledWith(
        'pi_1',
        12_500,
        'requested_by_customer',
        'cancellation-refund:obligation-1:1',
      );
      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          outcome: expect.objectContaining({
            status: 'SUCCEEDED',
            providerReference: 're_cron_1',
          }),
          provenance: expect.objectContaining({ source: 'CRON' }),
        }),
      );
    });

    it('requeues transient error when retryCount < 3', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        status: RefundStatus.REFUND_PROCESSING,
        cancellationRefundObligationId: 'obligation-1',
        paymentId: 'payment-1',
        retryCount: 0,
        amount: 12_500,
        currency: 'usd',
        idempotencyKeyCreatedAt: new Date(),
        payment: { id: 'payment-1', stripePaymentIntentId: 'pi_1', currency: 'usd' },
        idempotencyKey: { key: 'cancellation-refund:obligation-1:1' },
      });
      stripe.createRefund.mockRejectedValue({ statusCode: 503, message: 'unavailable' });

      await service.recoverScheduledCancellationRefund('refund-1');

      expect(prisma.refund.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'refund-1', status: RefundStatus.REFUND_PROCESSING },
          data: expect.objectContaining({
            status: RefundStatus.REFUND_RETRY_SCHEDULED,
            retryCount: { increment: 1 },
            lastErrorCode: 'HTTP_503',
          }),
        }),
      );
      expect(refundSettlementService.settleVerifiedOutcome).not.toHaveBeenCalled();
    });
  });

  describe('resolveEscalatedCancellationRefund', () => {
    it('settles manual resolution with ADMIN provenance and actorId', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        cancellationRefundObligation: { bookingId: 'booking-1' },
        paymentId: 'payment-1',
        status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        amount: 12_500,
        currency: 'usd',
      });
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      const res = await service.resolveEscalatedCancellationRefund(
        'refund-1',
        'MARK_RESOLVED_MANUALLY',
        'admin-user-1',
      );

      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          money: { amount: 12_500, currency: 'usd' },
          outcome: expect.objectContaining({
            status: 'SUCCEEDED',
            providerReference: 'MANUAL_ADMIN_OVERRIDE',
          }),
          provenance: expect.objectContaining({
            source: 'ADMIN',
            actorId: 'admin-user-1',
          }),
        }),
      );
      expect(res).toEqual({
        refundId: 'refund-1',
        refundStatus: 'SUCCEEDED',
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });
      expect(audit.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          userId: 'admin-user-1',
          action: 'CANCELLATION_REFUND_MANUALLY_RESOLVED',
          resourceId: 'refund-1',
        }),
      );
    });

    it('rejects MARK_RESOLVED_MANUALLY if refund is not in REFUND_FAILED_NEEDS_ATTENTION', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        cancellationRefundObligation: { bookingId: 'booking-1' },
        paymentId: 'payment-1',
        status: RefundStatus.SUCCEEDED,
        amount: 12_500,
        currency: 'usd',
      });

      await expect(
        service.resolveEscalatedCancellationRefund('refund-1', 'MARK_RESOLVED_MANUALLY', 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });

    it('handles RETRY_WITH_FRESH_KEY cleanly and dispatches BookingRefundUpdatedEvent post-commit', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        cancellationRefundObligation: { bookingId: 'booking-1' },
        paymentId: 'payment-1',
        status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        amount: 12_500,
        currency: 'usd',
      });
      prisma.booking.findUniqueOrThrow.mockResolvedValue({ userId: 'user-1' });
      prisma.idempotencyKey.create.mockResolvedValue({ id: 'new-key-1' });
      prisma.refund.updateMany.mockResolvedValue({ count: 1 });

      let publishCalledBeforeCommit = false;
      prisma.$transaction.mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          const res = await callback(prisma);
          if (publisher.publish.mock.calls.length > 0) {
            publishCalledBeforeCommit = true;
          }
          return res;
        },
      );

      const res = await service.resolveEscalatedCancellationRefund(
        'refund-1',
        'RETRY_WITH_FRESH_KEY',
        'admin-1',
      );

      expect(res.refundStatus).toBe(RefundStatus.REFUND_RETRY_SCHEDULED);
      expect(res.bookingStatus).toBe(BookingStatus.CANCELLED_PENDING_REFUND);

      // Verify delegation to BookingLifecycleService instead of raw prisma update
      expect(bookingLifecycleService.updateBookingRefundStatus).toHaveBeenCalledWith(
        'booking-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        RefundStatus.REFUND_RETRY_SCHEDULED,
        undefined,
        prisma,
        expect.any(Object),
      );
      expect(prisma.booking.update).not.toHaveBeenCalled();

      // Verify context created and event published post-commit
      expect(publisher.createContext).toHaveBeenCalledWith(prisma);
      expect(publishCalledBeforeCommit).toBe(false);
      expect(publisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = publisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      expect(publishedBatch[0]).toMatchObject({
        bookingId: 'booking-1',
        sourceVersion: 2,
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        refundStatus: RefundStatus.REFUND_RETRY_SCHEDULED,
      });
      const publishedEvent = publishedBatch[0];
      expect(publishedEvent).toBeInstanceOf(BookingRefundUpdatedEvent);
    });

    it('discards events and does not publish if transaction rolls back on RETRY_WITH_FRESH_KEY', async () => {
      prisma.refund.findUnique.mockResolvedValue({
        id: 'refund-1',
        cancellationRefundObligation: { bookingId: 'booking-1' },
        paymentId: 'payment-1',
        status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        amount: 12_500,
        currency: 'usd',
      });
      prisma.booking.findUniqueOrThrow.mockResolvedValue({ userId: 'user-1' });
      prisma.idempotencyKey.create.mockResolvedValue({ id: 'new-key-1' });
      prisma.refund.updateMany.mockResolvedValue({ count: 0 }); // simulate conflict

      await expect(
        service.resolveEscalatedCancellationRefund(
          'refund-1',
          'RETRY_WITH_FRESH_KEY',
          'admin-1',
        ),
      ).rejects.toThrow(ConflictException);

      expect(publisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('handleChargeRefunded webhook', () => {
    it('settles verified outcome with WEBHOOK provenance for matching refund rows', async () => {
      prisma.payment.findUnique.mockResolvedValue({
        id: 'payment-1',
        stripePaymentIntentId: 'pi_1',
        currency: 'usd',
      });
      prisma.refund.findMany.mockResolvedValue([
        {
          id: 'refund-1',
          amount: 10000,
          stripeRefundId: 're_stripe_wh_1',
        },
      ]);
      refundSettlementService.settleVerifiedOutcome.mockResolvedValue({
        applied: true,
        transactionStatus: 'SUCCEEDED',
        paymentStatus: PaymentStatus.REFUNDED,
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
      });

      const event = {
        id: 'evt_stripe_wh_1',
        type: 'charge.refunded',
        data: {
          object: {
            payment_intent: 'pi_1',
            refunds: {
              data: [{ id: 're_stripe_wh_1', amount: 10000 }],
            },
          },
        },
      };

      await service.handleChargeRefunded(event);

      expect(refundSettlementService.settleVerifiedOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionId: 'refund-1',
          money: { amount: 10000, currency: 'usd' },
          outcome: expect.objectContaining({
            status: 'SUCCEEDED',
            providerReference: 're_stripe_wh_1',
          }),
          provenance: expect.objectContaining({
            source: 'WEBHOOK',
            externalEventId: 'evt_stripe_wh_1',
            metadata: {
              paymentIntentId: 'pi_1',
              stripeRefundId: 're_stripe_wh_1',
            },
          }),
        }),
      );
    });
  });
});
