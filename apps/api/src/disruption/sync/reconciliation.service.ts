import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService } from './supplier-sync.service';
import { CacheService } from '@/cache/cache.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingWithRelations } from '@/booking-lifecycle/booking-lifecycle.types';

export interface ReconciliationResult {
  selected: number;
  processed: number;
  unchanged: number;
  changed: number;
  failed: number;
  deferred: number;
  stale: number;
  budgetBlocked: number;
}

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supplierSyncService: SupplierSyncService,
    private readonly cacheService: CacheService,
    private readonly bookingLifecycleService: BookingLifecycleService,
  ) {}

  @Cron(process.env.DUFFEL_RECONCILIATION_CRON || '*/30 * * * *')
  async handleCron(): Promise<void> {
    const isReconciliationEnabled = process.env.FEATURE_FLAG_DISRUPTION_RECONCILIATION === 'true';
    if (!isReconciliationEnabled) {
      return;
    }

    this.logger.log('Starting reconciliation cron job...');
    try {
      const result = await this.reconcile();
      this.logger.log(`Reconciliation cron complete. Result: ${JSON.stringify(result)}`);
    } catch (error) {
      this.logger.error('Error occurred during reconciliation cron execution:', error);
    }
  }

  async reconcile(): Promise<ReconciliationResult> {
    const now = new Date();
    const seventyTwoHoursLater = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);
    const batchSize = Number(process.env.DUFFEL_RECONCILIATION_BATCH_SIZE || 20);

    // 1. Complete stale bookings that have passed their final arrival
    const staleBookings = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        OR: [
          { currentFinalArrivalAt: { lte: now } },
          {
            AND: [{ currentFinalArrivalAt: null }, { departureAt: { lte: now } }],
          },
        ],
      },
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, supplierOfferId: true } },
      },
    });

    let stale = 0;
    for (const booking of staleBookings) {
      try {
        const completedBooking = await this.bookingLifecycleService.checkAndCompleteBooking(
          booking as BookingWithRelations,
        );
        if (completedBooking.status === 'COMPLETED') {
          stale++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to process completion for booking ${booking.id}: ${msg}`);
      }
    }

    // 2. Fetch eligible bookings for sync
    const eligibleBookings = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        supplierOrderId: { not: null },
        nextUnflownDepartureAt: {
          gt: now,
          lte: seventyTwoHoursLater,
        },
        AND: [
          {
            OR: [{ nextSupplierSyncAt: null }, { nextSupplierSyncAt: { lte: now } }],
          },
          {
            OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: fiveMinutesAgo } }],
          },
        ],
      },
      take: batchSize,
      orderBy: [
        { lastSupplierSyncedAt: { sort: 'asc', nulls: 'first' } },
        { nextUnflownDepartureAt: 'asc' },
        { id: 'asc' },
      ],
    });

    const selected = eligibleBookings.length;
    let processed = 0;
    let unchanged = 0;
    let changed = 0;
    let failed = 0;
    let deferred = 0;
    let budgetBlocked = 0;

    this.logger.log(`Selected ${selected} bookings for reconciliation.`);

    for (const booking of eligibleBookings) {
      try {
        const result = await this.supplierSyncService.syncBooking(booking.id, 'RECONCILIATION');

        if (result.status === 'SKIPPED_LOCKED' || result.status === 'SKIPPED_INELIGIBLE') {
          deferred++;
        } else {
          if (result.status === 'REVISION_CREATED') {
            changed++;
          } else {
            unchanged++;
          }
          processed++;

          // Clear failures on success
          await this.cacheService.del(`reconciliation:failures:${booking.id}`);
        }

        this.logger.log(
          JSON.stringify({
            message: 'Reconciliation sync completed for booking.',
            bookingId: booking.id,
            status: result.status,
            metric: 'reconciliation_success',
          }),
        );
      } catch (error: unknown) {
        if (this.isBudgetBlockedError(error)) {
          await this.prisma.booking.updateMany({
            where: { id: booking.id },
            data: { syncLockedAt: null, syncLockToken: null },
          });
          this.logger.warn(
            JSON.stringify({
              message: 'Duffel budget capacity reached. Deferring reconciliation.',
              bookingId: booking.id,
              metric: 'budget_blocked',
            }),
          );
          budgetBlocked++;
          continue;
        }

        failed++;
        const err = error instanceof Error ? error : new Error(String(error));

        // Exponential backoff setup
        const failureKey = `reconciliation:failures:${booking.id}`;
        const currentFailuresStr = await this.cacheService.get(failureKey);
        const currentFailures = currentFailuresStr ? parseInt(currentFailuresStr, 10) : 0;
        const newFailures = currentFailures + 1;

        await this.cacheService.set(failureKey, String(newFailures), 48 * 60 * 60);

        const backoffMinutes = 15 * Math.pow(2, newFailures - 1);
        const nextSyncAt = new Date(Date.now() + backoffMinutes * 60 * 1000);

        await this.prisma.booking.updateMany({
          where: { id: booking.id },
          data: {
            nextSupplierSyncAt: nextSyncAt,
            syncLockedAt: null,
            syncLockToken: null,
          },
        });

        this.logger.error(
          JSON.stringify({
            message: 'Reconciliation sync failed for booking.',
            bookingId: booking.id,
            error: err.message,
            nextSupplierSyncAt: nextSyncAt.toISOString(),
            metric: 'reconciliation_failure',
          }),
          err.stack,
        );
      }
    }

    const summary = {
      selected,
      processed,
      unchanged,
      changed,
      failed,
      deferred,
      stale,
      budgetBlocked,
    };
    this.logger.log(`Reconciliation run summary: ${JSON.stringify(summary)}`);
    return summary;
  }

  private isBudgetBlockedError(error: unknown): boolean {
    const rateLimitCodes = new Set([
      'RATE_LIMIT_EXCEEDED',
      'UPSTREAM_RATE_LIMITED',
      'BUDGET_EXHAUSTED',
      'BUDGET_UNAVAILABLE',
      'UPSTREAM_UNAVAILABLE',
    ]);

    if (error instanceof HttpException) {
      if (error.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        return true;
      }
      const response = error.getResponse();
      if (typeof response === 'object' && response !== null && 'code' in response) {
        return rateLimitCodes.has(String((response as Record<string, unknown>).code));
      }
    }

    if (typeof error === 'object' && error !== null) {
      const err = error as Record<string, unknown>;
      if (err.status === 429 || err.statusCode === 429) {
        return true;
      }
      if (typeof err.code === 'string' && rateLimitCodes.has(err.code)) {
        return true;
      }
      if (typeof err.response === 'object' && err.response !== null && 'code' in err.response) {
        return rateLimitCodes.has(String((err.response as Record<string, unknown>).code));
      }
    }

    return false;
  }
}
