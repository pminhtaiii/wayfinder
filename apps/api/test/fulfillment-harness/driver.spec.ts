import { createHmac } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  assertOwnedRunResources,
  buildApplicationEnvironments,
  ownedApplicationEnvironment,
  startFulfillmentHarnessDriver,
  type ApplicationEnvironmentInput,
  type FulfillmentHarnessDriverServer,
} from './bootstrap';
import type { CleanupReport, RunAllocation, RunAllocationRequest } from './driver';

jest.setTimeout(120_000);

type RouteCase = { method: string; suffix: string; body?: unknown };
type IngressObservation = { body: string; signature: string | string[] | undefined };
type IngressReceiver = { origin: string; observations: IngressObservation[]; close: () => Promise<void> };

const runRequest: RunAllocationRequest = {
  scenario: 'stripe-auth-redaction',
  seed: 'driver-contract-seed',
  startTime: '2026-10-08T00:00:00.000Z',
};
const validEnvironmentInput: ApplicationEnvironmentInput = {
  runId: 'run-contract-fixture',
  databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/fulfillment_recovery_test',
  redisUrl: 'redis://127.0.0.1:6379/0',
  redisPrefix: 'fulfillment:run-contract-fixture:',
  providerUrls: {
    stripe: 'http://127.0.0.1:41001',
    supplier: 'http://127.0.0.1:41002',
  },
  applicationCredentials: {
    stripeApiKey: 'sk_test_fixture',
    stripePublishableKey: 'pk_test_fixture',
    stripeWebhookSecret: 'whsec_fixture',
    supplierApiKey: 'duffel_test_fixture',
  },
};

let receiver: IngressReceiver | undefined;
let controlServer: FulfillmentHarnessDriverServer | undefined;
let firstRun: RunAllocation | undefined;
let secondRun: RunAllocation | undefined;
let thirdRun: RunAllocation | undefined;
let ownedChild: ChildProcess | undefined;
let unownedChild: ChildProcess | undefined;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(name + ' is required for the driver integration contract');
  return value;
}

// API/Jest keeps its scoped DATABASE_URL; CI must provision this admin DB or set the explicit override.
function fulfillmentHarnessAdminDatabaseUrl(): string {
  const configuredUrl = process.env.FULFILLMENT_HARNESS_ADMIN_DATABASE_URL;
  if (configuredUrl) return configuredUrl;
  const databaseUrl = new URL(requiredEnvironment('DATABASE_URL'));
  databaseUrl.pathname = '/fulfillment_recovery_test';
  databaseUrl.searchParams.delete('schema');
  return databaseUrl.toString();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readRecord(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isRecord(value)) throw new Error('expected a JSON object response');
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('expected a non-empty string field: ' + field);
  }
  return value;
}

function routeCases(runId: string): RouteCase[] {
  const root = '/driver/runs/' + encodeURIComponent(runId);
  return [
    { method: 'GET', suffix: root + '/ledger?provider=stripe' },
    {
      method: 'POST',
      suffix: root + '/scenarios',
      body: {
        provider: 'STRIPE',
        purpose: 'PAYMENT_INTENT_CREATE',
        bookingIntentId: 'booking-intent-auth-check',
        outcome: 'CONFIRMED',
      },
    },
    { method: 'POST', suffix: root + '/events/evt_auth_check/release', body: { copies: 1, deliveryOrder: [0] } },
    { method: 'POST', suffix: root + '/responses/resp_auth_check/release', body: {} },
    { method: 'POST', suffix: root + '/clock/advance', body: { milliseconds: 0, maxJobs: 1 } },
    { method: 'POST', suffix: root + '/scheduler/drain', body: { maxJobs: 1 } },
    { method: 'DELETE', suffix: root },
  ];
}

async function sendControlRequest(
  server: FulfillmentHarnessDriverServer,
  route: RouteCase,
  token?: string,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (route.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(server.origin + route.suffix, {
    method: route.method,
    headers,
    ...(route.body === undefined ? {} : { body: JSON.stringify(route.body) }),
  });
}

async function startIngressReceiver(): Promise<IngressReceiver> {
  const observations: IngressObservation[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      observations.push({
        body: Buffer.concat(chunks).toString('utf8'),
        signature: request.headers['stripe-signature'],
      });
      response.writeHead(204);
      response.end();
    });
  });
  await listenLoopback(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('ingress receiver failed to bind');
  return {
    origin: 'http://127.0.0.1:' + address.port,
    observations,
    close: () => closeServer(server),
  };
}

function listenLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function schemaExists(scopedDatabaseUrl: string): Promise<boolean> {
  const parsed = new URL(scopedDatabaseUrl);
  const schemaName = parsed.searchParams.get('schema');
  if (!schemaName) throw new Error('run database URL must carry its schema');
  parsed.searchParams.set('schema', 'public');
  const inspectionClient = new PrismaClient({
    datasources: { db: { url: parsed.toString() } },
  });
  try {
    const schemas = await inspectionClient.$queryRaw<Array<{ schema_name: string }>>`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = ${schemaName}
    `;
    return schemas.length === 1;
  } finally {
    await inspectionClient.$disconnect();
  }
}

async function connectRedis(redisUrl: string): Promise<Redis> {
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });
  await client.connect();
  return client;
}

function startLongLivedChild(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(function () {}, 1000)'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

function processIsAlive(child: ChildProcess): boolean {
  const pid = child.pid;
  if (!pid || child.exitCode !== null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function setChildPidForOwnershipTest(child: ChildProcess, pid: number): void {
  Object.defineProperty(child, 'pid', { configurable: true, enumerable: true, writable: true, value: pid });
}
async function stopUnownedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    child.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function makeEnvironmentInput(overrides: Partial<ApplicationEnvironmentInput> = {}): ApplicationEnvironmentInput {
  return { ...validEnvironmentInput, ...overrides };
}

async function createConfirmedIntent(run: RunAllocation): Promise<{ intentId: string; clientSecret: string }> {
  const headers = {
    Authorization: 'Bearer ' + run.applicationCredentials.stripeApiKey,
    'content-type': 'application/x-www-form-urlencoded',
  };
  const form = new URLSearchParams();
  form.set('amount', '1450');
  form.set('currency', 'usd');
  form.set('capture_method', 'manual');
  form.set('payment_method', 'pm_simulated');
  form.set('metadata[bookingIntentId]', 'booking-intent-' + run.runId);
  const createResponse = await fetch(run.providerUrls.stripe + '/v1/payment_intents', {
    method: 'POST',
    headers,
    body: form.toString(),
  });
  expect(createResponse.status).toBe(200);
  const created = await readRecord(createResponse);
  const intentId = requiredString(created, 'id');
  const clientSecret = requiredString(created, 'client_secret');
  const confirmResponse = await fetch(
    run.providerUrls.stripe + '/v1/payment_intents/' + encodeURIComponent(intentId) + '/confirm',
    { method: 'POST', headers, body: '' },
  );
  expect(confirmResponse.status).toBe(200);
  return { intentId, clientSecret };
}

function dockerOutput(argumentsList: string[]): string {
  const result = childProcess.spawnSync('docker', argumentsList, {
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error('owned Redis inspection failed');
  return (result.stdout ?? '').trim();
}

function ownedRedisContainerIds(runId: string): string[] {
  return dockerOutput([
    'ps', '--all', '--quiet', '--no-trunc',
    '--filter', 'label=com.booking.fulfillment-harness.owner=fulfillment-harness-driver',
    '--filter', 'label=com.booking.fulfillment-harness.run-id=' + runId,
  ]).split(/\r?\n/).filter((value) => value.length > 0);
}

function ownedRedisContainerId(runId: string): string {
  const ids = ownedRedisContainerIds(runId);
  if (ids.length !== 1 || !/^[0-9a-f]{64}$/.test(ids[0])) {
    throw new Error('expected one full-ID Redis container for the owned run');
  }
  const containerId = ids[0];
  const inspectedId = dockerOutput(['inspect', '--format', '{{.Id}}', containerId]);
  const labelsValue: unknown = JSON.parse(dockerOutput([
    'inspect', '--format', '{{json .Config.Labels}}', containerId,
  ]));
  if (
    inspectedId !== containerId ||
    !isRecord(labelsValue) ||
    labelsValue['com.booking.fulfillment-harness.owner'] !== 'fulfillment-harness-driver' ||
    labelsValue['com.booking.fulfillment-harness.run-id'] !== runId
  ) {
    throw new Error('Redis container ownership did not match its full ID and run labels');
  }
  return containerId;
}
describe('fulfillment harness driver bootstrap authorization and cleanup retry', () => {
  it('authorizes first allocation separately and retains live-run resources until child cleanup succeeds', async () => {
    let server: FulfillmentHarnessDriverServer | undefined;
    let child: ChildProcess | undefined;
    let actualPid: number | undefined;
    let redisClient: Redis | undefined;
    let serverClosed = false;

    let firstDatabaseUrl = '';
    let secondDatabaseUrl = '';
    try {
      server = await startFulfillmentHarnessDriver({
        databaseUrl: fulfillmentHarnessAdminDatabaseUrl(),
        bindAddress: '127.0.0.1',
        redisImage: 'redis:7-alpine',
      });
      const allocationRoute = { method: 'POST', suffix: '/driver/runs', body: runRequest };
      expect((await sendControlRequest(server, allocationRoute)).status).toBe(401);
      expect((await sendControlRequest(server, allocationRoute, 'wrong-bootstrap-token')).status).toBe(401);

      const firstResponse = await sendControlRequest(server, allocationRoute, server.bootstrapToken);
      expect(firstResponse.status).toBe(201);
      const first = await readRecord(firstResponse);
      const firstRunId = requiredString(first, 'runId');
      const firstToken = requiredString(first, 'driverToken');

      const firstCustomer = first['customer'];
      if (!isRecord(firstCustomer)) throw new Error('first allocation omitted its generated customer');
      const customerId = requiredString(firstCustomer, 'id');
      const customerEmail = requiredString(firstCustomer, 'email');
      const customerPassword = requiredString(firstCustomer, 'password');
      expect(JSON.stringify(first)).not.toContain(server.bootstrapToken);

      const firstOptions = server.applicationOptions(firstRunId);
      firstDatabaseUrl = firstOptions.databaseUrl;
      const firstEnvironment = server.applicationEnvironment(firstRunId);
      expect(JSON.stringify(firstEnvironment)).not.toContain(server.bootstrapToken);
      const customerClient = new PrismaClient({ datasources: { db: { url: firstDatabaseUrl } } });
      try {
        const persistedCustomer = await customerClient.user.findUnique({
          where: { id: customerId },
          select: { id: true, email: true, password: true },
        });
        expect(persistedCustomer?.email).toBe(customerEmail);
        expect(persistedCustomer?.password).not.toBe(customerPassword);
      } finally {
        await customerClient.$disconnect();
      }

      const secondResponse = await sendControlRequest(
        server,
        { method: 'POST', suffix: '/driver/runs', body: { ...runRequest, seed: 'driver-bootstrap-second-seed' } },
        firstToken,
      );
      expect(secondResponse.status).toBe(201);
      const second = await readRecord(secondResponse);
      const secondRunId = requiredString(second, 'runId');

      expect(secondRunId).not.toBe(firstRunId);
      const secondCustomer = second['customer'];
      if (!isRecord(secondCustomer)) throw new Error('second allocation omitted its generated customer');
      expect(requiredString(secondCustomer, 'email')).not.toBe(customerEmail);
      secondDatabaseUrl = server.applicationOptions(secondRunId).databaseUrl;

      const redisKey = firstOptions.redisPrefix + 'identity-guard';
      redisClient = await connectRedis(firstOptions.redisUrl);
      await redisClient.set(redisKey, 'preserve-until-owned-child-exits');
      child = await startLongLivedChild();
      actualPid = child.pid;
      if (!actualPid) throw new Error('registered test child did not receive a process ID');
      server.registerApplicationProcess(firstOptions, child);

      const impossiblePid = Number.MAX_SAFE_INTEGER;
      expect(actualPid).not.toBe(impossiblePid);
      setChildPidForOwnershipTest(child, impossiblePid);
      const rejectedCleanup = await sendControlRequest(
        server,
        { method: 'DELETE', suffix: '/driver/runs/' + encodeURIComponent(firstRunId) },
        firstToken,
      );
      expect(rejectedCleanup.status).toBe(500);
      const rejectedReport = await readRecord(rejectedCleanup);
      expect(rejectedReport['leakedResourceCount']).toBe(1);
      expect(rejectedReport['droppedSchema']).toBe('');
      expect(rejectedReport['removedRedisPrefix']).toBe('');
      expect(await schemaExists(firstDatabaseUrl)).toBe(true);
      expect(await redisClient.get(redisKey)).toBe('preserve-until-owned-child-exits');
      await expect(assertOwnedRunResources(firstOptions)).resolves.toBeUndefined();

      setChildPidForOwnershipTest(child, actualPid);
      await redisClient.quit();
      redisClient = undefined;
      await server.close();
      serverClosed = true;
      expect(await schemaExists(firstDatabaseUrl)).toBe(false);
      expect(await schemaExists(secondDatabaseUrl)).toBe(false);
      expect(processIsAlive(child)).toBe(false);
    } finally {
      if (child && actualPid !== undefined) setChildPidForOwnershipTest(child, actualPid);
      if (redisClient) {
        try { await redisClient.quit(); }
        catch { redisClient.disconnect(); }
      }
      if (server && !serverClosed) {
        await server.close();
        serverClosed = true;
      }
      if (child && processIsAlive(child)) await stopUnownedChild(child);
    }
  });
});

describe('fulfillment harness cleanup resource retry', () => {
  it('drops the owned schema and retains Redis ownership when one exact Docker removal fails', async () => {
    let server: FulfillmentHarnessDriverServer | undefined;
    let activeSpy: jest.SpyInstance | undefined;
    try {
      server = await startFulfillmentHarnessDriver({
        databaseUrl: fulfillmentHarnessAdminDatabaseUrl(),
        bindAddress: '127.0.0.1',
        redisImage: 'redis:7-alpine',
      });
      const run = await server.driver.allocate({ ...runRequest, seed: 'driver-redis-removal-retry-seed' });
      const options = server.applicationOptions(run.runId);
      const containerId = ownedRedisContainerId(run.runId);
      // Human-approved boundary: fail only this run's exact full Docker ID; delegate every other command.
      const realChildProcess = jest.requireActual<typeof import('node:child_process')>('node:child_process');
      const originalSpawnSync = realChildProcess.spawnSync;
      let injectedRemovalFailure = false;
      activeSpy = jest.spyOn(realChildProcess, 'spawnSync');
      const spy = activeSpy;
      spy.mockImplementation((command, argumentsList, spawnOptions) => {
        const values = Array.isArray(argumentsList) ? argumentsList : [];
        if (
          !injectedRemovalFailure &&
          command === 'docker' &&
          values[0] === 'rm' &&
          values[1] === '--force' &&
          values[2] === containerId
        ) {
          injectedRemovalFailure = true;
          throw new Error('injected one-shot owned Redis removal failure');
        }
        return originalSpawnSync(command, argumentsList, spawnOptions);
      });

      let firstReport: CleanupReport;
      try {
        firstReport = await server.driver.teardown(run.runId);
      } finally {
        spy.mockRestore();
        activeSpy = undefined;
      }
      expect(injectedRemovalFailure).toBe(true);
      expect(firstReport.leakedResourceCount).toBe(1);
      expect(firstReport.droppedSchema).toBe(new URL(options.databaseUrl).searchParams.get('schema'));
      expect(firstReport.removedRedisPrefix).toBe('');
      expect(await schemaExists(options.databaseUrl)).toBe(false);
      expect(ownedRedisContainerId(run.runId)).toBe(containerId);
      const retainedOptions = server.applicationOptions(run.runId);
      expect(retainedOptions.databaseUrl).toBe(options.databaseUrl);
      expect(retainedOptions.redisUrl).toBe(options.redisUrl);
      expect(retainedOptions.redisPrefix).toBe(options.redisPrefix);

      const retryReport = await server.driver.teardown(run.runId);
      expect(retryReport.leakedResourceCount).toBe(0);
      expect(retryReport.removedRedisPrefix).toBe(options.redisPrefix);
      expect(await schemaExists(options.databaseUrl)).toBe(false);
      expect(ownedRedisContainerIds(run.runId)).toEqual([]);
    } finally {
      activeSpy?.mockRestore();
      if (server) await server.close();
    }
  });
});

describe('fulfillment harness driver security and isolation', () => {
  beforeAll(async () => {
    receiver = await startIngressReceiver();
    controlServer = await startFulfillmentHarnessDriver({
      databaseUrl: fulfillmentHarnessAdminDatabaseUrl(),
      apiUrl: receiver.origin,
      frontendUrl: 'http://127.0.0.1:3000',
      bindAddress: '127.0.0.1',
      redisImage: 'redis:7-alpine',
    });
    firstRun = await controlServer.driver.allocate(runRequest);
    secondRun = await controlServer.driver.allocate({
      ...runRequest,
      seed: 'driver-contract-second-seed',
    });
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    const attemptCleanup = async (cleanup: () => Promise<void>): Promise<void> => {
      try { await cleanup(); }
      catch (error) { cleanupErrors.push(error); }
    };

    await attemptCleanup(async () => {
      if (controlServer && firstRun) {
        const report = await controlServer.driver.teardown(firstRun.runId);
        expect(report.leakedResourceCount).toBe(0);
      }
    });
    await attemptCleanup(async () => {
      if (controlServer && secondRun) {
        const report = await controlServer.driver.teardown(secondRun.runId);
        expect(report.leakedResourceCount).toBe(0);
      }
    });
    await attemptCleanup(async () => {
      if (controlServer && thirdRun) {
        const report = await controlServer.driver.teardown(thirdRun.runId);
        expect(report.leakedResourceCount).toBe(0);
      }
    });
    await attemptCleanup(async () => {
      if (controlServer) await controlServer.close();
    });
    await attemptCleanup(async () => {
      if (receiver) await receiver.close();
    });
    await attemptCleanup(async () => {
      if (ownedChild) await stopUnownedChild(ownedChild);
    });
    await attemptCleanup(async () => {
      if (unownedChild) await stopUnownedChild(unownedChild);
    });

    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, 'fulfillment harness fixture cleanup failed');
    }
  });

  it('binds the driver to loopback and rejects unsafe origins before a run can start', async () => {
    expect(controlServer?.origin.startsWith('http://127.0.0.1:')).toBe(true);
    await expect(
      startFulfillmentHarnessDriver({
        databaseUrl: fulfillmentHarnessAdminDatabaseUrl(),
        apiUrl: 'http://127.0.0.1:3001',
        frontendUrl: 'http://127.0.0.1:3000',
        bindAddress: '0.0.0.0',
        redisImage: 'redis:7-alpine',
      }),
    ).rejects.toThrow();

    expect(() =>
      buildApplicationEnvironments(
        makeEnvironmentInput({
          databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/flight_booking',
        }),
      ),
    ).toThrow();
    expect(() =>
      buildApplicationEnvironments(
        makeEnvironmentInput({
          providerUrls: { stripe: 'https://api.stripe.com', supplier: 'http://127.0.0.1:41002' },
        }),
      ),
    ).toThrow();
    expect(() =>
      buildApplicationEnvironments(
        makeEnvironmentInput({
          providerUrls: { stripe: 'http://127.0.0.1:41001', supplier: 'http://localhost:41002' },
        }),
      ),
    ).toThrow();
  });

  it('denies missing and wrong driver credentials on every control route', async () => {
    const run = firstRun;
    const server = controlServer;
    if (!run || !server) throw new Error('driver fixture did not start');
    for (const route of routeCases(run.runId)) {
      const missing = await sendControlRequest(server, route);
      expect(missing.status).toBe(401);
      const wrong = await sendControlRequest(server, route, 'wrong-driver-token');
      expect(wrong.status).toBe(401);
    }
    const allocate = await fetch(server.origin + '/driver/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer wrong-driver-token' },
      body: JSON.stringify(runRequest),
    });
    expect(allocate.status).toBe(401);
  });

  it('does not let application provider credentials call any driver route', async () => {
    const run = firstRun;
    const server = controlServer;
    if (!run || !server) throw new Error('driver fixture did not start');
    const applicationCredentials = Object.values(run.applicationCredentials);
    for (const credential of applicationCredentials) {
      for (const route of routeCases(run.runId)) {
        const response = await sendControlRequest(server, route, credential);
        expect(response.status).toBe(401);
      }
      const allocate = await fetch(server.origin + '/driver/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + credential },
        body: JSON.stringify(runRequest),
      });
      expect(allocate.status).toBe(401);
    }
    const stillOwned = await sendControlRequest(server, routeCases(run.runId)[0] ?? { method: 'GET', suffix: '' }, run.driverToken);
    expect(stillOwned.status).toBe(200);
  });

  it('keeps run ids opaque and driver credentials out of API and Next environments', async () => {
    const run = firstRun;
    const other = secondRun;
    const server = controlServer;
    if (!run || !other || !server) throw new Error('driver fixtures did not start');
    expect(run.runId).not.toBe(runRequest.seed);
    expect(run.runId).not.toContain(runRequest.scenario);
    expect(run.runId).not.toBe(other.runId);
    expect(run.driverToken).not.toBe(run.applicationCredentials.stripeApiKey);
    expect(run.driverToken).not.toBe(run.applicationCredentials.stripeWebhookSecret);
    expect(run.driverToken).not.toBe(run.applicationCredentials.supplierApiKey);
    expect(other.driverToken).not.toBe(run.driverToken);

    const environment = server.applicationEnvironment(run.runId);
    const apiValues = Object.values(environment.api).join('\n');
    const webValues = Object.values(environment.web).join('\n');
    expect(Object.keys(environment.api)).not.toContain('FULFILLMENT_DRIVER_TOKEN');
    expect(Object.keys(environment.web)).not.toContain('FULFILLMENT_DRIVER_TOKEN');
    expect(apiValues).not.toContain(run.driverToken);
    expect(webValues).not.toContain(run.driverToken);
    expect(apiValues).toContain(run.applicationCredentials.stripeApiKey);
    expect(apiValues).toContain(run.applicationCredentials.supplierApiKey);
    expect(environment.web.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toBe(
      run.applicationCredentials.stripePublishableKey,
    );
    expect(environment.api.REDIS_KEY_PREFIX).not.toBe(environment.web.REDIS_KEY_PREFIX);
  });

  it('rejects cross-run ledger access and refuses to tear down another run schema or Redis', async () => {
    const run = firstRun;
    const other = secondRun;
    const server = controlServer;
    if (!run || !other || !server) throw new Error('driver fixtures did not start');
    for (const route of routeCases(other.runId)) {
      const response = await sendControlRequest(server, route, run.driverToken);
      expect(response.status).toBe(404);
    }

    const environment = server.applicationEnvironment(other.runId);
    const databaseUrl = environment.api.DATABASE_URL;
    const redisUrl = environment.api.REDIS_URL;
    if (!databaseUrl || !redisUrl) throw new Error('run database or Redis URL is missing');
    expect(await schemaExists(databaseUrl)).toBe(true);

    const redis = await connectRedis(redisUrl);
    try {
      await redis.set('raw-cross-run-ownership-probe', 'run-two');
      expect(await redis.get('raw-cross-run-ownership-probe')).toBe('run-two');
    } finally {
      await redis.quit();
    }

    const authorizedRead = await sendControlRequest(
      server,
      { method: 'GET', suffix: '/driver/runs/' + encodeURIComponent(other.runId) + '/ledger?provider=stripe' },
      other.driverToken,
    );
    expect(authorizedRead.status).toBe(200);
    expect(await schemaExists(databaseUrl)).toBe(true);
    const redisAfterRejectedTeardown = await connectRedis(redisUrl);
    try {
      expect(await redisAfterRejectedTeardown.get('raw-cross-run-ownership-probe')).toBe('run-two');
    } finally {
      await redisAfterRejectedTeardown.quit();
    }
  });

  it('isolates identical raw Redis keys across two allocated runs', async () => {
    const first = firstRun;
    const second = secondRun;
    const server = controlServer;
    if (!first || !second || !server) throw new Error('driver fixtures did not start');
    const firstUrl = server.applicationEnvironment(first.runId).api.REDIS_URL;
    const secondUrl = server.applicationEnvironment(second.runId).api.REDIS_URL;
    if (!firstUrl || !secondUrl) throw new Error('run Redis URL is missing');
    const firstRedis = await connectRedis(firstUrl);
    const secondRedis = await connectRedis(secondUrl);
    try {
      await firstRedis.set('same-raw-application-key', 'first-run');
      await secondRedis.set('same-raw-application-key', 'second-run');
      expect(await firstRedis.get('same-raw-application-key')).toBe('first-run');
      expect(await secondRedis.get('same-raw-application-key')).toBe('second-run');
    } finally {
      await Promise.all([firstRedis.quit(), secondRedis.quit()]);
    }
  });

  it('releases a genuine signed simulator event to the configured application ingress', async () => {
    const run = firstRun;
    const server = controlServer;
    const ingress = receiver;
    if (!run || !server || !ingress) throw new Error('driver fixtures did not start');
    const created = await createConfirmedIntent(run);
    expect(created.intentId.length).toBeGreaterThan(4);
    const ledgerResponse = await sendControlRequest(
      server,
      { method: 'GET', suffix: '/driver/runs/' + encodeURIComponent(run.runId) + '/ledger?provider=stripe' },
      run.driverToken,
    );
    const ledger = await readRecord(ledgerResponse);
    const pendingEvents = ledger.pendingEventIds;
    if (!Array.isArray(pendingEvents) || typeof pendingEvents[0] !== 'string') {
      throw new Error('simulator did not expose the created signed event ID');
    }
    const eventId = pendingEvents[0];
    const releaseResponse = await sendControlRequest(
      server,
      {
        method: 'POST',
        suffix: '/driver/runs/' + encodeURIComponent(run.runId) + '/events/' + encodeURIComponent(eventId) + '/release',
        body: { copies: 2, deliveryOrder: [1, 0] },
      },
      run.driverToken,
    );
    expect(releaseResponse.status).toBe(200);
    const release = await readRecord(releaseResponse);
    expect(release.eventId).toBe(eventId);
    expect(release.acceptedStatuses).toEqual([204, 204]);
    expect(ingress.observations).toHaveLength(2);
    const observation = ingress.observations[0];
    // User approved this scalar-header guard on 2026-10-08; the original HMAC assertions stay unchanged.
    if (!observation || typeof observation.signature !== 'string') {
      throw new Error('signed simulator event has no Stripe signature');
    }
    const signatureParts = observation.signature.split(',');
    const timestampPart = signatureParts.find((part) => part.startsWith('t='));
    const digestPart = signatureParts.find((part) => part.startsWith('v1='));
    if (!timestampPart || !digestPart) throw new Error('Stripe signature format is incomplete');
    const expectedDigest = createHmac('sha256', run.applicationCredentials.stripeWebhookSecret)
      .update(timestampPart.slice(2) + '.' + observation.body)
      .digest('hex');
    expect(digestPart.slice(3)).toBe(expectedDigest);
    expect(ingress.observations[1]?.body).toBe(observation.body);
  });

  it('redacts provider secrets and client secrets from route output', async () => {
    const run = firstRun;
    const server = controlServer;
    if (!run || !server) throw new Error('driver fixture did not start');
    const created = await createConfirmedIntent(run);
    const response = await sendControlRequest(
      server,
      { method: 'GET', suffix: '/driver/runs/' + encodeURIComponent(run.runId) + '/ledger?provider=stripe' },
      run.driverToken,
    );
    expect(response.status).toBe(200);
    const ledger = await readRecord(response);
    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain(created.clientSecret);
    expect(serialized).not.toContain(run.applicationCredentials.stripeApiKey);
    expect(serialized).not.toContain(run.applicationCredentials.stripeWebhookSecret);
    expect(serialized).not.toContain(run.applicationCredentials.supplierApiKey);
    expect(serialized).not.toContain(run.driverToken);
    expect(serialized.toLowerCase()).not.toContain('client_secret');
    expect(serialized.toLowerCase()).not.toContain('authorization');
  });

  it('keeps generated users and application configuration scoped to the owned run and stops a registered app child before cleanup', async () => {
    const server = controlServer;
    const first = firstRun;
    const second = secondRun;
    if (!server || !first || !second) throw new Error('driver fixtures did not start');
    thirdRun = await server.driver.allocate({ ...runRequest, scenario: 'supplier-fixture-scenario' });
    const run = thirdRun;

    expect(second.customer.email).not.toBe(first.customer.email);
    expect(run.customer.email).not.toBe(first.customer.email);
    expect(run.customer.id).not.toBe(first.customer.id);

    const options = server.applicationOptions(run.runId);
    expect(options.apiUrl).toBe(run.apiUrl);
    expect(options.frontendUrl).toBe(run.frontendUrl);
    expect(options.stripePublishableKey).toBe(run.applicationCredentials.stripePublishableKey);
    await expect(assertOwnedRunResources(options)).resolves.toBeUndefined();
    await expect(assertOwnedRunResources({ ...options, redisPrefix: options.redisPrefix + 'other' })).rejects.toThrow();

    const storedEnvironment = ownedApplicationEnvironment(options);
    const environment = server.applicationEnvironment(run.runId);
    expect(environment.api.FULFILLMENT_HARNESS_RUN_ID).toBe(run.runId);
    expect(environment.web.FULFILLMENT_HARNESS_RUN_ID).toBeUndefined();
    expect(environment.api.JWT_SECRET).toBe(storedEnvironment.api.JWT_SECRET);
    expect(environment.web.NEXTAUTH_SECRET).toBe(storedEnvironment.web.NEXTAUTH_SECRET);
    expect(environment.web.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toBe(run.applicationCredentials.stripePublishableKey);
    expect(environment.api.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY).toBeUndefined();
    const serializedEnvironments = JSON.stringify(environment);
    expect(serializedEnvironments).not.toContain(run.driverToken);
    expect(serializedEnvironments).not.toContain(run.customer.email);
    expect(serializedEnvironments).not.toContain(run.customer.password);

    ownedChild = await startLongLivedChild();
    const processId = ownedChild.pid;
    if (!processId) throw new Error('application test child did not receive a process ID');
    server.registerApplicationProcess(options, ownedChild);
    const response = await sendControlRequest(
      server,
      { method: 'DELETE', suffix: '/driver/runs/' + encodeURIComponent(run.runId) },
      run.driverToken,
    );
    expect(response.status).toBe(200);
    const report = await readRecord(response);
    thirdRun = undefined;
    ownedChild = undefined;
    expect(report.terminatedProcessIds).toContain(processId);
    expect(report.droppedSchema).toBe(new URL(options.databaseUrl).searchParams.get('schema'));
    expect(report.removedRedisPrefix).toBe(options.redisPrefix);
    expect(report.leakedResourceCount).toBe(0);
    expect(await schemaExists(options.databaseUrl)).toBe(false);
  });
  it('terminates only recorded child processes during bounded teardown', async () => {
    const server = controlServer;
    if (!server) throw new Error('driver fixture did not start');
    thirdRun = await server.driver.allocate({
      ...runRequest,
      seed: 'driver-process-ownership-seed',
    });
    ownedChild = await startLongLivedChild();
    unownedChild = await startLongLivedChild();
    const ownedPid = ownedChild.pid;
    if (!ownedPid) throw new Error('owned test child did not receive a process ID');
    server.registerOwnedProcess(thirdRun.runId, ownedChild);
    const report = await server.driver.teardown(thirdRun.runId);
    thirdRun = undefined;
    expect(report.terminatedProcessIds).toContain(ownedPid);
    expect(report.leakedResourceCount).toBe(0);
    expect(ownedChild.exitCode).not.toBeNull();
    expect(unownedChild.exitCode).toBeNull();
    expect(processIsAlive(unownedChild)).toBe(true);
  });
});
