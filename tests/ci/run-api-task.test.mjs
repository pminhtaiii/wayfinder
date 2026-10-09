import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const runnerSource = resolve(repositoryRoot, 'scripts/ci/run-api-task.mjs');
const fakeCli = `
const fs = require('node:fs');
const record = {
  script: process.argv[1],
  args: process.argv.slice(2),
  env: {
    DUFFEL_MOCK: process.env.DUFFEL_MOCK,
    DUFFEL_API_URL: process.env.DUFFEL_API_URL,
    FEATURE_FLAG_BOOKING_READINESS: process.env.FEATURE_FLAG_BOOKING_READINESS,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    FULFILLMENT_HARNESS_ADMIN_DATABASE_URL: process.env.FULFILLMENT_HARNESS_ADMIN_DATABASE_URL,
  },
  duffelKeys: Object.keys(process.env).filter((key) =>
    ['DUFFEL_MOCK', 'DUFFEL_API_URL'].includes(key.toUpperCase()),
  ),
};
fs.appendFileSync(process.env.API_TASK_LOG, JSON.stringify(record) + '\\n');
const exitCode = process.env.API_TASK_FAIL_ON && process.argv[1].includes(process.env.API_TASK_FAIL_ON)
  ? Number(process.env.API_TASK_EXIT_CODE || 1)
  : 0;
if (process.env.API_TASK_CONTROL_SIGNALS === 'true') {
  const keepAlive = setInterval(() => {}, 1000);
  const failSafe = setTimeout(() => process.exit(2), 10000);
  process.on('SIGINT', () => {
    fs.appendFileSync(process.env.API_TASK_LOG, JSON.stringify({ signal: 'SIGINT' }) + '\\n');
  });
  process.on('SIGTERM', () => {
    fs.appendFileSync(process.env.API_TASK_LOG, JSON.stringify({ signal: 'SIGTERM' }) + '\\n');
    clearInterval(keepAlive);
    clearTimeout(failSafe);
    process.exit(0);
  });
} else if (process.env.API_TASK_RELEASE_FILE) {
  const releasePoll = setInterval(() => {
    if (fs.existsSync(process.env.API_TASK_RELEASE_FILE)) {
      clearInterval(releasePoll);
      clearTimeout(failSafe);
      process.exit(exitCode);
    }
  }, 20);
  const failSafe = setTimeout(() => process.exit(2), 10000);
} else {
  setTimeout(() => process.exit(exitCode), Number(process.env.API_TASK_DELAY_MS || 0));
}
`;

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'api-task-runner-'));
  t.after(async () => rm(root, { recursive: true, force: true }));

  const runnerPath = join(root, 'scripts', 'ci', 'run-api-task.mjs');
  const apiRoot = join(root, 'apps', 'api');
  const cliPaths = [
    'packages/shared/node_modules/typescript/bin/tsc',
    'apps/api/node_modules/prisma/build/index.js',
    'apps/api/node_modules/@nestjs/cli/bin/nest.js',
    'apps/api/node_modules/jest/bin/jest.js',
  ];
  await mkdir(dirname(runnerPath), { recursive: true });
  await copyFile(runnerSource, runnerPath);
  for (const cliPath of cliPaths) {
    const target = join(root, cliPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, fakeCli);
  }

  return { root, runnerPath, apiRoot, logPath: join(root, 'child-log.ndjson') };
}

function startRunner(fixture, command, args = [], overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      [
        'DATABASE_URL',
        'REDIS_URL',
        'FULFILLMENT_HARNESS_ADMIN_DATABASE_URL',
        'DUFFEL_MOCK',
        'DUFFEL_API_URL',
      ].includes(normalizedKey) ||
      normalizedKey.startsWith('FEATURE_FLAG_') ||
      normalizedKey.startsWith('API_TASK_')
    ) {
      delete env[key];
    }
  }
  Object.assign(env, overrides);
  env.API_TASK_LOG = fixture.logPath;
  const child = spawn(process.execPath, [fixture.runnerPath, command, ...args], {
    cwd: fixture.apiRoot,
    env,
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolveResult) => {
    child.once('close', (code, signal) => resolveResult({ code, signal, stdout, stderr }));
  });
  return { child, result };
}

async function readLog(logPath) {
  const contents = await readFile(logPath, 'utf8');
  return contents
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
}

async function waitForLog(logPath) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(logPath, 'utf8');
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  assert.fail('API task child did not start');
}

async function waitForSignalRecord(logPath, signal) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const records = await readLog(logPath);
      if (records.some((record) => record.signal === signal)) return;
    } catch {
      // Wait for the child process to append its signal record.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.fail(`API task child did not receive ${signal}`);
}

const validDatabaseUrl =
  'postgresql://ci-user:never-print-this@127.0.0.1:5432/fulfillment_recovery_test?schema=public';
const validRedisUrl = 'redis://127.0.0.1:6379/0';

test('component tests clear inherited Duffel overrides and forward Jest arguments', async (t) => {
  const fixture = await createFixture(t);
  const forwardedArgs = [
    '--runTestsByPath',
    'src/example.spec.ts',
    '--testNamePattern=keeps flags',
  ];
  const result = await startRunner(fixture, 'test:component', forwardedArgs, {
    duffel_mock: 'true',
    dUfFeL_aPi_Url: 'http://untrusted.example.invalid',
    FEATURE_FLAG_BOOKING_READINESS: 'true',
  }).result;

  assert.equal(result.code, 0, result.stderr);
  const [record] = await readLog(fixture.logPath);
  assert.deepEqual(record.args, [
    '--config',
    './jest-component.json',
    '--runInBand',
    ...forwardedArgs,
  ]);
  assert.equal(record.env.DUFFEL_MOCK, undefined);
  assert.equal(record.env.DUFFEL_API_URL, undefined);
  assert.deepEqual(record.duffelKeys, []);
  assert.equal(record.env.FEATURE_FLAG_BOOKING_READINESS, 'true');
  assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), false);
});

test('integration preflight rejects missing or unsafe storage before launching Jest', async (t) => {
  const fixture = await createFixture(t);
  const cases = [
    {
      name: 'missing DATABASE_URL',
      overrides: { REDIS_URL: validRedisUrl },
      message: /DATABASE_URL is required/,
      secret: undefined,
    },
    {
      name: 'remote database host',
      overrides: {
        DATABASE_URL:
          'postgresql://ci-user:database-secret@db.example.invalid:5432/fulfillment_recovery_test?schema=public',
        REDIS_URL: validRedisUrl,
      },
      message: /DATABASE_URL must target the local fulfillment_recovery_test database/,
      secret: 'database-secret',
    },
    {
      name: 'wrong database name',
      overrides: {
        DATABASE_URL: 'postgresql://ci-user:database-secret@127.0.0.1:5432/postgres',
        REDIS_URL: validRedisUrl,
      },
      message: /DATABASE_URL must target the local fulfillment_recovery_test database/,
      secret: 'database-secret',
    },
    {
      name: 'missing REDIS_URL',
      overrides: { DATABASE_URL: validDatabaseUrl },
      message: /REDIS_URL is required/,
      secret: undefined,
    },
    {
      name: 'remote Redis service',
      overrides: {
        DATABASE_URL: validDatabaseUrl,
        REDIS_URL: 'redis://redis.example.invalid:6379/0',
      },
      message: /REDIS_URL must target a disposable loopback Redis database/,
      secret: undefined,
    },
    {
      name: 'scoped admin URL',
      overrides: {
        DATABASE_URL: validDatabaseUrl,
        REDIS_URL: validRedisUrl,
        FULFILLMENT_HARNESS_ADMIN_DATABASE_URL:
          'postgresql://ci-user:admin-secret@127.0.0.1:5432/fulfillment_recovery_test?schema=public',
      },
      message: /FULFILLMENT_HARNESS_ADMIN_DATABASE_URL must be an unscoped local PostgreSQL URL/,
      secret: 'admin-secret',
    },
    {
      name: 'admin URL on a different port',
      overrides: {
        DATABASE_URL: validDatabaseUrl,
        REDIS_URL: validRedisUrl,
        FULFILLMENT_HARNESS_ADMIN_DATABASE_URL:
          'postgres://ci-user:admin-secret@127.0.0.1:5433/fulfillment_recovery_test',
      },
      message: /FULFILLMENT_HARNESS_ADMIN_DATABASE_URL must be an unscoped local PostgreSQL URL/,
      secret: 'admin-secret',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await startRunner(fixture, 'test:integration', [], scenario.overrides).result;
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, scenario.message);
      if (scenario.secret) assert.equal(result.stderr.includes(scenario.secret), false);
      assert.equal(await exists(fixture.logPath), false, 'Jest must not start for rejected URLs');
      await rm(fixture.logPath, { force: true });
    });
  }
});

test('integration keeps its app URL verbatim and validates the local Redis target', async (t) => {
  const fixture = await createFixture(t);
  const result = await startRunner(
    fixture,
    'test:integration',
    ['--runTestsByPath', 'test/example.e2e-spec.ts'],
    {
      DATABASE_URL: validDatabaseUrl,
      REDIS_URL: validRedisUrl,
    },
  ).result;

  assert.equal(result.code, 0, result.stderr);
  const [record] = await readLog(fixture.logPath);
  assert.deepEqual(record.args, [
    '--config',
    './jest-integration.json',
    '--runInBand',
    '--runTestsByPath',
    'test/example.e2e-spec.ts',
  ]);
  assert.equal(record.env.DATABASE_URL, validDatabaseUrl);
  assert.equal(record.env.REDIS_URL, validRedisUrl);
});

test('integration accepts an unscoped app URL and PostgreSQL protocol aliases on one endpoint', async (t) => {
  const fixture = await createFixture(t);
  const applicationUrl =
    'postgresql://app-user:app-secret@127.0.0.1:5432/fulfillment_recovery_test';
  const adminUrl = 'postgres://admin-user:admin-secret@127.0.0.1/fulfillment_recovery_test';
  const result = await startRunner(fixture, 'test:integration', [], {
    DATABASE_URL: applicationUrl,
    REDIS_URL: validRedisUrl,
    FULFILLMENT_HARNESS_ADMIN_DATABASE_URL: adminUrl,
  }).result;

  assert.equal(result.code, 0, result.stderr);
  const [record] = await readLog(fixture.logPath);
  assert.equal(record.env.DATABASE_URL, applicationUrl);
  assert.equal(record.env.FULFILLMENT_HARNESS_ADMIN_DATABASE_URL, adminUrl);
  assert.equal(result.stdout.includes('app-secret'), false);
  assert.equal(result.stderr.includes('admin-secret'), false);
});

test('an existing checkout lock blocks build and test children', async (t) => {
  const fixture = await createFixture(t);
  const scratch = join(fixture.root, '.scratch');
  await mkdir(scratch, { recursive: true });
  await writeFile(
    join(scratch, 'api-task.lock'),
    JSON.stringify({ pid: 123, command: 'another task' }),
  );

  for (const command of ['build', 'test:unit']) {
    const result = await startRunner(fixture, command).result;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /API checkout is busy/);
    assert.equal(await exists(fixture.logPath), false, `${command} child must not start`);
  }
});

test('build commands stop at the first child failure and remove their own lock', async (t) => {
  const fixture = await createFixture(t);
  const result = await startRunner(fixture, 'build', [], {
    API_TASK_FAIL_ON: 'tsc',
    API_TASK_EXIT_CODE: '23',
  }).result;

  assert.equal(result.code, 23, result.stderr);
  const records = await readLog(fixture.logPath);
  assert.equal(records.length, 1, 'Prisma and Nest must not run after shared types fail');
  assert.equal(records[0].script.replaceAll('\\', '/').endsWith('typescript/bin/tsc'), true);
  assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), false);
});

test('a child startup failure also removes the owned lock', async (t) => {
  const fixture = await createFixture(t);
  await unlink(join(fixture.apiRoot, 'node_modules', '@nestjs', 'cli', 'bin', 'nest.js'));
  const result = await startRunner(fixture, 'start').result;

  assert.equal(result.code, 1);
  assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), false);
});

test('the checkout lock stays held until the child closes', async (t) => {
  const fixture = await createFixture(t);
  const releasePath = join(fixture.root, 'release-child');
  let first;
  t.after(async () => {
    await writeFile(releasePath, 'release').catch(() => {});
    if (first) await first.result;
  });
  first = startRunner(fixture, 'test:component', [], { API_TASK_RELEASE_FILE: releasePath });
  await waitForLog(fixture.logPath);

  const second = await startRunner(fixture, 'test:unit').result;
  assert.equal(second.code, 1, second.stderr);
  assert.match(second.stderr, /API checkout is busy/);
  assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), true);

  await writeFile(releasePath, 'release');
  const firstResult = await first.result;
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), false);
});

test(
  'a later termination signal still reaches a child after SIGINT',
  { skip: process.platform === 'win32' },
  async (t) => {
    const fixture = await createFixture(t);
    let task;
    t.after(async () => {
      if (!task) return;
      if (task.child.exitCode === null && task.child.signalCode === null)
        task.child.kill('SIGTERM');
      await task.result;
    });
    task = startRunner(fixture, 'test:component', [], { API_TASK_CONTROL_SIGNALS: 'true' });
    await waitForLog(fixture.logPath);

    assert.equal(task.child.kill('SIGINT'), true);
    await waitForSignalRecord(fixture.logPath, 'SIGINT');
    assert.equal(task.child.kill('SIGTERM'), true);

    const result = await task.result;
    assert.equal(result.signal, 'SIGINT');
    const records = await readLog(fixture.logPath);
    assert.equal(
      records.some((record) => record.signal === 'SIGTERM'),
      true,
    );
    assert.equal(await exists(join(fixture.root, '.scratch', 'api-task.lock')), false);
  },
);

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}
