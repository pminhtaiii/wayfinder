import { PrismaClient, Prisma, BookingIntentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { BookingProjectionReconciliationService } from '../src/booking-projection/booking-projection-reconciliation.service';
import { BookingProjectionRepository } from '../src/booking-projection/booking-projection.repository';
import { BookingProjectionService } from '../src/booking-projection/booking-projection.service';
import { BookingEventHydratorService } from '../src/domain-events/booking-event-hydrator.service';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Booking & BookingAgentProjection Version Migration (E2E)', () => {
  let prisma: PrismaClient;
  let testUserId: string;
  let testIntentId: string;
  let testBookingId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Create test user
    const user = await prisma.user.create({
      data: {
        email: `migration-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 7)}@example.com`,
        password: 'hash_password_test',
      },
    });
    testUserId = user.id;

    // Create test booking intent
    const intent = await prisma.bookingIntent.create({
      data: {
        userId: testUserId,
        supplierOfferId: `off_test_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('199.99'),
        confirmedPrice: new Prisma.Decimal('199.99'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });
    testIntentId = intent.id;
  });

  afterAll(async () => {
    try {
      if (testBookingId) {
        await prisma.ledgerEntry.deleteMany({
          where: { payment: { bookingIntentId: testIntentId } },
        });
        await prisma.refund.deleteMany({
          where: { payment: { bookingIntentId: testIntentId } },
        });
        await prisma.booking.updateMany({
          where: { id: testBookingId },
          data: { paymentId: null },
        });
        await prisma.payment.deleteMany({
          where: { bookingIntentId: testIntentId },
        });
        await prisma.bookingAgentProjection.deleteMany({
          where: { bookingId: testBookingId },
        });
        await prisma.booking.deleteMany({
          where: { id: testBookingId },
        });
      }
      if (testIntentId) {
        await prisma.bookingIntent.deleteMany({
          where: { id: testIntentId },
        });
      }
      if (testUserId) {
        await prisma.idempotencyKey.deleteMany({
          where: { customerId: testUserId },
        });
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  describe('Default Values Verification', () => {
    it('verifies new Booking row has default version = 1', async () => {
      const booking = await prisma.booking.create({
        data: {
          userId: testUserId,
          bookingIntentId: testIntentId,
          totalAmount: new Prisma.Decimal('199.99'),
          currency: 'GBP',
          status: 'PROCESSING',
          flightSnapshot: {
            stops: 0,
            segments: [
              {
                departureAirport: { iataCode: 'LHR' },
                arrivalAirport: { iataCode: 'JFK' },
                departureAt: '2026-12-01T10:00:00.000Z',
                arrivalAt: '2026-12-01T18:00:00.000Z',
                airline: { name: 'British Airways', iataCode: 'BA' },
                flightNumber: '178',
              },
            ],
          },
        },
      });
      testBookingId = booking.id;

      // Assert Prisma client reads version as 1
      expect(booking.version).toBe(1);

      // Raw SQL verification directly against PostgreSQL
      const rawRows = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "bookings" WHERE "id" = ${booking.id}
      `;
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].version).toBe(1);
    });

    it('verifies new BookingAgentProjection row has default sourceVersion = 0', async () => {
      const agentRef = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const departure = new Date();
      const arrival = new Date(departure.getTime() + 7200000);

      const projection = await prisma.bookingAgentProjection.create({
        data: {
          bookingId: testBookingId,
          agentReference: agentRef,
          status: 'PROCESSING',
          airline: 'British Airways',
          origin: 'LHR',
          destination: 'JFK',
          departureAt: departure,
          arrivalAt: arrival,
          durationMinutes: 480,
          stopCount: 0,
        },
      });

      // Assert Prisma client reads sourceVersion as 0
      expect(projection.sourceVersion).toBe(0);

      // Raw SQL verification directly against PostgreSQL
      const rawRows = await prisma.$queryRaw<Array<{ source_version: number }>>`
        SELECT "source_version" FROM "booking_agent_projections" WHERE "bookingId" = ${testBookingId}
      `;
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].source_version).toBe(0);
    });

    it('verifies PostgreSQL column defaults apply when inserted via raw SQL without specifying version columns', async () => {
      // Create another booking intent for raw SQL insertion
      const secondIntent = await prisma.bookingIntent.create({
        data: {
          userId: testUserId,
          supplierOfferId: `off_raw_${randomUUID()}`,
          status: BookingIntentStatus.COMPLETED,
          originalPrice: new Prisma.Decimal('299.99'),
          confirmedPrice: new Prisma.Decimal('299.99'),
          pricedAt: new Date(),
          intentExpiresAt: new Date(Date.now() + 3600000),
          origin: 'CDG',
          destination: 'JFK',
          departureDate: new Date(),
          adults: 1,
          rawOfferSnapshot: {},
        },
      });

      const rawBookingId = randomUUID();
      await prisma.$executeRaw`
        INSERT INTO "bookings" ("id", "userId", "bookingIntentId", "totalAmount", "currency", "status", "updatedAt")
        VALUES (${rawBookingId}, ${testUserId}, ${secondIntent.id}, 299.99, 'GBP', 'PROCESSING', NOW())
      `;

      const rawBookingRows = await prisma.$queryRaw<Array<{ version: number }>>`
        SELECT "version" FROM "bookings" WHERE "id" = ${rawBookingId}
      `;
      expect(rawBookingRows[0].version).toBe(1);

      const rawAgentRef = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await prisma.$executeRaw`
        INSERT INTO "booking_agent_projections" (
          "bookingId", "agentReference", "status", "airline", "origin", "destination",
          "departureAt", "arrivalAt", "durationMinutes", "stopCount", "updatedAt"
        )
        VALUES (
          ${rawBookingId}, ${rawAgentRef}, 'CONFIRMED', 'Air France', 'CDG', 'JFK',
          NOW(), NOW() + INTERVAL '8 hours', 480, 0, NOW()
        )
      `;

      const rawProjRows = await prisma.$queryRaw<Array<{ source_version: number }>>`
        SELECT "source_version" FROM "booking_agent_projections" WHERE "bookingId" = ${rawBookingId}
      `;
      expect(rawProjRows[0].source_version).toBe(0);

      // Cleanup raw test records
      await prisma.bookingAgentProjection.delete({ where: { bookingId: rawBookingId } });
      await prisma.booking.delete({ where: { id: rawBookingId } });
      await prisma.bookingIntent.delete({ where: { id: secondIntent.id } });
    });
  });

  describe('Foreign Key & Relation Preservation', () => {
    it('verifies existing foreign keys and one-to-one references are preserved with new columns present', async () => {
      // Query booking with relations
      const bookingWithRelations = await prisma.booking.findUnique({
        where: { id: testBookingId },
        include: {
          user: true,
          bookingIntent: true,
          agentProjection: true,
        },
      });

      expect(bookingWithRelations).not.toBeNull();
      expect(bookingWithRelations!.userId).toBe(testUserId);
      expect(bookingWithRelations!.user.id).toBe(testUserId);
      expect(bookingWithRelations!.bookingIntentId).toBe(testIntentId);
      expect(bookingWithRelations!.bookingIntent.id).toBe(testIntentId);
      expect(bookingWithRelations!.agentProjection).not.toBeNull();
      expect(bookingWithRelations!.agentProjection!.bookingId).toBe(testBookingId);
      expect(bookingWithRelations!.version).toBe(1);
      expect(bookingWithRelations!.agentProjection!.sourceVersion).toBe(0);

      // Query reverse relation from projection to booking
      const projectionWithBooking = await prisma.bookingAgentProjection.findUnique({
        where: { bookingId: testBookingId },
        include: {
          booking: {
            include: {
              user: true,
            },
          },
        },
      });

      expect(projectionWithBooking).not.toBeNull();
      expect(projectionWithBooking!.booking.id).toBe(testBookingId);
      expect(projectionWithBooking!.booking.user.id).toBe(testUserId);
      expect(projectionWithBooking!.sourceVersion).toBe(0);
      expect(projectionWithBooking!.booking.version).toBe(1);
    });
  });

  describe('Legacy-Writer Compatibility Fixture', () => {
    it('verifies that updates omitting version leave Booking.version intact, unchanged (1), and valid', async () => {
      // 1. Prisma update without version field (simulating legacy service updating booking)
      const updatedViaPrisma = await prisma.booking.update({
        where: { id: testBookingId },
        data: {
          status: 'CONFIRMED',
          pnrReference: 'LEGACY-PNR-001',
          supplierOrderId: 'ord_legacy_test',
        },
      });

      expect(updatedViaPrisma.status).toBe('CONFIRMED');
      expect(updatedViaPrisma.pnrReference).toBe('LEGACY-PNR-001');
      // version must remain intact and unchanged at 1
      expect(updatedViaPrisma.version).toBe(1);

      // 2. Raw SQL update without touching "version" column (simulating pure legacy SQL writer)
      await prisma.$executeRaw`
        UPDATE "bookings"
        SET "cancellationRefundable" = true, "updatedAt" = NOW()
        WHERE "id" = ${testBookingId}
      `;

      const queriedAfterRawUpdate = await prisma.booking.findUniqueOrThrow({
        where: { id: testBookingId },
      });

      expect(queriedAfterRawUpdate.cancellationRefundable).toBe(true);
      expect(queriedAfterRawUpdate.version).toBe(1);

      // 3. Raw SQL projection update without touching "source_version" column
      await prisma.$executeRaw`
        UPDATE "booking_agent_projections"
        SET "status" = 'CONFIRMED', "flightNumber" = 'BA178', "updatedAt" = NOW()
        WHERE "bookingId" = ${testBookingId}
      `;

      const queriedProjAfterRaw = await prisma.bookingAgentProjection.findUniqueOrThrow({
        where: { bookingId: testBookingId },
      });

      expect(queriedProjAfterRaw.status).toBe('CONFIRMED');
      expect(queriedProjAfterRaw.flightNumber).toBe('BA178');
      expect(queriedProjAfterRaw.sourceVersion).toBe(0);

      // 4. Link Payment, Refund, and LedgerEntry to verify they remain completely untouched by reconciliation
      const paymentIdem = await prisma.idempotencyKey.create({
        data: {
          key: `idem-pay-${randomUUID()}`,
          requestHash: randomUUID(),
          customerId: testUserId,
          requestPath: '/api/bookings/payment/confirm',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: testIntentId,
          attemptNumber: 1,
          idempotencyKeyId: paymentIdem.id,
          stripePaymentIntentId: `pi_test_${randomUUID().replace(/-/g, '')}`,
          amount: 19999,
          currency: 'GBP',
          status: 'SUCCEEDED',
          version: 0,
        },
      });

      await prisma.booking.update({
        where: { id: testBookingId },
        data: { paymentId: payment.id },
      });

      const refundIdem = await prisma.idempotencyKey.create({
        data: {
          key: `idem-ref-${randomUUID()}`,
          requestHash: randomUUID(),
          customerId: testUserId,
          requestPath: '/api/bookings/payment/refund',
          expiresAt: new Date(Date.now() + 86400000),
        },
      });

      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: refundIdem.id,
          stripeRefundId: `re_test_${randomUUID().replace(/-/g, '')}`,
          amount: 5000,
          currency: 'GBP',
          triggerType: 'SYSTEM_AUTOMATED',
          status: 'SUCCEEDED',
        },
      });

      const ledgerEntry = await prisma.ledgerEntry.create({
        data: {
          paymentId: payment.id,
          refundTransactionId: refund.id,
          transactionId: `tx_${randomUUID()}`,
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: 'CREDIT',
          amount: 5000,
          currency: 'GBP',
        },
      });

      // Record state of payment, refund, ledgerEntry, and projection before reconciliation
      const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const refundBefore = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      const ledgerBefore = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: ledgerEntry.id } });
      const projectionBefore = await prisma.bookingAgentProjection.findUniqueOrThrow({
        where: { bookingId: testBookingId },
      });
      const recordedAgentRef = projectionBefore.agentReference;

      // Reset projection freshness: source_version = 0
      await prisma.$executeRaw`
        UPDATE "booking_agent_projections"
        SET "source_version" = 0
        WHERE "bookingId" = ${testBookingId}
      `;

      const projAfterReset = await prisma.bookingAgentProjection.findUniqueOrThrow({
        where: { bookingId: testBookingId },
      });
      expect(projAfterReset.sourceVersion).toBe(0);

      // Trigger a reconciliation pass using BookingProjectionReconciliationService
      const repo = new BookingProjectionRepository(prisma as unknown as PrismaService);
      const projService = new BookingProjectionService();
      const hydrator = new BookingEventHydratorService(prisma as unknown as PrismaService);
      const reconciliationService = new BookingProjectionReconciliationService(
        repo,
        projService,
        hydrator,
      );

      const passSummary = await reconciliationService.reconcileBatch();
      expect(passSummary).not.toBeNull();
      expect(passSummary!.repaired).toBeGreaterThanOrEqual(1);

      // Verify projection repaired cleanly to booking.version with stable agentReference
      const repairedProjection = await prisma.bookingAgentProjection.findUniqueOrThrow({
        where: { bookingId: testBookingId },
      });
      const currentBooking = await prisma.booking.findUniqueOrThrow({
        where: { id: testBookingId },
      });

      expect(repairedProjection.sourceVersion).toBe(currentBooking.version);
      expect(repairedProjection.agentReference).toBe(recordedAgentRef);
      expect(repairedProjection.status).toBe(currentBooking.status);

      // Assert payments, refunds, and ledger_entries remain completely unmodified
      const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const refundAfter = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
      const ledgerAfter = await prisma.ledgerEntry.findUniqueOrThrow({ where: { id: ledgerEntry.id } });

      expect(paymentAfter).toEqual(paymentBefore);
      expect(refundAfter).toEqual(refundBefore);
      expect(ledgerAfter).toEqual(ledgerBefore);
    });
  });
});
