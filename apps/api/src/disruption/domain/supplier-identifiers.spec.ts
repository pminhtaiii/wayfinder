import type { FlightSegmentSnapshot } from '@shared/booking-types';
import { normalizeFlightSegments } from './itinerary-normalizer';
import { matchSegments } from './segment-matcher';

function snapshotSegment(
  flightNumber: string,
  departureIata: string,
  arrivalIata: string,
  departureAt: string,
): FlightSegmentSnapshot {
  return {
    airline: { name: 'Northwind Air', iataCode: 'NW' },
    flightNumber,
    departureAirport: { iataCode: departureIata, name: departureIata, city: departureIata },
    arrivalAirport: { iataCode: arrivalIata, name: arrivalIata, city: arrivalIata },
    departureAt,
    arrivalAt: '2026-10-10T10:00:00Z',
    duration: 'PT2H',
    supplierSegmentId: 'seg_legacy',
  };
}

describe('neutral supplier segment identity', () => {
  it('survives snapshot normalization and drives exact segment matching', () => {
    const previous = normalizeFlightSegments([
      snapshotSegment('NW42', 'SGN', 'HAN', '2026-10-10T08:00:00Z'),
    ]);
    const current = normalizeFlightSegments([
      snapshotSegment('NW99', 'JFK', 'LHR', '2026-10-12T12:00:00Z'),
    ]);

    expect(previous[0]).toMatchObject({ supplierSegmentId: 'seg_legacy' });
    expect(matchSegments(previous, current).matches[0]).toMatchObject({
      method: 'ID_MATCH',
      confidence: 'HIGH',
    });
  });
});
