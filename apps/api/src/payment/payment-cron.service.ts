import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, BookingIntentStatus, PaymentEventSource } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../common/stripe.service';
import { enforceTransition } from './payment-state-machine';
import { PaymentMethodService } from './payment-method.service';
import { PaymentRefundService } from './payment-refund.service';
import { hasStripePaymentIntentId } from '@/payment-fulfillment/stripe-payment-intent-reference';

@Injectable()
export class PaymentCronService {
  private readonly logger = new Logger(PaymentCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly configService: ConfigService,
    private readonly paymentMethodService: PaymentMethodService,
    private readonly paymentRefundService: PaymentRefundService,
  ) {}

  @Cron('*/1 * * * *')
  async handleCancellationRefundRecovery(): Promise<void> {
    const now = new Date();
    const processingLeaseExpiresAt = new Date(now.getTime() + 5 * 60_000);
    try {
      const dueRefunds = await this.prisma.refund.findMany({
        where: {
          OR: [
            { status: 'REFUND_RETRY_SCHEDULED', nextRetryAt: { lte: now } },
            { status: 'REFUND_PROCESSING', nextRetryAt: { lte: now } },
            { status: 'REFUND_PROCESSING', nextRetryAt: null },
          ],
        },
        orderBy: { nextRetryAt: 'asc' },
        take: 100,
      });
      for (const refund of dueRefunds) {
        try {
          const claim = await this.prisma.refund.updateMany({
            where: { id: refund.id, status: refund.status, nextRetryAt: refund.nextRetryAt },
            data: { status: 'REFUND_PROCESSING', nextRetryAt: processingLeaseExpiresAt },
          });
          if (claim.count === 1) {
            await this.paymentRefundService.recoverScheduledCancellationRefund(refund.id);
          }
        } catch (error: unknown) {
          this.logger.error(
            `Cancellation refund recovery failed for ${refund.id}: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error.stack : undefined,
          );
        }
      }
    } catch (error: unknown) {
      this.logger.error(
        `Cancellation refund recovery sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  @Cron('*/5 * * * *')
  async handleAuthorizationExpiry(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting authorization expiry sweep...');

    const rawExpireMinutes = this.configService.get<number>('PAYMENT_AUTH_EXPIRE_MINUTES', 60);
    const expireMinutes = Number.isFinite(Number(rawExpireMinutes)) ? Number(rawExpireMinutes) : 60;
    const cutoff = new Date(Date.now() - expireMinutes * 60 * 1000);

    let expiredCount = 0;
    let failureCount = 0;

    try {
      const payments = await this.prisma.payment.findMany({
        where: {
          status: PaymentStatus.AUTHORIZED,
          updatedAt: { lt: cutoff },
        },
        include: { bookingIntent: true },
      });

      for (const payment of payments) {
        try {
          if (!hasStripePaymentIntentId(payment)) {
            continue;
          }

          const stripePaymentIntent = await this.stripeService.retrievePaymentIntent(
            payment.stripePaymentIntentId,
          );

          if (stripePaymentIntent.status === 'succeeded') {
            await this.reconcileSucceededAuthorization({
              ...payment,
              userId: payment.bookingIntent.userId,
            });
            this.logger.log(
              `Reconciled succeeded payment ${payment.id} (PI: ${payment.stripePaymentIntentId})`,
            );
            expiredCount++;
            continue;
          }

          enforceTransition(PaymentStatus.AUTHORIZED, PaymentStatus.EXPIRED);

          if (stripePaymentIntent.status !== 'canceled') {
            await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
          }

          await this.expireAuthorization(payment);

          this.logger.log(`Expired payment ${payment.id} (PI: ${payment.stripePaymentIntentId})`);
          expiredCount++;
        } catch (error) {
          failureCount++;
          this.logger.error(
            `Failed to expire payment ${payment.id}: ${(error as Error).message}`,
            (error as Error).stack,
          );
        }
      }

      const duration = Date.now() - start;
      this.logger.log(
        `Authorization expiry sweep completed in ${duration}ms. Expired: ${expiredCount}, Failures: ${failureCount}`,
      );
    } catch (error) {
      this.logger.error(
        `Authorization expiry sweep failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleIdempotencyKeyCleanup(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting idempotency key cleanup...');

    try {
      const result = await this.prisma.idempotencyKey.deleteMany({
        where: {
          expiresAt: { lt: new Date() },
        },
      });

      const duration = Date.now() - start;
      this.logger.log(
        `Idempotency key cleanup completed in ${duration}ms. Deleted: ${result.count}`,
      );
    } catch (error) {
      this.logger.error(
        `Idempotency key cleanup failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  @Cron('*/5 * * * *')
  async handleStaleLockDetection(): Promise<void> {
    const start = Date.now();
    this.logger.log('Starting stale lock detection...');

    const rawTimeout = this.configService.get<string | number>(
      'IDEMPOTENCY_LOCK_TIMEOUT_MINUTES',
      5,
    );
    const parsedMinutes =
      typeof rawTimeout === 'number' ? rawTimeout : parseInt(String(rawTimeout), 10);
    const lockTimeoutMinutes =
      Number.isFinite(parsedMinutes) && parsedMinutes > 0 ? parsedMinutes : 5;
    const lockCutoff = new Date(Date.now() - lockTimeoutMinutes * 60 * 1000);

    try {
      const result = await this.prisma.idempotencyKey.updateMany({
        where: {
          lockedAt: { not: null, lt: lockCutoff },
        },
        data: {
          lockedAt: null,
        },
      });

      const duration = Date.now() - start;
      this.logger.log(`Stale lock detection completed in ${duration}ms. Cleared: ${result.count}`);
    } catch (error) {
      this.logger.error(
        `Stale lock detection failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  private async expireAuthorization(payment: {
    id: string;
    bookingIntentId: string;
    version: number;
    amount: number;
  }): Promise<void> {
    const maxAttempts = this.configService.get<number>('PAYMENT_MAX_ATTEMPTS', 2);

    const newStatus = await this.prisma.$transaction(async (tx) => {
      const bookingIntent = await tx.bookingIntent.findUnique({
        where: { id: payment.bookingIntentId },
        select: { paymentAttemptCount: true },
      });

      if (!bookingIntent) {
        throw new Error(`Booking intent ${payment.bookingIntentId} not found`);
      }

      const newStatus: BookingIntentStatus =
        bookingIntent.paymentAttemptCount >= maxAttempts
          ? BookingIntentStatus.PAYMENT_EXHAUSTED
          : BookingIntentStatus.AWAITING_PAYMENT;

      await tx.payment.update({
        where: { id: payment.id, version: payment.version },
        data: {
          status: PaymentStatus.EXPIRED,
          version: { increment: 1 },
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'authorization.expired',
          previousStatus: PaymentStatus.AUTHORIZED,
          newStatus: PaymentStatus.EXPIRED,
          amount: payment.amount,
          source: PaymentEventSource.CRON,
          createdBy: 'system',
        },
      });

      await tx.bookingIntent.update({
        where: { id: payment.bookingIntentId },
        data: { status: newStatus },
      });

      return newStatus;
    });

    this.logger.log(`Updated booking intent ${payment.bookingIntentId} to ${newStatus}`);
  }

  private async reconcileSucceededAuthorization(payment: {
    id: string;
    bookingIntentId: string;
    stripePaymentIntentId: string;
    version: number;
    amount: number;
    currency: string;
    userId: string;
    stripeCustomerId: string | null;
  }): Promise<void> {
    enforceTransition(PaymentStatus.AUTHORIZED, PaymentStatus.SUCCEEDED);

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id, version: payment.version },
        data: {
          status: PaymentStatus.SUCCEEDED,
          version: { increment: 1 },
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'payment_intent.succeeded',
          previousStatus: PaymentStatus.AUTHORIZED,
          newStatus: PaymentStatus.SUCCEEDED,
          amount: payment.amount,
          source: PaymentEventSource.CRON,
          createdBy: 'system',
          metadata: {
            reconciledBy: 'authorization_expiry_cron',
            stripeStatus: 'succeeded',
          },
        },
      });

      await tx.bookingIntent.update({
        where: { id: payment.bookingIntentId },
        data: { status: BookingIntentStatus.CONFIRMED },
      });

      const existingLedger = await tx.ledgerEntry.findFirst({
        where: { paymentId: payment.id },
      });

      if (!existingLedger) {
        const transactionId = crypto.randomUUID();
        await tx.ledgerEntry.createMany({
          data: [
            {
              paymentId: payment.id,
              transactionId,
              accountId: 'CUSTOMER_RECEIVABLE',
              entryType: 'DEBIT',
              amount: payment.amount,
              currency: payment.currency,
            },
            {
              paymentId: payment.id,
              transactionId,
              accountId: 'PLATFORM_REVENUE',
              entryType: 'CREDIT',
              amount: payment.amount,
              currency: payment.currency,
            },
          ],
        });
      }
    });

    if (payment.stripeCustomerId) {
      try {
        await this.paymentMethodService.saveMethod(
          payment.userId,
          payment.stripeCustomerId,
          payment.stripePaymentIntentId,
        );
      } catch (error: unknown) {
        this.logger.warn(
          `Unable to save payment method for payment ${payment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
