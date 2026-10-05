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
import * as http from 'http';
import * as crypto from 'crypto';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { StripeService } from '@/common/stripe.service';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { JwtStrategy } from '@/auth/strategies/jwt.strategy';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';

const SAMPLE_COUNT = 100;
const HANDOFF_P95_LIMIT_MS = 300;
const RUN_MARKER = `t098-${crypto.randomUUID()}`;
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: SAMPLE_COUNT,
  maxFreeSockets: SAMPLE_COUNT,
  timeout: 120_000,
});

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

type BenchmarkSummary = {
  utcDate: string;
  environment: 'test_db';
  handoffCreate: { count: number; p95Ms: number | null; failures: number };
  handoffResolve: { count: number; p95Ms: number | null; failures: number };
  consumeConcurrency: {
    count: number;
    p95Ms: number | null;
    supplierWinners: number;
    intentCount: number;
    expectedLosers: number;
    failures: number;
    authP95Ms: number | null;
    claimP95Ms: number | null;
  };
};

function percentile95(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * 0.95) - 1];
}

let baseUrl = '';

function getJson(url: string, agent: http.Agent): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        agent,
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          resolve({ status: res.statusCode || 500 });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postJson(
  target: string | { hostname: string; port: number | string; path: string },
  body: any,
  headers: Record<string, string>,
  agent: http.Agent,
  bodyLength?: number,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const length = bodyLength ?? Buffer.byteLength(data);
    let hostname: string;
    let port: number | string;
    let path: string;

    if (typeof target === 'string') {
      const parsed = new URL(target);
      hostname = parsed.hostname;
      port = parsed.port;
      path = parsed.pathname;
    } else {
      hostname = target.hostname;
      port = target.port;
      path = target.path;
    }

    const req = http.request(
      {
        hostname,
        port,
        path,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': length,
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsedBody = null;
          try {
            parsedBody = raw ? JSON.parse(raw) : null;
          } catch {}
          resolve({ status: res.statusCode || 500, body: parsedBody });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('Chat handoff performance (E2E)', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let duffel: Duffel;
  let stripeService: StripeService;
  let attestationService: SelectionAttestationService;
  let jwtStrategy: JwtStrategy;
  let chatHandoffService: ChatHandoffService;
  let userId: string;
  let userToken: string;
  let chatSessionId: string;
  let flightOfferId: string;
  let createdTokens: string[] = [];
  let summary: BenchmarkSummary = {
    utcDate: new Date().toISOString().slice(0, 10),
    environment: 'test_db',
    handoffCreate: { count: 0, p95Ms: null, failures: 0 },
    handoffResolve: { count: 0, p95Ms: null, failures: 0 },
    consumeConcurrency: {
      count: 0,
      p95Ms: null,
      supplierWinners: 0,
      intentCount: 0,
      expectedLosers: 0,
      failures: 0,
      authP95Ms: null,
      claimP95Ms: null,
    },
  };

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
    await app.listen(0);

    const server = app.getHttpServer();
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 3001;
    baseUrl = `http://127.0.0.1:${port}`;

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    stripeService = moduleFixture.get<StripeService>(StripeService);
    attestationService = moduleFixture.get<SelectionAttestationService>(
      SelectionAttestationService,
    );
    jwtStrategy = moduleFixture.get<JwtStrategy>(JwtStrategy);
    chatHandoffService = moduleFixture.get<ChatHandoffService>(ChatHandoffService);

    const user = await prisma.user.create({
      data: {
        email: `${RUN_MARKER}@example.test`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userId = user.id;
    userToken = jwtService.sign(
      { sub: user.id, id: user.id, jti: crypto.randomUUID(), email: user.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    const session = await prisma.chatSession.create({
      data: { userId },
    });
    chatSessionId = session.id;

    const offer = await prisma.flightOffer.create({
      data: {
        searchHash: RUN_MARKER,
        supplierOfferId: `${RUN_MARKER}-offer`,
        rawOffer: {
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: 'pas_benchmark', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                  arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                  operating_carrier: { name: 'Benchmark Carrier' },
                },
              ],
            },
          ],
        },
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date(Date.now() + 86_400_000),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100),
        currency: 'USD',
      },
    });
    flightOfferId = offer.id;

    await prisma.airport.upsert({
      where: { iataCode: 'SGN' },
      update: {},
      create: {
        iataCode: 'SGN',
        name: 'Benchmark Origin',
        city: 'Benchmark City',
        country: 'VN',
        latitude: 10.8,
        longitude: 106.6,
        type: AirportType.MEDIUM_AIRPORT,
      },
    });
    await prisma.airport.upsert({
      where: { iataCode: 'HAN' },
      update: {},
      create: {
        iataCode: 'HAN',
        name: 'Benchmark Destination',
        city: 'Benchmark City',
        country: 'VN',
        latitude: 21.2,
        longitude: 105.8,
        type: AirportType.MEDIUM_AIRPORT,
      },
    });

    // Pre-warm Prisma raw query engine and database connections
    await prisma.$queryRaw`SELECT 1`;

    // Pre-warm keep-alive HTTP connection pool
    await Promise.all(
      Array.from({ length: SAMPLE_COUNT }, () => getJson(`${baseUrl}/health/ping`, httpAgent)),
    );
  });

  afterAll(async () => {
    console.info(`T098_BENCHMARK_SUMMARY ${JSON.stringify(summary)}`);

    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.chatHandoff.deleteMany({ where: { userId } });
    await prisma.bookingIntentPassenger.deleteMany({ where: { intent: { userId } } });
    await prisma.bookingIntent.deleteMany({ where: { userId } });
    await prisma.chatSession.deleteMany({ where: { userId } });
    await prisma.flightOffer.deleteMany({ where: { searchHash: RUN_MARKER } });
    await prisma.user.deleteMany({ where: { id: userId } });
    httpAgent.destroy();
    await app.close();
  });

  async function createHandoff(
    version: number,
    onTiming?: (elapsed: number) => void,
  ): Promise<string> {
    const attestation = await attestationService.signSelectionAttestation(
      userId,
      chatSessionId,
      version,
      new Date(Date.now() + 900_000).toISOString(),
      [{ flightOfferId, duffelOfferId: `${RUN_MARKER}-offer` }],
    );
    const claimToken = mintClaimToken(userId, Math.floor(Date.now() / 1000));
    const startedAt = performance.now();
    const response = await postJson(
      `${baseUrl}/api/chat-handoff/tokens`,
      { selectionAttestationHash: attestation, selectedOfferIndex: 1 },
      {
        'X-Agent-API-Key': process.env.AGENT_SERVICE_API_KEY!,
        'X-User-Claim': claimToken,
      },
      httpAgent,
    );
    const elapsed = performance.now() - startedAt;
    if (onTiming) onTiming(elapsed);

    expect(response.status).toBe(201);
    return response.body.token as string;
  }

  it('keeps 100 public handoff creates and resolves below the p95 limit without supplier calls', async () => {
    const duffelGet = jest.spyOn(duffel.offers, 'get');
    const paymentCreate = jest.spyOn(stripeService, 'createPaymentIntent');

    // Warm-up is intentionally excluded from all measured samples.
    for (let w = 1; w <= 5; w += 1) {
      const warmupToken = await createHandoff(1000 + w);
      const warmupRes = await postJson(
        `${baseUrl}/api/chat-handoff/resolve`,
        { handoffToken: warmupToken },
        { Authorization: `Bearer ${userToken}` },
        httpAgent,
      );
      expect(warmupRes.status).toBe(200);
    }
    duffelGet.mockClear();
    paymentCreate.mockClear();

    const createSamples: number[] = [];
    const resolveSamples: number[] = [];
    const createFailures: number[] = [];
    const resolveFailures: number[] = [];

    for (let index = 2; index <= SAMPLE_COUNT + 1; index += 1) {
      try {
        createdTokens.push(await createHandoff(index, (elapsed) => createSamples.push(elapsed)));
      } catch {
        createFailures.push(index);
      }
    }

    for (const handoffToken of createdTokens) {
      const startedAt = performance.now();
      const response = await postJson(
        `${baseUrl}/api/chat-handoff/resolve`,
        { handoffToken },
        { Authorization: `Bearer ${userToken}` },
        httpAgent,
      );
      resolveSamples.push(performance.now() - startedAt);
      if (response.status !== 200) resolveFailures.push(response.status);
    }

    summary = {
      ...summary,
      handoffCreate: {
        count: createSamples.length,
        p95Ms: percentile95(createSamples),
        failures: createFailures.length,
      },
      handoffResolve: {
        count: resolveSamples.length,
        p95Ms: percentile95(resolveSamples),
        failures: resolveFailures.length,
      },
    };

    expect(createFailures).toHaveLength(0);
    expect(resolveFailures).toHaveLength(0);
    expect(createSamples).toHaveLength(SAMPLE_COUNT);
    expect(resolveSamples).toHaveLength(SAMPLE_COUNT);
    expect(percentile95(createSamples)).toBeLessThan(HANDOFF_P95_LIMIT_MS);
    expect(percentile95(resolveSamples)).toBeLessThan(HANDOFF_P95_LIMIT_MS);
    expect(duffelGet).not.toHaveBeenCalled();
    expect(paymentCreate).not.toHaveBeenCalled();

    duffelGet.mockRestore();
    paymentCreate.mockRestore();
  });

  it('allows one supplier-reaching canonical intent winner for 100 simultaneous handoff consumers', async () => {
    const handoffToken = await createHandoff(SAMPLE_COUNT + 2);
    const duffelGet = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
      data: {
        id: `${RUN_MARKER}-offer`,
        total_amount: '100.00',
        total_currency: 'USD',
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        passengers: [{ id: 'pas_benchmark', type: 'adult' }],
      },
    } as never);
    const paymentCreate = jest.spyOn(stripeService, 'createPaymentIntent');
    const authSamples: number[] = [];
    const claimSamples: number[] = [];
    const originalValidate = jwtStrategy.validate.bind(jwtStrategy);
    const originalClaim = chatHandoffService.resolveAndAcquireClaim.bind(chatHandoffService);
    jest.spyOn(jwtStrategy, 'validate').mockImplementation(async (request, payload) => {
      const startedAt = performance.now();
      try {
        return await originalValidate(request, payload);
      } finally {
        authSamples.push(performance.now() - startedAt);
      }
    });
    jest
      .spyOn(chatHandoffService, 'resolveAndAcquireClaim')
      .mockImplementation(async (token, userId, ttlMs, context) => {
        const startedAt = performance.now();
        try {
          return await originalClaim(token, userId, ttlMs, context);
        } finally {
          claimSamples.push(performance.now() - startedAt);
        }
      });
    const requestBody = {
      handoffToken,
      passengers: [
        {
          offerPassengerId: 'pas_benchmark',
          type: PassengerType.ADULT,
          source: {
            type: 'inline',
            givenName: 'Benchmark',
            familyName: 'Passenger',
            dateOfBirth: '1990-01-01',
            gender: 'male',
            nationality: 'VN',
            email: 'benchmark@example.test',
            phoneCountryCode: '+84',
            phoneNumber: '912345678',
            title: 'Mr',
          },
        },
      ],
    };
    const requestBodyJson = JSON.stringify(requestBody);
    const requestBodyLength = Buffer.byteLength(requestBodyJson);
    const parsed = new URL(baseUrl);
    const intentsTarget = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/api/bookings/intents',
    };
    const authHeaders = { Authorization: `Bearer ${userToken}` };

    // Pre-warm keep-alive HTTP connection pool
    await Promise.all(
      Array.from({ length: SAMPLE_COUNT }, () => getJson(`${baseUrl}/health/ping`, httpAgent)),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));

    const responses = await Promise.all(
      Array.from({ length: SAMPLE_COUNT }, async () => {
        const startedAt = performance.now();
        const response = await postJson(
          intentsTarget,
          requestBodyJson,
          authHeaders,
          httpAgent,
          requestBodyLength,
        );
        return { response, latencyMs: performance.now() - startedAt };
      }),
    );
    const successful = responses.filter(({ response }) => response.status === 201);
    const expectedLosers = responses.filter(({ response }) => response.status === 409);
    const unexpectedFailures = responses.filter(
      ({ response }) => response.status !== 201 && response.status !== 409,
    );
    const intentCount = await prisma.bookingIntent.count({ where: { userId } });
    const consumedHandoff = await prisma.chatHandoff.findFirst({
      where: { userId, consumedAt: { not: null } },
      select: { consumedByBookingIntentId: true },
    });

    summary = {
      ...summary,
      consumeConcurrency: {
        count: responses.length,
        p95Ms: percentile95(responses.map(({ latencyMs }) => latencyMs)),
        supplierWinners: duffelGet.mock.calls.length,
        intentCount,
        expectedLosers: expectedLosers.length,
        failures: unexpectedFailures.length,
        authP95Ms: percentile95(authSamples),
        claimP95Ms: percentile95(claimSamples),
      },
    };

    expect(successful).toHaveLength(1);
    expect(expectedLosers).toHaveLength(SAMPLE_COUNT - 1);
    expect(unexpectedFailures).toHaveLength(0);
    expect(duffelGet).toHaveBeenCalledTimes(1);
    expect(intentCount).toBe(1);
    expect(consumedHandoff?.consumedByBookingIntentId).toBe(successful[0].response.body.intentId);
    expect(paymentCreate).not.toHaveBeenCalled();
    expect(summary.consumeConcurrency.claimP95Ms).not.toBeNull();
    expect(summary.consumeConcurrency.claimP95Ms!).toBeLessThan(HANDOFF_P95_LIMIT_MS);

    duffelGet.mockRestore();
    paymentCreate.mockRestore();
  });
});
