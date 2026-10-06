import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import jest from 'jest';

const { runCLI } = jest;

const apiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function listTests(configPath) {
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };

  try {
    const result = await runCLI(
      { $0: 'jest', _: [], config: resolve(apiRoot, configPath), listTests: true, runInBand: true },
      [apiRoot],
    );
    assert.ok(result.results, `Jest returned no result for ${configPath}`);
  } finally {
    process.stdout.write = write;
  }

  const tests = output
    .trim()
    .split(/\r?\n/)
    .filter((path) => /(?:\.spec|\.e2e-spec)\.ts$/.test(path))
    .map((path) => path.replaceAll('\\', '/'));
  assert.ok(tests.length > 0, `Jest selected no tests for ${configPath}`);
  return tests;
}

function assertDisjoint(groups) {
  const owners = new Map();
  for (const [category, tests] of Object.entries(groups)) {
    for (const test of tests) {
      const previous = owners.get(test);
      assert.equal(previous, undefined, `${test} appears in both ${previous} and ${category}`);
      owners.set(test, category);
    }
  }
}

const legacySource = new Set(await listTests('jest.config.json'));
const legacyE2e = new Set(await listTests('test/jest-e2e.json'));
assert.ok(legacySource.size > 0, 'Legacy API unit selection must not be empty.');
assert.ok(legacyE2e.size > 0, 'Legacy API E2E selection must not be empty.');
const legacy = new Set([...legacySource, ...legacyE2e]);
const categories = {
  unit: await listTests('jest-unit.json'),
  contract: await listTests('jest-contract.json'),
  component: await listTests('jest-component.json'),
  integration: await listTests('jest-integration.json'),
  performance: await listTests('jest-performance-unit.json'),
};

assertDisjoint(categories);
const classified = new Set(Object.values(categories).flat());
assert.deepEqual(
  [...classified].sort(),
  [...legacy].sort(),
  'Every legacy API unit and E2E test must appear in exactly one category.',
);

const performanceUnit = new Set(categories.performance);
const performanceE2e = new Set(await listTests('test/jest-e2e-performance.json'));
const optionalPerformance = new Set([
  ...performanceUnit,
  ...performanceE2e,
]);
assertDisjoint({ performanceUnit: [...performanceUnit], performanceE2e: [...performanceE2e] });
assert.deepEqual(
  [...new Set(await listTests('jest-performance.json'))].sort(),
  [...optionalPerformance].sort(),
  'The optional performance aggregate must retain fast and E2E performance specs.',
);

process.stdout.write(`Partition covers ${classified.size} API tests exactly once.\n`);
