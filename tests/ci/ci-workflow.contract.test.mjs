import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { evaluateCiStatus, SERVICE_CHAINS } from '../../scripts/ci/evaluate-ci-status.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const evaluatorPath = resolve(root, 'scripts/ci/evaluate-ci-status.mjs');
const workflowPath = resolve(root, '.github/workflows/ci.yml');
const services = SERVICE_CHAINS;
const jobIds = ['detect-changes', ...Object.values(services).flat()];
const smokeAndSanityJob = 'smoke-and-sanity';
const workflowJobIds = [...jobIds, smokeAndSanityJob];

function validResults(changes = {}) {
  const results = {
    api: changes.api ? 'true' : 'false',
    web: changes.web ? 'true' : 'false',
    agent: changes.agent ? 'true' : 'false',
    security: changes.security ? 'true' : 'false',
    'detect-changes': 'success',
    [smokeAndSanityJob]: ['api', 'web', 'agent'].some((service) => changes[service])
      ? 'success'
      : 'skipped',
  };

  for (const [service, jobs] of Object.entries(services)) {
    for (const job of jobs) {
      results[job] = changes[service] ? 'success' : 'skipped';
    }
  }
  return results;
}

function workflow() {
  assert.ok(existsSync(workflowPath), 'expected .github/workflows/ci.yml to exist');
  return readFileSync(workflowPath, 'utf8');
}

function jobBlock(source, jobId) {
  const match = source.match(
    new RegExp(
      `^  ${jobId}:[ \\t]*\\n([\\s\\S]*?)(?=^  [\\w-]+:[ \\t]*$|^(?!\\s)|$(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `expected ${jobId} job`);
  return match[0];
}

function workflowJobBlocks(source) {
  const headers = [...source.matchAll(/^\x20{2}([\w-]+):[ \t]*$/gm)];
  return headers.map((header, index) => ({
    jobId: header[1],
    block: source.slice(header.index, headers[index + 1]?.index ?? source.length),
  }));
}

function stepBlock(job, stepName) {
  const match = job.match(
    new RegExp(
      `^      - name: ${stepName}[ \\t]*\\n([\\s\\S]*?)(?=^      - name: |$(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `expected ${stepName} step`);
  return match[0];
}

function filterBlock(detect, filterName) {
  const match = detect.match(
    new RegExp(
      `^            ${filterName}:[ \\t]*\\n([\\s\\S]*?)(?=^            [\\w-]+:[ \\t]*$|^  [\\w-]+:[ \\t]*$|$(?![\\s\\S]))`,
      'm',
    ),
  );
  assert.ok(match, `expected ${filterName} routing filter`);
  return match[0];
}

function workflowSteps(job) {
  const stepsIndex = job.indexOf('    steps:\n');
  assert.notEqual(stepsIndex, -1, 'expected workflow job steps');

  const steps = job.slice(stepsIndex);
  const matches = [
    ...steps.matchAll(
      /^      - name:\s+(.+?)\s*\n([\s\S]*?)(?=^      - name:|$(?![\s\S]))/gm,
    ),
  ];
  assert.ok(matches.length > 0, 'expected named workflow steps');
  return matches.map(([block, name]) => ({ block, name }));
}

function stepContaining(job, pattern, description) {
  const matches = workflowSteps(job).filter(({ block }) => pattern.test(block));
  assert.equal(matches.length, 1, description);
  return matches[0].block;
}

test('API and web gates check changed TypeScript after install against the PR base', () => {
  const source = workflow();
  for (const jobId of ['api-gate', 'web-gate']) {
    const job = jobBlock(source, jobId);
    assert.match(stepBlock(job, 'Checkout pull request'), /fetch-depth:\s+2/);
    const install = stepBlock(job, 'Install Node dependencies');
    const guard = stepBlock(job, 'Check changed TypeScript escapes');
    assert.match(
      guard,
      /node scripts\/ci\/check-type-escapes\.mjs --base HEAD\^1/,
    );
    assert.ok(
      job.indexOf(guard) > job.indexOf(install),
      jobId + ' must run the guard after dependency installation',
    );
  }
  assert.match(
    stepBlock(jobBlock(source, 'api-gate'), 'Test TypeScript escape guard'),
    /node --test tests\/ci\/check-type-escapes\.test\.mjs/,
  );
});

test('detect-changes always runs the agent CLI tests after Node setup', () => {
  const detect = jobBlock(workflow(), 'detect-changes');
  const setupNode = stepBlock(detect, 'Set up Node 20');
  const contextTests = stepBlock(detect, 'Test agent context CLI');
  const workTests = stepBlock(detect, 'Test agent work CLI');
  const workflowContracts = stepBlock(detect, 'Verify workflow contract');

  assert.match(contextTests, /node --test tests\/ci\/agent-context\.test\.mjs/);
  assert.match(workTests, /node --test tests\/ci\/agent-work\.test\.mjs/);
  assert.ok(
    detect.indexOf(contextTests) > detect.indexOf(setupNode),
    'agent context tests must run after Node setup',
  );
  assert.ok(
    detect.indexOf(workTests) > detect.indexOf(contextTests),
    'agent work tests must run after the agent context tests',
  );
  assert.ok(
    detect.indexOf(workTests) < detect.indexOf(workflowContracts),
    'agent tests must run before the workflow contract checks',
  );
  for (const agentTest of [contextTests, workTests]) {
    assert.doesNotMatch(agentTest, /^\s+if:/m, 'agent CLI tests must run unconditionally');
  }
  assert.doesNotMatch(detect, /^[\t\x20]{4}if:/m, 'detect-changes must remain unconditional');
  assert.doesNotMatch(
    detect,
    /pnpm install/,
    'the standalone CLI tests must not require dependency installation',
  );
});

function jobIfExpression(job) {
  const match = job.match(/^    if:\s*(?:>-\s*\n)?\s*\$\{\{([\s\S]*?)\}\}\s*$/m);
  assert.ok(match, 'expected a GitHub Actions if expression');
  return match[1].replace(/\s+/g, ' ').trim();
}

function parenthesizedGroups(expression) {
  const groups = [];
  const starts = [];
  for (const [index, character] of [...expression].entries()) {
    if (character === '(') {
      starts.push(index);
    } else if (character === ')') {
      const start = starts.pop();
      if (start !== undefined) {
        groups.push(expression.slice(start + 1, index));
      }
    }
  }
  return groups;
}

function assertChangeAwareSharedJobPredicate(expression) {
  const candidates = [expression, ...parenthesizedGroups(expression)];
  const outputTrue = (service) =>
    new RegExp(`needs\\.detect-changes\\.outputs\\.${service}\\s*==\\s*['"]true['"]`);
  const unchanged = (service) =>
    new RegExp(
      `needs\\.detect-changes\\.outputs\\.${service}\\s*(?:!=\\s*['"]true['"]|==\\s*['"]false['"])`,
    );
  const terminalSuccess = (job) => new RegExp(`needs\\.${job}\\.result\\s*==\\s*['"]success['"]`);

  assert.match(
    expression,
    /always\(\)/,
    'the shared job predicate must still evaluate after prerequisite jobs finish',
  );
  assert.match(
    expression,
    /needs\.detect-changes\.result\s*==\s*['"]success['"]/,
    'the shared job predicate must require successful change detection',
  );
  assert.ok(
    candidates.some(
      (candidate) =>
        candidate.includes('||') && ['api', 'web', 'agent'].every((service) => outputTrue(service).test(candidate)),
    ),
    'the shared job predicate must require at least one changed domain',
  );

  for (const [service, terminals] of Object.entries({
    api: ['api-unit-tests', 'api-interface-tests', 'api-integration-tests', 'api-performance-tests'],
    web: ['web-build', 'web-unit-tests', 'web-interface-tests'],
    agent: ['agent-unit-tests', 'agent-integration-tests', 'agent-performance-tests'],
  })) {
    assert.ok(
      candidates.some(
        (candidate) =>
          unchanged(service).test(candidate) &&
          candidate.includes('||') &&
          terminals.every((terminal) => terminalSuccess(terminal).test(candidate)),
      ),
      `${service} must permit an unchanged domain or require all of its terminal jobs to succeed`,
    );
  }
}

function assertContains(block, pattern, description) {
  assert.match(block, pattern, description);
}

test('truth table accepts every valid API, Web, and Agent routing combination', () => {
  for (const api of [false, true]) {
    for (const web of [false, true]) {
      for (const agent of [false, true]) {
        const result = evaluateCiStatus(validResults({ api, web, agent }));
        assert.deepEqual(result, {
          passed: true,
          reason: 'all required CI jobs reached their expected conclusions',
        });
      }
    }
  }
});

test('evaluator rejects malformed or failed change detection', () => {
  for (const malformed of [true, false, 'TRUE', 'yes', '', undefined]) {
    const result = evaluateCiStatus({ ...validResults(), api: malformed });
    assert.equal(result.passed, false, `api=${String(malformed)} must be rejected`);
  }

  for (const conclusion of ['failure', 'cancelled', 'skipped', undefined]) {
    const result = evaluateCiStatus({ ...validResults(), 'detect-changes': conclusion });
    assert.equal(result.passed, false, `detect-changes=${String(conclusion)} must be rejected`);
  }
});

test('evaluator rejects every false-green job result', () => {
  for (const [service, jobs] of Object.entries(services)) {
    for (const job of jobs) {
      for (const conclusion of ['failure', 'cancelled', 'skipped', undefined]) {
        const result = evaluateCiStatus({
          ...validResults({ [service]: true }),
          [job]: conclusion,
        });
        assert.equal(
          result.passed,
          false,
          `${job}=${String(conclusion)} must fail an active chain`,
        );
      }

      for (const conclusion of ['success', 'failure', 'cancelled', undefined]) {
        const result = evaluateCiStatus({ ...validResults(), [job]: conclusion });
        assert.equal(
          result.passed,
          false,
          `${job}=${String(conclusion)} must fail an inactive chain`,
        );
      }
    }
  }
});

test('evaluator accepts nested GitHub-summary shaped results and never throws for invalid input', () => {
  const flat = validResults({ api: true, agent: true });
  const nested = {
    outputs: { api: flat.api, web: flat.web, agent: flat.agent, security: flat.security },
    jobs: Object.fromEntries(workflowJobIds.map((job) => [job, flat[job]])),
  };
  assert.equal(evaluateCiStatus(nested).passed, true);

  for (const invalid of [null, undefined, [], '', 1]) {
    assert.doesNotThrow(() => evaluateCiStatus(invalid));
    assert.equal(evaluateCiStatus(invalid).passed, false);
  }
});

test('evaluator CLI emits JSON and fails closed', () => {
  const passing = spawnSync(process.execPath, [evaluatorPath, JSON.stringify(validResults())], {
    encoding: 'utf8',
  });
  assert.equal(passing.status, 0);
  assert.deepEqual(JSON.parse(passing.stdout), evaluateCiStatus(validResults()));

  const failing = spawnSync(process.execPath, [evaluatorPath, '{'], { encoding: 'utf8' });
  assert.equal(failing.status, 1);
  assert.equal(JSON.parse(failing.stdout).passed, false);

  const envPassing = spawnSync(process.execPath, [evaluatorPath], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DETECT_CHANGES_RESULT: 'success',
      API_CHANGED: 'false',
      WEB_CHANGED: 'false',
      AGENT_CHANGED: 'false',
      SECURITY_CHANGED: 'false',
      API_GATE_RESULT: 'skipped',
      API_UNIT_TESTS_RESULT: 'skipped',
      API_INTERFACE_TESTS_RESULT: 'skipped',
      API_INTEGRATION_TESTS_RESULT: 'skipped',
      API_PERFORMANCE_TESTS_RESULT: 'skipped',
      WEB_GATE_RESULT: 'skipped',
      WEB_BUILD_RESULT: 'skipped',
      WEB_UNIT_TESTS_RESULT: 'skipped',
      WEB_INTERFACE_TESTS_RESULT: 'skipped',
      AGENT_GATE_RESULT: 'skipped',
      AGENT_UNIT_TESTS_RESULT: 'skipped',
      AGENT_INTEGRATION_TESTS_RESULT: 'skipped',
      AGENT_PERFORMANCE_TESTS_RESULT: 'skipped',
      SECURITY_SAST_RESULT: 'skipped',
      SECURITY_SUPPLY_CHAIN_RESULT: 'skipped',
      SMOKE_AND_SANITY_RESULT: 'skipped',
    },
  });
  assert.equal(envPassing.status, 0);
  assert.equal(JSON.parse(envPassing.stdout).passed, true);
});

test('evaluator CLI prints usage for --help without parsing it as JSON', () => {
  const help = spawnSync(process.execPath, [evaluatorPath, '--help'], { encoding: 'utf8' });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: node scripts\/ci\/evaluate-ci-status\.mjs/i);
  assert.equal(help.stderr, '');
});

test('workflow envelope uses the stable event, permissions, concurrency, and timeouts', () => {
  const source = workflow();
  assertContains(
    source,
    /^on:\s*\n\s+pull_request:\s*\n\s+branches:\s*(?:\[development\]|\n\s+- development)\s*\n\s+schedule:\s*\n\s+- cron:\s*['"][^'"]+['"]\s*$/m,
    'workflow must target development pull requests and periodic scans',
  );
  assertContains(
    source,
    /^permissions:\s*\n\s+contents:\s+read\s*$/m,
    'default permissions must be contents: read',
  );
  assertContains(
    source,
    /^concurrency:\s*\n\s+group:\s+.*github\.event\.pull_request\.number.*\n\s+cancel-in-progress:\s+true\s*$/m,
    'workflow must cancel superseded PR runs',
  );

  for (const job of [...jobIds, 'ci-status']) {
    const block = jobBlock(source, job);
    assertContains(
      block,
      /^    runs-on:\s+ubuntu-latest\s*$/m,
      `${job} must use a fresh Ubuntu runner`,
    );
    assertContains(block, /^    timeout-minutes:\s+\d+\s*$/m, `${job} must declare a timeout`);
  }

  const detect = jobBlock(source, 'detect-changes');
  assertContains(
    detect,
    /^    permissions:\s*\n\s+contents:\s+read\s*\n\s+pull-requests:\s+read\s*$/m,
    'only detection may add pull-request read access',
  );
});

test('workflow pins actions, disables credential persistence, and avoids unsafe caches', () => {
  const source = workflow();
  const actionUses = [...source.matchAll(/^\s+uses:\s+([^\s#]+)@([\w.-]+)(?:\s+#.*)?$/gm)];
  assert.ok(actionUses.length > 0, 'workflow must use pinned actions');
  for (const [, action, ref] of actionUses) {
    assert.match(ref, /^[a-f0-9]{40}$/i, `${action} must use a 40-character SHA`);
  }
  for (const [action, sha] of Object.entries({
    'actions/checkout': '3d3c42e5aac5ba805825da76410c181273ba90b1',
    'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
    'pnpm/action-setup': '0977fd99725f1db4007ccb2928dbb4e90d06cc86',
    'dorny/paths-filter': 'fbd0ab8f3e69293af611ebaee6363fc25e6d187d',
    'astral-sh/setup-uv': 'c771a70e6277c0a99b617c7a806ffedaca235ff9',
  })) {
    assertContains(
      source,
      new RegExp(`^\\s+uses:\\s+${action.replace('/', '\\/')}@${sha}\\s+#\\s+.+$`, 'm'),
      `${action} must use the reviewed release SHA`,
    );
  }

  const checkoutCount = actionUses.filter(([, action]) => action === 'actions/checkout').length;
  const persistedCredentialCount = (source.match(/^\s+persist-credentials:\s+false\s*$/gm) ?? [])
    .length;
  assert.ok(checkoutCount > 0, 'workflow must check out source explicitly');
  assert.equal(
    persistedCredentialCount,
    checkoutCount,
    'every checkout must disable persisted credentials',
  );
  assert.doesNotMatch(
    source,
    /(?:node_modules|\.next|\.venv)(?:\/|\b)/i,
    'workflow must never cache dependency or build directories',
  );
});

test('workflow preserves service-specific validation and network boundaries', () => {
  const source = workflow();
  const apiGate = jobBlock(source, 'api-gate');
  for (const requirement of [
    /eslint/,
    /pnpm build:shared/,
    /prisma:generate/,
    /tsc --noEmit/,
  ]) {
    assertContains(apiGate, requirement, `API gate must include ${requirement}`);
  }

  const apiInterface = jobBlock(source, 'api-interface-tests');
  for (const requirement of [
    /api-test-partition\.contract\.test\.mjs/,
    /pnpm --filter @shared\/types test/,
    /test:contract/,
    /test:component/,
  ]) {
    assertContains(apiInterface, requirement, `API interface tests must include ${requirement}`);
  }

  const apiIntegration = jobBlock(source, 'api-integration-tests');
  for (const requirement of [
    /postgres:16-alpine/,
    /redis:7-alpine/,
    /prisma migrate deploy/,
    /test:integration/,
    /supplier-identifiers-migration\.e2e\.mjs/,
    /node-network-guard\.cjs/,
  ]) {
    assertContains(apiIntegration, requirement, `API integration must include ${requirement}`);
  }

  const webGate = jobBlock(source, 'web-gate');
  const webBuild = jobBlock(source, 'web-build');
  const webUnit = jobBlock(source, 'web-unit-tests');
  const webInterface = jobBlock(source, 'web-interface-tests');
  for (const requirement of [/lint/, /route/, /typecheck/]) {
    assertContains(webGate, requirement, `Web gate must include ${requirement}`);
  }
  assertContains(
    webBuild,
    /node-network-guard\.cjs/,
    'Web build must preload the Node network guard',
  );
  assertContains(webUnit, /test:unit/, 'web unit job must run the fast Node suite');
  assertContains(webUnit, /build:shared/, 'web unit job must build shared workspace exports');
  assertContains(webInterface, /test:characterization/, 'web interface job must run characterization');
  assertContains(
    webBuild,
    /NEXT_PUBLIC_API_URL/,
    'Web build must supply non-production API configuration',
  );

  const agentGate = jobBlock(source, 'agent-gate');
  const agentUnit = jobBlock(source, 'agent-unit-tests');
  const agentIntegration = jobBlock(source, 'agent-integration-tests');
  const agentPerformance = jobBlock(source, 'agent-performance-tests');
  for (const requirement of [
    /uv sync --locked --package agent/,
    /CI_VALIDATE_TEST_PARTITIONS:\s*['"]?1['"]?/,
    /pytest apps\/agent\/tests --collect-only -qq/,
    /ruff check/,
    /ruff format --check/,
  ]) {
    assertContains(agentGate, requirement, `Agent gate must include ${requirement}`);
  }
  for (const requirement of [
    /-m agent_unit/,
    /PYTHONPATH.*tests\/ci\/python/,
  ]) {
    assertContains(agentUnit, requirement, `Agent unit tests must include ${requirement}`);
  }
  for (const requirement of [
    /redis:7-alpine/,
    /CI_REQUIRE_REDIS_TESTS:\s*['"]?1['"]?/,
    /-m agent_redis/,
    /PYTHONPATH.*tests\/ci\/python/,
  ]) {
    assertContains(agentIntegration, requirement, `Agent integration tests must include ${requirement}`);
  }
  for (const requirement of [
    /redis:7-alpine/,
    /CI_REQUIRE_PERFORMANCE_TESTS:\s*['"]?1['"]?/,
    /-m agent_performance/,
    /PYTHONPATH.*tests\/ci\/python/,
  ]) {
    assertContains(agentPerformance, requirement, `Agent performance tests must include ${requirement}`);
  }
});

test('Agent unit, Redis, and performance selectors are independently required', () => {
  const source = workflow();
  for (const [jobId, marker, guard] of [
    ['agent-unit-tests', 'agent_unit', undefined],
    ['agent-integration-tests', 'agent_redis', 'CI_REQUIRE_REDIS_TESTS'],
    ['agent-performance-tests', 'agent_performance', 'CI_REQUIRE_PERFORMANCE_TESTS'],
  ]) {
    const job = jobBlock(source, jobId);
    assert.match(job, new RegExp(`-m ${marker}`), `${jobId} must select ${marker}`);
    if (guard) assert.match(job, new RegExp(`${guard}:\\s*['"]?1['"]?`), `${jobId} must require collected coverage`);
  }
});

test('API unit and fast performance lanes use explicit locked task selectors', () => {
  const apiUnitTests = jobBlock(workflow(), 'api-unit-tests');
  const unitStep = stepBlock(apiUnitTests, 'Run API unit tests with loopback-only network');
  const apiPerformance = jobBlock(workflow(), 'api-performance-tests');
  const performanceStep = stepBlock(
    apiPerformance,
    'Run API performance checks with loopback-only network',
  );
  const apiPackage = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));

  assert.equal(
    apiPackage.scripts['test:unit'],
    'node ../../scripts/ci/run-api-task.mjs test:unit',
    'API unit command must run through the checkout task lock',
  );
  assert.match(unitStep, /pnpm --filter @api\/backend run test:unit/);
  assert.match(apiUnitTests, /pnpm build:shared/);
  assert.match(apiUnitTests, /prisma:generate/);
  assert.equal(
    apiPackage.scripts['test:performance:unit'],
    'node ../../scripts/ci/run-api-task.mjs test:performance:unit',
    'API performance command must run through the checkout task lock',
  );
  assert.match(performanceStep, /pnpm --filter @api\/backend run test:performance:unit/);
  assert.doesNotMatch(
    unitStep,
    /test -- --runInBand/,
    'CI must not depend on pnpm forwarding Jest flags through the generic test script',
  );
});

test('default API E2E excludes runner-dependent performance benchmarks', () => {
  const e2eConfig = JSON.parse(readFileSync(resolve(root, 'apps/api/test/jest-e2e.json'), 'utf8'));
  const apiPackage = JSON.parse(readFileSync(resolve(root, 'apps/api/package.json'), 'utf8'));

  assert.ok(
    e2eConfig.testPathIgnorePatterns?.includes('[.-]performance\\.e2e-spec\\.ts$'),
    'correctness E2E must not fail on unpinned runner latency thresholds',
  );
  assert.equal(
    apiPackage.scripts['test:e2e:performance'],
    'node ../../scripts/ci/run-api-task.mjs test:e2e:performance',
    'performance benchmarks must remain available through the locked explicit opt-in command',
  );
  assert.doesNotMatch(
    workflow(),
    /test:e2e:performance/,
    'runner-sensitive AppModule performance benchmarks must stay opt-in',
  );
});

test('workflow defines the required job graph, routing matrix, and fail-closed summary', () => {
  const source = workflow();
  for (const job of [...jobIds, 'ci-status']) {
    jobBlock(source, job);
  }

  const detect = jobBlock(source, 'detect-changes');
  for (const output of Object.keys(services)) {
    const expression = `^\\s+${output}:\\s+\\$\\{\\{(?=.*outputs\\.${output}).*\\}\\}`;
    assertContains(
      detect,
      new RegExp(expression, 'm'),
      `detect-changes must publish ${output}`,
    );
  }
  for (const path of [
    'apps/api/**',
    'apps/web/**',
    'apps/agent/**',
    'packages/shared/**',
    'tests/ci/**',
    'scripts/ci/**',
  ]) {
    assert.ok(source.includes(path), `routing filters must include ${path}`);
  }
  for (const path of ['package.json', 'pyproject.toml', 'uv.lock']) {
    assert.ok(source.includes(path), `routing filters must account for ${path}`);
  }

  for (const [job, dependency] of [
    ['api-gate', 'detect-changes'],
    ['api-unit-tests', 'api-gate'],
    ['api-interface-tests', 'api-gate'],
    ['api-integration-tests', 'api-gate'],
    ['api-performance-tests', 'api-gate'],
    ['web-gate', 'detect-changes'],
    ['web-build', 'web-gate'],
    ['web-unit-tests', 'web-gate'],
    ['web-interface-tests', 'web-gate'],
    ['agent-gate', 'detect-changes'],
    ['agent-unit-tests', 'agent-gate'],
    ['agent-integration-tests', 'agent-gate'],
    ['agent-performance-tests', 'agent-gate'],
  ]) {
    assertContains(
      jobBlock(source, job),
      new RegExp(`^    needs:\\s+(?:${dependency}|\\[[^\\]]*${dependency}[^\\]]*\\])\\s*$`, 'm'),
      `${job} must depend on ${dependency}`,
    );
  }

  const summary = jobBlock(source, 'ci-status');
  assertContains(
    summary,
    /^    if:\s+\$\{\{\s*always\(\)\s*\}\}\s*$/m,
    'ci-status must always evaluate all results',
  );
  for (const job of jobIds) {
    assertContains(
      summary,
      new RegExp(`^    needs:\\s+\\[[^\\]]*${job}[^\\]]*\\]\\s*$|^\\s+- ${job}\\s*$`, 'm'),
      `ci-status must need ${job}`,
    );
  }
  assertContains(summary, /evaluate-ci-status\.mjs/, 'ci-status must invoke the shared evaluator');
});

test('smoke-and-sanity is a shared workflow job, not a service-chain terminal', () => {
  assert.ok(
    workflowJobIds.includes(smokeAndSanityJob),
    'the tested workflow job set must include smoke-and-sanity',
  );
  assert.ok(
    !Object.values(services).flat().includes(smokeAndSanityJob),
    'smoke-and-sanity must remain outside SERVICE_CHAINS because it is shared infrastructure',
  );

  jobBlock(workflow(), smokeAndSanityJob);
});

test('Compose-only shared-infrastructure routing makes every domain applicable', () => {
  const detect = jobBlock(workflow(), 'detect-changes');
  const sharedPaths = [
    'tests/smoke/**',
    'scripts/ci/run-smoke-sanity.mjs',
    'docker-compose.yml',
  ];

  for (const service of ['api', 'web', 'agent']) {
    const filter = filterBlock(detect, service);
    for (const path of sharedPaths) {
      assert.ok(
        filter.includes(path),
        `${service} routing must include ${path} so shared stack changes cannot be skipped`,
      );
    }
  }
});

test('Compose-only routing requires a successful shared smoke-and-sanity result', () => {
  const composeOnly = validResults({ api: true, web: true, agent: true });

  assert.equal(
    evaluateCiStatus({ ...composeOnly, [smokeAndSanityJob]: 'success' }).passed,
    true,
    'a Compose-only change with successful prerequisite and shared jobs must pass',
  );

  for (const result of ['skipped', 'cancelled', 'failure', undefined]) {
    assert.equal(
      evaluateCiStatus({ ...composeOnly, [smokeAndSanityJob]: result }).passed,
      false,
      `a Compose-only change must reject smoke-and-sanity=${String(result)}`,
    );
  }

  assert.equal(
    evaluateCiStatus({ ...validResults(), [smokeAndSanityJob]: 'skipped' }).passed,
    true,
    'an unchanged repository must retain the valid shared-job skipped path',
  );
});

test('smoke-and-sanity is an always-evaluated, change-aware dependency gate', () => {
  const shared = jobBlock(workflow(), smokeAndSanityJob);
  const predicate = jobIfExpression(shared);

  for (const requirement of [
    /^    runs-on:\s+ubuntu-latest\s*$/m,
    /^    timeout-minutes:\s+\d+\s*$/m,
  ]) {
    assertContains(shared, requirement, `smoke-and-sanity must include ${requirement}`);
  }

  for (const dependency of [
    'detect-changes',
    'api-unit-tests',
    'api-interface-tests',
    'api-integration-tests',
    'api-performance-tests',
    'web-build',
    'web-unit-tests',
    'web-interface-tests',
    'agent-unit-tests',
    'agent-integration-tests',
    'agent-performance-tests',
  ]) {
    assertContains(
      shared,
      new RegExp(`^    needs:\\s+\\[[^\\]]*${dependency}[^\\]]*\\]\\s*$|^\\s+- ${dependency}\\s*$`, 'm'),
      `smoke-and-sanity must need ${dependency}`,
    );
  }

  assertChangeAwareSharedJobPredicate(predicate);
  assert.throws(
    () =>
      assertChangeAwareSharedJobPredicate(
        "always() && needs.detect-changes.result == 'success' && (needs.detect-changes.outputs.api == 'true' || needs.detect-changes.outputs.web == 'true' || needs.detect-changes.outputs.agent == 'true') && needs.api-unit-tests.result == 'success' && needs.api-interface-tests.result == 'success' && needs.api-integration-tests.result == 'success' && needs.api-performance-tests.result == 'success' && needs.web-build.result == 'success' && needs.web-unit-tests.result == 'success' && needs.web-interface-tests.result == 'success' && needs.agent-unit-tests.result == 'success' && needs.agent-integration-tests.result == 'success' && needs.agent-performance-tests.result == 'success'",
      ),
    /must permit an unchanged domain/,
    'a predicate that requires every terminal even for unchanged domains must be rejected',
  );
});

test('smoke-and-sanity provisions the locked loopback stack and invokes only the orchestrator', () => {
  const shared = jobBlock(workflow(), smokeAndSanityJob);

  for (const requirement of [
    /pnpm\/action-setup@[a-f0-9]{40}/i,
    /version:\s*10\.34\.5/,
    /actions\/setup-node@[a-f0-9]{40}/i,
    /node-version:\s*20/,
    /astral-sh\/setup-uv@[a-f0-9]{40}/i,
    /version:\s*0\.12\.0/,
    /python-version:\s*['"]3\.11['"]?/,
    /pnpm install --frozen-lockfile/,
    /uv sync --locked --package agent/,
    /docker compose up -d/,
    /pnpm build:shared/,
    /prisma:generate/,
    /prisma migrate deploy/,
    /pnpm --filter @api\/backend build/,
    /pnpm --filter @web\/frontend build/,
  ]) {
    assertContains(shared, requirement, `smoke-and-sanity must include ${requirement}`);
  }

  const orchestrator = stepContaining(
    shared,
    /node scripts\/ci\/run-smoke-sanity\.mjs --mode=ci/,
    'expected exactly one smoke-and-sanity orchestrator step',
  );
  assertContains(
    orchestrator,
    /^        run:\s+node scripts\/ci\/run-smoke-sanity\.mjs --mode=ci\s*$/m,
    'the orchestrator step must run the exact CI command without appended flags',
  );
  for (const requirement of [
    /NODE_OPTIONS:\s*--require=\$\{\{ github\.workspace \}\}\/tests\/ci\/node-network-guard\.cjs/,
    /DATABASE_URL:.*127\.0\.0\.1/,
    /REDIS_URL:.*127\.0\.0\.1/,
    /DUFFEL_API_URL:.*127\.0\.0\.1/,
    /STRIPE_API_URL:.*127\.0\.0\.1/,
    /AGENT_SERVICE_URL:.*127\.0\.0\.1/,
    /NESTJS_API_URL:.*127\.0\.0\.1/,
    /API_URL:.*127\.0\.0\.1/,
  ]) {
    assertContains(
      orchestrator,
      requirement,
      `the orchestrator step must set ${requirement} locally`,
    );
  }

  assert.doesNotMatch(
    shared,
    /node --test(?:\s+--test-reporter=spec)?\s+tests\/smoke\/(?:smoke|sanity)\.test\.mjs/,
    'the orchestrator, rather than inline suite commands, must enforce readiness then smoke then sanity',
  );
});

test('smoke-and-sanity diagnostics are always-run and privacy-safe', () => {
  const shared = jobBlock(workflow(), smokeAndSanityJob);
  const diagnostics = stepContaining(
    shared,
    /docker compose ps/,
    'expected exactly one diagnostics step that inspects Compose services',
  );
  const teardown = stepContaining(
    shared,
    /docker compose down/,
    'expected exactly one teardown step that stops Compose services',
  );

  assertContains(
    diagnostics,
    /^        if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m,
    'smoke-and-sanity must always collect Compose diagnostics',
  );
  assert.doesNotMatch(
    diagnostics,
    /\bdocker\s+compose\s+logs\b|\b(?:tail|head|cat|less|more|sed|awk)\b[^\r\n]*(?:\*\.log\b|(?:stdout|stderr)\.log\b|\.smoke-diagnostics)/i,
    'the diagnostics step must not print raw Compose or service/mock log bodies automatically',
  );
  assertContains(
    teardown,
    /^        if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m,
    'smoke-and-sanity must always tear down its Compose services',
  );
});

test('ci-status consumes the shared smoke-and-sanity result', () => {
  const summary = jobBlock(workflow(), 'ci-status');

  assertContains(
    summary,
    new RegExp(`^    needs:\\s+\\[[^\\]]*${smokeAndSanityJob}[^\\]]*\\]\\s*$|^\\s+- ${smokeAndSanityJob}\\s*$`, 'm'),
    'ci-status must wait for smoke-and-sanity',
  );
  assertContains(
    summary,
    /SMOKE_AND_SANITY_RESULT:\s*\$\{\{\s*needs\.smoke-and-sanity\.result\s*\}\}/,
    'ci-status must pass the shared job conclusion to the evaluator',
  );
});

test('security routing handles required paths', () => {
  const detect = jobBlock(workflow(), 'detect-changes');
  const filter = filterBlock(detect, 'security');
  const expectedPaths = [
    '.github/workflows/**',
    '.gitleaks.toml',
    'scripts/security/**',
    'tests/security/**',
    'tests/security/toolchain.json',
    'tests/security/exceptions.json',
    'docs/security/**',
    'package.json',
    'pnpm-lock.yaml',
    'pyproject.toml',
    'apps/agent/pyproject.toml',
    'uv.lock',
    'apps/api/src/auth/**',
    'apps/web/**auth**',
    'apps/api/src/**',
    'apps/agent/src/**',
    'apps/web/components/**',
  ];
  for (const p of expectedPaths) {
    assert.ok(filter.includes(p), `security filter must include ${p}`);
  }
});

test('security-sast and security-supply-chain jobs meet strict CI guidelines', () => {
  const source = workflow();
  const sast = jobBlock(source, 'security-sast');
  const sc = jobBlock(source, 'security-supply-chain');

  for (const job of [sast, sc]) {
    assertContains(job, /^    runs-on:\s+ubuntu-latest\s*$/m, 'must use fresh Ubuntu runner');
    assertContains(job, /^    timeout-minutes:\s+10\s*$/m, 'must declare 10min timeout');
    assertContains(job, /^    permissions:\s*\n\s+contents:\s+read\s*$/m, 'permissions must be contents: read');
    assertContains(job, /^    needs:\s+(?:\[[^\]]*detect-changes[^\]]*\]|detect-changes)\s*$/m, 'must need detect-changes');
    assertContains(job, /^    if:\s+\$\{\{\s*needs\.detect-changes\.outputs\.security\s*==\s*['"]true['"]\s*\}\}\s*$/m, 'must gate on security changed');
  }

  assertContains(sast, /pnpm\/action-setup@[a-f0-9]{40}/, 'sast must use pinned pnpm setup');
  // Human-approved 2026-10-03: align security checks with existing pnpm 10.34.5 jobs.
  assertContains(sast, /version:\s*10\.34\.5/, 'sast must use pnpm 10.34.5');
  assertContains(sast, /actions\/setup-node@[a-f0-9]{40}/, 'sast must use pinned setup-node');
  assertContains(sast, /pnpm install --frozen-lockfile/, 'sast must install frozen dependencies');
  assertContains(sast, /astral-sh\/setup-uv@[a-f0-9]{40}/, 'must use setup-uv');
  assertContains(sast, /uv tool install --python 3\.11 --with "setuptools<80" semgrep==1\.88\.0/, 'must install semgrep 1.88.0');
  assertContains(sast, /node scripts\/security\/run-sast\.mjs --mode full --sarif-output artifacts\/security\/sast\.json --strict-scanner/, 'must run run-sast');
  assertContains(sast, /actions\/upload-artifact@[a-f0-9]{40}/, 'must upload artifacts');
  assertContains(sast, /^        if:\s+always\(\)\s*$/m, 'must upload always');

  assertContains(sc, /pnpm\/action-setup@[a-f0-9]{40}/, 'supply chain must use pinned pnpm setup');
  assertContains(sc, /version:\s*10\.34\.5/, 'supply chain must use pnpm 10.34.5');
  assertContains(sc, /actions\/setup-node@[a-f0-9]{40}/, 'supply chain must use pinned setup-node');
  assertContains(sc, /astral-sh\/setup-uv@[a-f0-9]{40}/, 'supply chain must use pinned setup-uv');
  assertContains(sc, /fetch-depth:\s+0/, 'Gitleaks history scan must fetch full history');
  assertContains(sc, /ba6dbb656933921c775ee5a2d1c13a91046e7952e9d919f9bac4cec61d628e7d/, 'must verify Gitleaks v8.18.4 checksum');
  assertContains(sc, /node scripts\/security\/run-supply-chain\.mjs --output artifacts\/security\/supply-chain\.json --strict/, 'must run run-supply-chain');
  assertContains(sc, /actions\/upload-artifact@[a-f0-9]{40}/, 'must upload artifacts always');
  const dependencyJobs = workflowJobBlocks(source).filter(({ block }) =>
    block.includes('pnpm install --frozen-lockfile'),
  );

  assert.ok(dependencyJobs.length > 0, 'expected Node dependency jobs');
  for (const { jobId, block } of dependencyJobs) {
    assert.match(block, /actions\/setup-node@[a-f0-9]{40}/, `${jobId} must set up Node`);
    const setup = stepBlock(block, 'Set up pnpm 10.34.5');
    assert.match(setup, /version:\s*10\.34\.5/, `${jobId} must use pnpm 10.34.5`);
  }
});

test('local dependency patch changes route through API, web, and security checks', () => {
  const detect = jobBlock(workflow(), 'detect-changes');

  for (const service of ['api', 'web', 'security']) {
    assert.ok(
      filterBlock(detect, service).includes('patches/**'),
      `${service} filter must include local dependency patches`,
    );
  }
});

test('ci-status processes security aggregates correctly', () => {
  const source = workflow();
  const summary = jobBlock(source, 'ci-status');

  assertContains(summary, /SECURITY_CHANGED:\s*\$\{\{\s*needs\.detect-changes\.outputs\.security\s*\}\}/, 'must pass SECURITY_CHANGED');
  assertContains(summary, /SECURITY_SAST_RESULT:\s*\$\{\{\s*needs\.security-sast\.result\s*\}\}/, 'must pass SECURITY_SAST_RESULT');
  assertContains(summary, /SECURITY_SUPPLY_CHAIN_RESULT:\s*\$\{\{\s*needs\.security-supply-chain\.result\s*\}\}/, 'must pass SECURITY_SUPPLY_CHAIN_RESULT');
  assertContains(summary, /SECURITY_REPORT_DIRECTORY:\s*artifacts\/security/, 'must pass SECURITY_REPORT_DIRECTORY');

  assertContains(summary, /actions\/download-artifact@[a-f0-9]{40}/, 'must download artifact');
  assertContains(summary, /^        if:\s+always\(\)\s*$/m, 'must download always');
  assertContains(summary, /^        continue-on-error:\s+true\s*$/m, 'download must continue on error');
});

test('API integration job provisions the database required by its recovery fixtures', () => {
  const apiIntegration = jobBlock(workflow(), 'api-integration-tests');
  const databaseName = 'fulfillment_recovery_test';
  const postgresDatabase = apiIntegration.match(/^\s+POSTGRES_DB:\s+([A-Za-z0-9_]+)$/m);
  const postgresHealthDatabase = apiIntegration.match(
    /--health-cmd "pg_isready -U postgres -d ([A-Za-z0-9_]+)"/,
  );
  const databaseUrl = apiIntegration.match(/^\s+DATABASE_URL:\s+(\S+)$/m);
  assert.equal(
    postgresDatabase?.[1],
    databaseName,
    'PostgreSQL must create the recovery fixture database',
  );
  assert.equal(
    postgresHealthDatabase?.[1],
    databaseName,
    'PostgreSQL health check must target the created database',
  );
  assert.ok(databaseUrl, 'integration job must set DATABASE_URL');
  const parsedDatabaseUrl = new URL(databaseUrl[1]);
  assert.equal(parsedDatabaseUrl.pathname, '/' + databaseName);
  assert.equal(parsedDatabaseUrl.searchParams.get('schema'), 'public');
  const adminDatabaseUrl = apiIntegration.match(
    /^\s+FULFILLMENT_HARNESS_ADMIN_DATABASE_URL:\s+(\S+)$/m,
  );
  assert.ok(adminDatabaseUrl, 'integration job must set the explicit harness admin database URL');
  const parsedAdminDatabaseUrl = new URL(adminDatabaseUrl[1]);
  assert.equal(parsedAdminDatabaseUrl.hostname, '127.0.0.1');
  assert.equal(parsedAdminDatabaseUrl.pathname, '/' + databaseName);
  assert.equal(parsedAdminDatabaseUrl.searchParams.has('schema'), false);
  assert.equal(parsedAdminDatabaseUrl.protocol, parsedDatabaseUrl.protocol);
  assert.match(
    apiIntegration,
    /image: redis:7-alpine/,
    'integration job must provide its disposable Redis service',
  );
  assert.match(apiIntegration, /REDIS_URL: redis:\/\/127\.0\.0\.1:6379\/0/);

  const integrationConfig = JSON.parse(
    readFileSync(resolve(root, 'apps/api/jest-integration.json'), 'utf8'),
  );
  for (const selection of [
    '**/test/**/*.e2e-spec.ts',
    '**/test/fulfillment-harness/scheduler.spec.ts',
    '**/test/fulfillment-harness/driver.spec.ts',
  ]) {
    assert.ok(
      integrationConfig.testMatch.includes(selection),
      'integration selector must include ' + selection,
    );
  }
  const migrationPath = 'test/fulfillment-recovery-migration.e2e-spec.ts';
  assert.equal(
    integrationConfig.testPathIgnorePatterns.some((pattern) =>
      new RegExp(pattern).test(migrationPath),
    ),
    false,
    'integration selector must not exclude the recovery migration fixture',
  );
});

test('API CI generates Prisma through the locked package task before workers start', () => {
  const source = workflow();
  const safeGenerateCommand = 'pnpm --filter @api/backend prisma:generate';
  assert.equal(
    source.split(safeGenerateCommand).length - 1,
    6,
    'each API CI workspace must generate Prisma through the task runner',
  );
  assert.doesNotMatch(
    source,
    /pnpm --filter @api\/backend exec prisma generate/,
    'CI must not bypass the checkout task lock for Prisma generation',
  );

  const jobSteps = {
    'api-gate': ['Typecheck API'],
    'api-unit-tests': ['Run API unit tests with loopback-only network'],
    'api-interface-tests': [
      'Verify API test partitions cover the previous suite',
      'Run shared package contract tests',
      'Run API contract tests with loopback-only network',
      'Run API component tests with loopback-only network',
    ],
    'api-performance-tests': ['Run API performance checks with loopback-only network'],
    'api-integration-tests': ['Run API integration tests with loopback-only network'],
    'smoke-and-sanity': ['Build API and Web applications'],
  };
  for (const [jobId, steps] of Object.entries(jobSteps)) {
    const job = jobBlock(source, jobId);
    assert.ok(
      job.includes(safeGenerateCommand),
      jobId + ' must generate Prisma through the task runner',
    );
    const install = stepBlock(job, 'Install Node dependencies');
    assert.ok(
      job.indexOf(safeGenerateCommand) > job.indexOf(install),
      jobId + ' must generate after installing dependencies',
    );
    for (const stepName of steps) {
      assert.ok(
        job.indexOf(safeGenerateCommand) < job.indexOf(stepBlock(job, stepName)),
        jobId + ' must generate Prisma before ' + stepName,
      );
    }
  }
});

test('security API image includes the locked task runner in its Docker context', () => {
  const dockerfile = readFileSync(resolve(root, 'tests/security/api.Dockerfile'), 'utf8');
  const dockerignore = readFileSync(
    resolve(root, 'tests/security/api.Dockerfile.dockerignore'),
    'utf8',
  );

  assert.match(dockerfile, /^COPY scripts\/ci\/run-api-task\.mjs \.\/scripts\/ci\/$/m);
  assert.match(dockerfile, /^RUN .*pnpm --filter @api\/backend build/m);
  for (const allowedPath of ['!scripts/', '!scripts/ci/', '!scripts/ci/run-api-task.mjs']) {
    assert.ok(
      dockerignore.split(/\r?\n/).includes(allowedPath),
      'API build context must include ' + allowedPath,
    );
  }
});
