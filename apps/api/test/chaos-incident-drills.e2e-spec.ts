process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.CHAT_HANDOFF_SECRET = 'chaos-drill-handoff-secret-32bytes!';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { DuffelSearchAdapter, DuffelTimeoutError } from '@/supplier/search/duffel-search.adapter';
import { ChatHandoffService } from '@/chat-handoff/chat-handoff.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { CacheService } from '@/cache/cache.service';
import { LockoutService } from '@/auth/rate-limit/lockout.service';
import { PassengerType, Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import * as crypto from 'crypto';

describe('Chaos & Fault-Tolerance Incident Drills (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let searchAdapter: DuffelSearchAdapter;
  let chatHandoffService: ChatHandoffService;
  let tokenService: ChatHandoffTokenService;
  let cacheService: CacheService;
  let lockoutService: LockoutService;

  let testUser: { id: string; email: string };
  let authToken: string;

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
    jwtService = moduleFixture.get<JwtService>(JwtService);
    searchAdapter = moduleFixture.get<DuffelSearchAdapter>(DuffelSearchAdapter);
    chatHandoffService = moduleFixture.get<ChatHandoffService>(ChatHandoffService);
    tokenService = moduleFixture.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    lockoutService = moduleFixture.get<LockoutService>(LockoutService);
  });

  afterAll(async () => {
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

    // Create test user
    const u = await prisma.user.create({
      data: {
        email: `chaos-drill-${crypto.randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: u.id, email: u.email };
    authToken = jwtService.sign(
      { sub: u.id, id: u.id, email: u.email, jti: crypto.randomUUID() },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients', expiresIn: '24h' },
    );
  });

  async function createMockFlightOffer(data: Partial<Prisma.FlightOfferCreateInput> = {}) {
    return prisma.flightOffer.create({
      data: {
        searchHash: `search-hash-${crypto.randomUUID()}`,
        supplierOfferId: `off_duffel_${crypto.randomUUID()}`,
        rawOffer: {
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: new Date(Date.now() + 86400000).toISOString(),
                  arriving_at: new Date(Date.now() + 90000000).toISOString(),
                  operating_carrier: { name: 'Vietnam Airlines' },
                },
              ],
            },
          ],
        },
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date(Date.now() + 86400000),
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
        price: new Prisma.Decimal(150.0),
        currency: 'USD',
        ...data,
      },
    });
  }

  // =========================================================================
  // Drill 1: Supplier Timeout & Recovery Drill
  // =========================================================================
  describe('Drill 1: Supplier Timeout & Recovery Drill', () => {
    it('simulates supplier timeout during pricing validation, safely releases claim in finally block, and succeeds upon recovery retry', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const handoffId = crypto.randomUUID();
      const { token, tokenHash } = await tokenService.generateToken(handoffId, 'idem-chaos-1', 1);
      const duffelOfferIdHash = tokenService.hashToken(offer.supplierOfferId);

      const session = await prisma.chatSession.create({
        data: {
          id: crypto.randomUUID(),
          userId: testUser.id,
        },
      });

      await prisma.chatHandoff.create({
        data: {
          id: handoffId,
          userId: testUser.id,
          chatSessionId: session.id,
          flightOfferId: offer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'print-chaos-1',
          selectionAttestationHash: 'attest-chaos-1',
          selectedOfferIndex: 1,
          tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-chaos-1',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      // 1. Simulate Duffel 504 / timeout during live offer validation
      const duffelSpy = jest
        .spyOn(searchAdapter, 'getOffer')
        .mockRejectedValue(new DuffelTimeoutError('Upstream Duffel supplier 504 gateway timeout'));

      const reqBody = {
        handoffToken: token,
        passengers: [
          {
            type: PassengerType.ADULT,
            givenName: 'Minh',
            familyName: 'Tai',
            dateOfBirth: '1995-05-15',
            gender: 'male',
            nationality: 'VN',
          },
        ],
      };

      const failureRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${authToken}`)
        .send(reqBody);

      expect(failureRes.status).toBe(502);
      expect(failureRes.body.code).toBe('UPSTREAM_TIMEOUT');

      // 2. Assert watchdog cancels and releaseClaim in finally block safely cleared all claim fields back to NULL
      const handoffAfterFailure = await prisma.chatHandoff.findUnique({
        where: { id: handoffId },
      });

      expect(handoffAfterFailure).toBeDefined();
      expect(handoffAfterFailure?.claimedAt).toBeNull();
      expect(handoffAfterFailure?.claimTokenHash).toBeNull();
      expect(handoffAfterFailure?.claimExpiresAt).toBeNull();
      expect(handoffAfterFailure?.claimRecoverAfter).toBeNull();
      expect(handoffAfterFailure?.consumedAt).toBeNull();
      expect(handoffAfterFailure?.consumedByBookingIntentId).toBeNull();

      // 3. Assert zero orphaned CLAIMED locks remain indefinitely
      const orphanedLocks = await prisma.chatHandoff.count({
        where: {
          id: handoffId,
          OR: [
            { claimTokenHash: { not: null } },
            { claimExpiresAt: { not: null } },
            { claimRecoverAfter: { not: null } },
          ],
        },
      });
      expect(orphanedLocks).toBe(0);

      // Verify safe resolve confirms handoff is back to ACTIVE
      const resolveRes = await request(app.getHttpServer())
        .post('/api/chat-handoff/resolve')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ token })
        .expect(200);

      expect(resolveRes.body.status).toBe('ACTIVE');

      // 4. Supplier Recovery: Restore supplier service and retry createIntent
      duffelSpy.mockRestore();
      jest.spyOn(searchAdapter, 'getOffer').mockResolvedValue({
        id: offer.supplierOfferId,
        // The stored fixture supplies the itinerary returned by the supplier.
        slices: (offer.rawOffer as Prisma.JsonObject).slices,
        total_amount: '150.00',
        total_currency: 'USD',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        passengers: [{ id: 'duffel-pas-1', type: 'adult' }],
      });

      const successRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${authToken}`)
        .send(reqBody);

      expect(successRes.status).toBe(201);
      expect(successRes.body.intentId).toBeDefined();
      expect(successRes.body.confirmedPrice).toBe(150);

      // Verify handoff was successfully consumed
      const handoffAfterSuccess = await prisma.chatHandoff.findUnique({
        where: { id: handoffId },
      });
      expect(handoffAfterSuccess?.consumedAt).not.toBeNull();
      expect(handoffAfterSuccess?.consumedByBookingIntentId).toBe(successRes.body.intentId);
    });
  });

  // =========================================================================
  // Drill 2: Expired Claim Recovery Drill
  // =========================================================================
  describe('Drill 2: Expired Claim Recovery Drill', () => {
    it('successfully recovers and consumes handoff when previous claim lease expired (> claimRecoverAfter)', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const handoffId = crypto.randomUUID();
      const { token, tokenHash } = await tokenService.generateToken(handoffId, 'idem-chaos-2', 1);
      const duffelOfferIdHash = tokenService.hashToken(offer.supplierOfferId);

      const session = await prisma.chatSession.create({
        data: {
          id: crypto.randomUUID(),
          userId: testUser.id,
        },
      });

      const now = Date.now();
      // Simulate crashed worker leaving expired claim lease past claimRecoverAfter
      await prisma.chatHandoff.create({
        data: {
          id: handoffId,
          userId: testUser.id,
          chatSessionId: session.id,
          flightOfferId: offer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'print-chaos-2',
          selectionAttestationHash: 'attest-chaos-2',
          selectedOfferIndex: 1,
          tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-chaos-2',
          claimedAt: new Date(now - 60000),
          claimTokenHash: 'stale-crashed-claim-token-hash',
          claimExpiresAt: new Date(now - 30000),
          claimRecoverAfter: new Date(now - 25000),
          expiresAt: new Date(now + 15 * 60 * 1000),
        },
      });

      // 1. Assert resolveSafe detects expired claim lease and returns status ACTIVE
      const resolveRes = await request(app.getHttpServer())
        .post('/api/chat-handoff/resolve')
        .set('Authorization', `Bearer ${authToken}`)
        .send({ token })
        .expect(200);

      expect(resolveRes.body.status).toBe('ACTIVE');
      expect(resolveRes.body.offer.origin).toBe('SGN');
      expect(resolveRes.body.offer.destination).toBe('HAN');

      // 2. Assert createIntent and tryAcquireClaim successfully acquire new claim and consume handoff
      jest.spyOn(searchAdapter, 'getOffer').mockResolvedValue({
        id: offer.supplierOfferId,
        // The stored fixture supplies the itinerary returned by the supplier.
        slices: (offer.rawOffer as Prisma.JsonObject).slices,
        total_amount: '150.00',
        total_currency: 'USD',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        passengers: [{ id: 'duffel-pas-1', type: 'adult' }],
      });

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          handoffToken: token,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
            },
          ],
        });

      expect(createRes.status).toBe(201);
      expect(createRes.body.intentId).toBeDefined();

      const finalHandoff = await prisma.chatHandoff.findUnique({
        where: { id: handoffId },
      });
      expect(finalHandoff?.consumedAt).not.toBeNull();
      expect(finalHandoff?.consumedByBookingIntentId).toBe(createRes.body.intentId);
    });
  });

  // =========================================================================
  // Drill 3: Redis Disconnect Resilience
  // =========================================================================
  describe('Drill 3: Redis Disconnect Resilience', () => {
    it('CacheService handles Redis connection drop gracefully with in-memory fallback', async () => {
      const redisClient = (cacheService as unknown as { redisClient: any }).redisClient;
      expect(redisClient).toBeDefined();

      // 1. Simulate Redis command failures (connection drop) during SET and GET
      const setSpy = jest
        .spyOn(redisClient, 'set')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));
      const getSpy = jest
        .spyOn(redisClient, 'get')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));

      // Writing when Redis fails should log warning and store in in-memory fallback
      await expect(
        cacheService.set('chaos:redis:disconnect:key', 'resilient_value', 60),
      ).resolves.not.toThrow();

      // Reading when Redis fails should log warning and retrieve from in-memory fallback
      const val = await cacheService.get('chaos:redis:disconnect:key');
      expect(val).toBe('resilient_value');

      // 2. Simulate Redis ping command failure for checkHealth
      const pingSpy = jest
        .spyOn(redisClient, 'ping')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));

      // checkHealth() must execute real ping failure path and return 'down' without unhandled exception
      const healthStatus = await cacheService.checkHealth();
      expect(healthStatus).toBe('down');

      setSpy.mockRestore();
      getSpy.mockRestore();
      pingSpy.mockRestore();
    });

    it('LockoutService and rate limiting handle Redis errors safely without throwing unhandled exceptions', async () => {
      const redisClient = (cacheService as unknown as { redisClient: any }).redisClient;
      expect(redisClient).toBeDefined();

      const testIp = '192.168.1.100';

      // 1. Inject Redis command failures across incr, ttl, del, set, keys
      const incrSpy = jest
        .spyOn(redisClient, 'incr')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));
      const ttlSpy = jest
        .spyOn(redisClient, 'ttl')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));
      const delSpy = jest
        .spyOn(redisClient, 'del')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));
      const setSpy = jest
        .spyOn(redisClient, 'set')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));
      const keysSpy = jest
        .spyOn(redisClient, 'keys')
        .mockRejectedValue(new Error('ECONNREFUSED: Redis connection lost'));

      // Test lockout checks operate gracefully on Redis failure (fallback to in-memory)
      const initialStatus = await lockoutService.isLockedOut(testIp);
      expect(initialStatus.locked).toBe(false);

      // Record failed attempts under Redis failure -> should gracefully fall back to in-memory tracking
      for (let i = 1; i <= 4; i++) {
        const attempt = await lockoutService.recordFailedAttempt(testIp);
        expect(attempt.locked).toBe(false);
        expect(attempt.attempts).toBe(i);
      }

      // 5th attempt triggers lockout via in-memory fallback
      const fifthAttempt = await lockoutService.recordFailedAttempt(testIp);
      expect(fifthAttempt.locked).toBe(true);
      expect(fifthAttempt.retryAfterSeconds).toBeGreaterThan(0);

      // Verify lockout is recognized
      const lockedStatus = await lockoutService.isLockedOut(testIp);
      expect(lockedStatus.locked).toBe(true);
      expect(lockedStatus.retryAfterSeconds).toBeGreaterThan(0);

      // Clear lockout for IP under Redis failure
      await expect(lockoutService.clearLockoutForIp(testIp, false)).resolves.not.toThrow();

      // Verify lockout cleared
      const clearedStatus = await lockoutService.isLockedOut(testIp);
      expect(clearedStatus.locked).toBe(false);

      incrSpy.mockRestore();
      ttlSpy.mockRestore();
      delSpy.mockRestore();
      setSpy.mockRestore();
      keysSpy.mockRestore();
    });
  });
});
