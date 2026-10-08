import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Test, type TestingModule } from '@nestjs/testing';
import { PaymentStatus, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  FulfillmentWorkflowRepository,
  type WorkflowActor,
  type WorkflowClaim,
} from './fulfillment-workflow.repository';
import { ProviderOperationService } from './provider-operation.service';

type ProviderOperationFixture = {
  schemaName: string;
  adminPrisma: PrismaClient;
  prismaA: PrismaClient;
  prismaB: PrismaClient;
  moduleA: TestingModule;
  moduleB: TestingModule;
  repositoryA: FulfillmentWorkflowRepository;
  repositoryB: FulfillmentWorkflowRepository;
  serviceA: ProviderOperationService;
  serviceB: ProviderOperationService;
  dispose: () => Promise<void>;
};

type BookingIntentFixture = {
  bookingIntentId: string;
  userId: string;
  idempotencyKeyId: string;
};

let integrationFixture: ProviderOperationFixture | undefined;

const sagaActor: WorkflowActor = { kind: 'SAGA', actorId: 'provider-operation-spec' };
const recoveryActor: WorkflowActor = { kind: 'RECOVERY', actorId: 'provider-operation-spec' };

function getIntegrationFixture(): ProviderOperationFixture {
  if (!integrationFixture) {
    throw new Error('Provider operation integration fixture was not initialized');
  }
  return integrationFixture;
}

function requireClaim(claim: WorkflowClaim | null): WorkflowClaim {
  if (claim === null) {
    throw new Error('Expected workflow claim to be acquired');
  }
  return claim;
}

async function createServiceModule(prisma: PrismaClient): Promise<TestingModule> {
  return Test.createTestingModule({
    providers: [
      ProviderOperationService,
      FulfillmentWorkflowRepository,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
}

async function createIntegrationFixture(): Promise<ProviderOperationFixture> {
  const baseDatabaseUrl = process.env.DATABASE_URL;
  if (!baseDatabaseUrl) {
    throw new Error('DATABASE_URL must target the fulfillment_recovery_test database');
  }

  const parsedDatabaseUrl = new URL(baseDatabaseUrl);
  if (
    parsedDatabaseUrl.pathname !== '/fulfillment_recovery_test' ||
    (parsedDatabaseUrl.hostname !== '127.0.0.1' && parsedDatabaseUrl.hostname !== 'localhost')
  ) {
    throw new Error('Provider operation fixtures may only use the local fulfillment_recovery_test database');
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
  let moduleA: TestingModule | undefined;
  let moduleB: TestingModule | undefined;

  const dispose = async (): Promise<void> => {
    if (moduleA) {
      await moduleA.close();
    }
    if (moduleB) {
      await moduleB.close();
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
      await adminPrisma.$executeRawUnsafe('DROP SCHEMA ' + schemaName + ' CASCADE');
    }
    await adminPrisma.$disconnect();
  };

  try {
    await adminPrisma.$executeRawUnsafe('CREATE SCHEMA ' + schemaName);
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
    moduleA = await createServiceModule(prismaA);
    moduleB = await createServiceModule(prismaB);

    const readyModuleA = moduleA;
    const readyModuleB = moduleB;
    const readyPrismaA = prismaA;
    const readyPrismaB = prismaB;
    return {
      schemaName,
      adminPrisma,
      prismaA: readyPrismaA,
      prismaB: readyPrismaB,
      moduleA: readyModuleA,
      moduleB: readyModuleB,
      repositoryA: readyModuleA.get(FulfillmentWorkflowRepository),
      repositoryB: readyModuleB.get(FulfillmentWorkflowRepository),
      serviceA: readyModuleA.get(ProviderOperationService),
      serviceB: readyModuleB.get(ProviderOperationService),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function createIdempotencyKey(prisma: PrismaClient, userId: string): Promise<string> {
  const idempotencyKey = await prisma.idempotencyKey.create({
    data: {
      key: 'provider-operation-' + randomUUID(),
      requestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      customerId: userId,
      requestPath: '/bookings/payment/create',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    },
  });
  return idempotencyKey.id;
}

async function createBookingIntentFixture(prisma: PrismaClient): Promise<BookingIntentFixture> {
  const user = await prisma.user.create({
    data: {
      email: 'provider-operation-' + randomUUID() + '@example.test',
      password: 'test-only-password',
    },
  });
  const bookingIntent = await prisma.bookingIntent.create({
    data: {
      userId: user.id,
      supplierOfferId: 'supplier-' + randomUUID(),
      originalPrice: 420,
      confirmedPrice: 420,
      pricedAt: new Date('2026-10-01T00:00:00.000Z'),
      origin: 'SFO',
      destination: 'LAX',
      departureDate: new Date('2030-01-15T00:00:00.000Z'),
      adults: 1,
      rawOfferSnapshot: { fixture: 'provider-operation' },
      intentExpiresAt: new Date('2029-12-01T00:00:00.000Z'),
    },
  });
  const idempotencyKeyId = await createIdempotencyKey(prisma, user.id);
  return { bookingIntentId: bookingIntent.id, userId: user.id, idempotencyKeyId };
}

async function expireClaim(prisma: PrismaClient, workflowId: string): Promise<void> {
  await prisma.fulfillmentWorkflow.update({
    where: { id: workflowId },
    data: { leaseExpiresAt: new Date(0) },
  });
}

describe('ProviderOperationService database journal', () => {
  beforeAll(async () => {
    integrationFixture = await createIntegrationFixture();
  });

  afterAll(async () => {
    if (integrationFixture) {
      await integrationFixture.dispose();
    }
    integrationFixture = undefined;
  });

  it('atomically reserves one payment and intent operation across a fresh key and claim fence', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const firstClaim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const firstReservation = await fixture.serviceA.reservePaymentAndIntentCreate(firstClaim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });

    const firstPayment = await fixture.prismaA.payment.findUnique({
      where: { id: firstReservation.paymentId },
    });
    if (!firstPayment) {
      throw new Error('Reserved payment was not persisted');
    }
    expect(firstPayment.status).toBe(PaymentStatus.RESERVED);
    expect(firstPayment.stripePaymentIntentId).toBeNull();
    expect(firstPayment.idempotencyKeyId).toBe(booking.idempotencyKeyId);
    expect(firstPayment.fulfillmentWorkflowId).toBe(firstClaim.workflowId);
    expect(firstPayment.amount).toBe(42_000);
    expect(firstPayment.currency).toBe('usd');

    const firstWorkflow = await fixture.prismaA.fulfillmentWorkflow.findUnique({
      where: { id: firstClaim.workflowId },
    });
    if (!firstWorkflow) {
      throw new Error('Fulfillment workflow disappeared');
    }
    expect(firstWorkflow.currentPaymentId).toBe(firstReservation.paymentId);

    const firstOperations = await fixture.prismaA.providerOperation.findMany({
      where: { workflowId: firstClaim.workflowId },
    });
    expect(firstOperations).toHaveLength(1);
    expect(firstOperations[0].id).toBe(firstReservation.operation.id);
    expect(firstOperations[0].paymentId).toBe(firstReservation.paymentId);
    expect(firstReservation.operation.provider).toBe('STRIPE');
    expect(firstReservation.operation.purpose).toBe('PAYMENT_INTENT_CREATE');
    expect(firstReservation.operation.logicalSequence).toBe(1);

    const replacementIdempotencyKeyId = await createIdempotencyKey(fixture.prismaA, booking.userId);
    await expireClaim(fixture.prismaA, firstClaim.workflowId);
    const takeoverClaim = requireClaim(await fixture.repositoryB.acquireClaim(booking.bookingIntentId, recoveryActor));
    expect(takeoverClaim.fence).toBeGreaterThan(firstClaim.fence);
    const sameReservation = await fixture.serviceB.reservePaymentAndIntentCreate(takeoverClaim, {
      idempotencyKeyId: replacementIdempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });

    expect(sameReservation.paymentId).toBe(firstReservation.paymentId);
    expect(sameReservation.operation.id).toBe(firstReservation.operation.id);
    const payments = await fixture.prismaB.payment.findMany({
      where: { fulfillmentWorkflowId: takeoverClaim.workflowId },
    });
    const operations = await fixture.prismaB.providerOperation.findMany({
      where: { workflowId: takeoverClaim.workflowId },
    });
    expect(payments).toHaveLength(1);
    expect(payments[0].idempotencyKeyId).toBe(booking.idempotencyKeyId);
    expect(payments[0].stripePaymentIntentId).toBeNull();
    expect(operations).toHaveLength(1);
  });
});
