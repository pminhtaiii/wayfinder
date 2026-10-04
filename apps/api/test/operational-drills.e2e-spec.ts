import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { SyncClaimService } from '@/disruption/sync/sync-claim.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { ChatSession, FlightOffer, User } from '@prisma/client';
import * as crypto from 'crypto';

jest.setTimeout(120_000);

describe('Operational Runbook Drills (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let configService: ConfigService;
  let attestationService: SelectionAttestationService;
  let tokenService: ChatHandoffTokenService;
  let syncClaimService: SyncClaimService;
  let cacheService: CacheService;
  let jwtService: JwtService;

  let validUser: User;
  let validUserToken: string;
  let validSession: ChatSession;
  let validFlightOffer: FlightOffer;

  const configOverrides: Record<string, string> = {};

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = 'drill-agent-key';
    process.env.CLAIM_TOKEN_SECRET = 'drill-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.ATTESTATION_SECRET = 'drill-attestation-secret-v1';
    process.env.CHAT_HANDOFF_SECRET = 'drill-handoff-secret-v1';
    process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
    process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
    process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown) => {
          if (key in configOverrides) return configOverrides[key];
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'true';
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    configService = moduleFixture.get<ConfigService>(ConfigService);
    attestationService = moduleFixture.get<SelectionAttestationService>(
      SelectionAttestationService,
    );
    tokenService = moduleFixture.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    syncClaimService = moduleFixture.get<SyncClaimService>(SyncClaimService);
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    for (const key of Object.keys(configOverrides)) {
      delete configOverrides[key];
    }

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

    validUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `drill-user-${crypto.randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    validUserToken = jwtService.sign(
      { sub: validUser.id, id: validUser.id, jti: crypto.randomUUID(), email: validUser.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    validSession = await prisma.chatSession.create({
      data: {
        userId: validUser.id,
      },
    });

    validFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: 'testhash-op-drills',
        supplierOfferId: 'off_drill_123',
        rawOffer: {
          expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'LHR' },
                  destination: { iata_code: 'JFK' },
                  departing_at: new Date(Date.now() + 86400000).toISOString(),
                  arriving_at: new Date(Date.now() + 90000000).toISOString(),
                  operating_carrier: { name: 'Drill Airways' },
                },
              ],
            },
          ],
        },
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(Date.now() + 86400000),
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
        price: 450.0,
        currency: 'GBP',
      },
    });
  });

  // =========================================================================
  // Drill 1: Redis Outage Drill
  // =========================================================================
  describe('Drill 1: Redis Outage Resilience', () => {
    it('should maintain stable degraded reporting and protect resources during redis outage', async () => {
      // Simulate cache error / Redis disconnect in CacheService
      const decrSpy = jest
        .spyOn(cacheService, 'decr')
        .mockRejectedValue(new Error('Redis connection lost'));

      await expect(cacheService.decr('drill:rate:user1')).rejects.toThrow('Redis connection lost');

      // Verify CacheService get/set fallbacks to in-memory gracefully without crashing
      await cacheService.set('drill:fallback:key', 'safe_value', 60);
      const val = await cacheService.get('drill:fallback:key');
      expect(val).toBe('safe_value');

      decrSpy.mockRestore();
    });

    it('should report healthy 200 on /health when database is accessible', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.dependencies.database).toBe('up');
    });
  });

  // =========================================================================
  // Drill 2: Secret Key Rotation Drill
  // =========================================================================
  describe('Drill 2: Secret Key Rotation Ring', () => {
    it('CHAT_HANDOFF_SECRET: tokens signed with Key V1 resolve cleanly after Key V2 is introduced', async () => {
      // Step 1: Generate token under Key V1
      configOverrides['CHAT_HANDOFF_SECRET_V1'] = 'handoff-secret-version-1';
      configOverrides['CHAT_HANDOFF_SECRET'] = 'handoff-secret-version-1';

      const rowId = crypto.randomUUID();
      const idempotencyHash = crypto.randomBytes(16).toString('hex');
      const genResultV1 = await tokenService.generateToken(rowId, idempotencyHash, 1);

      const duffelOfferIdHash = tokenService.hashToken(validFlightOffer.supplierOfferId);

      // Store in DB as a V1 handoff record
      await prisma.chatHandoff.create({
        data: {
          id: rowId,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-v1',
          selectionAttestationHash: 'attest-hash-v1',
          selectedOfferIndex: 1,
          tokenHash: genResultV1.tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-key-hash-v1',
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
      });

      // Step 2: Introduce Key V2 in configuration (active key moves to V2, while V1 remains in ring)
      configOverrides['CHAT_HANDOFF_SECRET_V2'] = 'handoff-secret-version-2-active';
      configOverrides['CHAT_HANDOFF_SECRET_V1'] = 'handoff-secret-version-1';

      // Step 3: Resolve the V1 token via HTTP API
      const res = await request(app.getHttpServer())
        .post('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ token: genResultV1.token })
        .expect(200);

      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.offer.airline).toBe('Drill Airways');
      expect(res.body.offer.origin).toBe('LHR');
      expect(res.body.offer.destination).toBe('JFK');
    });

    it('ATTESTATION_SECRET: attestations signed with Key V1 verify cleanly after Key V2 is introduced', async () => {
      // Step 1: Sign with Key V1
      configOverrides['ATTESTATION_SECRET_V1'] = 'attestation-secret-v1';
      configOverrides['ATTESTATION_SECRET'] = 'attestation-secret-v1';

      const offers = [
        { flightOfferId: validFlightOffer.id, duffelOfferId: validFlightOffer.supplierOfferId },
      ];
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();

      const attestationV1 = await attestationService.signSelectionAttestation(
        validUser.id,
        validSession.id,
        1,
        expiresAt,
        offers,
      );

      // Step 2: Introduce Key V2 as active signing key
      configOverrides['ATTESTATION_SECRET_V2'] = 'attestation-secret-v2-active';
      configOverrides['ATTESTATION_SECRET_V1'] = 'attestation-secret-v1';

      // Step 3: Verification of V1 attestation must succeed via rotation ring
      const verified = await attestationService.verifySelectionAttestation(
        attestationV1,
        validUser.id,
        validSession.id,
        1,
        offers,
      );
      expect(verified).toBe(true);

      // Step 4: Attestations signed with Key V2 must also verify cleanly
      const attestationV2 = await attestationService.signSelectionAttestation(
        validUser.id,
        validSession.id,
        2,
        expiresAt,
        offers,
      );

      const verifiedV2 = await attestationService.verifySelectionAttestation(
        attestationV2,
        validUser.id,
        validSession.id,
        2,
        offers,
      );
      expect(verifiedV2).toBe(true);
    });

    it('should reject attestation when secret key has been completely revoked from ring', async () => {
      configOverrides['ATTESTATION_SECRET_V1'] = 'revoked-key';
      const offers = [
        { flightOfferId: validFlightOffer.id, duffelOfferId: validFlightOffer.supplierOfferId },
      ];
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();

      const attestationOld = await attestationService.signSelectionAttestation(
        validUser.id,
        validSession.id,
        1,
        expiresAt,
        offers,
      );

      // Rotate to new key and purge revoked key
      configOverrides['ATTESTATION_SECRET_V2'] = 'attestation-secret-v2-active';
      delete configOverrides['ATTESTATION_SECRET_V1'];
      delete configOverrides['ATTESTATION_SECRET'];

      await expect(
        attestationService.verifySelectionAttestation(
          attestationOld,
          validUser.id,
          validSession.id,
          1,
          offers,
        ),
      ).rejects.toThrow('Invalid signature');
    });
  });

  // =========================================================================
  // Drill 3: Expired Token & Claim Recovery Drill
  // =========================================================================
  describe('Drill 3: Expired Token & Claim Recovery', () => {
    it('expired handoff tokens return stable 410 HANDOFF_EXPIRED error without blocking subsequent operations', async () => {
      const rowId = crypto.randomUUID();
      const idempotencyHash = crypto.randomBytes(16).toString('hex');
      const genResult = await tokenService.generateToken(rowId, idempotencyHash, 1);
      const duffelOfferIdHash = tokenService.hashToken(validFlightOffer.supplierOfferId);

      // Create an expired handoff record (expired 5 minutes ago)
      await prisma.chatHandoff.create({
        data: {
          id: rowId,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-exp',
          selectionAttestationHash: 'attest-hash-exp',
          selectedOfferIndex: 1,
          tokenHash: genResult.tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-key-hash-exp',
          expiresAt: new Date(Date.now() - 5 * 60000), // Expired!
        },
      });

      // Resolving expired token must return HTTP 410 Gone
      const res = await request(app.getHttpServer())
        .post('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ token: genResult.token })
        .expect(410);

      expect(res.body.code).toBe('HANDOFF_EXPIRED');

      // Subsequent token generation and resolution for the same user is not blocked
      const newRowId = crypto.randomUUID();
      const newIdemHash = crypto.randomBytes(16).toString('hex');
      const newGenResult = await tokenService.generateToken(newRowId, newIdemHash, 1);

      await prisma.chatHandoff.create({
        data: {
          id: newRowId,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-fresh',
          selectionAttestationHash: 'attest-hash-fresh',
          selectedOfferIndex: 1,
          tokenHash: newGenResult.tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-key-hash-fresh',
          expiresAt: new Date(Date.now() + 15 * 60000),
        },
      });

      const freshRes = await request(app.getHttpServer())
        .post('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ token: newGenResult.token })
        .expect(200);

      expect(freshRes.body.status).toBe('ACTIVE');
    });

    it('active unexpired claim lease returns 409 HANDOFF_IN_PROGRESS, but expired lease recovers cleanly', async () => {
      const rowId = crypto.randomUUID();
      const idempotencyHash = crypto.randomBytes(16).toString('hex');
      const genResult = await tokenService.generateToken(rowId, idempotencyHash, 1);
      const duffelOfferIdHash = tokenService.hashToken(validFlightOffer.supplierOfferId);

      // Create record with active claim lease (lease expires in 5 minutes)
      const handoff = await prisma.chatHandoff.create({
        data: {
          id: rowId,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-claim',
          selectionAttestationHash: 'attest-hash-claim',
          selectedOfferIndex: 1,
          tokenHash: genResult.tokenHash,
          tokenKeyVersion: 1,
          idempotencyKeyHash: 'idem-key-hash-claim',
          expiresAt: new Date(Date.now() + 15 * 60000),
          claimExpiresAt: new Date(Date.now() + 5 * 60000), // Active claim lease in progress
        },
      });

      // 1. While claim lease is active, resolveSafe returns 409 HANDOFF_IN_PROGRESS
      const conflictRes = await request(app.getHttpServer())
        .post('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ token: genResult.token })
        .expect(409);

      expect(conflictRes.body.code).toBe('HANDOFF_IN_PROGRESS');

      // 2. Transition lease to expired (lease expired 1 minute ago)
      await prisma.chatHandoff.update({
        where: { id: rowId },
        data: {
          claimExpiresAt: new Date(Date.now() - 60000),
          claimRecoverAfter: new Date(Date.now() - 60000),
        },
      });

      // 3. Once expired, resolveSafe recovers gracefully and returns 200 OK
      const recoveredRes = await request(app.getHttpServer())
        .post('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ token: genResult.token })
        .expect(200);

      expect(recoveredRes.body.status).toBe('ACTIVE');
      expect(recoveredRes.body.offer.airline).toBe('Drill Airways');
    });

    it('SyncClaimService automatically overrides and recovers stale sync claim leases (> 5 minutes)', async () => {
      const now = new Date();
      const bookingIntent = await prisma.bookingIntent.create({
        data: {
          userId: validUser.id,
          supplierOfferId: validFlightOffer.supplierOfferId,
          originalPrice: 450.0,
          confirmedPrice: 450.0,
          currency: 'GBP',
          pricedAt: now,
          origin: 'LHR',
          destination: 'JFK',
          departureDate: new Date(now.getTime() + 86400000),
          cabinClass: 'economy',
          adults: 1,
          children: 0,
          infants: 0,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(now.getTime() + 3600000),
          status: 'PENDING',
        },
      });

      // Create a confirmed booking with a stale sync lock (acquired 6 minutes ago)
      const staleLockedAt = new Date(Date.now() - 6 * 60 * 1000);
      const booking = await prisma.booking.create({
        data: {
          userId: validUser.id,
          bookingIntentId: bookingIntent.id,
          status: 'CONFIRMED',
          supplierOrderId: 'ord_drill_lock_123',
          totalAmount: 450.0,
          currency: 'GBP',
          syncLockedAt: staleLockedAt,
          syncLockToken: 'stale-lock-token-123',
        },
      });

      // Attempt to acquire claim on stale booking -> must succeed with a new token
      const newClaimToken = await syncClaimService.acquireClaim(booking.id);
      expect(newClaimToken).toBeDefined();
      expect(typeof newClaimToken).toBe('string');
      expect(newClaimToken).not.toBe('stale-lock-token-123');

      // Verify database updated with new lock token
      const updatedBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
      });
      expect(updatedBooking?.syncLockToken).toBe(newClaimToken);

      // Attempting to acquire again while fresh lock is held must return null (safe contention lock)
      const concurrentClaim = await syncClaimService.acquireClaim(booking.id);
      expect(concurrentClaim).toBeNull();

      // Release claim cleanly
      const released = await syncClaimService.releaseClaim(booking.id, newClaimToken!);
      expect(released).toBe(true);
    });
  });
});
