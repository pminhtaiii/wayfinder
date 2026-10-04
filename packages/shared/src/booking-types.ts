import { BookingStatus } from './booking-status';
import { BookingFailureReason } from './booking-failure-reason';
import { PassengerType } from './types';

/**
 * Snapshot of a single flight segment captured at PNR creation time.
 * Stored as JSON in the flightSnapshot column. Zero Duffel API calls at read time.
 */
export interface FlightSegmentSnapshot {
  airline: {
    name: string;
    iataCode: string;
    logoUrl?: string;
  };
  flightNumber: string;
  departureAirport: {
    iataCode: string;
    name: string;
    city: string;
    terminal?: string;
    gate?: string;
  };
  arrivalAirport: {
    iataCode: string;
    name: string;
    city: string;
    terminal?: string;
    gate?: string;
  };
  /** ISO 8601 datetime */
  departureAt: string;
  /** ISO 8601 datetime */
  arrivalAt: string;
  /** ISO 8601 duration, e.g. "PT5H30M" */
  duration: string;
  aircraftType?: string;
  supplierSegmentId?: string;
  sliceOrder?: number;
  segmentOrder?: number;
  globalOrder?: number;
}

/**
 * Complete flight snapshot stored per booking.
 * Captured at PNR creation — ensures detail page requires zero Duffel API calls.
 */
export interface FlightSnapshot {
  segments: FlightSegmentSnapshot[];
  /** ISO 8601 duration */
  totalDuration: string;
  stops: number;
  cabinClass: string;
  baggageAllowance?: string;
  fareClass?: string;
}

/** Legacy HTTP response shape retained while internal snapshots use supplier names. */
export type FlightSegmentSnapshotDto = Omit<FlightSegmentSnapshot, 'supplierSegmentId'> & {
  duffelSegmentId?: string;
};

/** Legacy HTTP response shape for a complete flight snapshot. */
export type FlightSnapshotDto = Omit<FlightSnapshot, 'segments'> & {
  segments: FlightSegmentSnapshotDto[];
};

/**
 * Details of a single passenger captured at booking time.
 * Note: passportNumber is AES-256-GCM encrypted at the application layer before storage.
 * The API returns only a masked version (e.g. XXXXXX1234 showing last 4 chars).
 */
export interface PassengerDetail {
  type: PassengerType;
  title?: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  /** Encrypted in DB; masked on read (last 4 chars only) */
  passportNumber?: string;
  nationality?: string;
}

/**
 * Passenger snapshot stored per booking.
 * Captured at booking time for record purposes.
 */
export interface PassengerSnapshot {
  passengers: PassengerDetail[];
  contactEmail: string | null;
  contactPhone?: string | null;
}

/**
 * Single booking item returned in the My Bookings list.
 */
export interface BookingListItemDto {
  id: string;
  status: BookingStatus;
  failureReason?: BookingFailureReason;
  pnrReference?: string;
  totalAmount: string;
  currency: string;
  departureAt?: string;
  /** Payment status joined from the associated Payment record */
  paymentStatus?: string;
  createdAt: string;
  updatedAt: string;
  /** First segment airline for card display */
  airline?: {
    name: string;
    iataCode: string;
    logoUrl?: string;
  };
  /** First segment departure airport */
  origin?: {
    iataCode: string;
    city: string;
  };
  /** Last segment arrival airport */
  destination?: {
    iataCode: string;
    city: string;
  };
}

/**
 * Full booking detail including flight snapshot and passenger details.
 * Returned by GET /api/bookings/:bookingId.
 */
export interface BookingDetailDto {
  id: string;
  status: BookingStatus;
  failureReason?: BookingFailureReason;
  pnrReference?: string;
  duffelOrderId?: string;
  flightSnapshot?: FlightSnapshotDto;
  passengerSnapshot?: PassengerSnapshot;
  totalAmount: string;
  currency: string;
  departureAt?: string;
  /** Payment status joined for charge message derivation */
  paymentStatus?: string;
  stripePaymentIntentId?: string;
  cancellationDeadline?: string | null;
  cancellationRefundable?: boolean | null;
  airlineRefundAmount?: string | null;
  customerRefundAmount?: string | null;
  duffelCancellationQuoteId?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * DTO returned when creating/retrieving a cancellation quote.
 */
export interface CancellationQuoteResponseDto {
  quoteId: string;
  bookingId: string;
  duffelOrderId: string;
  refundAmount: string;
  currency: string;
  expiresAt: string;
  refundable: boolean;
  cancellationDeadline?: string;
  /** Supplier-provided destination for the quoted refund. */
  refundTo: string | null;
  /** Supplier-provided excluded ancillary value; never derived locally. */
  nonRefundableAncillaryAmount: string | null;
  nonRefundableAncillaryCurrency: string | null;
}

/** Durable response for a supplier-first cancellation request. */
export interface CancellationResponseDto {
  bookingId: string;
  bookingStatus: string;
  cancellationStatus: string;
  refundStatus: string;
  refundAmount: string;
  nextRetryAt?: string;
  duffelCancellationQuoteId?: string | null;
}
