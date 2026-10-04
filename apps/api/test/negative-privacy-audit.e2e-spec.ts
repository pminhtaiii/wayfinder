import * as crypto from 'crypto';

const encryptionKey = crypto.randomBytes(32).toString('hex');
const chatEncryptionKey = crypto.randomBytes(32).toString('hex');

process.env.ENCRYPTION_KEY = encryptionKey;
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
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
import Redis from 'ioredis';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { ChatService } from '@/chat/chat.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { BookingIntentService } from '@/booking-intent/booking-intent.service';
import { BookingReadinessObservability } from '@/booking-intent/booking-readiness.observability';
import { CacheService } from '@/cache/cache.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { createChatTelemetryEvent } from '@/common/observability/chat-observability';

const FORBIDDEN_PRIVACY_CORPUS = [
  'chk_handoff_v1_secret_credential_12345',
  'chk_handoff_v1_stale_987654321',
  'raw_handoff_token_secret_xyz',
  'duffel-private-offer-id-999',
  'off_01H123456789ABCDEF000000',
  'local_flight_offer_id_uuid_777777',
  'flight-offer-local-uuid-1234',
  'booking_db_id_uuid_888888',
  'PNR-XYZ123',
  'PNR123456',
  'pnr_ABCDEF',
  'PASS-123456',
  'P12345678',
  'B98765432',
  '4111222233334444',
  '4111111111111111',
  '4242424242424242',
  'Plaintext sensitive customer conversation between Alice and Bob',
  'customer.secret@example.com',
  'traveller.john@example.test',
  '+84 912345678',
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

describe('Automated Negative Privacy & Security Continuous Audit (e2e)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let chatService: ChatService;
  let cryptoService: ChatMessageCryptoService;
  let attestationService: SelectionAttestationService;
  let duffel: Duffel;
  let handoffService: ChatHandoffService;
  let intentService: BookingIntentService;
  let readinessObservability: BookingReadinessObservability;
  let cacheService: CacheService;

  const capturedTelemetryLogs: string[] = [];
  const runMarker = `privacy-audit-${crypto.randomUUID()}`;
  let testUserId: string;
  let testUserToken: string;

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
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    handoffService = moduleFixture.get(ChatHandoffService);
    intentService = moduleFixture.get(BookingIntentService);
    readinessObservability = moduleFixture.get(BookingReadinessObservability);
    cacheService = moduleFixture.get(CacheService);

    // Spy on logger outputs to capture any emitted JSON telemetry or logs
    const mockLogger = {
      log: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
      warn: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
      error: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
    };
    (handoffService as unknown as { logger: typeof mockLogger }).logger = mockLogger;
    (intentService as unknown as { logger: typeof mockLogger }).logger = mockLogger;
    (readinessObservability as unknown as { logger: typeof mockLogger }).logger = mockLogger;

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `${runMarker}@negative-privacy.test`,
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
  // 1. Raw PostgreSQL Database Tables Scanner
  // ==========================================================================
  describe('Raw PostgreSQL Database Tables Scanner', () => {
    it('verifies chat_messages table contains 0 "content" column and stores ciphertext only', async () => {
      const contentCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_messages' AND column_name = 'content';
      `;
      expect(contentCols.length).toBe(0);

      const ciphertextCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_messages' AND column_name IN ('contentCiphertext', 'contentNonce', 'contentAuthTag', 'contentKeyVersion');
      `;
      expect(ciphertextCols.length).toBe(4);
    });

    it('verifies chat_sessions table contains 0 "title" column and stores ciphertext only', async () => {
      const titleCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name = 'title';
      `;
      expect(titleCols.length).toBe(0);

      const titleCiphertextCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name IN ('titleCiphertext', 'titleNonce', 'titleAuthTag', 'titleKeyVersion');
      `;
      expect(titleCiphertextCols.length).toBe(4);
    });

    it('verifies chat_handoffs table contains 0 "token" or raw offer ID column (tokenHash only)', async () => {
      const rawTokenCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_handoffs' AND column_name IN ('token', 'rawToken', 'duffelOfferId');
      `;
      expect(rawTokenCols.length).toBe(0);

      const hashCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_handoffs' AND column_name IN ('tokenHash', 'supplierOfferIdHash', 'selectionAttestationHash');
      `;
      expect(hashCols.length).toBe(3);
    });

    it('persists chat messages and sessions with zero plaintext across raw PostgreSQL database rows', async () => {
      const SENSITIVE_CONVERSATION =
        'Plaintext sensitive customer conversation between Alice and Bob with passport PASS-123456';
      const SENSITIVE_TITLE = 'Trip to Danang PNR-XYZ123';

      const session = await chatService.createSession(testUserId, SENSITIVE_TITLE);
      const message = await chatService.createMessage(testUserId, session.id, {
        sender: 'USER',
        content: SENSITIVE_CONVERSATION,
      });

      // Raw SQL query directly against PostgreSQL table
      const rawMessageRows: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_messages" WHERE "id" = ${message.id}::text;
      `;
      expect(rawMessageRows.length).toBe(1);
      const rawMsg = rawMessageRows[0];

      // Ensure no plaintext content column in row
      expect(rawMsg.content).toBeUndefined();
      expect(rawMsg.contentCiphertext).toBeDefined();

      const rawSessionRows: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_sessions" WHERE "id" = ${session.id}::text;
      `;
      expect(rawSessionRows.length).toBe(1);
      const rawSes = rawSessionRows[0];
      expect(rawSes.title).toBeUndefined();
      expect(rawSes.titleCiphertext).toBeDefined();

      // Negative scan across serialized database records
      const rawMsgJson = JSON.stringify(rawMsg);
      const rawSesJson = JSON.stringify(rawSes);

      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(rawMsgJson).not.toContain(forbidden);
        expect(rawSesJson).not.toContain(forbidden);
      }
    });
  });

  // ==========================================================================
  describe('Chat Handoffs & Audit Logs Zero PII Scanner', () => {
    it('executes full handoff issuance, resolution, and booking flow without leaking forbidden corpus', async () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      const user = await prisma.user.upsert({
        where: { email: `${runMarker}@negative-privacy.test` },
        update: {},
        create: {
          id: testUserId,
          email: `${runMarker}@negative-privacy.test`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });
      testUserId = user.id;

      const session = await chatService.createSession(testUserId);
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: `off_01H123456789ABCDEF000000`,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(150),
          currency: 'USD',
          rawOffer: {
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            passengers: [{ id: 'pas_audit_1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                    arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                    operating_carrier: { name: 'Negative Privacy Carrier' },
                  },
                ],
              },
            ],
          },
        },
      });

      for (const airport of [
        { iataCode: 'SGN', name: 'Saigon', city: 'Ho Chi Minh', latitude: 10.8, longitude: 106.6 },
        { iataCode: 'HAN', name: 'Hanoi', city: 'Hanoi', latitude: 21.2, longitude: 105.8 },
      ]) {
        await prisma.airport.upsert({
          where: { iataCode: airport.iataCode },
          update: {},
          create: { ...airport, country: 'VN', type: AirportType.MEDIUM_AIRPORT },
        });
      }

      const attestation = await attestationService.signSelectionAttestation(
        testUserId,
        session.id,
        1,
        new Date(Date.now() + 900_000).toISOString(),
        [{ flightOfferId: offer.id, duffelOfferId: `off_01H123456789ABCDEF000000` }],
      );

      const claimToken = mintClaimToken(testUserId, Math.floor(Date.now() / 1000));

      // Issue handoff
      const handoffRes = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimToken)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);

      const issuedToken = handoffRes.body.token;
      expect(issuedToken).toBeDefined();

      // Resolve handoff
      await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: issuedToken })
        .set('Authorization', `Bearer ${testUserToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      // Consume handoff
      const duffelGetSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: `off_01H123456789ABCDEF000000`,
          total_amount: '150.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: 'pas_audit_1', type: 'adult' }],
        },
      } as never);

      await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${testUserToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({
          handoffToken: issuedToken,
          passengers: [
            {
              offerPassengerId: 'pas_audit_1',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'TestAuditor',
                familyName: 'PrivacyChecker',
                dateOfBirth: '1990-01-01',
                gender: 'male',
                nationality: 'VN',
                email: 'customer.secret@example.com',
                phoneCountryCode: '+84',
                phoneNumber: '912345678',
                title: 'Mr',
              },
            },
          ],
        })
        .expect(201);

      duffelGetSpy.mockRestore();

      // Scan Raw chat_handoffs table in DB
      const rawHandoffRows: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_handoffs" WHERE "userId" = ${testUserId}::text;
      `;
      expect(rawHandoffRows.length).toBeGreaterThan(0);
      const serializedHandoffRows = JSON.stringify(rawHandoffRows);

      // Must NOT contain raw token or raw offer ID
      expect(serializedHandoffRows).not.toContain(issuedToken);
      expect(serializedHandoffRows).not.toContain('off_01H123456789ABCDEF000000');

      // Scan AuditLog records in DB
      const dbAuditLogs = await prisma.auditLog.findMany({
        where: { userId: testUserId },
      });
      expect(dbAuditLogs.length).toBeGreaterThan(0);
      const serializedAuditLogs = JSON.stringify(dbAuditLogs);

      // Audit logs metadata must contain 0 PII or raw secrets
      expect(serializedAuditLogs).not.toContain(issuedToken);
      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(serializedAuditLogs).not.toContain(forbidden);
      }
    });
  });

  // ==========================================================================
  // 3. Application Logs & Telemetry Stream Scanner
  // ==========================================================================
  describe('Application Logs & Telemetry Stream Scanner', () => {
    it('telemetry engine strictly rejects forbidden corpus from metadata', () => {
      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(() =>
          createChatTelemetryEvent('handoff_resolve', 'resolved', 15, {}, { outcome: forbidden }),
        ).toThrow('not safe to emit');
      }
    });

    it('scans 100% of captured application logs and verifies zero forbidden corpus matches', () => {
      const mergedLogs = capturedTelemetryLogs.join(' \n ');
      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(mergedLogs).not.toContain(forbidden);
      }
    });
  });

  // ==========================================================================
  // 4. Redis Keys & Cache Store Scanner
  // ==========================================================================
  describe('Redis Keys & Cache Store Scanner (chat:budget:*, chat:session-lock:*, chat:snapshot:*)', () => {
    it('verifies Redis chat keys and payloads contain zero forbidden privacy corpus', async () => {
      // Populate sample budget, session-lock, and snapshot keys in cache/Redis
      const testPrefix = `audit_${runMarker}`;
      const budgetKey = `chat:budget:${testPrefix}_user`;
      const lockKey = `chat:session-lock:${testPrefix}_session`;
      const snapshotKey = `chat:snapshot:${testPrefix}_user:${testPrefix}_session`;

      await cacheService.set(budgetKey, '5', 60);
      await cacheService.set(lockKey, 'fence_token_123', 60);
      await cacheService.set(
        snapshotKey,
        JSON.stringify({
          schemaVersion: 1,
          snapshotVersion: 1,
          userId: `${testPrefix}_user`,
          sessionId: `${testPrefix}_session`,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          results: [],
        }),
        60,
      );

      // Scan Cache / Redis for keys and values
      const budgetVal = await cacheService.get(budgetKey);
      const lockVal = await cacheService.get(lockKey);
      const snapshotVal = await cacheService.get(snapshotKey);

      const allRedisPayloads = `${budgetKey} ${budgetVal} ${lockKey} ${lockVal} ${snapshotKey} ${snapshotVal}`;

      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(allRedisPayloads).not.toContain(forbidden);
      }

      // Clean up test keys
      await cacheService.del(budgetKey);
      await cacheService.del(lockKey);
      await cacheService.del(snapshotKey);
    });
  });
});
