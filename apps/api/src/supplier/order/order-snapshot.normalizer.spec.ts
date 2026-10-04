import { Test, TestingModule } from '@nestjs/testing';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';

// User-approved 2026-10-03 per test-adaptations-api.md: these assert new internal normalizer writes; upstream order fixtures and legacy JSON/wire keys remain unchanged.

describe('OrderSnapshotNormalizer', () => {
  let normalizer: OrderSnapshotNormalizer;
  let testingModule: TestingModule;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      providers: [OrderSnapshotNormalizer],
    }).compile();
    normalizer = testingModule.get(OrderSnapshotNormalizer);
  });

  afterEach(async () => {
    await testingModule.close();
  });

  it('preserves multi-slice flight and passenger snapshot output', () => {
    const order = {
      slices: [
        {
          // User-approved 2026-10-02: durations include the connection layover and total 18h30.
          duration: 'PT11H30M',
          segments: [
            {
              id: 'seg_lhr_cdg',
              departing_at: '2026-10-01T08:00:00+01:00',
              arriving_at: '2026-10-01T10:30:00+02:00',
              origin: { iata_code: 'LHR', name: 'Heathrow', city_name: 'London' },
              destination: { iata_code: 'CDG', name: 'Charles de Gaulle', city_name: 'Paris' },
              origin_terminal: '5',
              destination_terminal: '2E',
              operating_carrier: { name: 'British Airways', iata_code: 'BA' },
              marketing_carrier: { name: 'British Airways', iata_code: 'BA' },
              marketing_carrier_flight_number: '304',
              duration: 'PT1H30M',
              aircraft: { name: 'Airbus A320' },
              passengers: [{ cabin_class: 'business' }],
            },
            {
              id: 'seg_cdg_jfk',
              departing_at: '2026-10-01T12:00:00+02:00',
              arriving_at: '2026-10-01T14:30:00-04:00',
              origin: { iata_code: 'CDG', name: 'Charles de Gaulle', city: { name: 'Paris' } },
              destination: { iata_code: 'JFK', name: 'John F. Kennedy', city_name: 'New York' },
              operating_carrier: { name: 'Air France', iata_code: 'AF' },
              marketing_carrier: { name: 'Delta Air Lines', iata_code: 'DL' },
              marketing_carrier_flight_number: '45',
              duration: 'PT8H30M',
            },
          ],
        },
        {
          duration: 'PT7H',
          segments: [
            {
              id: 'seg_jfk_lhr',
              departing_at: '2026-10-08T18:00:00-04:00',
              arriving_at: '2026-10-09T06:00:00+01:00',
              origin: { iata_code: 'JFK', name: 'John F. Kennedy', city_name: 'New York' },
              destination: { iata_code: 'LHR', name: 'Heathrow', city_name: 'London' },
              marketing_carrier: { name: 'British Airways', iata_code: 'BA' },
              marketing_carrier_flight_number: '178',
              duration: 'PT7H',
            },
          ],
        },
      ],
      passengers: [
        {
          id: 'pas_adult',
          type: 'adult',
          title: 'Ms',
          given_name: 'Ada',
          family_name: 'Lovelace',
          born_on: '1815-12-10',
          email: 'ada@example.com',
          phone_number: '+441234567890',
        },
        {
          id: 'pas_child',
          type: 'child',
          given_name: 'Byron',
          family_name: 'Lovelace',
          born_on: '1830-12-10',
        },
        {
          id: 'pas_infant',
          type: 'infant_without_seat',
          title: null,
          given_name: null,
          family_name: null,
          born_on: null,
        },
      ],
    };

    expect(normalizer.mapDuffelOrderToSnapshots(order)).toStrictEqual({
      flightSnapshot: {
        segments: [
          {
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '304',
            departureAirport: {
              iataCode: 'LHR',
              name: 'Heathrow',
              city: 'London',
              terminal: '5',
            },
            arrivalAirport: {
              iataCode: 'CDG',
              name: 'Charles de Gaulle',
              city: 'Paris',
              terminal: '2E',
            },
            departureAt: '2026-10-01T08:00:00+01:00',
            arrivalAt: '2026-10-01T10:30:00+02:00',
            duration: 'PT1H30M',
            aircraftType: 'Airbus A320',
            supplierSegmentId: 'seg_lhr_cdg',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
          {
            airline: { name: 'Air France', iataCode: 'AF' },
            flightNumber: '45',
            departureAirport: {
              iataCode: 'CDG',
              name: 'Charles de Gaulle',
              city: 'Paris',
              terminal: undefined,
            },
            arrivalAirport: {
              iataCode: 'JFK',
              name: 'John F. Kennedy',
              city: 'New York',
              terminal: undefined,
            },
            departureAt: '2026-10-01T12:00:00+02:00',
            arrivalAt: '2026-10-01T14:30:00-04:00',
            duration: 'PT8H30M',
            aircraftType: undefined,
            supplierSegmentId: 'seg_cdg_jfk',
            sliceOrder: 0,
            segmentOrder: 1,
            globalOrder: 1,
          },
          {
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '178',
            departureAirport: {
              iataCode: 'JFK',
              name: 'John F. Kennedy',
              city: 'New York',
              terminal: undefined,
            },
            arrivalAirport: {
              iataCode: 'LHR',
              name: 'Heathrow',
              city: 'London',
              terminal: undefined,
            },
            departureAt: '2026-10-08T18:00:00-04:00',
            arrivalAt: '2026-10-09T06:00:00+01:00',
            duration: 'PT7H',
            aircraftType: undefined,
            supplierSegmentId: 'seg_jfk_lhr',
            sliceOrder: 1,
            segmentOrder: 0,
            globalOrder: 2,
          },
        ],
        totalDuration: 'PT18H30M',
        stops: 1,
        cabinClass: 'business',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'ADULT',
            title: 'Ms',
            firstName: 'Ada',
            lastName: 'Lovelace',
            dateOfBirth: '1815-12-10',
          },
          {
            type: 'CHILD',
            title: undefined,
            firstName: 'Byron',
            lastName: 'Lovelace',
            dateOfBirth: '1830-12-10',
          },
          {
            type: 'INFANT',
            title: undefined,
            firstName: 'Unknown',
            lastName: 'Unknown',
            dateOfBirth: '1990-01-01',
          },
        ],
        contactEmail: 'ada@example.com',
        contactPhone: '+441234567890',
      },
    });
  });

  it('normalizes ordered segments, carrier identities, city fallbacks, and local dates', () => {
    const order = {
      slices: [
        {
          segments: [
            {
              id: 'seg_lhr_cdg',
              duration: 'PT1H30M',
              departing_at: '2026-10-01T08:00:00+01:00',
              arriving_at: '2026-10-01T10:30:00+02:00',
              origin: { iata_code: 'LHR', name: 'Heathrow', city: { name: 'London' } },
              destination: { iata_code: 'CDG', name: 'Charles de Gaulle', city_name: 'Paris' },
              origin_terminal: '5',
              destination_terminal: '2E',
              operating_carrier: { name: 'Lufthansa', iata_code: 'LH' },
              marketing_carrier: { name: 'United Airlines', iata_code: 'UA' },
              marketing_carrier_flight_number: '910',
              aircraft: { name: 'Airbus A320' },
            },
            {
              id: 'seg_cdg_fco',
              duration: 'PT2H',
              departing_at: '2026-10-01T12:00:00+02:00',
              arriving_at: '2026-10-01T14:00:00+02:00',
              origin: { iata_code: 'CDG', name: 'Charles de Gaulle' },
              destination: { iata_code: 'FCO', name: 'Fiumicino', city: { name: 'Rome' } },
              marketing_carrier: { name: 'Air France', iata_code: 'AF' },
              marketing_carrier_flight_number: '70',
            },
          ],
        },
        {
          segments: [
            {
              id: 'seg_jfk_lhr',
              duration: 'PT8H',
              departing_at: '2026-10-08T18:00:00-04:00',
              arriving_at: '2026-10-09T06:00:00+01:00',
              origin: { iata_code: 'JFK', name: 'John F. Kennedy', city_name: 'New York' },
              destination: { iata_code: 'LHR', name: 'Heathrow', city_name: 'London' },
              operating_carrier: { name: 'American Airlines', iata_code: 'AA' },
              marketing_carrier: { name: 'British Airways', iata_code: 'BA' },
              marketing_carrier_flight_number: '174',
            },
          ],
        },
      ],
    };

    expect(normalizer.normalizeDuffelOrder(order)).toStrictEqual([
      {
        sliceOrder: 0,
        segmentOrder: 0,
        globalOrder: 0,
        supplierSegmentId: 'seg_lhr_cdg',
        marketingCarrierIata: 'UA',
        operatingCarrierIata: 'LH',
        airlineName: 'Lufthansa',
        flightNumber: '910',
        departureAirportIata: 'LHR',
        departureAirportName: 'Heathrow',
        departureCity: 'London',
        departureTerminal: '5',
        departureAt: '2026-10-01T08:00:00+01:00',
        departureLocalDate: '2026-10-01',
        arrivalAirportIata: 'CDG',
        arrivalAirportName: 'Charles de Gaulle',
        arrivalCity: 'Paris',
        arrivalTerminal: '2E',
        arrivalAt: '2026-10-01T10:30:00+02:00',
        arrivalLocalDate: '2026-10-01',
        durationMinutes: 90,
        aircraftType: 'Airbus A320',
      },
      {
        sliceOrder: 0,
        segmentOrder: 1,
        globalOrder: 1,
        supplierSegmentId: 'seg_cdg_fco',
        marketingCarrierIata: 'AF',
        operatingCarrierIata: 'AF',
        airlineName: 'Air France',
        flightNumber: '70',
        departureAirportIata: 'CDG',
        departureAirportName: 'Charles de Gaulle',
        departureCity: 'Charles de Gaulle',
        departureTerminal: null,
        departureAt: '2026-10-01T12:00:00+02:00',
        departureLocalDate: '2026-10-01',
        arrivalAirportIata: 'FCO',
        arrivalAirportName: 'Fiumicino',
        arrivalCity: 'Rome',
        arrivalTerminal: null,
        arrivalAt: '2026-10-01T14:00:00+02:00',
        arrivalLocalDate: '2026-10-01',
        durationMinutes: 120,
        aircraftType: null,
      },
      {
        sliceOrder: 1,
        segmentOrder: 0,
        globalOrder: 2,
        supplierSegmentId: 'seg_jfk_lhr',
        marketingCarrierIata: 'BA',
        operatingCarrierIata: 'AA',
        airlineName: 'American Airlines',
        flightNumber: '174',
        departureAirportIata: 'JFK',
        departureAirportName: 'John F. Kennedy',
        departureCity: 'New York',
        departureTerminal: null,
        departureAt: '2026-10-08T18:00:00-04:00',
        departureLocalDate: '2026-10-08',
        arrivalAirportIata: 'LHR',
        arrivalAirportName: 'Heathrow',
        arrivalCity: 'London',
        arrivalTerminal: null,
        arrivalAt: '2026-10-09T06:00:00+01:00',
        arrivalLocalDate: '2026-10-09',
        durationMinutes: 480,
        aircraftType: null,
      },
    ]);
  });

  it('keeps empty and partial order defaults while skipping malformed entries', () => {
    expect(normalizer.mapDuffelOrderToSnapshots(null)).toStrictEqual({
      flightSnapshot: {
        segments: [],
        totalDuration: 'PT0H',
        stops: 0,
        cabinClass: 'economy',
      },
      passengerSnapshot: {
        passengers: [],
        contactEmail: null,
        contactPhone: null,
      },
    });
    expect(normalizer.normalizeDuffelOrder(null)).toStrictEqual([]);

    const partialOrder = {
      slices: [
        null,
        {
          duration: 'PT1H15M',
          segments: [
            null,
            {
              id: 42,
              origin: 'unknown',
              destination: false,
              marketing_carrier: 'unknown',
              departing_at: 42,
              arriving_at: null,
              passengers: [null],
            },
          ],
        },
      ],
      passengers: [null, { type: 'child', given_name: '' }],
    };

    expect(normalizer.mapDuffelOrderToSnapshots(partialOrder)).toStrictEqual({
      flightSnapshot: {
        segments: [
          {
            airline: { name: 'Unknown', iataCode: 'XX' },
            flightNumber: '0000',
            departureAirport: {
              iataCode: '',
              name: '',
              city: '',
              terminal: undefined,
            },
            arrivalAirport: {
              iataCode: '',
              name: '',
              city: '',
              terminal: undefined,
            },
            departureAt: '',
            arrivalAt: '',
            duration: '',
            aircraftType: undefined,
            supplierSegmentId: undefined,
            sliceOrder: 1,
            segmentOrder: 1,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT1H15M',
        stops: 1,
        cabinClass: 'economy',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'CHILD',
            title: undefined,
            firstName: 'Unknown',
            lastName: 'Unknown',
            dateOfBirth: '1990-01-01',
          },
        ],
        contactEmail: null,
        contactPhone: null,
      },
    });
    expect(normalizer.normalizeDuffelOrder(partialOrder)).toStrictEqual([
      {
        sliceOrder: 1,
        segmentOrder: 1,
        globalOrder: 0,
        supplierSegmentId: null,
        marketingCarrierIata: 'XX',
        operatingCarrierIata: 'XX',
        airlineName: 'Unknown',
        flightNumber: '0000',
        departureAirportIata: '',
        departureAirportName: '',
        departureCity: '',
        departureTerminal: null,
        departureAt: '',
        departureLocalDate: '',
        arrivalAirportIata: '',
        arrivalAirportName: '',
        arrivalCity: '',
        arrivalTerminal: null,
        arrivalAt: '',
        arrivalLocalDate: '',
        durationMinutes: 0,
        aircraftType: null,
      },
    ]);
  });
});
