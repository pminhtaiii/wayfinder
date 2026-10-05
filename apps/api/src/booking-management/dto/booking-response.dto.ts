import { BookingFailureReason, BookingStatus, Prisma } from '@prisma/client';
import { CurrentItineraryDto, BookingDisruptionDto } from '@shared/disruption-types';
import type { FlightSnapshotDto } from '@shared/booking-types';

export class BookingListItemResponseDto {
  id!: string;
  status!: BookingStatus;
  failureReason!: BookingFailureReason | null;
  pnrReference!: string | null;
  totalAmount!: string;
  currency!: string;
  departureAt!: string | null;
  /** Legacy wire flight snapshot projection; neutral supplierSegmentId mapped to duffelSegmentId */
  flightSnapshot!: FlightSnapshotDto | Prisma.JsonValue | null;
  currentItinerary!: CurrentItineraryDto;
  disruption!: BookingDisruptionDto;
  createdAt!: string;
}

export class BookingListResponseDto {
  bookings!: BookingListItemResponseDto[];
  pagination!: { page: number; limit: number; total: number; totalPages: number };
}

export class BookingDetailResponseDto extends BookingListItemResponseDto {
  duffelOrderId!: string | null;
  passengerSnapshot!: Prisma.JsonValue | null;
  payment!: { id: string; status: string; stripePaymentIntentId: string } | null;
  bookingIntent!: { id: string; offerId: string };
  cancellationDeadline!: string | null;
  cancellationRefundable!: boolean | null;
  airlineRefundAmount!: string | null;
  customerRefundAmount!: string | null;
  duffelCancellationQuoteId!: string | null;
  updatedAt!: string;
  ancillarySummary?: {
    seats: {
      intentPassengerId: string;
      passengerName: string;
      segmentId: string;
      seatDesignator: string;
      amount: string;
      currency: string;
    }[];
    baggage: {
      intentPassengerId: string;
      passengerName: string;
      type: string;
      quantity: number;
      amount: string;
      currency: string;
    }[];
  } | null;
}
