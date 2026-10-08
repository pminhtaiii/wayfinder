import { expect, test } from '@playwright/test';
import {
  createFulfillmentHarnessServer,
  redactCapturedOutput,
  spawnedChildProcessIds,
  type HarnessApplicationOptions,
  type HarnessDriverOptions,
} from '../../api/test/fulfillment-harness/server';

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
