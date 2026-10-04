import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { FlightsService } from './flights.service';
import { FlightSearchOrchestratorService } from './flight-search-orchestrator.service';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelTimeoutError } from '@/supplier/search/duffel-search.adapter';
import {
  FLIGHT_SEARCH_PORT,
  FlightOffer,
} from '@/supplier/search/flight-search.port';
import { FlightOfferNormalizer } from '@/supplier/search/flight-offer.normalizer';
import { AuditService } from '@/audit/audit.service';
import { DuffelOffer } from '@/duffel/duffel.types';
import { FlightMatchResult } from '@/flight-match/flight-match.types';
import { FlightSearchRequestDto } from './dto/search-flight.dto';
import { generateDeterministicUUID } from './flight-offer-normalizer';
import { Prisma } from '@prisma/client';

// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md

describe('FlightsService (T036)', () => {
  let service: FlightsService;
  let prisma: {
    airport: { findUnique: jest.Mock };
    searchHistory: { create: jest.Mock; findFirst: jest.Mock };
    flightOffer: { createMany: jest.Mock; findUnique: jest.Mock; delete: jest.Mock };
    offerRecovery: { createMany: jest.Mock; findUnique: jest.Mock };
    auditLog: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let cacheService: { get: jest.Mock; set: jest.Mock };
  let flightSearchPort: {
    search: jest.Mock;
    getOfferById: jest.Mock;
    normalizeStoredOffer: jest.Mock;
  };
  let auditService: { createLog: jest.Mock };
  let orchestratorService: { orchestrateSearch: jest.Mock };

  const flushWriteBehind = () => new Promise((resolve) => setImmediate(resolve));

  const createMockNormalizedFlightOffer = (
    rawOffer: DuffelOffer,
    overrides: Partial<FlightOffer> = {},
  ): FlightOffer => {
    const normalized = FlightOfferNormalizer.normalizeOffer(rawOffer);
    return {
      ...normalized,
      rawSupplierPayload: rawOffer,
      ...overrides,
    };
  };

  const createMockDuffelOffer = (id: string, amount = '150.00', airline = 'Vietnam Airlines'): DuffelOffer => ({
    id,
    total_amount: amount,
    total_currency: 'USD',
    slices: [
      {
        id: `sli_${id}`,
        duration: 'PT2H0M',
        origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
        destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
        segments: [
          {
            id: `seg_${id}`,
            duration: 'PT2H0M',
            departing_at: '2026-10-01T08:00:00',
            arriving_at: '2026-10-01T10:00:00',
            origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            marketing_carrier: { id: 'VN', name: airline, iata_code: 'VN' },
            operating_carrier: { id: 'VN', name: airline, iata_code: 'VN' },
            marketing_carrier_flight_number: '123',
            aircraft: { id: 'arc_1', name: 'A321', iata_code: '321' },
            passengers: [
              {
                passenger_id: 'pas_1',
                cabin_class: 'economy',
                baggages: [{ type: 'checked', quantity: 1 }],
              },
            ],
          },
        ],
      },
    ],
    passengers: [{ id: 'pas_1', type: 'adult' }],
    passenger_identity_documents_required: false,
  });

  const createMockMatchResult = (
    score = 88,
    matchLevel: 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK' = 'STRONG',
  ): FlightMatchResult => ({
    eligibility: { eligible: true, violations: [] },
    score,
    matchLevel,
    breakdown: [
      {
        dimension: 'AIRLINE',
        score: 100,
        weight: 0.4,
        contribution: 40,
        signal: 'POSITIVE',
        explanation: {
          key: 'match.airline.preferred',
          params: { airline: 'Vietnam Airlines' },
        },
      },
    ],
    metadata: {
      scoringVersion: 'flight-match-v1',
      activeWeights: {
        PRICE: 0.1,
        AIRLINE: 0.4,
        ARRIVAL_SCHEDULE: 0.1,
        STOPS: 0.2,
        CABIN: 0.1,
        DEPARTURE_SCHEDULE: 0.1,
        BAGGAGE: 0,
        DURATION: 0,
      },
    },
  });

  beforeEach(async () => {
    prisma = {
      airport: {
        findUnique: jest.fn().mockImplementation(({ where }: { where: { iataCode: string } }) => {
          if (where.iataCode === 'HAN' || where.iataCode === 'SGN' || where.iataCode === 'DAD') {
            return Promise.resolve({ iataCode: where.iataCode, name: `${where.iataCode} Airport` });
          }
          return Promise.resolve(null);
        }),
      },
      searchHistory: { create: jest.fn().mockResolvedValue({ id: 'hist_1' }), findFirst: jest.fn() },
      flightOffer: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        delete: jest.fn().mockResolvedValue({ count: 1 }),
      },
      offerRecovery: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
      },
      auditLog: { findFirst: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (callback) => {
        if (typeof callback === 'function') {
          return callback(prisma);
        }
        return callback;
      }),
    };

    cacheService = {
      get: jest.fn(),
      set: jest.fn(),
    };

    flightSearchPort = {
      search: jest.fn(),
      getOfferById: jest.fn(),
      normalizeStoredOffer: jest.fn(),
    };

    auditService = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit_1' }),
    };

    orchestratorService = {
      orchestrateSearch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CacheService, useValue: cacheService },
        { provide: FLIGHT_SEARCH_PORT, useValue: flightSearchPort },
        { provide: AuditService, useValue: auditService },
        { provide: FlightSearchOrchestratorService, useValue: orchestratorService },
      ],
    }).compile();

    service = module.get<FlightsService>(FlightsService);
  });

  describe('Validation', () => {
    it('throws BadRequestException when origin and destination are identical', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'HAN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Origin and destination must be different'),
      );
    });

    it('throws BadRequestException when returnDate is before departureDate', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-10',
        returnDate: '2026-10-05',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Return date must be on or after departure date'),
      );
    });

    it('throws BadRequestException when origin airport does not exist', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'XYZ',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Origin airport with code XYZ does not exist'),
      );
    });

    it('throws BadRequestException when destination airport does not exist', async () => {
      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'XYZ',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toThrow(
        new BadRequestException('Destination airport with code XYZ does not exist'),
      );
    });
  });

  describe('Delegation to FlightSearchOrchestratorService', () => {
    it('delegates result normalization, scoring, and metadata assembly with expected parameters', async () => {
      const rawOffer1 = createMockDuffelOffer('off_1', '250.00');
      const rawOffer2 = createMockDuffelOffer('off_2', '180.00');
      const normOffer1 = createMockNormalizedFlightOffer(rawOffer1);
      const normOffer2 = createMockNormalizedFlightOffer(rawOffer2);
      const searchHash = 'sha256_mock_hash_123';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer1, normOffer2],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer1,
            rawOffer: rawOffer1,
            scoredOffer: {
              offer: { id: 'uuid-1', originalIndex: 0 },
              matchResult: createMockMatchResult(90),
            },
          },
          {
            offer: normOffer2,
            rawOffer: rawOffer2,
            scoredOffer: {
              offer: { id: 'uuid-2', originalIndex: 1 },
              matchResult: createMockMatchResult(75),
            },
          },
        ],
        meta: {
          totalResults: 2,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 2,
          matchLevelCounts: { STRONG: 2, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        returnDate: '2026-10-15',
        adults: 2,
        children: 1,
        infants: 0,
        cabinClass: 'economy',
      };

      await service.search('user_123', query);

      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledTimes(1);
      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledWith({
        offers: [normOffer1, normOffer2],
        query: {
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          returnDate: '2026-10-15',
          adults: 2,
          children: 1,
          infants: 0,
          cabinClass: 'economy',
        },
        userId: 'user_123',
        searchHash,
        cached: false,
      });
    });

    it('passes empty array when rawResult.offers is undefined', async () => {
      const searchHash = 'sha256_empty_offers';

      flightSearchPort.search.mockResolvedValue({
        offers: [],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [],
        meta: {
          totalResults: 0,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 0,
          matchLevelCounts: { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await service.search('user_123', query);

      expect(orchestratorService.orchestrateSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          offers: [],
        }),
      );
    });
  });

  describe('Order and matchResult preservation', () => {
    it('preserves orchestrator sort order and attaches matchResult and scoredOffer id to each FlightOfferDto', async () => {
      const rawOfferA = createMockDuffelOffer('off_A', '300.00');
      const rawOfferB = createMockDuffelOffer('off_B', '150.00');
      const normOfferA = createMockNormalizedFlightOffer(rawOfferA);
      const normOfferB = createMockNormalizedFlightOffer(rawOfferB);
      const matchResultA = createMockMatchResult(60, 'FAIR');
      const matchResultB = createMockMatchResult(95, 'STRONG');

      flightSearchPort.search.mockResolvedValue({
        offers: [normOfferA, normOfferB],
        cached: false,
        searchHash: 'sha256_order_test',
      });

      // Orchestrator returns B first (higher match score), then A
      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOfferB,
            rawOffer: rawOfferB,
            scoredOffer: {
              offer: { id: 'deterministic-uuid-b', originalIndex: 1 },
              matchResult: matchResultB,
            },
          },
          {
            offer: normOfferA,
            rawOffer: rawOfferA,
            scoredOffer: {
              offer: { id: 'deterministic-uuid-a', originalIndex: 0 },
              matchResult: matchResultA,
            },
          },
        ],
        meta: {
          totalResults: 2,
          searchHash: 'sha256_order_test',
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 2,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 1, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const response = await service.search('user_123', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      expect(response.results).toHaveLength(2);

      // Verify order: B first, then A
      expect(response.results[0].id).toBe('deterministic-uuid-b');
      expect(response.results[0].duffelOfferId).toBe('off_B');
      expect(response.results[0].matchResult).toEqual(matchResultB);

      expect(response.results[1].id).toBe('deterministic-uuid-a');
      expect(response.results[1].duffelOfferId).toBe('off_A');
      expect(response.results[1].matchResult).toEqual(matchResultA);
    });
  });

  describe('Offer Persistence on Cache-Miss and Cache-Hit', () => {
    it('on cache-miss (cached: false): persists SearchHistory, and missing FlightOffer & OfferRecovery with skipDuplicates: true and zero score fields', async () => {
      const rawOffer = createMockDuffelOffer('off_miss', '199.99');
      const normOffer = createMockNormalizedFlightOffer(rawOffer, { id: 'uuid-offer-miss' });
      const searchHash = 'sha256_cache_miss';
      const matchResult = createMockMatchResult(82);

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-offer-miss', originalIndex: 0 },
              matchResult,
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // Verify transaction called
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);

      // Verify SearchHistory created
      expect(prisma.searchHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user_test',
          origin: 'HAN',
          destination: 'SGN',
          adults: 1,
          resultCount: 1,
          searchHash,
        }),
      });

      // Verify FlightOffer created with skipDuplicates: true
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'uuid-offer-miss',
            searchHash,
            supplierOfferId: 'off_miss',
            origin: 'HAN',
            destination: 'SGN',
          }),
        ],
        skipDuplicates: true,
      });

      // STRICT INVARIANT: ZERO score or dimension breakdown columns persisted to FlightOffer
      const persistedFlightOfferData = prisma.flightOffer.createMany.mock.calls[0][0].data[0];
      expect(persistedFlightOfferData).not.toHaveProperty('score');
      expect(persistedFlightOfferData).not.toHaveProperty('matchScore');
      expect(persistedFlightOfferData).not.toHaveProperty('matchResult');
      expect(persistedFlightOfferData).not.toHaveProperty('matchLevel');
      expect(persistedFlightOfferData).not.toHaveProperty('breakdown');
      expect(persistedFlightOfferData).not.toHaveProperty('scoringVersion');

      // Verify OfferRecovery created with skipDuplicates: true
      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [{ id: 'uuid-offer-miss', searchHash }],
        skipDuplicates: true,
      });
    });

    it('on cache-hit (cached: true): persists SearchHistory AND upserts missing FlightOffer & OfferRecovery with skipDuplicates: true', async () => {
      const rawOffer = createMockDuffelOffer('off_hit', '140.00');
      const normOffer = createMockNormalizedFlightOffer(rawOffer, { id: 'uuid-offer-hit' });
      const searchHash = 'sha256_cache_hit';
      const matchResult = createMockMatchResult(91);

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: true,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-offer-hit', originalIndex: 0 },
              matchResult,
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: true,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // On cache hit, SearchHistory must STILL be created
      expect(prisma.searchHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 'user_test',
          searchHash,
        }),
      });

      // AND crucially, FlightOffer and OfferRecovery must ALSO be upserted with skipDuplicates: true
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'uuid-offer-hit',
            searchHash,
            supplierOfferId: 'off_hit',
          }),
        ],
        skipDuplicates: true,
      });

      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [{ id: 'uuid-offer-hit', searchHash }],
        skipDuplicates: true,
      });
    });

    it('does not throw when write-behind transaction encounters an error', async () => {
      const rawOffer = createMockDuffelOffer('off_err');
      const normOffer = createMockNormalizedFlightOffer(rawOffer, { id: 'uuid-err' });
      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash: 'sha256_err',
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            rawOffer,
            scoredOffer: {
              offer: { id: 'uuid-err', originalIndex: 0 },
              matchResult: createMockMatchResult(),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash: 'sha256_err',
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      prisma.$transaction.mockRejectedValue(new Error('DB connection dropped'));

      const response = await service.search('user_test', {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      });

      await flushWriteBehind();

      // Search response is returned cleanly despite write-behind failure
      expect(response.results).toHaveLength(1);
    });
  });

  describe('Audit Telemetry (T037)', () => {
    it('emits search.completed audit log with safe parameters and strictly zero PII', async () => {
      const rawOffer = createMockDuffelOffer('off_audit');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_audit_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(85),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        returnDate: '2026-10-15',
        adults: 2,
        children: 1,
        infants: 1,
        cabinClass: 'economy',
      };

      const response = await service.search('user_123', query, 'trace-999', 'corr-888');

      // Verify response contains mode: 'MATCHED'
      expect(response.mode).toBe('MATCHED');

      // Find call for search.completed
      const searchCompletedCall = auditService.createLog.mock.calls.find(
        (call) => call[1]?.action === 'search.completed',
      );

      expect(searchCompletedCall).toBeDefined();
      const [tx, auditPayload] = searchCompletedCall!;
      expect(tx).toBe(prisma);
      expect(auditPayload).toMatchObject({
        userId: 'user_123',
        action: 'search.completed',
        resourceType: 'Flight',
        traceId: 'trace-999',
        correlationId: 'corr-888',
        metadata: {
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          returnDate: '2026-10-15',
          adults: 2,
          children: 1,
          infants: 1,
          cabinClass: 'economy',
          mode: 'MATCHED',
          resultCount: 1,
          eligibleCount: 1,
          duration: expect.any(Number),
          searchHash,
        },
      });

      // Assert zero PII or raw provider payloads leaked in metadata
      const metaJson = JSON.stringify(auditPayload.metadata);
      expect(metaJson).not.toContain('email');
      expect(metaJson).not.toContain('password');
      expect(metaJson).not.toContain('token');
      expect(metaJson).not.toContain('slices');
      expect(metaJson).not.toContain('offers');
    });
  });

  describe('Search Caller Characterization (T001)', () => {
    it('delegates search for user caller ("user") and handles raw search cache miss', async () => {
      const rawOffer = createMockDuffelOffer('off_user_call');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_user_caller_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(88),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const response = await service.search('user_1', query, undefined, undefined, {
        caller: 'user',
      });

      expect(flightSearchPort.search).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          adults: 1,
        }),
        'user',
      );
      expect(response.meta.cached).toBe(false);
    });

    it('delegates search for agent caller ("agent") and handles raw search cache miss', async () => {
      const rawOffer = createMockDuffelOffer('off_agent_call');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_agent_caller_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(85),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 2,
      };

      const response = await service.search('agent_user', query, undefined, undefined, {
        caller: 'agent',
      });

      expect(flightSearchPort.search).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          adults: 2,
        }),
        'agent',
      );
      expect(response.meta.cached).toBe(false);
    });

    it('defaults caller to "user" when caller option is omitted', async () => {
      const rawOffer = createMockDuffelOffer('off_default_caller');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_default_caller_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(80),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await service.search('user_1', query);

      expect(flightSearchPort.search).toHaveBeenCalledWith(
        expect.anything(),
        'user',
      );
    });

    it('returns cached result on cache hit with cached: true and 0 additional searches', async () => {
      const rawOffer = createMockDuffelOffer('off_cached_call');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_cache_hit_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: true,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(90),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: true,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      const response = await service.search('user_1', query, undefined, undefined, {
        caller: 'user',
      });

      expect(response.meta.cached).toBe(true);
      expect(flightSearchPort.search).toHaveBeenCalledTimes(1);
    });

    it('returns cached result on cache hit for agent caller with cached: true and 0 additional searches', async () => {
      const rawOffer = createMockDuffelOffer('off_cached_agent_call');
      const normOffer = createMockNormalizedFlightOffer(rawOffer);
      const searchHash = 'sha256_cache_hit_agent_hash';

      flightSearchPort.search.mockResolvedValue({
        offers: [normOffer],
        cached: true,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOffer,
            scoredOffer: {
              offer: { id: normOffer.id, originalIndex: 0 },
              matchResult: createMockMatchResult(91),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: true,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 2,
      };

      const response = await service.search('agent_user_1', query, undefined, undefined, {
        caller: 'agent',
      });

      expect(response.meta.cached).toBe(true);
      expect(flightSearchPort.search).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-10-01',
          adults: 2,
        }),
        'agent',
      );
      expect(flightSearchPort.search).toHaveBeenCalledTimes(1);
    });

    it('propagates UPSTREAM_UNAVAILABLE 502 when upstream Duffel fails and skips persistence and audit', async () => {
      flightSearchPort.search.mockRejectedValue(
        new HttpException(
          {
            message: 'Upstream flight search service is temporarily unavailable',
            code: 'UPSTREAM_UNAVAILABLE',
          },
          HttpStatus.BAD_GATEWAY,
        ),
      );

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        response: {
          code: 'UPSTREAM_UNAVAILABLE',
        },
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditService.createLog).not.toHaveBeenCalled();
    });

    it('propagates RATE_LIMIT_EXCEEDED 429 when budget limit is exhausted and skips persistence and audit', async () => {
      flightSearchPort.search.mockRejectedValue(
        new HttpException(
          {
            message: 'Flight search capacity temporarily reached. Please try again later.',
            code: 'RATE_LIMIT_EXCEEDED',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
      };

      await expect(service.search('user_1', query)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        response: {
          code: 'RATE_LIMIT_EXCEEDED',
        },
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditService.createLog).not.toHaveBeenCalled();
    });
  });

  describe('Deterministic offer UUID assignment and slice/segment order preservation (T001)', () => {
    it('assigns deterministic offer UUID and preserves slice and segment index order for multi-leg journeys', async () => {
      const multiSliceOffer: DuffelOffer = {
        id: 'off_multi_seg',
        total_amount: '350.00',
        total_currency: 'USD',
        slices: [
          {
            id: 'sli_outbound',
            duration: 'PT3H30M',
            origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            segments: [
              {
                id: 'seg_out_0',
                duration: 'PT1H20M',
                departing_at: '2026-10-01T08:00:00',
                arriving_at: '2026-10-01T09:20:00',
                origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '101',
                aircraft: { id: 'arc_1', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
              {
                id: 'seg_out_1',
                duration: 'PT1H30M',
                departing_at: '2026-10-01T11:00:00',
                arriving_at: '2026-10-01T12:30:00',
                origin: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '102',
                aircraft: { id: 'arc_2', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
            ],
          },
          {
            id: 'sli_return',
            duration: 'PT3H30M',
            origin: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            destination: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            segments: [
              {
                id: 'seg_ret_0',
                duration: 'PT1H30M',
                departing_at: '2026-10-15T14:00:00',
                arriving_at: '2026-10-15T15:30:00',
                origin: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                destination: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '201',
                aircraft: { id: 'arc_3', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
              {
                id: 'seg_ret_1',
                duration: 'PT1H20M',
                departing_at: '2026-10-15T17:00:00',
                arriving_at: '2026-10-15T18:20:00',
                origin: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                destination: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '202',
                aircraft: { id: 'arc_4', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_1', type: 'adult' }],
        passenger_identity_documents_required: false,
      };

      const expectedDeterministicUuid = generateDeterministicUUID(multiSliceOffer.id);
      const searchHash = 'sha256_order_and_uuid_test';
      const normMultiOffer = createMockNormalizedFlightOffer(multiSliceOffer);

      flightSearchPort.search.mockResolvedValue({
        offers: [normMultiOffer],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normMultiOffer,
            scoredOffer: {
              offer: { id: expectedDeterministicUuid, originalIndex: 0 },
              matchResult: createMockMatchResult(92),
            },
          },
        ],
        meta: {
          totalResults: 1,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 1,
          matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        returnDate: '2026-10-15',
        adults: 1,
        cabinClass: 'economy',
      };

      const response = await service.search('user_test', query, undefined, undefined, {
        persistence: 'required',
      });

      expect(response.results).toHaveLength(1);
      const offerResult = response.results[0];

      // 1. Assert deterministic offer UUID assignment
      expect(offerResult.id).toBe(expectedDeterministicUuid);
      expect(offerResult.duffelOfferId).toBe('off_multi_seg');

      // 2. Assert preservation of slice/segment index order
      // Outbound segments order preserved
      expect(offerResult.flightNumber).toBe('VN101');
      expect(offerResult.segments).toHaveLength(2);
      expect(offerResult.segments[0].departureAirport).toBe('HAN');
      expect(offerResult.segments[0].arrivalAirport).toBe('DAD');
      expect(offerResult.segments[0].carrierCode).toBe('VN');
      expect(offerResult.segments[0].flightNumber).toBe('101');
      expect(offerResult.segments[1].departureAirport).toBe('DAD');
      expect(offerResult.segments[1].arrivalAirport).toBe('SGN');
      expect(offerResult.segments[1].carrierCode).toBe('VN');
      expect(offerResult.segments[1].flightNumber).toBe('102');

      // Return segments order preserved
      expect(offerResult.returnSegments).toHaveLength(2);
      expect(offerResult.returnSegments![0].departureAirport).toBe('SGN');
      expect(offerResult.returnSegments![0].arrivalAirport).toBe('DAD');
      expect(offerResult.returnSegments![0].carrierCode).toBe('VN');
      expect(offerResult.returnSegments![0].flightNumber).toBe('201');
      expect(offerResult.returnSegments![1].departureAirport).toBe('DAD');
      expect(offerResult.returnSegments![1].arrivalAirport).toBe('HAN');
      expect(offerResult.returnSegments![1].carrierCode).toBe('VN');
      expect(offerResult.returnSegments![1].flightNumber).toBe('202');

      // Stops and endpoints
      expect(offerResult.departureAirport).toBe('HAN');
      expect(offerResult.arrivalAirport).toBe('SGN');
      expect(offerResult.stops).toBe(2);

      // Verify deterministic UUID is persisted in database
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: expectedDeterministicUuid,
            supplierOfferId: 'off_multi_seg',
            searchHash,
          }),
        ],
        skipDuplicates: true,
      });

      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [{ id: expectedDeterministicUuid, searchHash }],
        skipDuplicates: true,
      });
    });

    it('assigns unique deterministic UUIDs and preserves segment orders across multiple distinct ranked offers', async () => {
      const offerA: DuffelOffer = {
        id: 'off_flight_a',
        total_amount: '200.00',
        total_currency: 'USD',
        slices: [
          {
            id: 'sli_a_out',
            duration: 'PT3H0M',
            origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            segments: [
              {
                id: 'seg_a_1',
                duration: 'PT1H20M',
                departing_at: '2026-10-01T08:00:00',
                arriving_at: '2026-10-01T09:20:00',
                origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '111',
                aircraft: { id: 'arc_1', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
              {
                id: 'seg_a_2',
                duration: 'PT1H10M',
                departing_at: '2026-10-01T10:30:00',
                arriving_at: '2026-10-01T11:40:00',
                origin: { id: 'DAD', name: 'Da Nang', iata_code: 'DAD', type: 'airport' },
                destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '112',
                aircraft: { id: 'arc_2', name: 'Airbus A321', iata_code: '321' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_1', type: 'adult' }],
        passenger_identity_documents_required: false,
      };

      const offerB: DuffelOffer = {
        id: 'off_flight_b',
        total_amount: '250.00',
        total_currency: 'USD',
        slices: [
          {
            id: 'sli_b_out',
            duration: 'PT2H10M',
            origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
            destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
            segments: [
              {
                id: 'seg_b_1',
                duration: 'PT2H10M',
                departing_at: '2026-10-01T14:00:00',
                arriving_at: '2026-10-01T16:10:00',
                origin: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '120',
                aircraft: { id: 'arc_3', name: 'Airbus A350', iata_code: '350' },
                passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_1', type: 'adult' }],
        passenger_identity_documents_required: false,
      };

      const uuidA = generateDeterministicUUID(offerA.id);
      const uuidB = generateDeterministicUUID(offerB.id);
      const rfc4122Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      expect(uuidA).not.toBe(uuidB);
      expect(uuidA).toMatch(rfc4122Regex);
      expect(uuidB).toMatch(rfc4122Regex);

      const normOfferA = createMockNormalizedFlightOffer(offerA);
      const normOfferB = createMockNormalizedFlightOffer(offerB);

      const searchHash = 'sha256_multi_offer_hash';
      flightSearchPort.search.mockResolvedValue({
        offers: [normOfferA, normOfferB],
        cached: false,
        searchHash,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: normOfferA,
            scoredOffer: {
              offer: { id: uuidA, originalIndex: 0 },
              matchResult: createMockMatchResult(95),
            },
          },
          {
            offer: normOfferB,
            scoredOffer: {
              offer: { id: uuidB, originalIndex: 1 },
              matchResult: createMockMatchResult(80),
            },
          },
        ],
        meta: {
          totalResults: 2,
          searchHash,
          cached: false,
          requestedCabinClass: 'economy',
          scoringVersion: 'flight-match-v1',
          eligibleCount: 2,
          matchLevelCounts: { STRONG: 2, GOOD: 0, FAIR: 0, WEAK: 0 },
        },
        droppedCount: 0,
        rejectionCounts: {},
      });

      const query: FlightSearchRequestDto = {
        origin: 'HAN',
        destination: 'SGN',
        departureDate: '2026-10-01',
        adults: 1,
        cabinClass: 'economy',
      };

      const response = await service.search('user_test', query, undefined, undefined, {
        persistence: 'required',
      });

      expect(response.results).toHaveLength(2);

      // Offer A assertions (index 0)
      expect(response.results[0].id).toBe(uuidA);
      expect(response.results[0].duffelOfferId).toBe('off_flight_a');
      expect(response.results[0].segments).toHaveLength(2);
      expect(response.results[0].segments[0].flightNumber).toBe('111');
      expect(response.results[0].segments[1].flightNumber).toBe('112');

      // Offer B assertions (index 1)
      expect(response.results[1].id).toBe(uuidB);
      expect(response.results[1].duffelOfferId).toBe('off_flight_b');
      expect(response.results[1].segments).toHaveLength(1);
      expect(response.results[1].segments[0].flightNumber).toBe('120');

      // Assert persistence received both deterministic UUIDs in transaction
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({ id: uuidA, supplierOfferId: 'off_flight_a', searchHash }),
          expect.objectContaining({ id: uuidB, supplierOfferId: 'off_flight_b', searchHash }),
        ],
        skipDuplicates: true,
      });

      expect(prisma.offerRecovery.createMany).toHaveBeenCalledWith({
        data: [
          { id: uuidA, searchHash },
          { id: uuidB, searchHash },
        ],
        skipDuplicates: true,
      });
    });
  });

  describe('Live Offer Detail Characterization (T001)', () => {
    const offerId = '550e8400-e29b-41d4-a716-446655440000';
    const userId = 'user_detail_test';

    const createMockStoredFlightOffer = (
      id = offerId,
      price = '150.00',
      supplierOfferId = 'off_stored_123',
    ) => ({
      id,
      searchHash: 'sha256_mock_hash',
      supplierOfferId,
      origin: 'HAN',
      destination: 'SGN',
      departureDate: new Date('2026-10-01T08:00:00.000Z'),
      returnDate: new Date('2026-10-15T15:00:00.000Z'),
      adults: 1,
      children: 0,
      infants: 0,
      cabinClass: 'economy',
      price: new Prisma.Decimal(price),
      currency: 'USD',
      rawOffer: {},
    });

    const createMockLiveOffer = (
      duffelOfferId = 'off_stored_123',
      totalAmount = '150.00',
    ): FlightOffer => {
      const rawOffer = createMockDuffelOffer(duffelOfferId, totalAmount);
      return createMockNormalizedFlightOffer(rawOffer, {
        conditions: {
          refundable: true,
          changeable: false,
          changeBeforeDeparture: null,
        },
      });
    };

    it('retrieves live detail successfully with confirmed price and availability matching stored offer', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockResolvedValue(
        createMockLiveOffer('off_stored_123', '150.00'),
      );

      const detail = await service.getFlightDetail(offerId, userId);

      expect(detail.id).toBe(offerId);
      expect(detail.originalPrice).toBe(150);
      expect(detail.confirmedPrice).toBe(150);
      expect(detail.priceChanged).toBe(false);
      expect(detail.airline).toBe('Vietnam Airlines');
      expect(detail.conditions.refundable).toBe(true);
      expect(detail.conditions.changeable).toBe(false);
      expect(flightSearchPort.getOfferById).toHaveBeenCalledWith('off_stored_123');

      expect(auditService.createLog).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          userId,
          action: 'flight_detail_view',
          resourceType: 'Flight',
          resourceId: offerId,
          metadata: expect.objectContaining({
            flightId: offerId,
            duffelOfferId: 'off_stored_123',
            priceChanged: false,
            originalPrice: 150,
            confirmedPrice: 150,
          }),
        }),
      );
    });

    it('detects price drift when live offer price differs from stored price', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockResolvedValue(
        createMockLiveOffer('off_stored_123', '175.50'),
      );

      const detail = await service.getFlightDetail(offerId, userId);

      expect(detail.originalPrice).toBe(150);
      expect(detail.confirmedPrice).toBe(175.5);
      expect(detail.priceChanged).toBe(true);

      expect(auditService.createLog).toHaveBeenCalledWith(
        prisma,
        expect.objectContaining({
          metadata: expect.objectContaining({
            priceChanged: true,
            originalPrice: 150,
            confirmedPrice: 175.5,
          }),
        }),
      );
    });

    it('purges DB row and throws HttpException OFFER_EXPIRED (410) when upstream returns 404', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockRejectedValue({ status: 404, message: 'Offer not found' });

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.GONE,
        response: {
          code: 'OFFER_EXPIRED',
          recovery: expect.objectContaining({
            origin: 'HAN',
            destination: 'SGN',
            departureDate: '2026-10-01',
          }),
        },
      });

      expect(prisma.flightOffer.delete).toHaveBeenCalledWith({
        where: { id: offerId },
      });
    });

    it('purges DB row and throws HttpException OFFER_EXPIRED (410) when upstream returns 410', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockRejectedValue({ status: 410, message: 'Offer expired' });

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.GONE,
        response: {
          code: 'OFFER_EXPIRED',
        },
      });

      expect(prisma.flightOffer.delete).toHaveBeenCalledWith({
        where: { id: offerId },
      });
    });

    it('catches DB purge error gracefully and still throws OFFER_EXPIRED (410) without an unhandled crash', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockRejectedValue({ status: 404, message: 'Offer not found' });
      prisma.flightOffer.delete.mockRejectedValue(new Error('DB disconnect during purge'));

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.GONE,
        response: {
          code: 'OFFER_EXPIRED',
        },
      });

      expect(prisma.flightOffer.delete).toHaveBeenCalledWith({
        where: { id: offerId },
      });
    });

    it('translates upstream 500 error into BAD_GATEWAY without DB purge', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockRejectedValue(new Error('Duffel API failure'));

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        response: {
          code: 'UPSTREAM_UNAVAILABLE',
        },
      });

      expect(prisma.flightOffer.delete).not.toHaveBeenCalled();
    });

    it('translates DuffelTimeoutError from getOfferById into BAD_GATEWAY without DB purge', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(
        createMockStoredFlightOffer(offerId, '150.00', 'off_stored_123'),
      );
      flightSearchPort.getOfferById.mockRejectedValue(new DuffelTimeoutError());

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.BAD_GATEWAY,
        response: {
          code: 'UPSTREAM_UNAVAILABLE',
        },
      });

      expect(prisma.flightOffer.delete).not.toHaveBeenCalled();
    });

    it('falls back to offerRecovery and searchHistory and throws OFFER_EXPIRED (410) when offer row was purged', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(null);
      prisma.offerRecovery.findUnique.mockResolvedValue({
        id: offerId,
        searchHash: 'hash_recovered',
      });
      prisma.searchHistory.findFirst.mockResolvedValue({
        origin: 'HAN',
        destination: 'SGN',
        departureDate: new Date('2026-10-01T00:00:00.000Z'),
        returnDate: null,
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      });

      await expect(service.getFlightDetail(offerId, userId)).rejects.toMatchObject({
        status: HttpStatus.GONE,
        response: {
          code: 'OFFER_EXPIRED',
          recovery: expect.objectContaining({
            origin: 'HAN',
            destination: 'SGN',
            departureDate: '2026-10-01',
          }),
        },
      });
    });

    it('throws NOT_FOUND 404 when offer does not exist in DB or recovery for valid UUID', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(null);
      prisma.offerRecovery.findUnique.mockResolvedValue(null);

      const validUuid = '550e8400-e29b-41d4-a716-446655440099';
      await expect(service.getFlightDetail(validUuid, userId)).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
        response: {
          code: 'NOT_FOUND',
        },
      });
    });

    it('throws BadRequestException for invalid UUID format when offer not in DB or recovery', async () => {
      prisma.flightOffer.findUnique.mockResolvedValue(null);
      prisma.offerRecovery.findUnique.mockResolvedValue(null);

      await expect(service.getFlightDetail('invalid-uuid-format', userId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});


