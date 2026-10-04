import * as crypto from 'crypto';

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.CHAT_HANDOFF_SECRET = 'phase11e-reliability-secret-32b!';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ChatService } from '@/chat/chat.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma } from '@prisma/client';

describe('Phase 11E: Continuous Reliability, Lifecycle & DR Cryptographic Audit (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let chatService: ChatService;
  let cryptoService: ChatMessageCryptoService;

  let testUser: { id: string; email: string };
  let testFlightOffer: { id: string };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    chatService = moduleFixture.get<ChatService>(ChatService);
    cryptoService = moduleFixture.get<ChatMessageCryptoService>(ChatMessageCryptoService);

    const suffix = crypto.randomBytes(4).toString('hex');
    testUser = await prisma.user.create({
      data: {
        email: `reliab-user-${suffix}@test.com`,
        password: 'hashed_password',
        status: 'ACTIVE',
      },
    });

    testFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: `sh_${suffix}`,
        supplierOfferId: `off_reliab_${suffix}`,
        rawOffer: {},
        origin: 'SFO',
        destination: 'NRT',
        departureDate: new Date(Date.now() + 86400000),
        adults: 1,
        price: new Prisma.Decimal(750.0),
        currency: 'USD',
      },
    });
  });

  afterAll(async () => {
    if (testFlightOffer?.id) {
      await prisma.flightOffer.deleteMany({ where: { id: testFlightOffer.id } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    }
    await app.close();
  });

  describe('ChatSession Soft-Delete & Handoff Lifecycle', () => {
    it('revokes unconsumed active handoffs while preserving consumed handoffs with immutable audit links', async () => {
      // 1. Create a session
      const session = await chatService.createSession(testUser.id, 'Lifecycle Test Session');

      // 2. Create an unconsumed active handoff
      const unconsumedHandoff = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: session.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-unconsumed',
          selectionAttestationHash: 'att-unconsumed',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(Date.now() + 300000), // 5 min in future
          claimedAt: new Date(),
          claimTokenHash: 'claim-token-123',
          claimExpiresAt: new Date(Date.now() + 60000),
          claimRecoverAfter: new Date(Date.now() + 65000),
          consumedAt: null,
          consumedByBookingIntentId: null,
        },
      });

      // 3. Create a consumed handoff linked to a BookingIntent
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: testUser.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferId: `off_intent_${crypto.randomUUID()}`,
          originalPrice: new Prisma.Decimal(750),
          confirmedPrice: new Prisma.Decimal(750),
          currency: 'USD',
          status: 'PENDING',
          pricedAt: new Date(),
          origin: 'SFO',
          destination: 'NRT',
          departureDate: new Date(Date.now() + 86400000),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 600000),
        },
      });

      const consumedHandoff = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: session.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-consumed',
          selectionAttestationHash: 'att-consumed',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(Date.now() + 300000),
          claimedAt: new Date(Date.now() - 60000),
          claimTokenHash: 'claim-token-consumed',
          claimExpiresAt: new Date(Date.now() + 60000),
          claimRecoverAfter: new Date(Date.now() + 65000),
          consumedAt: new Date(),
          consumedByBookingIntentId: intent.id,
        },
      });

      // 4. Soft-delete session
      await chatService.deleteSession(testUser.id, session.id);

      // 5. Verify unconsumed handoff is invalidated / revoked
      const updatedUnconsumed = await prisma.chatHandoff.findUnique({
        where: { id: unconsumedHandoff.id },
      });
      expect(updatedUnconsumed).toBeDefined();
      expect(updatedUnconsumed?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(updatedUnconsumed?.claimedAt).toBeNull();
      expect(updatedUnconsumed?.claimTokenHash).toBeNull();
      expect(updatedUnconsumed?.claimExpiresAt).toBeNull();
      expect(updatedUnconsumed?.claimRecoverAfter).toBeNull();

      // 6. Verify consumed handoff is completely preserved with immutable audit link
      const updatedConsumed = await prisma.chatHandoff.findUnique({
        where: { id: consumedHandoff.id },
      });
      expect(updatedConsumed).toBeDefined();
      expect(updatedConsumed?.consumedAt).not.toBeNull();
      expect(updatedConsumed?.consumedByBookingIntentId).toBe(intent.id);
      expect(updatedConsumed?.claimTokenHash).toBe('claim-token-consumed');

      // Cleanup
      await prisma.chatHandoff.deleteMany({ where: { chatSessionId: session.id } });
      await prisma.bookingIntent.delete({ where: { id: intent.id } });
      await prisma.chatSession.delete({ where: { id: session.id } });
    });
  });

  describe('Disaster Recovery Backup Restoration Cryptographic Audit', () => {
    it('simulates DB dump restoration and verifies AES-256-GCM ciphertext decrypts cleanly with active key & AAD', async () => {
      // 1. Create encrypted session & message
      const session = await chatService.createSession(testUser.id, 'DR Backup Test Session');
      const msg = await chatService.createMessage(testUser.id, session.id, {
        sender: 'USER',
        type: 'STANDARD',
        content: 'Top secret booking itinerary plan',
      });

      expect(msg.content).toBe('Top secret booking itinerary plan');

      // 2. Fetch raw database row (simulating restored snapshot)
      const rawSession = await prisma.chatSession.findUnique({ where: { id: session.id } });
      const rawMsg = await prisma.chatMessage.findUnique({ where: { id: msg.id } });

      expect(rawSession?.titleCiphertext).not.toBeNull();
      expect(rawSession?.titleNonce).not.toBeNull();
      expect(rawSession?.titleAuthTag).not.toBeNull();
      expect(rawMsg?.contentCiphertext).not.toBeNull();
      expect(rawMsg?.contentNonce).not.toBeNull();
      expect(rawMsg?.contentAuthTag).not.toBeNull();

      // 3. Assert decrypted cleanly with valid active CHAT_ENCRYPTION_KEY
      const decryptedTitle = await cryptoService.decryptSessionTitle(rawSession!);
      expect(decryptedTitle).toBe('DR Backup Test Session');

      const decryptedMsg = await cryptoService.decryptMessageContent(rawMsg!);
      expect(decryptedMsg).toBe('Top secret booking itinerary plan');

      // 4. Assert fail-closed if key is wrong
      const wrongKeyMockConfig = {
        get: (key: string) => {
          if (key === 'CHAT_ENCRYPTION_KEY') {
            return crypto.randomBytes(32).toString('hex'); // Different 32-byte key
          }
          return null;
        },
      } as unknown as ConfigService;
      const wrongKeyCryptoService = new ChatMessageCryptoService(wrongKeyMockConfig);

      await expect(wrongKeyCryptoService.decryptSessionTitle(rawSession!)).rejects.toThrow();
      await expect(wrongKeyCryptoService.decryptMessageContent(rawMsg!)).rejects.toThrow();

      // 5. Assert fail-closed if record-bound AAD is tampered
      const tamperedMsg = {
        ...rawMsg!,
        sessionId: crypto.randomUUID(), // Tampered session id binding in AAD
      };
      await expect(cryptoService.decryptMessageContent(tamperedMsg)).rejects.toThrow();

      const tamperedSenderMsg = {
        ...rawMsg!,
        sender: 'AGENT' as const, // Tampered sender binding in AAD
      };
      await expect(cryptoService.decryptMessageContent(tamperedSenderMsg)).rejects.toThrow();

      // Cleanup
      await prisma.chatMessage.deleteMany({ where: { sessionId: session.id } });
      await prisma.chatSession.delete({ where: { id: session.id } });
    });
  });
});
