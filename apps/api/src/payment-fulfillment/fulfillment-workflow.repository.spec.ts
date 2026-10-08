import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FulfillmentWorkflowRepository,
  type WorkflowActor,
  type WorkflowClaim,
} from './fulfillment-workflow.repository';

type ClaimIntegrationFixture = {
  schemaName: string;
  adminPrisma: PrismaClient;
  prismaA: PrismaClient;
  prismaB: PrismaClient;
  repositoryModuleA: TestingModule;
  repositoryModuleB: TestingModule;
  repositoryA: FulfillmentWorkflowRepository;
  repositoryB: FulfillmentWorkflowRepository;
  dispose: () => Promise<void>;
};

let claimFixture: ClaimIntegrationFixture | undefined;

function getClaimFixture(): ClaimIntegrationFixture {
  if (!claimFixture) {
    throw new Error('Claim integration fixture was not initialized');
  }
  return claimFixture;
}

async function createRepositoryModule(prisma: PrismaClient): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      FulfillmentWorkflowRepository,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
}

async function createClaimIntegrationFixture(): Promise<ClaimIntegrationFixture> {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error('DATABASE_URL must target the fulfillment_recovery_test database');
  }

  const parsedDatabaseUrl = new URL(baseDatabaseUrl);
  if (
    parsedDatabaseUrl.pathname !== '/fulfillment_recovery_test' ||
    (parsedDatabaseUrl.hostname !== '127.0.0.1' && parsedDatabaseUrl.hostname !== 'localhost')
  ) {
    throw new Error('Claim fixtures may only use the local fulfillment_recovery_test database');
  }

  const schemaName = 'fulfillment_recovery_' + randomUUID().replaceAll('-', '');
  const inspectionDatabaseUrl = new URL(baseDatabaseUrl);
  inspectionDatabaseUrl.searchParams.set('schema', 'public');
  const adminPrisma = new PrismaClient({
    datasources: { db: { url: inspectionDatabaseUrl.toString() } },
  });
  let schemaCreated = false;
  let migrationPrisma: PrismaClient | undefined;
  let prismaA: PrismaClient | undefined;
  let prismaB: PrismaClient | undefined;
  let repositoryModuleA: TestingModule | undefined;
  let repositoryModuleB: TestingModule | undefined;

  const dispose = async (): Promise<void> => {
    if (repositoryModuleA) {
      await repositoryModuleA.close();
    }
    if (repositoryModuleB) {
      await repositoryModuleB.close();
    }
    if (prismaA) {
      await prismaA.$disconnect();
    }
    if (prismaB) {
      await prismaB.$disconnect();
    }
    if (migrationPrisma) {
      await migrationPrisma.$disconnect();
    }
    if (schemaCreated) {
      await adminPrisma.$executeRawUnsafe('DROP SCHEMA "' + schemaName + '" CASCADE');
    }
    await adminPrisma.$disconnect();
  };

  try {
    await adminPrisma.$executeRawUnsafe('CREATE SCHEMA "' + schemaName + '"');
    schemaCreated = true;

    const fixtureDatabaseUrl = new URL(baseDatabaseUrl);
    fixtureDatabaseUrl.searchParams.set('schema', schemaName);
    const scopedDatabaseUrl = fixtureDatabaseUrl.toString();
    migrationPrisma = new PrismaClient({
      datasources: { db: { url: scopedDatabaseUrl } },
    });

    const migrationResult = spawnSync(
      process.execPath,
      [
        path.resolve(__dirname, '../../node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        path.resolve(__dirname, '../../prisma/schema.prisma'),
      ],
      {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: scopedDatabaseUrl },
      },
    );

    if (migrationResult.error) {
      throw new Error('Prisma migration deploy could not start: ' + migrationResult.error.message);
    }
    if (migrationResult.status !== 0) {
      const output = ((migrationResult.stdout ?? '') + '\n' + (migrationResult.stderr ?? '')).replaceAll(
        scopedDatabaseUrl,
        '[redacted DATABASE_URL]',
      );
      throw new Error('Prisma migration deploy failed: ' + output);
    }
    await migrationPrisma.$disconnect();
    migrationPrisma = undefined;

    prismaA = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
    prismaB = new PrismaClient({ datasources: { db: { url: scopedDatabaseUrl } } });
    repositoryModuleA = await createRepositoryModule(prismaA);
    repositoryModuleB = await createRepositoryModule(prismaB);

    const firstModule = repositoryModuleA;
    const secondModule = repositoryModuleB;
    const firstPrisma = prismaA;
    const secondPrisma = prismaB;
    return {
      schemaName,
      adminPrisma,
      prismaA: firstPrisma,
      prismaB: secondPrisma,
      repositoryModuleA: firstModule,
      repositoryModuleB: secondModule,
      repositoryA: firstModule.get(FulfillmentWorkflowRepository),
      repositoryB: secondModule.get(FulfillmentWorkflowRepository),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function createWorkflowFixture(
  prisma: PrismaClient,
  bookingIntentId: string,
): Promise<void> {
  const user = await prisma.user.create({
    data: {
      email: 'claim-' + randomUUID() + '@example.test',
      password: 'test-only-password',
    },
  });
  const bookingIntent = await prisma.bookingIntent.create({
    data: {
      id: bookingIntentId,
      userId: user.id,
      supplierOfferId: 'supplier-' + randomUUID(),
      originalPrice: 125,
      confirmedPrice: 125,
      pricedAt: new Date('2026-10-01T00:00:00.000Z'),
      origin: 'SFO',
      destination: 'LAX',
      departureDate: new Date('2030-01-15T00:00:00.000Z'),
      adults: 1,
      rawOfferSnapshot: { fixture: 'claim' },
      intentExpiresAt: new Date('2029-12-01T00:00:00.000Z'),
    },
  });
  await prisma.fulfillmentWorkflow.create({
    data: { bookingIntentId: bookingIntent.id },
  });
}

describe('FulfillmentWorkflowRepository database claims', () => {
  jest.setTimeout(180_000);

  beforeAll(async () => {
    claimFixture = await createClaimIntegrationFixture();
  });

  afterAll(async () => {
    if (claimFixture) {
      await claimFixture.dispose();
      claimFixture = undefined;
    }
  });

  it('allows only one concurrent workflow claimant', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const sagaActor: WorkflowActor = { kind: 'SAGA', actorId: 'saga-1' };
    const recoveryActor: WorkflowActor = { kind: 'RECOVERY', actorId: 'recovery-1' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const results = await Promise.all([
      fixture.repositoryA.acquireClaim(bookingIntentId, sagaActor),
      fixture.repositoryB.acquireClaim(bookingIntentId, recoveryActor),
    ]);
    const claims = results.filter((claim): claim is WorkflowClaim => claim !== null);

    expect(claims).toHaveLength(1);
  });
});