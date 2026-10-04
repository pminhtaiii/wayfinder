// User approved on 2026-10-03: internal fixture names match the domain rename.
// Values and scenarios are unchanged.
import { computeItineraryDiff } from './itinerary-diff';
import { NormalizedSegment } from './itinerary-normalizer';

describe('ItineraryDiff', () => {
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

  it('should detect segment time shifts, terminal, and aircraft changes', () => {
    const prev = [baseSegment];
    const curr: NormalizedSegment[] = [
      {
        ...baseSegment,
        departureAt: '2026-10-01T10:30:00+01:00', // shifted by +30m
        arrivalAt: '2026-10-01T14:15:00-04:00', // shifted by +45m
        departureTerminal: '3', // terminal changed
        aircraftType: 'Boeing 787', // aircraft changed
      },
    ];

    const result = computeItineraryDiff(prev, curr);

    expect(result.segmentDiffs).toHaveLength(1);
    expect(result.segmentDiffs[0]).toEqual({
      globalOrder: 0,
      supplierSegmentId: 'seg_1',
      departureAirportChanged: false,
      arrivalAirportChanged: false,
      departureLocalDateChanged: false,
      arrivalLocalDateChanged: false,
      departureTimeShiftMinutes: 30,
      arrivalTimeShiftMinutes: 45,
      departureTerminalChanged: true,
      arrivalTerminalChanged: false,
      aircraftTypeChanged: true,
    });
  });

  it('should detect final arrival shift for a slice', () => {
    // 2-segment connection: LHR -> JFK -> MIA.
    // In baseline, final arrival at MIA is 18:00.
    // In current, final arrival at MIA is 19:30 (shift +90m).
    const prev1 = {
      ...baseSegment,
      supplierSegmentId: 'seg_1',
      sliceOrder: 0,
      segmentOrder: 0,
      globalOrder: 0,
    };
    const prev2 = {
      ...baseSegment,
      supplierSegmentId: 'seg_2',
      sliceOrder: 0,
      segmentOrder: 1,
      globalOrder: 1,
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
      departureAt: '2026-10-01T15:00:00-04:00',
      arrivalAt: '2026-10-01T18:00:00-04:00',
    };

    const curr1 = { ...prev1 };
    const curr2 = {
      ...prev2,
      arrivalAt: '2026-10-01T19:30:00-04:00', // final arrival moved by 90 minutes
    };

    const result = computeItineraryDiff([prev1, prev2], [curr1, curr2]);

    expect(result.sliceDiffs).toHaveLength(1);
    expect(result.sliceDiffs[0].sliceOrder).toBe(0);
    expect(result.sliceDiffs[0].finalArrivalShiftMinutes).toBe(90);
  });

  it('should calculate connection times, MCT violations, overlaps, and overnight connections', () => {
    // Segment 1: arrives at JFK on 13:30.
    // Segment 2: departs JFK on 14:00 (connection time: 30m, which is below MCT [60m]).
    const prev1 = {
      ...baseSegment,
      supplierSegmentId: 'seg_1',
      sliceOrder: 0,
      segmentOrder: 0,
      globalOrder: 0,
    };
    const prev2 = {
      ...baseSegment,
      supplierSegmentId: 'seg_2',
      sliceOrder: 0,
      segmentOrder: 1,
      globalOrder: 1,
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
      departureAt: '2026-10-01T15:00:00-04:00', // connection time is 90 mins (safe)
      arrivalAt: '2026-10-01T18:00:00-04:00',
    };

    const curr1 = { ...prev1 };
    const curr2 = {
      ...prev2,
      departureAt: '2026-10-01T14:00:00-04:00', // connection time becomes 30 minutes! (MCT violation)
    };

    const result = computeItineraryDiff([prev1, prev2], [curr1, curr2]);

    expect(result.connectionDiffs).toHaveLength(1);
    expect(result.connectionDiffs[0]).toEqual({
      sliceOrder: 0,
      prevConnectionMinutes: 90,
      currConnectionMinutes: 30,
      isBelowMct: true,
      isOverlapping: false,
      isOvernightIntroduced: false,
    });
  });

  it('should detect negative overlapping connection time', () => {
    const prev1 = {
      ...baseSegment,
      supplierSegmentId: 'seg_1',
      sliceOrder: 0,
      segmentOrder: 0,
      globalOrder: 0,
    };
    const prev2 = {
      ...baseSegment,
      supplierSegmentId: 'seg_2',
      sliceOrder: 0,
      segmentOrder: 1,
      globalOrder: 1,
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
      departureAt: '2026-10-01T15:00:00-04:00',
      arrivalAt: '2026-10-01T18:00:00-04:00',
    };

    const curr1 = { ...prev1 };
    const curr2 = {
      ...prev2,
      departureAt: '2026-10-01T13:00:00-04:00', // departs before arrival of curr1 (13:30) -> overlap!
    };

    const result = computeItineraryDiff([prev1, prev2], [curr1, curr2]);
    expect(result.connectionDiffs[0].isOverlapping).toBe(true);
    expect(result.connectionDiffs[0].currConnectionMinutes).toBe(-30);
  });

  it('should detect overnight connection introduced', () => {
    // Prev:
    // Seg 1: LHR->JFK (arr 10-01 13:30)
    // Seg 2: JFK->MIA (dep 10-01 15:00) -> same day connection
    const prev1 = {
      ...baseSegment,
      supplierSegmentId: 'seg_1',
      sliceOrder: 0,
      segmentOrder: 0,
      globalOrder: 0,
    };
    const prev2 = {
      ...baseSegment,
      supplierSegmentId: 'seg_2',
      sliceOrder: 0,
      segmentOrder: 1,
      globalOrder: 1,
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
      departureAt: '2026-10-01T15:00:00-04:00',
      departureLocalDate: '2026-10-01',
    };

    // Curr:
    // Seg 1: LHR->JFK (arr 10-01 13:30)
    // Seg 2: JFK->MIA (dep 10-02 09:00) -> overnight connection!
    const curr1 = { ...prev1 };
    const curr2 = {
      ...prev2,
      departureAt: '2026-10-02T09:00:00-04:00',
      departureLocalDate: '2026-10-02',
    };

    const result = computeItineraryDiff([prev1, prev2], [curr1, curr2]);
    expect(result.connectionDiffs[0].isOvernightIntroduced).toBe(true);
  });

  it('should detect slice routing changes', () => {
    const prev = [baseSegment];
    const curr = [
      {
        ...baseSegment,
        departureAirportIata: 'LGW', // Routing changed!
      },
    ];

    const result = computeItineraryDiff(prev, curr);
    expect(result.isRoutingChanged).toBe(true);
    expect(result.sliceDiffs[0].isRoutingChanged).toBe(true);
  });

  it('should build a safe presentation summary for the UI', () => {
    const prev = [baseSegment];
    const curr = [
      {
        ...baseSegment,
        departureAt: '2026-10-01T10:30:00+01:00',
        arrivalAt: '2026-10-01T14:00:00-04:00',
      },
    ];

    const result = computeItineraryDiff(prev, curr);
    expect(result.presentationSummary).toEqual({
      isRoutingChanged: false,
      hasStopsChanged: false,
      addedSegmentsCount: 0,
      removedSegmentsCount: 0,
      sliceSummaries: [
        {
          sliceOrder: 0,
          originIata: 'LHR',
          destinationIata: 'JFK',
          finalArrivalShiftMinutes: 30,
        },
      ],
    });
  });
});
