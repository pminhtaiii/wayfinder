process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule, envSchema } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DisruptionStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

describe('Disruption Phase 1 (Schema & Config E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Database Schema Constraints', () => {
    let userId: string;
    let bookingIntentId: string;
    let bookingId: string;

    beforeEach(async () => {
      const suffix = crypto.randomUUID();
      const user = await prisma.user.create({
        data: {
          email: `test-disruption-user-${suffix}@example.com`,
          password: 'Password123!',
          role: 'USER',
          status: 'ACTIVE',
        },
      });
      userId = user.id;

      const intent = await prisma.bookingIntent.create({
        data: {
          userId,
          supplierOfferId: `off_fake_${suffix}`,
          originalPrice: new Prisma.Decimal('100.00'),
          confirmedPrice: new Prisma.Decimal('100.00'),
          currency: 'USD',
          pricedAt: new Date(),
          origin: 'HAN',
          destination: 'NRT',
          departureDate: new Date(),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 3600000),
        },
      });
      bookingIntentId = intent.id;

      const booking = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'USD',
          status: 'CONFIRMED',
        },
      });
      bookingId = booking.id;
    });

    afterEach(async () => {
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
    });

    it('should verify disruptionStatus default value is NONE and disruptionNeedsAttention default is false', async () => {
      const b = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(b?.disruptionStatus).toBe(DisruptionStatus.NONE);
      expect(b?.disruptionNeedsAttention).toBe(false);
    });

    it('should enforce unique (bookingId, version) constraint on ItineraryRevision', async () => {
      // Create first revision
      const rev1 = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          version: 1,
          source: 'WEBHOOK',
          fingerprint: 'fp1',
          isMaterial: false,
          incrementalDiff: {},
          cumulativeDiff: {},
        },
      });

      expect(rev1.version).toBe(1);

      // Creating a duplicate version for the same booking must fail
      await expect(
        prisma.itineraryRevision.create({
          data: {
            bookingId,
            version: 1,
            source: 'RECONCILIATION',
            fingerprint: 'fp2',
            isMaterial: true,
            incrementalDiff: {},
            cumulativeDiff: {},
          },
        }),
      ).rejects.toThrow();
    });

    it('should enforce unique revisionId constraint on NotificationOutbox', async () => {
      const rev = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          version: 1,
          source: 'WEBHOOK',
          fingerprint: 'fp1',
          isMaterial: true,
          incrementalDiff: {},
          cumulativeDiff: {},
        },
      });

      // Create first outbox entry
      await prisma.notificationOutbox.create({
        data: {
          bookingId,
          revisionId: rev.id,
          type: 'MATERIAL_DISRUPTION',
          payload: {},
        },
      });

      // Creating a second outbox entry for the same revision must fail
      await expect(
        prisma.notificationOutbox.create({
          data: {
            bookingId,
            revisionId: rev.id,
            type: 'MATERIAL_DISRUPTION',
            payload: {},
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('Environment Configuration Validation', () => {
    it('should have safe defaults for disruption feature flags disabled', () => {
      const configService = app.get<ConfigService>(ConfigService);
      expect(configService.get('FEATURE_FLAG_DISRUPTION_INGRESS')).toBe('false');
      expect(configService.get('FEATURE_FLAG_DISRUPTION_PROCESSOR')).toBe('false');
      expect(configService.get('FEATURE_FLAG_DISRUPTION_RECONCILIATION')).toBe('false');
      expect(configService.get('FEATURE_FLAG_DISRUPTION_SURFACING')).toBe('false');
      expect(configService.get('FEATURE_FLAG_DISRUPTION_OUTBOX')).toBe('false');
    });

    it('should validate missing required Stripe secrets', () => {
      const incompleteConfig = {
        PORT: '3001',
      };

      const result = envSchema.safeParse(incompleteConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.errors.map((e) => e.message);
        expect(errorMessages).toContain('STRIPE_SECRET_KEY is required');
        expect(errorMessages).toContain('STRIPE_WEBHOOK_SECRET is required');
      }
    });

    it('should validate with optional DUFFEL_WEBHOOK_SECRET', () => {
      const completeConfig = {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        DUFFEL_WEBHOOK_SECRET: 'whsec_' + 'duffel_123',
      };

      const result = envSchema.safeParse(completeConfig);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.DUFFEL_WEBHOOK_SECRET).toBe('whsec_' + 'duffel_123');
        expect(result.data.FEATURE_FLAG_DISRUPTION_INGRESS).toBe('false');
      }
    });
  });
});
