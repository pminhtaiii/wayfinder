import { randomUUID } from 'crypto';
import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BookingFailureReason,
  BookingStatus,
  PaymentEventSource,
  PaymentStatus,
  Prisma,
  RefundStatus,
  RefundTriggerType,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import type { PassengerEnrichmentInput } from '@/payment-fulfillment/ports';
import { RefundTransactionService } from '@/refund/refund-transaction.service';
import { RefundSettlementService } from '@/refund-settlement/refund-settlement.service';
import { CacheService } from '@/cache/cache.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingWithRelations } from './booking-lifecycle.types';
import { BookingEventPublisherService, TransactionEventContext } from '@/domain-events';

const STALE_THRESHOLD_MS = 15 * 60 * 1000;

const BOOKING_RECOVERY_INCLUDE = {
  payment: {
    include: {
      ancillarySelection: {
        include: {
          seatSelections: true,
          baggageSelections: true,
        },
      },
    },
  },
  bookingIntent: {
    include: {
      passengers: true,
    },
  },
  activeDisruptionRevision: {
    include: {
      segments: { orderBy: { globalOrder: 'asc' } },
      notificationOutbox: true,
    },
  },
  itineraryRevisions: {
    orderBy: { version: 'desc' },
    take: 1,
    include: { segments: { orderBy: { globalOrder: 'asc' } } },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSupplierOrderId(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string' && value.id.trim().length > 0) return value.id;
  if (!isRecord(value.data)) return null;
  return typeof value.data.id === 'string' && value.data.id.trim().length > 0
    ? value.data.id
    : null;
}

@Injectable()
export class BookingRecoveryService {
  private readonly logger = new Logger(BookingRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly duffelCancellationService: DuffelCancellationService,
    private readonly duffelRecoveryService: DuffelRecoveryService,
    private readonly refundTransactionService: RefundTransactionService,
    private readonly refundSettlementService: RefundSettlementService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    private readonly cacheService: CacheService,
    @Optional() private readonly publisher?: BookingEventPublisherService,
  ) {}

  @OnEvent('booking.reconciliation.requested', { async: true })
  async handleReconciliationRequested(event: { bookingId: string }): Promise<void> {
    if (!event?.bookingId) return;
    await this.reconcileBookingWithLock(event.bookingId);
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweepStaleBookings(): Promise<void> {
    this.logger.log('Running stale PROCESSING bookings sweeper');
    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
    const staleBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.PROCESSING,
        createdAt: { lte: staleThreshold },
      },
    });

    for (const booking of staleBookings) {
      await this.reconcileBookingWithLock(booking.id);
    }
  }

  private async reconcileBookingWithLock(bookingId: string): Promise<void> {
    try {
      const token = randomUUID();
      const lockKey = 'booking:recon:lock:' + bookingId;
      const acquired = await this.cacheService.acquireLock(lockKey, token, 300);
      if (!acquired) {
        this.logger.log(
          `Reconciliation lock collision for booking ${bookingId}; skipping attempt.`,
        );
        return;
      }

      try {
        const deferKey = `booking:recovery:defer:${bookingId}`;
        if ((await this.cacheService.getTtl(deferKey)) > 0) {
          this.logger.log(
            `Booking ${bookingId} is deferred from stale recovery until its retry time; skipping.`,
          );
          return;
        }

        const booking = await this.prisma.booking.findUnique({
          where: { id: bookingId },
          include: BOOKING_RECOVERY_INCLUDE,
        });

        if (!booking) {
          this.logger.warn(`Booking ${bookingId} not found during locked reconciliation; skipping.`);
          return;
        }

        const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
        if (booking.status !== BookingStatus.PROCESSING || booking.createdAt > staleThreshold) {
          this.logger.log(
            `Booking ${bookingId} is not eligible for stale processing recovery (status: ${booking.status}); skipping.`,
          );
          return;
        }

        await this.reconcileBookingIfStale(booking as unknown as BookingWithRelations, {
          lockKey,
          token,
        });
      } finally {
        await this.cacheService.releaseLock(lockKey, token);
      }
    } catch (e: unknown) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.logger.error(
        `[reconcileBookingWithLock] Error during locked reconciliation for booking ${bookingId}: ${error.message}`,
        error.stack,
      );
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async sweepUncompletedBookings(): Promise<void> {
    this.logger.log('Running CONFIRMED -> COMPLETED bookings sweeper');
    const pastBookings = await this.prisma.booking.findMany({
      where: {
        status: BookingStatus.CONFIRMED,
        departureAt: { lte: new Date() },
      },
      include: {
        payment: {
          include: {
            ancillarySelection: {
              include: {
                seatSelections: true,
                baggageSelections: true,
              },
            },
          },
        },
        bookingIntent: {
          include: {
            passengers: true,
          },
        },
        activeDisruptionRevision: {
          include: {
            segments: { orderBy: { globalOrder: 'asc' } },
            notificationOutbox: true,
          },
        },
        itineraryRevisions: {
          orderBy: { version: 'desc' },
          take: 1,
          include: { segments: { orderBy: { globalOrder: 'asc' } } },
        },
      },
    });

    for (const booking of pastBookings) {
      try {
        await this.bookingLifecycleService.checkAndCompleteBooking(
          booking as unknown as BookingWithRelations,
        );
      } catch (e: unknown) {
        const error = e instanceof Error ? e : new Error(String(e));
        this.logger.error(`Failed to complete booking ${booking.id}: ${error.message}`, error.stack);
      }
    }
  }

  async reconcileBookingIfStale(
    booking: BookingWithRelations,
    lockContext?: { lockKey: string; token: string },
  ): Promise<BookingWithRelations> {
    if (booking.status !== BookingStatus.PROCESSING) return booking;

    const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
    if (booking.createdAt > staleThreshold) {
      return booking;
    }

    if (lockContext) {
      const stillOwned = await this.cacheService.renewLock(
        lockContext.lockKey,
        lockContext.token,
        300,
      );
      if (!stillOwned) {
        this.logger.warn(
          `Reconciliation lock lease lost or expired for booking ${booking.id} (${lockContext.lockKey}); aborting stale reconciliation.`,
        );
        return booking;
      }
    }

    try {
      const withTimeout = <T>(promise: Promise<T>, ms = 3000): Promise<T> => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Timeout')), ms);
        });
        return Promise.race([promise, timeoutPromise]).finally(() => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
        });
      };

      if (!booking.payment?.stripePaymentIntentId) {
        let eventContext: TransactionEventContext | undefined;
        let didTransition = false;
        await this.prisma.$transaction(async (tx) => {
          eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
          await this.bookingLifecycleService.failBooking(
            booking.id,
            BookingFailureReason.BOOKING_TIMEOUT,
            undefined,
            undefined,
            undefined,
            tx,
            eventContext,
          );
          didTransition = (eventContext?.events.length ?? 0) > 0;
        });

        if (didTransition) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = BookingFailureReason.BOOKING_TIMEOUT;

          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            await this.publisher.publish(eventContext.events);
          }
        }
        return booking;
      }

      const payment = booking.payment;
      const intent = await withTimeout(
        this.stripeService.retrievePaymentIntent(payment.stripePaymentIntentId),
      );
      if (intent.status !== 'succeeded') {
        const isPaymentAlreadyCancelledOrRefunded =
          payment.status === 'CANCELLED' || payment.status === 'REFUNDED';
        const deferRecovery = async (retryAt: string, retryAfterSeconds: number): Promise<void> => {
          try {
            await this.cacheService.set(
              `booking:recovery:defer:${booking.id}`,
              retryAt,
              retryAfterSeconds,
            );
          } catch (deferError: unknown) {
            const deferErr =
              deferError instanceof Error ? deferError : new Error(String(deferError));
            this.logger.error(
              `Failed to defer stale booking ${booking.id} after unconfirmed cancellation: ${deferErr.message}`,
              deferErr.stack,
            );
          }
        };

        try {
          const duffelCancelledEvent = await this.prisma.paymentEvent.findFirst({
            where: { paymentId: payment.id, eventType: 'duffel_order_cancelled' },
          });
          if (!duffelCancelledEvent) {
            const duffelEvent = await this.prisma.paymentEvent.findFirst({
              where: { paymentId: payment.id, eventType: 'duffel_order_created' },
              orderBy: { createdAt: 'desc' },
            });
            const supplierOrderId = readSupplierOrderId(duffelEvent?.metadata);
            if (duffelEvent && !supplierOrderId) {
              const retryAfterSeconds = 300;
              await deferRecovery(
                new Date(Date.now() + retryAfterSeconds * 1000).toISOString(),
                retryAfterSeconds,
              );
              return booking;
            }
            if (supplierOrderId) {
              let cancellationConfirmed = false;
              try {
                const cancellation =
                  await this.duffelCancellationService.cancelOrder(supplierOrderId);
                const pendingStatus = cancellation.status?.trim().toLowerCase() === 'pending';
                if (!cancellation.success || pendingStatus) {
                  throw new Error('Duffel order cancellation is not confirmed');
                }
                this.logger.log(
                  `Successfully cancelled orphaned Duffel order ${supplierOrderId} during stale booking sweep.`,
                );
                cancellationConfirmed = true;
              } catch (cancelError: unknown) {
                const err =
                  cancelError instanceof Error ? cancelError : new Error(String(cancelError));
                this.logger.error(
                  `Duffel order cancellation failed during stale booking sweep: ${err.message}`,
                  err.stack,
                );
                let retryAfterSeconds = 300;
                let retryAt = new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
                if (
                  cancelError instanceof HttpException &&
                  cancelError.getStatus() === HttpStatus.TOO_MANY_REQUESTS
                ) {
                  const response = cancelError.getResponse();
                  if (
                    typeof response === 'object' &&
                    response !== null &&
                    'code' in response &&
                    (response.code === 'RATE_LIMIT_EXCEEDED' ||
                      response.code === 'BUDGET_UNAVAILABLE') &&
                    'retryAfterSeconds' in response &&
                    typeof response.retryAfterSeconds === 'number' &&
                    Number.isInteger(response.retryAfterSeconds) &&
                    response.retryAfterSeconds > 0
                  ) {
                    retryAfterSeconds = response.retryAfterSeconds;
                    retryAt =
                      'resetAt' in response &&
                      typeof response.resetAt === 'string' &&
                      !Number.isNaN(Date.parse(response.resetAt))
                        ? new Date(response.resetAt).toISOString()
                        : new Date(Date.now() + retryAfterSeconds * 1000).toISOString();
                  }
                }
                await deferRecovery(retryAt, retryAfterSeconds);
                return booking;
              }

              if (cancellationConfirmed) {
                await this.prisma.paymentEvent.create({
                  data: {
                    paymentId: payment.id,
                    eventType: 'duffel_order_cancelled',
                    previousStatus: payment.status ?? PaymentStatus.AUTHORIZED,
                    newStatus: payment.status ?? PaymentStatus.AUTHORIZED,
                    source: PaymentEventSource.SYSTEM,
                    createdBy: 'system',
                    metadata: { duffelOrderId: supplierOrderId },
                  },
                });
              }
            }
          }
        } catch (duffelLookupError: unknown) {
          const err =
            duffelLookupError instanceof Error
              ? duffelLookupError
              : new Error(String(duffelLookupError));
          this.logger.error(
            `Duffel order cancellation failed during stale booking sweep: ${err.message}`,
            err.stack,
          );
          return booking;
        }

        // Release the Stripe authorization hold (cancel intent)
        if (!isPaymentAlreadyCancelledOrRefunded && intent.status !== 'canceled') {
          try {
            await this.stripeService.cancelPaymentIntent(payment.stripePaymentIntentId);
            this.logger.log(
              `Successfully cancelled Stripe PaymentIntent ${payment.stripePaymentIntentId} during stale booking sweep.`,
            );
          } catch (stripeCancelError: unknown) {
            const err =
              stripeCancelError instanceof Error
                ? stripeCancelError
                : new Error(String(stripeCancelError));
            this.logger.error(
              `Stripe cancelPaymentIntent failed during stale booking sweep: ${err.message}`,
              err.stack,
            );
          }
        }

        let eventContext: TransactionEventContext | undefined;
        let didTransition = false;
        await this.prisma.$transaction(async (tx) => {
          eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
          await this.bookingLifecycleService.failBooking(
            booking.id,
            BookingFailureReason.CAPTURE_FAILED,
            undefined,
            undefined,
            undefined,
            tx,
            eventContext,
          );
          didTransition = (eventContext?.events.length ?? 0) > 0;
          if (didTransition) {
            await tx.payment.updateMany({
              where: { id: payment.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
              data: { status: 'CANCELLED' },
            });
          }
        });

        if (didTransition) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = BookingFailureReason.CAPTURE_FAILED;

          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            await this.publisher.publish(eventContext.events);
          }
        }
        return booking;
      }

      const duffelEvent = await this.prisma.paymentEvent.findFirst({
        where: { paymentId: payment.id, eventType: 'duffel_order_created' },
        orderBy: { createdAt: 'desc' },
      });

      const rawOrder: unknown = duffelEvent?.metadata;
      if (isRecord(rawOrder) && typeof rawOrder.id === 'string') {
        const bookingIntent = await this.prisma.bookingIntent.findUnique({
          where: { id: booking.bookingIntentId },
          include: { passengers: true, user: true },
        });
        const passengerEnrichment: PassengerEnrichmentInput[] | undefined =
          bookingIntent && bookingIntent.user
            ? bookingIntent.passengers.map((passenger) => {
                const dateOfBirth = passenger.dateOfBirth;
                return {
                  id: passenger.supplierPassengerId ?? undefined,
                  firstName: passenger.givenName,
                  lastName: passenger.familyName,
                  dateOfBirth: Number.isNaN(dateOfBirth.getTime())
                    ? undefined
                    : dateOfBirth.toISOString().slice(0, 10),
                };
              })
            : undefined;

        const { flightSnapshot, passengerSnapshot } =
          this.duffelRecoveryService.mapOrderToSnapshots(
            rawOrder,
            passengerEnrichment,
            bookingIntent?.user?.email,
          );
        const orderRecord = rawOrder;
        const bookingReference =
          typeof orderRecord.booking_reference === 'string' ? orderRecord.booking_reference : null;
        const supplierOrderId =
          typeof orderRecord.id === 'string' ? orderRecord.id : rawOrder.id;
        // The lifecycle method persists a nullable PNR but retains a legacy string parameter type.
        const lifecycleBookingReference = bookingReference as unknown as string;
        const departureAt = flightSnapshot.segments?.[0]?.departureAt
          ? new Date(flightSnapshot.segments[0].departureAt)
          : null;

        let eventContext: TransactionEventContext | undefined;
        let didTransition = false;
        await this.prisma.$transaction(async (tx) => {
          eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
          await this.bookingLifecycleService.confirmBooking(
            booking.id,
            lifecycleBookingReference,
            supplierOrderId,
            flightSnapshot,
            passengerSnapshot,
            tx,
            eventContext,
          );
          didTransition = (eventContext?.events.length ?? 0) > 0;
          if (didTransition) {
            await tx.payment.updateMany({
              where: {
                id: payment.id,
                status: { notIn: ['SUCCEEDED', 'REFUNDED', 'CANCELLED'] },
              },
              data: { status: 'SUCCEEDED' },
            });
          }
        });

        if (didTransition) {
          booking.status = BookingStatus.CONFIRMED;
          booking.pnrReference = bookingReference;
          booking.supplierOrderId = supplierOrderId;
          booking.flightSnapshot = flightSnapshot as unknown as Prisma.JsonValue;
          booking.passengerSnapshot = passengerSnapshot as unknown as Prisma.JsonValue;
          booking.departureAt = departureAt;

          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            await this.publisher.publish(eventContext.events);
          }
        }
      } else {
        let eventContext: TransactionEventContext | undefined;
        let didTransition = false;
        await this.prisma.$transaction(async (tx) => {
          eventContext = this.publisher ? this.publisher.createContext(tx) : { tx, events: [] };
          await this.bookingLifecycleService.failBooking(
            booking.id,
            BookingFailureReason.SYSTEM_ERROR,
            undefined,
            undefined,
            undefined,
            tx,
            eventContext,
          );
          didTransition = (eventContext?.events.length ?? 0) > 0;
        });

        if (didTransition) {
          booking.status = BookingStatus.FAILED;
          booking.failureReason = BookingFailureReason.SYSTEM_ERROR;

          if (eventContext && eventContext.events.length > 0 && this.publisher) {
            await this.publisher.publish(eventContext.events);
          }

          try {
            await withTimeout(
              this.triggerAutomatedRefund(
                payment.id,
                'Stale processing booking timeout without duffel order',
              ),
            );
          } catch (e: unknown) {
            const err = e instanceof Error ? e : new Error(String(e));
            this.logger.error(
              `CRITICAL: Automated refund failed during stale booking reconciliation for payment ${payment.id}: ${err.message}`,
              err.stack,
            );
          }
        }
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.logger.error(
        `Error during stale booking reconciliation for ${booking.id}: ${err.message}`,
        err.stack,
      );
      throw e;
    }
    return booking;
  }

  private async triggerAutomatedRefund(paymentId: string, reason: string): Promise<void> {
    const idempotencyKey = `refund:${paymentId}:${reason}:1`;

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      this.logger.warn(`Payment ${paymentId} not found for automated refund`);
      return;
    }

    const succeededRefunds = await this.prisma.refund.findMany({
      where: { paymentId, status: RefundStatus.SUCCEEDED },
      select: { amount: true },
    });

    const totalRefunded = succeededRefunds.reduce((sum, r) => sum + r.amount, 0);
    const refundableAmount = payment.amount - totalRefunded;

    if (refundableAmount <= 0) {
      this.logger.warn(`No refundable amount remaining for payment ${paymentId}`);
      return;
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
      return;
    }

    let stripeRefund: { id: string };
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

    await this.refundSettlementService.settleVerifiedOutcome({
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
  }

  private toSafeStripeErrorCode(error: unknown): string {
    if (typeof error !== 'object' || error === null) return 'STRIPE_UNKNOWN_ERROR';
    const candidate = error as { statusCode?: unknown; code?: unknown };
    if (typeof candidate.code === 'string' && /^[A-Z0-9_:-]{1,80}$/.test(candidate.code))
      return candidate.code;
    if (typeof candidate.statusCode === 'number') return `HTTP_${candidate.statusCode}`;
    return 'STRIPE_UNKNOWN_ERROR';
  }
}
