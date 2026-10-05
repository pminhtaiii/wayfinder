import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateCiStatus, SERVICE_CHAINS } from '../../scripts/ci/evaluate-ci-status.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const evaluatorPath = resolve(root, 'scripts/ci/evaluate-ci-status.mjs');
const SMOKE_JOB = 'smoke-and-sanity';

function flatResults({ api, web, agent, smoke }) {
  const changes = { api, web, agent, security: 'false' };
  const jobs = Object.fromEntries(
    Object.entries(SERVICE_CHAINS).flatMap(([service, chain]) =>
      chain.map((job) => [job, changes[service] === 'true' ? 'success' : 'skipped']),
    ),
  );
  return {
    ...changes,
    'detect-changes': 'success',
    ...jobs,
    [SMOKE_JOB]: smoke,
  };
}

function nestedResults(flat) {
  const { api, web, agent, security, ...jobs } = flat;
  return { outputs: { api, web, agent, security }, jobs };
}

// These expectations are hand-derived from the aggregate contract: only the
// all-false routing row skips smoke-and-sanity; every other row requires success.
const validRows = [
  { name: 'no domain changes', api: 'false', web: 'false', agent: 'false', smoke: 'skipped' },
  { name: 'API only', api: 'true', web: 'false', agent: 'false', smoke: 'success' },
  { name: 'Web only', api: 'false', web: 'true', agent: 'false', smoke: 'success' },
  { name: 'Agent only', api: 'false', web: 'false', agent: 'true', smoke: 'success' },
  { name: 'API and Web', api: 'true', web: 'true', agent: 'false', smoke: 'success' },
  { name: 'API and Agent', api: 'true', web: 'false', agent: 'true', smoke: 'success' },
  { name: 'Web and Agent', api: 'false', web: 'true', agent: 'true', smoke: 'success' },
  { name: 'Compose-only routing', api: 'true', web: 'true', agent: 'true', smoke: 'success' },
];

function withoutSmoke(results) {
  const { [SMOKE_JOB]: _ignored, ...without } = results;
  return without;
}

test('aggregate truth table accepts the one valid smoke-and-sanity conclusion per routing row', () => {
  for (const row of validRows) {
    assert.equal(evaluateCiStatus(flatResults(row)).passed, true, row.name);
  }
});

test('changed-domain rows reject every non-success smoke-and-sanity conclusion', () => {
  for (const row of validRows.filter((row) => row.smoke === 'success')) {
    for (const smoke of ['failure', 'cancelled', 'skipped']) {
      assert.equal(
        evaluateCiStatus(flatResults({ ...row, smoke })).passed,
        false,
        `${row.name}: ${SMOKE_JOB}=${smoke} must fail`,
      );
    }
    assert.equal(
      evaluateCiStatus(withoutSmoke(flatResults(row))).passed,
      false,
      `${row.name}: missing ${SMOKE_JOB} must fail`,
    );
  }
});

test('all-false routing rejects every non-skipped smoke-and-sanity conclusion', () => {
  const allFalse = validRows[0];
  for (const smoke of ['success', 'failure', 'cancelled']) {
    assert.equal(
      evaluateCiStatus(flatResults({ ...allFalse, smoke })).passed,
      false,
      `all-false: ${SMOKE_JOB}=${smoke} must fail`,
    );
  }
  assert.equal(
    evaluateCiStatus(withoutSmoke(flatResults(allFalse))).passed,
    false,
    `all-false: missing ${SMOKE_JOB} must fail`,
  );
});

test('applicable prerequisite failure or cancellation cannot be masked by smoke success', () => {
  const changedRows = validRows.filter((row) => row.smoke === 'success');
  for (const row of changedRows) {
    const applicableJob =
      row.api === 'true' ? 'api-gate' : row.web === 'true' ? 'web-gate' : 'agent-gate';
    for (const conclusion of ['failure', 'cancelled']) {
      assert.equal(
        evaluateCiStatus({ ...flatResults(row), [applicableJob]: conclusion }).passed,
        false,
        `${row.name}: ${applicableJob}=${conclusion} cannot be masked by ${SMOKE_JOB}=success`,
      );
    }
  }
});

test('nested outputs/jobs results obey the same shared-job truth table', () => {
  for (const row of validRows) {
    assert.equal(evaluateCiStatus(nestedResults(flatResults(row))).passed, true, `${row.name}: valid`);

    const invalidConclusions =
      row.smoke === 'success' ? ['failure', 'cancelled', 'skipped'] : ['success', 'failure', 'cancelled'];
    for (const smoke of invalidConclusions) {
      assert.equal(
        evaluateCiStatus(nestedResults(flatResults({ ...row, smoke }))).passed,
        false,
        `${row.name}: nested ${SMOKE_JOB}=${smoke} must fail`,
      );
    }
    assert.equal(
      evaluateCiStatus(nestedResults(withoutSmoke(flatResults(row)))).passed,
      false,
      `${row.name}: nested missing ${SMOKE_JOB} must fail`,
    );
  }
});

function cliEnvironment(smoke) {
  const environment = {
    ...process.env,
    DETECT_CHANGES_RESULT: 'success',
    API_CHANGED: 'false',
    WEB_CHANGED: 'false',
    AGENT_CHANGED: 'false',
    SECURITY_CHANGED: 'false',
    API_GATE_RESULT: 'skipped',
    ...Object.fromEntries(
      Object.values(SERVICE_CHAINS)
        .flat()
        .map((job) => [`${job.replaceAll('-', '_').toUpperCase()}_RESULT`, 'skipped']),
    ),
    ...(smoke === undefined ? {} : { SMOKE_AND_SANITY_RESULT: smoke }),
  };
  if (smoke === undefined) {
    delete environment.SMOKE_AND_SANITY_RESULT;
  }
  return environment;
}

test('CLI adapter includes SMOKE_AND_SANITY_RESULT and fails closed when it is absent or wrong', () => {
  const passing = spawnSync(process.execPath, [evaluatorPath], {
    encoding: 'utf8',
    env: cliEnvironment('skipped'),
  });
  assert.equal(passing.status, 0, 'all-false CLI input with shared skipped must pass');

  for (const smoke of [undefined, 'success', 'failure', 'cancelled']) {
    const result = spawnSync(process.execPath, [evaluatorPath], {
      encoding: 'utf8',
      env: cliEnvironment(smoke),
    });
    assert.equal(result.status, 1, `CLI ${SMOKE_JOB}=${String(smoke)} must fail closed`);
    assert.equal(JSON.parse(result.stdout).passed, false);
  }
});

test('security changes require both security jobs and a passing static report evaluation', () => {
  const securityOnly = {
    ...flatResults({ api: 'false', web: 'false', agent: 'false', smoke: 'skipped' }),
    security: 'true',
    'security-sast': 'success',
    'security-supply-chain': 'success',
  };

  // Security-only active, evaluateSecurityResults passes
  assert.equal(evaluateCiStatus(securityOnly, { evaluateSecurityResults: () => ({ passed: true }) }).passed, true);

  // Security report evaluation fails
  const result = evaluateCiStatus(securityOnly, {
    evaluateSecurityResults: () => ({
      passed: false,
      errors: ['[Fail-Closed] missing static report'],
    }),
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /security/i);

  // Security jobs failed/skipped
  assert.equal(evaluateCiStatus({ ...securityOnly, 'security-sast': 'failure' }, { evaluateSecurityResults: () => ({ passed: true }) }).passed, false);
  assert.equal(evaluateCiStatus({ ...securityOnly, 'security-supply-chain': 'skipped' }, { evaluateSecurityResults: () => ({ passed: true }) }).passed, false);

  // Security jobs success when security === 'false'
  const securityFalse = { ...securityOnly, security: 'false' };
  assert.equal(evaluateCiStatus(securityFalse).passed, false);

  // Mixed security + API/Web/Agent activates smoke-and-sanity
  const mixed = {
    ...flatResults({ api: 'true', web: 'false', agent: 'false', smoke: 'success' }),
    security: 'true',
    'security-sast': 'success',
    'security-supply-chain': 'success',
  };
  assert.equal(evaluateCiStatus(mixed, { evaluateSecurityResults: () => ({ passed: true }) }).passed, true);
});
