import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { SyncClaimService } from './sync-claim.service';
import { BookingEventPublisherService } from '@/domain-events/booking-event-publisher.service';
import { BookingDisruptionSyncedEvent } from '@/domain-events/booking.events';
import { PublishableEvent } from '@/domain-events';
import {
  normalizeDuffelOrder,
  normalizeFlightSegments,
  NormalizedSegment,
} from '../domain/itinerary-normalizer';

import { generateItineraryFingerprint } from '../domain/itinerary-fingerprint';
import { computeItineraryDiff } from '../domain/itinerary-diff';
import { classifyMateriality } from '../domain/materiality-classifier';
import { ItineraryRevisionSource, DisruptionStatus, BookingStatus, Prisma } from '@prisma/client';
import { FlightSegmentSnapshot } from '@shared/booking-types';
import { MaterialDisruptionReason, MaterialBaseline } from '@shared/disruption-types';
import * as crypto from 'crypto';
import { randomUUID } from 'crypto';

export type SyncResult =
  | { status: 'NO_CHANGE' }
  | { status: 'REVISION_CREATED'; revisionId: string }
  | { status: 'SKIPPED_INELIGIBLE' }
  | { status: 'SKIPPED_LOCKED' }
  | { status: 'CONVERGED_DUPLICATE' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface DbSegment {
  sliceOrder: number;
  segmentOrder: number;
  globalOrder: number;
  supplierSegmentId: string | null;
  marketingCarrierIata: string;
  operatingCarrierIata: string | null;
  airlineName: string;
  flightNumber: string;
  departureAirportIata: string;
  departureAirportName: string;
  departureCity: string;
  departureTerminal: string | null;
  departureAt: Date | string;
  departureLocalDate: Date | string;
  arrivalAirportIata: string;
  arrivalAirportName: string;
  arrivalCity: string;
  arrivalTerminal: string | null;
  arrivalAt: Date | string;
  arrivalLocalDate: Date | string;
  durationMinutes: number;
  aircraftType: string | null;
}

function mapDbSegmentToNormalized(dbSeg: DbSegment): NormalizedSegment {
  return {
    sliceOrder: dbSeg.sliceOrder,
    segmentOrder: dbSeg.segmentOrder,
    globalOrder: dbSeg.globalOrder,
    supplierSegmentId: dbSeg.supplierSegmentId,
    marketingCarrierIata: dbSeg.marketingCarrierIata,
    operatingCarrierIata: dbSeg.operatingCarrierIata,
    airlineName: dbSeg.airlineName,
    flightNumber: dbSeg.flightNumber,
    departureAirportIata: dbSeg.departureAirportIata,
    departureAirportName: dbSeg.departureAirportName,
    departureCity: dbSeg.departureCity,
    departureTerminal: dbSeg.departureTerminal,
    departureAt:
      dbSeg.departureAt instanceof Date ? dbSeg.departureAt.toISOString() : dbSeg.departureAt,
    departureLocalDate:
      dbSeg.departureLocalDate instanceof Date
        ? dbSeg.departureLocalDate.toISOString().split('T')[0]
        : dbSeg.departureLocalDate,
    arrivalAirportIata: dbSeg.arrivalAirportIata,
    arrivalAirportName: dbSeg.arrivalAirportName,
    arrivalCity: dbSeg.arrivalCity,
    arrivalTerminal: dbSeg.arrivalTerminal,
    arrivalAt: dbSeg.arrivalAt instanceof Date ? dbSeg.arrivalAt.toISOString() : dbSeg.arrivalAt,
    arrivalLocalDate:
      dbSeg.arrivalLocalDate instanceof Date
        ? dbSeg.arrivalLocalDate.toISOString().split('T')[0]
        : dbSeg.arrivalLocalDate,
    durationMinutes: dbSeg.durationMinutes,
    aircraftType: dbSeg.aircraftType,
  };
}

function calculateTimingFields(segments: NormalizedSegment[]) {
  if (segments.length === 0) {
    return {
      currentDepartureAt: null,
      nextUnflownDepartureAt: null,
      currentFinalArrivalAt: null,
    };
  }

  const sorted = [...segments].sort((a, b) => a.globalOrder - b.globalOrder);
  const firstSegment = sorted[0];
  const lastSegment = sorted[sorted.length - 1];

  const currentDepartureAt = new Date(firstSegment.departureAt);
  const currentFinalArrivalAt = new Date(lastSegment.arrivalAt);

  const now = new Date();
  const nextUnflownSegment = sorted.find((seg) => new Date(seg.departureAt) > now);
  const nextUnflownDepartureAt = nextUnflownSegment
    ? new Date(nextUnflownSegment.departureAt)
    : null;

  return {
    currentDepartureAt,
    nextUnflownDepartureAt,
    currentFinalArrivalAt,
  };
}

@Injectable()
export class SupplierSyncService {
  private readonly logger = new Logger(SupplierSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duffelRecoveryService: DuffelRecoveryService,
    private readonly syncClaimService: SyncClaimService,
    private readonly publisher: BookingEventPublisherService,
  ) {}

  /**
   * Authoritative supplier synchronization transaction.
   * Compares the latest supplier order against database state.
   */
  async syncBooking(
    bookingId: string,
    source: ItineraryRevisionSource,
    sourceEventId?: string,
  ): Promise<SyncResult> {
    const correlationId =
      sourceEventId ||
      `sync-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(7)}`;
    this.logger.log(
      `Starting sync for booking ${bookingId} with correlation ${correlationId} and source ${source}`,
    );

    // 1. Acquire Claim Lock
    const token = await this.syncClaimService.acquireClaim(bookingId);
    if (!token) {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true, supplierOrderId: true },
      });

      if (!booking || booking.status !== 'CONFIRMED' || !booking.supplierOrderId) {
        this.logger.warn(
          `Failed to acquire lock for booking ${bookingId} (permanently ineligible: status=${booking?.status}). Correlation: ${correlationId}`,
        );
        return { status: 'SKIPPED_INELIGIBLE' };
      }

      this.logger.warn(
        `Failed to acquire lock for booking ${bookingId} (transient lock conflict). Correlation: ${correlationId}`,
      );
      return { status: 'SKIPPED_LOCKED' };
    }

    try {
      // 2. Fetch Booking for Order ID
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: true },
          },
        },
      });

      if (!booking || booking.status !== 'CONFIRMED' || !booking.supplierOrderId) {
        this.logger.warn(
          `Booking ${bookingId} is not eligible for synchronization. Status: ${booking?.status}. Correlation: ${correlationId}`,
        );
        await this.syncClaimService.releaseClaim(bookingId, token);
        return { status: 'SKIPPED_INELIGIBLE' };
      }

      // 3. Fetch Full Duffel Order outside the transaction
      const order = await this.duffelRecoveryService.retrieveCompleteOrder(booking.supplierOrderId);
      if (!isRecord(order)) {
        throw new Error(`Duffel order not found for orderId ${booking.supplierOrderId}`);
      }

      // Check if order is cancelled on Duffel
      const cancellation = isRecord(order.cancellation) ? order.cancellation : undefined;
      const isDuffelCancelled = !!order.cancelled_at || cancellation?.confirmed_at != null;

      // 4. Normalize itinerary and calculate fingerprint
      const normalizedSegments = normalizeDuffelOrder(order);
      const newFingerprint = generateItineraryFingerprint(normalizedSegments);

      // Compare with the latest stored revision or original flightSnapshot
      const latestRev = booking.itineraryRevisions[0];
      let prevFingerprint = '';
      if (latestRev) {
        prevFingerprint = latestRev.fingerprint;
      } else {
        const flightSnapshot = booking.flightSnapshot as Record<string, unknown> | null;
        const segments =
          flightSnapshot && Array.isArray(flightSnapshot.segments)
            ? (flightSnapshot.segments as unknown as FlightSegmentSnapshot[])
            : [];
        const origSegments = normalizeFlightSegments(segments);
        prevFingerprint = generateItineraryFingerprint(origSegments);
      }

      // 5. Compare fingerprint and handle unchanged case
      if (newFingerprint === prevFingerprint && !isDuffelCancelled) {
        this.logger.log(
          `Fingerprint unchanged for booking ${bookingId}. Retaining current revision. Correlation: ${correlationId}`,
        );
        const now = new Date();
        await this.prisma.booking.updateMany({
          where: { id: bookingId, syncLockToken: token },
          data: {
            lastSupplierSyncedAt: now,
            syncLockedAt: null,
            syncLockToken: null,
          },
        });
        return { status: 'NO_CHANGE' };
      }

      // 6. Execute db writes in a short transaction
      let attempts = 0;
      while (attempts < 3) {
        let eventsToPublish: PublishableEvent[] = [];
        try {
          const result = await this.prisma.$transaction(
            async (tx): Promise<SyncResult> => {
              const context = this.publisher.createContext(tx);
              const now = new Date();

              // Lock the booking row immediately to serialize concurrent syncs and cancellations
              const dbBooking = await tx.booking.update({
                where: { id: bookingId },
                data: { lastSupplierSyncedAt: now },
                include: {
                  itineraryRevisions: {
                    orderBy: { version: 'desc' },
                    take: 1,
                    include: { segments: true },
                  },
                },
              });

              // Cancellation wins races
              if (dbBooking.status !== 'CONFIRMED') {
                this.logger.warn(
                  `Cancellation race won: booking ${bookingId} status is ${dbBooking.status}. Aborting sync writes. Correlation: ${correlationId}`,
                );
                if (dbBooking.syncLockToken === token) {
                  await tx.booking.update({
                    where: { id: bookingId },
                    data: { syncLockedAt: null, syncLockToken: null },
                  });
                }
                return { status: 'SKIPPED_INELIGIBLE' };
              }

              if (dbBooking.syncLockToken !== token) {
                this.logger.error(
                  `Lock token mismatch for booking ${bookingId}. Expected: ${token}, Found: ${dbBooking.syncLockToken}. Correlation: ${correlationId}`,
                );
                throw new Error('Lock token mismatch');
              }

              // Fingerprint collision / same fingerprint convergence
              const dbLatestRev = dbBooking.itineraryRevisions[0];
              if (dbLatestRev && dbLatestRev.fingerprint === newFingerprint) {
                const wasLatestCancelled = dbLatestRev.sourceEventId === 'supplier-cancellation';
                if (!isDuffelCancelled || wasLatestCancelled) {
                  this.logger.log(
                    `Safe convergence: fingerprint already match latest revision for booking ${bookingId}. Correlation: ${correlationId}`,
                  );
                  await tx.booking.update({
                    where: { id: bookingId },
                    data: {
                      lastSupplierSyncedAt: new Date(),
                      syncLockedAt: null,
                      syncLockToken: null,
                    },
                  });
                  return { status: 'CONVERGED_DUPLICATE' };
                }
              }

              const nextVersion = dbLatestRev ? dbLatestRev.version + 1 : 1;

              // Diffs
              let prevNormalized: NormalizedSegment[];
              if (dbLatestRev) {
                prevNormalized = dbLatestRev.segments.map((s) =>
                  mapDbSegmentToNormalized(s as unknown as DbSegment),
                );
              } else {
                const flightSnapshot = dbBooking.flightSnapshot as Record<string, unknown> | null;
                const segments =
                  flightSnapshot && Array.isArray(flightSnapshot.segments)
                    ? (flightSnapshot.segments as unknown as FlightSegmentSnapshot[])
                    : [];
                prevNormalized = normalizeFlightSegments(segments);
              }

              const incrementalDiff = computeItineraryDiff(prevNormalized, normalizedSegments);
              const flightSnapshot = dbBooking.flightSnapshot as Record<string, unknown> | null;
              const segments =
                flightSnapshot && Array.isArray(flightSnapshot.segments)
                  ? (flightSnapshot.segments as unknown as FlightSegmentSnapshot[])
                  : [];
              const originalNormalized = normalizeFlightSegments(segments);
              const cumulativeDiff = computeItineraryDiff(originalNormalized, normalizedSegments);

              // Materiality and classifications
              let classification = classifyMateriality(incrementalDiff, cumulativeDiff);
              if (isDuffelCancelled) {
                classification = {
                  isMaterial: true,
                  reasons: [MaterialDisruptionReason.SEGMENT_REMOVED],
                  baselines: [MaterialBaseline.INCREMENTAL, MaterialBaseline.CUMULATIVE],
                  rulesetVersion: classification.rulesetVersion,
                };
              }

              const timingFields = calculateTimingFields(normalizedSegments);
              const bookingData: Prisma.BookingUpdateManyMutationInput = {
                lastSupplierSyncedAt: now,
                syncLockedAt: null,
                syncLockToken: null,
                currentDepartureAt: timingFields.currentDepartureAt,
                nextUnflownDepartureAt: timingFields.nextUnflownDepartureAt,
                currentFinalArrivalAt: timingFields.currentFinalArrivalAt,
              };

              let outboxCreated = false;
              let outboxWarning = false;
              let attentionRaised = false;

              if (classification.isMaterial) {
                bookingData.disruptionStatus = 'DETECTED';
                bookingData.disruptionResolvedAt = null;
                bookingData.disruptionResolvedReason = null;
                bookingData.disruptionResolvedByType = null;
                bookingData.disruptionResolvedById = null;

                // Outbox throttle check
                const utcStartOfDay = new Date();
                utcStartOfDay.setUTCHours(0, 0, 0, 0);

                const dailyNotificationsCount = await tx.notificationOutbox.count({
                  where: {
                    bookingId,
                    createdAt: { gte: utcStartOfDay },
                  },
                });

                if (dailyNotificationsCount < 2) {
                  outboxCreated = true;
                } else if (dailyNotificationsCount === 2) {
                  outboxCreated = true;
                  outboxWarning = true;
                } else {
                  attentionRaised = true;
                  bookingData.disruptionNeedsAttention = true;
                  bookingData.disruptionAttentionReason = 'NOTIFICATION_THROTTLED';
                  bookingData.disruptionAttentionAt = now;
                }
              }

              const revisionSourceEventId = isDuffelCancelled
                ? 'supplier-cancellation'
                : sourceEventId;

              // Create revision
              const newRevision = await tx.itineraryRevision.create({
                data: {
                  bookingId,
                  version: nextVersion,
                  source,
                  sourceEventId: revisionSourceEventId,
                  fingerprint: newFingerprint,
                  isMaterial: classification.isMaterial,
                  materialReasons: classification.reasons,
                  materialBaselines: classification.baselines,
                  incrementalDiff: incrementalDiff as unknown as Prisma.InputJsonValue,
                  cumulativeDiff: cumulativeDiff as unknown as Prisma.InputJsonValue,
                  rulesetVersion: classification.rulesetVersion,
                  createdAt: now,
                },
              });

              // Create segments
              if (normalizedSegments.length > 0) {
                await tx.itineraryRevisionSegment.createMany({
                  data: normalizedSegments.map((seg) => ({
                    revisionId: newRevision.id,
                    sliceOrder: seg.sliceOrder,
                    segmentOrder: seg.segmentOrder,
                    globalOrder: seg.globalOrder,
                    supplierSegmentId: seg.supplierSegmentId,
                    marketingCarrierIata: seg.marketingCarrierIata,
                    operatingCarrierIata: seg.operatingCarrierIata,
                    airlineName: seg.airlineName,
                    flightNumber: seg.flightNumber,
                    departureAirportIata: seg.departureAirportIata,
                    departureAirportName: seg.departureAirportName,
                    departureCity: seg.departureCity,
                    departureTerminal: seg.departureTerminal,
                    departureAt: new Date(seg.departureAt),
                    departureLocalDate: new Date(seg.departureLocalDate),
                    arrivalAirportIata: seg.arrivalAirportIata,
                    arrivalAirportName: seg.arrivalAirportName,
                    arrivalCity: seg.arrivalCity,
                    arrivalTerminal: seg.arrivalTerminal,
                    arrivalAt: new Date(seg.arrivalAt),
                    arrivalLocalDate: new Date(seg.arrivalLocalDate),
                    durationMinutes: seg.durationMinutes,
                    aircraftType: seg.aircraftType,
                  })),
                });
              }

              // Outbox write
              if (outboxCreated) {
                await tx.notificationOutbox.create({
                  data: {
                    bookingId,
                    revisionId: newRevision.id,
                    type: 'MATERIAL_DISRUPTION',
                    status: 'PENDING',
                    payload: {
                      reasons: classification.reasons,
                      baselines: classification.baselines,
                    } as unknown as Prisma.InputJsonValue,
                    stabilizationWarning: outboxWarning,
                    createdAt: now,
                  },
                });
              }

              // Audit events
              await tx.disruptionAuditEvent.create({
                data: {
                  bookingId,
                  revisionId: newRevision.id,
                  action: classification.isMaterial ? 'DETECTED' : 'EVENT_RETRIED',
                  fromStatus: dbBooking.disruptionStatus,
                  toStatus:
                    (bookingData.disruptionStatus as DisruptionStatus) ||
                    dbBooking.disruptionStatus,
                  actorType: 'SYSTEM',
                  actorId: null,
                  correlationId,
                  traceId: correlationId,
                  createdAt: now,
                },
              });

              if (attentionRaised) {
                await tx.disruptionAuditEvent.create({
                  data: {
                    bookingId,
                    revisionId: newRevision.id,
                    action: 'ATTENTION_RAISED',
                    fromStatus: dbBooking.disruptionStatus,
                    toStatus:
                      (bookingData.disruptionStatus as DisruptionStatus) ||
                      dbBooking.disruptionStatus,
                    actorType: 'SYSTEM',
                    actorId: null,
                    correlationId,
                    traceId: correlationId,
                    createdAt: now,
                  },
                });
              }

              // Commit Booking updates conditionally (status is confirmed)
              const updateResult = await tx.booking.updateMany({
                where: { id: bookingId, status: 'CONFIRMED', syncLockToken: token },
                data: {
                  ...bookingData,
                  version: { increment: 1 },
                },
              });

              if (updateResult.count === 0) {
                throw new Error('Booking status changed concurrently or lock was lost');
              }

              if (classification.isMaterial) {
                await tx.booking.update({
                  where: { id: bookingId },
                  data: {
                    activeDisruptionRevision: {
                      connect: { id: newRevision.id },
                    },
                  },
                });
              }

              context.events.push(
                new BookingDisruptionSyncedEvent({
                  bookingId,
                  eventId: randomUUID(),
                  sourceVersion: (dbBooking.version ?? 1) + 1,
                  revisionId: newRevision.id,
                  // Safe cast: bookingData optionally overrides status, falling back to current dbBooking.status
                  status: (bookingData.status as BookingStatus | undefined) ?? dbBooking.status,
                  timestamp: now,
                }),
              );

              eventsToPublish = context.events;

              this.logger.log(
                `Successfully completed sync for booking ${bookingId}. Created revision ${newRevision.id}. Correlation: ${correlationId}`,
              );
              return { status: 'REVISION_CREATED', revisionId: newRevision.id };
            },
            { timeout: 15000, maxWait: 10000 },
          );

          if (eventsToPublish.length > 0) {
            await this.publisher.publish(eventsToPublish);
          }

          return result;
        } catch (txError: unknown) {
          const errWithCode = txError as { code?: string; meta?: { target?: string[] } };
          if (errWithCode.code === 'P2002') {
            const targets = errWithCode.meta?.target;
            if (targets?.includes('version')) {
              attempts++;
              this.logger.warn(
                `Version collision on booking ${bookingId}, retrying transaction (attempt ${attempts}/3). Correlation: ${correlationId}`,
              );
              continue;
            }
          }
          throw txError;
        }
      }

      throw new Error(
        `Max transaction retry attempts reached for booking ${bookingId} due to version collisions.`,
      );
    } catch (error) {
      if (this.isBudgetBlockedError(error)) {
        if (token) {
          await this.syncClaimService.releaseClaim(bookingId, token);
        }
        throw error;
      }

      // Conditionally release claim lock on failure, set backoff, retain stale coverage
      const errMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Synchronization failed for booking ${bookingId}: ${errMessage}. Correlation: ${correlationId}`,
        error instanceof Error ? error.stack : undefined,
      );
      if (token) {
        try {
          const backoffTime = new Date(Date.now() + 15 * 60 * 1000); // 15 min backoff
          await this.prisma.booking.updateMany({
            where: { id: bookingId, syncLockToken: token },
            data: {
              syncLockedAt: null,
              syncLockToken: null,
              nextSupplierSyncAt: backoffTime,
            },
          });
        } catch (releaseErr: unknown) {
          const releaseErrMessage =
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
          this.logger.error(
            `Failed to conditionally release lock on failure for booking ${bookingId}: ${releaseErrMessage}`,
          );
        }
      }
      throw error;
    }
  }

  isBudgetBlockedError(error: unknown): boolean {
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
