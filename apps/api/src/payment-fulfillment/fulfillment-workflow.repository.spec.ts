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
  it('renews an active claim without changing its fence', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'renewal-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }

    const renewedClaim = await fixture.repositoryB.renewClaim(claim, 60_000);
    if (renewedClaim === null) {
      throw new Error('Active workflow claim was not renewed');
    }

    expect(renewedClaim.ownerToken).toBe(claim.ownerToken);
    expect(renewedClaim.fence).toBe(claim.fence);
    expect(renewedClaim.leaseExpiresAt.getTime()).toBeGreaterThan(claim.leaseExpiresAt.getTime());
  });

  it.each(['America/Los_Angeles', 'Asia/Tokyo'])(
    'uses UTC lease timestamps with the session in %s',
    async (timeZone) => {
      const fixture = getClaimFixture();
      const bookingIntentId = randomUUID();
      const actor: WorkflowActor = { kind: 'SAGA', actorId: 'timezone-saga' };
      await createWorkflowFixture(fixture.prismaA, bookingIntentId);
      const baseDatabaseUrl = process.env.DATABASE_URL;
      if (!baseDatabaseUrl) {
        throw new Error('DATABASE_URL must target the fulfillment_recovery_test database');
      }
      const databaseUrl = new URL(baseDatabaseUrl);
      databaseUrl.searchParams.set('schema', fixture.schemaName);
      databaseUrl.searchParams.set('connection_limit', '1');
      const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl.toString() } } });
      let module: TestingModule | undefined;
      try {
        await prisma.$queryRaw`SELECT set_config('TimeZone', ${timeZone}, false)`;
        module = await createRepositoryModule(prisma);
        const repository = module.get(FulfillmentWorkflowRepository);
        const startedAt = Date.now();
        const claim = await repository.acquireClaim(bookingIntentId, actor, 60_000);
        if (!claim) {
          throw new Error('Initial workflow claim was not acquired');
        }
        const acquired = await prisma.fulfillmentWorkflow.findUniqueOrThrow({
          where: { bookingIntentId },
        });
        expect(claim.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(startedAt + 60_000);
        expect(claim.leaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
        for (const timestamp of [acquired.renewedAt, acquired.updatedAt]) {
          expect(timestamp?.getTime()).toBeGreaterThanOrEqual(startedAt);
          expect(timestamp?.getTime()).toBeLessThanOrEqual(Date.now());
        }
        expect(await repository.acquireClaim(bookingIntentId, actor)).toBeNull();
        expect(await repository.runFencedTransaction(claim, async () => 'written')).toEqual({
          kind: 'APPLIED', value: 'written',
        });

        const renewalStartedAt = Date.now();
        const renewedClaim = await repository.renewClaim(claim, 120_000);
        if (!renewedClaim) {
          throw new Error('Active workflow claim was not renewed');
        }
        const renewed = await prisma.fulfillmentWorkflow.findUniqueOrThrow({
          where: { bookingIntentId },
        });
        expect(renewedClaim.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(renewalStartedAt + 120_000);
        expect(renewedClaim.leaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 120_000);
        for (const timestamp of [renewed.renewedAt, renewed.updatedAt]) {
          expect(timestamp?.getTime()).toBeGreaterThanOrEqual(renewalStartedAt);
          expect(timestamp?.getTime()).toBeLessThanOrEqual(Date.now());
        }
        expect(await repository.runFencedTransaction(renewedClaim, async (tx) => {
          await tx.fulfillmentWorkflow.update({
            where: { bookingIntentId },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
          });
          return 'expired during write';
        })).toEqual({ kind: 'FENCED_OUT' });
        expect((await prisma.fulfillmentWorkflow.findUniqueOrThrow({
          where: { bookingIntentId },
        })).leaseExpiresAt).toEqual(renewedClaim.leaseExpiresAt);

        await prisma.fulfillmentWorkflow.update({
          where: { bookingIntentId },
          data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
        });
        expect(await repository.renewClaim(renewedClaim)).toBeNull();
        const write = jest.fn(async () => 'should not run');
        expect(await repository.runFencedTransaction(renewedClaim, write)).toEqual({ kind: 'FENCED_OUT' });
        expect(write).not.toHaveBeenCalled();
        const takeover = await repository.acquireClaim(bookingIntentId, actor);
        expect(takeover?.fence).toBe(renewedClaim.fence + 1n);
      } finally {
        await module?.close();
        await prisma.$disconnect();
      }
    },
  );

  it('takes over an expired lease with a higher fence', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'original-saga' };
    const takeoverActor: WorkflowActor = { kind: 'RECOVERY', actorId: 'takeover-recovery' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const originalClaim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 200);
    if (originalClaim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    const takeoverClaim = await fixture.repositoryB.acquireClaim(bookingIntentId, takeoverActor, 10_000);
    if (takeoverClaim === null) {
      throw new Error('Expired workflow claim was not taken over');
    }

    expect(takeoverClaim.ownerToken).not.toBe(originalClaim.ownerToken);
    expect(takeoverClaim.fence).toBeGreaterThan(originalClaim.fence);
  });

  it('rejects an expired claim before invoking a fenced write', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'expired-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 200);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    let callbackInvoked = false;
    const result = await fixture.repositoryB.runFencedTransaction(claim, async () => {
      callbackInvoked = true;
      return 'written';
    });

    expect(result).toEqual({ kind: 'FENCED_OUT' });
    expect(callbackInvoked).toBe(false);
  });

  it('rejects the stale token and fence after takeover without writing workflow state', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const originalActor: WorkflowActor = { kind: 'SAGA', actorId: 'stale-saga' };
    const takeoverActor: WorkflowActor = { kind: 'RECOVERY', actorId: 'current-recovery' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const staleClaim = await fixture.repositoryA.acquireClaim(bookingIntentId, originalActor, 200);
    if (staleClaim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    const currentClaim = await fixture.repositoryB.acquireClaim(bookingIntentId, takeoverActor, 10_000);
    if (currentClaim === null) {
      throw new Error('Expired workflow claim was not taken over');
    }

    let callbackInvoked = false;
    const result = await fixture.repositoryA.runFencedTransaction(staleClaim, async (tx) => {
      callbackInvoked = true;
      await tx.fulfillmentWorkflow.update({
        where: { id: staleClaim.workflowId },
        data: { version: { increment: 1 } },
      });
      return 'written';
    });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { version: true },
    });

    expect(currentClaim.fence).toBeGreaterThan(staleClaim.fence);
    expect(result).toEqual({ kind: 'FENCED_OUT' });
    expect(callbackInvoked).toBe(false);
    expect(workflow?.version).toBe(0);
  });

  it('rejects a stale owner token when its fence still matches', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'stale-token-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    const staleTokenClaim = { ...claim, ownerToken: claim.ownerToken + '-stale' };
    let callbackInvoked = false;
    const result = await fixture.repositoryB.runFencedTransaction(staleTokenClaim, async (tx) => {
      callbackInvoked = true;
      await tx.fulfillmentWorkflow.update({
        where: { id: claim.workflowId },
        data: { version: { increment: 1 } },
      });
      return 'written';
    });
    const workflow = await fixture.prismaA.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { version: true },
    });

    expect(staleTokenClaim.fence).toBe(claim.fence);
    expect(result).toEqual({ kind: 'FENCED_OUT' });
    expect(callbackInvoked).toBe(false);
    expect(workflow?.version).toBe(0);
  });

  it('rejects a stale fence when the owner token still matches', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'stale-fence-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    const staleFenceClaim = { ...claim, fence: claim.fence + 1n };
    let callbackInvoked = false;
    const result = await fixture.repositoryB.runFencedTransaction(staleFenceClaim, async (tx) => {
      callbackInvoked = true;
      await tx.fulfillmentWorkflow.update({
        where: { id: claim.workflowId },
        data: { version: { increment: 1 } },
      });
      return 'written';
    });
    const workflow = await fixture.prismaA.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { version: true },
    });

    expect(staleFenceClaim.ownerToken).toBe(claim.ownerToken);
    expect(result).toEqual({ kind: 'FENCED_OUT' });
    expect(callbackInvoked).toBe(false);
    expect(workflow?.version).toBe(0);
  });
  it('rejects mismatched workflow and booking-intent scope before callback', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'scope-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }

    let callbackInvoked = false;
    const wrongWorkflowScope = await fixture.repositoryB.runFencedTransaction(
      { ...claim, workflowId: randomUUID() },
      async () => {
        callbackInvoked = true;
        return 'written';
      },
    );
    const wrongIntentScope = await fixture.repositoryB.runFencedTransaction(
      { ...claim, bookingIntentId: randomUUID() },
      async () => {
        callbackInvoked = true;
        return 'written';
      },
    );

    expect(wrongWorkflowScope).toEqual({ kind: 'FENCED_OUT' });
    expect(wrongIntentScope).toEqual({ kind: 'FENCED_OUT' });
    expect(callbackInvoked).toBe(false);
  });

  // Human-approved 2026-10-08: assert the fenced callback write ran before lease-expiry rollback.
  // Human-approved 2026-10-08: move the callback-expiry case into its fixture describe without changing its assertions.
  it('rolls back local writes when the lease expires during a fenced callback', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'slow-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 200);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }

    let callbackInvoked = false;
    const result = await fixture.repositoryA.runFencedTransaction(claim, async (tx) => {
      await tx.fulfillmentWorkflow.update({
        where: { id: claim.workflowId },
        data: { version: { increment: 1 } },
      });
      callbackInvoked = true;
      await new Promise<void>((resolve) => setTimeout(resolve, 400));
      return 'written';
    });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { version: true },
    });

    expect(callbackInvoked).toBe(true);
    expect(result).toEqual({ kind: 'FENCED_OUT' });
    expect(workflow?.version).toBe(0);
  });

  it('uses the default lease duration when none is supplied', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'default-lease-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor);
    if (claim === null) {
      throw new Error('Default workflow claim was not acquired');
    }
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { leaseExpiresAt: true, updatedAt: true },
    });
    if (workflow?.leaseExpiresAt === null || workflow?.leaseExpiresAt === undefined) {
      throw new Error('Default workflow lease expiry was not persisted');
    }

    const persistedLeaseMs = workflow.leaseExpiresAt.getTime() - workflow.updatedAt.getTime();
    expect(persistedLeaseMs).toBeGreaterThan(175_000);
    expect(persistedLeaseMs).toBeLessThanOrEqual(180_000);
  });

  it('requires positive integer lease durations for acquisition and renewal', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'invalid-lease-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    await expect(fixture.repositoryA.acquireClaim(bookingIntentId, actor, 0)).rejects.toThrow(RangeError);
    await expect(fixture.repositoryA.acquireClaim(bookingIntentId, actor, 1.5)).rejects.toThrow(RangeError);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    await expect(fixture.repositoryB.renewClaim(claim, 0)).rejects.toThrow(RangeError);
    await expect(fixture.repositoryB.renewClaim(claim, 1.5)).rejects.toThrow(RangeError);
  });

  it('does not renew an expired claim', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'expired-renewal-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 200);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 400));

    const renewedClaim = await fixture.repositoryB.renewClaim(claim, 10_000);

    expect(renewedClaim).toBeNull();
  });

  it('commits writes for the current owner while its lease is active', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const actor: WorkflowActor = { kind: 'SAGA', actorId: 'current-owner-saga' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);

    const claim = await fixture.repositoryA.acquireClaim(bookingIntentId, actor, 10_000);
    if (claim === null) {
      throw new Error('Initial workflow claim was not acquired');
    }
    const result = await fixture.repositoryA.runFencedTransaction(claim, async (tx) => {
      await tx.fulfillmentWorkflow.update({
        where: { id: claim.workflowId },
        data: { version: { increment: 1 } },
      });
      return 'written';
    });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { version: true },
    });

    expect(result).toEqual({ kind: 'APPLIED', value: 'written' });
    expect(workflow?.version).toBe(1);
  });

  it('allows only one claimant when both clients find the workflow row missing', async () => {
    const fixture = getClaimFixture();
    const bookingIntentId = randomUUID();
    const sagaActor: WorkflowActor = { kind: 'SAGA', actorId: 'missing-row-saga' };
    const recoveryActor: WorkflowActor = { kind: 'RECOVERY', actorId: 'missing-row-recovery' };
    await createWorkflowFixture(fixture.prismaA, bookingIntentId);
    await fixture.prismaA.fulfillmentWorkflow.delete({ where: { bookingIntentId } });

    const results = await Promise.all([
      fixture.repositoryA.acquireClaim(bookingIntentId, sagaActor),
      fixture.repositoryB.acquireClaim(bookingIntentId, recoveryActor),
    ]);
    const claims = results.filter((claim): claim is WorkflowClaim => claim !== null);

    expect(claims).toHaveLength(1);
  });
});
