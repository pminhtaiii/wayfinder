import { expect, test } from '@playwright/test';
import {
  startFulfillmentHarnessDriver,
  type FulfillmentHarnessDriverServer,
} from '../../api/test/fulfillment-harness/bootstrap';
import { installFulfillmentStripeClient } from './fixtures/fulfillment-stripe-client';
import {
  createFulfillmentHarnessServer,
  redactCapturedOutput,
  spawnedChildProcessIds,
  type HarnessApplicationOptions,
  type HarnessDriverOptions,
  type FulfillmentHarnessServer,
} from '../../api/test/fulfillment-harness/server';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const application: HarnessApplicationOptions = {
  runId: 'run-test-1',
  apiUrl: 'http://127.0.0.1:4111',
  frontendUrl: 'http://127.0.0.1:4112',
  databaseUrl:
    'postgresql://postgres:postgres@127.0.0.1:5432/fulfillment_recovery_test?schema=fulfillment_recovery_11111111111111111111111111111111',
  redisUrl: 'redis://127.0.0.1:4103/0',
  redisPrefix: 'fulfillment:run-test-1:',
  stripeOrigin: 'https://api.stripe.com',
  stripeApiKey: 'sk_test_run_test_1',
  stripeWebhookSecret: 'whsec_run_test_1',
  supplierOrigin: 'http://127.0.0.1:4190',
  supplierApiKey: 'duffel_test_run_test_1',
};

const driver: HarnessDriverOptions = {
  runId: 'run-test-1',
  loopbackOrigin: 'http://127.0.0.1:4191',
  driverToken: 'driver_test_1',
};

test('rejects a public provider origin before spawning application processes', async () => {
  const before = spawnedChildProcessIds();
  const server = createFulfillmentHarnessServer({ application, driver });

  await expect(server.start()).rejects.toThrow(/loopback/i);
  expect(spawnedChildProcessIds()).toEqual(before);
});

function applicationWith(
  overrides: Partial<HarnessApplicationOptions> = {},
): HarnessApplicationOptions {
  return {
    ...application,
    stripeOrigin: 'http://127.0.0.1:4192',
    ...overrides,
  };
}

async function expectRejectedBeforeSpawn(
  applicationOptions: HarnessApplicationOptions,
  driverOptions: HarnessDriverOptions,
  expected: RegExp,
): Promise<void> {
  const before = spawnedChildProcessIds();
  const server = createFulfillmentHarnessServer({
    application: applicationOptions,
    driver: driverOptions,
  });
  try {
    await expect(server.start()).rejects.toThrow(expected);
  } finally {
    await server.stop();
  }
  expect(spawnedChildProcessIds()).toEqual(before);
}

test('rejects an unexpected database target before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({
      databaseUrl:
        'postgresql://postgres:postgres@127.0.0.1:5432/flight_booking?schema=fulfillment_recovery_11111111111111111111111111111111',
    }),
    driver,
    /database/i,
  );
});

test('rejects a missing generated run schema before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({
      databaseUrl: 'postgresql://postgres:postgres@127.0.0.1:5432/fulfillment_recovery_test',
    }),
    driver,
    /schema/i,
  );
});

test('rejects a non-loopback Redis URL before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({ redisUrl: 'redis://10.0.0.8:4103/0' }),
    driver,
    /loopback/i,
  );
});

test('rejects a Redis prefix that does not identify the run before spawning', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({ redisPrefix: 'fulfillment:run-other-1:' }),
    driver,
    /prefix/i,
  );
});

test('rejects a public supplier origin before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({ supplierOrigin: 'https://api.duffel.com' }),
    driver,
    /loopback/i,
  );
});

test('rejects production Stripe and supplier keys before spawning', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith({ stripeApiKey: 'sk_live_production' }),
    driver,
    /test-only/i,
  );
  await expectRejectedBeforeSpawn(
    applicationWith({ supplierApiKey: 'duffel_live_production' }),
    driver,
    /test-only/i,
  );
});

test('rejects a live Stripe publishable key before spawning application processes', async () => {
  const contaminated = applicationWith();
  Reflect.set(contaminated, 'stripePublishableKey', 'pk_live_production');
  await expectRejectedBeforeSpawn(contaminated, driver, /test-only/i);
});

test('rejects a driver token embedded in the Stripe publishable key before spawning', async () => {
  const contaminated = applicationWith();
  Reflect.set(contaminated, 'stripePublishableKey', 'pk_test_' + driver.driverToken);
  await expectRejectedBeforeSpawn(contaminated, driver, /driver credentials/i);
});

test('rejects a driver token in application options before spawning', async () => {
  const contaminated = applicationWith();
  Reflect.set(contaminated, 'driverToken', driver.driverToken);
  await expectRejectedBeforeSpawn(contaminated, driver, /driver credentials/i);
});

test('rejects a mismatched driver run ID before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith(),
    { ...driver, runId: 'run-other-1' },
    /run IDs/i,
  );
});

test('rejects duplicate application ports before spawning processes', async () => {
  const options = applicationWith();
  await expectRejectedBeforeSpawn(
    { ...options, frontendUrl: options.apiUrl },
    driver,
    /distinct owned ports/i,
  );
});

test('rejects a public driver origin before spawning application processes', async () => {
  await expectRejectedBeforeSpawn(
    applicationWith(),
    { ...driver, loopbackOrigin: 'http://driver.example:4191' },
    /loopback/i,
  );
});

test('rejects resources without an allocation owner before spawning', async () => {
  await expectRejectedBeforeSpawn(applicationWith(), driver, /ownership|owned/i);
});

test('rejects a driver token embedded in an application URL before spawning', async () => {
  const databaseUrl =
    application.databaseUrl + '&driver_token=' + encodeURIComponent(driver.driverToken);
  await expectRejectedBeforeSpawn(
    applicationWith({ databaseUrl }),
    driver,
    /driver credentials/i,
  );
});

test('redacts captured application output with the centralized sanitizer', async () => {
  const applicationSecret = 'app_secret_canary_20261008';
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature';
  const password = 'Password-Canary-20261008';
  const passport = 'P1234567';
  const diagnostic =
    'Authorization: Bearer ' +
    jwt +
    '; runtime=' +
    applicationSecret +
    '; {"password":"' +
    password +
    '","passportNumber":"' +
    passport +
    '"}; card 4111 1111 1111 1111';

  const sanitized = await redactCapturedOutput(diagnostic, [applicationSecret]);

  for (const canary of [applicationSecret, jwt, password, passport, '4111 1111 1111 1111']) {
    expect(sanitized).not.toContain(canary);
  }
  expect(sanitized).toContain('[redacted]');
});

test('starts real owner-allocated apps and tears them down through the run-scoped driver', async ({ page }) => {
  test.setTimeout(180_000);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the T016 real-app smoke');
  let adminDatabaseUrl = process.env.FULFILLMENT_HARNESS_ADMIN_DATABASE_URL;
  if (!adminDatabaseUrl) {
    const fallbackUrl = new URL(databaseUrl);
    fallbackUrl.pathname = '/fulfillment_recovery_test';
    fallbackUrl.searchParams.delete('schema');
    adminDatabaseUrl = fallbackUrl.toString();
  }

  const initialProcessIds = spawnedChildProcessIds();
  let driverServer: FulfillmentHarnessDriverServer | undefined;
  let applicationServer: FulfillmentHarnessServer | undefined;
  let runId: string | undefined;
  let driverTeardownCompleted = false;

  try {
    const owner = await startFulfillmentHarnessDriver({
      databaseUrl: adminDatabaseUrl,
      bindAddress: '127.0.0.1',
    });
    driverServer = owner;
    const allocation = await owner.driver.allocate({
      scenario: 't016-real-startup',
      seed: 'startup-' + Date.now(),
      startTime: new Date().toISOString(),
    });
    runId = allocation.runId;
    const applicationOptions = owner.applicationOptions(allocation.runId);
    const applicationEnvironment = owner.applicationEnvironment(allocation.runId);
    const publishableKey = applicationOptions.stripePublishableKey;
    if (!publishableKey) throw new Error('The run allocation did not include a Stripe browser key');

    expect(allocation.runId).toMatch(/^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(applicationOptions.runId).toBe(allocation.runId);
    expect(publishableKey).toBe(allocation.applicationCredentials.stripePublishableKey);
    expect(applicationEnvironment.api['FULFILLMENT_HARNESS_RUN_ID']).toBe(allocation.runId);
    expect(applicationEnvironment.api['NODE_ENV']).toBe('test');
    expect(applicationEnvironment.web['NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY']).toBe(publishableKey);
    const applicationValues = [
      ...Object.values(applicationEnvironment.api),
      ...Object.values(applicationEnvironment.web),
    ];
    expect(
      applicationValues.some(
        (value) => typeof value === 'string' && value.includes(allocation.driverToken),
      ),
    ).toBe(false);

    const appServer = createFulfillmentHarnessServer({
      application: applicationOptions,
      driver: {
        runId: allocation.runId,
        loopbackOrigin: owner.origin,
        driverToken: allocation.driverToken,
      },
    });
    applicationServer = appServer;
    await Promise.all([appServer.start(), appServer.start()]);
    await appServer.waitForHealthy(180_000);
    const activeProcessIds = spawnedChildProcessIds()
      .filter((processId) => !initialProcessIds.includes(processId))
      .sort((left, right) => left - right);
    expect(activeProcessIds).toHaveLength(2);

    const apiHealthResponse = await fetch(new URL('/health', applicationOptions.apiUrl).toString());
    expect(apiHealthResponse.status).toBe(200);
    const apiHealth: unknown = await apiHealthResponse.json();
    expect(apiHealth).toMatchObject({
      status: 'ok',
      dependencies: { database: 'up', redis: 'up' },
    });

    const healthResponse = await page.goto(new URL('/health/upstream', applicationOptions.frontendUrl).toString());
    expect(healthResponse?.status()).toBe(200);
    const health: unknown = healthResponse ? await healthResponse.json() : null;
    expect(health).toEqual({ status: 'ok', upstream: 'up' });

    const browserRequests: string[] = [];
    page.on('request', (request) => {
      browserRequests.push([request.method(), request.url(), request.postData() ?? ''].join(' '));
    });
    await page.setContent('<main id="fulfillment-stripe-fixture"></main>');
    await installFulfillmentStripeClient(page, applicationOptions.stripeOrigin, publishableKey);
    const fixtureAcceptedAllocatedKey = await page.evaluate((key) => {
      const factory: unknown = Reflect.get(window, 'Stripe');
      if (typeof factory !== 'function') return false;
      try {
        Reflect.apply(factory, window, [key]);
        return true;
      } catch {
        return false;
      }
    }, publishableKey);
    expect(fixtureAcceptedAllocatedKey).toBe(true);
    expect(browserRequests.join('\n')).not.toContain(allocation.driverToken);
    expect(await page.locator('body').innerText()).not.toContain(allocation.driverToken);

    const schemaName = new URL(applicationOptions.databaseUrl).searchParams.get('schema');
    if (!schemaName) throw new Error('The run allocation did not include its owned schema');
    const teardownResponse = await fetch(
      owner.origin + '/driver/runs/' + encodeURIComponent(allocation.runId),
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + allocation.driverToken },
      },
    );
    expect(teardownResponse.status).toBe(200);
    const cleanup: unknown = await teardownResponse.json();
    if (!isRecord(cleanup)) throw new Error('Run teardown returned an invalid report');
    const cleanupRunId = cleanup['runId'];
    const droppedSchema = cleanup['droppedSchema'];
    const removedRedisPrefix = cleanup['removedRedisPrefix'];
    const leakedResourceCount = cleanup['leakedResourceCount'];
    const rawTerminatedProcessIds = cleanup['terminatedProcessIds'];
    if (
      typeof cleanupRunId !== 'string' ||
      typeof droppedSchema !== 'string' ||
      typeof removedRedisPrefix !== 'string' ||
      typeof leakedResourceCount !== 'number' ||
      !Array.isArray(rawTerminatedProcessIds)
    ) {
      throw new Error('Run teardown returned an invalid report');
    }
    const terminatedProcessIds: number[] = [];
    for (const processId of rawTerminatedProcessIds) {
      if (typeof processId !== 'number') throw new Error('Run teardown returned an invalid process ID');
      terminatedProcessIds.push(processId);
    }
    driverTeardownCompleted = true;
    expect(cleanupRunId).toBe(allocation.runId);
    expect([...terminatedProcessIds].sort((left, right) => left - right)).toEqual(activeProcessIds);
    expect(droppedSchema).toBe(schemaName);
    expect(removedRedisPrefix).toBe(applicationOptions.redisPrefix);
    expect(leakedResourceCount).toBe(0);

    await appServer.stop();
    expect(spawnedChildProcessIds().sort((left, right) => left - right)).toEqual(
      [...initialProcessIds].sort((left, right) => left - right),
    );
    await expect(appServer.start()).rejects.toThrow(/stopped/i);
  } finally {
    try {
      if (applicationServer) await applicationServer.stop();
    } finally {
      if (driverServer) {
        try {
          if (runId && !driverTeardownCompleted) await driverServer.driver.teardown(runId);
        } finally {
          await driverServer.close();
        }
      }
    }
  }
});
