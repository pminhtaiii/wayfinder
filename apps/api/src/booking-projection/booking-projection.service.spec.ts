import {
  BookingProjectionService,
  MalformedRevisionError,
  SafeBookingProjectionData,
} from './booking-projection.service';

describe('BookingProjectionService', () => {
  let service: BookingProjectionService;

  beforeEach(() => {
    service = new BookingProjectionService();
  });

  describe('Standard extraction from latest active revision with ordered segments', () => {
    it('extracts flight data from active itinerary revision with ordered segments', () => {
      const depDate = new Date('2026-10-01T10:00:00.000Z');
      const arrDate = new Date('2026-10-01T16:30:00.000Z');

      const booking = {
        itineraryRevisions: [
          {
            version: 2,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'LHR',
                arrivalAirportIata: 'CDG',
                departureAt: depDate,
                arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
                airlineName: 'British Airways',
                marketingCarrierIata: 'BA',
                flightNumber: '304',
              },
              {
                globalOrder: 1,
                departureAirportIata: 'CDG',
                arrivalAirportIata: 'DXB',
                departureAt: new Date('2026-10-01T13:30:00.000Z'),
                arrivalAt: arrDate,
                airlineName: 'Air France',
                marketingCarrierIata: 'AF',
                flightNumber: '662',
              },
            ],
          },
        ],
        flightSnapshot: null,
      };

      const result = service.extractProjectionData(booking);

      expect(result).not.toBeNull();
      expect(result).toEqual<SafeBookingProjectionData>({
        airline: 'British Airways',
        origin: 'LHR',
        destination: 'DXB',
        departureAt: depDate,
        arrivalAt: arrDate,
        durationMinutes: 390,
        stopCount: 1,
        flightNumber: 'BA 304',
        baggageSummary: null,
        refundable: null,
        changeable: null,
      });
    });

    it('orders segments by globalOrder ascending before extracting boundary endpoints', () => {
      const seg1Dep = new Date('2026-10-01T08:00:00.000Z');
      const seg2Arr = new Date('2026-10-01T18:00:00.000Z');

      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            // Out of order in input array
            segments: [
              {
                globalOrder: 1,
                departureAirportIata: 'DOH',
                arrivalAirportIata: 'BKK',
                departureAt: new Date('2026-10-01T14:00:00.000Z'),
                arrivalAt: seg2Arr,
                airlineName: 'Qatar Airways',
                marketingCarrierIata: 'QR',
                flightNumber: '830',
              },
              {
                globalOrder: 0,
                departureAirportIata: 'LHR',
                arrivalAirportIata: 'DOH',
                departureAt: seg1Dep,
                arrivalAt: new Date('2026-10-01T12:00:00.000Z'),
                airlineName: 'Qatar Airways',
                marketingCarrierIata: 'QR',
                flightNumber: '10',
              },
            ],
          },
        ],
        flightSnapshot: null,
      };

      const result = service.extractProjectionData(booking);
      expect(result).not.toBeNull();
      expect(result?.origin).toBe('LHR');
      expect(result?.destination).toBe('BKK');
      expect(result?.departureAt).toEqual(seg1Dep);
      expect(result?.arrivalAt).toEqual(seg2Arr);
      expect(result?.durationMinutes).toBe(600);
      expect(result?.flightNumber).toBe('QR 10');
    });

    it('extracts latest revision when multiple revisions are present', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 2,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'JFK',
                arrivalAirportIata: 'LAX',
                departureAt: new Date('2026-11-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-11-01T16:00:00.000Z'),
                airlineName: 'Delta Air Lines',
                marketingCarrierIata: 'DL',
                flightNumber: '100',
              },
            ],
          },
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'JFK',
                arrivalAirportIata: 'SFO',
                departureAt: new Date('2026-11-01T08:00:00.000Z'),
                arrivalAt: new Date('2026-11-01T14:00:00.000Z'),
                airlineName: 'Old Airline',
                flightNumber: '999',
              },
            ],
          },
        ],
        flightSnapshot: null,
      };

      const result = service.extractProjectionData(booking);
      expect(result?.origin).toBe('JFK');
      expect(result?.destination).toBe('LAX');
      expect(result?.airline).toBe('Delta Air Lines');
      expect(result?.flightNumber).toBe('DL 100');
    });

    it('falls back to raw flightNumber when marketingCarrierIata is missing', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'SGN',
                arrivalAirportIata: 'HAN',
                departureAt: new Date('2026-09-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-09-01T12:00:00.000Z'),
                airlineName: 'Vietnam Airlines',
                flightNumber: 'VN123',
              },
            ],
          },
        ],
      };

      const result = service.extractProjectionData(booking);
      expect(result?.flightNumber).toBe('VN123');
    });

    it('does not duplicate carrier prefix when flightNumber already starts with carrier code', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'JFK',
                arrivalAirportIata: 'LHR',
                departureAt: new Date('2026-10-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-10-01T22:00:00.000Z'),
                airlineName: 'Delta Air Lines',
                marketingCarrierIata: 'DL',
                flightNumber: 'DL100',
              },
            ],
          },
        ],
      };

      const result = service.extractProjectionData(booking);
      expect(result?.flightNumber).toBe('DL100');
    });

    it('does not duplicate carrier prefix when flightNumber already starts with carrier code and space', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'JFK',
                arrivalAirportIata: 'LHR',
                departureAt: new Date('2026-10-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-10-01T22:00:00.000Z'),
                airlineName: 'Delta Air Lines',
                marketingCarrierIata: 'DL',
                flightNumber: 'DL 100',
              },
            ],
          },
        ],
      };

      const result = service.extractProjectionData(booking);
      expect(result?.flightNumber).toBe('DL 100');
    });
  });

  describe('Strict Invariant: No Stale Fallback', () => {
    const fallbackFlightSnapshot = {
      stops: 0,
      baggageAllowance: '1 checked bag',
      segments: [
        {
          departureAirport: { iataCode: 'LHR' },
          arrivalAirport: { iataCode: 'JFK' },
          departureAt: '2026-10-01T10:00:00Z',
          arrivalAt: '2026-10-01T16:00:00Z',
          airline: { name: 'British Airways', iataCode: 'BA' },
          flightNumber: '117',
        },
      ],
    };

    it('throws MalformedRevisionError when latest revision has 0 segments and does NOT fall back to flightSnapshot', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [],
          },
        ],
        flightSnapshot: fallbackFlightSnapshot,
      };

      expect(() => service.extractProjectionData(booking)).toThrow(MalformedRevisionError);
    });

    it('throws MalformedRevisionError when latest revision segments is null/undefined', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: null as any,
          },
        ],
        flightSnapshot: fallbackFlightSnapshot,
      };

      expect(() => service.extractProjectionData(booking)).toThrow(MalformedRevisionError);
    });

    it('throws MalformedRevisionError when first segment is missing departureAirportIata', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: '', // missing / blank
                arrivalAirportIata: 'JFK',
                departureAt: new Date('2026-10-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-10-01T16:00:00.000Z'),
                airlineName: 'BA',
                flightNumber: '117',
              },
            ],
          },
        ],
        flightSnapshot: fallbackFlightSnapshot,
      };

      expect(() => service.extractProjectionData(booking)).toThrow(MalformedRevisionError);
    });

    it('throws MalformedRevisionError when last segment is missing arrivalAirportIata', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'LHR',
                arrivalAirportIata: null as any, // missing
                departureAt: new Date('2026-10-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-10-01T16:00:00.000Z'),
                airlineName: 'BA',
                flightNumber: '117',
              },
            ],
          },
        ],
        flightSnapshot: fallbackFlightSnapshot,
      };

      expect(() => service.extractProjectionData(booking)).toThrow(MalformedRevisionError);
    });

    it('throws MalformedRevisionError when segment dates are invalid', () => {
      const booking = {
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'LHR',
                arrivalAirportIata: 'JFK',
                departureAt: 'not-a-valid-date' as any,
                arrivalAt: new Date('2026-10-01T16:00:00.000Z'),
                airlineName: 'BA',
                flightNumber: '117',
              },
            ],
          },
        ],
        flightSnapshot: fallbackFlightSnapshot,
      };

      expect(() => service.extractProjectionData(booking)).toThrow(MalformedRevisionError);
    });
  });

  describe('Fallback to flightSnapshot (permitted ONLY when itineraryRevisions is empty/non-existent)', () => {
    it('extracts flight data from flightSnapshot when itineraryRevisions is empty array', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: {
          stops: 1,
          baggageAllowance: '2 checked bags',
          segments: [
            {
              departureAirport: { iataCode: 'LHR' },
              arrivalAirport: { iataCode: 'DOH' },
              departureAt: '2026-10-01T08:00:00.000Z',
              arrivalAt: '2026-10-01T14:00:00.000Z',
              airline: { name: 'Qatar Airways', iataCode: 'QR' },
              flightNumber: '10',
            },
            {
              departureAirport: { iataCode: 'DOH' },
              arrivalAirport: { iataCode: 'BKK' },
              departureAt: '2026-10-01T16:00:00.000Z',
              arrivalAt: '2026-10-01T23:00:00.000Z',
              airline: { name: 'Qatar Airways', iataCode: 'QR' },
              flightNumber: '830',
            },
          ],
        },
      };

      const result = service.extractProjectionData(booking);
      expect(result).toEqual<SafeBookingProjectionData>({
        airline: 'Qatar Airways',
        origin: 'LHR',
        destination: 'BKK',
        departureAt: new Date('2026-10-01T08:00:00.000Z'),
        arrivalAt: new Date('2026-10-01T23:00:00.000Z'),
        durationMinutes: 900,
        stopCount: 1,
        flightNumber: 'QR 10',
        baggageSummary: '2 checked bags',
        refundable: null,
        changeable: null,
      });
    });

    it('extracts flight data from flightSnapshot when itineraryRevisions is undefined', () => {
      const booking = {
        flightSnapshot: {
          stops: 0,
          segments: [
            {
              departureAirport: { iataCode: 'SGN' },
              arrivalAirport: { iataCode: 'HAN' },
              departureAt: '2026-09-01T10:00:00.000Z',
              arrivalAt: '2026-09-01T12:00:00.000Z',
              airline: { name: 'Vietnam Airlines', iataCode: 'VN' },
              flightNumber: '123',
            },
          ],
        },
      };

      const result = service.extractProjectionData(booking);
      expect(result).not.toBeNull();
      expect(result?.origin).toBe('SGN');
      expect(result?.destination).toBe('HAN');
      expect(result?.flightNumber).toBe('VN 123');
    });

    it('uses fallback segment count minus 1 if stops is undefined in flightSnapshot', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: {
          segments: [
            {
              departureAirport: { iataCode: 'JFK' },
              arrivalAirport: { iataCode: 'LAX' },
              departureAt: '2026-09-01T10:00:00.000Z',
              arrivalAt: '2026-09-01T16:00:00.000Z',
              airline: { name: 'Delta' },
              flightNumber: 'DL100',
            },
          ],
        },
      };

      const result = service.extractProjectionData(booking);
      expect(result?.stopCount).toBe(0);
    });

    it('does not duplicate carrier prefix in flightSnapshot fallback when flightNumber already starts with iataCode', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: {
          stops: 0,
          segments: [
            {
              departureAirport: { iataCode: 'JFK' },
              arrivalAirport: { iataCode: 'LHR' },
              departureAt: '2026-10-01T10:00:00.000Z',
              arrivalAt: '2026-10-01T22:00:00.000Z',
              airline: { name: 'Delta Air Lines', iataCode: 'DL' },
              flightNumber: 'DL100',
            },
          ],
        },
      };

      const result = service.extractProjectionData(booking);
      expect(result?.flightNumber).toBe('DL100');
    });
  });

  describe('Returns null when no flight data exists', () => {
    it('returns null when itineraryRevisions is empty and flightSnapshot is null', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: null,
      };

      expect(service.extractProjectionData(booking)).toBeNull();
    });

    it('returns null when flightSnapshot has empty segments', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: { segments: [] },
      };

      expect(service.extractProjectionData(booking)).toBeNull();
    });

    it('returns null when flightSnapshot segments have invalid dates', () => {
      const booking = {
        itineraryRevisions: [],
        flightSnapshot: {
          segments: [
            {
              departureAirport: { iataCode: 'JFK' },
              arrivalAirport: { iataCode: 'LAX' },
              departureAt: 'invalid-date',
              arrivalAt: 'also-invalid',
            },
          ],
        },
      };

      expect(service.extractProjectionData(booking)).toBeNull();
    });

    it('returns null when booking is completely empty', () => {
      expect(service.extractProjectionData({})).toBeNull();
      expect(service.extractProjectionData(null)).toBeNull();
      expect(service.extractProjectionData(undefined)).toBeNull();
    });
  });

  describe('PII allowlist and sensitive field sanitization', () => {
    it('strictly returns only safe projection fields, excluding all sensitive/PII data', () => {
      const booking = {
        id: 'booking_uuid_123',
        userId: 'user_secret_456',
        pnrReference: 'SECRET_PNR',
        supplierOrderId: 'ord_secret_789',
        totalAmount: '450.00',
        currency: 'USD',
        passengerCount: 2,
        contactEmail: 'sensitive@customer.com',
        contactPhone: '+1-555-0199',
        passengers: [
          {
            firstName: 'Alice',
            lastName: 'Smith',
            passportNumber: 'PASS12345',
            dateOfBirth: '1990-01-01',
          },
        ],
        payment: {
          id: 'pay_123',
          stripePaymentIntentId: 'pi_secret_stripe',
        },
        itineraryRevisions: [
          {
            version: 1,
            segments: [
              {
                globalOrder: 0,
                departureAirportIata: 'LHR',
                arrivalAirportIata: 'JFK',
                departureAt: new Date('2026-10-01T10:00:00.000Z'),
                arrivalAt: new Date('2026-10-01T16:00:00.000Z'),
                airlineName: 'British Airways',
                marketingCarrierIata: 'BA',
                flightNumber: '117',
                // Internal segment fields that should not leak
                supplierSegmentId: 'seg_internal_1',
                passengerIds: ['pas_1'],
              },
            ],
          },
        ],
      };

      const result: any = service.extractProjectionData(booking);

      expect(result).not.toBeNull();

      // Ensure forbidden fields are strictly undefined
      expect(result.id).toBeUndefined();
      expect(result.userId).toBeUndefined();
      expect(result.pnrReference).toBeUndefined();
      expect(result.duffelOrderId).toBeUndefined();
      expect(result.totalAmount).toBeUndefined();
      expect(result.currency).toBeUndefined();
      expect(result.passengerCount).toBeUndefined();
      expect(result.contactEmail).toBeUndefined();
      expect(result.contactPhone).toBeUndefined();
      expect(result.passengers).toBeUndefined();
      expect(result.payment).toBeUndefined();
      expect(result.duffelSegmentId).toBeUndefined();
      expect(result.supplierSegmentId).toBeUndefined();
      expect(result.passengerIds).toBeUndefined();

      // Check allowed keys match exact allowlist
      const expectedKeys = [
        'airline',
        'arrivalAt',
        'baggageSummary',
        'changeable',
        'departureAt',
        'destination',
        'durationMinutes',
        'flightNumber',
        'origin',
        'refundable',
        'stopCount',
      ].sort();

      expect(Object.keys(result).sort()).toEqual(expectedKeys);
    });
  });
});
