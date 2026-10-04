process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  BookingStatus,
  PaymentStatus,
  RefundStatus,
  RefundTriggerType,
  LedgerEntryType,
  Prisma,
} from '@prisma/client';
import type Stripe from 'stripe';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { backfillCancellationRefundObligations } from '../prisma/scripts/backfill-cancellation-refund-obligations';

const MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260822000000_cancellation_refund_obligation_expand/migration.sql',
);
const CONTRACT_MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260823000000_refund_obligation_contract/migration.sql',
);
const CONTRACT_MIGRATION_NAME = '20260823000000_refund_obligation_contract';

function assertDisposableDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    (!/(test|e2e|flight_booking)/i.test(databaseUrl) && process.env.NODE_ENV !== 'test')
  ) {
    throw new Error(
      'This migration E2E temporarily changes schema and may only run against an explicitly named disposable test/e2e database.',
    );
  }
}

async function executeSqlScript(sql: string): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to execute migration SQL batches.');
  }

  const prismaCliPath = require.resolve('prisma/build/index.js');
  const prismaProcess = spawn(
    process.execPath,
    [prismaCliPath, 'db', 'execute', '--stdin', '--url', databaseUrl],
    {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: '1',
        PRISMA_TELEMETRY_INFORMATION: '0',
        PRISMA_HIDE_UPDATE_MESSAGE: 'true',
        NODE_OPTIONS: '',
      },
    },
  );
  let stderr = '';
  let processError: Error | undefined;
  prismaProcess.stderr.on('data', (chunk: Buffer | string): void => {
    stderr += chunk.toString();
  });
  prismaProcess.once('error', (error: Error): void => {
    processError = error;
  });
  prismaProcess.stdin.end(sql);

  await new Promise<void>((resolve, reject) => {
    prismaProcess.once('close', (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (processError) {
        reject(new Error(`Prisma db execute could not start: ${processError.message}`));
      } else if (exitCode === 0) {
        resolve();
      } else {
        const termination = signal ? ` (terminated by ${signal})` : '';
        reject(
          new Error(
            `Prisma db execute failed with exit code ${String(exitCode)}${termination}: ${stderr.trim() || 'No stderr output was produced.'}`,
          ),
        );
      }
    });
  });
}

async function revertMigration(prisma: PrismaService) {
  const statements = [
    'ALTER TABLE "ledger_entries" DROP CONSTRAINT IF EXISTS "ledger_entries_refundTransactionId_fkey"',
    'DROP INDEX IF EXISTS "ledger_entries_refundTransactionId_accountId_entryType_key"',
    'DROP INDEX IF EXISTS "ledger_entries_refundTransactionId_idx"',
    'ALTER TABLE "ledger_entries" DROP COLUMN IF EXISTS "refundTransactionId"',
    'ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_cancellationRefundObligationId_fkey"',
    'DROP INDEX IF EXISTS "refunds_cancellationRefundObligationId_idx"',
    'ALTER TABLE "refunds" DROP COLUMN IF EXISTS "cancellationRefundObligationId"',
    'DROP TABLE IF EXISTS "cancellation_refund_obligations" CASCADE',
  ];
  for (const stmt of statements) {
    await prisma.$executeRawUnsafe(stmt);
  }
}

async function applyMigration(prisma: PrismaService) {
  const migrationSql = fs.readFileSync(MIGRATION_PATH, 'utf-8');
  // A migration can contain PostgreSQL DO $$ blocks with internal semicolons.
  // Execute the exact file as one batch rather than parsing SQL in JavaScript.
  await executeSqlScript(migrationSql);
}

async function restoreLegacyContractSurface() {
  await executeSqlScript(`
    BEGIN;
    ALTER TABLE "refunds"
      DROP CONSTRAINT IF EXISTS "refunds_cancellation_refund_obligation_required";
    ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS "refunds_bookingId_key" ON "refunds"("bookingId");
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT FROM pg_constraint
        WHERE conrelid = '"refunds"'::regclass
          AND conname = 'refunds_bookingId_fkey'
      ) THEN
        ALTER TABLE "refunds"
          ADD CONSTRAINT "refunds_bookingId_fkey"
          FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
          ON DELETE SET NULL ON UPDATE CASCADE;
      END IF;
    END $$;
    COMMIT;
  `);
}

async function assertContractMigrationRecorded(prisma: PrismaService): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (
      SELECT FROM "_prisma_migrations"
      WHERE migration_name = '${CONTRACT_MIGRATION_NAME}'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    ) AS "exists";
  `);
  if (!rows[0]?.exists) {
    throw new Error(
      `This migration E2E requires ${CONTRACT_MIGRATION_NAME} to be applied before it restores the legacy test surface.`,
    );
  }
}

async function restoreContractMigrationHead(prisma: PrismaService): Promise<void> {
  const expandTable = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = 'cancellation_refund_obligations'
    ) AS "exists";
  `);
  if (!expandTable[0]?.exists) {
    await applyMigration(prisma);
  }
  const bookingIdColumn = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
    SELECT EXISTS (
      SELECT FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'refunds'
        AND column_name = 'bookingId'
    ) AS "exists";
  `);
  if (bookingIdColumn[0]?.exists) {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_cancellation_refund_obligation_required"',
    );
    await executeSqlScript(fs.readFileSync(CONTRACT_MIGRATION_PATH, 'utf-8'));
  }
  await assertContractMigrationRecorded(prisma);
}

describe('CancellationRefundObligation Migration & Backfill (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let stripeService: StripeService;
  let paymentRefundService: PaymentRefundService;

  let testUser: { id: string; email: string };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
    stripeService = moduleFixture.get<StripeService>(StripeService);
    paymentRefundService = moduleFixture.get<PaymentRefundService>(PaymentRefundService);

    assertDisposableDatabase();
    await assertContractMigrationRecorded(prisma);
    // The scenarios deliberately exercise the expand migration and legacy
    // Refund.bookingId relation, starting from the current contract head.
    await restoreLegacyContractSurface();
  });

  afterAll(async () => {
    try {
      await clearDisposableDatabase();
      await restoreContractMigrationHead(prisma);
    } finally {
      await app.close();
    }
  });

  async function clearDisposableDatabase(): Promise<void> {
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    try {
      await prisma.cancellationRefundObligation.deleteMany({});
    } catch {
      // Ignored if table temporarily dropped
    }
    await prisma.seatSelection.deleteMany({});
    await prisma.baggageSelectionSegment.deleteMany({});
    await prisma.baggageSelection.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.ancillarySelection.deleteMany({});
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
  }

  beforeEach(async () => {
    await clearDisposableDatabase();

    const user = await prisma.user.create({
      data: {
        email: `user-migration-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    testUser = { id: user.id, email: user.email };
  });

  async function createFlightOffer() {
    return prisma.flightOffer.create({
      data: {
        searchHash: `search-${crypto.randomUUID()}`,
        supplierOfferId: `off_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100.0),
        currency: 'USD',
      },
    });
  }

  async function createBookingIntent(userId: string, flightOfferId: string) {
    return prisma.bookingIntent.create({
      data: {
        userId,
        flightOfferId,
        supplierOfferId: `off_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        status: 'CONFIRMED',
        originalPrice: new Prisma.Decimal(100.0),
        confirmedPrice: new Prisma.Decimal(100.0),
        currency: 'USD',
        priceChanged: false,
        pricedAt: new Date(),
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-08-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
        paymentAttemptCount: 1,
      },
    });
  }

  async function createIdempotencyKey(userId: string, keyPrefix = 'migration-e2e') {
    return prisma.idempotencyKey.create({
      data: {
        key: `${keyPrefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        requestHash: crypto.randomBytes(16).toString('hex'),
        customerId: userId,
        requestPath: '/api/bookings/payment/refund',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  }

  async function createPayment(
    bookingIntentId: string,
    idempotencyKeyId: string,
    overrides: Partial<{
      stripePaymentIntentId: string;
      amount: number;
      currency: string;
      status: PaymentStatus;
    }> = {},
  ) {
    return prisma.payment.create({
      data: {
        bookingIntentId,
        attemptNumber: 1,
        idempotencyKeyId,
        stripePaymentIntentId: `pi_mig_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
        version: 0,
        ...overrides,
      },
    });
  }

  async function createBooking(
    userId: string,
    bookingIntentId: string,
    paymentId: string,
    overrides: Partial<{
      status: BookingStatus;
      totalAmount: Prisma.Decimal;
      customerRefundAmount: Prisma.Decimal;
      airlineRefundAmount: Prisma.Decimal;
      currency: string;
    }> = {},
  ) {
    return prisma.booking.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        bookingIntentId,
        paymentId,
        totalAmount: new Prisma.Decimal(100.0),
        currency: 'USD',
        status: BookingStatus.PROCESSING,
        ...overrides,
      },
    });
  }

  describe('Scenario 0: Pre-Migration Legacy Schema Upgrade Boundary & DDL Verification', () => {
    it('applies DDL migration to pre-existing legacy database rows, verifies non-null defaults / constraints, and runs backfill end-to-end', async () => {
      // 1. Revert schema to pre-migration state (simulate pre-migration PostgreSQL database)
      await revertMigration(prisma);

      // Verify pre-migration state: table and new columns do NOT exist
      const tableCheck = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'cancellation_refund_obligations'
        );
      `);
      expect(tableCheck[0].exists).toBe(false);

      const refundColCheck = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'refunds' AND column_name = 'cancellationRefundObligationId'
        );
      `);
      expect(refundColCheck[0].exists).toBe(false);

      const ledgerColCheck = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns 
          WHERE table_name = 'ledger_entries' AND column_name = 'refundTransactionId'
        );
      `);
      expect(ledgerColCheck[0].exists).toBe(false);

      // 2. Insert pre-migration legacy database fixtures using raw SQL (legacy schema only)
      const legacyOfferId = crypto.randomUUID();
      const legacyIntentId = crypto.randomUUID();
      const legacyPayIdemId = crypto.randomUUID();
      const legacyPaymentId = crypto.randomUUID();
      const legacyBookingId = crypto.randomUUID();
      const legacyRefundIdemId = crypto.randomUUID();
      const legacyRefundId = crypto.randomUUID();
      const legacyTxId = `tx_legacy_${crypto.randomUUID()}`;
      const legacyPayTxId = `tx_pay_auth_${crypto.randomUUID()}`;

      // Insert Flight Offer
      await prisma.$executeRawUnsafe(`
        INSERT INTO "flight_offers" ("id", "searchHash", "duffelOfferId", "rawOffer", "origin", "destination", "departureDate", "adults", "children", "infants", "cabin_class", "price", "currency", "createdAt")
        VALUES ('${legacyOfferId}', 'search-legacy', 'off_legacy_${Date.now()}', '{}'::jsonb, 'SGN', 'HAN', '2027-08-01'::date, 1, 0, 0, 'economy', 150.00, 'USD', NOW());
      `);

      // Insert Booking Intent
      await prisma.$executeRawUnsafe(`
        INSERT INTO "booking_intents" ("id", "userId", "flightOfferId", "duffelOfferId", "status", "originalPrice", "confirmedPrice", "currency", "priceChanged", "pricedAt", "origin", "destination", "departureDate", "cabinClass", "adults", "children", "infants", "rawOfferSnapshot", "intentExpiresAt", "paymentAttemptCount", "createdAt", "updatedAt")
        VALUES ('${legacyIntentId}', '${testUser.id}', '${legacyOfferId}', 'off_legacy_${Date.now()}', 'CONFIRMED'::"BookingIntentStatus", 150.00, 150.00, 'USD', false, NOW(), 'SGN', 'HAN', '2027-08-01'::date, 'economy', 1, 0, 0, '{}'::jsonb, NOW() + INTERVAL '1 hour', 1, NOW(), NOW());
      `);

      // Insert Payment Idempotency Key
      await prisma.$executeRawUnsafe(`
        INSERT INTO "idempotency_keys" ("id", "key", "requestHash", "customerId", "requestPath", "recoveryPoint", "createdAt", "expiresAt")
        VALUES ('${legacyPayIdemId}', 'sc0-pay:${Date.now()}', '${crypto.randomBytes(16).toString('hex')}', '${testUser.id}', '/api/bookings/payment', 'completed', NOW(), NOW() + INTERVAL '1 day');
      `);

      // Insert Payment
      await prisma.$executeRawUnsafe(`
        INSERT INTO "payments" ("id", "bookingIntentId", "attemptNumber", "idempotencyKeyId", "stripePaymentIntentId", "amount", "currency", "status", "version", "createdAt", "updatedAt")
        VALUES ('${legacyPaymentId}', '${legacyIntentId}', 1, '${legacyPayIdemId}', 'pi_legacy_${Date.now()}', 15000, 'USD', 'SUCCEEDED'::"PaymentStatus", 0, NOW(), NOW());
      `);

      // Insert Legacy Booking with Decimal amounts
      await prisma.$executeRawUnsafe(`
        INSERT INTO "bookings" ("id", "userId", "bookingIntentId", "paymentId", "totalAmount", "customerRefundAmount", "airlineRefundAmount", "currency", "status", "createdAt", "updatedAt")
        VALUES ('${legacyBookingId}', '${testUser.id}', '${legacyIntentId}', '${legacyPaymentId}', 150.00, 123.45, 100.00, 'USD', 'CANCELLED_AND_REFUNDED'::"BookingStatus", NOW(), NOW());
      `);

      // Insert Refund Idempotency Key
      await prisma.$executeRawUnsafe(`
        INSERT INTO "idempotency_keys" ("id", "key", "requestHash", "customerId", "requestPath", "recoveryPoint", "createdAt", "expiresAt")
        VALUES ('${legacyRefundIdemId}', 'sc0-ref:${Date.now()}', '${crypto.randomBytes(16).toString('hex')}', '${testUser.id}', '/api/bookings/payment/refund', 'started', NOW(), NOW() + INTERVAL '1 day');
      `);

      // Insert Legacy Refund (without cancellationRefundObligationId)
      await prisma.$executeRawUnsafe(`
        INSERT INTO "refunds" ("id", "paymentId", "bookingId", "idempotencyKeyId", "stripeRefundId", "amount", "currency", "status", "triggerType", "requiresReview", "retryCount", "createdAt", "updatedAt")
        VALUES ('${legacyRefundId}', '${legacyPaymentId}', '${legacyBookingId}', '${legacyRefundIdemId}', 're_legacy_upgrade_${Date.now()}', 12345, 'USD', 'SUCCEEDED'::"RefundStatus", 'SYSTEM_AUTOMATED'::"RefundTriggerType", false, 0, NOW(), NOW());
      `);

      // Insert Legacy Ledger Entries (including both initial payment entries and refund reversal entries with duplicate (accountId, entryType))
      await prisma.$executeRawUnsafe(`
        INSERT INTO "ledger_entries" ("id", "paymentId", "transactionId", "accountId", "entryType", "amount", "currency", "createdAt")
        VALUES
          ('${crypto.randomUUID()}', '${legacyPaymentId}', '${legacyPayTxId}', 'PLATFORM_REVENUE', 'CREDIT'::"LedgerEntryType", 15000, 'USD', NOW() - INTERVAL '1 minute'),
          ('${crypto.randomUUID()}', '${legacyPaymentId}', '${legacyPayTxId}', 'CUSTOMER_RECEIVABLE', 'DEBIT'::"LedgerEntryType", 15000, 'USD', NOW() - INTERVAL '1 minute'),
          ('${crypto.randomUUID()}', '${legacyPaymentId}', '${legacyTxId}', 'PLATFORM_REVENUE', 'DEBIT'::"LedgerEntryType", 12345, 'USD', NOW()),
          ('${crypto.randomUUID()}', '${legacyPaymentId}', '${legacyTxId}', 'CUSTOMER_RECEIVABLE', 'CREDIT'::"LedgerEntryType", 12345, 'USD', NOW());
      `);

      // 3. Execute the actual migration DDL script against populated legacy database
      await applyMigration(prisma);

      // 4. Assert DDL upgrade success & nullability semantics on legacy rows
      const postTableCheck = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = 'cancellation_refund_obligations'
        );
      `);
      expect(postTableCheck[0].exists).toBe(true);

      const legacyRefundRow = await prisma.$queryRawUnsafe<
        Array<{ id: string; cancellationRefundObligationId: string | null }>
      >(`
        SELECT id, "cancellationRefundObligationId" FROM "refunds" WHERE id = '${legacyRefundId}';
      `);
      expect(legacyRefundRow[0].cancellationRefundObligationId).toBeNull();

      const legacyLedgerRows = await prisma.$queryRawUnsafe<
        Array<{ id: string; refundTransactionId: string | null }>
      >(`
        SELECT id, "refundTransactionId" FROM "ledger_entries" WHERE "paymentId" = '${legacyPaymentId}';
      `);
      expect(legacyLedgerRows.length).toBe(4);
      for (const row of legacyLedgerRows) {
        expect(row.refundTransactionId).toBeNull();
      }

      // 5. Execute backfill on the upgraded database
      const stats = await backfillCancellationRefundObligations({ prisma });
      expect(stats.errors).toBe(0);
      expect(stats.obligationsCreated).toBeGreaterThanOrEqual(1);
      expect(stats.refundsLinked).toBeGreaterThanOrEqual(1);
      expect(stats.ledgerEntriesLinked).toBeGreaterThanOrEqual(2);

      // 6. Verify backfilled records via Prisma Client
      const obligation = await prisma.cancellationRefundObligation.findUnique({
        where: { bookingId: legacyBookingId },
        include: { refunds: true },
      });
      expect(obligation).toBeDefined();
      expect(obligation?.totalAmount).toBe(12345); // 123.45 -> 12345
      expect(obligation?.airlineRefundAmount).toBe(10000); // 100.00 -> 10000
      expect(obligation?.paymentId).toBe(legacyPaymentId);
      expect(obligation?.refunds.length).toBe(1);
      expect(obligation?.refunds[0].id).toBe(legacyRefundId);

      const linkedEntries = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: legacyRefundId },
      });
      expect(linkedEntries.length).toBe(2);
      const debitEntry = linkedEntries.find((e) => e.entryType === LedgerEntryType.DEBIT);
      const creditEntry = linkedEntries.find((e) => e.entryType === LedgerEntryType.CREDIT);
      expect(debitEntry?.amount).toBe(12345);
      expect(creditEntry?.amount).toBe(12345);

      // 7. Verify migration-only constraints (CHECK constraints, foreign key restrictions)
      // CHECK constraint: totalAmount >= 0
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "cancellation_refund_obligations" ("id", "bookingId", "paymentId", "totalAmount", "airlineRefundAmount", "currency", "createdAt", "updatedAt")
          VALUES ('${crypto.randomUUID()}', '${legacyBookingId}-fake', '${legacyPaymentId}', -100, 0, 'USD', NOW(), NOW());
        `),
      ).rejects.toThrow();

      // CHECK constraint: airlineRefundAmount >= 0
      await expect(
        prisma.$executeRawUnsafe(`
          INSERT INTO "cancellation_refund_obligations" ("id", "bookingId", "paymentId", "totalAmount", "airlineRefundAmount", "currency", "createdAt", "updatedAt")
          VALUES ('${crypto.randomUUID()}', '${legacyBookingId}-fake2', '${legacyPaymentId}', 100, -50, 'USD', NOW(), NOW());
        `),
      ).rejects.toThrow();

      // Foreign key RESTRICT: cannot delete Payment when referenced by CancellationRefundObligation
      await expect(prisma.payment.delete({ where: { id: legacyPaymentId } })).rejects.toThrow();

      // Foreign key CASCADE: deleting Booking cascades to CancellationRefundObligation
      await prisma.booking.delete({ where: { id: legacyBookingId } });
      const deletedObligation = await prisma.cancellationRefundObligation.findUnique({
        where: { id: obligation!.id },
      });
      expect(deletedObligation).toBeNull();
    });
  });

  describe('Scenario 1: Additive Schema Operability & Invariants', () => {
    it('supports CancellationRefundObligation linked to Booking and Payment, multiple Refunds per Obligation, and verifies ledger entry constraints', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey1 = await createIdempotencyKey(testUser.id, 'sc1-pay');
      const payment = await createPayment(intent.id, idempotencyKey1.id, {
        amount: 20000,
        currency: 'USD',
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        totalAmount: new Prisma.Decimal(200.0),
        currency: 'USD',
      });

      // 1. Create CancellationRefundObligation linked to Booking and Payment
      const obligation = await prisma.cancellationRefundObligation.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          totalAmount: 20000,
          airlineRefundAmount: 18000,
          currency: 'USD',
        },
      });

      expect(obligation).toBeDefined();
      expect(obligation.bookingId).toBe(booking.id);
      expect(obligation.paymentId).toBe(payment.id);
      expect(obligation.totalAmount).toBe(20000);
      expect(obligation.airlineRefundAmount).toBe(18000);

      // 2. Link multiple Refund records to single CancellationRefundObligation (1:N relationship)
      const refundIdem1 = await createIdempotencyKey(testUser.id, 'sc1-ref1');
      const refundIdem2 = await createIdempotencyKey(testUser.id, 'sc1-ref2');

      const refund1 = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          cancellationRefundObligationId: obligation.id,
          idempotencyKeyId: refundIdem1.id,
          stripeRefundId: `re_mig_1_${Date.now()}`,
          amount: 10000,
          currency: 'USD',
          status: RefundStatus.SUCCEEDED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        },
      });

      const refund2 = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          cancellationRefundObligationId: obligation.id,
          idempotencyKeyId: refundIdem2.id,
          stripeRefundId: `re_mig_2_${Date.now()}`,
          amount: 10000,
          currency: 'USD',
          status: RefundStatus.SUCCEEDED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        },
      });

      const fetchedObligation = await prisma.cancellationRefundObligation.findUnique({
        where: { id: obligation.id },
        include: { refunds: true },
      });
      expect(fetchedObligation?.refunds.length).toBe(2);
      expect(fetchedObligation?.refunds.map((r) => r.id).sort()).toEqual(
        [refund1.id, refund2.id].sort(),
      );

      // 3. Link LedgerEntry records to Refund via refundTransactionId
      const txId1 = `tx_${crypto.randomUUID()}`;
      const entryDebit = await prisma.ledgerEntry.create({
        data: {
          paymentId: payment.id,
          refundTransactionId: refund1.id,
          transactionId: txId1,
          accountId: 'PLATFORM_REVENUE',
          entryType: LedgerEntryType.DEBIT,
          amount: 10000,
          currency: 'USD',
        },
      });

      const entryCredit = await prisma.ledgerEntry.create({
        data: {
          paymentId: payment.id,
          refundTransactionId: refund1.id,
          transactionId: txId1,
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: LedgerEntryType.CREDIT,
          amount: 10000,
          currency: 'USD',
        },
      });

      expect(entryDebit.refundTransactionId).toBe(refund1.id);
      expect(entryCredit.refundTransactionId).toBe(refund1.id);

      // 4. Verify unique constraint @@unique([refundTransactionId, accountId, entryType])
      // Attempting to insert duplicate (refundTransactionId, accountId, entryType) throws Prisma P2002 error
      await expect(
        prisma.ledgerEntry.create({
          data: {
            paymentId: payment.id,
            refundTransactionId: refund1.id,
            transactionId: `tx_dup_${crypto.randomUUID()}`,
            accountId: 'PLATFORM_REVENUE',
            entryType: LedgerEntryType.DEBIT,
            amount: 5000,
            currency: 'USD',
          },
        }),
      ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);

      try {
        await prisma.ledgerEntry.create({
          data: {
            paymentId: payment.id,
            refundTransactionId: refund1.id,
            transactionId: `tx_dup_${crypto.randomUUID()}`,
            accountId: 'PLATFORM_REVENUE',
            entryType: LedgerEntryType.DEBIT,
            amount: 5000,
            currency: 'USD',
          },
        });
        fail('Expected P2002 error on duplicate (refundTransactionId, accountId, entryType)');
      } catch (error: unknown) {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          expect(error.code).toBe('P2002');
        } else {
          throw error;
        }
      }

      // Multiple entries with refundTransactionId: null succeed (PostgreSQL nullable unique semantics)
      const txIdNull1 = `tx_null_1_${crypto.randomUUID()}`;
      const txIdNull2 = `tx_null_2_${crypto.randomUUID()}`;

      const nullEntry1 = await prisma.ledgerEntry.create({
        data: {
          paymentId: payment.id,
          refundTransactionId: null,
          transactionId: txIdNull1,
          accountId: 'PLATFORM_REVENUE',
          entryType: LedgerEntryType.DEBIT,
          amount: 5000,
          currency: 'USD',
        },
      });

      const nullEntry2 = await prisma.ledgerEntry.create({
        data: {
          paymentId: payment.id,
          refundTransactionId: null,
          transactionId: txIdNull2,
          accountId: 'PLATFORM_REVENUE',
          entryType: LedgerEntryType.DEBIT,
          amount: 5000,
          currency: 'USD',
        },
      });

      expect(nullEntry1.id).toBeDefined();
      expect(nullEntry2.id).toBeDefined();
      expect(nullEntry1.refundTransactionId).toBeNull();
      expect(nullEntry2.refundTransactionId).toBeNull();
    });
  });

  describe('Scenario 2: Backfill Script Execution & Idempotency', () => {
    it('converts legacy fixtures, converts major-unit Decimal to minor units, links obligations and refunds, and is idempotent', async () => {
      const offer = await createFlightOffer();

      // Fixture A: Cancelled booking with legacy 1:1 Refund and Decimal amounts (123.45 -> 12345)
      const intentA = await createBookingIntent(testUser.id, offer.id);
      const payIdemA = await createIdempotencyKey(testUser.id, 'sc2-pay-a');
      const paymentA = await createPayment(intentA.id, payIdemA.id, {
        amount: 15000,
        currency: 'USD',
      });
      const bookingA = await createBooking(testUser.id, intentA.id, paymentA.id, {
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        totalAmount: new Prisma.Decimal(150.0),
        customerRefundAmount: new Prisma.Decimal(123.45),
        airlineRefundAmount: new Prisma.Decimal(100.0),
        currency: 'USD',
      });

      const refundIdemA = await createIdempotencyKey(testUser.id, 'sc2-ref-a');
      const legacyRefundA = await prisma.refund.create({
        data: {
          paymentId: paymentA.id,
          cancellationRefundObligationId: null,
          idempotencyKeyId: refundIdemA.id,
          stripeRefundId: `re_legacy_a_${Date.now()}`,
          amount: 12345,
          currency: 'USD',
          status: RefundStatus.SUCCEEDED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "bookingId" = '${bookingA.id}' WHERE "id" = '${legacyRefundA.id}'`,
      );

      const txA = `tx_legacy_a_${crypto.randomUUID()}`;
      await prisma.ledgerEntry.createMany({
        data: [
          {
            paymentId: paymentA.id,
            refundTransactionId: null,
            transactionId: txA,
            accountId: 'PLATFORM_REVENUE',
            entryType: LedgerEntryType.DEBIT,
            amount: 12345,
            currency: 'USD',
          },
          {
            paymentId: paymentA.id,
            refundTransactionId: null,
            transactionId: txA,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: LedgerEntryType.CREDIT,
            amount: 12345,
            currency: 'USD',
          },
        ],
      });

      // Fixture B: CANCELLED_NO_REFUND booking (amount = 0)
      const intentB = await createBookingIntent(testUser.id, offer.id);
      const payIdemB = await createIdempotencyKey(testUser.id, 'sc2-pay-b');
      const paymentB = await createPayment(intentB.id, payIdemB.id, {
        amount: 8000,
        currency: 'USD',
      });
      const bookingB = await createBooking(testUser.id, intentB.id, paymentB.id, {
        status: BookingStatus.CANCELLED_NO_REFUND,
        totalAmount: new Prisma.Decimal(80.0),
        currency: 'USD',
      });

      // 1. Run backfill first time
      const stats1 = await backfillCancellationRefundObligations({ prisma });

      expect(stats1.processedBookings).toBeGreaterThanOrEqual(2);
      expect(stats1.obligationsCreated).toBeGreaterThanOrEqual(2);
      expect(stats1.refundsLinked).toBeGreaterThanOrEqual(1);
      expect(stats1.ledgerEntriesLinked).toBeGreaterThanOrEqual(2);
      expect(stats1.quarantined).toBe(0);
      expect(stats1.errors).toBe(0);

      // Verify Fixture A obligation and conversion (123.45 -> 12345 minor units)
      const obligationA = await prisma.cancellationRefundObligation.findUnique({
        where: { bookingId: bookingA.id },
      });
      expect(obligationA).toBeDefined();
      expect(obligationA?.totalAmount).toBe(12345);
      expect(obligationA?.airlineRefundAmount).toBe(10000);
      expect(obligationA?.paymentId).toBe(paymentA.id);
      expect(obligationA?.currency).toBe('USD');

      // Verify Refund A linked to obligation
      const updatedRefundA = await prisma.refund.findUnique({
        where: { id: legacyRefundA.id },
      });
      expect(updatedRefundA?.cancellationRefundObligationId).toBe(obligationA?.id);

      // Verify Ledger entries linked to Refund A
      const linkedEntriesA = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: legacyRefundA.id },
      });
      expect(linkedEntriesA.length).toBe(2);
      for (const entry of linkedEntriesA) {
        expect(entry.refundTransactionId).toBe(legacyRefundA.id);
        expect(entry.amount).toBe(12345);
      }

      // Verify Fixture B obligation (CANCELLED_NO_REFUND -> 0 minor units)
      const obligationB = await prisma.cancellationRefundObligation.findUnique({
        where: { bookingId: bookingB.id },
      });
      expect(obligationB).toBeDefined();
      expect(obligationB?.totalAmount).toBe(0);
      expect(obligationB?.airlineRefundAmount).toBe(0);

      // 2. Run backfill second time to assert idempotency
      const stats2 = await backfillCancellationRefundObligations({ prisma });

      expect(stats2.obligationsCreated).toBe(0);
      expect(stats2.obligationsUpdated).toBe(0);
      expect(stats2.refundsLinked).toBe(0);
      expect(stats2.ledgerEntriesLinked).toBe(0);
      expect(stats2.quarantined).toBe(0);
      expect(stats2.errors).toBe(0);

      // Total count of obligations remains unchanged
      const allObligations = await prisma.cancellationRefundObligation.findMany();
      expect(allObligations.length).toBe(2);
    });
  });

  describe('Scenario 3: Balanced Double-Entry Ledger Invariant', () => {
    it('verifies that succeeded refunds link to balanced reversal ledger entries where sum(DEBIT) === sum(CREDIT)', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const payIdem = await createIdempotencyKey(testUser.id, 'sc3-pay');
      const payment = await createPayment(intent.id, payIdem.id, {
        amount: 5000,
        currency: 'USD',
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        totalAmount: new Prisma.Decimal(50.0),
        customerRefundAmount: new Prisma.Decimal(50.0),
        airlineRefundAmount: new Prisma.Decimal(50.0),
        currency: 'USD',
      });

      const refundIdem = await createIdempotencyKey(testUser.id, 'sc3-ref');
      const refund = await prisma.refund.create({
        data: {
          paymentId: payment.id,
          idempotencyKeyId: refundIdem.id,
          stripeRefundId: `re_sc3_${Date.now()}`,
          amount: 5000,
          currency: 'USD',
          status: RefundStatus.SUCCEEDED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "bookingId" = '${booking.id}' WHERE "id" = '${refund.id}'`,
      );

      const txId = `tx_sc3_${crypto.randomUUID()}`;
      await prisma.ledgerEntry.createMany({
        data: [
          {
            paymentId: payment.id,
            refundTransactionId: null,
            transactionId: txId,
            accountId: 'PLATFORM_REVENUE',
            entryType: LedgerEntryType.DEBIT,
            amount: 5000,
            currency: 'USD',
          },
          {
            paymentId: payment.id,
            refundTransactionId: null,
            transactionId: txId,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: LedgerEntryType.CREDIT,
            amount: 5000,
            currency: 'USD',
          },
        ],
      });

      // Execute backfill
      const stats = await backfillCancellationRefundObligations({ prisma });
      expect(stats.errors).toBe(0);
      expect(stats.ledgerEntriesLinked).toBe(2);

      // Verify linked ledger entries
      const linkedEntries = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: refund.id },
      });

      expect(linkedEntries.length).toBe(2);

      const debits = linkedEntries.filter((e) => e.entryType === LedgerEntryType.DEBIT);
      const credits = linkedEntries.filter((e) => e.entryType === LedgerEntryType.CREDIT);

      expect(debits.length).toBe(1);
      expect(credits.length).toBe(1);
      expect(debits[0].accountId).toBe('PLATFORM_REVENUE');
      expect(credits[0].accountId).toBe('CUSTOMER_RECEIVABLE');

      const sumDebit = debits.reduce((sum, e) => sum + e.amount, 0);
      const sumCredit = credits.reduce((sum, e) => sum + e.amount, 0);

      expect(sumDebit).toBe(5000);
      expect(sumCredit).toBe(5000);
      expect(sumDebit).toEqual(sumCredit);
      expect(sumDebit).toBe(refund.amount);
    });
  });

  describe('Scenario 4: Quarantine & Anomaly Resilience', () => {
    it('quarantines records with currency mismatches, missing payments, or imbalanced ledger entries without crashing, while processing clean records', async () => {
      const offer = await createFlightOffer();

      // Anomaly 1: Currency mismatch (Booking USD, Payment GBP)
      const intent1 = await createBookingIntent(testUser.id, offer.id);
      const payIdem1 = await createIdempotencyKey(testUser.id, 'sc4-pay-1');
      const payment1 = await createPayment(intent1.id, payIdem1.id, {
        amount: 10000,
        currency: 'GBP',
      });
      await createBooking(testUser.id, intent1.id, payment1.id, {
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        totalAmount: new Prisma.Decimal(100.0),
        currency: 'USD', // mismatch: booking is USD, payment is GBP
      });

      // Anomaly 2: Cancelled booking with missing payment
      const intent2 = await createBookingIntent(testUser.id, offer.id);
      await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: testUser.id,
          bookingIntentId: intent2.id,
          paymentId: null, // missing payment
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          totalAmount: new Prisma.Decimal(100.0),
          currency: 'USD',
        },
      });

      // Anomaly 3: SUCCEEDED refund with imbalanced candidate ledger entries (DEBIT 5000 vs CREDIT 4000)
      const intent3 = await createBookingIntent(testUser.id, offer.id);
      const payIdem3 = await createIdempotencyKey(testUser.id, 'sc4-pay-3');
      const payment3 = await createPayment(intent3.id, payIdem3.id, {
        amount: 5000,
        currency: 'USD',
      });
      const booking3 = await createBooking(testUser.id, intent3.id, payment3.id, {
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        totalAmount: new Prisma.Decimal(50.0),
        customerRefundAmount: new Prisma.Decimal(50.0),
        currency: 'USD',
      });
      const refundIdem3 = await createIdempotencyKey(testUser.id, 'sc4-ref-3');
      const refund3 = await prisma.refund.create({
        data: {
          paymentId: payment3.id,
          idempotencyKeyId: refundIdem3.id,
          stripeRefundId: `re_imbalance_${Date.now()}`,
          amount: 5000,
          currency: 'USD',
          status: RefundStatus.SUCCEEDED,
          triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "bookingId" = '${booking3.id}' WHERE "id" = '${refund3.id}'`,
      );

      // Imbalanced candidate ledger entries
      const txImbalanced = `tx_imbal_${crypto.randomUUID()}`;
      await prisma.ledgerEntry.createMany({
        data: [
          {
            paymentId: payment3.id,
            refundTransactionId: null,
            transactionId: txImbalanced,
            accountId: 'PLATFORM_REVENUE',
            entryType: LedgerEntryType.DEBIT,
            amount: 5000,
            currency: 'USD',
          },
          {
            paymentId: payment3.id,
            refundTransactionId: null,
            transactionId: txImbalanced,
            accountId: 'CUSTOMER_RECEIVABLE',
            entryType: LedgerEntryType.CREDIT,
            amount: 4000, // imbalanced: 4000 !== 5000
            currency: 'USD',
          },
        ],
      });

      // Clean record: valid booking and payment
      const intentClean = await createBookingIntent(testUser.id, offer.id);
      const payIdemClean = await createIdempotencyKey(testUser.id, 'sc4-pay-clean');
      const paymentClean = await createPayment(intentClean.id, payIdemClean.id, {
        amount: 7500,
        currency: 'USD',
      });
      const bookingClean = await createBooking(testUser.id, intentClean.id, paymentClean.id, {
        status: BookingStatus.CANCELLED_NO_REFUND,
        totalAmount: new Prisma.Decimal(75.0),
        currency: 'USD',
      });

      // Run backfill
      const stats = await backfillCancellationRefundObligations({ prisma });

      // Assertions
      expect(stats.errors).toBe(0);
      expect(stats.quarantined).toBeGreaterThanOrEqual(3);
      expect(stats.obligationsCreated).toBeGreaterThanOrEqual(1);

      // Clean booking obligation successfully created
      const cleanObligation = await prisma.cancellationRefundObligation.findUnique({
        where: { bookingId: bookingClean.id },
      });
      expect(cleanObligation).toBeDefined();
      expect(cleanObligation?.paymentId).toBe(paymentClean.id);
      expect(cleanObligation?.totalAmount).toBe(0);

      // Imbalanced ledger entries should NOT be linked to refund3
      const linkedImbalanced = await prisma.ledgerEntry.findMany({
        where: { refundTransactionId: refund3.id },
      });
      expect(linkedImbalanced.length).toBe(0);
    });
  });

  describe('Scenario 5: Existing Flows Non-Regression', () => {
    it('verifies standard booking, payment, cancellation refund process, and relationship queries continue operating seamlessly', async () => {
      const offer = await createFlightOffer();
      const intent = await createBookingIntent(testUser.id, offer.id);
      const idempotencyKey = await createIdempotencyKey(testUser.id, 'sc5-pay');
      const payment = await createPayment(intent.id, idempotencyKey.id, {
        amount: 10000,
        currency: 'USD',
        status: PaymentStatus.SUCCEEDED,
      });
      const booking = await createBooking(testUser.id, intent.id, payment.id, {
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        totalAmount: new Prisma.Decimal(100.0),
        currency: 'USD',
      });
      // Current cancellation processing reserves against the canonical
      // obligation. The legacy schema surface remains available for the
      // migration scenarios above, while this non-regression flow verifies
      // the post-backfill runtime contract.
      await prisma.cancellationRefundObligation.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          totalAmount: 10_000,
          airlineRefundAmount: 0,
          currency: 'USD',
        },
      });

      // Mock stripe createRefund
      jest.spyOn(stripeService, 'createRefund').mockResolvedValue({
        id: `re_stripe_sc5_${Date.now()}`,
        status: 'succeeded',
      } as unknown as Stripe.Refund);

      // Execute existing payment refund service flow
      const result = await paymentRefundService.processCancellationRefund({
        bookingId: booking.id,
        paymentId: payment.id,
        amount: 10000,
        currency: 'USD',
      });

      expect(result).toBeDefined();
      expect(result.refundStatus).toBe('SUCCEEDED');

      // Verify that booking, payment, and refund relationships are fully queryable
      const updatedBooking = await prisma.booking.findUnique({
        where: { id: booking.id },
        include: {
          payment: true,
          cancellationRefundObligation: {
            include: {
              refunds: true,
            },
          },
        },
      });

      expect(updatedBooking).toBeDefined();
      expect(updatedBooking?.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
      expect(updatedBooking?.paymentId).toBe(payment.id);
      expect(updatedBooking?.cancellationRefundObligation).toBeDefined();
      expect(updatedBooking?.cancellationRefundObligation?.refunds).toHaveLength(1);
      expect(updatedBooking?.cancellationRefundObligation?.refunds[0]?.amount).toBe(10000);

      // Verify ledger entries created during standard refund flow
      const ledgerEntries = await prisma.ledgerEntry.findMany({
        where: { paymentId: payment.id },
      });
      expect(ledgerEntries.length).toBeGreaterThanOrEqual(2);

      const debits = ledgerEntries.filter((e) => e.entryType === LedgerEntryType.DEBIT);
      const credits = ledgerEntries.filter((e) => e.entryType === LedgerEntryType.CREDIT);
      expect(debits.length).toBeGreaterThanOrEqual(1);
      expect(credits.length).toBeGreaterThanOrEqual(1);
    });
  });
});
