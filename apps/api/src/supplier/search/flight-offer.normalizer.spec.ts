import { DuffelOffer, DuffelPassenger, DuffelSlice } from '@/duffel/duffel.types';
// User approved 2026-10-04: additive supplier-boundary regression; existing normalization assertions remain unchanged.
import {
  generateDeterministicUUID as legacyGenerateDeterministicUUID,
  normalizeOffer as legacyNormalizeOffer,
} from '@/flights/flight-offer-normalizer';
import {
  FlightOfferNormalizer,
  generateDeterministicUUID,
  normalizeOffer,
  normalizeStoredOfferFacts,
  normalizeStoredOffer,
} from './flight-offer.normalizer';
import {
  FlightOffer,
  FlightSegment,
  FlightOfferPassenger,
  FlightOfferConditions,
} from './flight-search.port';

interface MockOfferOptions {
  id?: string;
  total_amount?: string;
  total_currency?: string;
  expires_at?: string | null;
  passengers?: DuffelPassenger[];
  slices?: DuffelSlice[];
  conditions?: {
    refund_before_departure?: {
      allowed: boolean;
      penalty_amount?: string | null;
      penalty_currency?: string | null;
    };
    change_before_departure?: {
      allowed: boolean;
      penalty_amount?: string | null;
      penalty_currency?: string | null;
    };
  };
}

type ExtendedDuffelOffer = DuffelOffer & {
  expires_at?: string | null;
  conditions?: {
    refund_before_departure?: {
      allowed: boolean;
      penalty_amount?: string | null;
      penalty_currency?: string | null;
    };
    change_before_departure?: {
      allowed: boolean;
      penalty_amount?: string | null;
      penalty_currency?: string | null;
    };
  };
};

function createSampleDuffelOffer(options: MockOfferOptions = {}): ExtendedDuffelOffer {
  return {
    id: options.id ?? 'off_sample_12345',
    total_amount: options.total_amount ?? '450.50',
    total_currency: options.total_currency ?? 'USD',
    passenger_identity_documents_required: false,
    expires_at: options.expires_at !== undefined ? options.expires_at : '2026-10-15T12:00:00Z',
    passengers: options.passengers ?? [
      { id: 'pas_adult_01', type: 'adult' },
      { id: 'pas_child_02', type: 'child' },
      { id: 'pas_infant_03', type: 'infant_without_seat' },
    ],
    slices: options.slices ?? [
      {
        id: 'sli_outbound_01',
        duration: 'PT5H30M',
        origin: {
          id: 'plc_sfo',
          name: 'San Francisco International Airport',
          iata_code: 'SFO',
          type: 'airport',
        },
        destination: {
          id: 'plc_jfk',
          name: 'John F Kennedy International Airport',
          iata_code: 'JFK',
          type: 'airport',
        },
        segments: [
          {
            id: 'seg_out_01',
            duration: 'PT2H30M',
            departing_at: '2026-10-01T08:00:00',
            arriving_at: '2026-10-01T10:30:00',
            origin: {
              id: 'plc_sfo',
              name: 'San Francisco International Airport',
              iata_code: 'SFO',
              type: 'airport',
            },
            origin_terminal: '2',
            destination: {
              id: 'plc_ord',
              name: "O'Hare International Airport",
              iata_code: 'ORD',
              type: 'airport',
            },
            destination_terminal: '1',
            marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: '101',
            aircraft: { id: 'arc_738', name: 'Boeing 737-800', iata_code: '738' },
            passengers: [
              {
                passenger_id: 'pas_adult_01',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
          {
            id: 'seg_out_02',
            duration: 'PT2H00M',
            departing_at: '2026-10-01T12:00:00',
            arriving_at: '2026-10-01T15:00:00',
            origin: {
              id: 'plc_ord',
              name: "O'Hare International Airport",
              iata_code: 'ORD',
              type: 'airport',
            },
            origin_terminal: '1',
            destination: {
              id: 'plc_jfk',
              name: 'John F Kennedy International Airport',
              iata_code: 'JFK',
              type: 'airport',
            },
            destination_terminal: '4',
            marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
            marketing_carrier_flight_number: '202',
            aircraft: { id: 'arc_320', name: 'Airbus A320', iata_code: '320' },
            passengers: [
              {
                passenger_id: 'pas_adult_01',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
    conditions: 'conditions' in options ? options.conditions : {
      refund_before_departure: { allowed: true },
      change_before_departure: {
        allowed: true,
        penalty_amount: '50.00',
        penalty_currency: 'USD',
      },
    },
  };
}

function createSampleRoundTripDuffelOffer(): ExtendedDuffelOffer {
  const oneWay = createSampleDuffelOffer();
  const returnSlice: DuffelSlice = {
    id: 'sli_return_01',
    duration: 'PT5H00M',
    origin: {
      id: 'plc_jfk',
      name: 'John F Kennedy International Airport',
      iata_code: 'JFK',
      type: 'airport',
    },
    destination: {
      id: 'plc_sfo',
      name: 'San Francisco International Airport',
      iata_code: 'SFO',
      type: 'airport',
    },
    segments: [
      {
        id: 'seg_ret_01',
        duration: 'PT5H00M',
        departing_at: '2026-10-10T10:00:00',
        arriving_at: '2026-10-10T13:00:00',
        origin: {
          id: 'plc_jfk',
          name: 'John F Kennedy International Airport',
          iata_code: 'JFK',
          type: 'airport',
        },
        origin_terminal: '4',
        destination: {
          id: 'plc_sfo',
          name: 'San Francisco International Airport',
          iata_code: 'SFO',
          type: 'airport',
        },
        destination_terminal: '2',
        marketing_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
        operating_carrier: { id: 'arl_ua', name: 'United Airlines', iata_code: 'UA' },
        marketing_carrier_flight_number: '303',
        aircraft: { id: 'arc_777', name: 'Boeing 777-200', iata_code: '777' },
        passengers: [
          {
            passenger_id: 'pas_adult_01',
            cabin_class: 'economy',
            baggages: [{ type: 'checked', quantity: 1 }],
          },
        ],
      },
    ],
  };

  return {
    ...oneWay,
    slices: [oneWay.slices[0], returnSlice],
  };
}

describe('FlightOfferNormalizer (T014)', () => {
  let normalizer: FlightOfferNormalizer;

  beforeEach(() => {
    normalizer = new FlightOfferNormalizer();
  });

  describe('a. Deterministic UUID parity', () => {
    const sampleIds = [
      'off_00001',
      'off_sample_12345',
      'off_unique_999',
      'off_roundtrip_test',
      'off_xyz_987654321',
      'test-random-uuid-parity',
    ];

    it.each(sampleIds)(
      'generates deterministic UUID matching legacy normalizer exactly for %s',
      (offerId) => {
        const expected = legacyGenerateDeterministicUUID(offerId);
        const actualInstance = normalizer.generateDeterministicUUID(offerId);
        const actualStatic = FlightOfferNormalizer.generateDeterministicUUID(offerId);
        const actualExport = generateDeterministicUUID(offerId);

        expect(actualInstance).toBe(expected);
        expect(actualStatic).toBe(expected);
        expect(actualExport).toBe(expected);
      },
    );

    it.each(sampleIds)('matches RFC 4122 v4 pattern for %s', (offerId) => {
      const rfc4122V4Pattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const uuid = normalizer.generateDeterministicUUID(offerId);

      expect(uuid).toMatch(rfc4122V4Pattern);
    });

    it('produces identical UUID across multiple invocations with same input (idempotence)', () => {
      const input = 'off_idempotence_check_123';
      const first = normalizer.generateDeterministicUUID(input);
      const second = normalizer.generateDeterministicUUID(input);

      expect(first).toBe(second);
    });

    it('produces distinct UUIDs for distinct input strings', () => {
      const uuidA = normalizer.generateDeterministicUUID('off_first_id');
      const uuidB = normalizer.generateDeterministicUUID('off_second_id');

      expect(uuidA).not.toBe(uuidB);
    });
  });

  describe('b. Live offer normalization (normalizeOffer)', () => {
    it('normalizes a live one-way DuffelOffer into a complete FlightOffer', () => {
      const rawOffer = createSampleDuffelOffer();
      const originalIndex = 3;
      const requestedCabin = 'economy';

      const result = normalizer.normalizeOffer(rawOffer, requestedCabin, originalIndex);

      expect(result).not.toBeNull();
      const offer = result as FlightOffer;

      // Identity
      expect(offer.id).toBe(legacyGenerateDeterministicUUID(rawOffer.id));
      expect(offer.supplierOfferId).toBe(rawOffer.id);

      // Amounts and currencies
      expect(offer.totalAmount).toBe('450.50');
      expect(offer.price).toBe(450.5);
      expect(offer.currency).toBe('USD');
      expect(offer.offerExpiresAt).toBe('2026-10-15T12:00:00Z');

      // Passenger mapping: uppercase type, supplierPassengerId = p.id
      expect(offer.passengers).toHaveLength(3);
      const expectedPassengers: readonly FlightOfferPassenger[] = [
        { supplierPassengerId: 'pas_adult_01', type: 'ADULT' },
        { supplierPassengerId: 'pas_child_02', type: 'CHILD' },
        { supplierPassengerId: 'pas_infant_03', type: 'INFANT' },
      ];
      expect(offer.passengers).toEqual(expectedPassengers);

      // Top-level flight summary facts
      expect(offer.airline).toBe('United Airlines');
      expect(offer.flightNumber).toBe('UA101');
      expect(offer.departureAirport).toBe('SFO');
      expect(offer.arrivalAirport).toBe('JFK');
      expect(offer.departureTime).toBe('2026-10-01T08:00:00');
      expect(offer.arrivalTime).toBe('2026-10-01T15:00:00');
      expect(offer.duration).toBe(330);
      expect(offer.stops).toBe(1); // 2 segments on outbound slice = 1 stop
      expect(offer.fareClass).toBe('Economy');
      expect(offer.baggageAllowance).toBe('1 checked bag(s)');

      // Outbound segments
      expect(offer.segments).toHaveLength(2);
      const seg1 = offer.segments[0];
      expect(seg1.supplierSegmentId).toBe('seg_out_01');
      expect(seg1.carrierCode).toBe('UA');
      expect(seg1.flightNumber).toBe('101');
      expect(seg1.operatingCarrier).toBe('United Airlines');
      expect(seg1.departureAirport).toBe('SFO');
      expect(seg1.departureTerminal).toBe('2');
      expect(seg1.departureTime).toBe('2026-10-01T08:00:00');
      expect(seg1.arrivalAirport).toBe('ORD');
      expect(seg1.arrivalTerminal).toBe('1');
      expect(seg1.arrivalTime).toBe('2026-10-01T10:30:00');
      expect(seg1.duration).toBe(150);
      expect(seg1.aircraft).toBe('Boeing 737-800');
      expect(seg1.cabinClass).toBe('economy');

      const seg2 = offer.segments[1];
      expect(seg2.supplierSegmentId).toBe('seg_out_02');
      expect(seg2.carrierCode).toBe('UA');
      expect(seg2.flightNumber).toBe('202');
      expect(seg2.departureAirport).toBe('ORD');
      expect(seg2.arrivalAirport).toBe('JFK');
      expect(seg2.duration).toBe(120);
      expect(seg2.aircraft).toBe('Airbus A320');
      expect(seg2.cabinClass).toBe('economy');

      // One-way returns null for returnSegments
      expect(offer.returnSegments).toBeNull();

      // Conditions
      const expectedConditions: FlightOfferConditions = {
        refundable: true,
        changeable: true,
        changeBeforeDeparture: {
          allowed: true,
          penaltyAmount: '50.00',
          penaltyCurrency: 'USD',
        },
      };
      expect(offer.conditions).toEqual(expectedConditions);

      // matchInput parity: verify 100% equivalence to legacy FlightMatchInput
      const legacyMatch = legacyNormalizeOffer(rawOffer, originalIndex);
      expect(legacyMatch).not.toBeNull();
      expect(offer.matchInput).toEqual(legacyMatch);

      // Verify specific matchInput properties
      expect(offer.matchInput.id).toBe(offer.id);
      expect(offer.matchInput.price).toBe(450.5);
      expect(offer.matchInput.currency).toBe('USD');
      expect(offer.matchInput.stops).toBe(1);
      expect(offer.matchInput.duration).toBe(330);
      expect(offer.matchInput.outboundDepartureHour).toBe(8);
      expect(offer.matchInput.outboundArrivalHour).toBe(15);
      expect(offer.matchInput.carrierCodes).toEqual(['UA']);
      expect(offer.matchInput.cabinClass).toBe('economy');
      expect(offer.matchInput.hasCheckedBaggage).toBe(true);
      expect(offer.matchInput.originalIndex).toBe(originalIndex);

      // rawSupplierPayload preserves exact raw object
      expect(offer.rawSupplierPayload).toBe(rawOffer);
    });

    it('normalizes round-trip offers with returnSegments populated from slice[1]', () => {
      const rawRoundTrip = createSampleRoundTripDuffelOffer();
      const result = normalizer.normalizeOffer(rawRoundTrip, 'economy', 0);

      expect(result).not.toBeNull();
      const offer = result as FlightOffer;

      expect(offer.returnSegments).not.toBeNull();
      expect(offer.returnSegments).toHaveLength(1);
      const retSeg = (offer.returnSegments as readonly FlightSegment[])[0];
      expect(retSeg.supplierSegmentId).toBe('seg_ret_01');
      expect(retSeg.carrierCode).toBe('UA');
      expect(retSeg.flightNumber).toBe('303');
      expect(retSeg.departureAirport).toBe('JFK');
      expect(retSeg.departureTerminal).toBe('4');
      expect(retSeg.arrivalAirport).toBe('SFO');
      expect(retSeg.arrivalTerminal).toBe('2');
      expect(retSeg.duration).toBe(300);
      expect(retSeg.aircraft).toBe('Boeing 777-200');
    });

    it('handles offers with missing conditions gracefully', () => {
      const rawOffer = createSampleDuffelOffer({ conditions: undefined });
      const result = normalizer.normalizeOffer(rawOffer, 'economy', 0);

      expect(result).not.toBeNull();
      const offer = result as FlightOffer;
      expect(offer.conditions.refundable).toBe(false);
      expect(offer.conditions.changeable).toBe(false);
      expect(offer.conditions.changeBeforeDeparture).toBeNull();
    });

    it('works via static normalizeOffer and exported function', () => {
      const rawOffer = createSampleDuffelOffer();
      const staticResult = FlightOfferNormalizer.normalizeOffer(rawOffer, 'economy', 1);
      const exportResult = normalizeOffer(rawOffer, 'economy', 1);

      expect(staticResult).not.toBeNull();
      expect(exportResult).not.toBeNull();
      expect(staticResult?.id).toBe(exportResult?.id);
    });
  });

  // Stored snapshots use exact passenger types, as required by the legacy readers.
  function createSampleStoredOffer(): ExtendedDuffelOffer {
    return createSampleDuffelOffer({
      passengers: [
        { id: 'pas_adult_01', type: 'adult' },
        { id: 'pas_child_02', type: 'child' },
        { id: 'pas_infant_03', type: 'infant' },
      ],
    });
  }

  describe('c. Legacy stored offer normalization (normalizeStoredOffer)', () => {
    it('normalizes route and arrival facts from partial stored evidence', () => {
      const partialSnapshot = {
        slices: [{
          segments: [{
            origin: { countryCode: 'GB' },
            destination: { iata_country_code: 'US' },
            arrivalDate: '2026-09-10T12:00:00',
          }],
        }],
      };

      expect(normalizeStoredOfferFacts(partialSnapshot)).toEqual({
        travelScope: 'INTERNATIONAL',
        tripCompletionDate: '2026-09-10',
        offerExpiresAt: null,
      });
    });

    it('preserves partial fact aliases and latest valid arrival date prefix', () => {
      const partialSnapshot = {
        expires_at: null,
        expiresAt: '2026-08-20T00:00:00Z',
        slices: [{
          segments: [
            {
              origin: { iata_country_code: 'GB' },
              destination: { countryCode: 'JP' },
              arriving_at: '2026-08-01T15:00:00Z',
            },
            {
              origin: { countryCode: 'JP' },
              destination: { iata_country_code: 'GB' },
              arrivalDate: '2026-08-10T15:00:00Z',
            },
            {
              origin: { countryCode: 'GB' },
              destination: { countryCode: 'JP' },
              arrivingAt: '2026-08-15 legacy timestamp',
            },
            {
              origin: { countryCode: 'GB' },
              destination: { countryCode: 'JP' },
              arriving_at: '2026-02-30T15:00:00Z',
            },
          ],
        }],
      };

      expect(normalizeStoredOfferFacts(partialSnapshot)).toEqual({
        travelScope: 'INTERNATIONAL',
        tripCompletionDate: '2026-08-15',
        offerExpiresAt: '2026-08-20T00:00:00Z',
      });
    });

    it('keeps array-backed missing route facts domestic but absent slices null', () => {
      expect(normalizeStoredOfferFacts({ slices: [] })).toEqual({
        travelScope: 'DOMESTIC',
        tripCompletionDate: null,
        offerExpiresAt: null,
      });
      expect(normalizeStoredOfferFacts({})).toEqual({
        travelScope: null,
        tripCompletionDate: null,
        offerExpiresAt: null,
      });
    });

    it('normalizes legacy country and arrival aliases into international return-trip facts', () => {
      const storedSnapshot = {
        id: 'off_legacy_round_trip',
        total_amount: '100.00',
        total_currency: 'USD',
        passengers: [{ id: 'pas_adult_1', type: 'adult' }],
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN', countryCode: 'VN' },
                destination: { iata_code: 'NRT', countryCode: 'JP' },
                departing_at: '2026-08-01T08:00:00Z',
                arrivalDate: '2026-08-01T15:00:00Z',
              },
            ],
          },
          {
            segments: [
              {
                origin: { iata_code: 'NRT', countryCode: 'JP' },
                destination: { iata_code: 'SGN', countryCode: 'VN' },
                departing_at: '2026-08-10T08:00:00Z',
                arrivingAt: '2026-08-10T15:00:00Z',
              },
            ],
          },
        ],
      };

      const result = normalizeStoredOffer(storedSnapshot);

      expect(result).toEqual(
        expect.objectContaining({
          travelScope: 'INTERNATIONAL',
          tripCompletionDate: '2026-08-10',
        }),
      );
    });

    it('normalizes the legacy stored expiry alias', () => {
      const storedSnapshot = {
        id: 'off_legacy_expiry',
        total_amount: '100.00',
        total_currency: 'USD',
        expiresAt: '2026-08-20T00:00:00Z',
        passengers: [{ id: 'pas_adult_1', type: 'adult' }],
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'NRT' },
                departing_at: '2026-08-01T08:00:00Z',
                arriving_at: '2026-08-01T15:00:00Z',
              },
            ],
          },
        ],
      };

      expect(normalizeStoredOffer(storedSnapshot)?.offerExpiresAt).toBe(
        '2026-08-20T00:00:00Z',
      );
    });

    it('normalizes airport codes across outbound and return segments without changing the snapshot', () => {
      const storedSnapshot = createSampleStoredOffer();
      storedSnapshot.slices.push(createSampleRoundTripDuffelOffer().slices[1]);
      const expectedCodes = storedSnapshot.slices.map((slice) =>
        slice.segments.map((segment) => ({
          departureAirport: segment.origin.iata_code,
          arrivalAirport: segment.destination.iata_code,
        })),
      );
      for (const slice of storedSnapshot.slices) {
        for (const segment of slice.segments) {
          segment.origin.iata_code = ` ${segment.origin.iata_code.toLowerCase()} `;
          segment.destination.iata_code = ` ${segment.destination.iata_code.toLowerCase()} `;
        }
      }
      const originalSnapshot = structuredClone(storedSnapshot);

      const result = normalizer.normalizeStoredOffer(storedSnapshot);

      expect(result).not.toBeNull();
      expect(result?.departureAirport).toBe(expectedCodes[0][0].departureAirport);
      expect(result?.arrivalAirport).toBe(expectedCodes[0][expectedCodes[0].length - 1].arrivalAirport);
      expect(result?.segments).toMatchObject(expectedCodes[0]);
      expect(result?.returnSegments).toMatchObject(expectedCodes[1]);
      expect(result?.rawSupplierPayload).toBe(storedSnapshot);
      expect(storedSnapshot).toEqual(originalSnapshot);
    });

    it.each([' ADULT ', ' Child ', ' InFaNt '])('accepts the exact passenger type %s after normalization', (type) => {
      const result = normalizer.normalizeStoredOffer({
        ...createSampleStoredOffer(),
        passengers: [{ id: 'pas_01', type }],
      });

      expect(result?.passengers).toEqual([{ supplierPassengerId: 'pas_01', type: type.trim().toUpperCase() }]);
    });

    it.each(['origin', 'destination'] as const)('rejects malformed %s codes in every slice', (endpoint) => {
      for (const code of ['', '  ', 'SF', 'SFOO', 'S1O', 'S-O', 'S F', 'éab', 123, null]) {
        for (const sliceIndex of [0, 1]) {
          const storedSnapshot = createSampleStoredOffer();
          storedSnapshot.slices.push(createSampleRoundTripDuffelOffer().slices[1]);
          const segment = storedSnapshot.slices[sliceIndex].segments[0];
          Object.assign(segment[endpoint], { iata_code: code });
          expect(normalizer.normalizeStoredOffer(storedSnapshot)).toBeNull();
        }
      }
    });

    it.each(['adult_extra', 'childish', 'infant_without_seat', ' INFANT_WITHOUT_SEAT ', 'unknown'])('rejects the noncanonical passenger type %s', (type) => {
      expect(normalizer.normalizeStoredOffer({
        ...createSampleStoredOffer(),
        passengers: [{ id: 'pas_01', type }],
      })).toBeNull();
    });

    it('decodes a valid legacy stored JSON snapshot into a FlightOffer', () => {
      const storedSnapshot = createSampleStoredOffer();

      const result = normalizer.normalizeStoredOffer(storedSnapshot);

      expect(result).not.toBeNull();
      const offer = result as FlightOffer;

      expect(offer.id).toBe(
        legacyGenerateDeterministicUUID(storedSnapshot.id),
      );
      expect(offer.supplierOfferId).toBe(storedSnapshot.id);
      expect(offer.passengers.length).toBeGreaterThan(0);
      expect(offer.segments.length).toBeGreaterThan(0);
      expect(offer.conditions).toBeDefined();
      expect(offer.matchInput).toBeDefined();
      expect(offer.rawSupplierPayload).toBe(storedSnapshot);
    });

    it('decodes stored snapshot via static method and exported function', () => {
      const storedSnapshot = createSampleStoredOffer();
      const staticResult = FlightOfferNormalizer.normalizeStoredOffer(storedSnapshot);
      const exportResult = normalizeStoredOffer(storedSnapshot);

      expect(staticResult).not.toBeNull();
      expect(exportResult).not.toBeNull();
      expect(staticResult?.id).toBe(exportResult?.id);
    });
  });

  describe('d. Fail-closed behavior (normalizeStoredOffer returns null without throwing)', () => {
    it('returns null for null, undefined, or empty object', () => {
      expect(normalizer.normalizeStoredOffer(null)).toBeNull();
      expect(normalizer.normalizeStoredOffer(undefined)).toBeNull();
      expect(normalizer.normalizeStoredOffer({})).toBeNull();
    });

    it('returns null for non-object primitives', () => {
      expect(normalizer.normalizeStoredOffer('not-an-object')).toBeNull();
      expect(normalizer.normalizeStoredOffer(12345)).toBeNull();
      expect(normalizer.normalizeStoredOffer(true)).toBeNull();
      expect(normalizer.normalizeStoredOffer(false)).toBeNull();
      expect(normalizer.normalizeStoredOffer(Symbol('test'))).toBeNull();
    });

    it('returns null for missing or empty slices array', () => {
      const base = createSampleStoredOffer();
      expect(normalizer.normalizeStoredOffer({ ...base, slices: undefined })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, slices: [] })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, slices: 'not-an-array' })).toBeNull();
    });

    it('returns null for slices with empty or missing segments array', () => {
      const base = createSampleStoredOffer();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          slices: [{ ...base.slices[0], segments: [] }],
        }),
      ).toBeNull();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          slices: [{ ...base.slices[0], segments: undefined }],
        }),
      ).toBeNull();
    });

    it('returns null for segments missing origin or destination', () => {
      const baseMissingOrigin = createSampleStoredOffer();
      const badSegOrigin = { ...baseMissingOrigin.slices[0].segments[0], origin: undefined };
      expect(
        normalizer.normalizeStoredOffer({
          ...baseMissingOrigin,
          slices: [{ ...baseMissingOrigin.slices[0], segments: [badSegOrigin] }],
        }),
      ).toBeNull();

      const baseMissingDest = createSampleStoredOffer();
      const badSegDest = { ...baseMissingDest.slices[0].segments[0], destination: undefined };
      expect(
        normalizer.normalizeStoredOffer({
          ...baseMissingDest,
          slices: [{ ...baseMissingDest.slices[0], segments: [badSegDest] }],
        }),
      ).toBeNull();
    });

    it('returns null for segments with invalid ISO timestamps', () => {
      const baseBadDepart = createSampleStoredOffer();
      const badDepartSeg = {
        ...baseBadDepart.slices[0].segments[0],
        departing_at: 'invalid-iso-timestamp',
      };
      expect(
        normalizer.normalizeStoredOffer({
          ...baseBadDepart,
          slices: [{ ...baseBadDepart.slices[0], segments: [badDepartSeg] }],
        }),
      ).toBeNull();

      const baseBadArrival = createSampleStoredOffer();
      const badArrivalSeg = {
        ...baseBadArrival.slices[0].segments[0],
        arriving_at: '2026-13-45T99:99:99',
      };
      expect(
        normalizer.normalizeStoredOffer({
          ...baseBadArrival,
          slices: [{ ...baseBadArrival.slices[0], segments: [badArrivalSeg] }],
        }),
      ).toBeNull();
    });

    it('returns null for missing or empty passengers array', () => {
      const base = createSampleStoredOffer();
      expect(normalizer.normalizeStoredOffer({ ...base, passengers: undefined })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, passengers: [] })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, passengers: 'not-an-array' })).toBeNull();
    });

    it('returns null for passengers with missing id or invalid type', () => {
      const base = createSampleStoredOffer();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          passengers: [{ id: '', type: 'adult' }],
        }),
      ).toBeNull();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          passengers: [{ id: 'pas_01', type: '' }],
        }),
      ).toBeNull();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          passengers: [{ id: 'pas_01', type: 12345 }],
        }),
      ).toBeNull();
    });

    it('returns null for missing or non-numeric total_amount', () => {
      const base = createSampleStoredOffer();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: undefined })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: '' })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: '0' })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: '-50.00' })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: 'NaN' })).toBeNull();
      expect(
        normalizer.normalizeStoredOffer({ ...base, total_amount: 'not-a-number' }),
      ).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_amount: 450.5 })).toBeNull();
    });

    it('returns null for missing or empty total_currency', () => {
      const base = createSampleStoredOffer();
      expect(normalizer.normalizeStoredOffer({ ...base, total_currency: undefined })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_currency: '' })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_currency: '   ' })).toBeNull();
      expect(normalizer.normalizeStoredOffer({ ...base, total_currency: 123 })).toBeNull();
    });

    it('returns null for stored offers with duplicate passenger ids', () => {
      const base = createSampleStoredOffer();
      expect(
        normalizer.normalizeStoredOffer({
          ...base,
          passengers: [
            { id: 'pas_dup', type: 'adult' },
            { id: 'pas_dup', type: 'child' },
          ],
        }),
      ).toBeNull();
    });
  });
});
