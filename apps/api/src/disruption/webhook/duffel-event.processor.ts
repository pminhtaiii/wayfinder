import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { SupplierSyncService } from '../sync/supplier-sync.service';
import { DuffelProcessorHealthService } from './duffel-processor-health.service';
import { DuffelWebhookEvent, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class DuffelEventProcessor {
  private readonly logger = new Logger(DuffelEventProcessor.name);
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly supplierSyncService: SupplierSyncService,
    private readonly healthService: DuffelProcessorHealthService,
  ) {}

  @Cron('*/10 * * * * *')
  async handleCron(): Promise<void> {
    const isProcessorEnabled = process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR === 'true';
    if (!isProcessorEnabled) {
      return;
    }

    this.healthService.recordHeartbeat();

    if (this.isProcessing) {
      this.logger.debug('Processor is already running a batch, skipping this tick');
      return;
    }

    this.isProcessing = true;
    try {
      await this.processInboxBatch();
    } catch (error) {
      this.logger.error('Error during inbox batch processing', error);
    } finally {
      this.isProcessing = false;
    }
  }

  async processInboxBatch(batchSize = 20): Promise<void> {
    const claimed = await this.claimEvents(batchSize);
    if (claimed.length === 0) return;

    this.logger.log(`Claimed ${claimed.length} events for processing.`);

    await Promise.all(
      claimed.map(async ({ event, token }) => {
        try {
          if (!event.duffelOrderId) {
            throw new Error('DuffelWebhookEvent is missing duffelOrderId');
          }

          const booking = await this.prisma.booking.findFirst({
            where: { supplierOrderId: event.duffelOrderId },
          });

          if (!booking) {
            throw new Error(`No booking found with duffelOrderId ${event.duffelOrderId}`);
          }

          const result = await this.supplierSyncService.syncBooking(
            booking.id,
            'WEBHOOK',
            event.supplierEventId,
          );

          if (result.status === 'SKIPPED_LOCKED') {
            await this.handleLockConflict(event.id, token);
            return;
          }

          await this.handleSuccess(event.id, token);
          this.healthService.recordSuccess();
        } catch (error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.logger.error(
            JSON.stringify({
              message: `Failed to process event ${event.id}`,
              duffelEventId: event.supplierEventId,
              inboxEventId: event.id,
              eventType: event.eventType,
              status: 'FAILED',
              attempt: event.attempts,
              errorClass: err.name || 'Error',
              error: err.message,
            }),
          );
          if (err.stack) {
            this.logger.error(err.stack);
          }
          await this.handleFailure(event.id, token, err, event.attempts);
        }
      }),
    );
  }

  async claimEvents(batchSize: number): Promise<{ event: DuffelWebhookEvent; token: string }[]> {
    const now = new Date();
    const leaseDurationMs = 5 * 60 * 1000;
    const staleCutoff = new Date(now.getTime() - leaseDurationMs);

    const candidates = await this.prisma.duffelWebhookEvent.findMany({
      where: {
        OR: [
          {
            status: { in: ['PENDING', 'RETRY_SCHEDULED'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          {
            status: 'PROCESSING',
            processingStartedAt: { lt: staleCutoff },
          },
        ],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: batchSize * 2,
    });

    const claimed: { event: DuffelWebhookEvent; token: string }[] = [];

    for (const candidate of candidates) {
      if (claimed.length >= batchSize) break;

      const token = crypto.randomUUID();

      const updateResult = await this.prisma.duffelWebhookEvent.updateMany({
        where: {
          id: candidate.id,
          OR: [
            {
              status: candidate.status,
              processingToken: candidate.processingToken,
            },
            {
              status: 'PROCESSING',
              processingStartedAt: candidate.processingStartedAt,
              processingToken: candidate.processingToken,
            },
          ],
        },
        data: {
          status: 'PROCESSING',
          processingStartedAt: now,
          processingToken: token,
          attempts: { increment: 1 },
        },
      });

      if (updateResult.count > 0) {
        const updatedEvent = await this.prisma.duffelWebhookEvent.findUnique({
          where: { id: candidate.id },
        });
        if (updatedEvent) {
          claimed.push({ event: updatedEvent, token });
        }
      }
    }

    return claimed;
  }

  async handleLockConflict(eventId: string, token: string): Promise<void> {
    const now = new Date();
    await this.prisma.duffelWebhookEvent.updateMany({
      where: { id: eventId, processingToken: token },
      data: {
        status: 'RETRY_SCHEDULED',
        nextAttemptAt: new Date(now.getTime() + 1 * 60 * 1000),
        processingToken: null,
        processingStartedAt: null,
        attempts: { decrement: 1 },
      },
    });
  }

  async handleSuccess(eventId: string, token: string): Promise<void> {
    const now = new Date();
    const result = await this.prisma.duffelWebhookEvent.updateMany({
      where: { id: eventId, processingToken: token },
      data: {
        status: 'PROCESSED',
        processedAt: now,
        processingToken: null,
        processingStartedAt: null,
      },
    });

    if (result.count > 0) {
      const event = await this.prisma.duffelWebhookEvent.findUnique({ where: { id: eventId } });
      if (event) {
        this.logger.log(
          JSON.stringify({
            message: `Event processed successfully`,
            duffelEventId: event.supplierEventId,
            inboxEventId: event.id,
            eventType: event.eventType,
            status: event.status,
            attempt: event.attempts,
          }),
        );
      }
    }
  }

  async handleFailure(
    eventId: string,
    token: string,
    error: Error,
    attempts: number,
  ): Promise<void> {
    const nextMinutes = this.getRetryDelayMinutes(attempts);
    const now = new Date();

    if (nextMinutes !== null) {
      const nextAttemptAt = new Date(now.getTime() + nextMinutes * 60 * 1000);
      const result = await this.prisma.duffelWebhookEvent.updateMany({
        where: { id: eventId, processingToken: token },
        data: {
          status: 'RETRY_SCHEDULED',
          nextAttemptAt,
          processingToken: null,
          processingStartedAt: null,
          lastErrorCode: error.name || 'UNKNOWN_ERROR',
          lastErrorAt: now,
        },
      });

      if (result.count > 0) {
        const event = await this.prisma.duffelWebhookEvent.findUnique({ where: { id: eventId } });
        if (event) {
          this.logger.warn(
            JSON.stringify({
              message: `Event processing failed, scheduled retry`,
              duffelEventId: event.supplierEventId,
              inboxEventId: event.id,
              eventType: event.eventType,
              status: event.status,
              attempt: event.attempts,
              retryTimestamp: nextAttemptAt.toISOString(),
            }),
          );
        }
      }
    } else {
      const result = await this.prisma.duffelWebhookEvent.updateMany({
        where: { id: eventId, processingToken: token },
        data: {
          status: 'FAILED_NEEDS_ATTENTION',
          nextAttemptAt: null,
          processingToken: null,
          processingStartedAt: null,
          lastErrorCode: error.name || 'UNKNOWN_ERROR',
          lastErrorAt: now,
        },
      });

      if (result.count > 0) {
        const event = await this.prisma.duffelWebhookEvent.findUnique({ where: { id: eventId } });
        if (event) {
          this.logger.error(
            JSON.stringify({
              message: `Event processing failed permanently, escalated to FAILED_NEEDS_ATTENTION`,
              duffelEventId: event.supplierEventId,
              inboxEventId: event.id,
              eventType: event.eventType,
              status: event.status,
              attempt: event.attempts,
            }),
          );
        }
      }
    }
  }

  getRetryDelayMinutes(attempts: number): number | null {
    if (attempts === 1) return 1;
    if (attempts === 2) return 5;
    if (attempts === 3) return 15;
    if (attempts === 4) return 15;
    return null;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleRetentionRedaction(): Promise<void> {
    const isRedactionEnabled = process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR === 'true';
    if (!isRedactionEnabled) {
      return;
    }

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);

    this.logger.log(
      `Starting raw payload redaction cleanup for events older than ${cutoff.toISOString()}`,
    );

    try {
      const result = await this.prisma.duffelWebhookEvent.updateMany({
        where: {
          createdAt: { lt: cutoff },
          payloadRedactedAt: null,
          rawPayload: { not: Prisma.DbNull },
        },
        data: {
          rawPayload: Prisma.DbNull,
          payloadRedactedAt: new Date(),
        },
      });

      this.logger.log(`Successfully redacted raw payloads for ${result.count} events.`);
    } catch (error) {
      this.logger.error('Failed to run raw payload redaction cleanup', error);
    }
  }
}
