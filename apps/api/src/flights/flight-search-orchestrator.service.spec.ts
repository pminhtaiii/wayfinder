import { Test, TestingModule } from '@nestjs/testing';
import { DuffelOffer } from '@/duffel/duffel.types';
import { ProfileService, ScoringPreferences as ProfileScoringPreferences } from '@/profile/profile.service';
import { FlightMatchScorerService } from '@/flight-match/flight-match-scorer.service';
import { CategoryRankerService } from '@/flight-match/category-ranker.service';
import {
  FlightSearchOrchestratorService,
  OrchestratorParams,
  hasEffectivePreferences,
} from './flight-search-orchestrator.service';
import { FlightOffer, FlightSearchResult } from '@/supplier/search/flight-search.port';
import { generateDeterministicUUID } from './flight-offer-normalizer';
import {
  ActiveWeights,
  FlightMatchInput,
} from '@/flight-match/flight-match.types';

describe('FlightSearchOrchestratorService', () => {
  let service: FlightSearchOrchestratorService;
  let profileService: jest.Mocked<Pick<ProfileService, 'getScoringPreferences'>>;
  let scorer: jest.Mocked<Pick<FlightMatchScorerService, 'scoreAll'>>;
  let categoryRanker: jest.Mocked<Pick<CategoryRankerService, 'rank'>>;

  const createMockDuffelOffer = (id: string, overrides: Partial<DuffelOffer> = {}): DuffelOffer => ({
    id,
    total_amount: '200.00',
    total_currency: 'USD',
    passenger_identity_documents_required: false,
    passengers: [{ id: 'pas_1', type: 'adult' }],
    slices: [
      {
        id: `sli_${id}`,
        duration: 'PT2H',
        origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
        destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
        segments: [
          {
            id: `seg_${id}`,
            duration: 'PT2H',
            departing_at: '2026-09-01T08:00:00',
            arriving_at: '2026-09-01T10:00:00',
            origin: { id: 'plc_sfo', name: 'San Francisco', iata_code: 'SFO', type: 'airport' },
            destination: { id: 'plc_jfk', name: 'New York', iata_code: 'JFK', type: 'airport' },
            marketing_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
            operating_carrier: { id: 'arl_ba', name: 'British Airways', iata_code: 'BA' },
            marketing_carrier_flight_number: '100',
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
    ...overrides,
  });

  const createMockNormalizedFlightOffer = (
    id: string,
    rawDuffelOffer: DuffelOffer = createMockDuffelOffer(id),
    overrides: Partial<FlightOffer> = {},
  ): FlightOffer => {
    const deterministicId = generateDeterministicUUID(id);
    const totalAmount = overrides.totalAmount ?? rawDuffelOffer.total_amount;
    const currency = overrides.currency ?? rawDuffelOffer.total_currency;
    const price = overrides.price ?? parseFloat(totalAmount);
    return {
      id: deterministicId,
      supplierOfferId: id,
      totalAmount,
      price,
      currency,
      offerExpiresAt: null,
      passengers: [{ supplierPassengerId: 'pas_1', type: 'ADULT' }],
      airline: 'British Airways',
      flightNumber: 'BA100',
      departureAirport: 'SFO',
      arrivalAirport: 'JFK',
      departureTime: '2026-09-01T08:00:00',
      arrivalTime: '2026-09-01T10:00:00',
      duration: 120,
      stops: 0,
      fareClass: 'Economy',
      baggageAllowance: '1 checked bag(s)',
      segments: [
        {
          supplierSegmentId: `seg_${id}`,
          carrierCode: 'BA',
          flightNumber: '100',
          operatingCarrier: 'British Airways',
          departureAirport: 'SFO',
          departureTerminal: null,
          departureTime: '2026-09-01T08:00:00',
          arrivalAirport: 'JFK',
          arrivalTerminal: null,
          arrivalTime: '2026-09-01T10:00:00',
          duration: 120,
          aircraft: null,
          cabinClass: 'economy',
        },
      ],
      returnSegments: null,
      conditions: {
        refundable: false,
        changeable: true,
        changeBeforeDeparture: null,
      },
      matchInput: {
        id: deterministicId,
        price,
        currency,
        stops: 0,
        duration: 120,
        outboundDepartureHour: 8,
        outboundArrivalHour: 10,
        carrierCodes: ['BA'],
        cabinClass: 'economy',
        hasCheckedBaggage: true,
        originalIndex: 0,
      },
      rawSupplierPayload: rawDuffelOffer,
      ...overrides,
    };
  };

  const coldStartPreferences: ProfileScoringPreferences = {
    preferredAirlines: [],
    blacklistedAirlines: [],
    classPreference: null,
    preferredDepartureWindow: null,
    preferredArrivalWindow: null,
    maxStops: null,
    priceSensitivity: null,
    requiresCheckedBaggage: null,
  };

  const defaultPreferences: ProfileScoringPreferences = {
    ...coldStartPreferences,
    preferredAirlines: ['BA'],
  };

  const mockActiveWeights: ActiveWeights = {
    PRICE: 0.25,
    AIRLINE: 0.15,
    ARRIVAL_SCHEDULE: 0.1,
    STOPS: 0.15,
    CABIN: 0.1,
    DEPARTURE_SCHEDULE: 0.1,
    BAGGAGE: 0.05,
    DURATION: 0.1,
  };

  const defaultQuery: OrchestratorParams['query'] = {
    origin: 'SFO',
    destination: 'JFK',
    departureDate: '2026-09-01',
    adults: 1,
  };

  beforeEach(async () => {
    profileService = {
      getScoringPreferences: jest.fn().mockResolvedValue(defaultPreferences),
    };

    scorer = {
      scoreAll: jest.fn().mockImplementation((offers: readonly FlightMatchInput[]) =>
        offers.map((offer) => ({
          offer,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 85,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: {
              scoringVersion: 'flight-match-v1',
              activeWeights: mockActiveWeights,
            },
          },
        })),
      ),
    };

    categoryRanker = {
      rank: jest.fn().mockImplementation((offers) => [...offers]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FlightSearchOrchestratorService,
        { provide: ProfileService, useValue: profileService },
        { provide: FlightMatchScorerService, useValue: scorer },
        { provide: CategoryRankerService, useValue: categoryRanker },
      ],
    }).compile();

    service = module.get<FlightSearchOrchestratorService>(FlightSearchOrchestratorService);
  });

  describe('Core Flow & Normalization', () => {
    it('accepts canonical offers and caps at 20 canonical valid offers', async () => {
      const offers: FlightOffer[] = [];
      for (let i = 0; i < 25; i++) {
        const offer = createMockNormalizedFlightOffer(`off_${i.toString().padStart(2, '0')}`);
        offers.push({
          ...offer,
          matchInput: { ...offer.matchInput, originalIndex: i },
        });
      }

      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledTimes(1);
      const passedOffers = scorer.scoreAll.mock.calls[0][0];
      expect(passedOffers).toHaveLength(20);
      expect(passedOffers[0].id).toBeDefined();
      expect(response.results).toHaveLength(20);
      expect(response.mode).toBe('MATCHED');
    });

    it('tracks dropped offers and rejection counts for mixed currencies', async () => {
      const validOffer = createMockNormalizedFlightOffer('off_valid');
      const mixedCurrencyOffer = createMockNormalizedFlightOffer(
        'off_eur',
        createMockDuffelOffer('off_eur', { total_currency: 'EUR' }),
        {
          currency: 'EUR',
          matchInput: {
            ...createMockNormalizedFlightOffer('off_eur').matchInput,
            currency: 'EUR',
          },
        },
      );

      const params: OrchestratorParams = {
        offers: [validOffer, mixedCurrencyOffer],
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(1);
      expect(response.rejectionCounts['MIXED_CURRENCY']).toBe(1);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].offer.supplierOfferId).toBe('off_valid');
    });

    it('maps scored offers back to corresponding canonical offers by originalIndex and offer id', async () => {
      const offer0 = createMockNormalizedFlightOffer('off_0');
      const offer1 = createMockNormalizedFlightOffer('off_1');
      const offer2 = createMockNormalizedFlightOffer('off_2');
      const offers: FlightOffer[] = [
        { ...offer0, matchInput: { ...offer0.matchInput, originalIndex: 0 } },
        { ...offer1, matchInput: { ...offer1.matchInput, originalIndex: 1 } },
        { ...offer2, matchInput: { ...offer2.matchInput, originalIndex: 2 } },
      ];

      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      scorer.scoreAll.mockImplementation((scoredOffers: readonly FlightMatchInput[]) =>
        [...scoredOffers].reverse().map((offer) => ({
          offer,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: offer.originalIndex === 2 ? 90 : 70,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: {
              scoringVersion: 'flight-match-v1',
              activeWeights: mockActiveWeights,
            },
          },
        })),
      );

      const response = await service.orchestrateSearch(params);

      expect(response.results).toHaveLength(3);
      expect(response.results[0].offer.supplierOfferId).toBe('off_2');
      expect(response.results[0].scoredOffer.offer.originalIndex).toBe(2);
      expect(response.results[1].offer.supplierOfferId).toBe('off_1');
      expect(response.results[1].scoredOffer.offer.originalIndex).toBe(1);
      expect(response.results[2].offer.supplierOfferId).toBe('off_0');
      expect(response.results[2].scoredOffer.offer.originalIndex).toBe(0);
    });
  });

  describe('Profile Fetching', () => {
    it('calls profileService.getScoringPreferences exactly once when userId is present', async () => {
      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: defaultQuery,
        userId: 'usr_123',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).toHaveBeenCalledTimes(1);
      expect(profileService.getScoringPreferences).toHaveBeenCalledWith('usr_123');
    });

    it('uses default empty preferences, does not call profileService, and switches to RANKED mode when userId is null', async () => {
      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: defaultQuery,
        userId: null,
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledTimes(1);
      expect(response.mode).toBe('RANKED');
    });

    it('uses default empty preferences, does not call profileService, and switches to RANKED mode when userId is undefined', async () => {
      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: defaultQuery,
        userId: undefined,
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledTimes(1);
      expect(response.mode).toBe('RANKED');
    });

    it('uses default empty preferences, does not call profileService, and switches to RANKED mode when userId is empty string', async () => {
      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: defaultQuery,
        userId: '   ',
        searchHash: 'hash_123',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).not.toHaveBeenCalled();
      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledTimes(1);
      expect(response.mode).toBe('RANKED');
    });
  });

  describe('Query Cabin Precedence (Decision 3)', () => {
    it('overrides profile classPreference with query.cabinClass when profile preference is set', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'economy',
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: 'business' },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'business',
        }),
      );
    });

    it('retains profile classPreference when query.cabinClass is not provided', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'premium_economy',
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'premium_economy',
        }),
      );
    });

    it('keeps effective classPreference null when profile classPreference is null, even if query.cabinClass is provided', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: null,
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: 'first' },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: null,
        }),
      );
    });

    it("ignores unsupported profile classPreference (e.g. 'unknown_class', 'coach') and leaves effective classPreference null when query.cabinClass is omitted", async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'coach',
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: null,
        }),
      );
    });

    it("applies valid query.cabinClass override when profile classPreference is non-empty unsupported (e.g. 'unknown_class')", async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: 'unknown_class',
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: 'business' },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'business',
        }),
      );
    });

    it("handles case-insensitive and trimmed profile classPreference (e.g. ' ECONOMY ')", async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        classPreference: ' ECONOMY ',
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_1',
        searchHash: 'hash_123',
        cached: false,
      };

      await service.orchestrateSearch(params);

      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          classPreference: 'economy',
        }),
      );
    });
  });

  describe('Raw-Cache Hit Rescoring & Zero Persistence (T034)', () => {
    it('re-scores cached offers using requesting user profile preferences and sets meta.cached: true', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...defaultPreferences,
        preferredAirlines: ['BA', 'VS'],
        maxStops: 0,
      });

      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_cached_1')],
        query: defaultQuery,
        userId: 'usr_rescore_42',
        searchHash: 'hash_cached_rescore',
        cached: true,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).toHaveBeenCalledWith('usr_rescore_42');
      expect(scorer.scoreAll).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          preferredAirlines: ['BA', 'VS'],
          maxStops: 0,
        }),
      );
      expect(response.meta.cached).toBe(true);
      expect(response.meta.searchHash).toBe('hash_cached_rescore');
    });

    it('enforces zero persistence invariant: orchestrator has zero persistence dependencies and performs 0 DB/cache writes', () => {
      expect(service).not.toHaveProperty('prisma');
      expect(service).not.toHaveProperty('prismaService');
      expect(service).not.toHaveProperty('cacheService');
      expect(service).not.toHaveProperty('redis');

      const propertyKeys = Object.getOwnPropertyNames(service);
      expect(propertyKeys).toEqual(
        expect.arrayContaining(['profileService', 'scorer', 'categoryRanker', 'logger']),
      );
      expect(propertyKeys).not.toContain('prisma');
      expect(propertyKeys).not.toContain('prismaService');
      expect(propertyKeys).not.toContain('cacheService');
    });
  });

  describe('Aggregate Metadata Generation (T034)', () => {
    it('accurately counts all 4 match levels (STRONG, GOOD, FAIR, WEAK) in matchLevelCounts', async () => {
      const offers = [
        createMockNormalizedFlightOffer('off_1'),
        createMockNormalizedFlightOffer('off_2'),
        createMockNormalizedFlightOffer('off_3'),
        createMockNormalizedFlightOffer('off_4'),
      ];

      scorer.scoreAll.mockReturnValueOnce([
        {
          offer: offers[0].matchInput,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 95,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
        {
          offer: offers[1].matchInput,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 75,
            matchLevel: 'GOOD',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
        {
          offer: offers[2].matchInput,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 55,
            matchLevel: 'FAIR',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
        {
          offer: offers[3].matchInput,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 35,
            matchLevel: 'WEAK',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
      ]);

      const params: OrchestratorParams = {
        offers,
        query: { ...defaultQuery, cabinClass: 'business' },
        userId: 'usr_meta',
        searchHash: 'hash_meta_full',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.meta).toEqual({
        totalResults: 4,
        searchHash: 'hash_meta_full',
        cached: false,
        requestedCabinClass: 'business',
        scoringVersion: 'flight-match-v1',
        eligibleCount: 4,
        matchLevelCounts: {
          STRONG: 1,
          GOOD: 1,
          FAIR: 1,
          WEAK: 1,
        },
      });
    });

    it('strictly excludes ineligible offers (eligible: false, matchLevel: null) from matchLevelCounts', async () => {
      const offers = [
        createMockNormalizedFlightOffer('off_1'),
        createMockNormalizedFlightOffer('off_2'),
        createMockNormalizedFlightOffer('off_3'),
      ];

      scorer.scoreAll.mockReturnValueOnce([
        {
          offer: offers[0].matchInput,
          matchResult: {
            eligibility: { eligible: true, violations: [] },
            score: 85,
            matchLevel: 'STRONG',
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
        {
          offer: offers[1].matchInput,
          matchResult: {
            eligibility: {
              eligible: false,
              violations: [
                {
                  constraint: 'BLACKLISTED_AIRLINE',
                  explanation: {
                    key: 'constraint.airline.blacklisted',
                    params: { airline: 'BA' },
                  },
                },
              ],
            },
            score: null,
            matchLevel: null,
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
        {
          offer: offers[2].matchInput,
          matchResult: {
            eligibility: {
              eligible: false,
              violations: [
                {
                  constraint: 'BLACKLISTED_AIRLINE',
                  explanation: {
                    key: 'constraint.airline.blacklisted',
                    params: { airline: 'BA' },
                  },
                },
              ],
            },
            score: null,
            matchLevel: null,
            breakdown: [],
            metadata: { scoringVersion: 'flight-match-v1', activeWeights: mockActiveWeights },
          },
        },
      ]);

      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: 'usr_ineligible',
        searchHash: 'hash_ineligible',
        cached: true,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.meta.totalResults).toBe(3);
      expect(response.meta.eligibleCount).toBe(1);
      expect(response.meta.matchLevelCounts).toEqual({
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      });
      expect(response.meta.scoringVersion).toBe('flight-match-v1');
    });

    it('returns zero counts for eligibleCount and all buckets when canonical offers are empty', async () => {
      const params: OrchestratorParams = {
        offers: [],
        query: defaultQuery,
        userId: 'usr_empty',
        searchHash: 'hash_empty',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.results).toEqual([]);
      expect(response.droppedCount).toBe(0);
      expect(response.meta).toEqual({
        totalResults: 0,
        searchHash: 'hash_empty',
        cached: false,
        requestedCabinClass: 'economy',
        scoringVersion: 'flight-match-v1',
        eligibleCount: 0,
        matchLevelCounts: {
          STRONG: 0,
          GOOD: 0,
          FAIR: 0,
          WEAK: 0,
        },
      });
    });

    it('defaults requestedCabinClass to economy when query.cabinClass is not provided', async () => {
      const params: OrchestratorParams = {
        offers: [createMockNormalizedFlightOffer('off_1')],
        query: { ...defaultQuery, cabinClass: undefined },
        userId: 'usr_default_cabin',
        searchHash: 'hash_cabin_default',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);
      expect(response.meta.requestedCabinClass).toBe('economy');
    });
  });

  describe('Invalid Offer Tracking & Telemetry (T034)', () => {
    it('logs telemetry when offers are dropped for currency mismatch without failing', async () => {
      const validOfferUSD1 = createMockNormalizedFlightOffer('off_usd_1');
      const validOfferUSD2 = createMockNormalizedFlightOffer('off_usd_2');
      const mismatchOfferEUR = createMockNormalizedFlightOffer(
        'off_curr_mismatch',
        createMockDuffelOffer('off_curr_mismatch', { total_currency: 'EUR' }),
        {
          currency: 'EUR',
          matchInput: {
            ...createMockNormalizedFlightOffer('off_curr_mismatch').matchInput,
            currency: 'EUR',
          },
        },
      );

      const params: OrchestratorParams = {
        offers: [validOfferUSD1, validOfferUSD2, mismatchOfferEUR],
        query: defaultQuery,
        userId: 'usr_telemetry',
        searchHash: 'hash_telemetry_test',
        cached: false,
      };

      const loggerWarnSpy = jest.spyOn(service.logger, 'warn');

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(1);
      expect(response.rejectionCounts).toEqual({
        MIXED_CURRENCY: 1,
      });
      expect(response.results).toHaveLength(2);
      expect(response.results[0].offer.supplierOfferId).toBe('off_usd_1');
      expect(response.meta.totalResults).toBe(2);

      expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('hash_telemetry_test'),
        expect.objectContaining({
          searchHash: 'hash_telemetry_test',
          droppedCount: 1,
          rejectionCounts: {
            MIXED_CURRENCY: 1,
          },
        }),
      );
    });

    it('does not log telemetry when droppedCount is 0', async () => {
      const validOffer = createMockNormalizedFlightOffer('off_clean');
      const params: OrchestratorParams = {
        offers: [validOffer],
        query: defaultQuery,
        userId: 'usr_clean',
        searchHash: 'hash_clean',
        cached: false,
      };

      const loggerWarnSpy = jest.spyOn(service.logger, 'warn');

      const response = await service.orchestrateSearch(params);

      expect(response.droppedCount).toBe(0);
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('hasEffectivePreferences (T042 Truth Table)', () => {
    const coldStartPreferences = {
      preferredAirlines: [],
      blacklistedAirlines: [],
      classPreference: null,
      preferredDepartureWindow: null,
      preferredArrivalWindow: null,
      maxStops: null,
      priceSensitivity: null,
      requiresCheckedBaggage: null,
    };

    it('returns false for cold start when all fields are null or empty arrays', () => {
      expect(hasEffectivePreferences(coldStartPreferences)).toBe(false);
    });

    describe('preferredAirlines', () => {
      it('returns true when preferredAirlines contains at least one airline code', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredAirlines: ['BA'],
          }),
        ).toBe(true);
      });

      it('returns false when preferredAirlines is empty array', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredAirlines: [],
          }),
        ).toBe(false);
      });
    });

    describe('blacklistedAirlines (blacklist-only preference)', () => {
      it('returns true when blacklistedAirlines contains at least one airline code (blacklist-only)', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            blacklistedAirlines: ['FR'],
          }),
        ).toBe(true);
      });

      it('returns false when blacklistedAirlines is empty array', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            blacklistedAirlines: [],
          }),
        ).toBe(false);
      });
    });

    describe('classPreference', () => {
      it('returns true when classPreference is a valid non-empty string', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            classPreference: 'economy',
          }),
        ).toBe(true);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            classPreference: 'business',
          }),
        ).toBe(true);
      });

      it('returns false when classPreference is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            classPreference: null,
          }),
        ).toBe(false);
      });

      it('returns false when classPreference is empty or whitespace-only string', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            classPreference: '',
          }),
        ).toBe(false);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            classPreference: '   ',
          }),
        ).toBe(false);
      });
    });

    describe('preferredDepartureWindow', () => {
      it('returns true when preferredDepartureWindow is set', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredDepartureWindow: { start: 6, end: 12 },
          }),
        ).toBe(true);
      });

      it('returns false when preferredDepartureWindow is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredDepartureWindow: null,
          }),
        ).toBe(false);
      });
    });

    describe('preferredArrivalWindow', () => {
      it('returns true when preferredArrivalWindow is set', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredArrivalWindow: { start: 14, end: 20 },
          }),
        ).toBe(true);
      });

      it('returns false when preferredArrivalWindow is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            preferredArrivalWindow: null,
          }),
        ).toBe(false);
      });
    });

    describe('maxStops', () => {
      it('returns true when maxStops is 0 (direct flights only - falsy integer edge case)', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            maxStops: 0,
          }),
        ).toBe(true);
      });

      it('returns true when maxStops is 1, 2, or 3', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            maxStops: 1,
          }),
        ).toBe(true);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            maxStops: 2,
          }),
        ).toBe(true);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            maxStops: 3,
          }),
        ).toBe(true);
      });

      it('returns false when maxStops is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            maxStops: null,
          }),
        ).toBe(false);
      });
    });

    describe('priceSensitivity', () => {
      it('returns true when priceSensitivity is BUDGET, MODERATE, or FLEXIBLE', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            priceSensitivity: 'BUDGET',
          }),
        ).toBe(true);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            priceSensitivity: 'MODERATE',
          }),
        ).toBe(true);
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            priceSensitivity: 'FLEXIBLE',
          }),
        ).toBe(true);
      });

      it('returns false when priceSensitivity is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            priceSensitivity: null,
          }),
        ).toBe(false);
      });
    });

    describe('requiresCheckedBaggage', () => {
      it('returns true when requiresCheckedBaggage is true', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            requiresCheckedBaggage: true,
          }),
        ).toBe(true);
      });

      it('returns true when requiresCheckedBaggage is false (explicit false preference)', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            requiresCheckedBaggage: false,
          }),
        ).toBe(true);
      });

      it('returns false when requiresCheckedBaggage is null', () => {
        expect(
          hasEffectivePreferences({
            ...coldStartPreferences,
            requiresCheckedBaggage: null,
          }),
        ).toBe(false);
      });
    });

    describe('multiple preferences', () => {
      it('returns true when multiple preferences are set simultaneously', () => {
        expect(
          hasEffectivePreferences({
            preferredAirlines: ['BA', 'VS'],
            blacklistedAirlines: ['FR'],
            classPreference: 'business',
            preferredDepartureWindow: { start: 8, end: 12 },
            preferredArrivalWindow: { start: 16, end: 20 },
            maxStops: 0,
            priceSensitivity: 'FLEXIBLE',
            requiresCheckedBaggage: true,
          }),
        ).toBe(true);
      });
    });
  });

  describe('Scorer Non-Invocation & RANKED Mode Switching (T043 [US2])', () => {
    it('triggers CategoryRankerService.rank and never calls FlightMatchScorerService.scoreAll on cold start (null userId)', async () => {
      const offers = [createMockNormalizedFlightOffer('off_1'), createMockNormalizedFlightOffer('off_2')];
      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: null,
        searchHash: 'hash_cold_start',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledTimes(1);
      expect(categoryRanker.rank).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: offers[0].id, originalIndex: 0 }),
          expect.objectContaining({ id: offers[1].id, originalIndex: 0 }),
        ]),
      );
      expect(response.mode).toBe('RANKED');
      expect(response.results).toHaveLength(2);
      expect(response.results[0].offer).toBe(offers[0]);
      expect(response.results[1].offer).toBe(offers[1]);
      expect(response.results[0].scoredOffer.matchResult).toBeNull();
      expect(response.results[1].scoredOffer.matchResult).toBeNull();
      expect(response.meta.scoringVersion).toBeNull();
      expect(response.meta.eligibleCount).toBeUndefined();
      expect(response.meta.matchLevelCounts).toBeUndefined();
      expect(response.meta.totalResults).toBe(2);
    });

    it('triggers CategoryRankerService.rank and never calls scorer when user has all empty/null preferences', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce(coldStartPreferences);

      const offers = [createMockNormalizedFlightOffer('off_1')];
      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: 'usr_cold_user',
        searchHash: 'hash_cold_user',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(profileService.getScoringPreferences).toHaveBeenCalledWith('usr_cold_user');
      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledTimes(1);
      expect(response.mode).toBe('RANKED');
      expect(response.results[0].offer).toBe(offers[0]);
      expect(response.results[0].scoredOffer.matchResult).toBeNull();
      expect(response.meta.scoringVersion).toBeNull();
      expect(response.meta.eligibleCount).toBeUndefined();
      expect(response.meta.matchLevelCounts).toBeUndefined();
    });

    it('preserves 5-tier category ranking order in response results when ranker reorders offers', async () => {
      const offer0 = createMockNormalizedFlightOffer('off_0');
      const offer1 = createMockNormalizedFlightOffer('off_1');
      const offer2 = createMockNormalizedFlightOffer('off_2');
      const offers: FlightOffer[] = [
        { ...offer0, matchInput: { ...offer0.matchInput, originalIndex: 0 } },
        { ...offer1, matchInput: { ...offer1.matchInput, originalIndex: 1 } },
        { ...offer2, matchInput: { ...offer2.matchInput, originalIndex: 2 } },
      ];

      categoryRanker.rank.mockImplementationOnce((rankOffers) => [
        rankOffers[2],
        rankOffers[0],
        rankOffers[1],
      ]);

      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: null,
        searchHash: 'hash_reorder',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.mode).toBe('RANKED');
      expect(response.results).toHaveLength(3);
      expect(response.results[0].offer.supplierOfferId).toBe('off_2');
      expect(response.results[0].scoredOffer.offer.originalIndex).toBe(2);
      expect(response.results[0].scoredOffer.matchResult).toBeNull();

      expect(response.results[1].offer.supplierOfferId).toBe('off_0');
      expect(response.results[1].scoredOffer.offer.originalIndex).toBe(0);
      expect(response.results[1].scoredOffer.matchResult).toBeNull();

      expect(response.results[2].offer.supplierOfferId).toBe('off_1');
      expect(response.results[2].scoredOffer.offer.originalIndex).toBe(1);
      expect(response.results[2].scoredOffer.matchResult).toBeNull();
    });

    it('handles empty canonical offers in RANKED mode with zero results and null scoringVersion', async () => {
      const params: OrchestratorParams = {
        offers: [],
        query: defaultQuery,
        userId: null,
        searchHash: 'hash_empty_cold',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(scorer.scoreAll).not.toHaveBeenCalled();
      expect(categoryRanker.rank).toHaveBeenCalledWith([]);
      expect(response.mode).toBe('RANKED');
      expect(response.results).toEqual([]);
      expect(response.meta.totalResults).toBe(0);
      expect(response.meta.scoringVersion).toBeNull();
      expect(response.meta.eligibleCount).toBeUndefined();
      expect(response.meta.matchLevelCounts).toBeUndefined();
    });

    it('invokes scorer.scoreAll and enters MATCHED mode when active preferences are present', async () => {
      profileService.getScoringPreferences.mockResolvedValueOnce({
        ...coldStartPreferences,
        maxStops: 1,
      });

      const offers = [createMockNormalizedFlightOffer('off_1')];
      const params: OrchestratorParams = {
        offers,
        query: defaultQuery,
        userId: 'usr_active',
        searchHash: 'hash_active',
        cached: false,
      };

      const response = await service.orchestrateSearch(params);

      expect(categoryRanker.rank).not.toHaveBeenCalled();
      expect(scorer.scoreAll).toHaveBeenCalledTimes(1);
      expect(response.mode).toBe('MATCHED');
      expect(response.results[0].offer.supplierOfferId).toBe('off_1');
      expect(response.results[0].scoredOffer.matchResult).not.toBeNull();
      expect(response.meta.scoringVersion).toBe('flight-match-v1');
      expect(response.meta.eligibleCount).toBe(1);
      expect(response.meta.matchLevelCounts).toBeDefined();
    });
  });

  describe('FlightSearchPort Compatibility with FlightSearchResult and FlightOffer (T013 [US1])', () => {
    it.each([null, 'usr_personalized'])(
      'filters mixed currencies before the result cap for user %s',
      async (userId) => {
        const offers = Array.from({ length: 23 }, (_, index) => {
          const raw = createMockDuffelOffer(`off_currency_${index}`, {
            total_currency: index === 1 || index === 22 ? 'EUR' : 'USD',
          });
          const offer = createMockNormalizedFlightOffer(raw.id, raw);
          return { ...offer, matchInput: { ...offer.matchInput, originalIndex: index } };
        });

        const response = await service.orchestrateSearch({
          offers,
          query: defaultQuery,
          userId,
          searchHash: 'currency_hash',
          cached: false,
        });

        expect(response.droppedCount).toBe(2);
        expect(response.rejectionCounts).toEqual({ MIXED_CURRENCY: 2 });
        expect(response.results).toHaveLength(20);
        expect(response.results.map((result) => result.offer)).toEqual([
          offers[0], ...offers.slice(2, 21),
        ]);
        expect(response.results[1].offer).toBe(offers[2]);
        expect(response.results.every((result) => result.scoredOffer.offer.currency === 'USD')).toBe(true);
      },
    );

    it('handles an empty normalized offer list without currency rejections', async () => {
      const response = await service.orchestrateSearch({
        offers: [], query: defaultQuery, searchHash: 'empty_hash', cached: true,
      });
      expect(response.results).toEqual([]);
      expect(response.droppedCount).toBe(0);
      expect(response.rejectionCounts).toEqual({});
    });

    it('asserts FlightSearchResult envelope compatibility with orchestrator cache and searchHash metadata', async () => {
      const rawOffer = createMockDuffelOffer('off_envelope_test');
      const normalizedOffer = createMockNormalizedFlightOffer('off_envelope_test', rawOffer);

      const searchResult: FlightSearchResult = {
        offers: [normalizedOffer],
        searchHash: 'sha256_port_envelope_hash',
        cached: true,
      };

      const params: OrchestratorParams = {
        offers: searchResult.offers,
        query: defaultQuery,
        userId: 'usr_envelope',
        searchHash: searchResult.searchHash,
        cached: searchResult.cached,
      };

      const response = await service.orchestrateSearch(params);

      expect(response.meta.searchHash).toBe(searchResult.searchHash);
      expect(response.meta.cached).toBe(true);
      expect(response.results).toHaveLength(1);
      expect(response.results[0].offer).toBe(normalizedOffer);
      expect(response.results[0].scoredOffer.offer.id).toBe(normalizedOffer.id);
    });

    it('asserts FlightOffer matchInput satisfies FlightMatchScorer and CategoryRanker contracts without type coercion', () => {
      const rawOffer = createMockDuffelOffer('off_match_contract');
      const flightOffer = createMockNormalizedFlightOffer('off_match_contract', rawOffer);

      // Verify that matchInput from FlightOffer conforms directly to Scorer input shape
      expect(flightOffer.matchInput).toHaveProperty('id', flightOffer.id);
      expect(flightOffer.matchInput).toHaveProperty('price', flightOffer.price);
      expect(flightOffer.matchInput).toHaveProperty('currency', flightOffer.currency);
      expect(flightOffer.matchInput).toHaveProperty('stops', flightOffer.stops);
      expect(flightOffer.matchInput).toHaveProperty('duration', flightOffer.duration);
      expect(flightOffer.matchInput.carrierCodes).toEqual(['BA']);
      expect(flightOffer.matchInput.hasCheckedBaggage).toBe(true);
      expect(flightOffer.matchInput.originalIndex).toBe(0);
    });

    it('preserves supplier-neutral passenger and conditions structures for downstream readiness and handoff readers', () => {
      const rawOffer = createMockDuffelOffer('off_neutral_fields');
      const flightOffer = createMockNormalizedFlightOffer('off_neutral_fields', rawOffer, {
        conditions: {
          refundable: true,
          changeable: false,
          changeBeforeDeparture: {
            allowed: true,
            penaltyAmount: '50.00',
            penaltyCurrency: 'USD',
          },
        },
      });

      expect(flightOffer.passengers[0].supplierPassengerId).toBe('pas_1');
      expect(flightOffer.passengers[0].type).toBe('ADULT');
      expect(flightOffer.conditions.refundable).toBe(true);
      expect(flightOffer.conditions.changeable).toBe(false);
      expect(flightOffer.conditions.changeBeforeDeparture?.allowed).toBe(true);
      expect(flightOffer.conditions.changeBeforeDeparture?.penaltyAmount).toBe('50.00');
      expect(flightOffer.conditions.changeBeforeDeparture?.penaltyCurrency).toBe('USD');
    });
  });
});

