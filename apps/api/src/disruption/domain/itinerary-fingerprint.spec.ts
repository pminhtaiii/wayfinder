// User approved on 2026-10-03: internal fixture names match the domain rename.
// Values and scenarios are unchanged.
import { generateItineraryFingerprint } from './itinerary-fingerprint';
import { NormalizedSegment } from './itinerary-normalizer';

describe('ItineraryFingerprint', () => {
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

  it('should generate same fingerprint for identical itineraries', () => {
    const fp1 = generateItineraryFingerprint([baseSegment]);
    const fp2 = generateItineraryFingerprint([{ ...baseSegment }]);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^v1_[a-f0-9]{64}$/);
  });

  it('should ignore volatile and display-only fields', () => {
    const fp1 = generateItineraryFingerprint([baseSegment]);
    const alteredSegment: NormalizedSegment = {
      ...baseSegment,
      supplierSegmentId: 'seg_different_id_999',
      airlineName: 'BA flights',
      departureAirportName: 'Heathrow Airport Terminal 5',
      arrivalAirportName: 'JFK Intl',
      departureCity: 'London City',
      arrivalCity: 'NYC',
    };
    const fp2 = generateItineraryFingerprint([alteredSegment]);
    expect(fp1).toBe(fp2);
  });

  it('should change fingerprint if a canonical field changes', () => {
    const fpBase = generateItineraryFingerprint([baseSegment]);

    const fpTimeChange = generateItineraryFingerprint([
      {
        ...baseSegment,
        departureAt: '2026-10-01T10:05:00+01:00',
      },
    ]);
    expect(fpBase).not.toBe(fpTimeChange);

    const fpFlightChange = generateItineraryFingerprint([
      {
        ...baseSegment,
        flightNumber: '178',
      },
    ]);
    expect(fpBase).not.toBe(fpFlightChange);

    const fpAirportChange = generateItineraryFingerprint([
      {
        ...baseSegment,
        departureAirportIata: 'LGW',
      },
    ]);
    expect(fpBase).not.toBe(fpAirportChange);

    const fpTerminalChange = generateItineraryFingerprint([
      {
        ...baseSegment,
        departureTerminal: '3',
      },
    ]);
    expect(fpBase).not.toBe(fpTerminalChange);
  });

  it('should be key-order independent', () => {
    // Segment with a different property definition order
    const rearrangedSegment = {
      arrivalLocalDate: '2026-10-01',
      departureLocalDate: '2026-10-01',
      durationMinutes: 510,
      departureTerminal: '5',
      departureAt: '2026-10-01T10:00:00+01:00',
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
      arrivalAirportIata: 'JFK',
      arrivalAirportName: 'John F. Kennedy',
      arrivalCity: 'New York',
      arrivalTerminal: '4',
      arrivalAt: '2026-10-01T13:30:00-04:00',
      aircraftType: 'Boeing 777',
    } as NormalizedSegment;

    const fp1 = generateItineraryFingerprint([baseSegment]);
    const fp2 = generateItineraryFingerprint([rearrangedSegment]);
    expect(fp1).toBe(fp2);
  });

  it('should be segment-order sensitive', () => {
    const segment2 = {
      ...baseSegment,
      globalOrder: 1,
      segmentOrder: 1,
      departureAirportIata: 'JFK',
      arrivalAirportIata: 'MIA',
    };

    const fpA = generateItineraryFingerprint([baseSegment, segment2]);
    const fpB = generateItineraryFingerprint([segment2, baseSegment]);
    expect(fpA).not.toBe(fpB);
  });
});
