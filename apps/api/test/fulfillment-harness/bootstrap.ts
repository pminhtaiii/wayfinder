import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { VirtualFulfillmentRecoveryScheduler } from './scheduler';
import { assertSupportedFaultSelection, FULFILLMENT_SCENARIO_MANIFEST } from './scenarios';
import { startStripeServer } from './stripe-server';
import { startSupplierServer } from './supplier-server';
import type { HarnessApplicationOptions } from './server';
import type {
  CleanupReport,
  FaultSelection,
  GeneratedCustomerFixture,
  FulfillmentHarnessDriver,
  IngressResult,
  RedactedLedger,
  RunAllocation,
  RunAllocationRequest,
} from './driver';
import type {
  ProviderName,
  StripeLedgerSummary as SimulatorStripeLedger,
  SupplierLedgerSummary as SimulatorSupplierLedger,
  StripeSimulator,
  SupplierSimulator,
} from './simulator-types';

export type ApplicationEnvironmentInput = {
  runId: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  providerUrls: { stripe: string; supplier: string };
  applicationCredentials: {
    stripeApiKey: string;
    stripePublishableKey: string;
    stripeWebhookSecret: string;
    supplierApiKey: string;
  };
  apiUrl?: string;
  frontendUrl?: string;
};

export type ApplicationEnvironment = {
  api: NodeJS.ProcessEnv;
  web: NodeJS.ProcessEnv;
};

export type FulfillmentHarnessDriverServer = {
  origin: string;
  driver: FulfillmentHarnessDriver;
  bootstrapToken: string;
  applicationEnvironment(runId: string): ApplicationEnvironment;
  applicationOptions(runId: string): HarnessApplicationOptions;
  registerOwnedProcess(runId: string, child: ChildProcess): void;
  registerApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): void;
  stopApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): Promise<void>;
  close(): Promise<void>;
};

type DriverOptions = {
  databaseUrl: string;
  bindAddress?: string;
  redisImage?: string;
  // Test-only signed-event receiver override; allocated app origins remain independent.
  apiUrl?: string;
  frontendUrl?: string;
};

type OwnedChild = { pid: number; child: ChildProcess; startIdentity: string | undefined; stopPromise?: Promise<boolean> };
type OwnedRun = {
  allocation: RunAllocation;
  application: HarnessApplicationOptions;
  apiEnvironment: NodeJS.ProcessEnv;
  webEnvironment: NodeJS.ProcessEnv;
  environmentSecrets: string[];
  stripe: StripeSimulator;
  supplier: SupplierSimulator;
  scheduler: VirtualFulfillmentRecoveryScheduler;
  databaseUrl: string;
  schemaName: string;
  redisContainerId: string;
  redisPort: number;
  redisPrefix: string;
  redisLabels: Record<string, string>;
  ingressUrl: string;
  children: Map<number, OwnedChild>;
  stripeClosed: boolean;
  supplierClosed: boolean;
  redisRemoved: boolean;
  schemaDropped: boolean;
};

type PendingAllocationCleanup = {
  runId: string;
  databaseUrl: string;
  schemaName: string;
  schemaMayExist: boolean;
  redisStartAttempted: boolean;
  stripe?: StripeSimulator;
  supplier?: SupplierSimulator;
  redisContainerId?: string;
};
type ContainerInspection = {
  id: string;
  runId: string;
  owner: string;
  port: number;
};

const ownedRuns = new Map<string, OwnedRun>();
const pendingAllocations = new Map<string, PendingAllocationCleanup>();
const ownerLabel = 'com.booking.fulfillment-harness.owner';
const runLabel = 'com.booking.fulfillment-harness.run-id';
const ownerValue = 'fulfillment-harness-driver';
const redisImage = 'redis:7-alpine';
const maximumRequestBytes = 1024 * 1024;
const requestTimeoutMs = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeSegment(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,160}$/.test(value);
}

function parseLoopbackOrigin(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(name + ' must be an HTTP loopback origin');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== '/' ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error(name + ' must be an HTTP loopback origin with an explicit port');
  }
  return url;
}

function validateDatabaseUrl(value: string, allowSchema: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Database URL must target the local fulfillment_recovery_test database');
  }
  const schemas = url.searchParams.getAll('schema');
  const validSchemaCount =
    schemas.length === 0 ||
    (allowSchema && schemas.length === 1 && /^fulfillment_recovery_[0-9a-f]{32}$/.test(schemas[0] ?? ''));
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/fulfillment_recovery_test' ||
    !validSchemaCount
  ) {
    throw new Error('Database URL must target the local fulfillment_recovery_test database');
  }
  return url;
}

function validateRedisUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Redis URL must target a task-owned loopback instance');
  }
  const port = Number(url.port);
  if (
    url.protocol !== 'redis:' ||
    url.hostname !== '127.0.0.1' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/(0|[1-9][0-9]*)$/.test(url.pathname) ||
    Number(url.pathname.slice(1)) > 15 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Redis URL must target a task-owned loopback instance');
  }
  return url;
}

function randomSecret(prefix: string): string {
  return prefix + randomBytes(32).toString('hex');
}

function runtimeEnvironment(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  const repositoryRoot = path.resolve(__dirname, '../../../..');
  const guardPath = path.resolve(repositoryRoot, 'tests', 'ci', 'node-network-guard.cjs').replace(/\\/g, '/');
  environment.NODE_OPTIONS = '--require="' + guardPath + '"';
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export function buildApplicationEnvironments(input: ApplicationEnvironmentInput): {
  api: NodeJS.ProcessEnv;
  web: NodeJS.ProcessEnv;
  secrets: string[];
} {
  if (!safeSegment(input.runId)) throw new Error('Run ID is invalid');
  validateDatabaseUrl(input.databaseUrl, true);
  validateRedisUrl(input.redisUrl);
  parseLoopbackOrigin(input.providerUrls.stripe, 'Stripe simulator URL');
  parseLoopbackOrigin(input.providerUrls.supplier, 'Supplier simulator URL');
  const apiUrl = input.apiUrl ? parseLoopbackOrigin(input.apiUrl, 'API URL') : undefined;
  const frontendUrl = input.frontendUrl
    ? parseLoopbackOrigin(input.frontendUrl, 'Frontend URL')
    : undefined;
  const credentials = input.applicationCredentials;
  if (Object.values(credentials).some((value) => typeof value !== 'string' || value.length < 8)) {
    throw new Error('Application provider credentials are invalid');
  }
  const secrets = {
    jwt: randomSecret(''),
    agent: randomSecret(''),
    claim: randomSecret(''),
    attestation: randomSecret(''),
    chat: randomSecret(''),
    encryption: randomSecret(''),
  };
  const apiValues: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    CI: 'true',
    PORT: apiUrl?.port,
    DATABASE_URL: input.databaseUrl,
    REDIS_URL: input.redisUrl,
    REDIS_KEY_PREFIX: input.redisPrefix,
    FULFILLMENT_HARNESS_RUN_ID: input.runId,
    STRIPE_API_URL: input.providerUrls.stripe,
    STRIPE_SECRET_KEY: credentials.stripeApiKey,
    STRIPE_WEBHOOK_SECRET: credentials.stripeWebhookSecret,
    DUFFEL_API_URL: input.providerUrls.supplier,
    DUFFEL_ACCESS_TOKEN: credentials.supplierApiKey,
    JWT_SECRET: secrets.jwt,
    AGENT_SERVICE_API_KEY: secrets.agent,
    CLAIM_TOKEN_SECRET: secrets.claim,
    ATTESTATION_SECRET: secrets.attestation,
    CHAT_HANDOFF_SECRET: secrets.chat,
    CHAT_ENCRYPTION_KEY: secrets.encryption,
    ENCRYPTION_KEY: secrets.encryption,
    FRONTEND_URL: frontendUrl?.origin,
    FEATURE_FLAG_FULFILLMENT_RECOVERY: 'false',
  };
  const webValues: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    CI: 'true',
    NEXTAUTH_SECRET: secrets.jwt,
    NEXTAUTH_URL: frontendUrl?.origin,
    API_URL: apiUrl?.origin,
    NEXT_PUBLIC_API_URL: apiUrl?.origin,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: credentials.stripePublishableKey,
  };
  return {
    api: runtimeEnvironment(apiValues),
    web: runtimeEnvironment(webValues),
    secrets: Object.values(secrets),
  };
}



function dockerCommand(argumentsList: string[], timeout: number = 60000): string {
  const result = spawnSync('docker', argumentsList, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Owned Redis container operation failed');
  }
  return (result.stdout ?? '').trim();
}

function inspectOwnedContainer(containerId: string): ContainerInspection {
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error('Redis container ID is not a full Docker ID');
  }
  const id = dockerCommand(['inspect', '--format', '{{.Id}}', containerId]);
  const encodedLabels = dockerCommand(['inspect', '--format', '{{json .Config.Labels}}', containerId]);
  let decoded: unknown;
  try {
    decoded = JSON.parse(encodedLabels);
  } catch {
    throw new Error('Redis owner labels could not be read');
  }
  if (!isRecord(decoded)) throw new Error('Redis owner labels are missing');
  const runId = decoded[runLabel];
  const owner = decoded[ownerLabel];
  if (typeof runId !== 'string' || typeof owner !== 'string' || id !== containerId) {
    throw new Error('Redis owner labels do not match the allocated container');
  }
  const portOutput = dockerCommand(['port', containerId, '6379/tcp']);
  const match = /^127\.0\.0\.1:(\d+)$/.exec(portOutput.split(/\r?\n/)[0] ?? '');
  const port = Number(match?.[1]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('Redis container is not bound to a loopback port');
  }
  return { id, runId, owner, port };
}

function startRedisContainer(runId: string, pending: PendingAllocationCleanup): ContainerInspection {
  const labels: Record<string, string> = {
    [ownerLabel]: ownerValue,
    [runLabel]: runId,
  };
  const argumentsList = [
    'run',
    '--detach',
    '--name',
    'fulfillment-recovery-' + runId,
    '--label',
    ownerLabel + '=' + labels[ownerLabel],
    '--label',
    runLabel + '=' + labels[runLabel],
    '--publish',
    '127.0.0.1::6379',
    redisImage,
  ];
  const containerId = dockerCommand(argumentsList);
  pending.redisContainerId = containerId;
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error('Docker did not return a full Redis container ID');
  }
  const inspection = inspectOwnedContainer(containerId);
  if (inspection.runId !== runId || inspection.owner !== ownerValue) {
    throw new Error('Started Redis container did not retain its owner labels');
  }
  return inspection;
}

async function waitForRedis(url: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.ping();
      await client.quit();
      return;
    } catch {
      client.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error('Owned Redis container did not become ready');
}

function scopedDatabaseUrl(databaseUrl: string, schemaName: string): string {
  const url = validateDatabaseUrl(databaseUrl, false);
  url.searchParams.set('schema', schemaName);
  return url.toString();
}

async function createSchema(databaseUrl: string, schemaName: string): Promise<void> {
  const adminUrl = validateDatabaseUrl(databaseUrl, false);
  adminUrl.searchParams.set('schema', 'public');
  const client = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await client.$executeRawUnsafe('CREATE SCHEMA "' + schemaName + '"');
  } finally {
    await client.$disconnect();
  }
}


async function createGeneratedCustomer(
  databaseUrl: string,
  schemaName: string,
  input: RunAllocationRequest,
): Promise<GeneratedCustomerFixture> {
  const digest = createHash('sha256').update(input.scenario + '\n' + input.seed).digest('hex');
  const email = 'fulfillment-' + digest.slice(0, 24) + '@example.test';
  const password = 'Feature030-' + digest.slice(0, 24) + '!';
  const client = new PrismaClient({
    datasources: { db: { url: scopedDatabaseUrl(databaseUrl, schemaName) } },
  });
  try {
    const user = await client.user.create({
      data: { email, password: await bcrypt.hash(password, 10) },
      select: { id: true, email: true },
    });
    return { id: user.id, email: user.email, password };
  } finally {
    await client.$disconnect();
  }
}
async function dropSchema(databaseUrl: string, schemaName: string): Promise<void> {
  if (!/^fulfillment_recovery_[0-9a-f]{32}$/.test(schemaName)) {
    throw new Error('Refusing to drop a schema outside the owned namespace');
  }
  const adminUrl = validateDatabaseUrl(databaseUrl, false);
  adminUrl.searchParams.set('schema', 'public');
  const client = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    await client.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schemaName + '" CASCADE');
  } finally {
    await client.$disconnect();
  }
}

function migrateSchema(databaseUrl: string, schemaName: string): void {
  const apiRoot = path.resolve(__dirname, '../..');
  const scopedUrl = scopedDatabaseUrl(databaseUrl, schemaName);
  const migration = spawnSync(
    process.execPath,
    [
      path.resolve(apiRoot, 'node_modules', 'prisma', 'build', 'index.js'),
      'migrate',
      'deploy',
      '--schema',
      path.resolve(apiRoot, 'prisma', 'schema.prisma'),
    ],
    {
      cwd: apiRoot,
      encoding: 'utf8',
      timeout: 45000,
      windowsHide: true,
      shell: false,
      env: runtimeEnvironment({ DATABASE_URL: scopedUrl }),
    },
  );
  if (migration.error || migration.status !== 0) {
    throw new Error('Prisma migrations could not be applied to the owned schema');
  }
}

function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a loopback port')));
        return;
      }
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolve(address.port);
      });
    });
  });
}

async function choosePort(excluded: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = await getAvailablePort();
    if (!excluded.has(port)) {
      excluded.add(port);
      return port;
    }
  }
  throw new Error('Could not allocate a distinct loopback application port');
}

function originForPort(port: number): string {
  return 'http://127.0.0.1:' + port;
}

function assertLoopbackPeer(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteCount += value.length;
      if (byteCount > maximumRequestBytes) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function responseJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(field + ' must be a non-empty string');
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
    throw new Error(field + ' must be a bounded integer');
  }
  return value;
}



async function schemaExists(databaseUrl: string, schemaName: string): Promise<boolean> {
  const adminUrl = validateDatabaseUrl(databaseUrl, true);
  adminUrl.searchParams.set('schema', 'public');
  const client = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  try {
    const rows = await client.$queryRawUnsafe<Array<{ schema_name: string }>>(
      'SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1',
      schemaName,
    );
    return rows.length === 1;
  } finally {
    await client.$disconnect();
  }
}

function applicationStripePublishableKey(options: HarnessApplicationOptions): unknown {
  return 'stripePublishableKey' in options ? options.stripePublishableKey : undefined;
}
function sameApplicationOptions(left: HarnessApplicationOptions, right: HarnessApplicationOptions): boolean {
  return (
    left.runId === right.runId &&
    left.apiUrl === right.apiUrl &&
    left.frontendUrl === right.frontendUrl &&
    left.databaseUrl === right.databaseUrl &&
    left.redisUrl === right.redisUrl &&
    left.redisPrefix === right.redisPrefix &&
    left.stripeOrigin === right.stripeOrigin &&
    left.stripeApiKey === right.stripeApiKey &&
    applicationStripePublishableKey(left) === applicationStripePublishableKey(right) &&
    left.stripeWebhookSecret === right.stripeWebhookSecret &&
    left.supplierOrigin === right.supplierOrigin &&
    left.supplierApiKey === right.supplierApiKey
  );
}

function registerApplicationChild(application: HarnessApplicationOptions, child: ChildProcess): void {
  const owned = ownedRuns.get(application.runId);
  if (!owned || !sameApplicationOptions(owned.application, application)) {
    throw new Error('Application options do not match an in-process owned fulfillment run');
  }
  rememberOwnedProcess(owned, child);
}

export function registerApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): void {
  registerApplicationChild(application, child);
}
export async function stopApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): Promise<void> {
  const owned = ownedRuns.get(application.runId);
  if (!owned || !sameApplicationOptions(owned.application, application)) {
    throw new Error('Application options do not match an in-process owned fulfillment run');
  }
  const entry = [...owned.children.entries()].find(([, record]) => record.child === child);
  if (!entry) throw new Error('Application child is not registered to this owned fulfillment run');
  const [pid, record] = entry;
  if (!(await stopOwnedChild(owned, pid, record))) {
    throw new Error('Application child could not be safely stopped; owned run resources remain allocated');
  }
}
export function ownedApplicationEnvironment(application: HarnessApplicationOptions): {
  api: NodeJS.ProcessEnv;
  web: NodeJS.ProcessEnv;
  secrets: string[];
} {
  const owned = ownedRuns.get(application.runId);
  if (!owned || !sameApplicationOptions(owned.application, application)) {
    throw new Error('Application options do not match an in-process owned fulfillment run');
  }
  return {
    api: { ...owned.apiEnvironment },
    web: { ...owned.webEnvironment },
    secrets: [...owned.environmentSecrets],
  };
}

export async function assertOwnedRunResources(application: HarnessApplicationOptions): Promise<void> {
  const owned = ownedRuns.get(application.runId);
  if (!owned || !sameApplicationOptions(owned.application, application)) {
    throw new Error('Application options do not match an in-process owned fulfillment run');
  }
  const database = validateDatabaseUrl(application.databaseUrl, true);
  const schemaName = database.searchParams.get('schema');
  if (schemaName !== owned.schemaName || !/^fulfillment_recovery_[0-9a-f]{32}$/.test(schemaName ?? '')) {
    throw new Error('Application schema is not owned by the requested run');
  }
  const redis = validateRedisUrl(application.redisUrl);
  const container = inspectOwnedContainer(owned.redisContainerId);
  if (
    container.id !== owned.redisContainerId ||
    container.runId !== application.runId ||
    container.owner !== ownerValue ||
    container.port !== Number(redis.port) ||
    container.port !== owned.redisPort ||
    owned.redisLabels[runLabel] !== application.runId ||
    owned.redisLabels[ownerLabel] !== ownerValue ||
    application.redisPrefix !== owned.redisPrefix
  ) {
    throw new Error('Application Redis resources do not match the owned run');
  }
  if (
    application.apiUrl !== owned.allocation.apiUrl ||
    application.frontendUrl !== owned.allocation.frontendUrl ||
    application.stripeOrigin !== owned.allocation.providerUrls.stripe ||
    application.supplierOrigin !== owned.allocation.providerUrls.supplier ||
    applicationStripePublishableKey(application) !== owned.allocation.applicationCredentials.stripePublishableKey
  ) {
    throw new Error('Application origins do not match the owned run allocation');
  }
  if (!(await schemaExists(owned.databaseUrl, owned.schemaName))) {
    throw new Error('Owned PostgreSQL schema is missing');
  }
}

function processStartIdentity(pid: number): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const command = '(Get-Process -Id ' + String(pid) + ' -ErrorAction Stop).StartTime.ToUniversalTime().Ticks';
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false,
  });
  const identity = (result.stdout ?? '').trim();
  return result.error || result.status !== 0 || !/^\d+$/.test(identity) ? undefined : identity;
}
function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function childIsAlive(child: ChildProcess): boolean {
  if (!child.pid || childHasExited(child)) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownedChildIdentityMatches(owned: OwnedRun, pid: number, record: OwnedChild): boolean {
  if (owned.children.get(pid) !== record || record.pid !== pid || record.child.pid !== pid) return false;
  if (process.platform !== 'win32') return record.startIdentity === undefined;
  if (!record.startIdentity) return false;
  const currentIdentity = processStartIdentity(pid);
  return currentIdentity !== undefined && currentIdentity === record.startIdentity;
}

function childCanBeSignaled(owned: OwnedRun, pid: number, record: OwnedChild): boolean {
  return ownedChildIdentityMatches(owned, pid, record) && childIsAlive(record.child);
}

function terminateChild(owned: OwnedRun, pid: number, record: OwnedChild): void {
  if (!childCanBeSignaled(owned, pid, record)) throw new Error('Owned child process identity could not be verified');
  record.child.kill('SIGTERM');
}

function rememberOwnedProcess(owned: OwnedRun, child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || !childIsAlive(child)) throw new Error('Only a live child process can be registered');
  for (const other of ownedRuns.values()) {
    if (other.children.has(pid)) throw new Error('Process ID is already registered to a fulfillment run');
  }
  const record: OwnedChild = { pid, child, startIdentity: undefined };
  owned.children.set(pid, record);
  const startIdentity = processStartIdentity(pid);
  if (child.pid !== pid || childHasExited(child)) {
    throw new Error('Child process changed while ownership was being recorded');
  }
  if (process.platform === 'win32' && !startIdentity) {
    throw new Error('Windows child process start identity could not be verified');
  }
  record.startIdentity = startIdentity;
}
function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const onClose = (): void => finish(true);
    function finish(closed: boolean): void {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve(closed);
    }
    child.once('close', onClose);
  });
}

function forceTerminateOwnedChild(owned: OwnedRun, pid: number, record: OwnedChild): void {
  if (!childCanBeSignaled(owned, pid, record)) throw new Error('Owned child process identity could not be verified');
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false,
    });
    if (result.error || result.status !== 0) throw new Error('Owned child process tree could not be terminated');
    return;
  }
  record.child.kill('SIGKILL');
}

async function stopOwnedChildOnce(owned: OwnedRun, pid: number, record: OwnedChild): Promise<boolean> {
  if (owned.children.get(pid) !== record || record.pid !== pid) return false;
  const child = record.child;
  if (childHasExited(child)) {
    owned.children.delete(pid);
    return true;
  }
  if (child.pid !== pid || childHasExited(child)) return false;
  try {
    if (process.platform === 'win32') forceTerminateOwnedChild(owned, pid, record);
    else terminateChild(owned, pid, record);
    let closed = await waitForChildClose(child, 5000);
    if (process.platform !== 'win32' && !closed && !childHasExited(child)) {
      forceTerminateOwnedChild(owned, pid, record);
      closed = await waitForChildClose(child, 1000);
    }
    if (closed || childHasExited(child)) {
      owned.children.delete(pid);
      return true;
    }
  } catch {
    if (childHasExited(child)) {
      owned.children.delete(pid);
      return true;
    }
  }
  return false;
}

async function stopOwnedChild(owned: OwnedRun, pid: number, record: OwnedChild): Promise<boolean> {
  if (record.stopPromise) return record.stopPromise;
  const stopping = stopOwnedChildOnce(owned, pid, record);
  record.stopPromise = stopping;
  try {
    return await stopping;
  } finally {
    if (record.stopPromise === stopping) record.stopPromise = undefined;
  }
}

async function stopOwnedChildren(owned: OwnedRun): Promise<{ terminated: number[]; leaked: number }> {
  const terminated: number[] = [];
  let leaked = 0;
  for (const [pid, record] of [...owned.children].reverse()) {
    try {
      if (await stopOwnedChild(owned, pid, record)) terminated.push(pid);
      else leaked += 1;
    } catch {
      leaked += 1;
    }
  }
  return { terminated, leaked };
}function removeRunContainer(containerId: string, runId: string): boolean {
  const inspection = inspectOwnedContainer(containerId);
  if (inspection.id !== containerId || inspection.runId !== runId || inspection.owner !== ownerValue) return false;
  dockerCommand(['rm', '--force', containerId], 15000);
  return true;
}

async function removeOwnedContainer(owned: OwnedRun): Promise<boolean> {
  if (owned.redisRemoved) return true;
  try {
    if (!removeRunContainer(owned.redisContainerId, owned.allocation.runId)) return false;
    owned.redisRemoved = true;
    return true;
  } catch {
    return false;
  }
}

function findOwnedRunContainers(runId: string): string[] {
  const output = dockerCommand([
    'ps', '--all', '--quiet', '--no-trunc',
    '--filter', 'label=' + ownerLabel + '=' + ownerValue,
    '--filter', 'label=' + runLabel + '=' + runId,
  ]);
  return output.split(/\r?\n/).filter((value) => value.length > 0);
}

async function cleanupPendingAllocation(pending: PendingAllocationCleanup): Promise<number> {
  let leaked = 0;
  if (pending.supplier) {
    try { await pending.supplier.close(); pending.supplier = undefined; }
    catch { leaked += 1; }
  }
  if (pending.stripe) {
    try { await pending.stripe.close(); pending.stripe = undefined; }
    catch { leaked += 1; }
  }
  if (pending.redisStartAttempted) {
    let redisLeaked = false;
    try {
      const containerIds = pending.redisContainerId && /^[0-9a-f]{64}$/.test(pending.redisContainerId)
        ? [pending.redisContainerId]
        : findOwnedRunContainers(pending.runId);
      for (const containerId of containerIds) {
        if (!removeRunContainer(containerId, pending.runId)) {
          leaked += 1;
          redisLeaked = true;
        }
      }
    } catch {
      leaked += 1;
      redisLeaked = true;
    }
    if (!redisLeaked) {
      pending.redisContainerId = undefined;
      pending.redisStartAttempted = false;
    }
  }
  if (pending.schemaMayExist) {
    try { await dropSchema(pending.databaseUrl, pending.schemaName); pending.schemaMayExist = false; }
    catch { leaked += 1; }
  }
  if (leaked === 0) pendingAllocations.delete(pending.runId);
  return leaked;
}
async function closeSimulators(owned: OwnedRun): Promise<number> {
  let leaked = 0;
  if (!owned.stripeClosed) {
    try { await owned.stripe.close(); owned.stripeClosed = true; }
    catch { leaked += 1; }
  }
  if (!owned.supplierClosed) {
    try { await owned.supplier.close(); owned.supplierClosed = true; }
    catch { leaked += 1; }
  }
  return leaked;
}

async function teardownOwnedRun(owned: OwnedRun): Promise<CleanupReport> {
  const runId = owned.allocation.runId;
  const processCleanup = await stopOwnedChildren(owned);
  if (processCleanup.leaked > 0) {
    return {
      runId,
      terminatedProcessIds: processCleanup.terminated,
      droppedSchema: '',
      removedRedisPrefix: '',
      leakedResourceCount: processCleanup.leaked,
    };
  }

  let leakedResourceCount = await closeSimulators(owned);
  if (!(await removeOwnedContainer(owned))) leakedResourceCount += 1;
  if (!owned.schemaDropped) {
    try { await dropSchema(owned.databaseUrl, owned.schemaName); owned.schemaDropped = true; }
    catch { leakedResourceCount += 1; }
  }
  // The run-local virtual scheduler has no timers; deleting this record discards undrained callbacks.
  if (leakedResourceCount === 0) ownedRuns.delete(runId);
  return {
    runId,
    terminatedProcessIds: processCleanup.terminated,
    droppedSchema: owned.schemaDropped ? owned.schemaName : '',
    removedRedisPrefix: owned.redisRemoved ? owned.redisPrefix : '',
    leakedResourceCount,
  };
}
async function allocateOwnedRun(
  input: RunAllocationRequest,
  databaseUrl: string,
  eventIngressOverride: string | undefined,
  reservedPorts: Set<number>,
): Promise<OwnedRun> {
  if (!safeSegment(input.scenario) || !safeSegment(input.seed)) {
    throw new Error('Scenario and seed must be bounded safe identifiers');
  }
  const startTime = new Date(input.startTime);
  if (!Number.isFinite(startTime.getTime())) throw new Error('Run start time is invalid');
  const runId = 'run-' + randomUUID();
  const schemaName = 'fulfillment_recovery_' + randomUUID().replaceAll('-', '');
  const pending: PendingAllocationCleanup = { runId, databaseUrl, schemaName, schemaMayExist: false, redisStartAttempted: false };
  pendingAllocations.set(runId, pending);
  try {
    const stripe = await startStripeServer({ runId });
    pending.stripe = stripe;
    const supplier = await startSupplierServer({ runId, balanceAmount: '987.65', balanceCurrency: 'EUR' });
    pending.supplier = supplier;
    pending.redisStartAttempted = true;
    const container = startRedisContainer(runId, pending);
    reservedPorts.add(container.port);
    const redisUrl = 'redis://127.0.0.1:' + container.port + '/0';
    await waitForRedis(redisUrl);
    pending.schemaMayExist = true;
    await createSchema(databaseUrl, schemaName);
    migrateSchema(databaseUrl, schemaName);
    const customer = await createGeneratedCustomer(databaseUrl, schemaName, input);
    const apiUrl = originForPort(await choosePort(reservedPorts));
    const frontendUrl = originForPort(await choosePort(reservedPorts));
    const redisPrefix = 'fulfillment:run:' + runId + ':';
    const scopedUrl = scopedDatabaseUrl(databaseUrl, schemaName);
    const applicationCredentials = {
      stripeApiKey: stripe.applicationCredential,
      stripePublishableKey: stripe.publishableKey,
      stripeWebhookSecret: stripe.webhookSecret,
      supplierApiKey: supplier.applicationCredential,
    };
    const allocation: RunAllocation = {
      runId,
      apiUrl,
      frontendUrl,
      providerUrls: { stripe: stripe.origin, supplier: supplier.origin },
      applicationCredentials,
      driverToken: randomSecret('driver_'),
      customer,
    };
    const application: HarnessApplicationOptions = {
      runId,
      apiUrl,
      frontendUrl,
      databaseUrl: scopedUrl,
      redisUrl,
      redisPrefix,
      stripeOrigin: stripe.origin,
      stripeApiKey: stripe.applicationCredential,
      stripePublishableKey: stripe.publishableKey,
      stripeWebhookSecret: stripe.webhookSecret,
      supplierOrigin: supplier.origin,
      supplierApiKey: supplier.applicationCredential,
    };
    const environments = buildApplicationEnvironments({
      runId,
      databaseUrl: scopedUrl,
      redisUrl,
      redisPrefix,
      providerUrls: allocation.providerUrls,
      applicationCredentials,
      apiUrl,
      frontendUrl,
    });
    const owned: OwnedRun = {
      allocation,
      application,
      apiEnvironment: environments.api,
      webEnvironment: environments.web,
      environmentSecrets: [...environments.secrets, customer.password],
      stripe,
      supplier,
      scheduler: new VirtualFulfillmentRecoveryScheduler(startTime),
      databaseUrl,
      schemaName,
      redisContainerId: container.id,
      redisPort: container.port,
      redisPrefix,
      redisLabels: { [ownerLabel]: ownerValue, [runLabel]: runId },
      ingressUrl: eventIngressOverride ?? apiUrl,
      children: new Map<number, OwnedChild>(),
      stripeClosed: false,
      supplierClosed: false,
      redisRemoved: false,
      schemaDropped: false,
    };
    ownedRuns.set(runId, owned);
    pendingAllocations.delete(runId);
    return owned;
  } catch {
    const leaked = await cleanupPendingAllocation(pending);
    if (leaked > 0) {
      throw new Error('Run allocation cleanup remains pending for ' + runId + ': ' + leaked + ' resources');
    }
    throw new Error('Run allocation failed');
  }
}
function runFor(runId: string): OwnedRun {
  const owned = ownedRuns.get(runId);
  if (!owned) throw new Error('Fulfillment run was not found');
  return owned;
}

function safeStripeLedger(ledger: SimulatorStripeLedger): RedactedLedger {
  return {
    provider: 'STRIPE',
    paymentIntents: ledger.paymentIntents.map((intent) => ({
      id: intent.id, amount: intent.amount, currency: intent.currency,
      captureMethod: intent.captureMethod, status: intent.status,
    })),
    refunds: ledger.refunds.map((refund) => ({
      id: refund.id, paymentIntentId: refund.paymentIntentId, amount: refund.amount, status: refund.status,
    })),
    requestsReceived: ledger.requestsReceived,
    sideEffectCount: ledger.sideEffectCount,
    pendingEventIds: [...ledger.pendingEventIds],
    pendingResponseIds: [...ledger.pendingResponseIds],
  };
}

function safeSupplierLedger(ledger: SimulatorSupplierLedger): RedactedLedger {
  return {
    provider: 'DUFFEL',
    orders: ledger.orders.map((order) => ({
      id: order.id, balanceAmount: order.balanceAmount, balanceCurrency: order.balanceCurrency,
      status: order.status, serviceIds: [...order.serviceIds],
    })),
    requestsReceived: ledger.requestsReceived,
    sideEffectCount: ledger.sideEffectCount,
    pendingEventIds: [...ledger.pendingEventIds],
    pendingResponseIds: [...ledger.pendingResponseIds],
  };
}

function providerName(value: unknown): ProviderName {
  if (value === 'STRIPE' || value === 'DUFFEL') return value;
  throw new Error('Provider must be STRIPE or DUFFEL');
}

function makeDriver(
  databaseUrl: string,
  ingressOverride: string | undefined,
  reservedPorts: Set<number>,
  activeRunIds: Set<string>,
): FulfillmentHarnessDriver {
  return {
    allocate: async (input) => {
      const owned = await allocateOwnedRun(input, databaseUrl, ingressOverride, reservedPorts);
      activeRunIds.add(owned.allocation.runId);
      return owned.allocation;
    },
    async selectFault(runId, input: FaultSelection): Promise<void> {
      const owned = runFor(runId);
      assertSupportedFaultSelection(input);
      if (input.provider === 'STRIPE') await owned.stripe.selectFault(runId, input);
      else await owned.supplier.selectFault(runId, input);
    },
    async inspect(runId, provider): Promise<RedactedLedger> {
      const owned = runFor(runId);
      if (provider === 'STRIPE') return safeStripeLedger(await owned.stripe.inspect(runId));
      return safeSupplierLedger(await owned.supplier.inspect(runId));
    },
    async releaseEvent(runId, eventId, copies, deliveryOrder): Promise<IngressResult> {
      const owned = runFor(runId);
      requireInteger(copies, 'copies', 1, 20);
      if (deliveryOrder.length !== copies || new Set(deliveryOrder).size !== copies ||
        deliveryOrder.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= copies)) {
        throw new Error('Delivery order must be a permutation of copy indices');
      }
      const event = await owned.stripe.releaseEvent(runId, eventId);
      const acceptedStatuses: number[] = [];
      for (const _index of deliveryOrder) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
        try {
          const response = await fetch(owned.ingressUrl + '/payments/webhook', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'stripe-signature': event.signature },
            body: event.body,
            signal: controller.signal,
          });
          acceptedStatuses.push(response.status);
          await response.arrayBuffer();
        } catch {
          acceptedStatuses.push(0);
        } finally {
          clearTimeout(timer);
        }
      }
      return { eventId, acceptedStatuses };
    },
    async releaseResponse(runId, responseId): Promise<void> {
      const owned = runFor(runId);
      try {
        await owned.stripe.releaseResponse(runId, responseId);
      } catch {
        await owned.supplier.releaseResponse(runId, responseId);
      }
    },
    async advanceClock(runId, milliseconds, maxJobs) {
      return runFor(runId).scheduler.advance(milliseconds, maxJobs);
    },
    async drainScheduler(runId, maxJobs) {
      return runFor(runId).scheduler.advance(0, maxJobs);
    },
    async teardown(runId): Promise<CleanupReport> {
      const owned = runFor(runId);
      const report = await teardownOwnedRun(owned);
      if (report.leakedResourceCount === 0) activeRunIds.delete(runId);
      return report;
    },
  };
}



function parseFaultSelection(value: unknown): FaultSelection {
  if (!isRecord(value)) throw new Error('Fault selection must be a JSON object');
  const provider = providerName(value.provider);
  const purpose = requireString(value.purpose, 'purpose');
  const outcome = requireString(value.outcome, 'outcome');
  const bookingIntentId = requireString(value.bookingIntentId, 'bookingIntentId');
  const scenario = FULFILLMENT_SCENARIO_MANIFEST.find((candidate) =>
    candidate.provider === provider && candidate.purpose === purpose && candidate.outcome === outcome);
  if (!scenario) throw new Error('Unsupported fulfillment fault scenario');
  return { provider, purpose: scenario.purpose, outcome: scenario.outcome, bookingIntentId };
}

function requestToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length);
  return token.length > 0 ? token : undefined;
}

function tokenBelongsToActiveRun(token: string): boolean {
  return [...ownedRuns.values()].some((owned) => owned.allocation.driverToken === token);
}

function parseRunRequest(value: unknown): RunAllocationRequest {
  if (!isRecord(value)) throw new Error('Run request must be a JSON object');
  return {
    scenario: requireString(value.scenario, 'scenario'),
    seed: requireString(value.seed, 'seed'),
    startTime: requireString(value.startTime, 'startTime'),
  };
}

async function handleRunRoute(
  request: IncomingMessage,
  response: ServerResponse,
  owned: OwnedRun,
  segments: string[],
  url: URL,
  driver: FulfillmentHarnessDriver,
): Promise<void> {
  const runId = owned.allocation.runId;
  const method = request.method ?? 'GET';
  if (method === 'GET' && segments.length === 4 && segments[3] === 'ledger') {
    const requested = url.searchParams.get('provider')?.toUpperCase();
    const provider = providerName(requested);
    responseJson(response, 200, await driver.inspect(runId, provider));
    return;
  }
  if (method === 'POST' && segments.length === 4 && segments[3] === 'scenarios') {
    const body = parseJson(await readRequestBody(request));
    await driver.selectFault(runId, parseFaultSelection(body));
    responseJson(response, 200, { accepted: true });
    return;
  }
  if (method === 'POST' && segments.length === 6 && segments[3] === 'events' && segments[5] === 'release') {
    const body = parseJson(await readRequestBody(request));
    if (!isRecord(body) || !Array.isArray(body.deliveryOrder)) throw new Error('Event release body is invalid');
    const result = await driver.releaseEvent(
      runId, decodeURIComponent(segments[4] ?? ''),
      requireInteger(body.copies, 'copies', 1, 20),
      body.deliveryOrder.map((value) => requireInteger(value, 'delivery order index', 0, 19)),
    );
    responseJson(response, 200, result);
    return;
  }
  if (method === 'POST' && segments.length === 6 && segments[3] === 'responses' && segments[5] === 'release') {
    await readRequestBody(request);
    await driver.releaseResponse(runId, decodeURIComponent(segments[4] ?? ''));
    responseJson(response, 200, { released: true });
    return;
  }
  if (method === 'POST' && segments.length === 5 && segments[3] === 'clock' && segments[4] === 'advance') {
    const body = parseJson(await readRequestBody(request));
    if (!isRecord(body)) throw new Error('Clock request body is invalid');
    const milliseconds = requireInteger(body.milliseconds, 'milliseconds', 0, 86400000);
    const maxJobs = requireInteger(body.maxJobs, 'maxJobs', 0, 1000);
    responseJson(response, 200, await driver.advanceClock(runId, milliseconds, maxJobs));
    return;
  }
  if (method === 'POST' && segments.length === 5 && segments[3] === 'scheduler' && segments[4] === 'drain') {
    const body = parseJson(await readRequestBody(request));
    if (!isRecord(body)) throw new Error('Scheduler request body is invalid');
    responseJson(response, 200, await driver.drainScheduler(runId, requireInteger(body.maxJobs, 'maxJobs', 0, 1000)));
    return;
  }
  if (method === 'DELETE' && segments.length === 3) {
    const report = await driver.teardown(runId);
    responseJson(response, report.leakedResourceCount === 0 ? 200 : 500, report);

    return;
  }
  responseJson(response, 404, { error: 'not_found' });
}

async function handleControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  driver: FulfillmentHarnessDriver,
  bootstrapToken: string,
): Promise<void> {
  if (!assertLoopbackPeer(request)) {
    responseJson(response, 403, { error: 'loopback_peer_required' });
    return;
  }
  const token = requestToken(request);
  let url: URL;
  try { url = new URL(request.url ?? '/', origin); }
  catch { responseJson(response, 400, { error: 'invalid_request' }); return; }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 2 && segments[0] === 'driver' && segments[1] === 'runs' && request.method === 'POST') {
    if (!token || (token !== bootstrapToken && !tokenBelongsToActiveRun(token))) { responseJson(response, 401, { error: 'unauthorized' }); return; }
    try {
      const allocation = await driver.allocate(parseRunRequest(parseJson(await readRequestBody(request))));
      responseJson(response, 201, allocation);
    } catch { responseJson(response, 400, { error: 'invalid_request' }); }
    return;
  }
  if (segments.length < 3 || segments[0] !== 'driver' || segments[1] !== 'runs') {
    responseJson(response, 404, { error: 'not_found' }); return;
  }
  if (!token) { responseJson(response, 401, { error: 'unauthorized' }); return; }
  let runId: string;
  try { runId = decodeURIComponent(segments[2] ?? ''); }
  catch { responseJson(response, 404, { error: 'not_found' }); return; }
  const owned = ownedRuns.get(runId);
  if (!owned) {
    responseJson(response, tokenBelongsToActiveRun(token) ? 404 : 401, { error: tokenBelongsToActiveRun(token) ? 'not_found' : 'unauthorized' });
    return;
  }
  if (token !== owned.allocation.driverToken) {
    responseJson(response, tokenBelongsToActiveRun(token) ? 404 : 401, { error: tokenBelongsToActiveRun(token) ? 'not_found' : 'unauthorized' });
    return;
  }
  try { await handleRunRoute(request, response, owned, segments, url, driver); }
  catch { responseJson(response, 400, { error: 'invalid_request' }); }
}

export async function startFulfillmentHarnessDriver(options: DriverOptions): Promise<FulfillmentHarnessDriverServer> {
  const databaseUrl = validateDatabaseUrl(options.databaseUrl, false);
  if (options.bindAddress !== undefined && options.bindAddress !== '127.0.0.1') {
    throw new Error('Fulfillment driver must bind to 127.0.0.1');
  }
  if (options.redisImage !== undefined && options.redisImage !== redisImage) {
    throw new Error('Fulfillment driver only permits the pinned redis:7-alpine test image');
  }
  const eventIngressOverride = options.apiUrl
    ? parseLoopbackOrigin(options.apiUrl, 'Event ingress override').origin
    : undefined;
  const frontendHint = options.frontendUrl
    ? Number(parseLoopbackOrigin(options.frontendUrl, 'Frontend URL hint').port)
    : undefined;
  const reservedPorts = new Set<number>();
  if (eventIngressOverride) reservedPorts.add(Number(new URL(eventIngressOverride).port));
  if (frontendHint !== undefined) reservedPorts.add(frontendHint);
  const bootstrapToken = randomSecret('bootstrap_');
  const control = createServer((request, response) => {
    void handleControlRequest(request, response, controlOrigin, driver, bootstrapToken);
  });
  let controlOrigin = '';
  const activeRunIds = new Set<string>();
  const driver = makeDriver(databaseUrl.toString(), eventIngressOverride, reservedPorts, activeRunIds);
  await waitForServer(control);
  const address = control.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => control.close(() => resolve()));
    throw new Error('Fulfillment driver failed to bind a TCP port');
  }
  controlOrigin = 'http://127.0.0.1:' + address.port;
  reservedPorts.add(address.port);
  return {
    origin: controlOrigin,
    bootstrapToken,
    driver,
    applicationEnvironment(runId): ApplicationEnvironment {
      const owned = runFor(runId);
      const environment = ownedApplicationEnvironment(owned.application);
      return { api: environment.api, web: environment.web };
    },
    applicationOptions(runId): HarnessApplicationOptions {
      return { ...runFor(runId).application };
    },
    registerOwnedProcess(runId, child): void {
      rememberOwnedProcess(runFor(runId), child);
    },
    registerApplicationProcess(application, child): void {
      registerApplicationChild(application, child);
    },
    stopApplicationProcess(application, child): Promise<void> {
      return stopApplicationProcess(application, child);
    },
    async close(): Promise<void> {
      let leaked = 0;
      for (const runId of [...activeRunIds]) {
        const owned = ownedRuns.get(runId);
        if (!owned) { activeRunIds.delete(runId); continue; }
        const report = await teardownOwnedRun(owned);
        if (report.leakedResourceCount === 0) activeRunIds.delete(runId);
        else leaked += report.leakedResourceCount;
      }
      for (const pending of [...pendingAllocations.values()]) {
        leaked += await cleanupPendingAllocation(pending);
      }
      if (leaked > 0) throw new Error('Fulfillment driver close left owned resources behind');
      await new Promise<void>((resolve, reject) => {
        control.close((error) => error ? reject(error) : resolve());
        control.closeAllConnections();
      });
    },
  };
}

function waitForServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}
