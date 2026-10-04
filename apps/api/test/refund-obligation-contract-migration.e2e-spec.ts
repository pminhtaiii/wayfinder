import { Prisma, PrismaClient, RefundStatus, RefundTriggerType } from '@prisma/client';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const CONTRACT_MIGRATION_PATH = path.join(
  __dirname,
  '../prisma/migrations/20260823000000_refund_obligation_contract/migration.sql',
);
const CONTRACT_MIGRATION_NAME = '20260823000000_refund_obligation_contract';

const REVERSE_MAPPING_SQL = `
BEGIN;

ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "bookingId" TEXT;

UPDATE "refunds" r
SET "bookingId" = o."bookingId"
FROM "cancellation_refund_obligations" o
WHERE r."cancellationRefundObligationId" = o.id;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "refunds"
    WHERE "bookingId" IS NOT NULL
    GROUP BY "bookingId"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Reverse mapping would violate legacy Refund.bookingId uniqueness';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "refunds_bookingId_key" ON "refunds"("bookingId");
ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
`;

type Fixture = {
  userId: string;
  offerId: string;
  intentId: string;
  bookingId: string;
  primaryPaymentId: string;
  idempotencyKeyIds: string[];
  paymentIds: string[];
  obligationId?: string;
  refundIds: string[];
};

type RefundInput = {
  fixture: Fixture;
  paymentId?: string;
  obligationId?: string | null;
  amount?: number;
  currency?: string;
  reason?: string | null;
  status?: RefundStatus;
  legacyBooking?: boolean;
};

describe('Refund obligation contract migration (E2E)', () => {
  jest.setTimeout(120_000);

  const prisma = new PrismaClient();
  const migrationSql = fs.readFileSync(CONTRACT_MIGRATION_PATH, 'utf8');
  let fixtures: Fixture[] = [];

  /**
   * PostgreSQL DO blocks contain internal semicolons. Send each migration or
   * rollback script as one full batch through Prisma's CLI; never split it in
   * JavaScript or send a multi-command script through $executeRawUnsafe.
   */
  async function executeSqlScript(sql: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      throw new Error('DATABASE_URL is required to execute the contract migration SQL batch.');
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
      prismaProcess.once(
        'close',
        (exitCode: number | null, signal: NodeJS.Signals | null): void => {
          if (processError) {
            reject(new Error(`Prisma db execute could not start: ${processError.message}`));
            return;
          }

          if (exitCode === 0) {
            resolve();
            return;
          }

          const termination = signal ? ` (terminated by ${signal})` : '';
          const errorOutput = stderr.trim() || 'No stderr output was produced.';
          reject(
            new Error(
              `Prisma db execute failed with exit code ${String(exitCode)}${termination}: ${errorOutput}`,
            ),
          );
        },
      );
    });
  }

  async function applyContractMigration(): Promise<void> {
    await executeSqlScript(migrationSql);
  }

  async function hasBookingIdColumn(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'refunds'
          AND column_name = 'bookingId'
      ) AS "exists";
    `);
    return rows[0]?.exists === true;
  }

  async function hasLegacyForeignKey(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT FROM pg_constraint
        WHERE conrelid = '"refunds"'::regclass
          AND conname = 'refunds_bookingId_fkey'
      ) AS "exists";
    `);
    return rows[0]?.exists === true;
  }

  async function hasLegacyUniqueIndex(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = 'refunds'
          AND indexname = 'refunds_bookingId_key'
      ) AS "exists";
    `);
    return rows[0]?.exists === true;
  }

  async function hasContractDiscriminator(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT FROM pg_constraint
        WHERE conrelid = '"refunds"'::regclass
          AND conname = 'refunds_cancellation_refund_obligation_required'
      ) AS "exists";
    `);
    return rows[0]?.exists === true;
  }

  async function assertContractMigrationRecorded(): Promise<void> {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (
        SELECT FROM "_prisma_migrations"
        WHERE migration_name = '${CONTRACT_MIGRATION_NAME}'
          AND finished_at IS NOT NULL
          AND rolled_back_at IS NULL
      ) AS "exists";`,
    );
    if (!rows[0]?.exists) {
      throw new Error(
        `This verifier requires the ${CONTRACT_MIGRATION_NAME} migration to be applied and recorded before it temporarily restores the legacy relation.`,
      );
    }
  }

  async function assertContractSchemaAtMigrationHead(): Promise<void> {
    const [hasBookingId, legacyForeignKeyExists, legacyUniqueIndexExists, hasDiscriminator] =
      await Promise.all([
        hasBookingIdColumn(),
        hasLegacyForeignKey(),
        hasLegacyUniqueIndex(),
        hasContractDiscriminator(),
      ]);
    if (hasBookingId || legacyForeignKeyExists || legacyUniqueIndexExists || !hasDiscriminator) {
      throw new Error(
        'The database schema does not match the recorded refund-obligation contract migration head. Restore the disposable test database before running this verifier.',
      );
    }
  }

  async function restoreContractMigrationHead(): Promise<void> {
    if (await hasBookingIdColumn()) {
      // The temporary legacy surface may retain the contract CHECK from a
      // successful verifier case. The migration itself creates that CHECK.
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_cancellation_refund_obligation_required"',
      );
      await applyContractMigration();
    }
    await assertContractMigrationRecorded();
    await assertContractSchemaAtMigrationHead();
  }

  async function restoreLegacyContractSurface(): Promise<void> {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "refunds" DROP CONSTRAINT IF EXISTS "refunds_cancellation_refund_obligation_required"',
    );
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "refunds" ADD COLUMN IF NOT EXISTS "bookingId" TEXT',
    );
    await prisma.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "refunds_bookingId_key" ON "refunds"("bookingId")',
    );
    await executeSqlScript(`
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
    `);
  }

  async function cleanFixture(fixture: Fixture): Promise<void> {
    await prisma.ledgerEntry.deleteMany({
      where: { paymentId: { in: fixture.paymentIds } },
    });
    await prisma.refund.deleteMany({ where: { id: { in: fixture.refundIds } } });
    if (fixture.obligationId) {
      await prisma.cancellationRefundObligation.deleteMany({
        where: { id: fixture.obligationId },
      });
    }
    await prisma.booking.deleteMany({ where: { id: fixture.bookingId } });
    await prisma.payment.deleteMany({ where: { id: { in: fixture.paymentIds } } });
    await prisma.idempotencyKey.deleteMany({
      where: { id: { in: fixture.idempotencyKeyIds } },
    });
    await prisma.bookingIntent.deleteMany({ where: { id: fixture.intentId } });
    await prisma.flightOffer.deleteMany({ where: { id: fixture.offerId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
  }

  async function createFixture(options: { createObligation?: boolean } = {}): Promise<Fixture> {
    const marker = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `contract-migration-${marker}@example.test`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    const offer = await prisma.flightOffer.create({
      data: {
        searchHash: `contract-migration-${marker}`,
        supplierOfferId: `off_contract_${marker}`,
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100),
        currency: 'USD',
      },
    });
    const intent = await prisma.bookingIntent.create({
      data: {
        userId: user.id,
        flightOfferId: offer.id,
        supplierOfferId: `intent_contract_${marker}`,
        status: 'CONFIRMED',
        originalPrice: new Prisma.Decimal(100),
        confirmedPrice: new Prisma.Decimal(100),
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
        intentExpiresAt: new Date(Date.now() + 3_600_000),
        paymentAttemptCount: 1,
      },
    });
    const paymentKey = await prisma.idempotencyKey.create({
      data: {
        key: `contract-payment:${marker}`,
        requestHash: marker.replaceAll('-', ''),
        customerId: user.id,
        requestPath: '/api/bookings/payment',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingIntentId: intent.id,
        attemptNumber: 1,
        idempotencyKeyId: paymentKey.id,
        stripePaymentIntentId: `pi_contract_${marker}`,
        amount: 10_000,
        currency: 'USD',
        status: 'SUCCEEDED',
        version: 0,
      },
    });
    const booking = await prisma.booking.create({
      data: {
        userId: user.id,
        bookingIntentId: intent.id,
        paymentId: payment.id,
        totalAmount: new Prisma.Decimal(100),
        currency: 'USD',
        status: 'CANCELLED_PENDING_REFUND',
      },
    });
    const fixture: Fixture = {
      userId: user.id,
      offerId: offer.id,
      intentId: intent.id,
      bookingId: booking.id,
      primaryPaymentId: payment.id,
      idempotencyKeyIds: [paymentKey.id],
      paymentIds: [payment.id],
      refundIds: [],
    };
    if (options.createObligation) {
      const obligation = await prisma.cancellationRefundObligation.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          totalAmount: 10_000,
          airlineRefundAmount: 8_000,
          currency: 'USD',
        },
      });
      fixture.obligationId = obligation.id;
    }
    fixtures.push(fixture);
    return fixture;
  }

  async function addPayment(fixture: Fixture, currency = 'USD'): Promise<string> {
    const marker = randomUUID();
    const key = await prisma.idempotencyKey.create({
      data: {
        key: `contract-payment-secondary:${marker}`,
        requestHash: marker.replaceAll('-', ''),
        customerId: fixture.userId,
        requestPath: '/api/bookings/payment',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingIntentId: fixture.intentId,
        attemptNumber: 2,
        idempotencyKeyId: key.id,
        stripePaymentIntentId: `pi_contract_secondary_${marker}`,
        amount: 10_000,
        currency,
        status: 'SUCCEEDED',
        version: 0,
      },
    });
    fixture.idempotencyKeyIds.push(key.id);
    fixture.paymentIds.push(payment.id);
    return payment.id;
  }

  async function addRefund(input: RefundInput): Promise<string> {
    const marker = randomUUID();
    const key = await prisma.idempotencyKey.create({
      data: {
        key: `contract-refund:${marker}`,
        requestHash: marker.replaceAll('-', ''),
        customerId: input.fixture.userId,
        requestPath: '/api/bookings/payment/refund',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    input.fixture.idempotencyKeyIds.push(key.id);
    const refund = await prisma.refund.create({
      data: {
        paymentId: input.paymentId ?? input.fixture.primaryPaymentId,
        cancellationRefundObligationId: input.obligationId ?? undefined,
        idempotencyKeyId: key.id,
        stripeRefundId: `re_contract_${marker}`,
        amount: input.amount ?? 5_000,
        currency: input.currency ?? 'USD',
        reason: input.reason ?? 'customer-request',
        triggerType: RefundTriggerType.SYSTEM_AUTOMATED,
        status: input.status ?? RefundStatus.REFUND_PENDING,
      },
    });
    input.fixture.refundIds.push(refund.id);
    if (input.legacyBooking) {
      await prisma.$executeRawUnsafe(
        `UPDATE "refunds" SET "bookingId" = '${input.fixture.bookingId}' WHERE "id" = '${refund.id}'`,
      );
    }
    return refund.id;
  }

  async function addExactLedgerPair(
    fixture: Fixture,
    refundId: string,
    amount = 5_000,
  ): Promise<void> {
    await prisma.ledgerEntry.createMany({
      data: [
        {
          paymentId: fixture.primaryPaymentId,
          refundTransactionId: refundId,
          transactionId: `contract-ledger:${randomUUID()}`,
          accountId: 'PLATFORM_REVENUE',
          entryType: 'DEBIT',
          amount,
          currency: 'USD',
        },
        {
          paymentId: fixture.primaryPaymentId,
          refundTransactionId: refundId,
          transactionId: `contract-ledger:${randomUUID()}`,
          accountId: 'CUSTOMER_RECEIVABLE',
          entryType: 'CREDIT',
          amount,
          currency: 'USD',
        },
      ],
    });
  }

  async function expectPreflightAbort(message: string): Promise<void> {
    await expect(applyContractMigration()).rejects.toThrow(message);
    expect(await hasBookingIdColumn()).toBe(true);
  }

  beforeAll(async () => {
    await prisma.$connect();
    const hasExpandSchema = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name = 'cancellation_refund_obligations'
      ) AS "exists";
    `);
    if (!hasExpandSchema[0]?.exists) {
      throw new Error(
        'The expand migration must be applied before running the contract migration verifier.',
      );
    }
    await assertContractMigrationRecorded();
    await assertContractSchemaAtMigrationHead();
  });

  beforeEach(async () => {
    fixtures = [];
    await assertContractMigrationRecorded();
    await assertContractSchemaAtMigrationHead();
    try {
      await restoreLegacyContractSurface();
    } catch (error) {
      await restoreContractMigrationHead();
      throw error;
    }
  });

  afterEach(async () => {
    try {
      for (const fixture of [...fixtures].reverse()) {
        await cleanFixture(fixture);
      }
    } finally {
      fixtures = [];
      await restoreContractMigrationHead();
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('aborts before removing the legacy relation when any legacy booking-linked refund is unbackfilled', async () => {
    const fixture = await createFixture();
    await addRefund({
      fixture,
      reason: 'cancellation:legacy-booking',
      legacyBooking: true,
    });

    await expectPreflightAbort('legacy booking-linked refund');
    expect(await hasLegacyForeignKey()).toBe(true);
    expect(await hasLegacyUniqueIndex()).toBe(true);
  });

  it('contracts clean data, preserves direct refunds without obligations, and enforces the runtime cancellation discriminator', async () => {
    const fixture = await createFixture({ createObligation: true });
    await addRefund({
      fixture,
      obligationId: fixture.obligationId,
      // Legacy rows are backfilled based on bookingId, regardless of reason.
      reason: 'manual-legacy-adjustment',
      legacyBooking: true,
    });

    await applyContractMigration();

    expect(await hasBookingIdColumn()).toBe(false);
    expect(await hasLegacyForeignKey()).toBe(false);
    expect(await hasLegacyUniqueIndex()).toBe(false);

    await expect(
      addRefund({ fixture, reason: 'cancellation:runtime', obligationId: null }),
    ).rejects.toThrow();
    await expect(
      addRefund({ fixture, reason: 'customer-request', obligationId: null }),
    ).resolves.toEqual(expect.any(String));
  });

  it('aborts on obligation booking/payment/currency facts and linked refund payment facts', async () => {
    const fixture = await createFixture({ createObligation: true });
    const secondaryPaymentId = await addPayment(fixture);

    await prisma.cancellationRefundObligation.update({
      where: { id: fixture.obligationId },
      data: { paymentId: secondaryPaymentId },
    });
    await expectPreflightAbort('mismatched booking, payment, currency, or amount facts');

    await prisma.cancellationRefundObligation.update({
      where: { id: fixture.obligationId },
      data: { paymentId: fixture.primaryPaymentId, currency: 'EUR' },
    });
    await expectPreflightAbort('mismatched booking, payment, currency, or amount facts');

    await prisma.cancellationRefundObligation.update({
      where: { id: fixture.obligationId },
      data: { currency: 'USD' },
    });
    await addRefund({
      fixture,
      paymentId: secondaryPaymentId,
      obligationId: fixture.obligationId,
      reason: 'cancellation:linked-mismatch',
    });
    await expectPreflightAbort('refund obligation link');
  });

  it('aborts when payment or obligation capacity is exceeded', async () => {
    const fixture = await createFixture();
    await addRefund({ fixture, amount: 10_001, reason: 'customer-request' });

    await expectPreflightAbort('exceed refund capacity');
  });

  it('aborts invalid successful and non-successful refund ledger links', async () => {
    const fixture = await createFixture();
    const successfulRefundId = await addRefund({
      fixture,
      status: RefundStatus.SUCCEEDED,
      reason: 'customer-request',
    });
    await expectPreflightAbort('lack an exact reversal ledger pair');

    await prisma.refund.delete({ where: { id: successfulRefundId } });
    fixture.refundIds = fixture.refundIds.filter((id) => id !== successfulRefundId);
    const pendingRefundId = await addRefund({ fixture, reason: 'customer-request' });
    await addExactLedgerPair(fixture, pendingRefundId);
    await expectPreflightAbort('non-successful refund transaction ledger link');
  });

  it('runs the documented reverse mapping as a whole SQL batch and restores the legacy relation only when representable', async () => {
    const fixture = await createFixture({ createObligation: true });
    await addRefund({
      fixture,
      obligationId: fixture.obligationId,
      reason: 'cancellation:rollback-verifier',
    });
    await applyContractMigration();

    await executeSqlScript(REVERSE_MAPPING_SQL);

    expect(await hasBookingIdColumn()).toBe(true);
    expect(await hasLegacyForeignKey()).toBe(true);
    expect(await hasLegacyUniqueIndex()).toBe(true);
    const reverseMappedRows = await prisma.$queryRawUnsafe<Array<{ bookingId: string | null }>>(
      `SELECT "bookingId" FROM "refunds" WHERE "id" = '${fixture.refundIds[0]}'`,
    );
    expect(reverseMappedRows[0]?.bookingId).toBe(fixture.bookingId);
  });
});
