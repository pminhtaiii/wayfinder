import { VirtualFulfillmentRecoveryScheduler } from './scheduler';

describe('fulfillment recovery scheduler', () => {
  it('runs only jobs due by the advanced virtual time in due-time order', async () => {
    const scheduler = new VirtualFulfillmentRecoveryScheduler(
      new Date('2026-10-07T00:00:00.000Z'),
    );
    const executed: string[] = [];

    scheduler.register('later', new Date('2026-10-07T00:00:03.000Z'), async () => {
      executed.push('later');
    });
    scheduler.register('first', new Date('2026-10-07T00:00:01.000Z'), async () => {
      executed.push('first');
    });

    await expect(scheduler.advance(2_000, 10)).resolves.toEqual({
      executedJobIds: ['first'],
      nextDueAt: new Date('2026-10-07T00:00:03.000Z'),
      exceededBudget: false,
    });
    expect(executed).toEqual(['first']);
  });
});

  it('limits each advance to its explicit job budget', async () => {
    const scheduler = new VirtualFulfillmentRecoveryScheduler(
      new Date('2026-10-07T00:00:00.000Z'),
    );
    const executed: string[] = [];
    for (const jobId of ['first', 'second', 'third']) {
      scheduler.register(jobId, new Date('2026-10-07T00:00:01.000Z'), async () => {
        executed.push(jobId);
      });
    }

    await expect(scheduler.advance(1_000, 2)).resolves.toEqual({
      executedJobIds: ['first', 'second'],
      nextDueAt: new Date('2026-10-07T00:00:01.000Z'),
      exceededBudget: true,
    });
    expect(executed).toEqual(['first', 'second']);
  });

it('orders equal due times by job ID', async () => {
  const scheduler = new VirtualFulfillmentRecoveryScheduler(
    new Date('2026-10-07T00:00:00.000Z'),
  );
  const executed: string[] = [];
  for (const jobId of ['charlie', 'alpha', 'bravo']) {
    scheduler.register(jobId, new Date('2026-10-07T00:00:01.000Z'), async () => {
      executed.push(jobId);
    });
  }

  await scheduler.advance(1_000, 3);
  expect(executed).toEqual(['alpha', 'bravo', 'charlie']);
});

it('cancels a registered job before it becomes due', async () => {
  const scheduler = new VirtualFulfillmentRecoveryScheduler(
    new Date('2026-10-07T00:00:00.000Z'),
  );
  const run = jest.fn(async (): Promise<void> => undefined);
  scheduler.register('cancel-me', new Date('2026-10-07T00:00:01.000Z'), run);
  scheduler.cancel('cancel-me');

  await expect(scheduler.advance(1_000, 1)).resolves.toEqual({
    executedJobIds: [],
    nextDueAt: null,
    exceededBudget: false,
  });
  expect(run).not.toHaveBeenCalled();
});

it('rejects a provider-purpose pair that cannot produce its outcome', async () => {
  const { assertSupportedFaultSelection } = await import('./scenarios');

  expect(() =>
    assertSupportedFaultSelection({
      provider: 'STRIPE',
      purpose: 'PAYMENT_INTENT_CREATE',
      bookingIntentId: 'scenario-pair-test',
      outcome: 'ZERO_CANDIDATES',
    }),
  ).toThrow('Unsupported fulfillment fault scenario');
});

it('publishes a finite versioned manifest for contract-supported fault pairs', async () => {
  const {
    assertSupportedFaultSelection,
    FULFILLMENT_SCENARIO_MANIFEST,
    FULFILLMENT_SCENARIO_MANIFEST_VERSION,
  } = await import('./scenarios');

  expect(FULFILLMENT_SCENARIO_MANIFEST_VERSION).toBe(1);
  expect(Object.isFrozen(FULFILLMENT_SCENARIO_MANIFEST)).toBe(true);
  const pairKeys = FULFILLMENT_SCENARIO_MANIFEST.map(({ provider, purpose, outcome }) =>
    [provider, purpose, outcome].join(':'),
  );
  expect(new Set(pairKeys).size).toBe(FULFILLMENT_SCENARIO_MANIFEST.length);
  expect(FULFILLMENT_SCENARIO_MANIFEST).toEqual(
    expect.arrayContaining([
      { provider: 'DUFFEL', purpose: 'ORDER_CREATE', outcome: 'NO_CREATE_LOST_RESPONSE' },
      { provider: 'DUFFEL', purpose: 'ORDER_CREATE', outcome: 'CREATE_COMMITTED_LOST_RESPONSE' },
      { provider: 'DUFFEL', purpose: 'ORDER_CREATE', outcome: 'HELD_LATE_RESPONSE' },
      { provider: 'STRIPE', purpose: 'CAPTURE', outcome: 'CREATE_COMMITTED_LOST_RESPONSE' },
      { provider: 'STRIPE', purpose: 'CAPTURE', outcome: 'UNCOMMITTED_LOST_RESPONSE' },
      { provider: 'DUFFEL', purpose: 'ORDER_CANCEL', outcome: 'UNAVAILABLE' },
      { provider: 'STRIPE', purpose: 'AUTHORIZATION_RELEASE', outcome: 'PROCESSING' },
      { provider: 'STRIPE', purpose: 'REFUND', outcome: 'UNAVAILABLE' },
      { provider: 'STRIPE', purpose: 'RECONCILE', outcome: 'RATE_LIMITED' },
      { provider: 'DUFFEL', purpose: 'RECONCILE', outcome: 'ZERO_CANDIDATES' },
      { provider: 'DUFFEL', purpose: 'RECONCILE', outcome: 'MULTIPLE_CANDIDATES' },
      { provider: 'DUFFEL', purpose: 'RECONCILE', outcome: 'UNLINKED_CANDIDATE' },
    ]),
  );
  for (const { provider, purpose, outcome } of FULFILLMENT_SCENARIO_MANIFEST) {
    expect(() =>
      assertSupportedFaultSelection({
        provider,
        purpose,
        outcome,
        bookingIntentId: 'manifest-self-check',
      }),
    ).not.toThrow();
  }
});

it('represents cancellation, release, and refund uncertainty as processing or unavailable', async () => {
  const { FULFILLMENT_SCENARIO_MANIFEST } = await import('./scenarios');

  expect(FULFILLMENT_SCENARIO_MANIFEST).toEqual(
    expect.arrayContaining([
      { provider: 'DUFFEL', purpose: 'ORDER_CANCEL', outcome: 'PROCESSING' },
      { provider: 'DUFFEL', purpose: 'ORDER_CANCEL', outcome: 'UNAVAILABLE' },
      { provider: 'STRIPE', purpose: 'AUTHORIZATION_RELEASE', outcome: 'PROCESSING' },
      { provider: 'STRIPE', purpose: 'AUTHORIZATION_RELEASE', outcome: 'UNAVAILABLE' },
      { provider: 'STRIPE', purpose: 'REFUND', outcome: 'PROCESSING' },
      { provider: 'STRIPE', purpose: 'REFUND', outcome: 'UNAVAILABLE' },
    ]),
  );
});

it('keeps a short real database lease valid after fifteen virtual minutes', async () => {
  const { randomUUID } = await import('node:crypto');
  const { spawnSync } = await import('node:child_process');
  const nodePath = await import('node:path');
  const { PrismaClient } = await import('@prisma/client');
  const { Test } = await import('@nestjs/testing');
  const { PrismaService } = await import('@/prisma/prisma.service');
  const { FulfillmentWorkflowRepository } = await import(
    '@/payment-fulfillment/fulfillment-workflow.repository'
  );
  const { VirtualFulfillmentRecoveryScheduler } = await import('./scheduler');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must target the fulfillment_recovery_test database');
  }

  const parsedUrl = new URL(databaseUrl);
  if (
    parsedUrl.pathname !== '/fulfillment_recovery_test' ||
    (parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost')
  ) {
    throw new Error('Clock fixtures may only use the local fulfillment_recovery_test database');
  }

  const schemaName = 'fulfillment_recovery_scheduler_' + randomUUID().replaceAll('-', '');
  const inspectionUrl = new URL(databaseUrl);
  inspectionUrl.searchParams.set('schema', 'public');
  const adminPrisma = new PrismaClient({
    datasources: { db: { url: inspectionUrl.toString() } },
  });
  let schemaCreated = false;
  let migrationPrisma: InstanceType<typeof PrismaClient> | undefined;
  let prisma: InstanceType<typeof PrismaClient> | undefined;
  let testingModule: import('@nestjs/testing').TestingModule | undefined;

  try {
    await adminPrisma.$executeRawUnsafe('CREATE SCHEMA "' + schemaName + '"');
    schemaCreated = true;

    const fixtureUrl = new URL(databaseUrl);
    fixtureUrl.searchParams.set('schema', schemaName);
    const scopedUrl = fixtureUrl.toString();
    migrationPrisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } });
    const migration = spawnSync(
      process.execPath,
      [
        nodePath.resolve(__dirname, '../../node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        nodePath.resolve(__dirname, '../../prisma/schema.prisma'),
      ],
      {
        cwd: nodePath.resolve(__dirname, '../..'),
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: scopedUrl },
      },
    );
    if (migration.error) {
      throw new Error('Prisma migration deploy could not start: ' + migration.error.message);
    }
    if (migration.status !== 0) {
      const output = ((migration.stdout ?? '') + '\n' + (migration.stderr ?? '')).replaceAll(
        scopedUrl,
        '[redacted DATABASE_URL]',
      );
      throw new Error('Prisma migration deploy failed: ' + output);
    }
    await migrationPrisma.$disconnect();
    migrationPrisma = undefined;

    prisma = new PrismaClient({ datasources: { db: { url: scopedUrl } } });
    testingModule = await Test.createTestingModule({
      providers: [
        FulfillmentWorkflowRepository,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    const repository = testingModule.get(FulfillmentWorkflowRepository);
    const bookingIntentId = randomUUID();
    const user = await prisma.user.create({
      data: {
        email: 'scheduler-' + randomUUID() + '@example.test',
        password: 'test-only-password',
      },
    });
    await prisma.bookingIntent.create({
      data: {
        id: bookingIntentId,
        userId: user.id,
        supplierOfferId: 'scheduler-' + randomUUID(),
        originalPrice: 125,
        confirmedPrice: 125,
        pricedAt: new Date('2026-10-01T00:00:00.000Z'),
        origin: 'SFO',
        destination: 'LAX',
        departureDate: new Date('2030-01-15T00:00:00.000Z'),
        adults: 1,
        rawOfferSnapshot: { fixture: 'scheduler-clock' },
        intentExpiresAt: new Date('2029-12-01T00:00:00.000Z'),
      },
    });
    const claim = await repository.acquireClaim(
      bookingIntentId,
      { kind: 'RECOVERY', actorId: 'scheduler-clock-test' },
      5_000,
    );
    if (!claim) {
      throw new Error('Could not acquire the short test lease');
    }

    const virtualStart = new Date('2026-10-07T00:00:00.000Z');
    const scheduler = new VirtualFulfillmentRecoveryScheduler(virtualStart);
    const virtualJobId = 'virtual-clock-check';
    scheduler.register(
      virtualJobId,
      new Date(virtualStart.getTime() + 15 * 60 * 1_000),
      async () => undefined,
    );
    const drain = await scheduler.advance(15 * 60 * 1_000, 1);
    expect(drain.executedJobIds).toEqual([virtualJobId]);

    const storedWorkflow = await prisma.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { leaseExpiresAt: true },
    });
    expect(storedWorkflow?.leaseExpiresAt).toEqual(claim.leaseExpiresAt);
    await expect(repository.renewClaim(claim, 5_000)).resolves.not.toBeNull();
  } finally {
    await testingModule?.close();
    await prisma?.$disconnect();
    await migrationPrisma?.$disconnect();
    if (schemaCreated) {
      await adminPrisma.$executeRawUnsafe('DROP SCHEMA "' + schemaName + '" CASCADE');
    }
    await adminPrisma.$disconnect();
  }
}, 180_000);
