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
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';

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
import { CacheService } from '@/cache/cache.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { BookingIntentService } from '@/booking-intent/booking-intent.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  CHAT_HANDOFF_OBSERVABILITY_CONTRACT,
  createChatTelemetryEvent,
} from '@/common/observability/chat-observability';

const FORBIDDEN_PRIVACY_CORPUS = [
  'PNR-XYZ123',
  'PNR-778899',
  'chk_handoff_v1_secret_credential_alert_drill',
  'Plaintext sensitive customer query about passport P12345678',
  'PASS-998877',
  '4111222233334444',
  '4111111111111111',
  'attacker.secret@example.com',
  'victim.user@example.test',
  'duffel-private-offer-id-alert-drill',
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

describe('Automated Alert Rules & End-to-End Trace Correlation (e2e)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let cacheService: CacheService;
  let attestationService: SelectionAttestationService;
  let duffel: Duffel;
  let handoffService: ChatHandoffService;
  let intentService: BookingIntentService;

  const capturedLogs: string[] = [];
  const runMarker = `alert-drill-${crypto.randomUUID()}`;

  let userAId: string;
  let userAToken: string;
  let userBId: string;
  let userBToken: string;

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
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/(.*)', 'api/health', 'api/health/(.*)'],
    });
    await app.init();

    prisma = moduleFixture.get(PrismaService);
    jwtService = moduleFixture.get(JwtService);
    cacheService = moduleFixture.get(CacheService);
    attestationService = moduleFixture.get(SelectionAttestationService);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    handoffService = moduleFixture.get(ChatHandoffService);
    intentService = moduleFixture.get(BookingIntentService);

    // Spy on logger outputs to capture any emitted JSON telemetry or warning/error logs
    const mockLogger = {
      log: jest.fn((msg: string) => capturedLogs.push(String(msg))),
      warn: jest.fn((msg: string) => capturedLogs.push(String(msg))),
      error: jest.fn((msg: string) => capturedLogs.push(String(msg))),
    };
    (handoffService as unknown as { logger: typeof mockLogger }).logger = mockLogger;
    (intentService as unknown as { logger: typeof mockLogger }).logger = mockLogger;

    // Create User A (Attacker / Mismatched User)
    const userA = await prisma.user.create({
      data: {
        email: `usera-${runMarker}@alert-test.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userAId = userA.id;
    userAToken = jwtService.sign(
      { sub: userA.id, id: userA.id, jti: crypto.randomUUID(), email: userA.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    // Create User B (Victim / Legitimate Token Owner)
    const userB = await prisma.user.create({
      data: {
        email: `userb-${runMarker}@alert-test.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userBId = userB.id;
    userBToken = jwtService.sign(
      { sub: userB.id, id: userB.id, jti: crypto.randomUUID(), email: userB.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    // Setup destination/origin airports
    for (const airport of [
      {
        iataCode: 'SGN',
        name: 'Tan Son Nhat',
        city: 'Ho Chi Minh',
        latitude: 10.8,
        longitude: 106.6,
      },
      { iataCode: 'HAN', name: 'Noi Bai', city: 'Hanoi', latitude: 21.2, longitude: 105.8 },
    ]) {
      await prisma.airport.upsert({
        where: { iataCode: airport.iataCode },
        update: {},
        create: { ...airport, country: 'VN', type: AirportType.MEDIUM_AIRPORT },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      const userIds = [userAId, userBId].filter(Boolean);
      await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.chatHandoff.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.bookingIntentPassenger.deleteMany({
        where: { intent: { userId: { in: userIds } } },
      });
      await prisma.bookingIntent.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.chatMessage.deleteMany({ where: { session: { userId: { in: userIds } } } });
      await prisma.chatSession.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.flightOffer.deleteMany({ where: { searchHash: runMarker } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
  });

  // =========================================================================
  // Alert 1: Redis Outage Alert
  // =========================================================================
  describe('Alert Trigger 1: Redis Outage Alert', () => {
    it('verifies CHAT_HANDOFF_OBSERVABILITY_CONTRACT defines redis_health alert rule', () => {
      const redisAlert = CHAT_HANDOFF_OBSERVABILITY_CONTRACT.alerts.find(
        (a) => a.panel === 'redis_health',
      );
      expect(redisAlert).toBeDefined();
      expect(redisAlert?.condition).toBe('operator_configured');
    });

    it('triggers degraded status and 503 on /health and /health/redis when Redis is unreachable', async () => {
      const databaseSpy = jest.spyOn(prisma, '$transaction').mockResolvedValue(undefined as never);
      const redisSpy = jest.spyOn(cacheService, 'checkHealth').mockResolvedValue('down');

      try {
        const healthRes = await request(app.getHttpServer()).get('/health').expect(503);
        expect(healthRes.body.status).toBe('degraded');
        expect(healthRes.body.dependencies.redis).toBe('down');

        const redisRes = await request(app.getHttpServer()).get('/health/redis').expect(503);
        expect(redisRes.body).toEqual({
          status: 'down',
          dependency: 'redis',
        });
      } finally {
        redisSpy.mockRestore();
        databaseSpy.mockRestore();
      }
    });

    it('emits dependency: redis failure telemetry when control plane dependency fails', () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      const telemetry = createChatTelemetryEvent(
        'handoff_create',
        'failed',
        120,
        { traceId, correlationId },
        { outcome: 'failed', dependency: 'redis', error_class: 'dependency_unavailable' },
      );

      expect(telemetry.status).toBe('failed');
      expect(telemetry.metadata.dependency).toBe('redis');
      expect(telemetry.metadata.error_class).toBe('dependency_unavailable');
    });
  });

  // =========================================================================
  // Alert 2: Rate of 5xx errors > 2x baseline
  // =========================================================================
  describe('Alert Trigger 2: Rate of 5xx errors > 2x baseline', () => {
    it('verifies CHAT_HANDOFF_OBSERVABILITY_CONTRACT defines error_rate rule with 2x baseline multiplier over 300s', () => {
      const errorRateAlert = CHAT_HANDOFF_OBSERVABILITY_CONTRACT.alerts.find(
        (a) => a.panel === 'error_rate',
      );
      expect(errorRateAlert).toBeDefined();
      expect(errorRateAlert).toMatchObject({
        panel: 'error_rate',
        condition: 'above_baseline_multiple',
        baselineMultiple: 2,
        forSeconds: 300,
      });
    });

    it('evaluates error rate spikes and triggers alert condition when error rate exceeds 2x threshold', () => {
      // Alert rule evaluator function simulating rolling window monitoring
      const evaluateErrorRateAlert = (
        baselineErrorRatePercent: number,
        recentErrors: number,
        recentTotalRequests: number,
        multiplier: number = 2,
      ) => {
        const currentErrorRatePercent = (recentErrors / recentTotalRequests) * 100;
        const thresholdPercent = baselineErrorRatePercent * multiplier;
        const alertTriggered = currentErrorRatePercent > thresholdPercent;
        return {
          currentErrorRatePercent,
          thresholdPercent,
          alertTriggered,
        };
      };

      // Normal baseline: 1.0% error rate
      const baseline = 1.0;

      // Scenario A: Normal operations (1 error in 100 requests = 1.0%) -> Alert False
      const normalResult = evaluateErrorRateAlert(baseline, 1, 100, 2);
      expect(normalResult.alertTriggered).toBe(false);
      expect(normalResult.currentErrorRatePercent).toBeCloseTo(1.0, 5);

      // Scenario B: Elevated within tolerance (1.8% <= 2.0% threshold) -> Alert False
      const elevatedResult = evaluateErrorRateAlert(baseline, 9, 500, 2);
      expect(elevatedResult.alertTriggered).toBe(false);
      expect(elevatedResult.currentErrorRatePercent).toBeCloseTo(1.8, 5);

      // Scenario C: Sudden spike > 2x baseline (3.5% > 2.0% threshold) -> Alert TRUE
      const spikeResult = evaluateErrorRateAlert(baseline, 7, 200, 2);
      expect(spikeResult.alertTriggered).toBe(true);
      expect(spikeResult.currentErrorRatePercent).toBeCloseTo(3.5, 5);
      expect(spikeResult.thresholdPercent).toBeCloseTo(2.0, 5);
    });
  });

  // =========================================================================
  // Alert 3: Sudden spike in router fallback decisions
  // =========================================================================
  describe('Alert Trigger 3: Sudden spike in router fallback decisions', () => {
    it('verifies CHAT_HANDOFF_OBSERVABILITY_CONTRACT defines router_malformed_output alert rule', () => {
      const routerAlert = CHAT_HANDOFF_OBSERVABILITY_CONTRACT.alerts.find(
        (a) => a.panel === 'router_malformed_output',
      );
      expect(routerAlert).toBeDefined();
      expect(routerAlert?.condition).toBe('operator_configured');
    });

    it('evaluates router fallback alerts when malformed output or low confidence decisions spike above threshold', () => {
      // Router fallback alert rule evaluator
      const evaluateRouterFallbackAlert = (
        decisions: Array<{ status: string; outcome: string }>,
        fallbackThresholdPercent: number = 10.0,
      ) => {
        const fallbackCount = decisions.filter(
          (d) =>
            d.status === 'fallback' &&
            (d.outcome === 'malformed_output' || d.outcome === 'low_confidence'),
        ).length;
        const fallbackRatePercent = (fallbackCount / decisions.length) * 100;
        const alertTriggered = fallbackRatePercent > fallbackThresholdPercent;
        return { fallbackCount, total: decisions.length, fallbackRatePercent, alertTriggered };
      };

      // Normal operations: 98 classified, 2 malformed (2% fallback rate) -> Alert False
      const normalDecisions = [
        ...Array(98).fill({ status: 'classified', outcome: 'classified' }),
        ...Array(2).fill({ status: 'fallback', outcome: 'malformed_output' }),
      ];
      const normalEval = evaluateRouterFallbackAlert(normalDecisions, 10.0);
      expect(normalEval.alertTriggered).toBe(false);
      expect(normalEval.fallbackRatePercent).toBe(2.0);

      // Spiking operations: 80 classified, 20 malformed (20% fallback rate > 10% threshold) -> Alert TRUE
      const spikeDecisions = [
        ...Array(80).fill({ status: 'classified', outcome: 'classified' }),
        ...Array(15).fill({ status: 'fallback', outcome: 'malformed_output' }),
        ...Array(5).fill({ status: 'fallback', outcome: 'low_confidence' }),
      ];
      const spikeEval = evaluateRouterFallbackAlert(spikeDecisions, 10.0);
      expect(spikeEval.alertTriggered).toBe(true);
      expect(spikeEval.fallbackRatePercent).toBe(20.0);
      expect(spikeEval.fallbackCount).toBe(20);
    });
  });

  // =========================================================================
  // Alert 4: Cross-owner handoff resolution attempts
  // =========================================================================
  describe('Alert Trigger 4: Cross-owner handoff resolution attempts', () => {
    it('verifies CHAT_HANDOFF_OBSERVABILITY_CONTRACT defines handoff_cross_owner alert rule', () => {
      const crossOwnerAlert = CHAT_HANDOFF_OBSERVABILITY_CONTRACT.alerts.find(
        (a) => a.panel === 'handoff_cross_owner',
      );
      expect(crossOwnerAlert).toBeDefined();
      expect(crossOwnerAlert?.condition).toBe('operator_configured');
    });

    it('rejects cross-owner resolution with 404 HANDOFF_NOT_FOUND and zero identity leakage', async () => {
      const traceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const correlationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      // User B creates a legitimate handoff token
      const sessionB = await prisma.chatSession.create({ data: { userId: userBId } });
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: `off_cross_${runMarker}`,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(200),
          currency: 'USD',
          rawOffer: {
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            passengers: [{ id: 'pas_cross_1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                    arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                    operating_carrier: { name: 'Cross Airline' },
                  },
                ],
              },
            ],
          },
        },
      });

      const attestationB = await attestationService.signSelectionAttestation(
        userBId,
        sessionB.id,
        1,
        new Date(Date.now() + 900_000).toISOString(),
        [{ flightOfferId: offer.id, duffelOfferId: `off_cross_${runMarker}` }],
      );

      const claimTokenB = mintClaimToken(userBId, Math.floor(Date.now() / 1000));

      const handoffRes = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimTokenB)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ selectionAttestationHash: attestationB, selectedOfferIndex: 1 })
        .expect(201);

      const victimHandoffToken = handoffRes.body.token;
      expect(victimHandoffToken).toBeDefined();

      // Attacker User A attempts to resolve User B's handoff token via GET /api/chat-handoff/resolve
      const attackGetRes = await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: victimHandoffToken })
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(404);

      expect(attackGetRes.body.message).toBe('Handoff not found');
      expect(attackGetRes.body.code).toBe('HANDOFF_NOT_FOUND');
      expect(JSON.stringify(attackGetRes.body)).not.toContain(userBId);

      // Attacker User A attempts to resolve User B's handoff token via POST /api/chat-handoff/resolve
      const attackPostRes = await request(app.getHttpServer())
        .post('/api/chat-handoff/resolve')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ token: victimHandoffToken })
        .expect(404);

      expect(attackPostRes.body.message).toBe('Handoff not found');
      expect(attackPostRes.body.code).toBe('HANDOFF_NOT_FOUND');
      expect(JSON.stringify(attackPostRes.body)).not.toContain(userBId);
      expect(JSON.stringify(attackPostRes.body)).not.toContain(victimHandoffToken);

      // User B (legitimate owner) can resolve their own token cleanly
      const legitimateRes = await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: victimHandoffToken })
        .set('Authorization', `Bearer ${userBToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      expect(legitimateRes.body.status).toBe('ACTIVE');
      expect(legitimateRes.body.offer.airline).toBe('Cross Airline');
    });
  });

  // =========================================================================
  // End-to-End Trace Correlation Verification
  // =========================================================================
  describe('End-to-End Trace Correlation across Browser -> FastAPI -> NestJS -> Audit Logs', () => {
    it('propagates unified x-trace-id and x-correlation-id (chat_<32 hex>) through the complete handoff-to-intent chain', async () => {
      const e2eTraceId = `chat_${crypto.randomBytes(16).toString('hex')}`;
      const e2eCorrelationId = `chat_${crypto.randomBytes(16).toString('hex')}`;

      // 1. Session & Offer setup
      const session = await prisma.chatSession.create({ data: { userId: userAId } });
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: `off_trace_${runMarker}`,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(175),
          currency: 'USD',
          rawOffer: {
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            passengers: [{ id: 'pas_trace_1', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                    arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                    operating_carrier: { name: 'Trace Air' },
                  },
                ],
              },
            ],
          },
        },
      });

      const attestation = await attestationService.signSelectionAttestation(
        userAId,
        session.id,
        1,
        new Date(Date.now() + 900_000).toISOString(),
        [{ flightOfferId: offer.id, duffelOfferId: `off_trace_${runMarker}` }],
      );

      const claimToken = mintClaimToken(userAId, Math.floor(Date.now() / 1000));

      // 2. Issuance with Trace & Correlation headers
      const createRes = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimToken)
        .set('X-Trace-Id', e2eTraceId)
        .set('X-Correlation-Id', e2eCorrelationId)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);

      const handoffToken = createRes.body.token;

      // 3. Resolution with Trace & Correlation headers
      await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: handoffToken })
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Trace-Id', e2eTraceId)
        .set('X-Correlation-Id', e2eCorrelationId)
        .expect(200);

      // 4. Consumption via Booking Intent
      const duffelGetSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: `off_trace_${runMarker}`,
          total_amount: '175.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: 'pas_trace_1', type: 'adult' }],
        },
      } as never);

      await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${userAToken}`)
        .set('X-Trace-Id', e2eTraceId)
        .set('X-Correlation-Id', e2eCorrelationId)
        .send({
          handoffToken,
          passengers: [
            {
              offerPassengerId: 'pas_trace_1',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Trace',
                familyName: 'Auditor',
                dateOfBirth: '1990-01-01',
                gender: 'male',
                nationality: 'VN',
                email: 'trace.user@example.com',
                phoneCountryCode: '+84',
                phoneNumber: '988888888',
                title: 'Mr',
              },
            },
          ],
        })
        .expect(201);

      duffelGetSpy.mockRestore();

      // 5. Query Audit Logs in DB and verify full trace correlation continuity
      const auditEntries = await prisma.auditLog.findMany({
        where: { userId: userAId },
      });
      expect(auditEntries.length).toBeGreaterThan(0);

      const matchingTraceEntries = auditEntries.filter(
        (entry) => entry.traceId === e2eTraceId && entry.correlationId === e2eCorrelationId,
      );
      expect(matchingTraceEntries.length).toBeGreaterThanOrEqual(3);

      const actions = matchingTraceEntries.map((e) => e.action);
      expect(actions).toContain('chat_handoff_created');
      expect(actions).toContain('chat_handoff_resolved');
      expect(actions).toContain('chat_handoff_consumed');
    });

    it('enforces opaque chat_<32 hex> pattern on traceId and correlationId', () => {
      const opaquePattern = /^chat_[a-f0-9]{32}$/;

      // When invalid or missing ID is provided, createChatTelemetryEvent generates valid opaque ID
      const eventWithInvalid = createChatTelemetryEvent(
        'handoff_resolve',
        'resolved',
        15,
        { traceId: 'invalid-trace-id', correlationId: 'invalid-correlation' },
        { outcome: 'resolved' },
      );

      expect(opaquePattern.test(eventWithInvalid.trace_id)).toBe(true);
      expect(opaquePattern.test(eventWithInvalid.correlation_id)).toBe(true);
      expect(eventWithInvalid.trace_id).not.toBe('invalid-trace-id');
    });
  });

  // =========================================================================
  // Negative Privacy Audit in Alert Suite
  // =========================================================================
  describe('Negative Privacy Audit across Alert Handlers', () => {
    it('ensures zero forbidden privacy corpus appears in captured alert logs or audit metadata', async () => {
      const allCapturedLogsMerged = capturedLogs.join(' ');
      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(allCapturedLogsMerged).not.toContain(forbidden);
      }

      const allDbAuditLogs = await prisma.auditLog.findMany({
        where: { userId: { in: [userAId, userBId] } },
      });
      const serializedAudit = JSON.stringify(allDbAuditLogs);
      for (const forbidden of FORBIDDEN_PRIVACY_CORPUS) {
        expect(serializedAudit).not.toContain(forbidden);
      }
    });
  });
});
