import 'reflect-metadata';
import { copyFileSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { PaymentService } from '@/payment/payment.service';
import { PrismaService } from '@/prisma/prisma.service';
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

  it('adds operation and attempt tables with workflow claim and event evidence columns', async () => {
    const fixture = await createMigrationFixture();
    try {
      const tables = await fixture.inspectionPrisma.$queryRawUnsafe<
        Array<{ tableName: string }>
      >(
        'SELECT table_name AS "tableName" FROM information_schema.tables WHERE table_schema = $1 AND table_name IN ($2, $3, $4) ORDER BY table_name',
        fixture.schemaName,
        'fulfillment_workflows',
        'provider_attempts',
        'provider_operations',
      );
      expect(tables.map((row) => row.tableName)).toEqual([
        'fulfillment_workflows',
        'provider_attempts',
        'provider_operations',
      ]);

      const columns = await fixture.inspectionPrisma.$queryRawUnsafe<
        Array<{ tableName: string; columnName: string }>
      >(
        'SELECT table_name AS "tableName", column_name AS "columnName" FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ($2, $3, $4, $5)',
        fixture.schemaName,
        'fulfillment_workflows',
        'provider_operations',
        'provider_attempts',
        'payment_events',
      );
      const columnNames = columns.map((row) => row.tableName + '.' + row.columnName);
      expect(columnNames).toEqual(
        expect.arrayContaining([
          'fulfillment_workflows.bookingIntentId',
          'fulfillment_workflows.bookingId',
          'fulfillment_workflows.currentPaymentId',
          'fulfillment_workflows.ownerToken',
          'fulfillment_workflows.fence',
          'fulfillment_workflows.leaseExpiresAt',
          'fulfillment_workflows.actorType',
          'provider_operations.workflowId',
          'provider_operations.provider',
          'provider_operations.purpose',
          'provider_operations.logicalSequence',
          'provider_operations.status',
          'provider_attempts.operationId',
          'provider_attempts.kind',
          'provider_attempts.claimFence',
          'provider_attempts.startedAt',
          'provider_attempts.requestFingerprint',
          'payment_events.providerOperationId',
          'payment_events.providerAttemptId',
          'payment_events.provider',
          'payment_events.evidenceKind',
          'payment_events.outcomeClass',
          'payment_events.bookingIntentMatched',
          'payment_events.offerMatched',
          'payment_events.passengerSetMatched',
          'payment_events.itineraryMatched',
        ]),
      );
    } finally {
      await fixture.dispose();
    }
  });
});
type LegacyMigrationFixture = MigrationFixture & {
  applyCurrentMigration: () => void;
};

type LegacyReferences = {
  userId: string;
  bookingIntentId: string;
  paymentId: string;
  idempotencyKeyId: string;
  bookingId: string;
  paymentEventId: bigint;
};

type LegacySnapshot = {
  userId: string;
  userEmail: string;
  userCreatedAt: Date;
  userUpdatedAt: Date;
  bookingIntentId: string;
  bookingIntentStatus: string;
  originalPrice: string;
  confirmedPrice: string;
  intentCurrency: string;
  intentCreatedAt: Date;
  intentUpdatedAt: Date;
  paymentId: string;
  paymentBookingIntentId: string;
  paymentStatus: string;
  stripePaymentIntentId: string | null;
  amount: number;
  paymentCurrency: string;
  paymentCreatedAt: Date;
  paymentUpdatedAt: Date;
  idempotencyKeyId: string;
  idempotencyKey: string;
  requestHash: string;
  requestPath: string;
  recoveryPoint: string;
  lockedAt: Date | null;
  idempotencyCreatedAt: Date;
  idempotencyExpiresAt: Date;
  bookingId: string;
  bookingUserId: string;
  bookingIntentReference: string;
  bookingPaymentId: string | null;
  bookingStatus: string;
  supplierOrderId: string | null;
  totalAmount: string;
  bookingCurrency: string;
  bookingCreatedAt: Date;
  bookingUpdatedAt: Date;
  paymentEventId: bigint;
  eventPaymentId: string;
  eventType: string;
  previousStatus: string;
  newStatus: string;
  eventAmount: number | null;
  eventSource: string;
  stripeEventId: string | null;
  eventCreatedAt: Date;
  eventCreatedBy: string;
};

type LegacyJournalLinks = {
  paymentWorkflowId: string | null;
  providerOperationId: string | null;
  providerAttemptId: string | null;
  provider: string | null;
  evidenceKind: string | null;
  outcomeClass: string | null;
  bookingIntentMatched: boolean | null;
  offerMatched: boolean | null;
  passengerSetMatched: boolean | null;
  itineraryMatched: boolean | null;
};

function deployMigrationHistory(databaseUrl: string, schemaPath: string): void {
  const migrationResult = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, '../node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      schemaPath,
    ],
    {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    },
  );

  if (migrationResult.error) {
    throw new Error('Prisma migration deploy could not start: ' + migrationResult.error.message);
  }
  if (migrationResult.status !== 0) {
    const output = ((migrationResult.stdout ?? '') + '\n' + (migrationResult.stderr ?? '')).replaceAll(
      databaseUrl,
      '[redacted DATABASE_URL]',
    );
    throw new Error('Prisma migration deploy failed: ' + output);
  }
}

async function dropMigrationSchema(prisma: PrismaClient, schemaName: string): Promise<void> {
  await prisma.$executeRawUnsafe('DROP SCHEMA "' + schemaName + '" CASCADE');
  const remainingSchemas = await prisma.$queryRawUnsafe<Array<{ schemaName: string }>>(
    'SELECT schema_name AS "schemaName" FROM information_schema.schemata WHERE schema_name = $1',
    schemaName,
  );
  expect(remainingSchemas).toHaveLength(0);
  const publicSchema = await prisma.$queryRawUnsafe<Array<{ schemaName: string | null }>>(
    'SELECT to_regnamespace($1)::text AS "schemaName"',
    'public',
  );
  expect(publicSchema[0]?.schemaName).toBe('public');
}

function removeOwnedMigrationDirectory(tempRoot: string, fixtureDirectory: string): void {
  const resolvedRoot = path.resolve(tempRoot);
  const resolvedDirectory = path.resolve(fixtureDirectory);
  const relativePath = path.relative(resolvedRoot, resolvedDirectory);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('..' + path.sep) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error('Temporary migration directory escaped the plan-owned SDD temp directory');
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
}

async function createLegacyMigrationFixture(): Promise<LegacyMigrationFixture> {
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
  const repositoryRoot = path.resolve(__dirname, '../../..');
  const tempRoot = path.resolve(
    repositoryRoot,
    '.superpowers',
    'sdd',
    '2026-10-07-030-phase2',
    'temp',
  );
  const fixtureDirectory = path.resolve(tempRoot, 'legacy-' + schemaName);
  const sourceMigrations = path.resolve(__dirname, '../prisma/migrations');
  const latestMigrationName = '20261007000000_fulfillment_recovery';
  const latestMigrationSource = path.resolve(sourceMigrations, latestMigrationName);
  const tempMigrations = path.resolve(fixtureDirectory, 'migrations');
  const tempSchema = path.resolve(fixtureDirectory, 'schema.prisma');
  let fixturePrisma: PrismaClient | undefined;
  let schemaCreated = false;
  let tempDirectoryCreated = false;

  try {
    mkdirSync(tempRoot, { recursive: true });
    mkdirSync(fixtureDirectory);
    tempDirectoryCreated = true;
    cpSync(sourceMigrations, tempMigrations, {
      recursive: true,
      filter: (sourcePath) => path.resolve(sourcePath) !== latestMigrationSource,
    });
    copyFileSync(path.resolve(__dirname, '../prisma/schema.prisma'), tempSchema);

    await adminPrisma.$executeRawUnsafe('CREATE SCHEMA "' + schemaName + '"');
    schemaCreated = true;
    const fixtureDatabaseUrl = new URL(baseDatabaseUrl);
    fixtureDatabaseUrl.searchParams.set('schema', schemaName);
    const scopedDatabaseUrl = fixtureDatabaseUrl.toString();
    fixturePrisma = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
    deployMigrationHistory(scopedDatabaseUrl, tempSchema);

    const fixtureClient = fixturePrisma;
    let currentMigrationApplied = false;
    return {
      schemaName,
      prisma: fixtureClient,
      inspectionPrisma: adminPrisma,
      applyCurrentMigration: () => {
        if (currentMigrationApplied) {
          throw new Error('The current fulfillment recovery migration has already been applied');
        }
        cpSync(latestMigrationSource, path.resolve(tempMigrations, latestMigrationName), {
          recursive: true,
        });
        deployMigrationHistory(scopedDatabaseUrl, tempSchema);
        currentMigrationApplied = true;
      },
      dispose: async () => {
        try {
          await fixtureClient.$disconnect();
        } finally {
          try {
            await dropMigrationSchema(adminPrisma, schemaName);
          } finally {
            try {
              await adminPrisma.$disconnect();
            } finally {
              removeOwnedMigrationDirectory(tempRoot, fixtureDirectory);
            }
          }
        }
      },
    };
  } catch (error) {
    try {
      if (fixturePrisma) {
        await fixturePrisma.$disconnect();
      }
    } finally {
      try {
        if (schemaCreated) {
          await dropMigrationSchema(adminPrisma, schemaName);
        }
      } finally {
        try {
          await adminPrisma.$disconnect();
        } finally {
          if (tempDirectoryCreated) {
            removeOwnedMigrationDirectory(tempRoot, fixtureDirectory);
          }
        }
      }
    }
    throw error;
  }
}

// Human-approved 2026-10-08: legacy fixture enum parameters use explicit PostgreSQL enum casts.
async function createLegacyRows(prisma: PrismaClient): Promise<LegacyReferences> {
  const stripePaymentIntentId = 'pi_legacy_' + randomUUID();
  await createPaymentFixture(prisma, stripePaymentIntentId);
  const references = await prisma.$queryRawUnsafe<
    Array<Pick<LegacyReferences, 'userId' | 'bookingIntentId' | 'paymentId' | 'idempotencyKeyId'>>
  >(
    'SELECT u.id AS "userId", bi.id AS "bookingIntentId", p.id AS "paymentId", ik.id AS "idempotencyKeyId" FROM "users" u JOIN "booking_intents" bi ON bi."userId" = u.id JOIN "payments" p ON p."bookingIntentId" = bi.id JOIN "idempotency_keys" ik ON ik.id = p."idempotencyKeyId" WHERE ik."requestPath" = $1',
    '/migration-test',
  );
  expect(references).toHaveLength(1);
  const reference = references[0];
  if (!reference) {
    throw new Error('Legacy payment fixture did not create its expected references');
  }

  await prisma.$executeRawUnsafe(
    'UPDATE "booking_intents" SET "status" = $2::"BookingIntentStatus" WHERE "id" = $1',
    reference.bookingIntentId,
    'AWAITING_PAYMENT',
  );
  await prisma.$executeRawUnsafe(
    'UPDATE "payments" SET "status" = $2::"PaymentStatus" WHERE "id" = $1',
    reference.paymentId,
    'AUTHORIZED',
  );
  await prisma.$executeRawUnsafe(
    'UPDATE "idempotency_keys" SET "recoveryPoint" = $2, "lockedAt" = CURRENT_TIMESTAMP WHERE "id" = $1',
    reference.idempotencyKeyId,
    'stripe_authorized',
  );

  const bookingId = randomUUID();
  await prisma.$executeRawUnsafe(
    'INSERT INTO "bookings" ("id", "userId", "bookingIntentId", "paymentId", "status", "totalAmount", "currency", "updatedAt") VALUES ($1, $2, $3, $4, $5::"BookingStatus", $6, $7, CURRENT_TIMESTAMP)',
    bookingId,
    reference.userId,
    reference.bookingIntentId,
    reference.paymentId,
    'PROCESSING',
    125,
    'USD',
  );
  const events = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
    'INSERT INTO "payment_events" ("paymentId", "eventType", "previousStatus", "newStatus", "amount", "source", "stripeEventId", "createdBy") VALUES ($1, $2, $3::"PaymentStatus", $4::"PaymentStatus", $5, $6::"PaymentEventSource", $7, $8) RETURNING "id"',
    reference.paymentId,
    'payment_intent.amount_capturable_updated',
    'CREATED',
    'AUTHORIZED',
    12500,
    'WEBHOOK',
    'evt_legacy_' + randomUUID(),
    'migration-fixture',
  );
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event) {
    throw new Error('Legacy payment event fixture did not create its expected event');
  }

  return { ...reference, bookingId, paymentEventId: event.id };
}

async function readLegacySnapshot(
  prisma: PrismaClient,
  references: LegacyReferences,
): Promise<LegacySnapshot[]> {
  return prisma.$queryRawUnsafe<LegacySnapshot[]>(
    'SELECT u.id AS "userId", u.email AS "userEmail", u."createdAt" AS "userCreatedAt", u."updatedAt" AS "userUpdatedAt", bi.id AS "bookingIntentId", bi.status::text AS "bookingIntentStatus", bi."originalPrice"::text AS "originalPrice", bi."confirmedPrice"::text AS "confirmedPrice", bi.currency AS "intentCurrency", bi."createdAt" AS "intentCreatedAt", bi."updatedAt" AS "intentUpdatedAt", p.id AS "paymentId", p."bookingIntentId" AS "paymentBookingIntentId", p.status::text AS "paymentStatus", p."stripePaymentIntentId" AS "stripePaymentIntentId", p.amount AS "amount", p.currency AS "paymentCurrency", p."createdAt" AS "paymentCreatedAt", p."updatedAt" AS "paymentUpdatedAt", ik.id AS "idempotencyKeyId", ik.key AS "idempotencyKey", ik."requestHash" AS "requestHash", ik."requestPath" AS "requestPath", ik."recoveryPoint" AS "recoveryPoint", ik."lockedAt" AS "lockedAt", ik."createdAt" AS "idempotencyCreatedAt", ik."expiresAt" AS "idempotencyExpiresAt", b.id AS "bookingId", b."userId" AS "bookingUserId", b."bookingIntentId" AS "bookingIntentReference", b."paymentId" AS "bookingPaymentId", b.status::text AS "bookingStatus", b."supplierOrderId" AS "supplierOrderId", b."totalAmount"::text AS "totalAmount", b.currency AS "bookingCurrency", b."createdAt" AS "bookingCreatedAt", b."updatedAt" AS "bookingUpdatedAt", pe.id AS "paymentEventId", pe."paymentId" AS "eventPaymentId", pe."eventType" AS "eventType", pe."previousStatus"::text AS "previousStatus", pe."newStatus"::text AS "newStatus", pe.amount AS "eventAmount", pe.source::text AS "eventSource", pe."stripeEventId" AS "stripeEventId", pe."createdAt" AS "eventCreatedAt", pe."createdBy" AS "eventCreatedBy" FROM "booking_intents" bi JOIN "users" u ON u.id = bi."userId" JOIN "payments" p ON p."bookingIntentId" = bi.id JOIN "idempotency_keys" ik ON ik.id = p."idempotencyKeyId" JOIN "bookings" b ON b."bookingIntentId" = bi.id AND b."paymentId" = p.id JOIN "payment_events" pe ON pe."paymentId" = p.id WHERE bi.id = $1 AND p.id = $2 AND ik.id = $3 AND b.id = $4 AND pe.id = $5',
    references.bookingIntentId,
    references.paymentId,
    references.idempotencyKeyId,
    references.bookingId,
    references.paymentEventId,
  );
}

describe('legacy fulfillment recovery migration compatibility', () => {
  jest.setTimeout(180_000);

  it('preserves legacy evidence and references without inferring provider success', async () => {
    const fixture = await createLegacyMigrationFixture();
    try {
      const references = await createLegacyRows(fixture.prisma);
      const beforeMigration = await readLegacySnapshot(fixture.prisma, references);
      expect(beforeMigration).toHaveLength(1);
      expect(beforeMigration[0]?.paymentStatus).toBe('AUTHORIZED');
      expect(beforeMigration[0]?.bookingStatus).toBe('PROCESSING');
      expect(beforeMigration[0]?.supplierOrderId).toBeNull();

      fixture.applyCurrentMigration();

      const afterMigration = await readLegacySnapshot(fixture.prisma, references);
      expect(afterMigration).toEqual(beforeMigration);

      const stripePaymentIntentId = afterMigration[0]?.stripePaymentIntentId;
      if (typeof stripePaymentIntentId !== 'string') {
        throw new Error('The legacy payment must retain its original non-null Stripe ID');
      }
      await expect(
        fixture.prisma.$executeRawUnsafe(
          'INSERT INTO "payments" ("id", "bookingIntentId", "attemptNumber", "idempotencyKeyId", "stripePaymentIntentId", "amount", "currency", "updatedAt") VALUES ($1, $2, 2, $3, $4, $5, $6, CURRENT_TIMESTAMP)',
          randomUUID(),
          references.bookingIntentId,
          references.idempotencyKeyId,
          stripePaymentIntentId,
          afterMigration[0]?.amount,
          afterMigration[0]?.paymentCurrency,
        ),
      ).rejects.toThrow();

      const newLinks = await fixture.prisma.$queryRawUnsafe<LegacyJournalLinks[]>(
        'SELECT p."fulfillmentWorkflowId" AS "paymentWorkflowId", pe."providerOperationId" AS "providerOperationId", pe."providerAttemptId" AS "providerAttemptId", pe.provider::text AS "provider", pe."evidenceKind"::text AS "evidenceKind", pe."outcomeClass"::text AS "outcomeClass", pe."bookingIntentMatched" AS "bookingIntentMatched", pe."offerMatched" AS "offerMatched", pe."passengerSetMatched" AS "passengerSetMatched", pe."itineraryMatched" AS "itineraryMatched" FROM "payments" p JOIN "payment_events" pe ON pe."paymentId" = p.id WHERE p.id = $1 AND pe.id = $2',
        references.paymentId,
        references.paymentEventId,
      );
      expect(newLinks).toEqual([
        {
          paymentWorkflowId: null,
          providerOperationId: null,
          providerAttemptId: null,
          provider: null,
          evidenceKind: null,
          outcomeClass: null,
          bookingIntentMatched: null,
          offerMatched: null,
          passengerSetMatched: null,
          itineraryMatched: null,
        },
      ]);

      const journalCounts = await fixture.prisma.$queryRawUnsafe<
        Array<{ workflowCount: number; operationCount: number; attemptCount: number }>
      >(
        'SELECT (SELECT COUNT(*)::int FROM "fulfillment_workflows") AS "workflowCount", (SELECT COUNT(*)::int FROM "provider_operations") AS "operationCount", (SELECT COUNT(*)::int FROM "provider_attempts") AS "attemptCount"',
      );
      expect(journalCounts).toEqual([{ workflowCount: 0, operationCount: 0, attemptCount: 0 }]);
    } finally {
      await fixture.dispose();
    }
  });
});

describe('persisted payment reservation reader', () => {
  it('returns a safe pending status without a client secret for a reserved row', async () => {
    const fixture = await createMigrationFixture();
    try {
      await createPaymentFixture(fixture.prisma, null);
      const paymentRows = await fixture.prisma.$queryRawUnsafe<
        Array<{ paymentId: string; userId: string; stripePaymentIntentId: string | null }>
      >(
        'SELECT p.id AS "paymentId", bi."userId" AS "userId", p."stripePaymentIntentId" AS "stripePaymentIntentId" FROM "payments" p JOIN "booking_intents" bi ON bi.id = p."bookingIntentId"',
      );
      expect(paymentRows).toHaveLength(1);
      const payment = paymentRows[0];
      if (!payment) {
        throw new Error('Payment reservation fixture did not create its expected payment');
      }
      await fixture.prisma.$executeRawUnsafe(
        'UPDATE "payments" SET "status" = $2::"PaymentStatus" WHERE "id" = $1',
        payment.paymentId,
        'RESERVED',
      );
      const reservationRows = await fixture.prisma.$queryRawUnsafe<
        Array<{ stripePaymentIntentId: string | null; status: string }>
      >(
        'SELECT "stripePaymentIntentId" AS "stripePaymentIntentId", status::text AS "status" FROM "payments" WHERE id = $1',
        payment.paymentId,
      );
      expect(reservationRows).toEqual([{ stripePaymentIntentId: null, status: 'RESERVED' }]);

      const testingModule = await Test.createTestingModule({
        providers: [
          PaymentService,
          { provide: PrismaService, useValue: fixture.prisma },
          { provide: StripeService, useValue: {} },
          { provide: PaymentIdempotencyService, useValue: {} },
          { provide: AuditService, useValue: {} },
        ],
      }).compile();
      try {
        const paymentService = testingModule.get(PaymentService);
        const publicStatus = await paymentService.getPaymentStatus(payment.paymentId, payment.userId);
        expect(publicStatus).toEqual({
          paymentId: payment.paymentId,
          status: 'PENDING',
          amount: 12500,
          currency: 'USD',
          bookingIntentStatus: 'PENDING',
          attemptNumber: 1,
        });
        expect(publicStatus).not.toHaveProperty('clientSecret');
      } finally {
        await testingModule.close();
      }
    } finally {
      await fixture.dispose();
    }
  });
});