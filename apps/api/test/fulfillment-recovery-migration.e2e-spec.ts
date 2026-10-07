import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

type MigrationFixture = {
  schemaName: string;
  prisma: PrismaClient;
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
  const adminPrisma = new PrismaClient({ datasources: { db: { url: baseDatabaseUrl } } });
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

describe('fulfillment recovery migration compatibility', () => {
  jest.setTimeout(120_000);

  it('adds the workflow table to a clean migrated schema', async () => {
    const fixture = await createMigrationFixture();
    try {
      const rows = await fixture.prisma.$queryRawUnsafe<Array<{ tableName: string | null }>>(
        'SELECT to_regclass($1)::text AS "tableName"',
        fixture.schemaName + '.fulfillment_workflows',
      );
      expect(rows[0]?.tableName).toBe(fixture.schemaName + '.fulfillment_workflows');
    } finally {
      await fixture.dispose();
    }
  });
});