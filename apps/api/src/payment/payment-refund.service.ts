import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { RefundTransactionService } from '../refund/refund-transaction.service';
import { RefundSettlementService } from '../refund-settlement/refund-settlement.service';
import { RefundPaymentDto } from '@/payment/dto/refund-payment.dto';
import { RefundResolutionAction } from '@/payment/dto/resolve-refund.dto';
import { RefundResponse } from '@shared/types/payment.types';
import { enforceTransition } from '@/payment/payment-state-machine';
import { BookingStatus, PaymentStatus, RefundStatus, RefundTriggerType } from '@prisma/client';
import * as crypto from 'crypto';
import {
  BookingEventPublisherService,
  PublishableEvent,
} from '@/domain-events';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';

@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly idempotencyService: PaymentIdempotencyService,
    private readonly auditService: AuditService,
    private readonly refundTransactionService: RefundTransactionService,
    private readonly refundSettlementService: RefundSettlementService,
    private readonly publisher: BookingEventPublisherService,
    private readonly bookingLifecycleService: BookingLifecycleService,
  ) {}

  /**
   * Initiates a refund for a given payment (admin/user-triggered).
   */
  async initiateRefund(
    paymentId: string,
    dto: RefundPaymentDto,
    idempotencyKey: string,
    userId: string,
    userRole: string,
  ): Promise<RefundResponse> {
    const triggerType = userRole === 'ADMIN' ? RefundTriggerType.ADMIN : RefundTriggerType.USER;

    try {
      // 1. Find Payment with bookingIntent
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { bookingIntent: true },
      });

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      // 2. Validate user owns the payment (admins bypass ownership check)
      if (userRole !== 'ADMIN' && payment.bookingIntent.userId !== userId) {
        throw new ForbiddenException('You do not own this payment');
      }

      // 3. Validate payment status allows refund
      const previousStatus = payment.status as PaymentStatus;
      enforceTransition(previousStatus, PaymentStatus.REFUND_PENDING);

      const refundIdempotencyKey = `refund:${paymentId}:${idempotencyKey}`;

      const refund = await this.refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId,
        amount: dto.amount,
        currency: payment.currency,
        reason: dto.reason || 'requested_by_customer',
        triggerType,
        actorId: userId,
        idempotencyKey: refundIdempotencyKey,
      });

      if (refund.status === RefundStatus.SUCCEEDED) {
        return {
          refundId: refund.id,
          paymentId,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          triggerType,
        };
      }

      let stripeRefund;
      try {
        stripeRefund = await this.stripeService.createRefund(
          payment.stripePaymentIntentId,
          dto.amount,
          dto.reason,
          `${idempotencyKey}-stripe-refund`,
        );
      } catch (stripeError) {
        const safeErrorCode = this.toSafeStripeErrorCode(stripeError);
        await this.refundSettlementService.settleVerifiedOutcome({
          transactionId: refund.id,
          money: { amount: dto.amount, currency: payment.currency },
          outcome: {
            status: 'FAILED',
            errorCode: safeErrorCode,
            occurredAt: new Date().toISOString(),
          },
          provenance: {
            source: 'INLINE',
            actorId: userId,
          },
        });
        throw stripeError;
      }

      await this.prisma.refund.update({
        where: { id: refund.id },
        data: { stripeRefundId: stripeRefund.id },
      });

      return {
        refundId: refund.id,
        paymentId,
        amount: dto.amount,
        currency: payment.currency,
        status: RefundStatus.REFUND_PENDING,
        triggerType,
      };
    } catch (error) {
      this.logger.error(
        `Error in initiateRefund: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Handles charge.refunded webhook event from Stripe.
   */
  async handleChargeRefunded(event: Record<string, unknown>): Promise<void> {
    try {
      const data = event.data as Record<string, unknown>;
      const charge = data.object as Record<string, unknown>;
      const paymentIntentId = charge.payment_intent as string;

      if (!paymentIntentId) {
        this.logger.warn('charge.refunded event missing payment_intent, skipping');
        return;
      }

      // Find the Payment by stripePaymentIntentId
      const payment = await this.prisma.payment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      if (!payment) {
        this.logger.error({
          message: `Payment not found for stripePaymentIntentId: ${paymentIntentId}`,
          eventType: 'charge.refunded',
        });
        return;
      }

      // Match specific Stripe refunds from the event to our REFUND_PENDING records
      const stripeRefunds = (charge.refunds as Record<string, unknown>)?.data as
        | Array<Record<string, unknown>>
        | undefined;
      const stripeRefundIds = stripeRefunds?.map((r) => r.id as string) ?? [];

      if (stripeRefundIds.length === 0) {
        this.logger.error({
          message: `charge.refunded event has no refund IDs for payment ${payment.id}. Dropping event to avoid unfiltered match.`,
          paymentId: payment.id,
        });
        return;
      }

      // Phase 1: match REFUND_PENDING rows that already have a known stripeRefundId.
      const explicitMatches = await this.prisma.refund.findMany({
        where: {
          paymentId: payment.id,
          status: 'REFUND_PENDING',
          stripeRefundId: { in: stripeRefundIds },
        },
      });

      const matchedStripeIds = new Set(explicitMatches.map((r) => r.stripeRefundId));
      const unmatchedStripeIds = stripeRefundIds.filter((id) => !matchedStripeIds.has(id));

      // Phase 2: for any Stripe IDs that had no explicit match, attempt to atomically
      // bind one null-ID REFUND_PENDING row per unmatched ID. We update exactly one
      // row at a time (LIMIT 1 via sub-select) so two concurrent webhooks cannot both
      // claim the same null row.
      const lateBindMatches: Array<{ id: string; amount: number; stripeRefundId?: string | null }> =
        [];
      for (const stripeId of unmatchedStripeIds) {
        const claimed = await this.prisma.$queryRaw<
          Array<{ id: string; amount: number; stripeRefundId?: string | null }>
        >`
          UPDATE "refunds"
          SET    "stripeRefundId" = ${stripeId}
          WHERE  id = (
            SELECT id FROM "refunds"
            WHERE  "paymentId" = ${payment.id}
              AND  status = 'REFUND_PENDING'
              AND  "stripeRefundId" IS NULL
            ORDER BY "createdAt" ASC
            LIMIT  1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING id, amount, "stripeRefundId"
        `;
        if (claimed.length > 0) {
          lateBindMatches.push(...claimed);
        } else {
          this.logger.warn({
            message: `Stripe refund ID ${stripeId} could not be bound to any REFUND_PENDING row for payment ${payment.id}`,
            paymentId: payment.id,
            stripeRefundId: stripeId,
          });
        }
      }

      const pendingRefunds = [...explicitMatches, ...lateBindMatches];

      if (pendingRefunds.length === 0) {
        this.logger.warn({
          message: `No matching REFUND_PENDING refunds found for payment ${payment.id} and Stripe refund IDs ${stripeRefundIds.join(', ')}`,
          paymentId: payment.id,
          stripeRefundIds,
        });
        return;
      }

      for (const pendingRefund of pendingRefunds) {
        const stripeRefundId = pendingRefund.stripeRefundId || stripeRefundIds[0];
        await this.refundSettlementService.settleVerifiedOutcome({
          transactionId: pendingRefund.id,
          money: {
            amount: pendingRefund.amount,
            currency: payment.currency,
          },
          outcome: {
            status: 'SUCCEEDED',
            providerReference: stripeRefundId,
            occurredAt: new Date().toISOString(),
          },
          provenance: {
            source: 'WEBHOOK',
            externalEventId: event.id as string,
            metadata: {
              paymentIntentId,
              stripeRefundId,
            },
          },
        });
      }

      this.logger.log({
        message: `charge.refunded processed for payment ${payment.id}`,
        paymentId: payment.id,
        pendingRefundsCount: pendingRefunds.length,
      });
    } catch (error) {
      this.logger.error(
        `Error in handleChargeRefunded: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  /**
   * Triggers an automated/system-initiated refund (e.g., for failed Duffel bookings).
   */
  async triggerAutomatedRefund(paymentId: string, reason: string): Promise<RefundResponse> {
    try {
      const idempotencyKey = `refund:${paymentId}:${reason}:1`;

      // Find the payment
      const payment = await this.prisma.payment.findUnique({
        where: { id: paymentId },
        include: { bookingIntent: true },
      });

      if (!payment) {
        throw new NotFoundException('Payment not found');
      }

      // Validate payment status allows refund
      const previousStatus = payment.status as PaymentStatus;
      enforceTransition(previousStatus, PaymentStatus.REFUND_PENDING);

      // Calculate total already refunded
      const succeededRefunds = await this.prisma.refund.findMany({
        where: { paymentId, status: 'SUCCEEDED' },
        select: { amount: true },
      });

      const totalRefunded = succeededRefunds.reduce(
        (sum: number, r: { amount: number }) => sum + r.amount,
        0,
      );

      const refundableAmount = payment.amount - totalRefunded;
      if (refundableAmount <= 0) {
        throw new BadRequestException('No refundable amount remaining');
      }

      const refund = await this.refundTransactionService.reserveTransaction({
        kind: 'DIRECT',
        paymentId,
        amount: refundableAmount,
        currency: payment.currency,
        reason,
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        idempotencyKey,
      });

      if (refund.status === RefundStatus.SUCCEEDED) {
        return {
          refundId: refund.id,
          paymentId,
          amount: refund.amount,
          currency: refund.currency,
          status: refund.status,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        };
      }

      let stripeRefund;
      try {
        stripeRefund = await this.stripeService.createRefund(
          payment.stripePaymentIntentId,
          refundableAmount,
          reason,
          `${idempotencyKey}-stripe-refund`,
        );
      } catch (stripeError) {
        const safeErrorCode = this.toSafeStripeErrorCode(stripeError);
        await this.refundSettlementService.settleVerifiedOutcome({
          transactionId: refund.id,
          money: { amount: refundableAmount, currency: payment.currency },
          outcome: {
            status: 'FAILED',
            errorCode: safeErrorCode,
            occurredAt: new Date().toISOString(),
          },
          provenance: {
            source: 'INLINE',
          },
        });
        throw stripeError;
      }

      const settlement = await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: refundableAmount, currency: payment.currency },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: stripeRefund.id,
          occurredAt: new Date().toISOString(),
        },
        provenance: {
          source: 'INLINE',
        },
      });

      return {
        refundId: refund.id,
        paymentId,
        amount: refundableAmount,
        currency: payment.currency,
        status: settlement.transactionStatus,
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
      };
    } catch (error) {
      this.logger.error(
        `Error in triggerAutomatedRefund: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async processCancellationRefund(input: {
    bookingId: string;
    paymentId: string;
    amount: number;
    currency: string;
  }): Promise<{
    refundStatus: string;
    refundAmount: string;
    nextRetryAt?: string;
  }> {
    if (!Number.isInteger(input.amount) || input.amount <= 0) {
      throw new BadRequestException('Cancellation refund amount must be a positive integer');
    }

    const payment = await this.prisma.payment.findUnique({
      where: { id: input.paymentId },
      include: { bookingIntent: { select: { userId: true } } },
    });
    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: { id: true, paymentId: true, status: true },
    });
    if (!booking || booking.paymentId !== payment.id) {
      throw new NotFoundException('Cancellation booking not found for payment');
    }

    const refundAmount = this.toMajorCurrency(input.amount);
    if (booking.status === 'CANCELLED_AND_REFUNDED') {
      return { refundStatus: 'SUCCEEDED', refundAmount };
    }

    const obligation = await this.prisma.cancellationRefundObligation.findUnique({
      where: { bookingId: input.bookingId },
    });
    if (!obligation) {
      throw new NotFoundException('Cancellation refund obligation not found');
    }

    const idempotencyKey = `cancellation-refund:${obligation.id}:1`;

    const refund = await this.refundTransactionService.reserveTransaction({
      kind: 'CANCELLATION',
      paymentId: input.paymentId,
      cancellationRefundObligationId: obligation.id,
      cancellationBookingId: input.bookingId,
      amount: input.amount,
      currency: input.currency,
      triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
      idempotencyKey,
    });

    if (refund.status === 'SUCCEEDED') {
      return { refundStatus: 'SUCCEEDED', refundAmount };
    }

    let stripeRefund: { id: string } | null;
    try {
      stripeRefund = await this.createCancellationRefundWithRetries(
        payment.stripePaymentIntentId,
        input.amount,
        idempotencyKey,
      );
    } catch (error) {
      await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: input.amount, currency: input.currency },
        outcome: {
          status: 'FAILED',
          errorCode: 'REFUND_FAILED_NEEDS_ATTENTION',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'INLINE' },
      });
      throw error;
    }

    if (!stripeRefund) {
      const nextRetryAt = new Date(Date.now() + 60_000);
      await this.prisma.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PENDING },
        data: { status: RefundStatus.REFUND_RETRY_SCHEDULED, nextRetryAt },
      });
      return {
        refundStatus: RefundStatus.REFUND_RETRY_SCHEDULED,
        refundAmount,
        nextRetryAt: nextRetryAt.toISOString(),
      };
    }

    await this.refundSettlementService.settleVerifiedOutcome({
      transactionId: refund.id,
      money: { amount: input.amount, currency: input.currency },
      outcome: {
        status: 'SUCCEEDED',
        providerReference: stripeRefund.id,
        occurredAt: new Date().toISOString(),
      },
      provenance: { source: 'INLINE' },
    });

    return { refundStatus: 'SUCCEEDED', refundAmount };
  }

  /** Called only after the cron worker has CAS-claimed a due cancellation refund. */
  async recoverScheduledCancellationRefund(refundId: string): Promise<void> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      include: {
        payment: { select: { id: true, stripePaymentIntentId: true, currency: true } },
        idempotencyKey: { select: { key: true } },
      },
    });
    if (
      !refund ||
      refund.status !== RefundStatus.REFUND_PROCESSING ||
      !refund.cancellationRefundObligationId
    ) {
      return;
    }

    if (
      !refund.idempotencyKeyCreatedAt ||
      this.isIdempotencyKeyUnsafe(refund.idempotencyKeyCreatedAt)
    ) {
      await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: refund.amount, currency: refund.currency },
        outcome: {
          status: 'FAILED',
          errorCode: 'IDEMPOTENCY_KEY_SAFETY_WINDOW',
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'CRON' },
      });
      return;
    }

    try {
      const stripeRefund = await this.stripeService.createRefund(
        refund.payment.stripePaymentIntentId,
        refund.amount,
        'requested_by_customer',
        refund.idempotencyKey.key,
      );
      await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: refund.amount, currency: refund.currency },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: stripeRefund.id,
          occurredAt: new Date().toISOString(),
        },
        provenance: { source: 'CRON' },
      });
    } catch (error: unknown) {
      const errorCode = this.toSafeStripeErrorCode(error);
      if (!this.isTransientStripeError(error) || refund.retryCount >= 3) {
        await this.refundSettlementService.settleVerifiedOutcome({
          transactionId: refund.id,
          money: { amount: refund.amount, currency: refund.currency },
          outcome: {
            status: 'FAILED',
            errorCode,
            occurredAt: new Date().toISOString(),
          },
          provenance: { source: 'CRON' },
        });
        return;
      }

      const delay = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000][refund.retryCount] ?? 5 * 60_000;
      await this.prisma.refund.updateMany({
        where: { id: refund.id, status: RefundStatus.REFUND_PROCESSING },
        data: {
          status: RefundStatus.REFUND_RETRY_SCHEDULED,
          retryCount: { increment: 1 },
          nextRetryAt: new Date(Date.now() + delay),
          lastErrorCode: errorCode,
          lastErrorAt: new Date(),
        },
      });
    }
  }

  async resolveEscalatedCancellationRefund(
    refundId: string,
    action: RefundResolutionAction,
    actorId?: string,
  ): Promise<{ refundId: string; refundStatus: string; bookingStatus: string }> {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        id: true,
        paymentId: true,
        status: true,
        amount: true,
        currency: true,
        cancellationRefundObligation: { select: { bookingId: true } },
      },
    });
    if (!refund?.cancellationRefundObligation) {
      throw new NotFoundException('Escalated cancellation refund not found');
    }
    const bookingId = refund.cancellationRefundObligation.bookingId;

    if (action === 'RETRY_WITH_FRESH_KEY') {
      let eventsToPublish: PublishableEvent[] = [];
      const result = await this.prisma.$transaction(async (tx) => {
        const context = this.publisher.createContext(tx);
        const key = await tx.idempotencyKey.create({
          data: {
            key: `cancellation-refund:${bookingId}:${crypto.randomUUID()}`,
            requestHash: crypto.randomUUID(),
            customerId: (
              await tx.booking.findUniqueOrThrow({
                where: { id: bookingId },
                select: { userId: true },
              })
            ).userId,
            requestPath: `/api/admin/refunds/${refund.id}/resolve`,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
        });
        const claim = await tx.refund.updateMany({
          where: { id: refund.id, status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION },
          data: {
            idempotencyKeyId: key.id,
            idempotencyKeyCreatedAt: new Date(),
            status: RefundStatus.REFUND_RETRY_SCHEDULED,
            retryCount: 0,
            nextRetryAt: new Date(),
            lastErrorCode: null,
            lastErrorAt: null,
          },
        });
        if (claim.count !== 1) {
          throw new ConflictException('Refund is not awaiting manual resolution');
        }
        const bookingUpdate = await this.bookingLifecycleService.updateBookingRefundStatus(
          bookingId,
          BookingStatus.CANCELLED_PENDING_REFUND,
          RefundStatus.REFUND_RETRY_SCHEDULED,
          undefined,
          tx,
          context,
        );
        eventsToPublish = [...context.events];
        return {
          refundStatus: RefundStatus.REFUND_RETRY_SCHEDULED,
          bookingStatus:
            bookingUpdate.updatedBooking?.status ?? BookingStatus.CANCELLED_PENDING_REFUND,
        };
      });

      if (eventsToPublish.length > 0) {
        await this.publisher.publish(eventsToPublish);
      }

      await this.auditService.createLog(null, {
        userId: actorId ?? null,
        action: 'CANCELLATION_REFUND_MANUALLY_RESOLVED',
        resourceType: 'Refund',
        resourceId: refund.id,
        metadata: { action },
      });
      return { refundId: refund.id, ...result };
    }

    if (action === 'MARK_RESOLVED_MANUALLY') {
      if (refund.status !== RefundStatus.REFUND_FAILED_NEEDS_ATTENTION) {
        throw new ConflictException('Refund is not awaiting manual resolution');
      }

      const settlement = await this.refundSettlementService.settleVerifiedOutcome({
        transactionId: refund.id,
        money: { amount: refund.amount, currency: refund.currency },
        outcome: {
          status: 'SUCCEEDED',
          providerReference: 'MANUAL_ADMIN_OVERRIDE',
          occurredAt: new Date().toISOString(),
        },
        provenance: {
          source: 'ADMIN',
          actorId,
        },
      });

      if (!settlement.applied && settlement.transactionStatus !== 'SUCCEEDED') {
        throw new ConflictException('Refund is not awaiting manual resolution');
      }

      await this.auditService.createLog(null, {
        userId: actorId ?? null,
        action: 'CANCELLATION_REFUND_MANUALLY_RESOLVED',
        resourceType: 'Refund',
        resourceId: refund.id,
        metadata: { action },
      });

      return {
        refundId: refund.id,
        refundStatus: 'SUCCEEDED',
        bookingStatus: settlement.bookingStatus || 'CANCELLED_AND_REFUNDED',
      };
    }

    throw new BadRequestException(`Unsupported action: ${action}`);
  }

  async listEscalatedRefunds() {
    const refunds = await this.prisma.refund.findMany({
      where: { status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION },
      include: {
        cancellationRefundObligation: {
          select: {
            booking: {
              select: { id: true, status: true, pnrReference: true, supplierOrderId: true },
            },
          },
        },
        payment: {
          select: {
            id: true,
            status: true,
            stripePaymentIntentId: true,
            amount: true,
            currency: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return refunds.map(({ cancellationRefundObligation, ...refund }) => ({
      ...refund,
      booking: cancellationRefundObligation?.booking
        ? {
            id: cancellationRefundObligation.booking.id,
            status: cancellationRefundObligation.booking.status,
            pnrReference: cancellationRefundObligation.booking.pnrReference,
            duffelOrderId: cancellationRefundObligation.booking.supplierOrderId,
          }
        : null,
    }));
  }

  private isIdempotencyKeyUnsafe(createdAt: Date): boolean {
    return Date.now() - createdAt.getTime() >= 22 * 60 * 60 * 1000;
  }

  private toSafeStripeErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'STRIPE_UNKNOWN_ERROR';
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(candidate.code))
      return candidate.code;
    if (typeof candidate.statusCode === 'number') return `HTTP_${candidate.statusCode}`;
    return 'STRIPE_UNKNOWN_ERROR';
  }

  private async createCancellationRefundWithRetries(
    paymentIntentId: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<{ id: string } | null> {
    const retryDelays = [1_000, 3_000, 5_000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const refund = await this.stripeService.createRefund(
          paymentIntentId,
          amount,
          'requested_by_customer',
          idempotencyKey,
        );
        return { id: refund.id };
      } catch (error) {
        if (!this.isTransientStripeError(error)) {
          throw error;
        }
        if (attempt < retryDelays.length) {
          await this.delay(retryDelays[attempt]);
        }
      }
    }
    return null;
  }

  private isTransientStripeError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { statusCode?: unknown; code?: unknown; message?: unknown };
    const statusCode = candidate.statusCode;
    if (typeof statusCode === 'number' && (statusCode === 429 || statusCode >= 500)) {
      return true;
    }
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const message = typeof candidate.message === 'string' ? candidate.message : '';
    return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|connection/i.test(`${code} ${message}`);
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private toMajorCurrency(amount: number): string {
    return (amount / 100).toFixed(2);
  }
}
