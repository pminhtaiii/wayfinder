import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { DuffelOfferRequest } from '@/duffel/duffel.types';

describe('Flights Search (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let jwtToken: string;
  let userId: string;

  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitFor(assertion: () => Promise<void> | void, timeout = 2000, interval = 50) {
    const start = Date.now();
    for (;;) {
      try {
        await assertion();
        return;
      } catch (error) {
        if (Date.now() - start > timeout) {
          throw error;
        }
        await wait(interval);
      }
    }
  }

  beforeAll(async () => {
    jest
      .useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'setTimeout'],
      })
      .setSystemTime(new Date('2026-07-08T12:00:00.000Z'));

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app.close();
  });

  beforeEach(async () => {
    // Clean tables in dependent order
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.itineraryRevisionSegment.deleteMany({});
    await prisma.itineraryRevision.deleteMany({});
    await prisma.disruptionAuditEvent.deleteMany({});
    await prisma.notificationOutbox.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Clear cache
    const keys = await cacheService.keys('*');
    for (const key of keys) {
      await cacheService.del(key);
    }

    // Seed mock airports
    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'HAN',
          icaoCode: 'VVNB',
          name: 'Noi Bai International Airport',
          city: 'Hanoi',
          country: 'VN',
          region: 'VN-HN',
          latitude: 21.2212,
          longitude: 105.807,
          elevation: 39,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
        {
          iataCode: 'SGN',
          icaoCode: 'VVTS',
          name: 'Tan Son Nhat International Airport',
          city: 'Ho Chi Minh City',
          country: 'VN',
          region: 'VN-SG',
          latitude: 10.8184,
          longitude: 106.6633,
          elevation: 33,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ],
    });

    // Create active user
    const user = await prisma.user.create({
      data: {
        email: 'searchuser@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    // Sign JWT
    jwtToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
  });

  describe('Authentication Check', () => {
    it('should return 401 Unauthorized when requesting without Bearer token', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(401);
    });
  });

  describe('Input Validation Checks', () => {
    it('should return 400 Bad Request when origin or destination is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when origin/destination has an invalid IATA code', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HANOI',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'sg',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when origin or destination airport does not exist in database', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'XYZ',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(400);

      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'XYZ',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when origin and destination are the same', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'HAN',
          departureDate: '2026-07-15',
          adults: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when passenger count is invalid (e.g. adults out of bounds, total > 9, infants > adults)', async () => {
      // adults = 0
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 0,
        })
        .expect(400);

      // adults = 10
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 10,
        })
        .expect(400);

      // total > 9 (adults 6, children 4)
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 6,
          children: 4,
        })
        .expect(400);

      // infants > adults (adults 1, infants 2)
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
          infants: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when departureDate is in the past', async () => {
      // Current date in metadata is 2026-07-08. So 2026-07-07 is past.
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-07',
          adults: 2,
        })
        .expect(400);
    });

    it('should return 400 Bad Request when returnDate is before departureDate', async () => {
      await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          returnDate: '2026-07-14',
          adults: 2,
        })
        .expect(400);
    });
  });

  describe('Successful Search & Side-Effects', () => {
    let sdkSpy: jest.SpyInstance;
    const mockDuffelResponse: DuffelOfferRequest = {
      id: 'or_mock_123',
      slices: [
        {
          id: 'sli_mock_1',
          duration: 'PT2H10M',
          origin: {
            id: 'HAN',
            name: 'Noi Bai International Airport',
            iata_code: 'HAN',
            type: 'airport',
          },
          destination: {
            id: 'SGN',
            name: 'Tan Son Nhat International Airport',
            iata_code: 'SGN',
            type: 'airport',
          },
          segments: [
            {
              id: 'seg_mock_1',
              duration: 'PT2H10M',
              departing_at: '2026-07-15T08:00:00',
              arriving_at: '2026-07-15T10:10:00',
              origin: {
                id: 'HAN',
                name: 'Noi Bai International Airport',
                iata_code: 'HAN',
                type: 'airport',
              },
              destination: {
                id: 'SGN',
                name: 'Tan Son Nhat International Airport',
                iata_code: 'SGN',
                type: 'airport',
              },
              operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier_flight_number: '123',
              aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
              passengers: [
                {
                  passenger_id: 'pas_mock_1',
                  cabin_class: 'economy',
                  baggages: [{ type: 'checked', quantity: 1 }],
                },
              ],
            },
          ],
        },
      ],
      passengers: [{ id: 'pas_mock_1', type: 'adult' }],
      offers: [
        {
          id: 'off_mock_123',
          total_amount: '125.50',
          total_currency: 'USD',
          slices: [
            {
              id: 'sli_mock_1',
              duration: 'PT2H10M',
              origin: {
                id: 'HAN',
                name: 'Noi Bai International Airport',
                iata_code: 'HAN',
                type: 'airport',
              },
              destination: {
                id: 'SGN',
                name: 'Tan Son Nhat International Airport',
                iata_code: 'SGN',
                type: 'airport',
              },
              segments: [
                {
                  id: 'seg_mock_1',
                  duration: 'PT2H10M',
                  departing_at: '2026-07-15T08:00:00',
                  arriving_at: '2026-07-15T10:10:00',
                  origin: {
                    id: 'HAN',
                    name: 'Noi Bai International Airport',
                    iata_code: 'HAN',
                    type: 'airport',
                  },
                  destination: {
                    id: 'SGN',
                    name: 'Tan Son Nhat International Airport',
                    iata_code: 'SGN',
                    type: 'airport',
                  },
                  operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                  marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                  marketing_carrier_flight_number: '123',
                  aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                  passengers: [
                    {
                      passenger_id: 'pas_mock_1',
                      cabin_class: 'economy',
                      baggages: [{ type: 'checked', quantity: 1 }],
                    },
                  ],
                },
              ],
            },
          ],
          passengers: [{ id: 'pas_mock_1', type: 'adult' }],
          passenger_identity_documents_required: false,
        },
      ],
    };

    let duffel: Duffel;

    beforeEach(() => {
      duffel = app.get<Duffel>(DUFFEL_SDK);
      sdkSpy = jest.spyOn(duffel.offerRequests, 'create').mockResolvedValue({
        data: mockDuffelResponse,
      } as unknown as { data: DuffelOfferRequest });
    });

    afterEach(() => {
      sdkSpy.mockRestore();
    });

    it('should perform a successful one-way search in RANKED mode (cold start), verify return structure, security headers, Redis cache, DB writes, and audit logs', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(200);

      // Verify HTTP Headers & Security Invariants
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['etag']).toBeUndefined();

      // Verify return structure (mode, results, meta)
      expect(res.body.mode).toBe('RANKED');
      expect(res.body).toHaveProperty('results');
      expect(res.body).toHaveProperty('meta');
      expect(res.body.results).toBeInstanceOf(Array);
      expect(res.body.results.length).toBe(1);

      const offer = res.body.results[0];
      expect(offer).toHaveProperty('id');
      expect(offer.airline).toBe('Vietnam Airlines');
      expect(offer.flightNumber).toBe('VN123');
      expect(offer.departureAirport).toBe('HAN');
      expect(offer.arrivalAirport).toBe('SGN');
      expect(offer.departureTime).toBe('2026-07-15T08:00:00');
      expect(offer.arrivalTime).toBe('2026-07-15T10:10:00');
      expect(offer.duration).toBe(130);
      expect(offer.stops).toBe(0);
      expect(offer.price).toBe(125.5);
      expect(offer.currency).toBe('USD');
      expect(offer.fareClass).toBe('Economy');
      expect(offer.baggageAllowance).toContain('1');
      expect(offer.matchResult).toBeNull();

      const segment = offer.segments[0];
      expect(segment.carrierCode).toBe('VN');
      expect(segment.flightNumber).toBe('123');
      expect(segment.operatingCarrier).toBe('Vietnam Airlines');
      expect(segment.departureAirport).toBe('HAN');
      expect(segment.departureTime).toBe('2026-07-15T08:00:00');
      expect(segment.arrivalAirport).toBe('SGN');
      expect(segment.arrivalTime).toBe('2026-07-15T10:10:00');
      expect(segment.duration).toBe(130);
      expect(segment.aircraft).toBe('A321');

      expect(res.body.meta.totalResults).toBe(1);
      expect(res.body.meta.cached).toBe(false);
      expect(res.body.meta.scoringVersion).toBeNull();
      expect(res.body.meta).toHaveProperty('searchHash');
      const searchHash = res.body.meta.searchHash;

      // Verify raw Duffel results cached in Redis under flights:raw:${searchHash}
      const rawCached = await cacheService.get(`flights:raw:${searchHash}`);
      expect(rawCached).toBeDefined();
      const parsedRaw = JSON.parse(rawCached!);
      expect(parsedRaw.id).toBe('or_mock_123');
      expect(parsedRaw.offers[0].id).toBe('off_mock_123');

      // Verify async DB writes (FlightOffer, SearchHistory, OfferRecovery)
      await waitFor(async () => {
        const history = await prisma.searchHistory.findFirst({
          where: { userId },
        });
        expect(history).toBeDefined();
        expect(history!.origin).toBe('HAN');
        expect(history!.destination).toBe('SGN');
        expect(history!.adults).toBe(1);
        expect(history!.children).toBe(0);
        expect(history!.infants).toBe(0);
        expect(history!.cabinClass).toBe('economy');
        expect(history!.resultCount).toBe(1);
        expect(Number(history!.minPrice)).toBe(125.5);
        expect(history!.searchHash).toBe(searchHash);

        const offers = await prisma.flightOffer.findMany({
          where: { searchHash },
        });
        expect(offers.length).toBe(1);
        expect(offers[0].supplierOfferId).toBe('off_mock_123');
        expect(offers[0].id).toBe(offer.id);

        const recovery = await prisma.offerRecovery.findUnique({
          where: { id: offers[0].id },
        });
        expect(recovery).toBeDefined();
        expect(recovery!.searchHash).toBe(searchHash);
      });

      // Verify audit logs
      const auditLog = await prisma.auditLog.findFirst({
        where: { userId, action: 'flight_search' },
      });
      expect(auditLog).toBeDefined();
      expect(auditLog!.resourceType).toBe('Flight');
      const metadata = auditLog!.metadata as Record<string, unknown>;
      expect(metadata).toHaveProperty('origin', 'HAN');
      expect(metadata).toHaveProperty('destination', 'SGN');
      // No PII leak
      expect(metadata.email).toBeUndefined();
      expect(metadata.password).toBeUndefined();

      const searchCompletedLog = await prisma.auditLog.findFirst({
        where: { userId, action: 'search.completed' },
      });
      expect(searchCompletedLog).toBeDefined();
      expect((searchCompletedLog!.metadata as Record<string, unknown>).mode).toBe('RANKED');
    });

    it('should verify cache hit on repeated searches in RANKED mode, preserving DB upserts, headers, and zero external calls', async () => {
      // First Search (Cache Miss)
      const res1 = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(200);

      expect(res1.headers['cache-control']).toBe('private, no-store');
      expect(res1.headers['etag']).toBeUndefined();
      expect(res1.body.mode).toBe('RANKED');
      expect(res1.body.meta.cached).toBe(false);
      expect(sdkSpy).toHaveBeenCalledTimes(1);

      const searchHash = res1.body.meta.searchHash;

      // Verify Redis raw cache exists
      const rawCached = await cacheService.get(`flights:raw:${searchHash}`);
      expect(rawCached).toBeDefined();

      // Get budget key value
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const budgetKey = `budget:duffel:daily:user:${yyyy}-${mm}-${dd}`;
      const budgetValBefore = await cacheService.get(budgetKey);

      // Clear spy
      sdkSpy.mockClear();

      // Second Search (Cache Hit)
      const res2 = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(200);

      expect(res2.headers['cache-control']).toBe('private, no-store');
      expect(res2.headers['etag']).toBeUndefined();
      expect(res2.body.mode).toBe('RANKED');
      expect(res2.body.meta.cached).toBe(true);
      expect(res2.body.meta.searchHash).toBe(searchHash);
      expect(sdkSpy).not.toHaveBeenCalled();

      const budgetValAfter = await cacheService.get(budgetKey);
      expect(budgetValAfter).toBe(budgetValBefore);

      // Verify DB records on Cache Hit: SearchHistory should record the second search, and FlightOffer / OfferRecovery remain valid
      await waitFor(async () => {
        const histories = await prisma.searchHistory.findMany({
          where: { userId, searchHash },
        });
        expect(histories.length).toBe(2);

        const offers = await prisma.flightOffer.findMany({
          where: { searchHash },
        });
        expect(offers.length).toBe(1);
        expect(offers[0].supplierOfferId).toBe('off_mock_123');

        const recoveries = await prisma.offerRecovery.findMany({
          where: { searchHash },
        });
        expect(recoveries.length).toBe(1);
      });
    });

    it('should return 429 TOO MANY REQUESTS when the search budget is exhausted', async () => {
      // Exhaust the budget key in Redis (Default limit is 1000 for user caller)
      const now = new Date();
      const yyyy = now.getUTCFullYear();
      const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(now.getUTCDate()).padStart(2, '0');
      const budgetKey = `budget:duffel:daily:user:${yyyy}-${mm}-${dd}`;
      await cacheService.set(budgetKey, '1000');

      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(429);

      expect(res.body.code).toBe('RATE_LIMIT_EXCEEDED');
    });

    it('should return 502 BAD GATEWAY when the upstream Duffel API is down or unavailable', async () => {
      // Mock failure on the SDK spy
      sdkSpy.mockRejectedValueOnce(new Error('Upstream service connection timeout'));

      const res = await request(app.getHttpServer())
        .post('/api/flights/search')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          adults: 1,
        })
        .expect(502);

      expect(res.body.code).toBe('UPSTREAM_UNAVAILABLE');
      sdkSpy.mockRestore();
    });
  });
});
