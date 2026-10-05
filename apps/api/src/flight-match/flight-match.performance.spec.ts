import { Test, TestingModule } from '@nestjs/testing';
import { FlightOffer, FlightSegment } from '@/supplier/search/flight-search.port';
import { ProfileService } from '@/profile/profile.service';
import { FlightSearchOrchestratorService, OrchestratorParams } from '@/flights/flight-search-orchestrator.service';
import { FlightMatchScorerService } from './flight-match-scorer.service';
import { CategoryRankerService } from './category-ranker.service';
import type { FlightMatchInput, ScoringPreferences } from './flight-match.types';

function calculatePercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * (percentile / 100)) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function calculateLatencyStats(samples: readonly number[]) {
  const sum = samples.reduce((acc, val) => acc + val, 0);
  return {
    count: samples.length,
    mean: sum / samples.length,
    p50: calculatePercentile(samples, 50),
    p90: calculatePercentile(samples, 90),
    p95: calculatePercentile(samples, 95),
    p99: calculatePercentile(samples, 99),
  };
}

function orderedFullMatchResults(
  results: ReturnType<FlightMatchScorerService['scoreAll']>,
): Array<{
  readonly offerId: string;
  readonly matchResult: ReturnType<FlightMatchScorerService['scoreAll']>[number]['matchResult'];
}> {
  return results.map(({ offer, matchResult }) => ({ offerId: offer.id, matchResult }));
}

function expectFullMatchParityAcrossPasses(
  scorer: FlightMatchScorerService,
  offers: readonly FlightMatchInput[],
  preferences: ScoringPreferences,
  passes: number,
): void {
  const baseline = orderedFullMatchResults(scorer.scoreAll(offers, preferences));
  for (let pass = 0; pass < passes; pass++) {
    expect(orderedFullMatchResults(scorer.scoreAll(offers, preferences))).toEqual(baseline);
  }
}

/**
 * Realistic 20-offer fixture with diverse airlines, stops, durations, prices,
 * cabins, schedules, baggage, and mixed eligibility (18 eligible, 2 blacklisted).
 */
export const BENCHMARK_20_OFFERS: readonly FlightMatchInput[] = [
  {
    id: 'bench-offer-01',
    price: 350.0,
    currency: 'USD',
    stops: 0,
    duration: 180,
    outboundDepartureHour: 8,
    outboundArrivalHour: 11,
    carrierCodes: ['AA'],
    carrierNamesByCode: { AA: 'American Airlines' },
    cabinClass: 'economy',
    hasCheckedBaggage: true,
    originalIndex: 0,
  },
  {
    id: 'bench-offer-02',
    price: 420.5,
    currency: 'USD',
    stops: 0,
    duration: 175,
    outboundDepartureHour: 9,
    outboundArrivalHour: 12,
    carrierCodes: ['DL'],
    carrierNamesByCode: { DL: 'Delta Air Lines' },
    cabinClass: 'economy',
    hasCheckedBaggage: false,
    originalIndex: 1,
  },
  {
    id: 'bench-offer-03',
    price: 520.0,
    currency: 'USD',
    stops: 1,
    duration: 270,
    outboundDepartureHour: 10,
    outboundArrivalHour: 15,
    carrierCodes: ['UA'],
    carrierNamesByCode: { UA: 'United Airlines' },
    cabinClass: 'business',
    hasCheckedBaggage: true,
    originalIndex: 2,
  },
  {
    id: 'bench-offer-04',
    price: 890.0,
    currency: 'USD',
    stops: 0,
    duration: 190,
    outboundDepartureHour: 11,
    outboundArrivalHour: 14,
    carrierCodes: ['BA'],
    carrierNamesByCode: { BA: 'British Airways' },
    cabinClass: 'business',
    hasCheckedBaggage: true,
    originalIndex: 3,
  },
  {
    id: 'bench-offer-05',
    price: 290.0,
    currency: 'USD',
    stops: 1,
    duration: 310,
    outboundDepartureHour: 6,
    outboundArrivalHour: 11,
    carrierCodes: ['AF'],
    carrierNamesByCode: { AF: 'Air France' },
    cabinClass: 'economy',
    hasCheckedBaggage: null,
    originalIndex: 4,
  },
  {
    id: 'bench-offer-06',
    price: 650.0,
    currency: 'USD',
    stops: 1,
    duration: 290,
    outboundDepartureHour: 7,
    outboundArrivalHour: 12,
    carrierCodes: ['LH'],
    carrierNamesByCode: { LH: 'Lufthansa' },
    cabinClass: 'premium_economy',
    hasCheckedBaggage: true,
    originalIndex: 5,
  },
  {
    id: 'bench-offer-07',
    price: 780.0,
    currency: 'USD',
    stops: 0,
    duration: 185,
    outboundDepartureHour: 14,
    outboundArrivalHour: 17,
    carrierCodes: ['VS'],
    carrierNamesByCode: { VS: 'Virgin Atlantic' },
    cabinClass: 'premium_economy',
    hasCheckedBaggage: true,
    originalIndex: 6,
  },
  {
    id: 'bench-offer-08',
    price: 1200.0,
    currency: 'USD',
    stops: 1,
    duration: 420,
    outboundDepartureHour: 15,
    outboundArrivalHour: 22,
    carrierCodes: ['SQ'],
    carrierNamesByCode: { SQ: 'Singapore Airlines' },
    cabinClass: 'business',
    hasCheckedBaggage: true,
    originalIndex: 7,
  },
  {
    id: 'bench-offer-09',
    price: 1450.0,
    currency: 'USD',
    stops: 1,
    duration: 450,
    outboundDepartureHour: 22,
    outboundArrivalHour: 6,
    carrierCodes: ['EK'],
    carrierNamesByCode: { EK: 'Emirates' },
    cabinClass: 'first',
    hasCheckedBaggage: true,
    originalIndex: 8,
  },
  {
    id: 'bench-offer-10',
    price: 1380.0,
    currency: 'USD',
    stops: 1,
    duration: 440,
    outboundDepartureHour: 23,
    outboundArrivalHour: 7,
    carrierCodes: ['QR'],
    carrierNamesByCode: { QR: 'Qatar Airways' },
    cabinClass: 'business',
    hasCheckedBaggage: true,
    originalIndex: 9,
  },
  {
    id: 'bench-offer-11',
    price: 950.0,
    currency: 'USD',
    stops: 0,
    duration: 195,
    outboundDepartureHour: 13,
    outboundArrivalHour: 16,
    carrierCodes: ['JL'],
    carrierNamesByCode: { JL: 'Japan Airlines' },
    cabinClass: 'business',
    hasCheckedBaggage: false,
    originalIndex: 10,
  },
  {
    id: 'bench-offer-12',
    price: 610.0,
    currency: 'USD',
    stops: 1,
    duration: 330,
    outboundDepartureHour: 17,
    outboundArrivalHour: 22,
    carrierCodes: ['NH'],
    carrierNamesByCode: { NH: 'All Nippon Airways' },
    cabinClass: 'economy',
    hasCheckedBaggage: true,
    originalIndex: 11,
  },
  {
    id: 'bench-offer-13',
    price: 1800.0,
    currency: 'USD',
    stops: 2,
    duration: 620,
    outboundDepartureHour: 1,
    outboundArrivalHour: 12,
    carrierCodes: ['QF'],
    carrierNamesByCode: { QF: 'Qantas' },
    cabinClass: 'first',
    hasCheckedBaggage: true,
    originalIndex: 12,
  },
  {
    id: 'bench-offer-14',
    price: 540.0,
    currency: 'USD',
    stops: 1,
    duration: 300,
    outboundDepartureHour: 18,
    outboundArrivalHour: 23,
    carrierCodes: ['CX'],
    carrierNamesByCode: { CX: 'Cathay Pacific' },
    cabinClass: 'economy',
    hasCheckedBaggage: false,
    originalIndex: 13,
  },
  {
    id: 'bench-offer-15',
    price: 310.0,
    currency: 'USD',
    stops: 0,
    duration: 170,
    outboundDepartureHour: 2,
    outboundArrivalHour: 5,
    carrierCodes: ['KL'],
    carrierNamesByCode: { KL: 'KLM' },
    cabinClass: 'economy',
    hasCheckedBaggage: null,
    originalIndex: 14,
  },
  {
    id: 'bench-offer-16',
    price: 480.0,
    currency: 'USD',
    stops: 1,
    duration: 280,
    outboundDepartureHour: 20,
    outboundArrivalHour: 1,
    carrierCodes: ['IB'],
    carrierNamesByCode: { IB: 'Iberia' },
    cabinClass: 'economy',
    hasCheckedBaggage: true,
    originalIndex: 15,
  },
  {
    id: 'bench-offer-17',
    price: 720.0,
    currency: 'USD',
    stops: 2,
    duration: 540,
    outboundDepartureHour: 3,
    outboundArrivalHour: 12,
    carrierCodes: ['AY'],
    carrierNamesByCode: { AY: 'Finnair' },
    cabinClass: 'premium_economy',
    hasCheckedBaggage: true,
    originalIndex: 16,
  },
  {
    id: 'bench-offer-18',
    price: 390.0,
    currency: 'USD',
    stops: 0,
    duration: 165,
    outboundDepartureHour: 16,
    outboundArrivalHour: 19,
    carrierCodes: ['AZ'],
    carrierNamesByCode: { AZ: 'ITA Airways' },
    cabinClass: 'economy',
    hasCheckedBaggage: false,
    originalIndex: 17,
  },
  {
    id: 'bench-offer-19',
    price: 150.0,
    currency: 'USD',
    stops: 0,
    duration: 160,
    outboundDepartureHour: 10,
    outboundArrivalHour: 13,
    carrierCodes: ['NK'], // Blacklisted airline
    carrierNamesByCode: { NK: 'Spirit Airlines' },
    cabinClass: 'economy',
    hasCheckedBaggage: false,
    originalIndex: 18,
  },
  {
    id: 'bench-offer-20',
    price: 140.0,
    currency: 'USD',
    stops: 1,
    duration: 250,
    outboundDepartureHour: 9,
    outboundArrivalHour: 13,
    carrierCodes: ['F9'], // Blacklisted airline
    carrierNamesByCode: { F9: 'Frontier Airlines' },
    cabinClass: 'economy',
    hasCheckedBaggage: false,
    originalIndex: 19,
  },
];

/**
 * Realistic traveler profile preference fixture with airline preferences,
 * blacklists, departure/arrival windows, maxStops, sensitivity, and baggage requirement.
 */
export const BENCHMARK_PREFERENCES: ScoringPreferences = {
  preferredAirlines: ['AA', 'DL', 'UA', 'BA'],
  blacklistedAirlines: ['NK', 'F9'],
  classPreference: 'business',
  preferredDepartureWindow: { start: 8, end: 12 },
  preferredArrivalWindow: { start: 14, end: 18 },
  maxStops: 1,
  priceSensitivity: 'MODERATE',
  requiresCheckedBaggage: true,
};

function parseSegmentCabinClass(cabin: string): 'economy' | 'premium_economy' | 'business' | 'first' {
  switch (cabin) {
    case 'premium_economy':
      return 'premium_economy';
    case 'business':
      return 'business';
    case 'first':
      return 'first';
    case 'economy':
    default:
      return 'economy';
  }
}

function createMockFlightOfferFromInput(input: FlightMatchInput): FlightOffer {
  const isMultiSegment = input.stops > 0;
  const segments: FlightSegment[] = [];

  const departingIso = `2026-09-01T${input.outboundDepartureHour.toString().padStart(2, '0')}:00:00`;
  const arrivingIso = `2026-09-01T${input.outboundArrivalHour.toString().padStart(2, '0')}:00:00`;

  const carrierCode = input.carrierCodes[0] || 'AA';
  const carrierName = input.carrierNamesByCode?.[carrierCode] || 'Airline';
  const segmentCabinClass = parseSegmentCabinClass(input.cabinClass);

  if (isMultiSegment) {
    const firstDurationMins = Math.floor(input.duration / (input.stops + 1));
    segments.push({
      supplierSegmentId: `seg_${input.id}_1`,
      carrierCode,
      flightNumber: '101',
      operatingCarrier: carrierName,
      departureAirport: 'SFO',
      departureTerminal: null,
      departureTime: departingIso,
      arrivalAirport: 'ORD',
      arrivalTerminal: null,
      arrivalTime: `2026-09-01T${((input.outboundDepartureHour + 2) % 24).toString().padStart(2, '0')}:00:00`,
      duration: firstDurationMins,
      aircraft: null,
      cabinClass: segmentCabinClass,
    });

    for (let s = 1; s <= input.stops; s++) {
      const isLast = s === input.stops;
      segments.push({
        supplierSegmentId: `seg_${input.id}_${s + 1}`,
        carrierCode,
        flightNumber: '102',
        operatingCarrier: carrierName,
        departureAirport: 'ORD',
        departureTerminal: null,
        departureTime: `2026-09-01T${((input.outboundDepartureHour + 3) % 24).toString().padStart(2, '0')}:00:00`,
        arrivalAirport: 'JFK',
        arrivalTerminal: null,
        arrivalTime: isLast
          ? arrivingIso
          : `2026-09-01T${((input.outboundDepartureHour + 5) % 24).toString().padStart(2, '0')}:00:00`,
        duration: 120,
        aircraft: null,
        cabinClass: segmentCabinClass,
      });
    }
  } else {
    segments.push({
      supplierSegmentId: `seg_${input.id}_1`,
      carrierCode,
      flightNumber: '100',
      operatingCarrier: carrierName,
      departureAirport: 'SFO',
      departureTerminal: null,
      departureTime: departingIso,
      arrivalAirport: 'JFK',
      arrivalTerminal: null,
      arrivalTime: arrivingIso,
      duration: input.duration,
      aircraft: null,
      cabinClass: segmentCabinClass,
    });
  }

  return {
    id: input.id,
    supplierOfferId: `supp_${input.id}`,
    totalAmount: input.price.toFixed(2),
    price: input.price,
    currency: input.currency,
    offerExpiresAt: null,
    passengers: [{ supplierPassengerId: 'pas_1', type: 'ADULT' }],
    airline: carrierName,
    flightNumber: `${carrierCode}100`,
    departureAirport: 'SFO',
    arrivalAirport: 'JFK',
    departureTime: departingIso,
    arrivalTime: arrivingIso,
    duration: input.duration,
    stops: input.stops,
    fareClass: input.cabinClass,
    baggageAllowance: input.hasCheckedBaggage ? '1 checked bag' : null,
    segments,
    returnSegments: null,
    conditions: {
      refundable: false,
      changeable: true,
      changeBeforeDeparture: null,
    },
    matchInput: input,
    rawSupplierPayload: {},
  };
}

describe('Flight Match Performance Benchmark Suite (T039)', () => {
  const scorerService = new FlightMatchScorerService();

  describe('Part 1: Scorer Benchmark', () => {
    it('executes 1,000 deterministic scoring passes under 5 ms p95 with 100% deterministic outputs', () => {
      const iterations = 1000;
      const durations: number[] = [];

      // Initial baseline pass for determinism verification
      const baselineResult = scorerService.scoreAll(BENCHMARK_20_OFFERS, BENCHMARK_PREFERENCES);
      expect(baselineResult).toHaveLength(20);

      // Verify mixed eligibility in the fixture
      const eligibleCount = baselineResult.filter((r) => r.matchResult.eligibility.eligible).length;
      const ineligibleCount = baselineResult.filter((r) => !r.matchResult.eligibility.eligible).length;
      expect(eligibleCount).toBe(18);
      expect(ineligibleCount).toBe(2);

      // Warm up with 50 iterations
      for (let i = 0; i < 50; i++) {
        scorerService.scoreAll(BENCHMARK_20_OFFERS, BENCHMARK_PREFERENCES);
      }

      let deterministicMismatch = false;

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        const result = scorerService.scoreAll(BENCHMARK_20_OFFERS, BENCHMARK_PREFERENCES);
        const end = process.hrtime.bigint();
        durations.push(Number(end - start) / 1_000_000);

        if (result.length !== baselineResult.length) {
          deterministicMismatch = true;
        } else {
          for (let j = 0; j < result.length; j++) {
            if (
              result[j].offer.id !== baselineResult[j].offer.id ||
              result[j].matchResult.score !== baselineResult[j].matchResult.score ||
              result[j].matchResult.matchLevel !== baselineResult[j].matchResult.matchLevel ||
              result[j].matchResult.eligibility.eligible !== baselineResult[j].matchResult.eligibility.eligible
            ) {
              deterministicMismatch = true;
              break;
            }
          }
        }
      }

      const stats = calculateLatencyStats(durations);

      console.log('--- FlightMatchScorerService Benchmark (1,000 passes) ---', {
        samples: stats.count,
        meanMs: stats.mean.toFixed(4),
        p50Ms: stats.p50.toFixed(4),
        p90Ms: stats.p90.toFixed(4),
        p95Ms: stats.p95.toFixed(4),
        p99Ms: stats.p99.toFixed(4),
      });

      // Assert 100% deterministic identical outputs (scores, order, activeWeights)
      expect(deterministicMismatch).toBe(false);
      const finalResult = scorerService.scoreAll(BENCHMARK_20_OFFERS, BENCHMARK_PREFERENCES);
      expect(finalResult).toEqual(baselineResult);
      expect(finalResult[0].matchResult.metadata.activeWeights).toEqual(
        baselineResult[0].matchResult.metadata.activeWeights,
      );

      // Assert that p95 scoring latency is strictly under 5 ms (target is < 1 ms on 20 offers)
      expect(stats.p95).toBeLessThan(5);
    });

    it('keeps every ordered full match result identical across 1,000 passes', () => {
      expectFullMatchParityAcrossPasses(
        scorerService,
        BENCHMARK_20_OFFERS,
        BENCHMARK_PREFERENCES,
        1_000,
      );
    });
  });

  describe('Part 2: Warmed Orchestrator Overhead Benchmark', () => {
    it('measures warmed normalization + scoring overhead under 10 ms p95', async () => {
      const mockOffers: readonly FlightOffer[] =
        BENCHMARK_20_OFFERS.map(createMockFlightOfferFromInput);
      expect(mockOffers).toHaveLength(20);

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FlightSearchOrchestratorService,
          {
            provide: ProfileService,
            useValue: {
              getScoringPreferences: jest.fn().mockResolvedValue(BENCHMARK_PREFERENCES),
            },
          },
          { provide: FlightMatchScorerService, useValue: scorerService },
          { provide: CategoryRankerService, useValue: new CategoryRankerService() },
        ],
      }).compile();

      const orchestratorService = module.get<FlightSearchOrchestratorService>(
        FlightSearchOrchestratorService,
      );

      const params: OrchestratorParams = {
        offers: mockOffers,
        query: {
          origin: 'SFO',
          destination: 'JFK',
          departureDate: '2026-09-01',
          adults: 1,
          cabinClass: 'business',
        },
        userId: 'usr_bench_01',
        searchHash: 'search_hash_bench_01',
        cached: false,
      };

      // Warm up with 50 iterations
      for (let i = 0; i < 50; i++) {
        await orchestratorService.orchestrateSearch(params);
      }

      // Benchmark with 200 iterations
      const iterations = 200;
      const durations: number[] = [];

      for (let i = 0; i < iterations; i++) {
        const start = process.hrtime.bigint();
        const response = await orchestratorService.orchestrateSearch(params);
        const end = process.hrtime.bigint();
        durations.push(Number(end - start) / 1_000_000);

        if (i === 0) {
          expect(response.mode).toBe('MATCHED');
          expect(response.results).toHaveLength(20);
          expect(response.meta.eligibleCount).toBe(18);
        }
      }

      const stats = calculateLatencyStats(durations);

      console.log('--- FlightSearchOrchestratorService Benchmark (200 passes) ---', {
        samples: stats.count,
        meanMs: stats.mean.toFixed(4),
        p50Ms: stats.p50.toFixed(4),
        p90Ms: stats.p90.toFixed(4),
        p95Ms: stats.p95.toFixed(4),
        p99Ms: stats.p99.toFixed(4),
      });

      // Assert p95 total overhead is below 10 ms (target < 2 ms)
      expect(stats.p95).toBeLessThan(10);
    });
  });
});
