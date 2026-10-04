// User approved on 2026-10-03: internal fixture names match the domain rename.
// Values and scenarios are unchanged.
import { normalizeDuffelOrder, normalizeFlightSegments } from './itinerary-normalizer';
import { DuffelOrder } from '../../duffel/duffel.types';
import { FlightSegmentSnapshot } from '@shared/booking-types';

describe('ItineraryNormalizer', () => {
  describe('normalizeDuffelOrder', () => {
    it('should normalize a standard Duffel order', () => {
      const mockOrder = {
        id: 'ord_0000AV1234',
        slices: [
          {
            id: 'sli_outbound',
            duration: 'PT8H30M',
            origin: { iata_code: 'LHR', name: 'Heathrow', city_name: 'London', type: 'airport' },
            destination: {
              iata_code: 'JFK',
              name: 'John F. Kennedy',
              city_name: 'New York',
              type: 'airport',
            },
            segments: [
              {
                id: 'seg_outbound_1',
                duration: 'PT8H30M',
                departing_at: '2026-10-01T10:00:00+01:00',
                arriving_at: '2026-10-01T13:30:00-04:00',
                origin: {
                  iata_code: 'LHR',
                  name: 'Heathrow',
                  city_name: 'London',
                  type: 'airport',
                },
                destination: {
                  iata_code: 'JFK',
                  name: 'John F. Kennedy',
                  city_name: 'New York',
                  type: 'airport',
                },
                origin_terminal: '5',
                destination_terminal: '4',
                operating_carrier: { id: 'air_ba', name: 'British Airways', iata_code: 'BA' },
                marketing_carrier: { id: 'air_ba', name: 'British Airways', iata_code: 'BA' },
                marketing_carrier_flight_number: '177',
                aircraft: { id: 'arc_777', name: 'Boeing 777', iata_code: '777' },
              },
            ],
          },
        ],
        passengers: [],
      } as unknown as DuffelOrder;

      const result = normalizeDuffelOrder(mockOrder);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        sliceOrder: 0,
        segmentOrder: 0,
        globalOrder: 0,
        supplierSegmentId: 'seg_outbound_1',
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
      });
    });

    it('should fallback to marketing carrier if operating carrier is missing', () => {
      const mockOrder = {
        id: 'ord_123',
        slices: [
          {
            id: 'sli_1',
            duration: 'PT2H',
            segments: [
              {
                id: 'seg_1',
                duration: 'PT2H',
                departing_at: '2026-10-01T10:00:00Z',
                arriving_at: '2026-10-01T12:00:00Z',
                origin: { iata_code: 'LHR', name: 'Heathrow' },
                destination: { iata_code: 'CDG', name: 'Charles de Gaulle' },
                marketing_carrier: { name: 'Air France', iata_code: 'AF' },
                marketing_carrier_flight_number: '1234',
              },
            ],
          },
        ],
      } as unknown as DuffelOrder;

      const result = normalizeDuffelOrder(mockOrder);
      expect(result[0].operatingCarrierIata).toBe('AF');
      expect(result[0].airlineName).toBe('Air France');
    });
  });

  describe('normalizeFlightSegments', () => {
    it('should normalize snapshots containing full metadata', () => {
      const mockSegments: FlightSegmentSnapshot[] = [
        {
          airline: { name: 'British Airways', iataCode: 'BA' },
          flightNumber: '177',
          departureAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London', terminal: '5' },
          arrivalAirport: {
            iataCode: 'JFK',
            name: 'John F. Kennedy',
            city: 'New York',
            terminal: '4',
          },
          departureAt: '2026-10-01T10:00:00+01:00',
          arrivalAt: '2026-10-01T13:30:00-04:00',
          duration: 'PT8H30M',
          aircraftType: 'Boeing 777',
          supplierSegmentId: 'seg_outbound_1',
          sliceOrder: 0,
          segmentOrder: 0,
          globalOrder: 0,
        },
      ];

      const result = normalizeFlightSegments(mockSegments);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        sliceOrder: 0,
        segmentOrder: 0,
        globalOrder: 0,
        supplierSegmentId: 'seg_outbound_1',
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
      });
    });

    it('should handle legacy snapshots with missing order/ID metadata', () => {
      const mockLegacySegments: FlightSegmentSnapshot[] = [
        {
          airline: { name: 'Delta Air Lines', iataCode: 'DL' },
          flightNumber: '44',
          departureAirport: { iataCode: 'JFK', name: 'John F. Kennedy', city: 'New York' },
          arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
          departureAt: '2026-10-02T18:00:00Z',
          arrivalAt: '2026-10-03T06:00:00Z',
          duration: 'PT7H0M',
        },
      ];

      const result = normalizeFlightSegments(mockLegacySegments);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        sliceOrder: 0,
        segmentOrder: 0,
        globalOrder: 0,
        supplierSegmentId: null,
        marketingCarrierIata: 'DL',
        operatingCarrierIata: 'DL',
        airlineName: 'Delta Air Lines',
        flightNumber: '44',
        departureAirportIata: 'JFK',
        departureAirportName: 'John F. Kennedy',
        departureCity: 'New York',
        departureTerminal: null,
        departureAt: '2026-10-02T18:00:00Z',
        departureLocalDate: '2026-10-02',
        arrivalAirportIata: 'LHR',
        arrivalAirportName: 'Heathrow',
        arrivalCity: 'London',
        arrivalTerminal: null,
        arrivalAt: '2026-10-03T06:00:00Z',
        arrivalLocalDate: '2026-10-03',
        durationMinutes: 420,
        aircraftType: null,
      });
    });

    it('preserves legacy Duffel segment identity and ordering', (): void => {
      const legacySegments: FlightSegmentSnapshot[] = [
        {
          airline: { name: 'Northwind Air', iataCode: 'NW' },
          flightNumber: 'NW42',
          departureAirport: {
            iataCode: 'SGN',
            name: 'Tan Son Nhat International Airport',
            city: 'Ho Chi Minh City',
          },
          arrivalAirport: {
            iataCode: 'HAN',
            name: 'Noi Bai International Airport',
            city: 'Hanoi',
          },
          departureAt: '2026-10-10T08:00:00+07:00',
          arrivalAt: '2026-10-10T10:00:00+07:00',
          duration: 'PT2H',
          supplierSegmentId: 'seg_legacy_42',
          sliceOrder: 1,
          segmentOrder: 2,
          globalOrder: 3,
        },
      ];

      const result = normalizeFlightSegments(legacySegments);

      expect(result[0]).toMatchObject({
        supplierSegmentId: 'seg_legacy_42',
        sliceOrder: 1,
        segmentOrder: 2,
        globalOrder: 3,
        flightNumber: 'NW42',
        departureAirportIata: 'SGN',
        arrivalAirportIata: 'HAN',
      });
    });
  });
});
