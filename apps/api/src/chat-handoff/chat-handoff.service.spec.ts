import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  ChatHandoffService,
  ResolvedChatHandoff,
  firstFlightSegment,
  lastFlightSegment,
  handoffPassengers,
} from './chat-handoff.service';
import { ChatHandoffTokenService } from './chat-handoff-token.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { PrismaService } from '@/prisma/prisma.service';
import { FlightOfferNormalizer } from '@/supplier/search/flight-offer.normalizer';
import { FLIGHT_SEARCH_PORT } from '@/supplier/search/flight-search.port';
import { CreateChatHandoffDto } from './dto/create-chat-handoff.dto';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ChatHandoff, FlightOffer, Prisma } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import * as crypto from 'crypto';

function createMockFlightSearchPort() {
  return {
    search: jest.fn(),
    getOfferById: jest.fn(),
    createOrder: jest.fn(),
    normalizeStoredOffer: jest.fn((rawOffer: unknown) =>
      FlightOfferNormalizer.normalizeStoredOffer(rawOffer),
    ),
  };
}

// User approved updating existing tests for Feature 017 T093 security and lifecycle coverage on 2026-08-10.
// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md

describe('ChatHandoffService', () => {
  let service: ChatHandoffService;
  let prisma: PrismaService;
  let configService: ConfigService;
  let tokenService: ChatHandoffTokenService;
  let attestationService: SelectionAttestationService;
  let auditService: { createLog: jest.Mock };

  function createMockAttestation(
    userId: string,
    chatSessionId: string,
    snapshotVersion: number,
    offers: any[],
  ) {
    const payload = {
      userId,
      sessionId: chatSessionId,
      version: snapshotVersion,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      offers,
    };
    const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `mock_v1_${payloadBase64}.signature`;
  }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHandoffService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn(),
            chatHandoff: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            chatSession: {
              findUnique: jest.fn(),
              findFirst: jest.fn().mockResolvedValue({ id: 'cs1', userId: 'u1', deletedAt: null }),
            },
            flightOffer: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: ChatHandoffTokenService,
          useValue: {
            deriveIdempotencyHash: jest.fn(),
            computeIdempotencyHash: jest.fn(),
            generateToken: jest.fn(),
            verifyToken: jest.fn(),
            hashToken: jest.fn((token: string) =>
              token ? crypto.createHash('sha256').update(token).digest('hex') : '',
            ),
          },
        },
        {
          provide: SelectionAttestationService,
          useValue: {
            verifySelectionAttestation: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: { createLog: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: FLIGHT_SEARCH_PORT,
          useValue: createMockFlightSearchPort(),
        },
      ],
    }).compile();

    service = module.get<ChatHandoffService>(ChatHandoffService);
    prisma = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
    tokenService = module.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    attestationService = module.get<SelectionAttestationService>(SelectionAttestationService);
    auditService = module.get(AuditService);

    jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
      id: 'fo1',
      supplierOfferId: 'duff1',
      origin: 'SGN',
      destination: 'NRT',
      price: '420.00',
      currency: 'USD',
      adults: 1,
      children: 0,
      infants: 0,
      rawOffer: {
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'NRT' },
                departing_at: '2026-09-20T02:00:00.000Z',
                arriving_at: '2026-09-20T08:30:00.000Z',
                operating_carrier: { name: 'Vietnam Airlines' },
              },
            ],
          },
        ],
      },
    } as any);
  });

  describe('extra field rejection and DTO validation', () => {
    it('fails validation when client-supplied ids or extra fields are present', async () => {
      const payload = {
        userId: 'u1',
        chatSessionId: 'cs1',
        flightOfferId: 'fo1',
        duffelOfferIdHash: 'duff1',
        selectionAttestationHash: 'attest',
        selectedOfferIndex: 1,
        snapshotVersion: 1,
        snapshotFingerprint: 'f',
        id: 'bad-id', // Extra field
        idempotencyKey: 'bad-key',
        session: 'bad-session',
      };
      const dto = plainToInstance(CreateChatHandoffDto, payload);
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'id')).toBe(true);
      expect(errors.some((e) => e.property === 'userId')).toBe(true);
      expect(errors.some((e) => e.property === 'chatSessionId')).toBe(true);
      expect(errors.some((e) => e.property === 'idempotencyKey')).toBe(true);
    });

    it('validates CreateChatHandoffDto with valid fields and rejects invalid selectedOfferIndex', async () => {
      const validDto = plainToInstance(CreateChatHandoffDto, {
        selectionAttestationHash: 'valid_attestation_hash',
        selectedOfferIndex: 1,
      });
      const validErrors = await validate(validDto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(validErrors.length).toBe(0);

      const invalidDto = plainToInstance(CreateChatHandoffDto, {
        selectionAttestationHash: 'valid_attestation_hash',
        selectedOfferIndex: 0,
      });
      const invalidErrors = await validate(invalidDto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(invalidErrors.length).toBeGreaterThan(0);
      expect(invalidErrors.some((e) => e.property === 'selectedOfferIndex')).toBe(true);
    });

    it('fails validation when neither selectionAttestationHash nor attestation is provided', async () => {
      const dto = plainToInstance(CreateChatHandoffDto, {
        selectedOfferIndex: 1,
      });
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some(
          (e) =>
            e.property === 'selectionAttestationHash' ||
            e.property === 'attestation' ||
            e.property === 'selectedOfferIndex',
        ),
      ).toBe(true);
    });

    it('fails validation when selectionAttestationHash and attestation conflict', async () => {
      const dto = plainToInstance(CreateChatHandoffDto, {
        selectionAttestationHash: 'attest_hash_1',
        attestation: 'attest_hash_2',
        selectedOfferIndex: 1,
      });
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'selectedOfferIndex')).toBe(true);
    });

    it('passes validation when both selectionAttestationHash and attestation are identical', async () => {
      const dto = plainToInstance(CreateChatHandoffDto, {
        selectionAttestationHash: 'attest_hash_1',
        attestation: 'attest_hash_1',
        selectedOfferIndex: 1,
      });
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors.length).toBe(0);
    });
  });

  describe('create and createHandoffToken', () => {
    it('throws ServiceUnavailableException without minting when ISSUE flag is off', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      await expect(service.create({} as any)).rejects.toThrow(ServiceUnavailableException);
      expect(prisma.chatHandoff.create).not.toHaveBeenCalled();
      expect(tokenService.generateToken).not.toHaveBeenCalled();
    });

    it('creates a handoff when ISSUE flag is on and supports createHandoffToken alias', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(tokenService, 'deriveIdempotencyHash').mockReturnValue('hash');
      jest.spyOn(tokenService, 'generateToken').mockResolvedValue({
        token: 'token',
        tokenHash: 'tokenhash',
        keyVersion: 1,
      });
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue(null);
      jest.spyOn(prisma.chatHandoff, 'create').mockResolvedValue({
        id: '1',
        expiresAt: new Date(),
      } as any);

      const mockAttestation = createMockAttestation('u1', 'cs1', 1, [
        { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
      ]);

      const result = await service.createHandoffToken({
        selectionAttestationHash: mockAttestation,
        selectedOfferIndex: 1,
      });

      expect(result.token).toBe('token');
      expect(result.expiresAt).toBeDefined();
      expect(attestationService.verifySelectionAttestation).toHaveBeenCalledWith(
        mockAttestation,
        'u1',
        'cs1',
        1,
        [{ flightOfferId: 'fo1', duffelOfferId: 'duff1' }],
      );
      const createdData = (prisma.chatHandoff.create as jest.Mock).mock.calls[0][0].data;
      expect(createdData.selectionAttestationHash).toMatch(/^[a-f0-9]{64}$/);
      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_created',
          metadata: expect.objectContaining({ operation: 'handoff_create' }),
        }),
      );
    });

    it('rejects creation when selectedOfferIndex is out of bounds', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      const mockAttestation = createMockAttestation('u1', 'cs1', 1, [
        { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
      ]);

      await expect(
        service.create({
          selectionAttestationHash: mockAttestation,
          selectedOfferIndex: 5,
        }),
      ).rejects.toThrow('Selected offer index out of bounds');
    });

    it('returns existing token on active-retry when existing record is found before create', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(tokenService, 'deriveIdempotencyHash').mockReturnValue('hash');

      const existingRecord = {
        id: 'existing-1',
        idempotencyKeyHash: 'hash',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 100000),
      };
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue(existingRecord as any);
      jest.spyOn(tokenService, 'generateToken').mockResolvedValue({
        token: 'token-replayed',
        tokenHash: 'tokenhash2',
        keyVersion: 1,
      });

      const result = await service.create({
        selectionAttestationHash: createMockAttestation('u1', 'cs1', 1, [
          { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
        ]),
        selectedOfferIndex: 1,
      });

      expect(result.token).toBe('token-replayed');
      expect(result.expiresAt).toBe(existingRecord.expiresAt.toISOString());
      expect(prisma.chatHandoff.create).not.toHaveBeenCalled();
      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_replay',
          metadata: expect.objectContaining({ operation: 'handoff_replay' }),
        }),
      );
    });

    it('returns existing token on active-retry (Unique constraint violation P2002)', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(tokenService, 'deriveIdempotencyHash').mockReturnValue('hash');

      // First findUnique returns null (simulate race condition)
      jest
        .spyOn(prisma.chatHandoff, 'findUnique')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: '1',
          idempotencyKeyHash: 'hash',
          consumedAt: null,
          expiresAt: new Date(Date.now() + 100000),
        } as any);

      const p2002Error = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.x',
      });
      jest.spyOn(prisma.chatHandoff, 'create').mockRejectedValue(p2002Error);

      jest.spyOn(tokenService, 'generateToken').mockResolvedValue({
        token: 'token2',
        tokenHash: 'tokenhash2',
        keyVersion: 1,
      });

      const result = await service.create({
        selectionAttestationHash: createMockAttestation('u1', 'cs1', 1, [
          { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
        ]),
        selectedOfferIndex: 1,
      });

      expect(result.token).toBe('token2');
      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_replay',
          metadata: expect.objectContaining({ operation: 'handoff_replay' }),
        }),
      );
    });

    it('rejects active-retry when existing record is expired or already consumed', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(tokenService, 'deriveIdempotencyHash').mockReturnValue('hash');

      const expiredRecord = {
        id: '1',
        idempotencyKeyHash: 'hash',
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      };
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue(expiredRecord as any);

      await expect(
        service.create({
          selectionAttestationHash: createMockAttestation('u1', 'cs1', 1, [
            { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
          ]),
          selectedOfferIndex: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'HANDOFF_EXPIRED' },
      });
    });

    it('rejects creation when flightOffer is not found in database', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue(null);

      const mockAttestation = createMockAttestation('u1', 'cs1', 1, [
        { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
      ]);

      await expect(
        service.create({
          selectionAttestationHash: mockAttestation,
          selectedOfferIndex: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'FLIGHT_OFFER_NOT_FOUND' },
      });
    });

    it('rejects creation when duffelOfferId does not match database flight offer', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
        id: 'fo1',
        supplierOfferId: 'different_duff_id',
        rawOffer: { expires_at: new Date(Date.now() + 60000).toISOString() },
      } as any);

      const mockAttestation = createMockAttestation('u1', 'cs1', 1, [
        { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
      ]);

      await expect(
        service.create({
          selectionAttestationHash: mockAttestation,
          selectedOfferIndex: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'FLIGHT_OFFER_NOT_FOUND' },
      });
    });

    it('rejects creation when flightOffer rawOffer is stale', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
        id: 'fo1',
        supplierOfferId: 'duff1',
        rawOffer: { expires_at: new Date(Date.now() - 1000).toISOString() },
      } as any);

      const mockAttestation = createMockAttestation('u1', 'cs1', 1, [
        { flightOfferId: 'fo1', duffelOfferId: 'duff1' },
      ]);

      await expect(
        service.create({
          selectionAttestationHash: mockAttestation,
          selectedOfferIndex: 1,
        }),
      ).rejects.toMatchObject({
        response: { code: 'HANDOFF_OFFER_STALE' },
      });
    });
  });

  describe('resolve and resolveHandoffToken', () => {
    it('throws ServiceUnavailableException when ACCEPT flag is off', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('false');
      await expect(service.resolve('token', 'userId')).rejects.toThrow(ServiceUnavailableException);
    });

    it('returns handoff data on successful resolve and supports resolveHandoffToken alias', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      const mockRecord = {
        id: '1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        flightOfferId: 'fo1',
        tokenHash: 'thash',
        tokenKeyVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
      };

      jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue(mockRecord as any);

      const result = await service.resolveHandoffToken('token', 'u1');
      expect(result).toBeDefined();
      expect(result.id).toBe('1');
      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_resolved',
          metadata: expect.objectContaining({ operation: 'handoff_resolve' }),
        }),
      );
    });

    it('rejects resolve when token is expired with GoneException', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      const expiredRecord = {
        id: '1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        flightOfferId: 'fo1',
        tokenHash: 'thash',
        tokenKeyVersion: 1,
        expiresAt: new Date(Date.now() - 10_000),
      };

      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue(expiredRecord as any);

      await expect(service.resolve('token', 'u1')).rejects.toMatchObject({
        response: { code: 'HANDOFF_EXPIRED' },
      });
    });

    it('rejects resolveSafe when handoff is already consumed with ConflictException', async () => {
      jest.spyOn(service, 'resolve').mockResolvedValue({
        id: 'handoff-1',
        flightOfferId: 'offer-1',
        consumedAt: new Date(),
      } as any);

      await expect(service.resolveSafe('token', 'u1')).rejects.toMatchObject({
        response: { code: 'HANDOFF_ALREADY_CONSUMED' },
      });
    });

    it('rejects resolveSafe when Duffel offer ID hash does not match', async () => {
      jest.spyOn(service, 'resolve').mockResolvedValue({
        id: 'handoff-1',
        flightOfferId: 'offer-1',
        supplierOfferIdHash: 'expected-hash-value',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        consumedAt: null,
        claimedAt: null,
        claimExpiresAt: null,
        claimRecoverAfter: null,
      } as any);
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
        supplierOfferId: 'different-duffel-id',
        origin: 'SGN',
        destination: 'HAN',
      } as any);

      await expect(service.resolveSafe('token', 'u1')).rejects.toMatchObject({
        response: { code: 'HANDOFF_NOT_FOUND' },
      });
    });

    it('records consumed-token resolve as a replay without sensitive metadata', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        id: '1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        flightOfferId: 'offer-123',
        tokenHash: 'thash',
        tokenKeyVersion: 1,
        consumedAt: new Date(),
      } as any);

      await service.resolve('token', 'u1');

      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_replay',
          metadata: expect.objectContaining({ operation: 'handoff_replay' }),
        }),
      );
      const metadata = JSON.stringify(auditService.createLog.mock.calls.at(-1)[1].metadata);
      expect(metadata).not.toContain('offer-123');
      expect(metadata).not.toContain('u1');
    });

    it('does not block token resolution on a stalled audit write', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        id: 'handoff-1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        tokenHash: 'token-hash',
        tokenKeyVersion: 1,
        expiresAt: new Date(Date.now() + 60_000),
      } as any);
      auditService.createLog.mockReturnValue(new Promise(() => undefined));

      const result = await Promise.race([
        service.resolve('token', 'u1'),
        new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 100)),
      ]);

      expect(result).not.toBe('timed-out');
    });

    it('claims the canonical consume winner before emitting resolve telemetry', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        id: 'handoff-1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        tokenHash: 'token-hash',
        tokenKeyVersion: 1,
        flightOfferId: 'offer-1',
        expiresAt: new Date(Date.now() + 60_000),
        consumedAt: null,
      } as any);
      (prisma.$queryRaw as jest.Mock) = jest.fn().mockResolvedValue([
        {
          id: 'handoff-1',
          userId: 'u1',
          chatSessionId: 'session-1',
          flightOfferId: 'offer-1',
          tokenHash: 'token-hash',
          tokenKeyVersion: 1,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ]);

      const result = await service.resolveAndAcquireClaim('chk_handoff_v1_test', 'u1', 30_000);

      expect(result.handoff.id).toBe('handoff-1');
      expect(result.claimToken).toEqual(expect.any(String));
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [sqlParts] = (prisma.$queryRaw as jest.Mock).mock.calls[0] as [TemplateStringsArray];
      expect(sqlParts.join('')).toContain('"chat_sessions"."deletedAt" IS NULL');
      expect(sqlParts.join('')).toContain('"chat_sessions"."userId"');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(auditService.createLog).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          action: 'chat_handoff_resolved',
          metadata: expect.objectContaining({ operation: 'handoff_resolve' }),
        }),
      );
    });

    it('rejects a simultaneous same-owner claim without a second database attempt', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      let releaseClaim!: (rows: Array<Record<string, unknown>>) => void;
      const claimQuery = new Promise<Array<Record<string, unknown>>>((resolve) => {
        releaseClaim = resolve;
      });
      (prisma.$queryRaw as jest.Mock) = jest.fn().mockReturnValue(claimQuery);

      const first = service.resolveAndAcquireClaim('chk_handoff_v1_test', 'u1', 30_000);
      await Promise.resolve();
      const second = service.resolveAndAcquireClaim('chk_handoff_v1_test', 'u1', 30_000);

      await expect(second).rejects.toMatchObject({
        response: { code: 'HANDOFF_IN_PROGRESS' },
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      releaseClaim([
        {
          id: 'handoff-1',
          userId: 'u1',
          chatSessionId: 'session-1',
          flightOfferId: 'offer-1',
          tokenHash: 'hash',
          tokenKeyVersion: 1,
          expiresAt: new Date(Date.now() + 60_000),
          consumedAt: null,
        },
      ]);
      await expect(first).resolves.toMatchObject({ handoff: { id: 'handoff-1' } });
    });

    // User approved T093 ownership and claim-recovery regression coverage on 2026-08-10.
    it('does not reveal expiration state to a foreign owner', async () => {
      jest.spyOn(configService, 'get').mockReturnValue('true');
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        id: 'handoff-foreign',
        userId: 'owner-user',
        chatSession: { userId: 'owner-user', deletedAt: null },
        tokenHash: 'token-hash',
        tokenKeyVersion: 1,
        expiresAt: new Date('2026-01-01T00:00:00.000Z'),
      } as any);

      await expect(service.resolve('token', 'foreign-user')).rejects.toMatchObject({
        response: { code: 'HANDOFF_NOT_FOUND' },
      });
      expect(tokenService.verifyToken).not.toHaveBeenCalled();
    });

    it('returns an allowlisted checkout view without internal identifiers', async () => {
      jest
        .spyOn(configService, 'get')
        .mockImplementation((key) =>
          key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT' ? 'true' : 'false',
        );
      jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        id: 'handoff-1',
        userId: 'u1',
        chatSession: { userId: 'u1', deletedAt: null },
        chatSessionId: 'session-1',
        flightOfferId: 'offer-1',
        supplierOfferIdHash: crypto.createHash('sha256').update('duffel-t093').digest('hex'),
        tokenHash: 'token-hash',
        tokenKeyVersion: 1,
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        claimedAt: null,
        consumedAt: null,
      } as any);
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
        supplierOfferId: 'duffel-t093',
        origin: 'SGN',
        destination: 'HAN',
        adults: 1,
        children: 0,
        infants: 0,
        price: '125.00',
        currency: 'USD',
        rawOffer: {
          expires_at: '2026-12-31T23:59:59.000Z',
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: '2026-12-01T08:00:00.000Z',
                  arriving_at: '2026-12-01T10:00:00.000Z',
                  operating_carrier: { name: 'T093 Airways' },
                },
              ],
            },
          ],
        },
      } as any);

      const result = await service.resolveSafe('token', 'u1');

      expect(result).toEqual({
        status: 'ACTIVE',
        expiresAt: '2026-12-01T00:00:00.000Z',
        offer: {
          airline: 'T093 Airways',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: '2026-12-01T08:00:00.000Z',
          arrivalAt: '2026-12-01T10:00:00.000Z',
          price: '125.00',
          currency: 'USD',
          adults: 1,
          children: 0,
          infants: 0,
        },
      });
      expect(JSON.stringify(result)).not.toContain('handoff-1');
      expect(JSON.stringify(result)).not.toContain('session-1');
      expect(JSON.stringify(result)).not.toContain('offer-1');
    });

    it('keeps a handoff unavailable throughout its claim recovery buffer', async () => {
      jest.spyOn(service, 'resolve').mockResolvedValue({
        id: 'handoff-1',
        flightOfferId: 'offer-1',
        supplierOfferIdHash: 'hash',
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        consumedAt: null,
        claimedAt: new Date(Date.now() - 60_000),
        claimExpiresAt: new Date(Date.now() - 1_000),
        claimRecoverAfter: new Date(Date.now() + 4_000),
      } as any);

      await expect(service.resolveSafe('token', 'u1')).rejects.toMatchObject({
        response: { code: 'HANDOFF_IN_PROGRESS' },
      });
      expect(prisma.flightOffer.findUnique).not.toHaveBeenCalled();
    });

    it('reports an abandoned claim as active after its recovery buffer', async () => {
      jest.spyOn(service, 'resolve').mockResolvedValue({
        id: 'handoff-1',
        flightOfferId: 'offer-1',
        supplierOfferIdHash: crypto.createHash('sha256').update('duffel-t093').digest('hex'),
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        consumedAt: null,
        claimedAt: new Date(Date.now() - 60_000),
        claimExpiresAt: new Date(Date.now() - 10_000),
        claimRecoverAfter: new Date(Date.now() - 5_000),
      } as any);
      jest.spyOn(prisma.flightOffer, 'findUnique').mockResolvedValue({
        supplierOfferId: 'duffel-t093',
        origin: 'SGN',
        destination: 'HAN',
        adults: 1,
        children: 0,
        infants: 0,
        price: '125.00',
        currency: 'USD',
        rawOffer: {
          expires_at: '2026-12-31T23:59:59.000Z',
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: '2026-12-01T08:00:00.000Z',
                  arriving_at: '2026-12-01T10:00:00.000Z',
                  operating_carrier: { name: 'T093 Airways' },
                },
              ],
            },
          ],
        },
      } as any);

      const result = await service.resolveSafe('token', 'u1');

      expect(result.status).toBe('ACTIVE');
    });
  });

  describe('fast-fail reservations', () => {
    it('releases only the matching owner reservation', () => {
      const reservationId = service.tryAcquireInFlight('chk_handoff_v1_test', 'u1');
      expect(reservationId).toEqual(expect.any(String));
      expect(service.tryAcquireInFlight('chk_handoff_v1_test', 'u1')).toBeNull();

      service.releaseInFlight('chk_handoff_v1_test', 'u1', 'different-reservation');
      expect(service.tryAcquireInFlight('chk_handoff_v1_test', 'u1')).toBeNull();

      service.releaseInFlight('chk_handoff_v1_test', 'u1', reservationId!);
      expect(service.tryAcquireInFlight('chk_handoff_v1_test', 'u1')).toEqual(expect.any(String));
    });
  });

  describe('claim lifecycle', () => {
    it('uses a skip-locked transaction so concurrent claim losers do not queue', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: '1' }]),
        chatHandoff: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(tx));

      await expect(service.acquireClaim('1', 'u1', 30000)).resolves.toEqual(expect.any(String));

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.chatHandoff.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.chatHandoff.updateMany).not.toHaveBeenCalled();
    });

    it('acquires a claim', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: '1' }]),
        chatHandoff: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(tx));

      const result = await service.acquireClaim('1', 'u1', 30000);
      expect(result).toBeDefined();
      expect(tx.chatHandoff.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [{ claimRecoverAfter: null }, { claimRecoverAfter: { lte: expect.any(Date) } }],
          }),
        }),
      );
    });

    it('fails to acquire a claim if already claimed', async () => {
      const tx = {
        $queryRaw: jest.fn().mockResolvedValue([]),
        chatHandoff: { updateMany: jest.fn() },
      };
      (prisma.$transaction as jest.Mock).mockImplementation(async (callback) => callback(tx));

      await expect(service.acquireClaim('1', 'u1', 30000)).rejects.toThrow(
        'Failed to acquire handoff claim',
      );
      expect(tx.chatHandoff.updateMany).not.toHaveBeenCalled();
    });

    it('refreshes a claim', async () => {
      jest.spyOn(prisma.chatHandoff, 'updateMany').mockResolvedValue({ count: 1 });
      await service.refreshClaim('1', 'token', 30000);
      expect(prisma.chatHandoff.updateMany).toHaveBeenCalled();
    });

    it('fails to refresh a claim if token invalid or expired', async () => {
      jest.spyOn(prisma.chatHandoff, 'updateMany').mockResolvedValue({ count: 0 });
      await expect(service.refreshClaim('1', 'token', 30000)).rejects.toThrow(
        'Claim lost or expired',
      );
    });

    it('releases a claim', async () => {
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        userId: 'user-1',
        tokenHash: 'token-hash-1',
      } as unknown as ChatHandoff);
      jest.spyOn(prisma.chatHandoff, 'updateMany').mockResolvedValue({ count: 1 });
      const internalService = service as unknown as { claimedTokens: Map<string, number> };
      internalService.claimedTokens.set('user-1:token-hash-1', Date.now() + 30000);

      await service.releaseClaim('1', 'token');
      expect(prisma.chatHandoff.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            claimExpiresAt: { gt: expect.any(Date) },
          }),
        }),
      );
      expect(internalService.claimedTokens.get('user-1:token-hash-1')).toBeUndefined();
    });

    it('silently ignores release if token invalid and does not clear active tracking', async () => {
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        userId: 'user-1',
        tokenHash: 'token-hash-1',
      } as unknown as ChatHandoff);
      jest.spyOn(prisma.chatHandoff, 'updateMany').mockResolvedValue({ count: 0 });
      const internalService = service as unknown as { claimedTokens: Map<string, number> };
      internalService.claimedTokens.set('user-1:token-hash-1', Date.now() + 30000);

      await service.releaseClaim('1', 'token');
      expect(prisma.chatHandoff.updateMany).toHaveBeenCalled();
      expect(internalService.claimedTokens.get('user-1:token-hash-1')).toBeDefined();
    });

    it('does not clear in-flight activeClaimAttempts when releasing a claim', async () => {
      jest.spyOn(prisma.chatHandoff, 'findUnique').mockResolvedValue({
        userId: 'user-1',
        tokenHash: 'token-hash-1',
      } as unknown as ChatHandoff);
      jest.spyOn(prisma.chatHandoff, 'updateMany').mockResolvedValue({ count: 1 });
      const internalService = service as unknown as {
        claimedTokens: Map<string, number>;
        activeClaimAttempts: Map<string, Promise<unknown>>;
      };
      const inFlightPromise = new Promise<{ handoff: ResolvedChatHandoff; claimToken: string }>(
        () => {},
      );
      internalService.activeClaimAttempts.set('user-1:token-hash-1', inFlightPromise);
      internalService.claimedTokens.set('user-1:token-hash-1', Date.now() + 30000);

      await service.releaseClaim('1', 'token');

      expect(internalService.claimedTokens.get('user-1:token-hash-1')).toBeUndefined();
      expect(internalService.activeClaimAttempts.get('user-1:token-hash-1')).toBe(inFlightPromise);
    });
  });
});

describe('Raw-Reader Replacement Parity (T015)', () => {
  let service: ChatHandoffService;
  let prisma: PrismaService;
  let configService: ConfigService;
  let tokenService: ChatHandoffTokenService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatHandoffService,
        {
          provide: PrismaService,
          useValue: {
            $transaction: jest.fn(),
            chatHandoff: {
              findUnique: jest.fn(),
              findFirst: jest.fn(),
              create: jest.fn(),
              update: jest.fn(),
              updateMany: jest.fn(),
            },
            chatSession: {
              findUnique: jest.fn(),
              findFirst: jest.fn().mockResolvedValue({ id: 'cs1', userId: 'u1', deletedAt: null }),
            },
            flightOffer: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: ChatHandoffTokenService,
          useValue: {
            deriveIdempotencyHash: jest.fn(),
            computeIdempotencyHash: jest.fn(),
            generateToken: jest.fn(),
            verifyToken: jest.fn(),
            hashToken: jest.fn((token: string) =>
              token ? crypto.createHash('sha256').update(token).digest('hex') : '',
            ),
          },
        },
        {
          provide: SelectionAttestationService,
          useValue: {
            verifySelectionAttestation: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: { createLog: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: FLIGHT_SEARCH_PORT,
          useValue: createMockFlightSearchPort(),
        },
      ],
    }).compile();

    service = module.get<ChatHandoffService>(ChatHandoffService);
    prisma = module.get<PrismaService>(PrismaService);
    configService = module.get<ConfigService>(ConfigService);
    tokenService = module.get<ChatHandoffTokenService>(ChatHandoffTokenService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const singleSliceOffer: Record<string, unknown> = {
    id: 'off_handoff_single',
    total_amount: '220.00',
    total_currency: 'USD',
    expires_at: '2030-09-01T10:00:00Z',
    passengers: [
      { id: 'pas_1', type: 'adult' },
      { id: 'pas_2', type: 'child' },
    ],
    slices: [
      {
        duration: 'PT1H20M',
        segments: [
          {
            id: 'seg_1',
            origin: { iata_code: 'SGN' },
            destination: { iata_code: 'DAD' },
            departing_at: '2030-09-10T06:00:00Z',
            arriving_at: '2030-09-10T07:20:00Z',
            duration: 'PT1H20M',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '123',
            operating_carrier: { iata_code: 'BL', name: 'Pacific Airlines' },
          },
        ],
      },
    ],
  };

  const multiSliceOffer: Record<string, unknown> = {
    id: 'off_handoff_multi',
    total_amount: '850.00',
    total_currency: 'USD',
    expires_at: '2030-09-01T10:00:00Z',
    passengers: [
      { id: 'pas_1', type: 'adult' },
      { id: 'pas_2', type: 'child' },
      { id: 'pas_3', type: 'infant' },
    ],
    slices: [
      {
        duration: 'PT14H',
        segments: [
          {
            id: 'seg_1',
            origin: { iata_code: 'SGN' },
            destination: { iata_code: 'NRT' },
            departing_at: '2030-09-15T00:30:00Z',
            arriving_at: '2030-09-15T07:45:00Z',
            duration: 'PT5H15M',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '300',
            operating_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
          },
          {
            id: 'seg_2',
            origin: { iata_code: 'NRT' },
            destination: { iata_code: 'LAX' },
            departing_at: '2030-09-15T11:00:00Z',
            arriving_at: '2030-09-15T18:00:00Z',
            duration: 'PT9H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '301',
            operating_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
          },
        ],
      },
      {
        duration: 'PT12H',
        segments: [
          {
            id: 'seg_3',
            origin: { iata_code: 'LAX' },
            destination: { iata_code: 'SGN' },
            departing_at: '2030-09-25T23:00:00Z',
            arriving_at: '2030-09-27T06:00:00Z',
            duration: 'PT12H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '302',
            operating_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
          },
        ],
      },
    ],
  };

  it('characterizes firstFlightSegment extraction: airline, flightNumber, origin, departureAt parity', () => {
    for (const rawOffer of [singleSliceOffer, multiSliceOffer]) {
      const firstSeg = firstFlightSegment(rawOffer);
      expect(firstSeg).not.toBeNull();

      const rawMarketingCarrier = firstSeg?.marketing_carrier as
        | { iata_code?: string; name?: string }
        | undefined;
      const rawOperatingCarrier = firstSeg?.operating_carrier as { name?: string } | undefined;
      const rawOriginObj = firstSeg?.origin as { iata_code?: string } | undefined;

      const rawAirline =
        rawOperatingCarrier?.name ?? rawMarketingCarrier?.name ?? 'Unknown Airline';
      const rawFlightNumber =
        (rawMarketingCarrier?.iata_code ?? '') +
        String(firstSeg?.marketing_carrier_flight_number ?? '');
      const rawOrigin = rawOriginObj?.iata_code ?? '';
      const rawDepartureAt = String(firstSeg?.departing_at ?? '');

      const normalized = FlightOfferNormalizer.normalizeStoredOffer(rawOffer);
      expect(normalized).not.toBeNull();

      // User-requested correction: handoff prefers the operating carrier; the offer airline prefers marketing.
      expect(normalized!.segments[0].operatingCarrier).toBe(rawAirline);
      expect(normalized!.airline).toBe(rawMarketingCarrier?.name ?? rawAirline);
      expect(normalized!.flightNumber).toBe(rawFlightNumber);
      expect(normalized!.departureAirport).toBe(rawOrigin);
      expect(normalized!.departureTime).toBe(rawDepartureAt);
    }
  });

  it('characterizes lastFlightSegment extraction: destination and arrivalAt parity', () => {
    // 1. Single slice (one-way flight)
    {
      const lastSeg = lastFlightSegment(singleSliceOffer);
      expect(lastSeg).not.toBeNull();

      const rawDestObj = lastSeg?.destination as { iata_code?: string } | undefined;
      const rawDestination = rawDestObj?.iata_code ?? '';
      const rawArrivalAt = String(lastSeg?.arriving_at ?? '');

      const normalized = FlightOfferNormalizer.normalizeStoredOffer(singleSliceOffer);
      expect(normalized).not.toBeNull();

      // In single slice, outbound arrival matches the journey arrival
      expect(normalized!.arrivalAirport).toBe(rawDestination);
      expect(normalized!.arrivalTime).toBe(rawArrivalAt);
    }

    // 2. Multi-slice (round-trip flight)
    {
      const lastSeg = lastFlightSegment(multiSliceOffer);
      expect(lastSeg).not.toBeNull();

      const rawDestObj = lastSeg?.destination as { iata_code?: string } | undefined;
      const rawDestination = rawDestObj?.iata_code ?? '';
      const rawArrivalAt = String(lastSeg?.arriving_at ?? '');

      const normalized = FlightOfferNormalizer.normalizeStoredOffer(multiSliceOffer);
      expect(normalized).not.toBeNull();

      // normalized.arrivalAirport reflects the outbound destination ('LAX')
      expect(normalized!.arrivalAirport).toBe('LAX');
      // The final return segment of the overall journey reflects the last segment arrival ('SGN')
      const finalReturnSegment =
        normalized!.returnSegments![normalized!.returnSegments!.length - 1];
      expect(finalReturnSegment.arrivalAirport).toBe(rawDestination);
      expect(finalReturnSegment.arrivalTime).toBe(rawArrivalAt);
    }
  });

  it('characterizes handoffPassengers extraction: passenger IDs and types match 100%', () => {
    for (const rawOffer of [singleSliceOffer, multiSliceOffer]) {
      const rawPassengers = handoffPassengers(rawOffer);
      expect(rawPassengers).not.toBeNull();

      const normalized = FlightOfferNormalizer.normalizeStoredOffer(rawOffer);
      expect(normalized).not.toBeNull();

      const portPassengers = normalized!.passengers.map((p) => ({
        id: p.supplierPassengerId,
        type: p.type,
      }));

      expect(portPassengers).toEqual(rawPassengers);
    }
  });

  it('characterizes summary field parity against resolveSafe output', async () => {
    const rawOffer = singleSliceOffer;
    const normalized = FlightOfferNormalizer.normalizeStoredOffer(rawOffer);
    expect(normalized).not.toBeNull();

    jest.spyOn(configService, 'get').mockImplementation((key: string) => {
      if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
      return null;
    });

    jest.spyOn(tokenService, 'verifyToken').mockResolvedValue(true);
    jest.spyOn(tokenService, 'hashToken').mockImplementation((val: string) => `hash_${val}`);

    const handoffRecord = {
      id: 'handoff-uuid-1',
      userId: 'user-1',
      chatSessionId: 'session-1',
      flightOfferId: 'fo-1',
      supplierOfferIdHash: 'hash_off_handoff_single',
      tokenHash: 'hash_chk_handoff_validtoken',
      tokenKeyVersion: 1,
      claimExpiresAt: null,
      claimRecoverAfter: null,
      expiresAt: new Date(Date.now() + 600000),
      consumedAt: null,
      chatSession: { userId: 'user-1', deletedAt: null },
    };

    const flightOfferRecord = {
      id: 'fo-1',
      supplierOfferId: 'off_handoff_single',
      rawOffer,
      origin: 'SGN',
      destination: 'DAD',
      price: 220,
      currency: 'USD',
      adults: 1,
      children: 1,
      infants: 0,
    };

    jest
      .spyOn(prisma.chatHandoff, 'findUnique')
      .mockResolvedValue(handoffRecord as unknown as ChatHandoff);
    jest
      .spyOn(prisma.flightOffer, 'findUnique')
      .mockResolvedValue(flightOfferRecord as unknown as FlightOffer);

    const safeResult = await service.resolveSafe('chk_handoff_validtoken', 'user-1');

    // Preserve the operating-carrier precedence characterized by the corrected parity test.
    expect(safeResult.offer.airline).toBe(normalized!.segments[0].operatingCarrier);
    expect(safeResult.offer.departureAt).toBe(normalized!.departureTime);
    expect(safeResult.offer.arrivalAt).toBe(normalized!.arrivalTime);
    expect(safeResult.offer.origin).toBe(normalized!.departureAirport);
    expect(safeResult.offer.destination).toBe(normalized!.arrivalAirport);
    expect(safeResult.passengers).toEqual(
      normalized!.passengers.map((p) => ({ id: p.supplierPassengerId, type: p.type })),
    );
  });

  it('characterizes malformed raw payloads: normalizeStoredOffer returns null matching existing null parsers', () => {
    const legacyNullParserPayloads: readonly unknown[] = [
      null,
      undefined,
      {},
      { slices: 'not-an-array' },
      { slices: [] },
      { slices: [{ segments: [] }] },
      { slices: [{ segments: 'not-an-array' }] },
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: '2030-09-10T08:00:00Z',
                arriving_at: '2030-09-10T10:00:00Z',
              },
            ],
          },
        ],
        passengers: 'not-an-array',
      },
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: '2030-09-10T08:00:00Z',
                arriving_at: '2030-09-10T10:00:00Z',
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_1', type: 'unknown_type' }],
      },
    ];

    for (const malformed of legacyNullParserPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(malformed)).toBeNull();
      expect(createMockFlightSearchPort().normalizeStoredOffer(malformed)).toBeNull();

      const firstSeg = firstFlightSegment(malformed);
      const pass = handoffPassengers(malformed as Record<string, unknown> | null);

      expect(firstSeg === null || pass === null).toBe(true);
    }

    const additionalCorruptedPayloads: readonly unknown[] = [
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: '2030-09-10T08:00:00Z',
                arriving_at: '2030-09-10T10:00:00Z',
              },
            ],
          },
        ],
        passengers: [],
      },
      {
        slices: [{ segments: [{ origin: null }] }],
        passengers: [{ id: 'pas_1', type: 'adult' }],
      },
      {
        slices: [{ segments: [{ destination: null }] }],
        passengers: [{ id: 'pas_1', type: 'adult' }],
      },
      {
        id: 'bad-iso',
        total_amount: '100',
        total_currency: 'USD',
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                departing_at: 'invalid-iso-date',
                arriving_at: '2030-09-10T10:00:00Z',
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_1', type: 'adult' }],
      },
    ];

    for (const corrupted of additionalCorruptedPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(corrupted)).toBeNull();
    }
  });
});

