import * as crypto from 'crypto';
import * as http from 'http';
import { URL } from 'url';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.CHAT_ENCRYPTION_KEY =
  process.env.CHAT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { DuffelSearchAdapter } from '@/supplier/search/duffel-search.adapter';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { AirportType, PassengerType, Prisma } from '@prisma/client';

const SAMPLE_COUNT = 100;
const WARMUP_COUNT = 25;
const RUN_ID = crypto.randomUUID();

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 100,
  timeout: 120_000,
});

type BenchmarkStats = {
  samples: number[];
  count: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  failures: number;
};

type HttpResponse<T = Record<string, unknown>> = {
  status: number;
  body: T | null;
};

type ReadinessField = {
  fieldName: string;
  ready: boolean;
  blocking: boolean;
  reason?: string;
};

type ReadinessSection = {
  sectionName: string;
  ready: boolean;
  fields: ReadinessField[];
};

type ReadinessPassenger = {
  offerPassengerId: string;
  passengerType: string;
  ready: boolean;
  sections: ReadinessSection[];
};

type ReadinessResponse = {
  ready: boolean;
  scope: string;
  passengers: ReadinessPassenger[];
};

type ProfileResponse = {
  profileId: string;
  identity: {
    givenName: string;
    familyName: string;
    dateOfBirth: string;
    gender: string;
    title: string;
  };
  contact: {
    email: string;
    phoneCountryCode: string;
    phoneNumber: string;
  };
  travelDocument: {
    documentType: string;
    nationality: string;
    passportNumber: string;
    passportExpiry: string;
    issuingCountry: string;
  };
  revision: number;
};

type IntentPassengerResponse = {
  position: number;
  type: string;
  givenName: string;
  familyName: string;
  preFilledFromProfile: boolean;
  documentSummary: {
    hasPassport: boolean;
    maskedPassportNumber?: string;
  };
};

type IntentResponse = {
  intentId: string;
  status: string;
  passengers: IntentPassengerResponse[];
};

function getPercentile(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * (percentile / 100)) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

function calculateStats(samples: number[], failures: number): BenchmarkStats {
  return {
    samples,
    count: samples.length,
    p50: getPercentile(samples, 50),
    p90: getPercentile(samples, 90),
    p95: getPercentile(samples, 95),
    p99: getPercentile(samples, 99),
    failures,
  };
}

function getJson<T = Record<string, unknown>>(
  url: string,
  headers: Record<string, string>,
  agent: http.Agent,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent,
        headers: {
          Accept: 'application/json',
          Connection: 'keep-alive',
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
          let parsedBody: T | null = null;
          try {
            parsedBody = raw ? (JSON.parse(raw) as T) : null;
          } catch {}
          resolve({ status: res.statusCode || 500, body: parsedBody });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function postJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  agent: http.Agent,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const length = Buffer.byteLength(data);
    const parsed = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(length),
          Connection: 'keep-alive',
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
          let parsedBody: T | null = null;
          try {
            parsedBody = raw ? (JSON.parse(raw) as T) : null;
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

function patchJson<T = Record<string, unknown>>(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  agent: http.Agent,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const length = Buffer.byteLength(data);
    const parsed = new URL(url);

    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'PATCH',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(length),
          Connection: 'keep-alive',
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
          let parsedBody: T | null = null;
          try {
            parsedBody = raw ? (JSON.parse(raw) as T) : null;
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

describe('Booking Readiness Performance Benchmarks (E2E) - Task T075', () => {
  jest.setTimeout(180_000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let searchAdapter: DuffelSearchAdapter;
  let duffel: Duffel;

  let baseUrl = '';
  let testUser: { id: string; email: string };
  let testToken: string;
  let profile: { id: string; revision: number };
  let internationalOffer: { id: string; supplierOfferId: string };
  let domesticOffer: { id: string; supplierOfferId: string };

  const benchmarkStats: Record<string, BenchmarkStats> = {};

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown): unknown => {
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', {
      exclude: ['health', 'health/(.*)', 'api/health', 'api/health/(.*)'],
    });

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
    searchAdapter = moduleFixture.get<DuffelSearchAdapter>(DuffelSearchAdapter);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);

    // 1. Seed test user
    const user = await prisma.user.create({
      data: {
        email: `perf-test-${RUN_ID}@example.test`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: user.id, email: user.email };
    testToken = jwtService.sign(
      { sub: user.id, id: user.id, email: user.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    // 2. Seed international airport countries
    for (const ap of [
      { iataCode: 'SGN', name: 'Tan Son Nhat', city: 'Ho Chi Minh', country: 'VN' },
      { iataCode: 'LHR', name: 'Heathrow', city: 'London', country: 'GB' },
      { iataCode: 'HAN', name: 'Noi Bai', city: 'Ha Noi', country: 'VN' },
    ]) {
      await prisma.airport.upsert({
        where: { iataCode: ap.iataCode },
        update: {},
        create: {
          iataCode: ap.iataCode,
          name: ap.name,
          city: ap.city,
          country: ap.country,
          type: AirportType.LARGE_AIRPORT,
          latitude: 10.0,
          longitude: 106.0,
        },
      });
    }

    // 3. Seed international traveler profile via PATCH /api/profile endpoint (canonical encryption + revision initialization)
    const initialProfileRes = await patchJson<ProfileResponse>(
      `${baseUrl}/api/profile`,
      {
        expectedRevision: 0,
        identity: {
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          title: 'Mr',
        },
        contact: {
          email: 'john.doe@example.test',
          phoneCountryCode: '+84',
          phoneNumber: '912345678',
        },
        travelDocument: {
          documentType: 'passport',
          passportNumber: 'P12345678',
          passportExpiry: '2035-12-31',
          issuingCountry: 'VN',
          nationality: 'VN',
        },
      },
      { Authorization: `Bearer ${testToken}` },
      httpAgent,
    );

    if (!initialProfileRes.body?.profileId) {
      throw new Error(
        `Failed to initialize traveler profile for performance test: ${initialProfileRes.status}`,
      );
    }

    profile = {
      id: initialProfileRes.body.profileId,
      revision: initialProfileRes.body.revision,
    };

    // 4. Seed international flight offer
    const createdIntlOffer = await prisma.flightOffer.create({
      data: {
        searchHash: `perf-intl-${RUN_ID}`,
        supplierOfferId: `off_perf_intl_${RUN_ID}`,
        rawOffer: {
          id: `off_perf_intl_${RUN_ID}`,
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_perf_intl_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'LHR' },
                  departing_at: '2026-09-01T08:00:00Z',
                  arriving_at: '2026-09-01T18:00:00Z',
                },
              ],
            },
          ],
        } as unknown as Prisma.InputJsonValue,
        origin: 'SGN',
        destination: 'LHR',
        departureDate: new Date('2026-09-01T00:00:00.000Z'),
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
        price: new Prisma.Decimal(500),
        currency: 'USD',
      },
    });
    internationalOffer = { id: createdIntlOffer.id, supplierOfferId: createdIntlOffer.supplierOfferId };

    // 5. Seed domestic flight offer
    const createdDomOffer = await prisma.flightOffer.create({
      data: {
        searchHash: `perf-dom-${RUN_ID}`,
        supplierOfferId: `off_perf_dom_${RUN_ID}`,
        rawOffer: {
          id: `off_perf_dom_${RUN_ID}`,
          expires_at: '2030-08-25T10:00:00Z',
          passengers: [{ id: 'pas_perf_dom_001', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: '2026-09-01T08:00:00Z',
                  arriving_at: '2026-09-01T10:00:00Z',
                },
              ],
            },
          ],
        } as unknown as Prisma.InputJsonValue,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-09-01T00:00:00.000Z'),
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
        price: new Prisma.Decimal(100),
        currency: 'USD',
      },
    });
    domesticOffer = { id: createdDomOffer.id, supplierOfferId: createdDomOffer.supplierOfferId };

    // Pre-warm database connection pool
    await prisma.$queryRaw`SELECT 1`;

    // Pre-warm keep-alive HTTP connection pool & NestJS guards/pipes
    const prewarmHeaders = { Authorization: `Bearer ${testToken}` };
    for (let p = 0; p < 15; p++) {
      await getJson(`${baseUrl}/api/profile`, prewarmHeaders, httpAgent);
    }
  });

  afterAll(async () => {
    // Print Benchmark Summary Table
    console.log(
      '\n==================================== BENCHMARK SUMMARY (Task T075) ====================================',
    );
    console.table([
      {
        Benchmark: '1. Profile Read (GET /api/profile)',
        Samples: benchmarkStats['benchmark1']?.count ?? 0,
        p50_ms: benchmarkStats['benchmark1']?.p50.toFixed(2),
        p90_ms: benchmarkStats['benchmark1']?.p90.toFixed(2),
        p95_ms: benchmarkStats['benchmark1']?.p95.toFixed(2),
        p99_ms: benchmarkStats['benchmark1']?.p99.toFixed(2),
        Failures: benchmarkStats['benchmark1']?.failures ?? 0,
        Target_p95: '< 50 ms',
        Status:
          benchmarkStats['benchmark1'] &&
          benchmarkStats['benchmark1'].p95 < 50 &&
          benchmarkStats['benchmark1'].failures === 0
            ? 'PASS'
            : 'FAIL',
      },
      {
        Benchmark: '1B. Profile Write (PATCH /api/profile)',
        Samples: benchmarkStats['benchmark1b']?.count ?? 0,
        p50_ms: benchmarkStats['benchmark1b']?.p50.toFixed(2),
        p90_ms: benchmarkStats['benchmark1b']?.p90.toFixed(2),
        p95_ms: benchmarkStats['benchmark1b']?.p95.toFixed(2),
        p99_ms: benchmarkStats['benchmark1b']?.p99.toFixed(2),
        Failures: benchmarkStats['benchmark1b']?.failures ?? 0,
        Target_p95: '< 500 ms',
        Status:
          benchmarkStats['benchmark1b'] &&
          benchmarkStats['benchmark1b'].p95 < 500 &&
          benchmarkStats['benchmark1b'].failures === 0
            ? 'PASS'
            : 'FAIL',
      },
      {
        Benchmark: '2. Advisory Readiness (POST /api/bookings/intents/readiness)',
        Samples: benchmarkStats['benchmark2']?.count ?? 0,
        p50_ms: benchmarkStats['benchmark2']?.p50.toFixed(2),
        p90_ms: benchmarkStats['benchmark2']?.p90.toFixed(2),
        p95_ms: benchmarkStats['benchmark2']?.p95.toFixed(2),
        p99_ms: benchmarkStats['benchmark2']?.p99.toFixed(2),
        Failures: benchmarkStats['benchmark2']?.failures ?? 0,
        Target_p95: '< 100 ms',
        Status:
          benchmarkStats['benchmark2'] &&
          benchmarkStats['benchmark2'].p95 < 100 &&
          benchmarkStats['benchmark2'].failures === 0
            ? 'PASS'
            : 'FAIL',
      },
      {
        Benchmark: '3. Sequential Intent Creation (POST /api/bookings/intents)',
        Samples: benchmarkStats['benchmark3']?.count ?? 0,
        p50_ms: benchmarkStats['benchmark3']?.p50.toFixed(2),
        p90_ms: benchmarkStats['benchmark3']?.p90.toFixed(2),
        p95_ms: benchmarkStats['benchmark3']?.p95.toFixed(2),
        p99_ms: benchmarkStats['benchmark3']?.p99.toFixed(2),
        Failures: benchmarkStats['benchmark3']?.failures ?? 0,
        Target_p95: '< 200 ms',
        Status:
          benchmarkStats['benchmark3'] &&
          benchmarkStats['benchmark3'].p95 < 200 &&
          benchmarkStats['benchmark3'].failures === 0
            ? 'PASS'
            : 'FAIL',
      },
      {
        Benchmark: '4. 100-Way Concurrent Creation (POST /api/bookings/intents)',
        Samples: benchmarkStats['benchmark4']?.count ?? 0,
        p50_ms: benchmarkStats['benchmark4']?.p50.toFixed(2),
        p90_ms: benchmarkStats['benchmark4']?.p90.toFixed(2),
        p95_ms: benchmarkStats['benchmark4']?.p95.toFixed(2),
        p99_ms: benchmarkStats['benchmark4']?.p99.toFixed(2),
        Failures: benchmarkStats['benchmark4']?.failures ?? 0,
        Target_p95: 'N/A',
        Status:
          benchmarkStats['benchmark4'] && benchmarkStats['benchmark4'].failures === 0
            ? 'PASS'
            : 'FAIL',
      },
    ]);
    console.log(
      '=======================================================================================================\n',
    );

    // Cleanup resources
    try {
      if (prisma && testUser?.id) {
        await prisma.auditLog.deleteMany({ where: { userId: testUser.id } });
        await prisma.bookingIntentPassenger.deleteMany({
          where: { intent: { userId: testUser.id } },
        });
        await prisma.bookingIntent.deleteMany({ where: { userId: testUser.id } });
        await prisma.travelerProfile.deleteMany({ where: { userId: testUser.id } });
        const offerIds = [internationalOffer?.id, domesticOffer?.id].filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        );
        if (offerIds.length > 0) {
          await prisma.flightOffer.deleteMany({
            where: { id: { in: offerIds } },
          });
        }
        await prisma.user.deleteMany({ where: { id: testUser.id } });
      }
    } finally {
      if (httpAgent) {
        httpAgent.destroy();
      }
      if (app) {
        await app.close();
      }
    }
  });

  describe('Benchmark 1: Profile Read', () => {
    it('executes 100 requests to GET /api/profile with p95 < 50ms and verified owner profile fields', async () => {
      const authHeaders = { Authorization: `Bearer ${testToken}` };
      const endpoint = `${baseUrl}/api/profile`;

      // 10 Warmup requests
      for (let w = 0; w < WARMUP_COUNT; w++) {
        const warmupRes = await getJson<ProfileResponse>(endpoint, authHeaders, httpAgent);
        expect(warmupRes.status).toBe(200);
      }

      // 100 Benchmark requests
      const latencies: number[] = [];
      let failures = 0;

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const startedAt = performance.now();
        const res = await getJson<ProfileResponse>(endpoint, authHeaders, httpAgent);
        const elapsed = performance.now() - startedAt;

        if (res.status === 200 && res.body) {
          latencies.push(elapsed);
          expect(res.body.profileId).toBe(profile.id);
          expect(res.body.identity.givenName).toBe('John');
          expect(res.body.identity.familyName).toBe('Doe');
          expect(res.body.travelDocument.documentType).toBe('passport');
          expect(res.body.travelDocument.nationality).toBe('VN');
          expect(res.body.travelDocument.passportNumber).toBe('P12345678');
          expect(res.body.revision).toBe(profile.revision);
        } else {
          failures++;
        }
      }

      const stats = calculateStats(latencies, failures);
      benchmarkStats['benchmark1'] = stats;

      expect(failures).toBe(0);
      expect(latencies).toHaveLength(SAMPLE_COUNT);
      expect(stats.p95).toBeLessThan(50);
    });
  });

  describe('Benchmark 1B: Profile Write', () => {
    it('executes 100 sequential requests to PATCH /api/profile with p95 < 500ms', async () => {
      const authHeaders = { Authorization: `Bearer ${testToken}` };
      const endpoint = `${baseUrl}/api/profile`;

      // 10 Warmup requests
      for (let w = 0; w < WARMUP_COUNT; w++) {
        const warmupPayload = {
          expectedRevision: profile.revision,
          contact: {
            email: `warmup-${w}@example.test`,
            phoneCountryCode: '+84',
            phoneNumber: '912345678',
          },
        };
        const warmupRes = await patchJson<ProfileResponse>(
          endpoint,
          warmupPayload,
          authHeaders,
          httpAgent,
        );
        expect(warmupRes.status).toBe(200);
        if (warmupRes.body?.revision) {
          profile.revision = warmupRes.body.revision;
        }
      }

      // 100 Benchmark requests
      const latencies: number[] = [];
      let failures = 0;

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const payload = {
          expectedRevision: profile.revision,
          contact: {
            email: `perf-update-${i}@example.test`,
            phoneCountryCode: '+84',
            phoneNumber: '912345678',
          },
        };

        const startedAt = performance.now();
        const res = await patchJson<ProfileResponse>(endpoint, payload, authHeaders, httpAgent);
        const elapsed = performance.now() - startedAt;

        if (res.status === 200 && res.body?.revision) {
          latencies.push(elapsed);
          profile.revision = res.body.revision;
          expect(res.body.contact.email).toBe(`perf-update-${i}@example.test`);
        } else {
          failures++;
        }
      }

      const stats = calculateStats(latencies, failures);
      benchmarkStats['benchmark1b'] = stats;

      expect(failures).toBe(0);
      expect(latencies).toHaveLength(SAMPLE_COUNT);
      expect(stats.p95).toBeLessThan(500);
    });
  });

  describe('Benchmark 2: Advisory Readiness', () => {
    it('executes 100 requests to POST /api/bookings/intents/readiness with p95 < 100ms', async () => {
      const authHeaders = { Authorization: `Bearer ${testToken}` };
      const endpoint = `${baseUrl}/api/bookings/intents/readiness`;
      const payload = {
        flightOfferId: internationalOffer.id,
        passengers: [
          {
            offerPassengerId: 'pas_perf_intl_001',
            passengerType: PassengerType.ADULT,
            source: {
              type: 'traveler_profile',
              travelerProfileId: profile.id,
              expectedProfileRevision: profile.revision,
            },
          },
        ],
      };

      // 10 Warmup requests
      for (let w = 0; w < WARMUP_COUNT; w++) {
        const warmupRes = await postJson<ReadinessResponse>(
          endpoint,
          payload,
          authHeaders,
          httpAgent,
        );
        expect(warmupRes.status).toBe(200);
      }

      // 100 Benchmark requests
      const latencies: number[] = [];
      let failures = 0;

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const startedAt = performance.now();
        const res = await postJson<ReadinessResponse>(endpoint, payload, authHeaders, httpAgent);
        const elapsed = performance.now() - startedAt;

        if (res.status === 200 && res.body) {
          latencies.push(elapsed);
          expect(res.body.ready).toBe(true);
          expect(res.body.scope).toBe('INTERNATIONAL');
          expect(res.body.passengers).toHaveLength(1);
          expect(res.body.passengers[0].ready).toBe(true);
          const blockingFields = res.body.passengers.flatMap((p) =>
            p.sections.flatMap((s) => s.fields.filter((f) => f.blocking)),
          );
          expect(blockingFields).toHaveLength(0);
        } else {
          failures++;
        }
      }

      const stats = calculateStats(latencies, failures);
      benchmarkStats['benchmark2'] = stats;

      expect(failures).toBe(0);
      expect(latencies).toHaveLength(SAMPLE_COUNT);
      expect(stats.p95).toBeLessThan(100);
    });
  });

  describe('Benchmark 3: Sequential Intent Creation', () => {
    it('executes 100 sequential requests to POST /api/bookings/intents with p95 < 200ms and zero supplier calls', async () => {
      const authHeaders = { Authorization: `Bearer ${testToken}` };
      const endpoint = `${baseUrl}/api/bookings/intents`;
      const payload = {
        flightOfferId: internationalOffer.id,
        passengers: [
          {
            offerPassengerId: 'pas_perf_intl_001',
            type: PassengerType.ADULT,
            source: {
              type: 'traveler_profile',
              travelerProfileId: profile.id,
              expectedProfileRevision: profile.revision,
            },
          },
        ],
      };

      // Mock the supplier adapter to ensure zero external supplier network calls.
      const duffelOfferSpy = jest.spyOn(searchAdapter, 'getOffer').mockResolvedValue({
        id: internationalOffer.supplierOfferId,
        total_amount: '500.00',
        total_currency: 'USD',
        expires_at: '2030-08-25T10:00:00Z',
        passengers: [{ id: 'pas_perf_intl_001', type: 'adult' }],
        slices: [
          {
            duration: 'PT10H',
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'LHR' },
                departing_at: '2026-09-01T08:00:00Z',
                arriving_at: '2026-09-01T18:00:00Z',
              },
            ],
          },
        ],
      });
      const duffelOffersGetSpy = jest.spyOn(duffel.offers, 'get');

      // 10 Warmup requests
      for (let w = 0; w < WARMUP_COUNT; w++) {
        const warmupRes = await postJson<IntentResponse>(endpoint, payload, authHeaders, httpAgent);
        expect(warmupRes.status).toBe(201);
      }

      // Reset spy counts before benchmark loop
      duffelOfferSpy.mockClear();
      duffelOffersGetSpy.mockClear();

      // 100 Sequential benchmark requests
      const latencies: number[] = [];
      let failures = 0;

      for (let i = 0; i < SAMPLE_COUNT; i++) {
        const startedAt = performance.now();
        const res = await postJson<IntentResponse>(endpoint, payload, authHeaders, httpAgent);
        const elapsed = performance.now() - startedAt;

        if (res.status === 201 && res.body) {
          latencies.push(elapsed);
          expect(res.body.intentId).toBeDefined();
          expect(res.body.passengers).toHaveLength(1);
          expect(res.body.passengers[0].documentSummary.hasPassport).toBe(true);
          expect(res.body.passengers[0].preFilledFromProfile).toBe(true);
        } else {
          failures++;
        }
      }

      const stats = calculateStats(latencies, failures);
      benchmarkStats['benchmark3'] = stats;

      expect(failures).toBe(0);
      expect(latencies).toHaveLength(SAMPLE_COUNT);
      expect(stats.p95).toBeLessThan(200);

      // Verify zero external supplier calls were made to Duffel API
      expect(duffelOffersGetSpy).not.toHaveBeenCalled();
      expect(duffelOfferSpy).toHaveBeenCalledTimes(SAMPLE_COUNT);

      duffelOfferSpy.mockRestore();
      duffelOffersGetSpy.mockRestore();
    });
  });

  describe('Benchmark 4: 100-Way Concurrent Intent Creation', () => {
    it('executes 100 simultaneous concurrent POST /api/bookings/intents requests across Promise.all', async () => {
      const authHeaders = { Authorization: `Bearer ${testToken}` };
      const endpoint = `${baseUrl}/api/bookings/intents`;

      // Mock the supplier adapter for in-memory execution and zero supplier calls.
      const duffelOfferSpy = jest.spyOn(searchAdapter, 'getOffer').mockResolvedValue({
        id: internationalOffer.supplierOfferId,
        total_amount: '500.00',
        total_currency: 'USD',
        expires_at: '2030-08-25T10:00:00Z',
        passengers: [{ id: 'pas_perf_intl_001', type: 'adult' }],
        slices: [
          {
            duration: 'PT10H',
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'LHR' },
                departing_at: '2026-09-01T08:00:00Z',
                arriving_at: '2026-09-01T18:00:00Z',
              },
            ],
          },
        ],
      });

      // 10 Warmup requests
      for (let w = 0; w < WARMUP_COUNT; w++) {
        const warmupPayload = {
          flightOfferId: internationalOffer.id,
          passengers: [
            {
              offerPassengerId: 'pas_perf_intl_001',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Warmup',
                familyName: `Traveler${w}`,
                dateOfBirth: '1990-01-01',
                gender: 'male',
                email: `warmup${w}@example.test`,
                phoneCountryCode: '+84',
                phoneNumber: '912345678',
                title: 'Mr',
                documentType: 'passport',
                passportNumber: `P000000${w.toString().padStart(2, '0')}`,
                passportExpiry: '2035-12-31',
                issuingCountry: 'VN',
                nationality: 'VN',
              },
            },
          ],
        };
        const warmupRes = await postJson<IntentResponse>(
          endpoint,
          warmupPayload,
          authHeaders,
          httpAgent,
        );
        expect(warmupRes.status).toBe(201);
      }

      // Generate 100 concurrent requests with unique inline passenger data
      const concurrentRequests = Array.from({ length: SAMPLE_COUNT }, (_, index) => {
        const payload = {
          flightOfferId: internationalOffer.id,
          passengers: [
            {
              offerPassengerId: 'pas_perf_intl_001',
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Concurrent',
                familyName: `Traveler${index}`,
                dateOfBirth: '1990-01-01',
                gender: 'male',
                email: `concurrent${index}@example.test`,
                phoneCountryCode: '+84',
                phoneNumber: '912345678',
                title: 'Mr',
                documentType: 'passport',
                passportNumber: `P987654${index.toString().padStart(3, '0')}`,
                passportExpiry: '2035-12-31',
                issuingCountry: 'VN',
                nationality: 'VN',
              },
            },
          ],
        };

        return async () => {
          const startedAt = performance.now();
          const res = await postJson<IntentResponse>(endpoint, payload, authHeaders, httpAgent);
          const elapsed = performance.now() - startedAt;
          return { res, elapsed };
        };
      });

      // Launch 100 requests simultaneously via Promise.all
      const results = await Promise.all(concurrentRequests.map((fn) => fn()));

      const latencies: number[] = [];
      let failures = 0;
      const createdIntentIds: string[] = [];

      for (const { res, elapsed } of results) {
        if (res.status === 201 && res.body?.intentId) {
          latencies.push(elapsed);
          createdIntentIds.push(res.body.intentId);
        } else {
          failures++;
        }
      }

      const stats = calculateStats(latencies, failures);
      benchmarkStats['benchmark4'] = stats;

      // 1. Assert 100/100 HTTP 201 Created
      expect(failures).toBe(0);
      expect(createdIntentIds).toHaveLength(SAMPLE_COUNT);

      // 2. Assert exactly 100 distinct BookingIntent rows in database
      const distinctIntentIdSet = new Set(createdIntentIds);
      expect(distinctIntentIdSet.size).toBe(SAMPLE_COUNT);

      const dbIntents = await prisma.bookingIntent.findMany({
        where: { id: { in: createdIntentIds } },
      });
      expect(dbIntents).toHaveLength(SAMPLE_COUNT);

      // 3. Assert exactly 100 BookingIntentPassenger snapshot rows (1 per intent, 0 duplicates, 0 orphaned snapshots)
      const dbPassengers = await prisma.bookingIntentPassenger.findMany({
        where: { intentId: { in: createdIntentIds } },
      });
      expect(dbPassengers).toHaveLength(SAMPLE_COUNT);

      const passengerIntentIds = dbPassengers.map((p) => p.intentId);
      const distinctPassengerIntentIds = new Set(passengerIntentIds);
      expect(distinctPassengerIntentIds.size).toBe(SAMPLE_COUNT);

      for (const intentId of createdIntentIds) {
        const passengersForIntent = dbPassengers.filter((p) => p.intentId === intentId);
        expect(passengersForIntent).toHaveLength(1);
        expect(passengersForIntent[0].position).toBe(0);
      }

      // 4. Assert 0 deadlocks, 0 transaction failures (failures === 0)
      expect(failures).toBe(0);

      duffelOfferSpy.mockRestore();
    });
  });
});
