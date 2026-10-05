import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/prisma/prisma.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingWithRelations } from '@/booking-lifecycle/booking-lifecycle.types';
import { FlightSegmentSnapshotDto } from '@shared/booking-types';
import {
  BookingDisruptionDto,
  CurrentItineraryDto,
  DisruptionResolvedReason,
  MaterialDisruptionReason,
  DisruptionStatus as SharedDisruptionStatus,
} from '@shared/disruption-types';
import {
  BookingDetailResponseDto,
  BookingListItemResponseDto,
  BookingListResponseDto,
  BookingTab,
} from './dto';
import {
  parseDuffelCancellationQuoteId,
  parseSupplierCancellationQuoteId,
} from '@/cancellation/cancellation.types';
export { parseSupplierCancellationQuoteId, parseDuffelCancellationQuoteId };

function isJsonObject(value: unknown): value is Prisma.JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveLegacySegmentId(record: Prisma.JsonObject): string | undefined {
  if (typeof record.duffelSegmentId === 'string') {
    return record.duffelSegmentId;
  }
  if (typeof record.supplierSegmentId === 'string') {
    return record.supplierSegmentId;
  }
  return undefined;
}

function projectSnapshotSegment(segment: unknown): Prisma.JsonObject {
  if (!isJsonObject(segment)) {
    return {};
  }
  const { supplierSegmentId: _supplierSegmentId, duffelSegmentId: _duffelSegmentId, ...rest } = segment;
  const legacySegmentId = resolveLegacySegmentId(segment);

  return {
    ...rest,
    ...(legacySegmentId !== undefined ? { duffelSegmentId: legacySegmentId } : {}),
  };
}

function projectFlightSnapshot(raw: Prisma.JsonValue | null): Prisma.JsonValue | null {
  if (!isJsonObject(raw) || !Array.isArray(raw.segments)) {
    return raw;
  }
  const segments: Prisma.JsonArray = raw.segments.map((seg) => projectSnapshotSegment(seg));

  return {
    ...raw,
    segments,
  };
}

function toFlightSegmentSnapshotDto(raw: unknown): FlightSegmentSnapshotDto {
  if (!isJsonObject(raw)) {
    return {
      airline: { name: '', iataCode: '' },
      flightNumber: '',
      departureAirport: { iataCode: '', name: '', city: '' },
      arrivalAirport: { iataCode: '', name: '', city: '' },
      departureAt: '',
      arrivalAt: '',
      duration: '',
    };
  }
  const { supplierSegmentId: _supplierSegmentId, duffelSegmentId: _duffelSegmentId, ...rest } = raw;
  const legacyId = resolveLegacySegmentId(raw);

  const airlineRaw = isJsonObject(rest.airline) ? rest.airline : {};
  const departureAirportRaw = isJsonObject(rest.departureAirport) ? rest.departureAirport : {};
  const arrivalAirportRaw = isJsonObject(rest.arrivalAirport) ? rest.arrivalAirport : {};

  return {
    ...rest,
    airline: {
      name: typeof airlineRaw.name === 'string' ? airlineRaw.name : '',
      iataCode: typeof airlineRaw.iataCode === 'string' ? airlineRaw.iataCode : '',
      ...(typeof airlineRaw.logoUrl === 'string' ? { logoUrl: airlineRaw.logoUrl } : {}),
    },
    flightNumber: typeof rest.flightNumber === 'string' ? rest.flightNumber : '',
    departureAirport: {
      iataCode: typeof departureAirportRaw.iataCode === 'string' ? departureAirportRaw.iataCode : '',
      name: typeof departureAirportRaw.name === 'string' ? departureAirportRaw.name : '',
      city: typeof departureAirportRaw.city === 'string' ? departureAirportRaw.city : '',
      ...(typeof departureAirportRaw.terminal === 'string' ? { terminal: departureAirportRaw.terminal } : {}),
      ...(typeof departureAirportRaw.gate === 'string' ? { gate: departureAirportRaw.gate } : {}),
    },
    arrivalAirport: {
      iataCode: typeof arrivalAirportRaw.iataCode === 'string' ? arrivalAirportRaw.iataCode : '',
      name: typeof arrivalAirportRaw.name === 'string' ? arrivalAirportRaw.name : '',
      city: typeof arrivalAirportRaw.city === 'string' ? arrivalAirportRaw.city : '',
      ...(typeof arrivalAirportRaw.terminal === 'string' ? { terminal: arrivalAirportRaw.terminal } : {}),
      ...(typeof arrivalAirportRaw.gate === 'string' ? { gate: arrivalAirportRaw.gate } : {}),
    },
    departureAt: typeof rest.departureAt === 'string' ? rest.departureAt : '',
    arrivalAt: typeof rest.arrivalAt === 'string' ? rest.arrivalAt : '',
    duration: typeof rest.duration === 'string' ? rest.duration : '',
    ...(legacyId !== undefined ? { duffelSegmentId: legacyId } : {}),
  };
}

@Injectable()
export class BookingManagementService {
  private readonly logger = new Logger(BookingManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async listBookings(
    userId: string,
    tab: BookingTab,
    page: number,
    limit: number,
  ): Promise<BookingListResponseDto> {
    const now = new Date();
    const activeStatuses: BookingStatus[] = [
      BookingStatus.PROCESSING,
      BookingStatus.CONFIRMED,
      BookingStatus.CANCELLATION_PENDING,
      BookingStatus.CANCELLED_PENDING_REFUND,
      BookingStatus.FAILED,
    ];
    const pastTerminalStatuses: BookingStatus[] = [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED_AND_REFUNDED,
      BookingStatus.CANCELLED_NO_REFUND,
    ];

    const where =
      tab === 'past'
        ? {
            userId,
            OR: [
              { status: { in: pastTerminalStatuses } },
              { status: { in: activeStatuses }, departureAt: { lte: now } },
            ],
          }
        : {
            userId,
            status: { in: activeStatuses },
            OR: [{ departureAt: null }, { departureAt: { gt: now } }],
          };

    const bookings = await this.prisma.booking.findMany({
      where,
      include: {
        payment: { select: { id: true, status: true, stripePaymentIntentId: true } },
        bookingIntent: { select: { id: true, supplierOfferId: true } },
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

    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    const reconciledBookings = await Promise.all(
      bookings.map(async (b) => {
        this.requestReconciliationIfStale(b, staleThreshold);
        const updated = (await this.bookingLifecycleService.checkAndCompleteBooking(
          b as unknown as BookingWithRelations,
        )) as typeof b;
        return updated;
      }),
    );

    const ordered = this.sortBookings(reconciledBookings as unknown as BookingWithRelations[], tab);
    const total = ordered.length;
    const items = ordered
      .slice((page - 1) * limit, page * limit)
      .map((booking) => this.toListItem(booking));

    return {
      bookings: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getBookingDetail(bookingId: string, userId: string): Promise<BookingDetailResponseDto> {
    const initialBooking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
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

    if (!initialBooking) {
      throw new NotFoundException('Booking not found');
    }
    if (initialBooking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    const staleThreshold = new Date(Date.now() - 15 * 60 * 1000);
    this.requestReconciliationIfStale(initialBooking, staleThreshold);

    const booking = (await this.bookingLifecycleService.checkAndCompleteBooking(
      initialBooking as unknown as BookingWithRelations,
    )) as unknown as typeof initialBooking;

    const passengers = booking.bookingIntent?.passengers || [];
    const getPassengerName = (intentPassengerId: string) => {
      const passenger = passengers.find((p) => p.id === intentPassengerId);
      if (!passenger) return '';
      return `${passenger.givenName} ${passenger.familyName}`.trim();
    };

    const ancillarySelection = booking.payment?.ancillarySelection;
    const ancillarySummary = ancillarySelection
      ? {
          seats: (ancillarySelection.seatSelections || []).map((seat) => ({
            intentPassengerId: seat.intentPassengerId,
            passengerName: getPassengerName(seat.intentPassengerId),
            segmentId: seat.segmentId,
            seatDesignator: seat.seatDesignator,
            amount: seat.amount.toString(),
            currency: seat.currency,
          })),
          baggage: (ancillarySelection.baggageSelections || []).map((bag) => ({
            intentPassengerId: bag.intentPassengerId,
            passengerName: getPassengerName(bag.intentPassengerId),
            type: bag.type,
            quantity: bag.quantity,
            amount: bag.amount.toString(),
            currency: bag.currency,
          })),
        }
      : null;

    return {
      id: booking.id,
      status: booking.status,
      failureReason: booking.failureReason,
      pnrReference: booking.pnrReference,
      duffelOrderId: booking.supplierOrderId,
      totalAmount: booking.totalAmount.toString(),
      currency: booking.currency,
      departureAt: booking.departureAt?.toISOString() ?? null,
      flightSnapshot: projectFlightSnapshot(booking.flightSnapshot),
      passengerSnapshot: booking.passengerSnapshot,
      payment: booking.payment
        ? {
            id: booking.payment.id,
            status: booking.payment.status,
            stripePaymentIntentId: booking.payment.stripePaymentIntentId,
          }
        : null,
      bookingIntent: {
        id: booking.bookingIntent.id,
        offerId: booking.bookingIntent.supplierOfferId ?? '',
      },
      cancellationDeadline: booking.cancellationDeadline?.toISOString() ?? null,
      cancellationRefundable: booking.cancellationRefundable ?? null,
      airlineRefundAmount: booking.airlineRefundAmount
        ? booking.airlineRefundAmount.toString()
        : null,
      customerRefundAmount: booking.customerRefundAmount
        ? booking.customerRefundAmount.toString()
        : null,
      duffelCancellationQuoteId: parseSupplierCancellationQuoteId(
        booking.supplierCancellationQuoteId,
      ).quoteId,
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
      ancillarySummary,
      ...this.mapDisruptionAndItinerary(booking as unknown as BookingWithRelations),
    };
  }

  private mapDisruptionAndItinerary(booking: BookingWithRelations): {
    currentItinerary: CurrentItineraryDto;
    disruption: BookingDisruptionDto;
  } {
    const isSurfacing = process.env.FEATURE_FLAG_DISRUPTION_SURFACING === 'true';

    // 1. Build original itinerary data from flightSnapshot as fallback
    const rawSnapshot = isJsonObject(booking.flightSnapshot) ? booking.flightSnapshot : null;
    const rawSegments =
      rawSnapshot && Array.isArray(rawSnapshot.segments) ? rawSnapshot.segments : [];
    const originalSegments: FlightSegmentSnapshotDto[] = rawSegments.map((seg) =>
      toFlightSegmentSnapshotDto(seg),
    );

    // Default/fallback currentItinerary (which represents the original or when surfacing is disabled)
    let currentItinerary: CurrentItineraryDto = {
      source: 'ORIGINAL',
      revisionId: null,
      version: 0,
      segments: originalSegments,
      nextUnflownDepartureAt: booking.nextUnflownDepartureAt?.toISOString() ?? null,
      finalArrivalAt: booking.currentFinalArrivalAt?.toISOString() ?? null,
    };

    // Calculate timings from original segments if not present in DB
    if (!currentItinerary.nextUnflownDepartureAt || !currentItinerary.finalArrivalAt) {
      const sorted = [...originalSegments].sort(
        (a, b) => (a.globalOrder ?? 0) - (b.globalOrder ?? 0),
      );
      if (sorted.length > 0) {
        if (!currentItinerary.finalArrivalAt) {
          currentItinerary.finalArrivalAt = sorted[sorted.length - 1].arrivalAt;
        }
        if (!currentItinerary.nextUnflownDepartureAt) {
          const now = new Date();
          const next = sorted.find((s) => new Date(s.departureAt) > now);
          currentItinerary.nextUnflownDepartureAt = next ? next.departureAt : null;
        }
      }
    }

    // Default disruption status
    let disruption: BookingDisruptionDto = {
      status: SharedDisruptionStatus.NONE,
      activeRevisionId: null,
      isMaterial: false,
      materialReasons: [],
      incrementalSummary: {},
      cumulativeSummary: {},
      stabilizationWarning: false,
      resolvedReason: null,
      resolvedAt: null,
    };

    if (isSurfacing) {
      // Latest revision is used for current itinerary
      const latestRevision = booking.itineraryRevisions?.[0];
      if (latestRevision) {
        currentItinerary = {
          source: 'REVISION',
          revisionId: latestRevision.id,
          version: latestRevision.version,
          segments: latestRevision.segments.map((seg) => ({
            airline: {
              name: seg.airlineName,
              iataCode: seg.marketingCarrierIata,
            },
            flightNumber: seg.flightNumber,
            departureAirport: {
              iataCode: seg.departureAirportIata,
              name: seg.departureAirportName,
              city: seg.departureCity,
              terminal: seg.departureTerminal ?? undefined,
            },
            arrivalAirport: {
              iataCode: seg.arrivalAirportIata,
              name: seg.arrivalAirportName,
              city: seg.arrivalCity,
              terminal: seg.arrivalTerminal ?? undefined,
            },
            departureAt:
              seg.departureAt instanceof Date
                ? seg.departureAt.toISOString()
                : String(seg.departureAt),
            arrivalAt:
              seg.arrivalAt instanceof Date ? seg.arrivalAt.toISOString() : String(seg.arrivalAt),
            duration: `PT${seg.durationMinutes}M`,
            aircraftType: seg.aircraftType ?? undefined,
            duffelSegmentId: seg.supplierSegmentId ?? undefined,
            sliceOrder: seg.sliceOrder,
            segmentOrder: seg.segmentOrder,
            globalOrder: seg.globalOrder,
          })),
          nextUnflownDepartureAt: booking.nextUnflownDepartureAt?.toISOString() ?? null,
          finalArrivalAt: booking.currentFinalArrivalAt?.toISOString() ?? null,
        };

        // Re-calculate timings from revision segments if not present in DB
        if (!currentItinerary.nextUnflownDepartureAt || !currentItinerary.finalArrivalAt) {
          const sorted = [...latestRevision.segments].sort((a, b) => a.globalOrder - b.globalOrder);
          if (sorted.length > 0) {
            if (!currentItinerary.finalArrivalAt) {
              const lastArr = sorted[sorted.length - 1].arrivalAt;
              currentItinerary.finalArrivalAt =
                lastArr instanceof Date ? lastArr.toISOString() : String(lastArr);
            }
            if (!currentItinerary.nextUnflownDepartureAt) {
              const now = new Date();
              const next = sorted.find((s) => new Date(s.departureAt) > now);
              currentItinerary.nextUnflownDepartureAt = next
                ? next.departureAt instanceof Date
                  ? next.departureAt.toISOString()
                  : String(next.departureAt)
                : null;
            }
          }
        }
      }

      // If booking disruption status is not NONE, fill in disruption details
      if (booking.disruptionStatus && booking.disruptionStatus !== 'NONE') {
        const activeRevision = booking.activeDisruptionRevision;
        const incDiff = activeRevision?.incrementalDiff as unknown as {
          presentationSummary?: Record<string, unknown>;
        };
        const cumDiff = activeRevision?.cumulativeDiff as unknown as {
          presentationSummary?: Record<string, unknown>;
        };
        disruption = {
          status: booking.disruptionStatus as unknown as SharedDisruptionStatus,
          activeRevisionId: booking.activeDisruptionRevisionId,
          isMaterial: activeRevision ? activeRevision.isMaterial : false,
          materialReasons: activeRevision
            ? (activeRevision.materialReasons as unknown as MaterialDisruptionReason[])
            : [],
          incrementalSummary: incDiff?.presentationSummary || {},
          cumulativeSummary: cumDiff?.presentationSummary || {},
          stabilizationWarning: activeRevision?.notificationOutbox?.stabilizationWarning ?? false,
          resolvedReason:
            booking.disruptionResolvedReason as unknown as DisruptionResolvedReason | null,
          resolvedAt:
            booking.disruptionResolvedAt instanceof Date
              ? booking.disruptionResolvedAt.toISOString()
              : (booking.disruptionResolvedAt ?? null),
        };
      }
    }

    return { currentItinerary, disruption };
  }

  private sortBookings(bookings: BookingWithRelations[], tab: BookingTab): BookingWithRelations[] {
    return [...bookings].sort((left, right) => {
      if (tab === 'past') {
        return (right.departureAt?.getTime() ?? 0) - (left.departureAt?.getTime() ?? 0);
      }
      const priority: Record<BookingStatus, number> = {
        PROCESSING: 0,
        FAILED: 1,
        CONFIRMED: 2,
        CANCELLATION_PENDING: 3,
        CANCELLED_PENDING_REFUND: 4,
        CANCELLED_AND_REFUNDED: 5,
        CANCELLED_NO_REFUND: 6,
        COMPLETED: 7,
        REFUND_FAILED_NEEDS_ATTENTION: 8,
      };
      const priorityDifference = priority[left.status] - priority[right.status];
      if (priorityDifference !== 0) return priorityDifference;
      return (
        (left.departureAt?.getTime() ?? Number.MAX_SAFE_INTEGER) -
        (right.departureAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
      );
    });
  }

  private toListItem(booking: BookingWithRelations): BookingListItemResponseDto {
    return {
      id: booking.id,
      status: booking.status,
      failureReason: booking.failureReason,
      pnrReference: booking.pnrReference,
      totalAmount: booking.totalAmount.toString(),
      currency: booking.currency,
      departureAt: booking.departureAt?.toISOString() ?? null,
      flightSnapshot: projectFlightSnapshot(booking.flightSnapshot),
      ...this.mapDisruptionAndItinerary(booking),
      createdAt: booking.createdAt.toISOString(),
    };
  }

  private requestReconciliationIfStale(
    booking: { id: string; status: BookingStatus; createdAt: Date },
    staleThreshold: Date,
  ): void {
    if (
      booking.status === BookingStatus.PROCESSING &&
      new Date(booking.createdAt).getTime() <= staleThreshold.getTime()
    ) {
      try {
        this.eventEmitter.emit('booking.reconciliation.requested', {
          bookingId: booking.id,
        });
      } catch (e: unknown) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.logger.error(
          `Failed to emit reconciliation event for booking ${booking.id}: ${err.message}`,
          err.stack,
        );
      }
    }
  }
}
