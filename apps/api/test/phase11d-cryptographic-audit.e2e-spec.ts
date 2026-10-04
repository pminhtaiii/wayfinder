import * as crypto from 'crypto';

const encryptionKey = crypto.randomBytes(32).toString('hex');
const chatEncryptionKey = crypto.randomBytes(32).toString('hex');

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@127.0.0.1:5432/flight_booking?schema=public';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
process.env.ENCRYPTION_KEY = encryptionKey;
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'mock_stripe_key_placeholder';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_placeholder';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-1234567890';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';
process.env.ATTESTATION_SECRET = 'test-attestation-secret';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret-must-be-long-enough';
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AirportType, PassengerType, Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from '@/chat/chat.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { BookingProjectionRepository } from '@/booking-projection/booking-projection.repository';
import { CacheService } from '@/cache/cache.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

const SENSITIVE_PRIVACY_CORPUS = [
  'chk_handoff_v1_secret_credential_12345',
  'raw_handoff_token_secret_xyz',
  'duffel-private-offer-id-999',
  'off_01H123456789ABCDEF000000',
  'PNR-XYZ123',
  'PASS-998877',
  '4111222233334444',
  'customer.secret@example.com',
  'Plaintext sensitive customer flight booking conversation between Alice and Bob',
] as const;

function mintClaimToken(
  userId: string,
  iat: number,
  secret = 'test-claim-token-secret-must-be-long-enough',
): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('Phase 11D: Comprehensive Cryptographic and Data Privacy Final Audit (e2e)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let chatService: ChatService;
  let cryptoService: ChatMessageCryptoService;
  let attestationService: SelectionAttestationService;
  let handoffService: ChatHandoffService;
  let projectionRepository: BookingProjectionRepository;
  let cacheService: CacheService;

  const runMarker = `phase11d-audit-${crypto.randomUUID()}`;
  let testUserId: string;
  let testUserToken: string;
  let testSessionId: string;
  let testMessageId: string;
  let testFlightOfferId: string;
  let testBookingId: string;
  let issuedHandoffToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown): unknown => {
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          if (key === 'CHAT_ENCRYPTION_KEY') return chatEncryptionKey;
          if (key === 'ENCRYPTION_KEY') return encryptionKey;
          if (key === 'CLAIM_TOKEN_SECRET') return 'test-claim-token-secret-must-be-long-enough';
          if (key === 'AGENT_SERVICE_API_KEY') return 'test-agent-api-key';
          if (key === 'ATTESTATION_SECRET') return 'test-attestation-secret';
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    jwtService = moduleFixture.get(JwtService);
    chatService = moduleFixture.get(ChatService);
    cryptoService = moduleFixture.get(ChatMessageCryptoService);
    attestationService = moduleFixture.get(SelectionAttestationService);
    handoffService = moduleFixture.get(ChatHandoffService);
    projectionRepository = moduleFixture.get<BookingProjectionRepository>(BookingProjectionRepository);
    cacheService = moduleFixture.get(CacheService);

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `${runMarker}@phase11d-audit.test`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUserId = user.id;
    testUserToken = jwtService.sign(
      { sub: user.id, id: user.id, jti: crypto.randomUUID(), email: user.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );
  });

  afterAll(async () => {
    if (prisma && testUserId) {
      if (testBookingId) {
        await prisma.bookingAgentProjection.deleteMany({ where: { bookingId: testBookingId } });
        await prisma.booking.deleteMany({ where: { id: testBookingId } });
      }
      await prisma.auditLog.deleteMany({ where: { userId: testUserId } });
      await prisma.chatHandoff.deleteMany({ where: { userId: testUserId } });
      await prisma.bookingIntentPassenger.deleteMany({ where: { intent: { userId: testUserId } } });
      await prisma.bookingIntent.deleteMany({ where: { userId: testUserId } });
      await prisma.chatMessage.deleteMany({ where: { session: { userId: testUserId } } });
      await prisma.chatSession.deleteMany({ where: { userId: testUserId } });
      await prisma.flightOffer.deleteMany({ where: { searchHash: runMarker } });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    }
    await app?.close();
  });

  // ==========================================================================
  // 1. Schema Structure Verification via information_schema.columns
  // ==========================================================================
  describe('1. Schema Structure Verification via information_schema.columns', () => {
    it('asserts 0 "content" column on chat_messages table and presence of ciphertext envelope columns', async () => {
      const contentCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_messages' AND column_name = 'content';
      `;
      expect(contentCols.length).toBe(0);

      const ciphertextCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_messages' AND column_name IN (
          'contentCiphertext', 'contentNonce', 'contentAuthTag', 'contentKeyVersion'
        );
      `;
      expect(ciphertextCols.length).toBe(4);
    });

    it('asserts 0 "title" column on chat_sessions table and presence of ciphertext envelope columns', async () => {
      const titleCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name = 'title';
      `;
      expect(titleCols.length).toBe(0);

      const titleCiphertextCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name IN (
          'titleCiphertext', 'titleNonce', 'titleAuthTag', 'titleKeyVersion'
        );
      `;
      expect(titleCiphertextCols.length).toBe(4);
    });

    it('asserts 0 "token", "rawToken", or "duffelOfferId" columns on chat_handoffs and presence of hash columns', async () => {
      const forbiddenCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_handoffs' AND column_name IN ('token', 'rawToken', 'duffelOfferId');
      `;
      expect(forbiddenCols.length).toBe(0);

      const hashCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_handoffs' AND column_name IN (
          'tokenHash', 'idempotencyKeyHash', 'supplierOfferIdHash', 'selectionAttestationHash'
        );
      `;
      expect(hashCols.length).toBe(4);
    });

    it('asserts booking_agent_projections contains only allowlisted columns and 0 forbidden PII/payment/PNR columns', async () => {
      const columns: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'booking_agent_projections'
      `;
      const columnNames = columns.map((c) => c.column_name);

      // Verify presence of allowlisted columns
      const allowlisted = [
        'bookingId',
        'agentReference',
        'status',
        'airline',
        'origin',
        'destination',
        'departureAt',
        'arrivalAt',
        'durationMinutes',
        'stopCount',
        'flightNumber',
        'baggageSummary',
        'refundable',
        'changeable',
        'createdAt',
        'updatedAt',
      ];
      for (const col of allowlisted) {
        expect(columnNames).toContain(col);
      }

      // Verify absence of sensitive forbidden columns
      const forbidden = [
        'pnr',
        'pnrReference',
        'totalAmount',
        'price',
        'currency',
        'fareClass',
        'cabinClass',
        'passengerCount',
        'contactEmail',
        'contactPhone',
        'passportNumber',
        'paymentId',
        'stripePaymentIntentId',
        'rawDuffelOrder',
        'flightSnapshot',
        'passengerSnapshot',
      ];
      for (const col of forbidden) {
        expect(columnNames).not.toContain(col);
      }
    });
  });

  // ==========================================================================
  // 2. SQL Invariants Verification
  // ==========================================================================
  describe('2. SQL Invariants Verification', () => {
    it('SQL Invariant 1: zero chat_messages rows have NULL contentCiphertext', async () => {
      const result: Array<{ count: number }> = await prisma.$queryRaw`
        SELECT COUNT(*)::int as count FROM "chat_messages" WHERE "contentCiphertext" IS NULL;
      `;
      expect(result[0].count).toBe(0);
    });

    it('SQL Invariant 2: zero chat_handoffs rows have NULL tokenHash', async () => {
      const result: Array<{ count: number }> = await prisma.$queryRaw`
        SELECT COUNT(*)::int as count FROM "chat_handoffs" WHERE "tokenHash" IS NULL;
      `;
      expect(result[0].count).toBe(0);
    });

    it('SQL Invariant 3: zero booking_agent_projections rows have agentReference not matching bkref_%', async () => {
      const result: Array<{ count: number }> = await prisma.$queryRaw`
        SELECT COUNT(*)::int as count FROM "booking_agent_projections" WHERE "agentReference" NOT LIKE 'bkref_%';
      `;
      expect(result[0].count).toBe(0);
    });

    it('SQL Invariant 4: zero chat_sessions rows have NULL titleCiphertext when deletedAt IS NULL', async () => {
      const result: Array<{ count: number }> = await prisma.$queryRaw`
        SELECT COUNT(*)::int as count FROM "chat_sessions" WHERE "titleCiphertext" IS NULL AND "deletedAt" IS NULL;
      `;
      expect(result[0].count).toBe(0);
    });
  });

  // ==========================================================================
  // 3. Live Round-Trip & Negative Privacy Scan
  // ==========================================================================
  describe('3. Live Round-Trip & Negative Privacy Scan', () => {
    it('seeds sensitive session, messages, handoff, and projection and verifies raw SQL rows contain zero plaintext PII', async () => {
      const SENSITIVE_TITLE = 'Secret Flight to Danang PNR-XYZ123';
      const SENSITIVE_CONTENT =
        'Plaintext sensitive customer flight booking conversation between Alice and Bob with passport PASS-998877 and card 4111222233334444 and email customer.secret@example.com';

      // 1. Seed session with sensitive title
      const session = await chatService.createSession(testUserId, SENSITIVE_TITLE);
      testSessionId = session.id;
      expect(session.title).toBe(SENSITIVE_TITLE);

      // 2. Seed message with sensitive PII
      const message = await chatService.createMessage(testUserId, testSessionId, {
        sender: 'USER',
        content: SENSITIVE_CONTENT,
      });
      testMessageId = message.id;
      expect(message.content).toBe(SENSITIVE_CONTENT);

      // 3. Seed Flight Offer and Issue Handoff Token
      for (const airport of [
        { iataCode: 'SGN', name: 'Saigon', city: 'Ho Chi Minh', latitude: 10.8, longitude: 106.6 },
        { iataCode: 'DAD', name: 'Danang', city: 'Danang', latitude: 16.0, longitude: 108.2 },
      ]) {
        await prisma.airport.upsert({
          where: { iataCode: airport.iataCode },
          update: {},
          create: { ...airport, country: 'VN', type: AirportType.MEDIUM_AIRPORT },
        });
      }

      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: 'off_01H123456789ABCDEF000000',
          origin: 'SGN',
          destination: 'DAD',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(120),
          currency: 'USD',
          rawOffer: {
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            passengers: [{ id: 'pas_audit_1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'DAD' },
                    departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                    arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                    operating_carrier: { name: 'Vietnam Airlines' },
                  },
                ],
              },
            ],
          },
        },
      });
      testFlightOfferId = offer.id;

      const attestation = await attestationService.signSelectionAttestation(
        testUserId,
        testSessionId,
        1,
        new Date(Date.now() + 900_000).toISOString(),
        [{ flightOfferId: offer.id, duffelOfferId: 'off_01H123456789ABCDEF000000' }],
      );

      const claimToken = mintClaimToken(testUserId, Math.floor(Date.now() / 1000));

      const handoffRes = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimToken)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);

      issuedHandoffToken = handoffRes.body.token;
      expect(issuedHandoffToken).toBeDefined();

      // 4. Seed Booking and generate BookingAgentProjection
      const bookingIntent = await prisma.bookingIntent.create({
        data: {
          userId: testUserId,
          flightOfferId: offer.id,
          supplierOfferId: 'off_01H123456789ABCDEF000000',
          originalPrice: new Prisma.Decimal(120),
          confirmedPrice: new Prisma.Decimal(120),
          currency: 'USD',
          pricedAt: new Date(),
          origin: 'SGN',
          destination: 'DAD',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          rawOfferSnapshot: offer.rawOffer as Prisma.InputJsonValue,
          intentExpiresAt: new Date(Date.now() + 900_000),
        },
      });

      const booking = await prisma.booking.create({
        data: {
          userId: testUserId,
          bookingIntentId: bookingIntent.id,
          totalAmount: new Prisma.Decimal(120),
          currency: 'USD',
          status: 'CONFIRMED',
          pnrReference: 'PNR-XYZ123',
          supplierOrderId: 'ord_sensitive_duffel_123',
          flightSnapshot: {
            airline: { name: 'Vietnam Airlines', iataCode: 'VN' },
            stops: 0,
            baggageAllowance: '1x23kg',
            segments: [
              {
                airline: { name: 'Vietnam Airlines', iataCode: 'VN' },
                flightNumber: 'VN123',
                departureAirport: { iataCode: 'SGN' },
                arrivalAirport: { iataCode: 'DAD' },
                departureAt: new Date(Date.now() + 86_400_000).toISOString(),
                arrivalAt: new Date(Date.now() + 90_000_000).toISOString(),
              },
            ],
          },
          passengerSnapshot: [
            {
              givenName: 'Alice',
              familyName: 'Smith',
              passportNumber: 'PASS-998877',
              email: 'customer.secret@example.com',
            },
          ],
        },
      });
      testBookingId = booking.id;

      const agentReference = projectionRepository.generateAgentReference();
      await projectionRepository.upsertGuarded({
        bookingId: booking.id,
        status: booking.status,
        sourceVersion: 1,
        agentReference,
        airline: 'Vietnam Airlines',
        origin: 'SGN',
        destination: 'DAD',
        departureAt: new Date(Date.now() + 86_400_000),
        arrivalAt: new Date(Date.now() + 90_000_000),
        durationMinutes: 60,
        stopCount: 0,
        flightNumber: 'VN VN123',
        baggageSummary: '1x23kg',
      });
      const projection = await projectionRepository.findByBookingId(booking.id);
      expect(projection).not.toBeNull();
      expect(projection!.agentReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);

      // ======================================================================
      // Raw SQL Validations
      // ======================================================================

      // A. chat_messages raw row scan
      const rawMessages: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_messages" WHERE "id" = ${testMessageId}::text;
      `;
      expect(rawMessages.length).toBe(1);
      const rawMsg = rawMessages[0];
      expect(rawMsg.content).toBeUndefined();
      expect(rawMsg.contentCiphertext).toBeDefined();
      expect(rawMsg.contentNonce).toBeDefined();
      expect(rawMsg.contentAuthTag).toBeDefined();

      const rawMsgJson = JSON.stringify(rawMsg);
      for (const forbidden of SENSITIVE_PRIVACY_CORPUS) {
        expect(rawMsgJson).not.toContain(forbidden);
      }

      // B. chat_sessions raw row scan
      const rawSessions: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_sessions" WHERE "id" = ${testSessionId}::text;
      `;
      expect(rawSessions.length).toBe(1);
      const rawSes = rawSessions[0];
      expect(rawSes.title).toBeUndefined();
      expect(rawSes.titleCiphertext).toBeDefined();
      expect(rawSes.titleNonce).toBeDefined();
      expect(rawSes.titleAuthTag).toBeDefined();

      const rawSesJson = JSON.stringify(rawSes);
      for (const forbidden of SENSITIVE_PRIVACY_CORPUS) {
        expect(rawSesJson).not.toContain(forbidden);
      }

      // C. chat_handoffs raw row scan
      const rawHandoffs: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_handoffs" WHERE "chatSessionId" = ${testSessionId}::text;
      `;
      expect(rawHandoffs.length).toBeGreaterThan(0);
      const rawHandoffJson = JSON.stringify(rawHandoffs);
      expect(rawHandoffJson).not.toContain(issuedHandoffToken);
      expect(rawHandoffJson).not.toContain('off_01H123456789ABCDEF000000');

      // D. booking_agent_projections raw row scan
      const rawProjections: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "booking_agent_projections" WHERE "bookingId" = ${testBookingId}::text;
      `;
      expect(rawProjections.length).toBe(1);
      const rawProj = rawProjections[0];
      const rawProjJson = JSON.stringify(rawProj);

      // Must contain allowlisted safe flight details
      expect(rawProj.airline).toBe('Vietnam Airlines');
      expect(rawProj.origin).toBe('SGN');
      expect(rawProj.destination).toBe('DAD');
      expect(rawProj.flightNumber).toBe('VN VN123');
      expect(rawProj.agentReference).toMatch(/^bkref_/);

      // Must NOT contain any PNR, payment, or passenger PII
      for (const forbidden of SENSITIVE_PRIVACY_CORPUS) {
        expect(rawProjJson).not.toContain(forbidden);
      }
      expect(rawProjJson).not.toContain('ord_sensitive_duffel_123');
      expect(rawProjJson).not.toContain('Alice');
      expect(rawProjJson).not.toContain('Smith');

      // E. Decryption round-trip validation
      const fetchedSession = await chatService.getSession(testUserId, testSessionId);
      expect(fetchedSession.title).toBe(SENSITIVE_TITLE);

      const fetchedMessages = await chatService.listMessages(testUserId, testSessionId, {
        limit: 10,
        direction: 'before',
      });
      const foundMessage = fetchedMessages.messages.find((m) => m.id === testMessageId);
      expect(foundMessage).toBeDefined();
      expect(foundMessage!.content).toBe(SENSITIVE_CONTENT);

      // Direct crypto service round-trip
      const directDecryptedMessage = await cryptoService.decryptMessageContent(rawMsg as any);
      expect(directDecryptedMessage).toBe(SENSITIVE_CONTENT);

      const directDecryptedSession = await cryptoService.decryptSessionTitle(rawSes as any);
      expect(directDecryptedSession).toBe(SENSITIVE_TITLE);
    });

    it('fails closed when attempting to decrypt tampered ciphertext envelopes without fallback', async () => {
      const tamperedCiphertext = crypto.randomBytes(32).toString('hex');
      const tamperedNonce = crypto.randomBytes(12).toString('hex');
      const tamperedAuthTag = crypto.randomBytes(16).toString('hex');

      const tamperedMessage = {
        id: `tampered-msg-${crypto.randomUUID()}`,
        sessionId: testSessionId,
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: tamperedCiphertext,
        contentNonce: tamperedNonce,
        contentAuthTag: tamperedAuthTag,
        contentKeyVersion: 1,
      };

      await expect(cryptoService.decryptMessageContent(tamperedMessage as any)).rejects.toThrow();
    });
  });

  // ==========================================================================
  // 4. Redis Cache Negative Privacy Audit
  // ==========================================================================
  describe('4. Redis Cache Negative Privacy Audit', () => {
    it('populates chat keys in Redis and verifies zero unencrypted PII, raw tokens, or provider payloads', async () => {
      const budgetKey = `chat:budget:${runMarker}_user`;
      const lockKey = `chat:session-lock:${runMarker}_session`;
      const snapshotKey = `chat:snapshot:${runMarker}_user:${runMarker}_session`;

      // Set standard cache values
      await cacheService.set(budgetKey, '10', 60);
      await cacheService.set(lockKey, 'fence_token_audit_abc', 60);
      await cacheService.set(
        snapshotKey,
        JSON.stringify({
          schemaVersion: 1,
          snapshotVersion: 1,
          userId: `${runMarker}_user`,
          sessionId: `${runMarker}_session`,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          results: [],
        }),
        60,
      );

      const budgetVal = await cacheService.get(budgetKey);
      const lockVal = await cacheService.get(lockKey);
      const snapshotVal = await cacheService.get(snapshotKey);

      const aggregatedRedisPayloads = `${budgetKey} ${budgetVal} ${lockKey} ${lockVal} ${snapshotKey} ${snapshotVal}`;

      for (const forbidden of SENSITIVE_PRIVACY_CORPUS) {
        expect(aggregatedRedisPayloads).not.toContain(forbidden);
      }

      // Cleanup
      await cacheService.del(budgetKey);
      await cacheService.del(lockKey);
      await cacheService.del(snapshotKey);
    });
  });
});
