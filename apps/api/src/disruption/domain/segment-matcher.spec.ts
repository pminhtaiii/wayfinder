// User approved on 2026-10-03: internal fixture names match the domain rename.
// Values and scenarios are unchanged.
import { matchSegments } from './segment-matcher';
import { NormalizedSegment } from './itinerary-normalizer';

describe('SegmentMatcher', () => {
  const baseSegment: NormalizedSegment = {
    sliceOrder: 0,
    segmentOrder: 0,
    globalOrder: 0,
    supplierSegmentId: 'seg_1',
    marketingCarrierIata: 'BA',
    operatingCarrierIata: 'BA',
    airlineName: 'British Airways',
    flightNumber: '177',
    departureAirportIata: 'LHR',
    departureAirportName: 'Heathrow',
    departureCity: 'London',
    departureTerminal: '5',
    departureAt: '2026-10-01T10:00:00+01:00',
    departureLocalDate: '2026-10-01',
    arrivalAirportIata: 'JFK',
    arrivalAirportName: 'John F. Kennedy',
    arrivalCity: 'New York',
    arrivalTerminal: '4',
    arrivalAt: '2026-10-01T13:30:00-04:00',
    arrivalLocalDate: '2026-10-01',
    durationMinutes: 510,
    aircraftType: 'Boeing 777',
  };

  it('should match identical segments using exact ID (Tier 1)', () => {
    const prev = [baseSegment];
    const curr = [{ ...baseSegment }];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('ID_MATCH');
    expect(result.matches[0].confidence).toBe('HIGH');
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  it('should match using Flight Key (Tier 2) when ID is missing or mismatched', () => {
    // Missing ID (e.g. legacy baseline)
    const prev = [{ ...baseSegment, supplierSegmentId: null }];
    const curr = [{ ...baseSegment, supplierSegmentId: 'seg_new_123' }];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('FLIGHT_KEY_MATCH');
    expect(result.matches[0].confidence).toBe('HIGH');
  });

  it('should match using Route and Nearest Time (Tier 3) within 6 hours', () => {
    // Flight number or carrier changes, but route/date/time matches closely
    const prev = [{ ...baseSegment, supplierSegmentId: null, flightNumber: '177' }];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: 'seg_new',
        flightNumber: '999', // flight number changed
        departureAt: '2026-10-01T12:00:00+01:00', // moved by 2 hours
      },
    ];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('ROUTE_TIME_MATCH');
    expect(result.matches[0].confidence).toBe('MEDIUM');
  });

  it('should leave unmatched if time shift is outside the 6-hour tolerance', () => {
    const prev = [{ ...baseSegment, supplierSegmentId: null, globalOrder: 0 }];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: 'seg_new',
        flightNumber: '999',
        globalOrder: 1, // different globalOrder to prevent position match
        departureAt: '2026-10-01T17:00:00+01:00', // moved by 7 hours
      },
    ];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.added).toHaveLength(1);
  });

  it('should match using Position (Tier 4) as a final deterministic tie-breaker', () => {
    const prev = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '177',
        departureAirportIata: 'LHR',
        arrivalAirportIata: 'JFK',
      },
    ];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: 'seg_new',
        flightNumber: '999',
        departureAirportIata: 'LGW', // airport changed
        arrivalAirportIata: 'EWR', // airport changed
        departureAt: '2026-10-01T15:00:00+01:00', // outside 6 hours
      },
    ];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('POSITION_MATCH');
    expect(result.matches[0].confidence).toBe('LOW');
  });

  it('should correctly handle inserted segments', () => {
    const prev = [baseSegment];
    const newSegment: NormalizedSegment = {
      ...baseSegment,
      globalOrder: 1,
      segmentOrder: 1,
      supplierSegmentId: 'seg_2',
      flightNumber: '200',
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
    };
    const curr = [{ ...baseSegment }, newSegment];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.added).toEqual([newSegment]);
    expect(result.removed).toHaveLength(0);
  });

  it('should correctly handle removed segments', () => {
    const segment2 = {
      ...baseSegment,
      globalOrder: 1,
      segmentOrder: 1,
      supplierSegmentId: 'seg_2',
      flightNumber: '200',
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
    };
    const prev = [baseSegment, segment2];
    const curr = [{ ...baseSegment }];
    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(1);
    expect(result.removed).toEqual([segment2]);
    expect(result.added).toHaveLength(0);
  });

  it('should correctly handle rerouted segments', () => {
    const prev = [{ ...baseSegment, supplierSegmentId: null }];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: 'seg_2',
        departureAirportIata: 'LGW', // completely new origin
        arrivalAirportIata: 'MCO', // completely new destination
      },
    ];
    const result = matchSegments(prev, curr);

    // Positions match (globalOrder 0) -> POSITION_MATCH
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].method).toBe('POSITION_MATCH');
  });

  it('should prevent many-to-one matching', () => {
    // Two prev segments could match the same curr segment (Tier 3 candidate)
    // baseSegment departure is 10:00. P2 is 11:00. Curr is 11:15.
    // P2 is closer to Curr than baseSegment, so P2 should match, baseSegment remains removed.
    const p1 = { ...baseSegment, supplierSegmentId: null };
    const p2 = {
      ...baseSegment,
      supplierSegmentId: null,
      globalOrder: 1,
      segmentOrder: 1,
      departureAt: '2026-10-01T11:00:00+01:00',
    };
    const curr = {
      ...baseSegment,
      supplierSegmentId: 'seg_curr_unique',
      departureAt: '2026-10-01T11:15:00+01:00',
      flightNumber: '999', // forces Tier 3
    };

    const result = matchSegments([p1, p2], [curr]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].prevSegment.globalOrder).toBe(1); // p2 matches
    expect(result.removed).toEqual([p1]);
  });

  it('should handle same-day same-route ambiguity by leaving them unmatched under Tier 3', () => {
    // One prev segment, but two same-day same-route curr segments at equal distance (e.g. +2h and -2h)
    const prev = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        departureAt: '2026-10-01T12:00:00+01:00',
        flightNumber: '111',
      },
    ];
    const c1 = {
      ...baseSegment,
      supplierSegmentId: 'seg_new_1',
      flightNumber: '999',
      departureAt: '2026-10-01T10:00:00+01:00', // -2h
    };
    const c2 = {
      ...baseSegment,
      supplierSegmentId: 'seg_new_2',
      flightNumber: '999',
      departureAt: '2026-10-01T14:00:00+01:00', // +2h
    };

    matchSegments(prev, [c1, c2]);

    // Should not match Tier 3 due to ambiguity, but will it match Tier 4 (POSITION_MATCH)?
    // Wait, let's see. If we disable POSITION_MATCH for these, or if they have different globalOrders?
    // Let's check: if c1 has globalOrder 0, then prev (globalOrder 0) will match c1 via POSITION_MATCH.
    // If we want to test true ambiguity under Tier 3 without Tier 4 taking over, we can assign different globalOrders so Tier 4 doesn't match either.
    // E.g., prev has globalOrder 99. c1 has globalOrder 0, c2 has globalOrder 1.
    const prevAmbiguous = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        globalOrder: 99,
        departureAt: '2026-10-01T12:00:00+01:00',
        flightNumber: '111',
      },
    ];
    const resultAmbiguous = matchSegments(prevAmbiguous, [c1, c2]);

    expect(resultAmbiguous.matches).toHaveLength(0);
    expect(resultAmbiguous.removed).toHaveLength(1);
    expect(resultAmbiguous.added).toHaveLength(2);
  });

  it('should match using Position (Tier 4) when same-route segments are ambiguous', () => {
    const prev = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '111',
        globalOrder: 0,
        departureAt: '2026-10-01T10:00:00+01:00',
      },
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '222',
        globalOrder: 1,
        departureAt: '2026-10-01T14:00:00+01:00',
      },
    ];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '333',
        globalOrder: 0,
        departureAt: '2026-10-01T12:00:00+01:00',
      },
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '443',
        globalOrder: 1,
        departureAt: '2026-10-01T12:00:00+01:00',
      },
    ];

    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(2);
    expect(result.matches[0].method).toBe('POSITION_MATCH');
  });

  it('should not match using Position (Tier 4) if segments are in different slices or have unrelated routes', () => {
    const prev = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '111',
        globalOrder: 0,
        sliceOrder: 0,
        departureAirportIata: 'JFK',
        arrivalAirportIata: 'BOS',
        departureCity: 'New York',
        arrivalCity: 'Boston',
      },
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '222',
        globalOrder: 1,
        sliceOrder: 1,
        departureAirportIata: 'BOS',
        arrivalAirportIata: 'JFK',
        departureCity: 'Boston',
        arrivalCity: 'New York',
      },
    ];
    const curr = [
      {
        ...baseSegment,
        supplierSegmentId: null,
        flightNumber: '333',
        globalOrder: 0,
        sliceOrder: 1,
        departureAirportIata: 'CDG',
        arrivalAirportIata: 'BOM',
        departureCity: 'Paris',
        arrivalCity: 'Mumbai',
      },
    ];

    const result = matchSegments(prev, curr);

    expect(result.matches).toHaveLength(0);
    expect(result.removed).toHaveLength(2);
    expect(result.added).toHaveLength(1);
  });
});
