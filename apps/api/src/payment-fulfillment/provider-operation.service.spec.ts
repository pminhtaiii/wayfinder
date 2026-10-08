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
  it('reuses an operation identity for one logical sequence and separates a later sequence', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const operationInput: Parameters<ProviderOperationService['getOrCreateOperation']>[1] = {
      provider: 'DUFFEL',
      purpose: 'ORDER_CREATE',
      logicalSequence: 1,
      paymentId: null,
    };
    const firstOperation = await fixture.serviceA.getOrCreateOperation(claim, operationInput);
    const sameOperation = await fixture.serviceA.getOrCreateOperation(claim, operationInput);
    const laterOperation = await fixture.serviceA.getOrCreateOperation(claim, {
      ...operationInput,
      logicalSequence: 2,
    });

    expect(sameOperation.id).toBe(firstOperation.id);
    expect(laterOperation.id).not.toBe(firstOperation.id);
    const operations = await fixture.prismaA.providerOperation.findMany({
      where: { workflowId: claim.workflowId },
      orderBy: { logicalSequence: 'asc' },
    });
    expect(operations).toHaveLength(2);
    expect(operations[0].id).toBe(firstOperation.id);
    expect(operations[1].id).toBe(laterOperation.id);
  });
  it('persists a fresh prepared attempt for dispatch and takeover reconciliation', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const firstClaim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const operation = await fixture.serviceA.getOrCreateOperation(firstClaim, {
      provider: 'DUFFEL',
      purpose: 'ORDER_CREATE',
      logicalSequence: 1,
      paymentId: null,
    });
    const firstAttempt = await fixture.serviceA.prepareAttempt(firstClaim, {
      operationId: operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:request-a',
    });

    const persistedFirstAttempt = await fixture.prismaA.providerAttempt.findUnique({
      where: { id: firstAttempt.id },
    });
    if (!persistedFirstAttempt) {
      throw new Error('Prepared provider attempt was not persisted');
    }
    expect(persistedFirstAttempt.status).toBe('PREPARED');
    expect(persistedFirstAttempt.claimFence).toBe(firstClaim.fence);

    await expireClaim(fixture.prismaA, firstClaim.workflowId);
    const takeoverClaim = requireClaim(await fixture.repositoryB.acquireClaim(booking.bookingIntentId, recoveryActor));
    const reconciliationAttempt = await fixture.serviceB.prepareAttempt(takeoverClaim, {
      operationId: operation.id,
      kind: 'RECONCILIATION',
      requestFingerprint: 'sha256:request-a',
    });

    expect(reconciliationAttempt.id).not.toBe(firstAttempt.id);
    expect(reconciliationAttempt.claimFence).toBe(takeoverClaim.fence);
    await expect(
      fixture.serviceB.prepareAttempt(takeoverClaim, {
        operationId: operation.id,
        kind: 'DISPATCH',
        requestFingerprint: 'sha256:request-retry',
      }),
    ).rejects.toThrow();
    const attempts = await fixture.prismaB.providerAttempt.findMany({
      where: { operationId: operation.id },
      orderBy: { startedAt: 'asc' },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('PREPARED');
    expect(attempts[1].status).toBe('PREPARED');
  });
  it('appends only allowlisted evidence for an unresolved provider outcome', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const attempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: reservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:request-outcome',
    });
    const observedAt = new Date('2026-10-07T00:00:00.000Z');
    const result = await fixture.serviceA.recordOutcome(claim, {
      attemptId: attempt.id,
      outcome: 'UNRESOLVED',
      eventType: 'payment.intent.observation_unavailable',
      providerObjectId: null,
      amount: null,
      currency: null,
      observedAt,
      safeEvidence: {
        providerStatus: null,
        providerEventId: null,
        evidenceSource: 'AUTHORITATIVE_READ',
        linkage: {
          bookingIntentMatched: false,
          offerMatched: false,
          passengerSetMatched: false,
          itineraryMatched: false,
        },
      },
    });

    expect(result.kind).toBe('ADVANCED');
    const event = await fixture.prismaA.paymentEvent.findUnique({ where: { id: result.paymentEventId } });
    if (!event) {
      throw new Error('Provider evidence event was not persisted');
    }
    expect(event.paymentId).toBe(reservation.paymentId);
    expect(event.providerOperationId).toBe(reservation.operation.id);
    expect(event.providerAttemptId).toBe(attempt.id);
    expect(event.provider).toBe('STRIPE');
    expect(event.evidenceKind).toBe('AUTHORITATIVE_READ');
    expect(event.outcomeClass).toBe('UNRESOLVED');
    expect(event.bookingIntentMatched).toBe(false);
    expect(event.offerMatched).toBe(false);
    expect(event.passengerSetMatched).toBe(false);
    expect(event.itineraryMatched).toBe(false);
    expect(event.previousStatus).toBe(PaymentStatus.RESERVED);
    expect(event.newStatus).toBe(PaymentStatus.RESERVED);
    expect(event.metadata).toEqual({
      providerStatus: null,
      providerEventId: null,
      providerObjectId: null,
      amount: null,
      currency: null,
      observedAt: observedAt.toISOString(),
    });
  });
  it('appends a stale valid response without advancing state', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const staleClaim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(staleClaim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const attempt = await fixture.serviceA.prepareAttempt(staleClaim, {
      operationId: reservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:stale-response',
    });
    await expireClaim(fixture.prismaA, staleClaim.workflowId);
    const currentClaim = requireClaim(await fixture.repositoryB.acquireClaim(booking.bookingIntentId, recoveryActor));
    const result = await fixture.serviceA.recordOutcome(staleClaim, {
      attemptId: attempt.id,
      outcome: 'CONFIRMED',
      eventType: 'payment.intent.created',
      providerObjectId: 'pi_fixture_43',
      amount: 42_000,
      currency: 'usd',
      observedAt: new Date('2026-10-07T00:01:00.000Z'),
      safeEvidence: {
        providerStatus: 'requires_payment_method',
        providerEventId: null,
        evidenceSource: 'HTTP_RESPONSE',
        linkage: {
          bookingIntentMatched: true,
          offerMatched: true,
          passengerSetMatched: true,
          itineraryMatched: true,
        },
      },
    });

    expect(result.kind).toBe('EVIDENCE_ONLY');
    const payment = await fixture.prismaB.payment.findUnique({ where: { id: reservation.paymentId } });
    const operation = await fixture.prismaB.providerOperation.findUnique({ where: { id: reservation.operation.id } });
    const persistedAttempt = await fixture.prismaB.providerAttempt.findUnique({ where: { id: attempt.id } });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({ where: { id: currentClaim.workflowId } });
    const evidence = await fixture.prismaB.paymentEvent.findUnique({ where: { id: result.paymentEventId } });
    if (!payment || !operation || !persistedAttempt || !workflow || !evidence) {
      throw new Error('Stale provider evidence or its journal rows were not persisted');
    }
    expect(payment.status).toBe(PaymentStatus.RESERVED);
    expect(payment.stripePaymentIntentId).toBeNull();
    expect(operation.status).toBe('PREPARED');
    expect(operation.providerObjectId).toBeNull();
    expect(persistedAttempt.status).toBe('PREPARED');
    expect(workflow.fence).toBe(currentClaim.fence);
    expect(workflow.state).toBe('AUTHORIZING');
    expect(evidence.providerAttemptId).toBe(attempt.id);
    expect(evidence.providerOperationId).toBe(reservation.operation.id);
    expect(evidence.outcomeClass).toBe('CONFIRMED');
  });
  it('appends new evidence without rewriting the first uncertainty time or event', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const firstAttempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: reservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:uncertain-first',
    });
    const firstObservedAt = new Date('2026-10-07T00:02:00.000Z');
    const firstOutcome = await fixture.serviceA.recordOutcome(claim, {
      attemptId: firstAttempt.id,
      outcome: 'UNRESOLVED',
      eventType: 'payment.intent.observation_unavailable',
      providerObjectId: null,
      amount: null,
      currency: null,
      observedAt: firstObservedAt,
      safeEvidence: null,
    });
    const firstEvent = await fixture.prismaA.paymentEvent.findUnique({
      where: { id: firstOutcome.paymentEventId },
    });
    if (!firstEvent) {
      throw new Error('First provider evidence event was not persisted');
    }

    const reconciliationAttempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: reservation.operation.id,
      kind: 'RECONCILIATION',
      requestFingerprint: 'sha256:uncertain-reconcile',
    });
    await fixture.serviceA.recordOutcome(claim, {
      attemptId: reconciliationAttempt.id,
      outcome: 'CONFIRMED',
      eventType: 'payment.intent.created',
      providerObjectId: 'pi_fixture_44',
      amount: 42_000,
      currency: 'usd',
      observedAt: new Date('2026-10-07T00:03:00.000Z'),
      safeEvidence: {
        providerStatus: 'requires_payment_method',
        providerEventId: null,
        evidenceSource: 'AUTHORITATIVE_READ',
        linkage: {
          bookingIntentMatched: true,
          offerMatched: true,
          passengerSetMatched: true,
          itineraryMatched: true,
        },
      },
    });

    const events = await fixture.prismaA.paymentEvent.findMany({
      where: { providerOperationId: reservation.operation.id },
      orderBy: { id: 'asc' },
    });
    const persistedFirstEvent = await fixture.prismaA.paymentEvent.findUnique({
      where: { id: firstEvent.id },
    });
    const operation = await fixture.prismaA.providerOperation.findUnique({
      where: { id: reservation.operation.id },
    });
    const workflow = await fixture.prismaA.fulfillmentWorkflow.findUnique({
      where: { id: claim.workflowId },
    });
    const payment = await fixture.prismaA.payment.findUnique({
      where: { id: reservation.paymentId },
    });
    if (!persistedFirstEvent || !operation || !workflow || !payment) {
      throw new Error('Provider evidence journal rows were not preserved');
    }
    expect(events).toHaveLength(2);
    expect(events[0].id).toBe(firstEvent.id);
    expect(events[1].id).not.toBe(firstEvent.id);
    expect(persistedFirstEvent.metadata).toEqual(firstEvent.metadata);
    expect(operation.firstUncertainAt).toEqual(firstObservedAt);
    expect(workflow.firstUncertainAt).toEqual(firstObservedAt);
    expect(operation.status).toBe('CONFIRMED');
    expect(payment.stripePaymentIntentId).toBe('pi_fixture_44');
  });
  it('closes a reserved payment only after definitive intent-creation failure', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const attempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: reservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:definitive-create-failure',
    });
    const result = await fixture.serviceA.recordOutcome(claim, {
      attemptId: attempt.id,
      outcome: 'DEFINITIVE_FAILURE',
      eventType: 'payment.intent.creation_failed',
      providerObjectId: null,
      amount: null,
      currency: null,
      observedAt: new Date('2026-10-07T00:04:00.000Z'),
      safeEvidence: {
        providerStatus: 'failed',
        providerEventId: null,
        evidenceSource: 'HTTP_RESPONSE',
        linkage: {
          bookingIntentMatched: true,
          offerMatched: true,
          passengerSetMatched: true,
          itineraryMatched: true,
        },
      },
    });

    const payment = await fixture.prismaA.payment.findUnique({ where: { id: reservation.paymentId } });
    const operation = await fixture.prismaA.providerOperation.findUnique({ where: { id: reservation.operation.id } });
    const persistedAttempt = await fixture.prismaA.providerAttempt.findUnique({ where: { id: attempt.id } });
    const event = await fixture.prismaA.paymentEvent.findUnique({ where: { id: result.paymentEventId } });
    if (!payment || !operation || !persistedAttempt || !event) {
      throw new Error('Definitive provider failure evidence was not persisted');
    }
    expect(result.kind).toBe('ADVANCED');
    expect(payment.status).toBe(PaymentStatus.FAILED);
    expect(payment.stripePaymentIntentId).toBeNull();
    expect(operation.status).toBe('DEFINITIVE_FAILURE');
    expect(persistedAttempt.status).toBe('DEFINITIVE_FAILURE');
    expect(event.previousStatus).toBe(PaymentStatus.RESERVED);
    expect(event.newStatus).toBe(PaymentStatus.RESERVED);
    expect(event.amount).toBeNull();
  });
  it('reserves a new logical payment sequence only after definitive closure', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const firstReservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const firstAttempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: firstReservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:first-sequence',
    });
    await fixture.serviceA.recordOutcome(claim, {
      attemptId: firstAttempt.id,
      outcome: 'DEFINITIVE_FAILURE',
      eventType: 'payment.intent.creation_failed',
      providerObjectId: null,
      amount: null,
      currency: null,
      observedAt: new Date('2026-10-07T00:05:00.000Z'),
      safeEvidence: null,
    });

    const nextIdempotencyKeyId = await createIdempotencyKey(fixture.prismaA, booking.userId);
    const secondReservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: nextIdempotencyKeyId,
      attemptNumber: 2,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const payments = await fixture.prismaA.payment.findMany({
      where: { fulfillmentWorkflowId: claim.workflowId },
      orderBy: { attemptNumber: 'asc' },
    });
    const operations = await fixture.prismaA.providerOperation.findMany({
      where: { workflowId: claim.workflowId },
      orderBy: { logicalSequence: 'asc' },
    });
    const workflow = await fixture.prismaA.fulfillmentWorkflow.findUnique({
      where: { id: claim.workflowId },
    });
    if (!workflow) {
      throw new Error('Workflow disappeared after second payment reservation');
    }
    expect(secondReservation.paymentId).not.toBe(firstReservation.paymentId);
    expect(secondReservation.operation.id).not.toBe(firstReservation.operation.id);
    expect(payments).toHaveLength(2);
    expect(payments[0].idempotencyKeyId).toBe(booking.idempotencyKeyId);
    expect(payments[0].status).toBe(PaymentStatus.FAILED);
    expect(payments[1].idempotencyKeyId).toBe(nextIdempotencyKeyId);
    expect(payments[1].attemptNumber).toBe(2);
    expect(operations).toHaveLength(2);
    expect(operations[0].logicalSequence).toBe(1);
    expect(operations[0].paymentId).toBe(firstReservation.paymentId);
    expect(operations[1].logicalSequence).toBe(2);
    expect(operations[1].paymentId).toBe(secondReservation.paymentId);
    expect(workflow.currentPaymentId).toBe(secondReservation.paymentId);
  });
  it('rejects changed terms for an existing logical payment reservation', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const input = {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    };
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, input);

    for (const changedTerms of [
      { ...input, amount: 42_001 },
      { ...input, currency: 'cad' },
      { ...input, stripeCustomerId: 'cus_fixture123' },
    ]) {
      await expect(fixture.serviceA.reservePaymentAndIntentCreate(claim, changedTerms)).rejects.toThrow();
    }

    const payments = await fixture.prismaA.payment.findMany({ where: { fulfillmentWorkflowId: claim.workflowId } });
    const operations = await fixture.prismaA.providerOperation.findMany({ where: { workflowId: claim.workflowId } });
    expect(payments).toHaveLength(1);
    expect(payments[0].id).toBe(reservation.paymentId);
    expect(payments[0].amount).toBe(42_000);
    expect(payments[0].currency).toBe('usd');
    expect(payments[0].stripeCustomerId).toBeNull();
    expect(payments[0].idempotencyKeyId).toBe(booking.idempotencyKeyId);
    expect(operations).toHaveLength(1);
    expect(operations[0].id).toBe(reservation.operation.id);
  });
  it('does not reserve a new sequence after lease expiry while the prior attempt is unresolved', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const staleClaim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const firstReservation = await fixture.serviceA.reservePaymentAndIntentCreate(staleClaim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    await fixture.serviceA.prepareAttempt(staleClaim, {
      operationId: firstReservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:unresolved-first-sequence',
    });
    await expireClaim(fixture.prismaA, staleClaim.workflowId);
    const takeoverClaim = requireClaim(await fixture.repositoryB.acquireClaim(booking.bookingIntentId, recoveryActor));
    const nextIdempotencyKeyId = await createIdempotencyKey(fixture.prismaB, booking.userId);

    await expect(
      fixture.serviceB.reservePaymentAndIntentCreate(takeoverClaim, {
        idempotencyKeyId: nextIdempotencyKeyId,
        attemptNumber: 2,
        amount: 42_000,
        currency: 'usd',
        stripeCustomerId: null,
      }),
    ).rejects.toThrow('Previous payment attempt is not definitively closed');

    const payments = await fixture.prismaB.payment.findMany({ where: { fulfillmentWorkflowId: takeoverClaim.workflowId } });
    const operations = await fixture.prismaB.providerOperation.findMany({ where: { workflowId: takeoverClaim.workflowId } });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({ where: { id: takeoverClaim.workflowId } });
    expect(payments).toHaveLength(1);
    expect(payments[0].id).toBe(firstReservation.paymentId);
    expect(payments[0].status).toBe(PaymentStatus.RESERVED);
    expect(operations).toHaveLength(1);
    expect(operations[0].id).toBe(firstReservation.operation.id);
    expect(operations[0].status).toBe('PREPARED');
    expect(workflow?.currentPaymentId).toBe(firstReservation.paymentId);
  });
  it('rejects payment and journal associations from another workflow', async () => {
    const fixture = getIntegrationFixture();
    const firstBooking = await createBookingIntentFixture(fixture.prismaA);
    const secondBooking = await createBookingIntentFixture(fixture.prismaA);
    const firstClaim = requireClaim(await fixture.repositoryA.acquireClaim(firstBooking.bookingIntentId, sagaActor));
    const secondClaim = requireClaim(await fixture.repositoryB.acquireClaim(secondBooking.bookingIntentId, sagaActor));
    const reservationInput = {
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    };

    await expect(
      fixture.serviceA.reservePaymentAndIntentCreate(firstClaim, {
        ...reservationInput,
        idempotencyKeyId: secondBooking.idempotencyKeyId,
      }),
    ).rejects.toThrow();
    const firstReservation = await fixture.serviceA.reservePaymentAndIntentCreate(firstClaim, {
      ...reservationInput,
      idempotencyKeyId: firstBooking.idempotencyKeyId,
    });
    const secondReservation = await fixture.serviceB.reservePaymentAndIntentCreate(secondClaim, {
      ...reservationInput,
      idempotencyKeyId: secondBooking.idempotencyKeyId,
    });
    const secondAttempt = await fixture.serviceB.prepareAttempt(secondClaim, {
      operationId: secondReservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:other-workflow-attempt',
    });

    await expect(
      fixture.serviceA.getOrCreateOperation(firstClaim, {
        provider: 'STRIPE',
        purpose: 'AUTHORIZATION',
        logicalSequence: 1,
        paymentId: secondReservation.paymentId,
      }),
    ).rejects.toThrow();
    await expect(
      fixture.serviceA.prepareAttempt(firstClaim, {
        operationId: secondReservation.operation.id,
        kind: 'DISPATCH',
        requestFingerprint: 'sha256:other-workflow-operation',
      }),
    ).rejects.toThrow();
    await expect(
      fixture.serviceA.recordOutcome(firstClaim, {
        attemptId: secondAttempt.id,
        outcome: 'UNRESOLVED',
        eventType: 'payment.intent.observation_unavailable',
        providerObjectId: null,
        amount: null,
        currency: null,
        observedAt: new Date('2026-10-07T00:06:00.000Z'),
        safeEvidence: null,
      }),
    ).rejects.toThrow();

    const firstPayments = await fixture.prismaA.payment.findMany({
      where: { fulfillmentWorkflowId: firstClaim.workflowId },
    });
    const firstOperations = await fixture.prismaA.providerOperation.findMany({
      where: { workflowId: firstClaim.workflowId },
    });
    const firstEvents = await fixture.prismaA.paymentEvent.findMany({
      where: { providerOperation: { workflowId: firstClaim.workflowId } },
    });
    const secondEvents = await fixture.prismaA.paymentEvent.findMany({
      where: { providerOperation: { workflowId: secondClaim.workflowId } },
    });
    expect(firstPayments).toHaveLength(1);
    expect(firstPayments[0].id).toBe(firstReservation.paymentId);
    expect(firstOperations).toHaveLength(1);
    expect(firstOperations[0].id).toBe(firstReservation.operation.id);
    expect(firstEvents).toHaveLength(0);
    expect(secondEvents).toHaveLength(0);
  });
  it('does not reserve or prepare under a stale claim after takeover', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const staleClaim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const operation = await fixture.serviceA.getOrCreateOperation(staleClaim, {
      provider: 'DUFFEL',
      purpose: 'ORDER_CREATE',
      logicalSequence: 1,
      paymentId: null,
    });
    await expireClaim(fixture.prismaA, staleClaim.workflowId);
    const currentClaim = requireClaim(await fixture.repositoryB.acquireClaim(booking.bookingIntentId, recoveryActor));

    await expect(
      fixture.serviceA.reservePaymentAndIntentCreate(staleClaim, {
        idempotencyKeyId: booking.idempotencyKeyId,
        attemptNumber: 1,
        amount: 42_000,
        currency: 'usd',
        stripeCustomerId: null,
      }),
    ).rejects.toThrow('Workflow claim is no longer active');
    await expect(
      fixture.serviceA.prepareAttempt(staleClaim, {
        operationId: operation.id,
        kind: 'DISPATCH',
        requestFingerprint: 'sha256:stale-claim-dispatch',
      }),
    ).rejects.toThrow('Workflow claim is no longer active');

    const payments = await fixture.prismaB.payment.findMany({
      where: { fulfillmentWorkflowId: currentClaim.workflowId },
    });
    const attempts = await fixture.prismaB.providerAttempt.findMany({ where: { operationId: operation.id } });
    const persistedOperation = await fixture.prismaB.providerOperation.findUnique({ where: { id: operation.id } });
    const workflow = await fixture.prismaB.fulfillmentWorkflow.findUnique({ where: { id: currentClaim.workflowId } });
    expect(payments).toHaveLength(0);
    expect(attempts).toHaveLength(0);
    expect(persistedOperation?.status).toBe('NOT_STARTED');
    expect(workflow?.currentPaymentId).toBeNull();
  });
  it('drops unallowlisted provider fields from persisted evidence', async () => {
    const fixture = getIntegrationFixture();
    const booking = await createBookingIntentFixture(fixture.prismaA);
    const claim = requireClaim(await fixture.repositoryA.acquireClaim(booking.bookingIntentId, sagaActor));
    const reservation = await fixture.serviceA.reservePaymentAndIntentCreate(claim, {
      idempotencyKeyId: booking.idempotencyKeyId,
      attemptNumber: 1,
      amount: 42_000,
      currency: 'usd',
      stripeCustomerId: null,
    });
    const attempt = await fixture.serviceA.prepareAttempt(claim, {
      operationId: reservation.operation.id,
      kind: 'DISPATCH',
      requestFingerprint: 'sha256:allowlisted-evidence',
    });
    const observedAt = new Date('2026-10-07T00:07:00.000Z');
    const safeEvidence = {
      providerStatus: 'requires_payment_method',
      providerEventId: 'evt_fixture_45',
      evidenceSource: 'HTTP_RESPONSE',
      linkage: {
        bookingIntentMatched: true,
        offerMatched: true,
        passengerSetMatched: true,
        itineraryMatched: true,
      },
    } satisfies NonNullable<Parameters<ProviderOperationService['recordOutcome']>[1]['safeEvidence']>;
    const extendedEvidence = Object.assign(safeEvidence, {
      unlistedEvidenceField: 'must-not-be-persisted',
    });
    const outcomeInput = Object.assign(
      {
        attemptId: attempt.id,
        outcome: 'NONFINAL',
        eventType: 'payment.intent.requires_action',
        providerObjectId: 'pi_fixture_45',
        amount: 42_000,
        currency: 'usd',
        observedAt,
        safeEvidence: extendedEvidence,
      } satisfies Parameters<ProviderOperationService['recordOutcome']>[1],
      { unlistedOutcomeField: 'must-not-be-persisted' },
    );

    const result = await fixture.serviceA.recordOutcome(claim, outcomeInput);
    const event = await fixture.prismaA.paymentEvent.findUnique({ where: { id: result.paymentEventId } });
    if (!event) {
      throw new Error('Provider evidence event was not persisted');
    }
    expect(event.metadata).toEqual({
      providerStatus: 'requires_payment_method',
      providerEventId: 'evt_fixture_45',
      providerObjectId: 'pi_fixture_45',
      amount: 42_000,
      currency: 'usd',
      observedAt: observedAt.toISOString(),
    });
    expect(event.evidenceKind).toBe('HTTP_RESPONSE');
    expect(event.outcomeClass).toBe('NONFINAL');
  });
});