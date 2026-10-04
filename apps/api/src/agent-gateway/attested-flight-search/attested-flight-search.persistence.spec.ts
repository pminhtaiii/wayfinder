import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { FLIGHT_SEARCH_PORT, FlightSearchPort } from '@/supplier/search/flight-search.port';
import { FlightOfferNormalizer } from '@/supplier/search/flight-offer.normalizer';
import { DuffelOffer } from '@/duffel/duffel.types';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { ProfileService } from '@/profile/profile.service';
import { FlightMatchScorerService } from '@/flight-match/flight-match-scorer.service';
import { CategoryRankerService } from '@/flight-match/category-ranker.service';
import { FlightsService } from '@/flights/flights.service';
import { FlightSearchOrchestratorService } from '@/flights/flight-search-orchestrator.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { SelectionAttestationService } from '../selection-attestation.service';
import { AgentToolAuditService } from '../audit/agent-tool-audit.service';
import { AttestedFlightSearchService } from './attested-flight-search.service';

// User approved 2026-10-04: extend the typed port fixture without changing persistence assertions.

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

describe('Attested flight search persistence boundary', () => {
  let module: TestingModule;
  let service: AttestedFlightSearchService;
  let handoff: ChatHandoffService;
  let commit: ReturnType<typeof deferred>;
  let transactionStarted: ReturnType<typeof deferred>;
  let transaction: jest.Mock;
  let flightSearch: jest.Mock;
  let savedEncryptionKey: string | undefined;
  let savedChatEncryptionKey: string | undefined;

  const request = {
    chatSessionId: 'session-1',
    proposedSnapshotVersion: 1,
    search: { origin: 'HAN', destination: 'SGN', date: '2026-10-01', adults: 1 },
  };

  beforeEach(async () => {
    savedEncryptionKey = process.env.ENCRYPTION_KEY;
    savedChatEncryptionKey = process.env.CHAT_ENCRYPTION_KEY;
    const testKey = crypto.randomBytes(32).toString('hex');
    process.env.ENCRYPTION_KEY = testKey;
    process.env.CHAT_ENCRYPTION_KEY = testKey;
    commit = deferred();
    transactionStarted = deferred();
    const committed = new Map<string, Prisma.FlightOfferCreateManyInput>();
    const origin = { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' };
    const destination = { id: 'SGN', name: 'Saigon', iata_code: 'SGN', type: 'airport' };
    const carrier = { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' };
    const offer: DuffelOffer & { expires_at: string } = {
      id: 'off_persistence',
      total_amount: '150.00',
      total_currency: 'USD',
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      passengers: [{ id: 'pas_1', type: 'adult' }],
      passenger_identity_documents_required: false,
      slices: [
        {
          id: 'slice-1',
          origin,
          destination,
          duration: 'PT2H',
          segments: [
            {
              id: 'segment-1',
              origin,
              destination,
              duration: 'PT2H',
              departing_at: '2026-10-01T08:00:00',
              arriving_at: '2026-10-01T10:00:00',
              marketing_carrier: carrier,
              operating_carrier: carrier,
              marketing_carrier_flight_number: '123',
              passengers: [{ passenger_id: 'pas_1', cabin_class: 'economy' }],
            },
          ],
        },
      ],
    };
    const normalizer = new FlightOfferNormalizer();
    const isCached = false;
    flightSearch = jest.fn().mockImplementation(async (criteria) => {
      const normalized = normalizer.normalizeOffer(
        offer,
        criteria.cabinClass || 'economy',
        0,
      );
      return {
        offers: [normalized],
        searchHash: 'search-1',
        cached: isCached,
      };
    });
    const flightSearchPort: FlightSearchPort = {
      search: flightSearch,
      getOfferById: jest.fn(),
      normalizeStoredOffer: (raw) => normalizer.normalizeStoredOffer(raw),
      normalizeStoredOfferFacts: (raw) => normalizer.normalizeStoredOfferFacts(raw),
      // Approved 2026-10-04 per T061: retain the existing supplier normalizer for raw snapshots.
      normalizeStoredFlightSnapshot: (raw) => normalizer.normalizeStoredFlightSnapshot(raw),
    };
    transaction = jest
      .fn()
      .mockImplementation(
        async (callback: (tx: Prisma.TransactionClient) => Promise<unknown>): Promise<unknown> => {
          const staged: Prisma.FlightOfferCreateManyInput[] = [];
          const tx = {
            searchHistory: { create: jest.fn().mockResolvedValue({ id: 'history-1' }) },
            flightOffer: {
              createMany: jest
                .fn()
                .mockImplementation(({ data }: { data: Prisma.FlightOfferCreateManyInput[] }) => {
                  staged.push(...data);
                  return Promise.resolve({ count: data.length });
                }),
            },
            offerRecovery: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
          };
          // Only the database boundary is replaced; staged rows become visible on commit.
          const result = await callback(tx as unknown as Prisma.TransactionClient);
          transactionStarted.resolve();
          await commit.promise;
          staged.forEach((row) => {
            if (row.id) committed.set(row.id, row);
          });
          return result;
        },
      );
    module = await Test.createTestingModule({
      providers: [
        AttestedFlightSearchService,
        FlightsService,
        FlightSearchOrchestratorService,
        ProfileService,
        EncryptionService,
        FlightMatchScorerService,
        CategoryRankerService,
        SelectionAttestationService,
        AgentToolAuditService,
        AuditService,
        ChatMessageCryptoService,
        ChatHandoffService,
        ChatHandoffTokenService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ATTESTATION_SECRET: 'attestation-test-secret',
            CHAT_HANDOFF_SECRET: 'handoff-test-secret',
            FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
            CHAT_ENCRYPTION_KEY: testKey,
          }),
        },
        { provide: CacheService, useValue: {} },
        { provide: FLIGHT_SEARCH_PORT, useValue: flightSearchPort },
        {
          provide: PrismaService,
          useValue: {
            airport: { findUnique: jest.fn().mockResolvedValue({}) },
            travelerProfile: { findUnique: jest.fn().mockResolvedValue(null) },
            chatSession: {
              findFirst: jest.fn().mockResolvedValue({ id: 'session-1', userId: 'user-1' }),
            },
            chatMessage: { findFirst: jest.fn().mockResolvedValue(null) },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
            flightOffer: {
              findUnique: jest
                .fn()
                .mockImplementation(({ where }: { where: { id: string } }) =>
                  Promise.resolve(committed.get(where.id) ?? null),
                ),
            },
            chatHandoff: {
              findUnique: jest.fn().mockResolvedValue(null),
              create: jest
                .fn()
                .mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data)),
            },
            $transaction: transaction,
          },
        },
      ],
    }).compile();
    service = module.get(AttestedFlightSearchService);
    handoff = module.get(ChatHandoffService);
  });

  afterEach(async () => {
    commit.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await module.close();
    if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedEncryptionKey;
    if (savedChatEncryptionKey === undefined) delete process.env.CHAT_ENCRYPTION_KEY;
    else process.env.CHAT_ENCRYPTION_KEY = savedChatEncryptionKey;
  });

  it.each([false, true])(
    'waits for commit before returning an immediately usable attestation (cached=%s)',
    async (cached) => {
      const searchResult = await flightSearch({ cabinClass: 'economy' });
      flightSearch.mockClear().mockResolvedValue({ ...searchResult, cached });
      let returned = false;
      const search = service.searchFlightsV2('user-1', request).then((result) => {
        returned = true;
        return result;
      });
      await transactionStarted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
      commit.resolve();
      const result = await search;
      expect(result.results).toHaveLength(1);
      await expect(
        handoff.create(
          {
            attestation: result.selectionAttestation,
            selectedOfferIndex: 1,
          },
          {},
          'user-1',
        ),
      ).resolves.toMatchObject({ token: expect.stringMatching(/^chk_handoff_/) });
      expect(flightSearch).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed when the offer transaction cannot commit', async () => {
    transaction.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(service.searchFlightsV2('user-1', request)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it.each(['v1', 'v2'])('uses the agent supplier budget for %s search', async (version) => {
    commit.resolve();
    if (version === 'v1') await service.searchFlights('user-1', request.search);
    else await service.searchFlightsV2('user-1', request);
    expect(flightSearch).toHaveBeenCalledWith(expect.any(Object), 'agent');
  });

  it('preserves baggage allowance when the supplier provides only weight', async () => {
    const searchResult = await flightSearch({ cabinClass: 'economy' });
    const passenger = (searchResult.offers[0].rawSupplierPayload as DuffelOffer).slices[0].segments[0].passengers?.[0];
    if (!passenger) throw new Error('Supplier fixture must include a segment passenger');
    passenger.baggages = [
      { type: 'checked', weight: 23, weight_unit: 'kg' },
    ];
    commit.resolve();
    const result = await service.searchFlightsV2('user-1', request);
    expect(result.results[0].baggageAllowance).toBe('23kg checked');
  });

  describe('ChatMessageCryptoService provider contract', () => {
    it('provides ChatMessageCryptoService adhering to contract separate from EncryptionService', () => {
      const cryptoService = module.get<ChatMessageCryptoService>(ChatMessageCryptoService);
      const encryptionService = module.get<EncryptionService>(EncryptionService);

      expect(cryptoService).toBeDefined();
      expect(cryptoService).toBeInstanceOf(ChatMessageCryptoService);
      expect(encryptionService).toBeDefined();
      expect(encryptionService).toBeInstanceOf(EncryptionService);
      expect(cryptoService).not.toBe(encryptionService);

      expect(typeof cryptoService.decryptMessageContent).toBe('function');
      expect(typeof cryptoService.encryptMessageContent).toBe('function');
      expect(typeof cryptoService.isConfigured).toBe('function');
      expect(cryptoService.isConfigured()).toBe(true);
    });

    it('verifies ChatMessageCryptoService contract encrypts and decrypts with record-bound AAD', async () => {
      const cryptoService = module.get<ChatMessageCryptoService>(ChatMessageCryptoService);

      const messageId = 'msg-persist-test';
      const sessionId = 'session-1';
      const sender = 'USER';
      const type = 'TEXT';
      const plaintext = 'Search flights from HAN to SGN';

      const encrypted = await cryptoService.encryptMessageContent(
        messageId,
        sessionId,
        sender,
        type,
        plaintext,
      );

      expect(encrypted).toHaveProperty('ciphertext');
      expect(encrypted).toHaveProperty('nonce');
      expect(encrypted).toHaveProperty('authTag');
      expect(encrypted.keyVersion).toBe(1);

      const decrypted = await cryptoService.decryptMessageContent({
        id: messageId,
        sessionId,
        sender,
        type,
        contentCiphertext: encrypted.ciphertext,
        contentNonce: encrypted.nonce,
        contentAuthTag: encrypted.authTag,
        contentKeyVersion: encrypted.keyVersion,
      });

      expect(decrypted).toBe(plaintext);
    });
  });
});
