import { Test, TestingModule } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AttestedFlightSearchService } from './attested-flight-search.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { CacheService } from '@/cache/cache.service';
import { FlightsService } from '@/flights/flights.service';
import { SelectionAttestationService } from '../selection-attestation.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { FlightSearchQueryDto } from '../dto/flight-search-query.dto';
import { AttestedFlightSearchDto } from '../dto/attested-flight-search.dto';
import type { FlightMatchResult } from '@/flight-match/flight-match.types';

function getJsonDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  const values = Array.isArray(value) ? value : Object.values(value);
  if (values.length === 0) {
    return 1;
  }
  return 1 + Math.max(...values.map(getJsonDepth));
}

describe('AttestedFlightSearchService', () => {
  let service: AttestedFlightSearchService;
  let prismaService: any;
  let auditService: any;
  let cacheService: any;
  let flightsService: any;
  let selectionAttestationService: any;
  let chatMessageCryptoService: any;
  let agentToolAuditService: any;

  beforeEach(async () => {
    prismaService = {
      chatMessage: { findFirst: jest.fn() },
      chatSession: { findFirst: jest.fn() },
      flightOffer: { createMany: jest.fn(), findMany: jest.fn() },
    };
    auditService = { createLog: jest.fn().mockResolvedValue({}) };
    cacheService = { get: jest.fn(), set: jest.fn().mockResolvedValue(undefined) };
    flightsService = { search: jest.fn() };
    selectionAttestationService = {
      signSelectionAttestation: jest
        .fn()
        .mockResolvedValue('sel_v1_mock_attestation.mock_signature'),
    };
    chatMessageCryptoService = {
      decryptMessageContent: jest.fn().mockResolvedValue('I want to fly to Hanoi'),
      isConfigured: jest.fn().mockReturnValue(true),
    };
    agentToolAuditService = {
      recordToolExecution: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttestedFlightSearchService,
        { provide: PrismaService, useValue: prismaService },
        { provide: AuditService, useValue: auditService },
        { provide: CacheService, useValue: cacheService },
        { provide: FlightsService, useValue: flightsService },
        { provide: SelectionAttestationService, useValue: selectionAttestationService },
        { provide: ChatMessageCryptoService, useValue: chatMessageCryptoService },
        { provide: AgentToolAuditService, useValue: agentToolAuditService },
      ],
    }).compile();

    service = module.get<AttestedFlightSearchService>(AttestedFlightSearchService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('searchFlights (V1)', () => {
    const validQuery: FlightSearchQueryDto = {
      origin: 'SGN',
      destination: 'HAN',
      date: '2026-09-01',
      adults: 1,
      cabinClass: 'economy',
    };

    it('delegates to flightsService.search, slices canonical 20 results to top 5, maps to FlightResultDto, never calls Duffel or query-only cache, and records tool execution', async () => {
      const mockOffers = Array.from({ length: 20 }, (_, i) => ({
        id: `fo_uuid_${i}`,
        duffelOfferId: `off_${i}`,
        airline: `Airline ${i}`,
        flightNumber: `VN${100 + i}`,
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T07:00:00Z',
        arrivalTime: '2026-09-01T09:15:00Z',
        duration: 135,
        stops: 0,
        price: 100 + i * 10,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      }));

      flightsService.search.mockResolvedValueOnce({
        mode: 'RANKED',
        results: mockOffers,
        meta: {
          scoringVersion: null,
          totalResults: 20,
          cached: false,
          searchHash: 'search_hash_v1',
          requestedCabinClass: 'economy',
        },
      });

      const result = await service.searchFlights('user-1', validQuery, 'trace-1', 'corr-1');

      expect(flightsService.search).toHaveBeenCalledWith(
        'user-1',
        {
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2026-09-01',
          adults: 1,
          children: 0,
          infants: 0,
          cabinClass: 'economy',
        },
        'trace-1',
        'corr-1',
        // User-requested CI fix preserves the agent supplier budget through delegation.
        { caller: 'agent' },
      );
      expect(cacheService.get).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();

      expect(result.mode).toBe('RANKED');
      expect(result.meta).toEqual({
        scoringVersion: null,
        totalResults: 20,
        cached: false,
        searchHash: 'search_hash_v1',
      });
      expect(result.results).toHaveLength(5);
      expect(result.results[0]).toEqual({
        airline: 'Airline 0',
        flightNumber: 'VN100',
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T07:00:00Z',
        arrivalTime: '2026-09-01T09:15:00Z',
        duration: 135,
        stops: 0,
        price: 100,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      });
      expect(result.results[4].airline).toBe('Airline 4');

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'flights/search',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        durationMs: expect.any(Number),
        responseSizeBytes: expect.any(Number),
        occurredAt: expect.any(String),
        errorCode: undefined,
        traceId: 'trace-1',
        correlationId: 'corr-1',
      });
    });

    it('preserves MATCHED mode and populates matchResult on mapped V1 results', async () => {
      const mockMatchResult: FlightMatchResult = {
        eligibility: { eligible: true, violations: [] },
        score: 92,
        matchLevel: 'STRONG',
        breakdown: [],
        metadata: {
          scoringVersion: 'flight-match-v1',
          activeWeights: {
            PRICE: 0.35,
            AIRLINE: 0.15,
            ARRIVAL_SCHEDULE: 0.1,
            STOPS: 0.1,
            CABIN: 0.1,
            DEPARTURE_SCHEDULE: 0.1,
            BAGGAGE: 0.05,
            DURATION: 0.05,
          },
        },
      };

      flightsService.search.mockResolvedValueOnce({
        mode: 'MATCHED',
        results: [
          {
            id: 'fo_matched_1',
            duffelOfferId: 'off_matched_1',
            airline: 'Vietnam Airlines',
            flightNumber: 'VN210',
            departureAirport: 'SGN',
            arrivalAirport: 'HAN',
            departureTime: '2026-09-01T07:00:00Z',
            arrivalTime: '2026-09-01T09:15:00Z',
            duration: 135,
            stops: 0,
            price: 150,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: '1 checked bag(s)',
            matchResult: mockMatchResult,
          },
        ],
        meta: {
          scoringVersion: 'flight-match-v1',
          totalResults: 1,
          cached: true,
          searchHash: 'search_hash_matched',
          requestedCabinClass: 'economy',
        },
      });

      const result = await service.searchFlights('user-1', validQuery);

      expect(result.mode).toBe('MATCHED');
      expect(result.results[0].matchResult).toEqual({
        score: mockMatchResult.score,
        matchLevel: mockMatchResult.matchLevel,
        explanations: [],
      });
      expect(getJsonDepth(result)).toBeLessThanOrEqual(5);
      expect(result.meta?.scoringVersion).toBe('flight-match-v1');
    });

    it('supports departureDate and passengers aliases in V1 query', async () => {
      flightsService.search.mockResolvedValueOnce({
        mode: 'RANKED',
        results: [],
        meta: {
          totalResults: 0,
          cached: false,
          searchHash: 'empty_hash',
          requestedCabinClass: 'economy',
        },
      });

      await service.searchFlights('user-1', {
        origin: 'sgn ',
        destination: ' han',
        departureDate: '2026-09-02',
        passengers: 2,
      } as any);

      expect(flightsService.search).toHaveBeenCalledWith(
        'user-1',
        {
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2026-09-02',
          adults: 2,
          children: 0,
          infants: 0,
          cabinClass: 'economy',
        },
        undefined,
        undefined,
        { caller: 'agent' },
      );
    });

    it('rejects missing adults count', async () => {
      await expect(
        service.searchFlights('user-1', {
          origin: 'SGN',
          destination: 'HAN',
          date: '2026-09-01',
        } as any),
      ).rejects.toThrow(HttpException);

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_400',
        }),
      );
    });

    it('rejects missing date', async () => {
      await expect(
        service.searchFlights('user-1', { origin: 'SGN', destination: 'HAN', adults: 1 } as any),
      ).rejects.toThrow(HttpException);

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_400',
        }),
      );
    });

    it('triggers honest degradation on keyword match in user chat message', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'enc',
      });
      chatMessageCryptoService.decryptMessageContent.mockResolvedValueOnce(
        'I want first class tickets',
      );

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(HttpException);

      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          userId: 'user-1',
          action: 'AGENT_KEYWORD_TRIGGER',
          resourceType: 'agent-gateway',
          metadata: expect.objectContaining({
            matchedKeywords: ['first'],
            messageId: 'msg-1',
          }),
        }),
      );
    });

    it('throws 400 when chat decryption fails', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'corrupt',
      });
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(
        new Error('Corrupt envelope'),
      );

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(
        new HttpException('Unable to decrypt chat message envelope', HttpStatus.BAD_REQUEST),
      );
    });

    it('throws 503 when chat encryption is not configured', async () => {
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-1',
        sessionId: 'session-1',
        sender: 'USER',
        contentCiphertext: 'enc',
      });
      chatMessageCryptoService.isConfigured.mockReturnValueOnce(false);
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(
        new Error('CHAT_ENCRYPTION_KEY is missing'),
      );

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'session-1'),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('wraps upstream errors in 502 UPSTREAM_UNAVAILABLE', async () => {
      flightsService.search.mockRejectedValueOnce(new Error('Duffel API timeout'));

      await expect(
        service.searchFlights('user-1', validQuery, 'trace-1', 'corr-1'),
      ).rejects.toThrow(HttpException);

      expect(cacheService.get).not.toHaveBeenCalled();
      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'UPSTREAM_UNAVAILABLE',
        }),
      );
    });
  });

  describe('searchFlightsV2', () => {
    const validV2Dto: AttestedFlightSearchDto = {
      chatSessionId: 'sess_123',
      proposedSnapshotVersion: 1,
      search: {
        origin: 'SGN',
        destination: 'HAN',
        departureDate: '2026-09-01',
        adults: 1,
        cabinClass: 'economy',
      },
    };

    it('searches flights V2 delegating to flightsService.search and never calls Duffel directly', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

      const mockOffer = {
        id: 'fo_db_1',
        duffelOfferId: 'off_v2_1',
        airline: 'Bamboo Airways',
        flightNumber: 'QH201',
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T06:00:00Z',
        arrivalTime: '2026-09-01T08:00:00Z',
        duration: 120,
        stops: 0,
        price: 200,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      };

      flightsService.search.mockResolvedValueOnce({
        mode: 'RANKED',
        results: [mockOffer],
        meta: {
          totalResults: 1,
          searchHash: 'hash_abc',
          cached: false,
          requestedCabinClass: 'economy',
        },
      });

      const result = await service.searchFlightsV2('user-1', validV2Dto, 'trace-v2', 'corr-v2');

      expect(flightsService.search).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2026-09-01',
          adults: 1,
          cabinClass: 'economy',
        }),
        'trace-v2',
        'corr-v2',
        // User-requested race fix requires committed offers before attestation.
        { caller: 'agent', persistence: 'required' },
      );

      expect(result.selectionAttestation).toBe('sel_v1_mock_attestation.mock_signature');
      expect(result.snapshotVersion).toBe(1);
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        flightOfferId: 'fo_db_1',
        duffelOfferId: 'off_v2_1',
        airline: 'Bamboo Airways',
        flightNumber: 'QH201',
      });

      expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
        'user-1',
        'sess_123',
        1,
        expect.any(String),
        [{ flightOfferId: 'fo_db_1', duffelOfferId: 'off_v2_1' }],
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith({
        toolName: 'v2/flights/search',
        actorId: 'user-1',
        outcome: 'SUCCESS',
        durationMs: expect.any(Number),
        responseSizeBytes: expect.any(Number),
        occurredAt: expect.any(String),
        errorCode: undefined,
        traceId: 'trace-v2',
        correlationId: 'corr-v2',
      });
    });

    it('pins V2 signer offer order and the serialized result item keys', async (): Promise<void> => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

      const firstOffer = {
        id: 'fo_v2_first',
        duffelOfferId: 'off_v2_first',
        airline: 'Bamboo Airways',
        flightNumber: 'QH201',
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T06:00:00Z',
        arrivalTime: '2026-09-01T08:00:00Z',
        duration: 120,
        stops: 0,
        price: 200,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      };
      const secondOffer = {
        ...firstOffer,
        id: 'fo_v2_second',
        duffelOfferId: 'off_v2_second',
        airline: 'Vietnam Airlines',
        flightNumber: 'VN202',
      };

      flightsService.search.mockResolvedValueOnce({
        mode: 'RANKED',
        results: [firstOffer, secondOffer],
        meta: {
          totalResults: 2,
          searchHash: 'hash_ordered_v2',
          cached: false,
          requestedCabinClass: 'economy',
        },
      });

      const result = await service.searchFlightsV2('user-1', validV2Dto);

      expect(result.results.map((offer) => offer.flightOfferId)).toEqual([
        'fo_v2_first',
        'fo_v2_second',
      ]);
      expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledTimes(1);
      expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
        'user-1',
        'sess_123',
        1,
        result.snapshotExpiresAt,
        [
          { flightOfferId: 'fo_v2_first', duffelOfferId: 'off_v2_first' },
          { flightOfferId: 'fo_v2_second', duffelOfferId: 'off_v2_second' },
        ],
      );

      const [firstResult] = result.results;
      expect(firstResult).toBeDefined();
      if (firstResult) {
        expect(Object.keys(firstResult).sort()).toEqual([
          'airline',
          'arrivalAirport',
          'arrivalTime',
          'baggageAllowance',
          'currency',
          'departureAirport',
          'departureTime',
          'duffelOfferId',
          'duration',
          'fareClass',
          'flightNumber',
          'flightOfferId',
          'matchResult',
          'offerExpiresAt',
          'price',
          'stops',
        ]);
      }
    });

    it('slices canonical 20 offers down to first 5 in exact server-ranked order', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

      const mockOffers = Array.from({ length: 20 }, (_, i) => ({
        id: `fo_uuid_${i}`,
        duffelOfferId: `duffel_offer_${i}`,
        airline: `Airline ${i}`,
        flightNumber: `FL${100 + i}`,
        departureAirport: 'SGN',
        arrivalAirport: 'HAN',
        departureTime: '2026-09-01T06:00:00Z',
        arrivalTime: '2026-09-01T08:00:00Z',
        duration: 120,
        stops: 0,
        price: 100 + i * 10,
        currency: 'USD',
        fareClass: 'Economy',
        baggageAllowance: '1 checked bag(s)',
        matchResult: null,
      }));

      flightsService.search.mockResolvedValueOnce({
        mode: 'MATCHED',
        results: mockOffers,
        meta: {
          totalResults: 20,
          searchHash: 'hash_20',
          cached: false,
          requestedCabinClass: 'economy',
        },
      });

      const result = await service.searchFlightsV2('user-1', validV2Dto, 'trace-v2', null);

      // Falls back correlationId to chatSessionId when correlationId is null
      expect(flightsService.search).toHaveBeenCalledWith(
        'user-1',
        expect.any(Object),
        'trace-v2',
        'sess_123',
        { caller: 'agent', persistence: 'required' },
      );

      // Slices to exactly 5 preserving order
      expect(result.results).toHaveLength(5);
      expect(result.results.map((r) => r.flightOfferId)).toEqual([
        'fo_uuid_0',
        'fo_uuid_1',
        'fo_uuid_2',
        'fo_uuid_3',
        'fo_uuid_4',
      ]);
      expect(result.results.map((r) => r.airline)).toEqual([
        'Airline 0',
        'Airline 1',
        'Airline 2',
        'Airline 3',
        'Airline 4',
      ]);

      // Selection attestation signed for exact top 5
      expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
        'user-1',
        'sess_123',
        1,
        expect.any(String),
        [
          { flightOfferId: 'fo_uuid_0', duffelOfferId: 'duffel_offer_0' },
          { flightOfferId: 'fo_uuid_1', duffelOfferId: 'duffel_offer_1' },
          { flightOfferId: 'fo_uuid_2', duffelOfferId: 'duffel_offer_2' },
          { flightOfferId: 'fo_uuid_3', duffelOfferId: 'duffel_offer_3' },
          { flightOfferId: 'fo_uuid_4', duffelOfferId: 'duffel_offer_4' },
        ],
      );
    });

    it('rejects when chatSession does not exist or belong to user', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce(null);

      await expect(service.searchFlightsV2('user-1', validV2Dto)).rejects.toThrow(
        new HttpException('Chat session not found', HttpStatus.NOT_FOUND),
      );

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'v2/flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'HTTP_404',
        }),
      );
    });

    it('rejects missing search adults / passengers', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });

      const invalidDto: any = {
        chatSessionId: 'sess_123',
        search: {
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2026-09-01',
        },
      };

      await expect(service.searchFlightsV2('user-1', invalidDto)).rejects.toThrow(
        new HttpException(
          'At least one of adults or passengers must be provided',
          HttpStatus.BAD_REQUEST,
        ),
      );
    });

    it('rejects missing search date / departureDate', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });

      const invalidDto: any = {
        chatSessionId: 'sess_123',
        search: {
          origin: 'SGN',
          destination: 'HAN',
          adults: 1,
        },
      };

      await expect(service.searchFlightsV2('user-1', invalidDto)).rejects.toThrow(
        new HttpException(
          'At least one of date or departureDate must be provided',
          HttpStatus.BAD_REQUEST,
        ),
      );
    });

    it('wraps upstream failures in 502 UPSTREAM_UNAVAILABLE and records audit failure', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_123',
        userId: 'user-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);
      flightsService.search.mockRejectedValueOnce(new Error('Duffel API timeout'));

      let caughtError: any;
      try {
        await service.searchFlightsV2('user-1', validV2Dto, 'trace-v2', 'corr-v2');
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeInstanceOf(HttpException);
      expect(caughtError.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(caughtError.getResponse()).toEqual({
        message: 'Duffel API timeout',
        code: 'UPSTREAM_UNAVAILABLE',
      });

      expect(agentToolAuditService.recordToolExecution).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'v2/flights/search',
          actorId: 'user-1',
          outcome: 'FAILURE',
          errorCode: 'UPSTREAM_UNAVAILABLE',
          traceId: 'trace-v2',
          correlationId: 'corr-v2',
        }),
      );
    });

    describe('Task T061 [US4]: Exact Ranked First-Five Selection Attestation & Snapshot', () => {
      it('preserves exact server-ranked category order in RANKED mode with 20 offers without price/duration mutation', async () => {
        prismaService.chatSession.findFirst.mockResolvedValueOnce({
          id: 'sess_ranked_t061',
          userId: 'user-1',
          deletedAt: null,
        });
        prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

        // 20 offers in server-determined RANKED order (e.g., Best Value, Cheapest, Fastest)
        // Prices and durations are deliberately non-monotonic to prove no client/gateway re-sorting occurs
        const mockOffers = [
          {
            id: 'uuid-ranked-0',
            duffelOfferId: 'duffel-0',
            price: 450,
            duration: 240,
            airline: 'Air A',
          },
          {
            id: 'uuid-ranked-1',
            duffelOfferId: 'duffel-1',
            price: 120,
            duration: 360,
            airline: 'Air B',
          },
          {
            id: 'uuid-ranked-2',
            duffelOfferId: 'duffel-2',
            price: 600,
            duration: 110,
            airline: 'Air C',
          },
          {
            id: 'uuid-ranked-3',
            duffelOfferId: 'duffel-3',
            price: 320,
            duration: 180,
            airline: 'Air D',
          },
          {
            id: 'uuid-ranked-4',
            duffelOfferId: 'duffel-4',
            price: 210,
            duration: 290,
            airline: 'Air E',
          },
          ...Array.from({ length: 15 }, (_, i) => ({
            id: `uuid-ranked-${i + 5}`,
            duffelOfferId: `duffel-${i + 5}`,
            price: 100 + i * 20,
            duration: 150 + i * 10,
            airline: `Air ${i + 5}`,
          })),
        ].map((o) => ({
          ...o,
          flightNumber: 'VN999',
          departureAirport: 'SGN',
          arrivalAirport: 'HAN',
          departureTime: '2026-09-01T06:00:00Z',
          arrivalTime: '2026-09-01T08:00:00Z',
          stops: 0,
          currency: 'USD',
          fareClass: 'Economy',
          baggageAllowance: '1 checked bag(s)',
          matchResult: null,
        }));

        flightsService.search.mockResolvedValueOnce({
          mode: 'RANKED',
          results: mockOffers,
          meta: {
            totalResults: 20,
            searchHash: 'hash_ranked_20',
            cached: false,
            requestedCabinClass: 'economy',
          },
        });

        const dto: AttestedFlightSearchDto = {
          chatSessionId: 'sess_ranked_t061',
          proposedSnapshotVersion: 3,
          search: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2026-09-01',
            adults: 1,
            cabinClass: 'economy',
          },
        };

        const result = await service.searchFlightsV2('user-1', dto);

        expect(result.snapshotVersion).toBe(3);
        expect(result.results).toHaveLength(5);
        expect(result.results.map((r) => r.flightOfferId)).toEqual([
          'uuid-ranked-0',
          'uuid-ranked-1',
          'uuid-ranked-2',
          'uuid-ranked-3',
          'uuid-ranked-4',
        ]);
        expect(result.results.map((r) => r.price)).toEqual([450, 120, 600, 320, 210]);

        expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
          'user-1',
          'sess_ranked_t061',
          3,
          expect.any(String),
          [
            { flightOfferId: 'uuid-ranked-0', duffelOfferId: 'duffel-0' },
            { flightOfferId: 'uuid-ranked-1', duffelOfferId: 'duffel-1' },
            { flightOfferId: 'uuid-ranked-2', duffelOfferId: 'duffel-2' },
            { flightOfferId: 'uuid-ranked-3', duffelOfferId: 'duffel-3' },
            { flightOfferId: 'uuid-ranked-4', duffelOfferId: 'duffel-4' },
          ],
        );
      });

      it('binds exact ordered deterministic UUIDs and duffelOfferIds to chat session in MATCHED mode', async () => {
        prismaService.chatSession.findFirst.mockResolvedValueOnce({
          id: 'sess_matched_t061',
          userId: 'user-2',
          deletedAt: null,
        });
        prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

        const mockMatchedOffers = [
          {
            id: '7b8c9d0e-1234-4567-89ab-cdef01234567',
            duffelOfferId: 'off_duffel_matched_1',
            price: 250,
            airline: 'Airline A',
            matchResult: { score: 95, level: 'STRONG' },
          },
          {
            id: '8c9d0e1f-2345-4678-9abc-def012345678',
            duffelOfferId: 'off_duffel_matched_2',
            price: 310,
            airline: 'Airline B',
            matchResult: { score: 88, level: 'GOOD' },
          },
          {
            id: '9d0e1f2a-3456-4789-abcd-ef0123456789',
            duffelOfferId: 'off_duffel_matched_3',
            price: 180,
            airline: 'Airline C',
            matchResult: { score: 80, level: 'GOOD' },
          },
          {
            id: '0e1f2a3b-4567-489a-bcde-f01234567890',
            duffelOfferId: 'off_duffel_matched_4',
            price: 420,
            airline: 'Airline D',
            matchResult: { score: 72, level: 'FAIR' },
          },
          {
            id: '1f2a3b4c-5678-49ab-cdef-012345678901',
            duffelOfferId: 'off_duffel_matched_5',
            price: 500,
            airline: 'Airline E',
            matchResult: { score: 65, level: 'FAIR' },
          },
          ...Array.from({ length: 15 }, (_, i) => ({
            id: `2a3b4c5d-${i}-49ab-cdef-012345678902`,
            duffelOfferId: `off_duffel_extra_${i}`,
            price: 600 + i * 10,
            airline: `Extra Air ${i}`,
            matchResult: { score: 50 - i, level: 'WEAK' },
          })),
        ].map((o) => ({
          ...o,
          flightNumber: 'VN100',
          departureAirport: 'SGN',
          arrivalAirport: 'HAN',
          departureTime: '2026-09-01T06:00:00Z',
          arrivalTime: '2026-09-01T08:00:00Z',
          duration: 120,
          stops: 0,
          currency: 'USD',
          fareClass: 'Economy',
          baggageAllowance: '1 checked bag(s)',
        }));

        flightsService.search.mockResolvedValueOnce({
          mode: 'MATCHED',
          results: mockMatchedOffers,
          meta: {
            totalResults: 20,
            searchHash: 'hash_matched_20',
            cached: false,
            requestedCabinClass: 'economy',
          },
        });

        const dto: AttestedFlightSearchDto = {
          chatSessionId: 'sess_matched_t061',
          proposedSnapshotVersion: 1,
          search: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2026-09-01',
            adults: 1,
            cabinClass: 'economy',
          },
        };

        const result = await service.searchFlightsV2('user-2', dto);

        expect(result.results).toHaveLength(5);
        expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
          'user-2',
          'sess_matched_t061',
          1,
          expect.any(String),
          [
            {
              flightOfferId: '7b8c9d0e-1234-4567-89ab-cdef01234567',
              duffelOfferId: 'off_duffel_matched_1',
            },
            {
              flightOfferId: '8c9d0e1f-2345-4678-9abc-def012345678',
              duffelOfferId: 'off_duffel_matched_2',
            },
            {
              flightOfferId: '9d0e1f2a-3456-4789-abcd-ef0123456789',
              duffelOfferId: 'off_duffel_matched_3',
            },
            {
              flightOfferId: '0e1f2a3b-4567-489a-bcde-f01234567890',
              duffelOfferId: 'off_duffel_matched_4',
            },
            {
              flightOfferId: '1f2a3b4c-5678-49ab-cdef-012345678901',
              duffelOfferId: 'off_duffel_matched_5',
            },
          ],
        );
      });

      it('guarantees zero direct prisma.flightOffer calls (createMany, findMany) in AttestedFlightSearchService', async () => {
        prismaService.chatSession.findFirst.mockResolvedValueOnce({
          id: 'sess_no_db_offers',
          userId: 'user-1',
          deletedAt: null,
        });
        prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

        flightsService.search.mockResolvedValueOnce({
          mode: 'RANKED',
          results: [
            {
              id: 'fo_uuid_persisted_by_flights_service',
              duffelOfferId: 'duffel_off_persisted',
              airline: 'Vietnam Airlines',
              flightNumber: 'VN123',
              departureAirport: 'SGN',
              arrivalAirport: 'HAN',
              departureTime: '2026-09-01T06:00:00Z',
              arrivalTime: '2026-09-01T08:00:00Z',
              duration: 120,
              stops: 0,
              price: 150,
              currency: 'USD',
              fareClass: 'Economy',
              baggageAllowance: '1 checked bag(s)',
              matchResult: null,
            },
          ],
          meta: {
            totalResults: 1,
            searchHash: 'hash_no_db',
            cached: false,
            requestedCabinClass: 'economy',
          },
        });

        const dto: AttestedFlightSearchDto = {
          chatSessionId: 'sess_no_db_offers',
          proposedSnapshotVersion: 1,
          search: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2026-09-01',
            adults: 1,
          },
        };

        await service.searchFlightsV2('user-1', dto);

        // Verification of invariant: persistence belongs to FlightsService.search(), never AttestedFlightSearchService
        expect(prismaService.flightOffer.createMany).not.toHaveBeenCalled();
        expect(prismaService.flightOffer.findMany).not.toHaveBeenCalled();
      });

      it('verifies snapshotExpiresAt is exactly 15 minutes ahead, formatted as ISO, and matches offerExpiresAt', async () => {
        const fixedNow = 1756890000000;
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

        try {
          prismaService.chatSession.findFirst.mockResolvedValueOnce({
            id: 'sess_expires_test',
            userId: 'user-1',
            deletedAt: null,
          });
          prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

          flightsService.search.mockResolvedValueOnce({
            mode: 'RANKED',
            results: [
              {
                id: 'fo_uuid_1',
                duffelOfferId: 'off_1',
                airline: 'Bamboo Airways',
                flightNumber: 'QH101',
                departureAirport: 'SGN',
                arrivalAirport: 'HAN',
                departureTime: '2026-09-01T06:00:00Z',
                arrivalTime: '2026-09-01T08:00:00Z',
                duration: 120,
                stops: 0,
                price: 100,
                currency: 'USD',
                fareClass: 'Economy',
                baggageAllowance: '1 checked bag(s)',
                matchResult: null,
              },
            ],
            meta: {
              totalResults: 1,
              searchHash: 'hash_exp',
              cached: false,
              requestedCabinClass: 'economy',
            },
          });

          const dto: AttestedFlightSearchDto = {
            chatSessionId: 'sess_expires_test',
            proposedSnapshotVersion: 1,
            search: {
              origin: 'SGN',
              destination: 'HAN',
              departureDate: '2026-09-01',
              adults: 1,
            },
          };

          const result = await service.searchFlightsV2('user-1', dto);

          const expectedIso = new Date(fixedNow + 15 * 60 * 1000).toISOString();

          // Exactly 15 minutes ahead
          expect(result.snapshotExpiresAt).toBe(expectedIso);
          // Valid ISO 8601 string
          expect(result.snapshotExpiresAt).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
          );
          // Every returned result has matching offerExpiresAt
          expect(result.results).toHaveLength(1);
          expect(result.results[0].offerExpiresAt).toBe(expectedIso);

          // Selection attestation signed with the identical expiresAt ISO
          expect(selectionAttestationService.signSelectionAttestation).toHaveBeenCalledWith(
            'user-1',
            'sess_expires_test',
            1,
            expectedIso,
            [{ flightOfferId: 'fo_uuid_1', duffelOfferId: 'off_1' }],
          );
        } finally {
          nowSpy.mockRestore();
        }
      });

      describe('Gateway Mode & Match DTO Serialization (T062)', () => {
        it('serializes MATCHED response with mode: MATCHED, populated matchResult, and scoringVersion in meta', async () => {
          prismaService.chatSession.findFirst.mockResolvedValueOnce({
            id: 'sess_t062_matched',
            userId: 'user-t062',
            deletedAt: null,
          });
          prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

          const mockMatchResult: FlightMatchResult = {
            eligibility: { eligible: true, violations: [] },
            score: 88,
            matchLevel: 'STRONG',
            breakdown: [
              {
                dimension: 'PRICE',
                score: 95,
                weight: 0.35,
                contribution: 33.25,
                signal: 'POSITIVE',
                explanation: { key: 'match.price.below_median', params: { currency: 'USD', difference: 20 } },
              },
            ],
            metadata: {
              scoringVersion: 'flight-match-v1',
              activeWeights: {
                PRICE: 0.35,
                AIRLINE: 0.15,
                ARRIVAL_SCHEDULE: 0.1,
                STOPS: 0.1,
                CABIN: 0.1,
                DEPARTURE_SCHEDULE: 0.1,
                BAGGAGE: 0.05,
                DURATION: 0.05,
              },
            },
          };

          const mockFlightOffer = {
            id: 'c8a3f9e2-38b7-49d6-94d4-511252199cf8',
            duffelOfferId: 'off_duffel_t062_1',
            airline: 'Vietnam Airlines',
            flightNumber: 'VN123',
            departureAirport: 'SGN',
            arrivalAirport: 'HAN',
            departureTime: '2026-09-01T06:00:00Z',
            arrivalTime: '2026-09-01T08:00:00Z',
            duration: 120,
            stops: 0,
            price: 150,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: '1 checked bag(s)',
            matchResult: mockMatchResult,
          };

          flightsService.search.mockResolvedValueOnce({
            mode: 'MATCHED',
            results: [mockFlightOffer],
            meta: {
              totalResults: 1,
              searchHash: 'hash_matched_t062',
              cached: false,
              requestedCabinClass: 'economy',
              scoringVersion: 'flight-match-v1',
              eligibleCount: 1,
            },
          });

          const dto: AttestedFlightSearchDto = {
            chatSessionId: 'sess_t062_matched',
            proposedSnapshotVersion: 1,
            search: {
              origin: 'SGN',
              destination: 'HAN',
              departureDate: '2026-09-01',
              adults: 1,
              cabinClass: 'economy',
            },
          };

          const response = await service.searchFlightsV2('user-t062', dto);

          expect(response.mode).toBe('MATCHED');
          expect(response.meta).toEqual({
            scoringVersion: 'flight-match-v1',
            totalResults: 1,
            cached: false,
            searchHash: 'hash_matched_t062',
          });
          expect(response.results).toHaveLength(1);
          expect(response.results[0].flightOfferId).toBe('c8a3f9e2-38b7-49d6-94d4-511252199cf8');
          expect(response.results[0].duffelOfferId).toBe('off_duffel_t062_1');
          expect(response.results[0].matchResult).toEqual({
            score: mockMatchResult.score,
            matchLevel: mockMatchResult.matchLevel,
            explanations: [
              {
                key: 'match.price.below_median',
                params: { currency: 'USD', difference: 20 },
              },
            ],
          });
          expect(getJsonDepth(response)).toBeLessThanOrEqual(7);
        });

        it('serializes RANKED response with mode: RANKED, matchResult: null, and scoringVersion: null in meta', async () => {
          prismaService.chatSession.findFirst.mockResolvedValueOnce({
            id: 'sess_t062_ranked',
            userId: 'user-t062',
            deletedAt: null,
          });
          prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

          const mockFlightOffer = {
            id: 'd9b4f0e3-49c8-4ae7-a5e5-622363200df9',
            duffelOfferId: 'off_duffel_t062_2',
            airline: 'Vietjet Air',
            flightNumber: 'VJ123',
            departureAirport: 'SGN',
            arrivalAirport: 'HAN',
            departureTime: '2026-09-01T09:00:00Z',
            arrivalTime: '2026-09-01T11:00:00Z',
            duration: 120,
            stops: 0,
            price: 90,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: 'No checked baggage',
            matchResult: null,
          };

          flightsService.search.mockResolvedValueOnce({
            mode: 'RANKED',
            results: [mockFlightOffer],
            meta: {
              totalResults: 1,
              searchHash: 'hash_ranked_t062',
              cached: true,
              requestedCabinClass: 'economy',
              scoringVersion: null,
            },
          });

          const dto: AttestedFlightSearchDto = {
            chatSessionId: 'sess_t062_ranked',
            proposedSnapshotVersion: 2,
            search: {
              origin: 'SGN',
              destination: 'HAN',
              departureDate: '2026-09-01',
              adults: 1,
            },
          };

          const response = await service.searchFlightsV2('user-t062', dto);

          expect(response.mode).toBe('RANKED');
          expect(response.meta).toEqual({
            scoringVersion: null,
            totalResults: 1,
            cached: true,
            searchHash: 'hash_ranked_t062',
          });
          expect(response.results).toHaveLength(1);
          expect(response.results[0].flightOfferId).toBe('d9b4f0e3-49c8-4ae7-a5e5-622363200df9');
          expect(response.results[0].duffelOfferId).toBe('off_duffel_t062_2');
          expect(response.results[0].matchResult).toBeNull();
        });

        it('preserves deterministic UUIDs in flightOfferId and exact DTO structure across 5 ranked offers', async () => {
          prismaService.chatSession.findFirst.mockResolvedValueOnce({
            id: 'sess_t062_structure',
            userId: 'user-t062',
            deletedAt: null,
          });
          prismaService.chatMessage.findFirst.mockResolvedValueOnce(null);

          const mockResults = Array.from({ length: 5 }, (_, i) => ({
            id: `00000000-0000-4000-8000-00000000000${i}`,
            duffelOfferId: `off_duffel_${i}`,
            airline: `Airline ${i}`,
            flightNumber: `FL${i}`,
            departureAirport: 'SGN',
            arrivalAirport: 'HAN',
            departureTime: '2026-09-01T06:00:00Z',
            arrivalTime: '2026-09-01T08:00:00Z',
            duration: 120,
            stops: 0,
            price: 100 + i * 10,
            currency: 'USD',
            fareClass: 'Economy',
            baggageAllowance: '1 checked bag(s)',
            matchResult: null,
          }));

          flightsService.search.mockResolvedValueOnce({
            mode: 'RANKED',
            results: mockResults,
            meta: {
              totalResults: 5,
              searchHash: 'hash_5',
              cached: false,
              requestedCabinClass: 'economy',
            },
          });

          const dto: AttestedFlightSearchDto = {
            chatSessionId: 'sess_t062_structure',
            proposedSnapshotVersion: 1,
            search: {
              origin: 'SGN',
              destination: 'HAN',
              departureDate: '2026-09-01',
              adults: 1,
            },
          };

          const response = await service.searchFlightsV2('user-t062', dto);

          expect(response.mode).toBe('RANKED');
          expect(response.meta).toBeDefined();
          expect(response.results).toHaveLength(5);
          for (let i = 0; i < 5; i++) {
            const item = response.results[i];
            expect(item.flightOfferId).toBe(`00000000-0000-4000-8000-00000000000${i}`);
            expect(item.duffelOfferId).toBe(`off_duffel_${i}`);
            expect(item.matchResult).toBeNull();
            expect(item).toHaveProperty('offerExpiresAt');
            expect(item).toHaveProperty('airline');
            expect(item).toHaveProperty('flightNumber');
            expect(item).toHaveProperty('departureAirport');
            expect(item).toHaveProperty('arrivalAirport');
            expect(item).toHaveProperty('departureTime');
            expect(item).toHaveProperty('arrivalTime');
            expect(item).toHaveProperty('duration');
            expect(item).toHaveProperty('stops');
            expect(item).toHaveProperty('price');
            expect(item).toHaveProperty('currency');
            expect(item).toHaveProperty('fareClass');
            expect(item).toHaveProperty('baggageAllowance');
          }
        });
      });
    });
  });

  describe('ChatMessageCryptoService contract & provider verification', () => {
    it('verifies ChatMessageCryptoService contract methods are provided and callable', () => {
      expect(chatMessageCryptoService).toBeDefined();
      expect(typeof chatMessageCryptoService.decryptMessageContent).toBe('function');
      expect(typeof chatMessageCryptoService.isConfigured).toBe('function');
    });

    it('verifies searchFlightsV2 calls ChatMessageCryptoService.decryptMessageContent when user message exists', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_crypto_contract',
        userId: 'user-crypto-1',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-crypto-1',
        sessionId: 'sess_crypto_contract',
        sender: 'USER',
        contentCiphertext: 'enc_hex_payload',
      });
      chatMessageCryptoService.decryptMessageContent.mockResolvedValueOnce('find cheap flights');

      flightsService.search.mockResolvedValueOnce({
        mode: 'RANKED',
        results: [],
        meta: { totalResults: 0, cached: false, searchHash: 'h' },
      });

      await service.searchFlightsV2('user-crypto-1', {
        chatSessionId: 'sess_crypto_contract',
        search: {
          origin: 'SGN',
          destination: 'HAN',
          date: '2026-09-01',
          adults: 1,
        },
      });

      expect(chatMessageCryptoService.decryptMessageContent).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'msg-crypto-1',
          sessionId: 'sess_crypto_contract',
          sender: 'USER',
        }),
      );
    });

    it('verifies searchFlightsV2 triggers honest degradation when ChatMessageCryptoService reveals keyword', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_crypto_keyword',
        userId: 'user-crypto-2',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-crypto-2',
        sessionId: 'sess_crypto_keyword',
        sender: 'USER',
        contentCiphertext: 'enc_hex_payload',
      });
      chatMessageCryptoService.decryptMessageContent.mockResolvedValueOnce('I want business class');

      await expect(
        service.searchFlightsV2('user-crypto-2', {
          chatSessionId: 'sess_crypto_keyword',
          search: {
            origin: 'SGN',
            destination: 'HAN',
            date: '2026-09-01',
            adults: 1,
          },
        }),
      ).rejects.toThrow(HttpException);

      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          userId: 'user-crypto-2',
          action: 'AGENT_KEYWORD_TRIGGER',
        }),
      );
    });

    it('verifies searchFlightsV2 maps unconfigured crypto provider to 503 ServiceUnavailableException', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_crypto_unconf',
        userId: 'user-crypto-3',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-crypto-3',
        sessionId: 'sess_crypto_unconf',
        sender: 'USER',
        contentCiphertext: 'enc_hex_payload',
      });
      chatMessageCryptoService.isConfigured.mockReturnValueOnce(false);
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(
        new Error('CHAT_ENCRYPTION_KEY is missing'),
      );

      await expect(
        service.searchFlightsV2('user-crypto-3', {
          chatSessionId: 'sess_crypto_unconf',
          search: {
            origin: 'SGN',
            destination: 'HAN',
            date: '2026-09-01',
            adults: 1,
          },
        }),
      ).rejects.toThrow(ServiceUnavailableException);
    });

    it('verifies searchFlightsV2 maps crypto decryption failure to 400 BAD_REQUEST', async () => {
      prismaService.chatSession.findFirst.mockResolvedValueOnce({
        id: 'sess_crypto_corrupt',
        userId: 'user-crypto-4',
        deletedAt: null,
      });
      prismaService.chatMessage.findFirst.mockResolvedValueOnce({
        id: 'msg-crypto-4',
        sessionId: 'sess_crypto_corrupt',
        sender: 'USER',
        contentCiphertext: 'corrupt_cipher',
      });
      chatMessageCryptoService.isConfigured.mockReturnValueOnce(true);
      chatMessageCryptoService.decryptMessageContent.mockRejectedValueOnce(
        new Error('Failed to decrypt ChatMessage content'),
      );

      await expect(
        service.searchFlightsV2('user-crypto-4', {
          chatSessionId: 'sess_crypto_corrupt',
          search: {
            origin: 'SGN',
            destination: 'HAN',
            date: '2026-09-01',
            adults: 1,
          },
        }),
      ).rejects.toThrow(
        new HttpException('Unable to decrypt chat message envelope', HttpStatus.BAD_REQUEST),
      );
    });
  });

  describe('Static architecture & module dependency assertions (US1 T009)', () => {
    it('asserts AttestedFlightSearchService depends on ChatMessageCryptoService contract without depending on ChatService', () => {
      const paramTypes = Reflect.getMetadata('design:paramtypes', AttestedFlightSearchService) || [];
      const paramNames = paramTypes.map((t: any) => t?.name);

      expect(paramNames).toContain('ChatMessageCryptoService');
      expect(paramNames).not.toContain('ChatService');
      expect(paramNames).not.toContain('ChatController');
      expect(paramNames).not.toContain('AgentChatController');
      expect(paramNames).not.toContain('AgentChatAccessService');
    });

    it('asserts AttestedFlightSearchModule isolates crypto from chat service/controller components', () => {
      const modulePath = join(__dirname, 'attested-flight-search.module.ts');
      const moduleSource = readFileSync(modulePath, 'utf8');
      expect(moduleSource).not.toMatch(/\bChatService\b/);
      expect(moduleSource).not.toMatch(/\bChatController\b/);
      expect(moduleSource).not.toMatch(/\bAgentChatAccessService\b/);
    });
  });
});
