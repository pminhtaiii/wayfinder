import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const apiRoot = join(repositoryRoot, 'apps', 'api');
const sharedRoot = join(repositoryRoot, 'packages', 'shared');
const lockPath = join(repositoryRoot, '.scratch', 'api-task.lock');
const prismaCli = join(apiRoot, 'node_modules', 'prisma', 'build', 'index.js');
const nestCli = join(apiRoot, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js');
const jestCli = join(apiRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const typescriptCli = join(sharedRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const jestTasks = new Map([
  ['test', []],
  ['test:ci', ['--config', './jest.config.json', '--runInBand']],
  ['test:unit', ['--config', './jest-unit.json', '--runInBand']],
  ['test:contract', ['--config', './jest-contract.json', '--runInBand']],
  ['test:component', ['--config', './jest-component.json', '--runInBand']],
  ['test:integration', ['--config', './jest-integration.json', '--runInBand']],
  ['test:performance:unit', ['--config', './jest-performance-unit.json', '--runInBand']],
  ['test:performance', ['--config', './jest-performance.json', '--runInBand']],
  ['test:watch', ['--watch']],
  ['test:cov', ['--coverage']],
  ['test:e2e', ['--config', './test/jest-e2e.json', '--runInBand']],
  ['test:e2e:performance', ['--config', './test/jest-e2e-performance.json', '--runInBand']],
]);

const isolatedTestTasks = new Set([
  'test',
  'test:ci',
  'test:unit',
  'test:contract',
  'test:component',
  'test:performance:unit',
  'test:watch',
  'test:cov',
  'test:debug',
]);

const usage =
  'Usage: node scripts/ci/run-api-task.mjs <build|start|start:dev|start:debug|start:prod|prisma:generate|test task> [arguments...]';

function reportError(message) {
  process.stderr.write(message + '\n');
}

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(
      name +
        ' is required for API integration tests; set it to the local disposable test service URL.',
    );
  }
  return value;
}

function validateDatabaseUrl(value, allowAppSchema) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must target the local fulfillment_recovery_test database.');
  }

  const schemas = url.searchParams.getAll('schema');
  const validSchema =
    schemas.length === 0 ||
    (allowAppSchema &&
      schemas.length === 1 &&
      (schemas[0] === 'public' || /^fulfillment_recovery_[0-9a-f]{32}$/.test(schemas[0] ?? '')));
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/fulfillment_recovery_test' ||
    !validSchema
  ) {
    throw new Error('DATABASE_URL must target the local fulfillment_recovery_test database.');
  }
  return url;
}

function validateAdminDatabaseUrl(value, applicationUrl) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'FULFILLMENT_HARNESS_ADMIN_DATABASE_URL must be an unscoped local PostgreSQL URL for fulfillment_recovery_test.',
    );
  }

  const applicationPort = Number(applicationUrl.port || 5432);
  const adminPort = Number(url.port || 5432);
  if (
    (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') ||
    url.hostname !== '127.0.0.1' ||
    url.hostname !== applicationUrl.hostname ||
    url.pathname !== '/fulfillment_recovery_test' ||
    url.pathname !== applicationUrl.pathname ||
    adminPort !== applicationPort ||
    url.searchParams.has('schema')
  ) {
    throw new Error(
      'FULFILLMENT_HARNESS_ADMIN_DATABASE_URL must be an unscoped local PostgreSQL URL for fulfillment_recovery_test.',
    );
  }
}

function validateRedisUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'REDIS_URL must target a disposable loopback Redis database with an explicit port and index.',
    );
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
    throw new Error(
      'REDIS_URL must target a disposable loopback Redis database with an explicit port and index.',
    );
  }
}

function validateIntegrationEnvironment(environment) {
  const databaseUrl = validateDatabaseUrl(requiredEnvironment(environment, 'DATABASE_URL'), true);
  const redisUrl = requiredEnvironment(environment, 'REDIS_URL');
  validateRedisUrl(redisUrl);

  const configuredAdminUrl = environment.FULFILLMENT_HARNESS_ADMIN_DATABASE_URL;
  const adminUrl = configuredAdminUrl
    ? configuredAdminUrl
    : (() => {
        const derived = new URL(databaseUrl);
        derived.searchParams.delete('schema');
        return derived.toString();
      })();
  validateAdminDatabaseUrl(adminUrl, databaseUrl);
}

function taskCommands(task, args) {
  const buildShared = { executable: typescriptCli, args: [], cwd: sharedRoot };
  const generatePrisma = { executable: prismaCli, args: ['generate'], cwd: apiRoot };
  if (task === 'prisma:generate') {
    return [{ ...generatePrisma, args: [...generatePrisma.args, ...args] }];
  }
  if (task === 'build') {
    return [
      buildShared,
      generatePrisma,
      { executable: nestCli, args: ['build', ...args], cwd: apiRoot },
    ];
  }
  if (task === 'start:dev' || task === 'dev') {
    return [
      buildShared,
      generatePrisma,
      { executable: nestCli, args: ['start', '--watch', ...args], cwd: apiRoot },
    ];
  }
  if (task === 'start:debug') {
    return [
      buildShared,
      generatePrisma,
      { executable: nestCli, args: ['start', '--debug', '--watch', ...args], cwd: apiRoot },
    ];
  }
  if (task === 'start') {
    return [{ executable: nestCli, args: ['start', ...args], cwd: apiRoot }];
  }
  if (task === 'start:prod') {
    return [{ executable: join(apiRoot, 'dist', 'main.js'), args, cwd: apiRoot }];
  }
  if (task === 'test:debug') {
    return [
      {
        executable: jestCli,
        args: ['--runInBand', ...args],
        cwd: apiRoot,
        nodeArgs: ['--inspect-brk', '-r', 'tsconfig-paths/register', '-r', 'ts-node/register'],
      },
    ];
  }
  const jestArgs = jestTasks.get(task);
  if (jestArgs) {
    return [{ executable: jestCli, args: [...jestArgs, ...args], cwd: apiRoot }];
  }
  throw new Error('Unknown API task: ' + (task || '(missing)') + '. ' + usage);
}

function childEnvironment(task, environment) {
  const childEnv = { ...environment };
  if (isolatedTestTasks.has(task)) {
    for (const key of Object.keys(childEnv)) {
      const normalizedKey = key.toUpperCase();
      if (normalizedKey === 'DUFFEL_MOCK' || normalizedKey === 'DUFFEL_API_URL') {
        delete childEnv[key];
      }
    }
  }
  return childEnv;
}

async function acquireLock(task) {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, 'wx');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      let ownerDescription = '';
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (typeof owner.pid === 'number' && typeof owner.task === 'string') {
          ownerDescription = ` (PID ${owner.pid}, ${owner.task})`;
        }
      } catch {
        // A concurrent process may be writing the owner record; the lock itself is already authoritative.
      }
      throw new Error(
        `API checkout is busy${ownerDescription}. Wait for that task to finish. If it exited unexpectedly, inspect .scratch/api-task.lock and remove it only after confirming no API task is running.`,
      );
    }
    throw new Error('Could not acquire the API checkout lock.');
  }

  try {
    await handle.writeFile(
      JSON.stringify({ token, pid: process.pid, task, startedAt: new Date().toISOString() }),
      'utf8',
    );
    await handle.close();
  } catch {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    throw new Error('Could not record API checkout lock ownership.');
  }

  return async () => {
    let owner;
    try {
      owner = JSON.parse(await readFile(lockPath, 'utf8'));
    } catch {
      throw new Error('Could not verify API checkout lock ownership; leaving the lock in place.');
    }
    if (owner.token !== token) {
      throw new Error('API checkout lock ownership changed; leaving the lock in place.');
    }
    await unlink(lockPath);
  };
}

function signalExitCode(signal) {
  const signalNumber = os.constants.signals?.[signal];
  return typeof signalNumber === 'number' ? 128 + signalNumber : 1;
}

function execute(command, environment, signalState) {
  if (signalState.received) return Promise.resolve({ code: signalExitCode(signalState.received) });
  const nodeArgs = command.nodeArgs ?? [];
  const commandArgs = [...nodeArgs, command.executable, ...command.args];
  let child;
  try {
    child = spawn(process.execPath, commandArgs, {
      cwd: command.cwd,
      env: environment,
      stdio: 'inherit',
      windowsHide: true,
    });
  } catch {
    return Promise.resolve({ code: 1, startupError: true });
  }

  signalState.child = child;

  return new Promise((resolveResult) => {
    let startupError = false;
    child.once('error', () => {
      startupError = true;
    });
    child.once('close', (code, signal) => {
      signalState.child = undefined;
      resolveResult({ code: startupError ? 1 : (code ?? 1), signal, startupError });
    });
  });
}

function forwardSignal(signalState, signal) {
  const child = signalState.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill(signal);
  } catch {
    // Keep the checkout locked until the child closes, even when signal delivery fails.
  }
}

async function run() {
  const [task, ...args] = process.argv.slice(2);
  let commands;
  try {
    commands = taskCommands(task ?? '', args);
    if (task === 'test:integration') validateIntegrationEnvironment(process.env);
  } catch (error) {
    reportError(error instanceof Error ? error.message : 'API task preflight failed.');
    process.exitCode = 1;
    return;
  }

  let releaseLock;
  try {
    releaseLock = await acquireLock(task ?? '');
  } catch (error) {
    reportError(
      error instanceof Error ? error.message : 'Could not acquire the API checkout lock.',
    );
    process.exitCode = 1;
    return;
  }

  const signalState = { received: undefined, child: undefined };
  const signalHandlers = new Map([
    [
      'SIGINT',
      () => {
        signalState.received ??= 'SIGINT';
        forwardSignal(signalState, 'SIGINT');
      },
    ],
    [
      'SIGTERM',
      () => {
        signalState.received ??= 'SIGTERM';
        forwardSignal(signalState, 'SIGTERM');
      },
    ],
  ]);
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);

  let result = { code: 0 };
  try {
    const environment = childEnvironment(task ?? '', process.env);
    for (const command of commands) {
      result = await execute(command, environment, signalState);
      if (result.signal || result.code !== 0 || signalState.received) break;
    }
    if (result.startupError)
      reportError('Could not start the API task child process. Check the installed workspace CLI.');
  } catch {
    result = { code: 1 };
    reportError('API task failed before the child process completed.');
  } finally {
    try {
      await releaseLock();
    } catch (error) {
      reportError(
        error instanceof Error ? error.message : 'Could not release the API checkout lock.',
      );
      if (result.code === 0 && !result.signal) result = { code: 1 };
    }
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
  }

  const signal = result.signal ?? signalState.received;
  if (signal) {
    if (process.platform !== 'win32') {
      try {
        process.kill(process.pid, signal);
      } catch {
        process.exitCode = signalExitCode(signal);
      }
    } else {
      process.exitCode = signalExitCode(signal);
    }
  } else {
    process.exitCode = result.code;
  }
}

await run();
