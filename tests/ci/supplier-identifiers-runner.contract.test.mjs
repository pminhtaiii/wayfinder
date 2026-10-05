import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');
const webPackage = JSON.parse(readFileSync(resolve(root, 'apps/web/package.json'), 'utf8'));
const migrationHarness = resolve(root, 'tests/ci/supplier-identifiers-migration.e2e.mjs');
const migrationHarnessUrl = pathToFileURL(migrationHarness).href;
const compatibilityScript =
  'tsx --test lib/server/flight-search.spec.ts lib/server/booking-management.spec.ts tests/handoff-checkout-proxy.unit.ts tests/supplier-identity-injection.unit.ts';

test('web compatibility script lists the four existing compatibility tests', () => {
  assert.equal(webPackage.scripts['test:compatibility'], compatibilityScript);
  for (const testPath of [
    'apps/web/lib/server/flight-search.spec.ts',
    'apps/web/lib/server/booking-management.spec.ts',
    'apps/web/tests/handoff-checkout-proxy.unit.ts',
    'apps/web/tests/supplier-identity-injection.unit.ts',
  ]) {
    assert.equal(existsSync(resolve(root, testPath)), true, `${testPath} exists`);
  }
});

test('CI runs compatibility and migration contracts without replacing the pinned workflow contract', () => {
  assert.match(
    workflow,
    /run: node --test tests\/ci\/ci-workflow\.contract\.test\.mjs tests\/ci\/security-change-filter\.test\.mjs/,
  );
  assert.match(
    workflow,
    /node --test tests\/ci\/supplier-identifiers-migration\.contract\.test\.mjs tests\/ci\/supplier-identifiers-runner\.contract\.test\.mjs/,
  );
  assert.match(workflow, /NODE_OPTIONS:\s*--require=\$\{\{ github\.workspace \}\}\/tests\/ci\/node-network-guard\.cjs[\s\S]{0,180}test:compatibility/);
  assert.match(workflow, /pnpm --filter @web\/frontend run test:compatibility/);
});

test('API E2E CI invokes the live migration proof with loopback admin access', () => {
  assert.match(workflow, /node tests\/ci\/supplier-identifiers-migration\.e2e\.mjs/);
  assert.match(
    workflow,
    /T054_ADMIN_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres\?schema=public/,
  );
});

test('migration preflight accepts only a local admin URL and excludes credentials', async () => {
  const { getPreflightSummary } = await import(migrationHarnessUrl);
  const local = getPreflightSummary(
    'postgresql://ci-user:do-not-print@127.0.0.1:5432/postgres?schema=public',
  );

  assert.deepEqual(local, {
    adminDatabase: 'postgres',
    targetDatabases: ['feature029_slice62_fresh', 'feature029_slice62_upgrade'],
  });
  assert.doesNotMatch(JSON.stringify(local), /do-not-print/);
  assert.throws(
    () => getPreflightSummary('postgresql://ci-user:do-not-print@db.example.invalid:5432/postgres'),
    /loopback/,
  );
});
