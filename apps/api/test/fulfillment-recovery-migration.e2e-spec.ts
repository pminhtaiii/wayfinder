import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

type MigrationFixture = {
  schemaName: string;
  prisma: PrismaClient;
  inspectionPrisma: PrismaClient;
  dispose: () => Promise<void>;
};

async function createMigrationFixture(): Promise<MigrationFixture> {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error('DATABASE_URL must target the fulfillment_recovery_test database');
  }

  const parsedDatabaseUrl = new URL(baseDatabaseUrl);
  if (
    parsedDatabaseUrl.pathname !== '/fulfillment_recovery_test' ||
    (parsedDatabaseUrl.hostname !== '127.0.0.1' && parsedDatabaseUrl.hostname !== 'localhost')
  ) {
    throw new Error('Migration fixtures may only use the local fulfillment_recovery_test database');
  }

  const schemaName = 'fulfillment_recovery_' + randomUUID().replaceAll('-', '');
  const inspectionDatabaseUrl = new URL(baseDatabaseUrl);
  inspectionDatabaseUrl.searchParams.set('schema', 'public');
  const adminPrisma = new PrismaClient({
    datasources: { db: { url: inspectionDatabaseUrl.toString() } },
  });
  let fixturePrisma: PrismaClient | undefined;
  let schemaCreated = false;

  try {
    await adminPrisma.$executeRawUnsafe('CREATE SCHEMA "' + schemaName + '"');
    schemaCreated = true;

    const fixtureDatabaseUrl = new URL(baseDatabaseUrl);
    fixtureDatabaseUrl.searchParams.set('schema', schemaName);
    const scopedDatabaseUrl = fixtureDatabaseUrl.toString();
    fixturePrisma = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });

    const migrationResult = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        path.resolve(__dirname, '../prisma/schema.prisma'),
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: scopedDatabaseUrl },
      },
    );

    if (migrationResult.error) {
      throw new Error('Prisma migration deploy could not start: ' + migrationResult.error.message);
    }
    if (migrationResult.status !== 0) {
      const output = (migrationResult.stdout + '\n' + migrationResult.stderr).replaceAll(
        scopedDatabaseUrl,
        '[redacted DATABASE_URL]',
      );
      throw new Error('Prisma migration deploy failed: ' + output);
    }

    const fixtureClient = fixturePrisma;
    return {
      schemaName,
      prisma: fixtureClient,
      inspectionPrisma: adminPrisma,
      dispose: async () => {
        try {
          await fixtureClient.$disconnect();
          await adminPrisma.$executeRawUnsafe('DROP SCHEMA "' + schemaName + '" CASCADE');
        } finally {
          await adminPrisma.$disconnect();
        }
      },
    };
  } catch (error) {
    if (fixturePrisma) {
      await fixturePrisma.$disconnect();
    }
    if (schemaCreated) {
      await adminPrisma.$executeRawUnsafe('DROP SCHEMA "' + schemaName + '" CASCADE');
    }
    await adminPrisma.$disconnect();
    throw error;
  }
}

// Human-approved 2026-10-08: raw fixture inserts supply Prisma @updatedAt columns explicitly.
async function createPaymentFixture(
  prisma: PrismaClient,
  stripePaymentIntentId: string | null,
): Promise<void> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const bookingIntentId = randomUUID();
  const idempotencyKeyId = randomUUID();
  const paymentId = randomUUID();

  await prisma.$executeRawUnsafe(
    'INSERT INTO "users" ("id", "email", "password", "updatedAt") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
    userId,
    'migration-' + suffix + '@example.test',
    'test-only-password',
  );
  await prisma.$executeRawUnsafe(
    'INSERT INTO "booking_intents" ("id", "userId", "supplierOfferId", "originalPrice", "confirmedPrice", "pricedAt", "origin", "destination", "departureDate", "adults", "rawOfferSnapshot", "intentExpiresAt", "updatedAt") VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 1, $9::jsonb, $10, CURRENT_TIMESTAMP)',
    bookingIntentId,
    userId,
    'supplier-' + suffix,
    125,
    new Date('2026-10-01T00:00:00.000Z'),
    'SFO',
    'LAX',
    new Date('2030-01-15T00:00:00.000Z'),
    '{"fixture":"migration"}',
    new Date('2029-12-01T00:00:00.000Z'),
  );
  await prisma.$executeRawUnsafe(
    'INSERT INTO "idempotency_keys" ("id", "key", "requestHash", "customerId", "requestPath", "expiresAt") VALUES ($1, $2, $3, $4, $5, $6)',
    idempotencyKeyId,
    'migration-' + suffix,
    'a'.repeat(64),
    userId,
    '/migration-test',
    new Date('2030-01-01T00:00:00.000Z'),
  );
  await prisma.$executeRawUnsafe(
    'INSERT INTO "payments" ("id", "bookingIntentId", "attemptNumber", "idempotencyKeyId", "stripePaymentIntentId", "amount", "currency", "updatedAt") VALUES ($1, $2, 1, $3, $4, 12500, $5, CURRENT_TIMESTAMP)',
    paymentId,
    bookingIntentId,
    idempotencyKeyId,
    stripePaymentIntentId,
    'USD',
  );
}
describe('fulfillment recovery migration compatibility', () => {
  jest.setTimeout(120_000);

  it('adds the workflow table to a clean migrated schema', async () => {
    const fixture = await createMigrationFixture();
    try {
      // Human-approved 2026-10-08: inspect from public so PostgreSQL returns the qualified table name.
      const rows = await fixture.inspectionPrisma.$queryRawUnsafe<
        Array<{ tableName: string | null }>
      >(
        'SELECT to_regclass($1)::text AS "tableName"',
        fixture.schemaName + '.fulfillment_workflows',
      );
      expect(rows[0]?.tableName).toBe(fixture.schemaName + '.fulfillment_workflows');
    } finally {
      await fixture.dispose();
    }
  });

  it('allows null Stripe intent IDs while keeping non-null IDs unique', async () => {
    const fixture = await createMigrationFixture();
    try {
      const columns = await fixture.inspectionPrisma.$queryRawUnsafe<
        Array<{ isNullable: string }>
      >(
        'SELECT is_nullable AS "isNullable" FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3',
        fixture.schemaName,
        'payments',
        'stripePaymentIntentId',
      );
      expect(columns[0]?.isNullable).toBe('YES');

      await createPaymentFixture(fixture.prisma, null);
      await createPaymentFixture(fixture.prisma, null);
      await createPaymentFixture(fixture.prisma, 'pi_feature030_unique');
      await expect(createPaymentFixture(fixture.prisma, 'pi_feature030_unique')).rejects.toThrow();
    } finally {
      await fixture.dispose();
    }
  });

  it('stores an uncreated reservation without fabricating a Stripe ID', async () => {
    const fixture = await createMigrationFixture();
    try {
      await createPaymentFixture(fixture.prisma, null);
      await fixture.prisma.$executeRawUnsafe(
        "UPDATE \"payments\" SET \"status\" = 'RESERVED' WHERE \"stripePaymentIntentId\" IS NULL",
      );
      const payments = await fixture.prisma.$queryRawUnsafe<
        Array<{ stripePaymentIntentId: string | null; status: string }>
      >('SELECT "stripePaymentIntentId", "status" FROM "payments"');
      expect(payments).toHaveLength(1);
      expect(payments[0]?.stripePaymentIntentId).toBeNull();
      expect(payments[0]?.status).toBe('RESERVED');
    } finally {
      await fixture.dispose();
    }
  });
});