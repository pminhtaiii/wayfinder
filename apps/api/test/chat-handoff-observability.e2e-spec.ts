process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';
process.env.ATTESTATION_SECRET = 'test-attestation-secret';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AirportType, PassengerType, Prisma } from '@prisma/client';
import request from 'supertest';
import * as crypto from 'crypto';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { BookingIntentService } from '@/booking-intent/booking-intent.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  CHAT_HANDOFF_OBSERVABILITY_CONTRACT,
  createChatTelemetryEvent,
} from '@/common/observability/chat-observability';

const FORBIDDEN_TELEMETRY_VALUES = [
  'Sensitive customer message',
  'chk_handoff_v1_secret-token',
  'handoff-token-hash',
  'duffel-private-offer',
  'booking-db-id',
  'PNR-SECRET',
  'traveller@example.com',
  'passport-123',
  'payment-secret',
  'raw-tool-payload',
] as const;

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('chat handoff observability dashboard and alert contract', () => {
  jest.setTimeout(180_000);

  it('captures create, resolve, and canonical consume telemetry and audit records through public HTTP boundaries', async () => {
    const runMarker = `t097-${crypto.randomUUID()}`;
    const traceId = 'chat_0123456789abcdef0123456789abcdef';
    const correlationId = 'chat_fedcba9876543210fedcba9876543210';
    const log = jest.fn();
    let app: INestApplication | undefined;
    let prisma: PrismaService | undefined;
    let userId: string | undefined;

    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(ConfigService)
        .useValue({
          get: (key: string, defaultValue?: unknown): unknown => {
            if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
            if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
            if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
            if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
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
      const jwtService = moduleFixture.get(JwtService);
      const attestationService = moduleFixture.get(SelectionAttestationService);
      const duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
      const handoffService = moduleFixture.get(ChatHandoffService) as unknown as {
        logger: { log: jest.Mock; warn: jest.Mock };
      };
      const intentService = moduleFixture.get(BookingIntentService) as unknown as {
        logger: { log: jest.Mock; warn: jest.Mock };
      };
      handoffService.logger = { log, warn: jest.fn() };
      intentService.logger = { log, warn: jest.fn() };

      const user = await prisma!.user.create({
        data: { email: `${runMarker}@example.test`, password: 'Password123!', status: 'ACTIVE' },
      });
      userId = user.id;
      const userToken = jwtService.sign(
        { sub: user.id, id: user.id, jti: crypto.randomUUID(), email: user.email },
        { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
      );
      const session = await prisma!.chatSession.create({ data: { userId } });
      const offer = await prisma!.flightOffer.create({
        data: {
          searchHash: runMarker,
          supplierOfferId: `${runMarker}-offer`,
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          children: 0,
          infants: 0,
          price: new Prisma.Decimal(100),
          currency: 'USD',
          rawOffer: {
            expires_at: new Date(Date.now() + 900_000).toISOString(),
            passengers: [{ id: 'pas_observability', type: 'adult' }],
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                    arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                    operating_carrier: { name: 'Test Carrier' },
                  },
                ],
              },
            ],
          },
        },
      });
      for (const airport of [
        {
          iataCode: 'SGN',
          name: 'Test Origin',
          city: 'Test City',
          latitude: 10.8,
          longitude: 106.6,
        },
        {
          iataCode: 'HAN',
          name: 'Test Destination',
          city: 'Test City',
          latitude: 21.2,
          longitude: 105.8,
        },
      ]) {
        await prisma!.airport.upsert({
          where: { iataCode: airport.iataCode },
          update: {},
          create: { ...airport, country: 'VN', type: AirportType.MEDIUM_AIRPORT },
        });
      }
      const attestation = await attestationService.signSelectionAttestation(
        userId,
        session.id,
        1,
        new Date(Date.now() + 900_000).toISOString(),
        [{ flightOfferId: offer.id, duffelOfferId: `${runMarker}-offer` }],
      );
      const claimToken = mintClaimToken(userId, Math.floor(Date.now() / 1000));
      const create = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', process.env.AGENT_SERVICE_API_KEY!)
        .set('X-User-Claim', claimToken)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({ selectionAttestationHash: attestation, selectedOfferIndex: 1 })
        .expect(201);
      const handoffToken = create.body.token as string;

      await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .query({ token: handoffToken })
        .set('Authorization', `Bearer ${userToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);
      const duffelGet = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: `${runMarker}-offer`,
          total_amount: '100.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: 'pas_observability', type: 'adult' }],
        },
      } as never);
      await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${userToken}`)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .send({
          handoffToken,
          passengers: [
            {
              offerPassengerId: 'pas_observability',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Test',
                familyName: 'Passenger',
                dateOfBirth: '1990-01-01',
                gender: 'male',
                nationality: 'VN',
                email: 'traveller@example.test',
                phoneCountryCode: '+84',
                phoneNumber: '912345678',
                title: 'Mr',
              },
            },
          ],
        })
        .expect(201);
      expect(duffelGet).toHaveBeenCalledTimes(1);
      duffelGet.mockRestore();

      const expectedOperations = ['handoff_create', 'handoff_resolve', 'handoff_consume'];
      await new Promise((resolve) => setTimeout(resolve, 0));
      const events = log.mock.calls
        .map(([entry]) => (typeof entry === 'string' ? JSON.parse(entry) : null))
        .filter(
          (entry): entry is Record<string, unknown> =>
            entry !== null && expectedOperations.includes(String(entry.operation)),
        );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'handoff_create',
            metric: 'handoff_tokens_issued_total',
            status: 'created',
            metadata: { outcome: 'created' },
            trace_id: traceId,
            correlation_id: correlationId,
          }),
          expect.objectContaining({
            operation: 'handoff_resolve',
            metric: 'handoff_tokens_resolved_total',
            status: 'resolved',
            metadata: { outcome: 'resolved' },
            trace_id: traceId,
            correlation_id: correlationId,
          }),
          expect.objectContaining({
            operation: 'handoff_consume',
            metric: 'handoff_tokens_consumed_total',
            status: 'created',
            metadata: { outcome: 'consumed', price_changed: false },
            trace_id: traceId,
            correlation_id: correlationId,
          }),
        ]),
      );
      const auditLogs = await prisma!.auditLog.findMany({
        where: {
          userId,
          action: {
            in: ['chat_handoff_created', 'chat_handoff_resolved', 'chat_handoff_consumed'],
          },
        },
      });

      // Canonical intent creation resolves the handoff again before it claims it,
      // so the public resolve plus the canonical consume produce two resolves.
      expect(auditLogs).toHaveLength(4);
      expect(auditLogs.map((entry) => entry.metadata)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'handoff_create',
            metric: 'handoff_tokens_issued_total',
            status: 'created',
            outcome: 'created',
            traceId,
            correlationId,
          }),
          expect.objectContaining({
            operation: 'handoff_resolve',
            metric: 'handoff_tokens_resolved_total',
            status: 'resolved',
            outcome: 'resolved',
            traceId,
            correlationId,
          }),
          expect.objectContaining({
            operation: 'handoff_consume',
            metric: 'handoff_tokens_consumed_total',
            status: 'created',
            outcome: 'consumed',
            price_changed: false,
            traceId,
            correlationId,
          }),
        ]),
      );

      const serializedTelemetry = JSON.stringify({ events, auditLogs });
      for (const value of FORBIDDEN_TELEMETRY_VALUES) {
        expect(serializedTelemetry).not.toContain(value);
      }
    } finally {
      if (prisma && userId) {
        await prisma.auditLog.deleteMany({ where: { userId } });
        await prisma.chatHandoff.deleteMany({ where: { userId } });
        await prisma.bookingIntentPassenger.deleteMany({ where: { intent: { userId } } });
        await prisma.bookingIntent.deleteMany({ where: { userId } });
        await prisma.chatSession.deleteMany({ where: { userId } });
        await prisma.flightOffer.deleteMany({ where: { searchHash: runMarker } });
        await prisma.user.deleteMany({ where: { id: userId } });
      }
      await app?.close();
    }
  });

  it('rejects the protected privacy corpus before it can enter an emitted event', () => {
    for (const protectedValue of FORBIDDEN_TELEMETRY_VALUES) {
      expect(() =>
        createChatTelemetryEvent(
          'handoff_resolve',
          'resolved',
          42,
          {},
          { outcome: protectedValue },
        ),
      ).toThrow('not safe to emit');
    }
  });

  it('records the API-owned gaps and required alert thresholds without claiming the gaps are emitted', () => {
    expect(CHAT_HANDOFF_OBSERVABILITY_CONTRACT.requiredButNotEmittedByApi).toEqual(
      expect.arrayContaining([
        'redis_latency',
        'quota_daily_utilization_bucket',
        'active_streams',
        'router_disambiguations',
        'snapshot_replace',
        'snapshot_expire',
        'handoff_foreign_owner',
        'handoff_expired',
        'handoff_stale',
        'time_to_first_safe_token',
      ]),
    );
    expect(CHAT_HANDOFF_OBSERVABILITY_CONTRACT.alerts).toEqual(
      expect.arrayContaining([
        { panel: 'redis_health', condition: 'operator_configured' },
        { panel: 'quota_bypass_invariant', condition: 'operator_configured' },
        {
          panel: 'error_rate',
          condition: 'above_baseline_multiple',
          baselineMultiple: 2,
          forSeconds: 300,
        },
        { panel: 'router_malformed_output', condition: 'operator_configured' },
        { panel: 'handoff_cross_owner', condition: 'operator_configured' },
        { panel: 'token_integrity_or_privacy_corpus', condition: 'operator_configured' },
        {
          panel: 'handoff_resolve_consume_latency',
          condition: 'p95_above_ms',
          thresholdMs: 300,
        },
        { panel: 'time_to_first_safe_token', condition: 'operator_configured' },
      ]),
    );
  });
});
