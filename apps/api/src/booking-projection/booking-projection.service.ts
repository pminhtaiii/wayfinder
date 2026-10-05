import { Injectable, Logger } from '@nestjs/common';
import { FlightSnapshot } from '@shared/booking-types';

export class MalformedRevisionError extends Error {
  constructor(message = 'Authoritative itinerary revision is malformed or empty') {
    super(message);
    this.name = 'MalformedRevisionError';
    Object.setPrototypeOf(this, MalformedRevisionError.prototype);
  }
}

export type SafeBookingProjectionData = {
  airline: string;
  origin: string;
  destination: string;
  departureAt: Date;
  arrivalAt: Date;
  durationMinutes: number;
  stopCount: number;
  flightNumber: string | null;
  baggageSummary: string | null;
  refundable: boolean | null;
  changeable: boolean | null;
};

function formatFlightNumber(
  carrierCode: string | undefined | null,
  rawFlightNumber: string | undefined | null,
): string | null {
  if (!rawFlightNumber) return null;
  if (!carrierCode || carrierCode.trim() === '') return rawFlightNumber;
  const trimmedCarrier = carrierCode.trim();
  if (
    rawFlightNumber.startsWith(`${trimmedCarrier} `) ||
    rawFlightNumber.startsWith(trimmedCarrier)
  ) {
    return rawFlightNumber;
  }
  return `${trimmedCarrier} ${rawFlightNumber}`;
}

@Injectable()
export class BookingProjectionService {
  private readonly logger = new Logger(BookingProjectionService.name);

  extractProjectionData(booking: unknown): SafeBookingProjectionData | null {
    if (!booking || typeof booking !== 'object') {
      return null;
    }

    const b = booking as {
      itineraryRevisions?: Array<{
        version?: number;
        segments?: Array<{
          globalOrder?: number;
          departureAirportIata?: string;
          arrivalAirportIata?: string;
          departureAt?: Date | string;
          arrivalAt?: Date | string;
          airlineName?: string;
          flightNumber?: string;
          marketingCarrierIata?: string;
        }>;
      }>;
      flightSnapshot?: FlightSnapshot | null;
    };

    // 1. Primary: Authoritative ItineraryRevisions
    // Strict Invariant: No Stale Fallback: If itineraryRevisions has entries, but the latest revision
    // is empty (0 segments) or malformed (invalid dates, missing departureAirportIata/arrivalAirportIata),
    // it MUST throw MalformedRevisionError, and MUST NOT fall back to flightSnapshot.
    if (
      b.itineraryRevisions &&
      Array.isArray(b.itineraryRevisions) &&
      b.itineraryRevisions.length > 0
    ) {
      // Find latest revision: sort by version descending if present, else take first
      const revisions = [...b.itineraryRevisions].sort(
        (a, b) => (b.version ?? 0) - (a.version ?? 0),
      );
      const activeRevision = revisions[0];

      if (
        !activeRevision ||
        !activeRevision.segments ||
        !Array.isArray(activeRevision.segments) ||
        activeRevision.segments.length === 0
      ) {
        throw new MalformedRevisionError('Latest itinerary revision is empty or has no segments');
      }

      const segments = [...activeRevision.segments].sort(
        (a, b) => (a.globalOrder ?? 0) - (b.globalOrder ?? 0),
      );

      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];

      if (!firstSegment || !lastSegment) {
        throw new MalformedRevisionError('Revision segments cannot be indexed');
      }

      const origin = firstSegment.departureAirportIata;
      if (!origin || typeof origin !== 'string' || origin.trim() === '') {
        throw new MalformedRevisionError('First segment missing departureAirportIata');
      }

      const destination = lastSegment.arrivalAirportIata;
      if (!destination || typeof destination !== 'string' || destination.trim() === '') {
        throw new MalformedRevisionError('Last segment missing arrivalAirportIata');
      }

      if (!firstSegment.departureAt || !lastSegment.arrivalAt) {
        throw new MalformedRevisionError('Segment missing departureAt or arrivalAt');
      }

      const departureAt = new Date(firstSegment.departureAt);
      const arrivalAt = new Date(lastSegment.arrivalAt);

      if (isNaN(departureAt.getTime()) || isNaN(arrivalAt.getTime())) {
        throw new MalformedRevisionError(
          'Invalid departureAt or arrivalAt date in revision segments',
        );
      }

      const durationMinutes = Math.max(
        0,
        Math.round((arrivalAt.getTime() - departureAt.getTime()) / 60000),
      );
      const stopCount = Math.max(0, segments.length - 1);
      const airline = firstSegment.airlineName || '';
      const flightNumber = formatFlightNumber(
        firstSegment.marketingCarrierIata,
        firstSegment.flightNumber,
      );

      return {
        airline,
        origin,
        destination,
        departureAt,
        arrivalAt,
        durationMinutes,
        stopCount,
        flightNumber,
        baggageSummary: null,
        refundable: null,
        changeable: null,
      };
    }

    // 2. Fallback: flightSnapshot JSON (Permitted ONLY when itineraryRevisions is empty / non-existent)
    const flightSnapshot = b.flightSnapshot;
    if (
      flightSnapshot &&
      flightSnapshot.segments &&
      Array.isArray(flightSnapshot.segments) &&
      flightSnapshot.segments.length > 0
    ) {
      const segments = flightSnapshot.segments;
      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];

      const depStr = firstSegment?.departureAt;
      const arrStr = lastSegment?.arrivalAt;

      if (depStr && arrStr) {
        const departureAt = new Date(depStr);
        const arrivalAt = new Date(arrStr);

        if (!isNaN(departureAt.getTime()) && !isNaN(arrivalAt.getTime())) {
          const origin = firstSegment.departureAirport?.iataCode || '';
          const destination = lastSegment.arrivalAirport?.iataCode || '';
          const durationMinutes = Math.max(
            0,
            Math.round((arrivalAt.getTime() - departureAt.getTime()) / 60000),
          );
          const stopCount = flightSnapshot.stops ?? Math.max(0, segments.length - 1);
          const airline = firstSegment.airline?.name || '';
          const flightNumber = formatFlightNumber(
            firstSegment.airline?.iataCode,
            firstSegment.flightNumber,
          );
          const baggageSummary = flightSnapshot.baggageAllowance || null;

          return {
            airline,
            origin,
            destination,
            departureAt,
            arrivalAt,
            durationMinutes,
            stopCount,
            flightNumber,
            baggageSummary,
            refundable: null,
            changeable: null,
          };
        }
      }
    }

    return null;
  }
}
