import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export type HarnessApplicationOptions = {
  runId: string;
  apiUrl: string;
  frontendUrl: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  stripeOrigin: string;
  stripeApiKey: string;
  stripePublishableKey?: string;
  stripeWebhookSecret: string;
  supplierOrigin: string;
  supplierApiKey: string;
};

export type HarnessDriverOptions = {
  runId: string;
  loopbackOrigin: string;
  driverToken: string;
};

export interface FulfillmentHarnessServer {
  start(): Promise<void>;
  waitForHealthy(timeoutMs: number): Promise<void>;
  stop(): Promise<void>;
}

type LoopbackOrigin = {
  origin: string;
  port: number;
};

type ChildRecord = {
  name: string;
  child: ChildProcess;
  output: string;
  registrationAttempted: boolean;
  registered: boolean;
  closed: boolean;
};

type OwnershipModule = {
  assertOwnedRunResources(application: HarnessApplicationOptions): Promise<void>;
  ownedApplicationEnvironment(application: HarnessApplicationOptions): unknown;
  registerApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): unknown;
  stopApplicationProcess(application: HarnessApplicationOptions, child: ChildProcess): Promise<void>;
};

type OwnedApplicationEnvironments = {
  api: NodeJS.ProcessEnv;
  web: NodeJS.ProcessEnv;
  secrets: string[];
};
type SensitiveRedactionModule = {
  redactSensitive(value: unknown): string;
};

const spawnedProcessIds = new Set<number>();
const maximumLogCharacters = 8192;
const requestTimeoutMs = 1000;

export function spawnedChildProcessIds(): number[] {
  return [...spawnedProcessIds];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOwnershipModule(value: unknown): value is OwnershipModule {
  return (
    isRecord(value) &&
    typeof value['assertOwnedRunResources'] === 'function' &&
    typeof value['ownedApplicationEnvironment'] === 'function' &&
    typeof value['registerApplicationProcess'] === 'function' &&
    typeof value['stopApplicationProcess'] === 'function'
  );
}
function isSensitiveRedactionModule(value: unknown): value is SensitiveRedactionModule {
  return isRecord(value) && typeof value['redactSensitive'] === 'function';
}

function parseLoopbackOrigin(value: string, name: string): LoopbackOrigin {
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
  return { origin: url.origin, port };
}

function validateDatabaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Database URL must target the local fulfillment_recovery_test database');
  }
  const schemas = url.searchParams.getAll('schema');
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/fulfillment_recovery_test' ||
    schemas.length !== 1 ||
    !/^fulfillment_recovery_[0-9a-f]{32}$/.test(schemas[0] ?? '')
  ) {
    throw new Error('Database URL must include an allocated schema in fulfillment_recovery_test');
  }
}

function validateRedisUrl(value: string): number {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Redis URL must target a task-owned loopback instance');
  }
  const port = Number(url.port);
  const database = Number(url.pathname.slice(1));
  if (
    url.protocol !== 'redis:' ||
    url.hostname !== '127.0.0.1' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/(0|[1-9][0-9]*)$/.test(url.pathname) ||
    !Number.isSafeInteger(database) ||
    database < 0 ||
    database > 15 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error('Redis URL must target a task-owned loopback instance');
  }
  return port;
}

function validateApplicationOptions(
  application: HarnessApplicationOptions,
  driver: HarnessDriverOptions,
): { api: LoopbackOrigin; frontend: LoopbackOrigin; redisPort: number } {
  if (!/^run[-_][A-Za-z0-9_-]{1,120}$/.test(application.runId)) {
    throw new Error('A generated fulfillment run ID is required');
  }
  if (driver.runId !== application.runId) {
    throw new Error('Application and driver run IDs must match');
  }
  if (!driver.driverToken.trim()) {
    throw new Error('A separate fulfillment driver token is required');
  }

  const api = parseLoopbackOrigin(application.apiUrl, 'API');
  const frontend = parseLoopbackOrigin(application.frontendUrl, 'Frontend');
  const stripe = parseLoopbackOrigin(application.stripeOrigin, 'Stripe simulator');
  const supplier = parseLoopbackOrigin(application.supplierOrigin, 'Supplier simulator');
  const driverOrigin = parseLoopbackOrigin(driver.loopbackOrigin, 'Driver');
  const redisPort = validateRedisUrl(application.redisUrl);
  validateDatabaseUrl(application.databaseUrl);

  const ports = [api.port, frontend.port, stripe.port, supplier.port, driverOrigin.port, redisPort];
  if (new Set(ports).size !== ports.length) {
    throw new Error('Fulfillment run services must use distinct owned ports');
  }
  if (
    !application.redisPrefix.startsWith('fulfillment:') ||
    !/^[A-Za-z0-9:_-]+$/.test(application.redisPrefix) ||
    !application.redisPrefix.split(':').includes(application.runId)
  ) {
    throw new Error('Redis prefix must identify the fulfillment run');
  }
  if (!/^sk_test_[A-Za-z0-9_-]+$/.test(application.stripeApiKey)) {
    throw new Error('Stripe simulator key must be test-only');
  }
  if (application.stripePublishableKey !== undefined && !/^pk_test_[A-Za-z0-9_-]+$/.test(application.stripePublishableKey)) {
    throw new Error('Stripe browser key must be test-only');
  }

  if (!/^whsec_[A-Za-z0-9_-]+$/.test(application.stripeWebhookSecret)) {
    throw new Error('Stripe webhook signing secret is malformed');
  }
  if (!/^duffel_test_[A-Za-z0-9_-]+$/.test(application.supplierApiKey)) {
    throw new Error('Supplier simulator key must be test-only');
  }

  for (const [name, value] of Object.entries(application)) {
    if (
      name.toLowerCase().includes('driver') ||
      (typeof value === 'string' && value.includes(driver.driverToken))
    ) {
      throw new Error('Driver credentials cannot be included in application options');
    }
  }
  return { api, frontend, redisPort };
}

async function loadOwnershipModule(): Promise<OwnershipModule> {
  let loaded: unknown;
  try {
    const modulePath = path.resolve(__dirname, 'bootstrap');
    loaded = await import(modulePath);
  } catch {
    throw new Error('T013 run ownership validator is unavailable');
  }
  if (!isOwnershipModule(loaded)) {
    throw new Error('T013 run ownership validator is unavailable');
  }
  return loaded;
}

async function assertOwnedRunResources(application: HarnessApplicationOptions): Promise<void> {
  const owner = await loadOwnershipModule();
  try {
    await owner.assertOwnedRunResources(application);
  } catch {
    throw new Error('Fulfillment run resources are not owned by this run');
  }
}

function registerApplicationProcess(
  owner: OwnershipModule,
  application: HarnessApplicationOptions,
  child: ChildProcess,
): void {
  try {
    owner.registerApplicationProcess(application, child);
  } catch {
    throw new Error('Fulfillment application process could not be registered to owned run');
  }
}

async function stopOwnedApplicationProcess(
  owner: OwnershipModule,
  application: HarnessApplicationOptions,
  child: ChildProcess,
): Promise<void> {
  try {
    await owner.stopApplicationProcess(application, child);
  } catch {
    throw new Error('Fulfillment application process could not be safely stopped by its owner');
  }
}

function readRuntimeEnvironment(value: unknown): NodeJS.ProcessEnv {
  if (!isRecord(value)) throw new Error('Owned application environment is invalid');
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new Error('Owned application environment is invalid');
    environment[name] = entry;
  }
  return environment;
}

async function loadOwnedApplicationEnvironments(
  application: HarnessApplicationOptions,
): Promise<OwnedApplicationEnvironments> {
  const owner = await loadOwnershipModule();
  const value = owner.ownedApplicationEnvironment(application);
  if (!isRecord(value) || !Array.isArray(value['secrets'])) {
    throw new Error('T013 owned application environment is unavailable');
  }
  const api = readRuntimeEnvironment(value['api']);
  const web = readRuntimeEnvironment(value['web']);
  const secrets: string[] = [];
  for (const secret of value['secrets']) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('T013 owned application environment is invalid');
    }
    secrets.push(secret);
  }
  const publishableKey = application.stripePublishableKey;
  if (typeof publishableKey !== 'string' || publishableKey.length === 0) {
    throw new Error('Allocated Stripe browser key is missing');
  }
  const expectedApi: Record<string, string> = {
    NODE_ENV: 'test',
    FULFILLMENT_HARNESS_RUN_ID: application.runId,
    PORT: new URL(application.apiUrl).port,
    DATABASE_URL: application.databaseUrl,
    REDIS_URL: application.redisUrl,
    REDIS_KEY_PREFIX: application.redisPrefix,
    STRIPE_API_URL: application.stripeOrigin,
    STRIPE_SECRET_KEY: application.stripeApiKey,
    STRIPE_WEBHOOK_SECRET: application.stripeWebhookSecret,
    DUFFEL_API_URL: application.supplierOrigin,
    DUFFEL_ACCESS_TOKEN: application.supplierApiKey,
    FRONTEND_URL: new URL(application.frontendUrl).origin,
  };
  const expectedWeb: Record<string, string> = {
    NODE_ENV: 'test',
    NEXTAUTH_URL: new URL(application.frontendUrl).origin,
    API_URL: new URL(application.apiUrl).origin,
    NEXT_PUBLIC_API_URL: new URL(application.apiUrl).origin,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: publishableKey,
  };
  for (const [name, expected] of Object.entries(expectedApi)) {
    if (api[name] !== expected) throw new Error('T013 API environment does not match its allocation');
  }
  for (const [name, expected] of Object.entries(expectedWeb)) {
    if (web[name] !== expected) throw new Error('T013 web environment does not match its allocation');
  }
  return { api, web, secrets };
}
async function loadSensitiveRedactor(): Promise<(value: unknown) => string> {
  let loaded: unknown;
  try {
    const repositoryRoot = path.resolve(__dirname, '../../../..');
    const helperPath = path.resolve(repositoryRoot, 'tests', 'smoke', 'helpers', 'test-utils.mjs');
    loaded = await import(pathToFileURL(helperPath).href);
  } catch {
    throw new Error('Centralized diagnostic redaction helper is unavailable');
  }
  if (!isSensitiveRedactionModule(loaded)) {
    throw new Error('Centralized diagnostic redaction helper is unavailable');
  }
  const module = loaded;
  return (value: unknown): string => module.redactSensitive(value);
}

function redactCapturedOutputWith(
  value: string,
  secrets: readonly string[],
  redactSensitive: (value: unknown) => string,
): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
  }
  return redactSensitive(safe);
}

export async function redactCapturedOutput(value: string, secrets: readonly string[]): Promise<string> {
  const redactSensitive = await loadSensitiveRedactor();
  return redactCapturedOutputWith(value, secrets, redactSensitive);
}

function appendOutput(
  record: ChildRecord,
  chunk: unknown,
  secrets: readonly string[],
  redactSensitive: (value: unknown) => string,
): void {
  const value = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  const safe = redactCapturedOutputWith(value, secrets, redactSensitive);
  record.output = (record.output + safe).slice(-maximumLogCharacters);
}

function launchProcess(
  name: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  secrets: readonly string[],
  redactSensitive: (value: unknown) => string,
  onSpawn: (child: ChildProcess) => void,
): ChildRecord {
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
  });
  const record: ChildRecord = { name, child, output: '', registrationAttempted: false, registered: false, closed: false };
  child.stdout?.on('data', (chunk: unknown) => appendOutput(record, chunk, secrets, redactSensitive));
  child.stderr?.on('data', (chunk: unknown) => appendOutput(record, chunk, secrets, redactSensitive));
  child.once('spawn', () => {
    if (child.pid) spawnedProcessIds.add(child.pid);
    record.registrationAttempted = true;
    try {
      onSpawn(child);
      record.registered = true;
    } catch {
      record.registered = false;
    }
  });
  child.once('close', () => {
    record.closed = true;
    if (child.pid) spawnedProcessIds.delete(child.pid);
  });
  return record;
}

function waitForSpawn(record: ChildRecord): Promise<void> {
  const child = record.child;
  if (record.registrationAttempted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onSpawn = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error(record.name + ' process could not start'));
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error(record.name + ' process exited before startup'));
    };
    const cleanup = (): void => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForClose(record: ChildRecord, timeoutMs: number): Promise<void> {
  const child = record.child;
  if (record.closed || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, timeoutMs);
    const onClose = (): void => finish();
    function finish(): void {
      clearTimeout(timer);
      child.off('close', onClose);
      resolve();
    }
    child.once('close', onClose);
  });
}

async function stopProcesses(
  records: ChildRecord[],
  application: HarnessApplicationOptions,
  owner: OwnershipModule | undefined,
): Promise<void> {
  let failed = false;
  for (const record of [...records].reverse()) {
    if (record.closed || record.child.pid === undefined || record.child.exitCode !== null || record.child.signalCode !== null) continue;
    if (!owner || !record.registrationAttempted) {
      failed = true;
      continue;
    }
    try {
      await stopOwnedApplicationProcess(owner, application, record.child);
      await waitForClose(record, 1000);
    } catch {
      failed = true;
    }
    if (!record.closed && record.child.exitCode === null && record.child.signalCode === null) failed = true;
  }
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record && (record.closed || record.child.pid === undefined || record.child.exitCode !== null || record.child.signalCode !== null)) records.splice(index, 1);
  }
  if (failed) throw new Error('A recorded fulfillment application process did not stop');
}

async function isHealthy(url: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function processFailure(records: ChildRecord[]): string | undefined {
  const failed = records.find((record) => record.closed || record.child.exitCode !== null || record.child.signalCode !== null);
  if (!failed) return undefined;
  return failed.name + ' process exited before becoming healthy';
}

export function createFulfillmentHarnessServer(options: {
  application: HarnessApplicationOptions;
  driver: HarnessDriverOptions;
}): FulfillmentHarnessServer {
  const records: ChildRecord[] = [];
  const secrets = [
    options.application.stripeApiKey,
    options.application.stripeWebhookSecret,
    options.application.supplierApiKey,
    options.driver.driverToken,
  ];
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let started = false;
  let ownershipModule: OwnershipModule | undefined;
  let stopped = false;

  async function startProcesses(): Promise<void> {
    try {
      const validated = validateApplicationOptions(options.application, options.driver);
      await assertOwnedRunResources(options.application);
      const owner = await loadOwnershipModule();
      ownershipModule = owner;
      if (stopped) throw new Error('Fulfillment harness server was stopped');
      const redactSensitive = await loadSensitiveRedactor();
      const environments = await loadOwnedApplicationEnvironments(options.application);
      const outputSecrets = [...secrets, ...environments.secrets];
      for (const environment of [environments.api, environments.web]) {
        if (
          Object.values(environment).some(
            (value) => typeof value === 'string' && value.includes(options.driver.driverToken),
          )
        ) {
          throw new Error('Driver credentials cannot enter application processes');
        }
      }

      const apiRoot = path.resolve(__dirname, '../..');
      const repositoryRoot = path.resolve(__dirname, '../../../..');
      const webRoot = path.resolve(repositoryRoot, 'apps', 'web');
      const apiEntry = path.resolve(apiRoot, 'src', 'main.ts');
      const nextCli = path.resolve(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
      const apiRecord = launchProcess(
        'NestJS API',
        ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', apiEntry],
        apiRoot,
        environments.api,
        outputSecrets,
        redactSensitive,
        (child) => registerApplicationProcess(owner, options.application, child),
      );
      records.push(apiRecord);
      await waitForSpawn(apiRecord);
      if (!apiRecord.registered) throw new Error('Fulfillment application process could not be registered to owned run');
      if (stopped) throw new Error('Fulfillment harness server was stopped');

      const webRecord = launchProcess(
        'Next.js frontend',
        [nextCli, 'dev', '--hostname', '127.0.0.1', '--port', String(validated.frontend.port)],
        webRoot,
        environments.web,
        outputSecrets,
        redactSensitive,
        (child) => registerApplicationProcess(owner, options.application, child),
      );
      records.push(webRecord);
      await waitForSpawn(webRecord);
      if (!webRecord.registered) throw new Error('Fulfillment application process could not be registered to owned run');
      if (stopped) throw new Error('Fulfillment harness server was stopped');
      started = true;
    } catch (error) {
      stopped = true;
      try {
        await stopProcesses(records, options.application, ownershipModule);
      } catch {
        throw new Error('Fulfillment application startup failed and owned process cleanup failed');
      }
      if (error instanceof Error) throw error;
      throw new Error('Fulfillment application startup failed');
    }
  }

  return {
    start(): Promise<void> {
      if (stopped) return Promise.reject(new Error('Fulfillment harness server was stopped'));
      if (!startPromise) startPromise = startProcesses();
      return startPromise;
    },
    async waitForHealthy(timeoutMs: number): Promise<void> {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
        throw new RangeError('Health timeout must be a positive bounded integer');
      }
      if (!startPromise) throw new Error('Fulfillment harness server has not started');
      await startPromise;
      if (!started) throw new Error('Fulfillment harness server did not start');
      const apiOrigin = new URL(options.application.apiUrl).origin;
      const frontendOrigin = new URL(options.application.frontendUrl).origin;
      const apiListenerLine =
        'Fulfillment harness API listening at http://127.0.0.1:' + new URL(options.application.apiUrl).port;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const failure = processFailure(records);
        if (failure) throw new Error(failure + '\n' + records.map((record) => record.output).join('\n').slice(-maximumLogCharacters));
        const remaining = deadline - Date.now();
        const [apiReady, frontendReady] = await Promise.all([
          isHealthy(new URL('/health', apiOrigin).toString(), Math.min(requestTimeoutMs, remaining)),
          isHealthy(new URL('/health/upstream', frontendOrigin).toString(), Math.min(requestTimeoutMs, remaining)),
        ]);
        const apiBoundToLoopback = records.some(
          (record) => record.name === 'NestJS API' && record.output.includes(apiListenerLine),
        );
        if (apiReady && frontendReady && apiBoundToLoopback) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(1, deadline - Date.now()))));
      }
      const logs = records.map((record) => record.name + ': ' + record.output).join('\n').slice(-maximumLogCharacters);
      throw new Error('Real Next/Nest health checks did not pass before timeout\n' + logs);
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      stopPromise = (async () => {
        if (startPromise) await startPromise.catch(() => undefined);
        await stopProcesses(records, options.application, ownershipModule);
        started = false;
      })();
      return stopPromise;
    },
  };
}
