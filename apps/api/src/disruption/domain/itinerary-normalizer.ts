import type { FlightSegmentSnapshot } from '@shared/booking-types';
import { normalizeDuffelOrder as normalizeOrder } from '@/supplier/order/order-snapshot.normalizer';

export interface NormalizedSegment {
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
  departureAt: string;
  departureLocalDate: string;
  arrivalAirportIata: string;
  arrivalAirportName: string;
  arrivalCity: string;
  arrivalTerminal: string | null;
  arrivalAt: string;
  arrivalLocalDate: string;
  durationMinutes: number;
  aircraftType: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseIsoDurationToMinutes(durationStr: string | null | undefined): number {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const matches = durationStr.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 24 * 60 + hours * 60 + minutes;
}

function extractLocalDate(dateTimeStr: string): string {
  if (!dateTimeStr) return '';
  return dateTimeStr.split('T')[0];
}

/** @deprecated Use OrderSnapshotNormalizer from the supplier order capability. */
export function normalizeDuffelOrder(order: unknown): NormalizedSegment[] {
  return normalizeOrder(order);
}

export function normalizeFlightSegments(segments: FlightSegmentSnapshot[]): NormalizedSegment[] {
  if (!segments || !Array.isArray(segments)) {
    return [];
  }
  return segments.map((seg, index) => {
    const sliceOrder = seg.sliceOrder ?? 0;
    const segmentOrder = seg.segmentOrder ?? index;
    const globalOrder = seg.globalOrder ?? index;
    const legacySegmentId = isRecord(seg) ? seg['duffelSegmentId'] : undefined;

    return {
      sliceOrder,
      segmentOrder,
      globalOrder,
      supplierSegmentId:
        seg.supplierSegmentId ||
        (typeof legacySegmentId === 'string' && legacySegmentId ? legacySegmentId : null),
      marketingCarrierIata: seg.airline.iataCode,
      operatingCarrierIata: seg.airline.iataCode,
      airlineName: seg.airline.name,
      flightNumber: seg.flightNumber,
      departureAirportIata: seg.departureAirport.iataCode,
      departureAirportName: seg.departureAirport.name,
      departureCity: seg.departureAirport.city,
      departureTerminal: seg.departureAirport.terminal || null,
      departureAt: seg.departureAt,
      departureLocalDate: extractLocalDate(seg.departureAt),
      arrivalAirportIata: seg.arrivalAirport.iataCode,
      arrivalAirportName: seg.arrivalAirport.name,
      arrivalCity: seg.arrivalAirport.city,
      arrivalTerminal: seg.arrivalAirport.terminal || null,
      arrivalAt: seg.arrivalAt,
      arrivalLocalDate: extractLocalDate(seg.arrivalAt),
      durationMinutes: parseIsoDurationToMinutes(seg.duration),
      aircraftType: seg.aircraftType || null,
    };
  });
}
