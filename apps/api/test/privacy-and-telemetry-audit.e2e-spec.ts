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
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  CHAT_HANDOFF_OBSERVABILITY_CONTRACT,
  createChatTelemetryEvent,
} from '@/common/observability/chat-observability';

const FORBIDDEN_PRIVACY_CORPUS = [
  'PNR-XYZ123',
  'PNR-778899',
  'chk_handoff_v1_secret',
  'chk_handoff_v1_secret_credential_12345',
  'Plaintext sensitive customer conversation between Alice and Bob',
  'PASS-123456',
  'P12345678',
  '4111222233334444',
  '4111111111111111',
  'customer.secret@example.com',
  'traveller.john@example.test',
  'duffel-private-offer-id-999',
  'duffel-secret-offer-xyz',
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

describe('Privacy Corpus & Structured Telemetry Audit (e2e)', () => {
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

    // Spy on logger outputs to capture any emitted JSON telemetry or warning/error logs
    const mockLogger = {
      log: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
      warn: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
      error: jest.fn((msg: string) => capturedTelemetryLogs.push(String(msg))),
    };
    // Cast services to access internal logger property for test assertion capture
    (handoffService as unknown as { logger: typeof mockLogger }).logger = mockLogger;
    (intentService as unknown as { logger: typeof mockLogger }).logger = mockLogger;
    (readinessObservability as unknown as { logger: typeof mockLogger }).logger = mockLogger;

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `${runMarker}@privacy-audit.test`,
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

  describe('PostgreSQL Schema & Zero Plaintext Verification', () => {
    it('verifies that chat_messages table contains ZERO plaintext content columns', async () => {
      const messageContentCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_messages' AND column_name = 'content';
      `;
      expect(messageContentCols.length).toBe(0);
    });

    it('verifies that chat_sessions table contains ZERO plaintext title columns', async () => {
      const sessionTitleCols: Array<{ column_name: string }> = await prisma.$queryRaw`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'chat_sessions' AND column_name = 'title';
      `;
      expect(sessionTitleCols.length).toBe(0);
    });

    it('stores ChatMessages strictly with record-bound contentCiphertext and zero raw plaintext in DB rows', async () => {
      const SECRET_MESSAGE =
        'Plaintext sensitive customer conversation between Alice and Bob with passport PASS-123456';
      const SECRET_TITLE = 'Trip to Danang PNR-XYZ123';

      const session = await chatService.createSession(testUserId, SECRET_TITLE);
      expect(session.title).toBe(SECRET_TITLE);

      const message = await chatService.createMessage(testUserId, session.id, {
        sender: 'USER',
        content: SECRET_MESSAGE,
      });
      expect(message.content).toBe(SECRET_MESSAGE);

      // Raw SQL query directly on PostgreSQL
      const rawRows: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_messages" WHERE "id" = ${message.id}::text;
      `;
      expect(rawRows.length).toBe(1);
      const rawRow = rawRows[0];

      // Must NOT have 'content' column
      expect(rawRow.content).toBeUndefined();
      // Must have envelope fields
      expect(rawRow.contentCiphertext).toBeDefined();
      expect(typeof rawRow.contentCiphertext).toBe('string');
      expect(rawRow.contentNonce).toBeDefined();
      expect(rawRow.contentAuthTag).toBeDefined();
      expect(rawRow.contentKeyVersion).toBe(1);

      // Raw SQL query on session
      const rawSessions: Array<Record<string, unknown>> = await prisma.$queryRaw`
        SELECT * FROM "chat_sessions" WHERE "id" = ${session.id}::text;
      `;
      expect(rawSessions.length).toBe(1);
      const rawSession = rawSessions[0];
      expect(rawSession.title).toBeUndefined();
      expect(rawSession.titleCiphertext).toBeDefined();
      expect(rawSession.titleNonce).toBeDefined();
      expect(rawSession.titleAuthTag).toBeDefined();

      // Zero-plaintext verification across the raw DB record strings
      const rawRowString = JSON.stringify(rawRow);
      const rawSessionString = JSON.stringify(rawSession);
      expect(rawRowString).not.toContain('Plaintext sensitive customer conversation');
      expect(rawRowString).not.toContain('PASS-123456');
      expect(rawSessionString).not.toContain('PNR-XYZ123');
      expect(rawSessionString).not.toContain('Trip to Danang');
    });
  });

  describe('Structured JSON Telemetry & Audit Logs Contract', () => {
    it('verifies structured telemetry event schemas enforce traceId, correlationId, operation, latencyMs, and status', () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      const telemetryEvent = createChatTelemetryEvent(
        'handoff_create',
        'created',
        45.8,
        { traceId, correlationId },
        { outcome: 'created' },
      );

      // Verify all required fields
      expect(telemetryEvent).toHaveProperty('trace_id', traceId);
      expect(telemetryEvent).toHaveProperty('correlation_id', correlationId);
      expect(telemetryEvent).toHaveProperty('operation', 'handoff_create');
      expect(telemetryEvent).toHaveProperty('latency_ms', 46);
      expect(telemetryEvent).toHaveProperty('status', 'created');
      expect(telemetryEvent).toHaveProperty('metric', 'handoff_tokens_issued_total');
      expect(telemetryEvent.metadata).toEqual({ outcome: 'created' });
    });

    it('verifies structured booking readiness telemetry logs contain all required fields', () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      const logSpy = jest
        .spyOn(readinessObservability['logger'], 'error')
        .mockImplementation(() => {});

      readinessObservability.recordOutcome({
        status: 'advisory_error',
        latencyMs: 32.4,
        context: { traceId, correlationId },
        metadata: { outcome: 'error', blockingIssuesCount: 1 },
        error: true,
      });

      expect(logSpy).toHaveBeenCalled();
      const emittedLogJson = JSON.parse(logSpy.mock.calls.at(-1)![1]);
      expect(emittedLogJson).toMatchObject({
        service: 'api',
        trace_id: traceId,
        correlation_id: correlationId,
        status: 'advisory_error',
        latency_ms: 32,
      });
      logSpy.mockRestore();
    });

    it('verifies structured audit log entries in DB contain traceId, correlationId, operation/action, and metadata', async () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      // Execute handoff flow to generate real structured telemetry and DB audit log entries
      const session = await prisma.chatSession.create({ data: { userId: testUserId } });
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: `off_audit_${runMarker}`,
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
                    operating_carrier: { name: 'Audit Carrier' },
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
        [{ flightOfferId: offer.id, duffelOfferId: `off_audit_${runMarker}` }],
      );

      const claimToken = mintClaimToken(testUserId, Math.floor(Date.now() / 1000));

      const handoffRes = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimToken)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);

      const handoffToken = handoffRes.body.token;
      expect(handoffToken).toBeDefined();

      // Resolve handoff
      await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: handoffToken })
        .set('Authorization', `Bearer ${testUserToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      // Consume handoff via booking intent
      const duffelGetSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: `off_audit_${runMarker}`,
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
          handoffToken,
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

      // Query database audit logs
      const auditEntries = await prisma.auditLog.findMany({
        where: { userId: testUserId },
      });
      expect(auditEntries.length).toBeGreaterThan(0);

      for (const entry of auditEntries) {
        expect(entry.traceId).toBeDefined();
        expect(entry.correlationId).toBeDefined();
        expect(entry.action).toBeDefined();
        expect(entry.resourceType).toBeDefined();
        expect(entry.metadata).toBeDefined();
      }
    });
  });

  describe('Negative Privacy Audit & Forbidden Corpus Absence', () => {
    it('strictly rejects forbidden corpus from entering telemetry event emissions', () => {
      for (const forbiddenVal of FORBIDDEN_PRIVACY_CORPUS) {
        expect(() =>
          createChatTelemetryEvent(
            'handoff_resolve',
            'resolved',
            10,
            {},
            { outcome: forbiddenVal },
          ),
        ).toThrow('not safe to emit');
      }
    });

    it('ensures zero forbidden values appear in captured application logs, telemetry, or DB metadata', async () => {
      // 1. Check all captured application logs & telemetry strings
      const allLogsMerged = capturedTelemetryLogs.join(' ');
      for (const forbiddenVal of FORBIDDEN_PRIVACY_CORPUS) {
        expect(allLogsMerged).not.toContain(forbiddenVal);
      }

      // 2. Check all audit log metadata in the database for testUserId
      const dbAuditLogs = await prisma.auditLog.findMany({
        where: { userId: testUserId },
      });
      const serializedAuditLogs = JSON.stringify(dbAuditLogs);
      for (const forbiddenVal of FORBIDDEN_PRIVACY_CORPUS) {
        expect(serializedAuditLogs).not.toContain(forbiddenVal);
      }

      // 3. Check all chat sessions and messages stored for testUserId
      const dbSessions = await prisma.chatSession.findMany({
        where: { userId: testUserId },
        include: { messages: true },
      });
      const serializedChat = JSON.stringify(dbSessions);
      for (const forbiddenVal of FORBIDDEN_PRIVACY_CORPUS) {
        expect(serializedChat).not.toContain(forbiddenVal);
      }
    });
  });
});
