import * as crypto from 'crypto';

process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.CHAT_HANDOFF_SECRET = 'phase11e-drift-sentinel-secret-32b!';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DataDriftSentinelService } from '@/common/sentinel/data-drift-sentinel.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma } from '@prisma/client';

describe('Phase 11E: Data-Quality & State Drift Sentinel (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let sentinel: DataDriftSentinelService;

  let testUser: { id: string; email: string };
  let testSession: { id: string };
  let testFlightOffer: { id: string };

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
    sentinel = moduleFixture.get<DataDriftSentinelService>(DataDriftSentinelService);

    // Setup base entities
    const suffix = crypto.randomBytes(4).toString('hex');
    testUser = await prisma.user.create({
      data: {
        email: `drift-user-${suffix}@test.com`,
        password: 'hashed_password',
        status: 'ACTIVE',
      },
    });

    testSession = await prisma.chatSession.create({
      data: {
        userId: testUser.id,
      },
    });

    testFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: `sh_${suffix}`,
        supplierOfferId: `off_drift_${suffix}`,
        rawOffer: {},
        origin: 'JFK',
        destination: 'LHR',
        departureDate: new Date(Date.now() + 86400000),
        adults: 1,
        price: new Prisma.Decimal(500.0),
        currency: 'USD',
      },
    });
  });

  afterAll(async () => {
    // Cleanup created data
    if (testSession?.id) {
      await prisma.chatMessage.deleteMany({ where: { sessionId: testSession.id } }).catch(() => {});
      await prisma.chatHandoff
        .deleteMany({ where: { chatSessionId: testSession.id } })
        .catch(() => {});
      await prisma.chatSession.deleteMany({ where: { id: testSession.id } }).catch(() => {});
    }
    if (testFlightOffer?.id) {
      await prisma.flightOffer.deleteMany({ where: { id: testFlightOffer.id } }).catch(() => {});
    }
    if (testUser?.id) {
      await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    }
    await app.close();
  });

  describe('Dangling Claim Detection & Atomic Auto-Healing', () => {
    it('detects dangling expired claims and resets them atomically to clean unreserved state', async () => {
      const now = new Date();
      const expiredPast = new Date(now.getTime() - 10000);

      // Create dangling handoff #1: claimExpiresAt in past
      const danglingHandoff1 = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp1',
          selectionAttestationHash: 'att1',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(now.getTime() + 600000),
          claimedAt: new Date(now.getTime() - 30000),
          claimTokenHash: crypto.randomBytes(16).toString('hex'),
          claimExpiresAt: expiredPast,
          claimRecoverAfter: expiredPast,
          consumedAt: null,
          consumedByBookingIntentId: null,
        },
      });

      // Create dangling handoff #2: claimRecoverAfter in past
      const danglingHandoff2 = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp2',
          selectionAttestationHash: 'att2',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(now.getTime() + 600000),
          claimedAt: new Date(now.getTime() - 30000),
          claimTokenHash: crypto.randomBytes(16).toString('hex'),
          claimExpiresAt: new Date(now.getTime() + 10000),
          claimRecoverAfter: expiredPast,
          consumedAt: null,
          consumedByBookingIntentId: null,
        },
      });

      // Create active valid claimed handoff (not expired yet)
      const validClaimedHandoff = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp3',
          selectionAttestationHash: 'att3',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(now.getTime() + 600000),
          claimedAt: now,
          claimTokenHash: 'valid-claim-token-hash',
          claimExpiresAt: new Date(now.getTime() + 60000),
          claimRecoverAfter: new Date(now.getTime() + 65000),
          consumedAt: null,
          consumedByBookingIntentId: null,
        },
      });

      const healingResult = await sentinel.detectAndHealDanglingClaims(now);

      expect(healingResult.healedCount).toBeGreaterThanOrEqual(2);
      expect(healingResult.healedIds).toContain(danglingHandoff1.id);
      expect(healingResult.healedIds).toContain(danglingHandoff2.id);
      expect(healingResult.healedIds).not.toContain(validClaimedHandoff.id);

      // Verify records in DB
      const healed1 = await prisma.chatHandoff.findUnique({ where: { id: danglingHandoff1.id } });
      expect(healed1?.claimedAt).toBeNull();
      expect(healed1?.claimTokenHash).toBeNull();
      expect(healed1?.claimExpiresAt).toBeNull();
      expect(healed1?.claimRecoverAfter).toBeNull();

      const healed2 = await prisma.chatHandoff.findUnique({ where: { id: danglingHandoff2.id } });
      expect(healed2?.claimedAt).toBeNull();
      expect(healed2?.claimTokenHash).toBeNull();
      expect(healed2?.claimExpiresAt).toBeNull();
      expect(healed2?.claimRecoverAfter).toBeNull();

      const untouched = await prisma.chatHandoff.findUnique({
        where: { id: validClaimedHandoff.id },
      });
      expect(untouched?.claimTokenHash).toBe('valid-claim-token-hash');
    });
  });

  describe('Consumed Handoff Integrity Sentinel', () => {
    it('passes when 100% of consumed handoffs are linked to valid BookingIntents', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: testUser.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferId: `off_intent_${crypto.randomUUID()}`,
          originalPrice: new Prisma.Decimal(500),
          confirmedPrice: new Prisma.Decimal(500),
          currency: 'USD',
          status: 'PENDING',
          pricedAt: new Date(),
          origin: 'JFK',
          destination: 'LHR',
          departureDate: new Date(Date.now() + 86400000),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 600000),
        },
      });

      const consumedHandoff = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-c1',
          selectionAttestationHash: 'att-c1',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(Date.now() + 600000),
          consumedAt: new Date(),
          consumedByBookingIntentId: intent.id,
        },
      });

      const integrity = await sentinel.verifyConsumedHandoffIntegrity();
      expect(integrity.valid).toBe(true);
      expect(integrity.unlinkedConsumedCount).toBe(0);
      expect(integrity.totalConsumedCount).toBeGreaterThanOrEqual(1);

      // Cleanup
      await prisma.chatHandoff.delete({ where: { id: consumedHandoff.id } });
      await prisma.bookingIntent.delete({ where: { id: intent.id } });
    });

    it('detects and flags drift if an unlinked consumed handoff exists', async () => {
      const unlinkedConsumed = await prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferIdHash: crypto.randomBytes(16).toString('hex'),
          snapshotVersion: 1,
          snapshotFingerprint: 'fp-c2',
          selectionAttestationHash: 'att-c2',
          selectedOfferIndex: 1,
          tokenHash: crypto.randomBytes(16).toString('hex'),
          tokenKeyVersion: 1,
          idempotencyKeyHash: crypto.randomBytes(16).toString('hex'),
          expiresAt: new Date(Date.now() + 600000),
          consumedAt: new Date(),
          consumedByBookingIntentId: null, // Drift condition
        },
      });

      const integrity = await sentinel.verifyConsumedHandoffIntegrity();
      expect(integrity.valid).toBe(false);
      expect(integrity.unlinkedConsumedCount).toBeGreaterThanOrEqual(1);

      // Cleanup
      await prisma.chatHandoff.delete({ where: { id: unlinkedConsumed.id } });
    });
  });

  describe('Booking Projection 1:1 Sync Sentinel', () => {
    it('passes when all confirmed/cancelled bookings have projections', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: testUser.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferId: `off_intent_bk_${crypto.randomUUID()}`,
          originalPrice: new Prisma.Decimal(500),
          confirmedPrice: new Prisma.Decimal(500),
          currency: 'USD',
          status: 'PENDING',
          pricedAt: new Date(),
          origin: 'JFK',
          destination: 'LHR',
          departureDate: new Date(Date.now() + 86400000),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 600000),
        },
      });

      const booking = await prisma.booking.create({
        data: {
          userId: testUser.id,
          bookingIntentId: intent.id,
          status: 'CONFIRMED',
          totalAmount: new Prisma.Decimal(500),
          currency: 'USD',
          pnrReference: `REF_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        },
      });

      const projection = await prisma.bookingAgentProjection.create({
        data: {
          bookingId: booking.id,
          agentReference: `bkref_${crypto.randomUUID()}`,
          status: 'CONFIRMED',
          airline: 'Sentinel Air',
          origin: 'JFK',
          destination: 'LHR',
          departureAt: new Date(),
          arrivalAt: new Date(Date.now() + 3600000),
          durationMinutes: 420,
          stopCount: 0,
        },
      });

      const syncResult = await sentinel.verifyBookingProjectionSync();
      expect(syncResult.valid).toBe(true);
      expect(syncResult.missingProjectionCount).toBe(0);

      // Cleanup
      await prisma.bookingAgentProjection.delete({ where: { bookingId: booking.id } });
      await prisma.booking.delete({ where: { id: booking.id } });
      await prisma.bookingIntent.delete({ where: { id: intent.id } });
    });

    it('detects and flags drift when a confirmed/cancelled booking is missing its projection', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: testUser.id,
          flightOfferId: testFlightOffer.id,
          supplierOfferId: `off_intent_drift_${crypto.randomUUID()}`,
          originalPrice: new Prisma.Decimal(600),
          confirmedPrice: new Prisma.Decimal(600),
          currency: 'USD',
          status: 'PENDING',
          pricedAt: new Date(),
          origin: 'JFK',
          destination: 'LHR',
          departureDate: new Date(Date.now() + 86400000),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 600000),
        },
      });

      const driftedBooking = await prisma.booking.create({
        data: {
          userId: testUser.id,
          bookingIntentId: intent.id,
          status: 'CONFIRMED',
          totalAmount: new Prisma.Decimal(600),
          currency: 'USD',
          pnrReference: `DRIFT_${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        },
      });

      const syncResult = await sentinel.verifyBookingProjectionSync();
      expect(syncResult.valid).toBe(false);
      expect(syncResult.missingProjectionCount).toBeGreaterThanOrEqual(1);

      // Cleanup
      await prisma.booking.delete({ where: { id: driftedBooking.id } });
      await prisma.bookingIntent.delete({ where: { id: intent.id } });
    });
  });

  describe('runFullDriftSentinelAudit aggregate telemetry', () => {
    it('executes full audit and returns aggregate status', async () => {
      const audit = await sentinel.runFullDriftSentinelAudit();
      expect(audit).toHaveProperty('timestamp');
      expect(audit).toHaveProperty('danglingClaims');
      expect(audit).toHaveProperty('consumedHandoffIntegrity');
      expect(audit).toHaveProperty('bookingProjectionSync');
      expect(audit).toHaveProperty('healthy');
      expect(typeof audit.healthy).toBe('boolean');
    });
  });
});
