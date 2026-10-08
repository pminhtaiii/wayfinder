import { randomBytes } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type HarnessApplicationOptions = {
  runId: string;
  apiUrl: string;
  frontendUrl: string;
  databaseUrl: string;
  redisUrl: string;
  redisPrefix: string;
  stripeOrigin: string;
  stripeApiKey: string;
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
};

type OwnershipModule = {
  assertOwnedRunResources(application: HarnessApplicationOptions): Promise<void>;
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
  return isRecord(value) && typeof value['assertOwnedRunResources'] === 'function';
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
  if (!/^whsec_[A-Za-z0-9_-]+$/.test(application.stripeWebhookSecret)) {
    throw new Error('Stripe webhook signing secret is malformed');
  }
  if (!/^duffel_test_[A-Za-z0-9_-]+$/.test(application.supplierApiKey)) {
    throw new Error('Supplier simulator key must be test-only');
  }

  for (const [name, value] of Object.entries(application)) {
    if (name.toLowerCase().includes('driver') || value === driver.driverToken) {
      throw new Error('Driver credentials cannot be included in application options');
    }
  }
  return { api, frontend, redisPort };
}

async function assertOwnedRunResources(application: HarnessApplicationOptions): Promise<void> {
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
  try {
    await loaded.assertOwnedRunResources(application);
  } catch {
    throw new Error('Fulfillment run resources are not owned by this run');
  }
}

function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

function runtimeEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  const root = path.resolve(__dirname, '../../../..');
  const guardPath = path.resolve(root, 'tests', 'ci', 'node-network-guard.cjs').replace(/\\/g, '/');
  environment.NODE_OPTIONS = '--require="' + guardPath + '"';
  for (const [name, value] of Object.entries(values)) environment[name] = value;
  return environment;
}

function applicationEnvironments(application: HarnessApplicationOptions): {
  api: NodeJS.ProcessEnv;
  web: NodeJS.ProcessEnv;
} {
  const jwtSecret = randomSecret();
  const apiValues: Record<string, string> = {
    NODE_ENV: 'test',
    CI: 'true',
    PORT: String(new URL(application.apiUrl).port),
    DATABASE_URL: application.databaseUrl,
    REDIS_URL: application.redisUrl,
    REDIS_KEY_PREFIX: application.redisPrefix,
    STRIPE_API_URL: application.stripeOrigin,
    STRIPE_SECRET_KEY: application.stripeApiKey,
    STRIPE_WEBHOOK_SECRET: application.stripeWebhookSecret,
    DUFFEL_API_URL: application.supplierOrigin,
    DUFFEL_ACCESS_TOKEN: application.supplierApiKey,
    JWT_SECRET: jwtSecret,
    AGENT_SERVICE_API_KEY: randomSecret(),
    CLAIM_TOKEN_SECRET: randomSecret(),
    ATTESTATION_SECRET: randomSecret(),
    CHAT_HANDOFF_SECRET: randomSecret(),
    CHAT_ENCRYPTION_KEY: randomSecret(),
    ENCRYPTION_KEY: randomSecret(),
    FRONTEND_URL: application.frontendUrl,
    FEATURE_FLAG_FULFILLMENT_RECOVERY: 'false',
  };
  const webValues: Record<string, string> = {
    NODE_ENV: 'test',
    CI: 'true',
    NEXTAUTH_SECRET: jwtSecret,
    NEXTAUTH_URL: application.frontendUrl,
    API_URL: application.apiUrl,
    NEXT_PUBLIC_API_URL: application.apiUrl,
  };
  return { api: runtimeEnvironment(apiValues), web: runtimeEnvironment(webValues) };
}

function redact(value: string, secrets: readonly string[]): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
  }
  return safe
    .replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bpk_(?:live|test)_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bwhsec_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/\bduffel_(?:live|test)_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/authorization\s*:\s*bearer\s+[^\s,]+/gi, 'authorization: Bearer [redacted]')
    .replace(/client_secret(?:=|:)[^\s&]+/gi, 'client_secret=[redacted]');
}

function appendOutput(record: ChildRecord, chunk: unknown, secrets: readonly string[]): void {
  const value = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  record.output = (record.output + redact(value, secrets)).slice(-maximumLogCharacters);
}

function launchProcess(
  name: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  secrets: readonly string[],
): ChildRecord {
  const child = spawn(process.execPath, args, {
    cwd,
    env: environment,
    shell: false,
    stdio: 'pipe',
    windowsHide: true,
  });
  const record: ChildRecord = { name, child, output: '' };
  child.stdout?.on('data', (chunk: unknown) => appendOutput(record, chunk, secrets));
  child.stderr?.on('data', (chunk: unknown) => appendOutput(record, chunk, secrets));
  child.once('spawn', () => {
    if (child.pid) spawnedProcessIds.add(child.pid);
  });
  return record;
}

function waitForSpawn(record: ChildRecord): Promise<void> {
  const child = record.child;
  if (child.pid) return Promise.resolve();
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

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
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

function killRecordedProcess(record: ChildRecord, force: boolean): void {
  const pid = record.child.pid;
  if (!pid || record.child.exitCode !== null || record.child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    record.child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}

async function stopProcesses(records: ChildRecord[]): Promise<void> {
  let failed = false;
  for (const record of [...records].reverse()) {
    if (record.child.exitCode !== null || record.child.signalCode !== null) continue;
    killRecordedProcess(record, false);
    await waitForClose(record.child, 5000);
    if (record.child.exitCode === null && record.child.signalCode === null) {
      killRecordedProcess(record, true);
      await waitForClose(record.child, 1000);
    }
    if (record.child.exitCode === null && record.child.signalCode === null) failed = true;
  }
  records.length = 0;
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
  const failed = records.find((record) => record.child.exitCode !== null || record.child.signalCode !== null);
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
  let stopped = false;

  async function startProcesses(): Promise<void> {
    try {
      const validated = validateApplicationOptions(options.application, options.driver);
      await assertOwnedRunResources(options.application);
      if (stopped) throw new Error('Fulfillment harness server was stopped');
      const environments = applicationEnvironments(options.application);
      for (const environment of [environments.api, environments.web]) {
        if (Object.values(environment).includes(options.driver.driverToken)) {
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
        secrets,
      );
      records.push(apiRecord);
      await waitForSpawn(apiRecord);
      if (stopped) throw new Error('Fulfillment harness server was stopped');

      const webRecord = launchProcess(
        'Next.js frontend',
        [nextCli, 'dev', '--hostname', '127.0.0.1', '--port', String(validated.frontend.port)],
        webRoot,
        environments.web,
        secrets,
      );
      records.push(webRecord);
      await waitForSpawn(webRecord);
      if (stopped) throw new Error('Fulfillment harness server was stopped');
      started = true;
    } catch (error) {
      stopped = true;
      try {
        await stopProcesses(records);
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
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const failure = processFailure(records);
        if (failure) throw new Error(failure + '\n' + records.map((record) => record.output).join('\n').slice(-maximumLogCharacters));
        const remaining = deadline - Date.now();
        const [apiReady, frontendReady] = await Promise.all([
          isHealthy(new URL('/health', apiOrigin).toString(), Math.min(requestTimeoutMs, remaining)),
          isHealthy(new URL('/health/upstream', frontendOrigin).toString(), Math.min(requestTimeoutMs, remaining)),
        ]);
        if (apiReady && frontendReady) return;
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
        await stopProcesses(records);
        started = false;
      })();
      return stopPromise;
    },
  };
}
