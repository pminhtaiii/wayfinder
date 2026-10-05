import { normalizeFlightSegments } from '@/disruption/domain/itinerary-normalizer';

describe('legacy supplier segment snapshot reads', () => {
  it('normalizes a stored duffelSegmentId in memory without changing stored JSON', () => {
    const legacySegment = {
      airline: { name: 'British Airways', iataCode: 'BA' },
      flightNumber: '304',
      departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
      arrivalAirport: { iataCode: 'CDG', name: 'Charles de Gaulle', city: 'Paris' },
      departureAt: '2026-10-01T08:00:00+01:00',
      arrivalAt: '2026-10-01T10:30:00+02:00',
      duration: 'PT1H30M',
      duffelSegmentId: 'seg_legacy',
      sliceOrder: 1,
      segmentOrder: 2,
      globalOrder: 3,
    };

    const normalized = normalizeFlightSegments([legacySegment]);

    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({
      supplierSegmentId: 'seg_legacy',
      sliceOrder: 1,
      segmentOrder: 2,
      globalOrder: 3,
    });
    expect(normalized[0]).not.toHaveProperty('duffelSegmentId');
    expect(legacySegment).toHaveProperty('duffelSegmentId', 'seg_legacy');
  });

  it('preserves the neutral ID when reading a current snapshot', () => {
    const currentSegment = {
      airline: { name: 'British Airways', iataCode: 'BA' },
      flightNumber: '304',
      departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
      arrivalAirport: { iataCode: 'CDG', name: 'Charles de Gaulle', city: 'Paris' },
      departureAt: '2026-10-01T08:00:00+01:00',
      arrivalAt: '2026-10-01T10:30:00+02:00',
      duration: 'PT1H30M',
      supplierSegmentId: 'seg_current',
      sliceOrder: 1,
      segmentOrder: 2,
      globalOrder: 3,
    };

    expect(normalizeFlightSegments([currentSegment])[0].supplierSegmentId).toBe('seg_current');
  });

  it('keeps a missing segment ID absent in normalized state', () => {
    const segmentWithoutId = {
      airline: { name: 'British Airways', iataCode: 'BA' },
      flightNumber: '304',
      departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
      arrivalAirport: { iataCode: 'CDG', name: 'Charles de Gaulle', city: 'Paris' },
      departureAt: '2026-10-01T08:00:00+01:00',
      arrivalAt: '2026-10-01T10:30:00+02:00',
      duration: 'PT1H30M',
      sliceOrder: 1,
      segmentOrder: 2,
      globalOrder: 3,
    };

    expect(normalizeFlightSegments([segmentWithoutId])[0].supplierSegmentId).toBeNull();
  });
});
