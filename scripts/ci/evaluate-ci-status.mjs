import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateSecurityResults } from '../security/evaluate-results.mjs';

export const SERVICE_CHAINS = {
  api: [
    'api-gate',
    'api-unit-tests',
    'api-interface-tests',
    'api-integration-tests',
    'api-performance-tests',
  ],
  web: ['web-gate', 'web-build', 'web-unit-tests', 'web-interface-tests'],
  agent: ['agent-gate', 'agent-unit-tests', 'agent-integration-tests', 'agent-performance-tests'],
  security: ['security-sast', 'security-supply-chain'],
};

const DETECTION_OUTPUTS = Object.keys(SERVICE_CHAINS);
const DOMAIN_OUTPUTS = ['api', 'web', 'agent'];

function fail(reason) {
  return { passed: false, reason };
}

function getDetectionOutput(results, service) {
  return results?.outputs?.[service] ?? results?.[service];
}

function getConclusion(results, job) {
  return results?.jobs?.[job] ?? results?.[job];
}

export function evaluateCiStatus(results, options = {}) {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) {
    return fail('results must be an object');
  }

  const detectionConclusion = getConclusion(results, 'detect-changes');
  if (detectionConclusion !== 'success') {
    return fail(`detect-changes concluded ${String(detectionConclusion)}, expected success`);
  }

  const outputs = {};
  for (const service of DETECTION_OUTPUTS) {
    const rawOutput = getDetectionOutput(results, service);
    // Older callers predate the security aggregate. Treat an entirely absent
    // security route as unchanged, while still rejecting a partially supplied
    // security route below.
    const output =
      service === 'security' && rawOutput === undefined &&
      getConclusion(results, 'security-sast') === undefined &&
      getConclusion(results, 'security-supply-chain') === undefined
        ? 'false'
        : rawOutput;
    if (output !== 'true' && output !== 'false') {
      return fail(`${service} detection output must be the exact string true or false`);
    }
    outputs[service] = output;
  }

  for (const [service, jobs] of Object.entries(SERVICE_CHAINS)) {
    const expectedConclusion =
      outputs[service] === 'true' ? 'success' : 'skipped';

    for (const job of jobs) {
      const conclusion = getConclusion(results, job);
      if (conclusion !== expectedConclusion) {
        return fail(
          `${job} concluded ${String(conclusion)}, expected ${expectedConclusion} because ${service} is ${getDetectionOutput(results, service)}`,
        );
      }
    }
  }

  if (outputs.security === 'true') {
    const reportDirectory =
      options.securityReportDirectory ??
      results.securityReportDirectory ??
      process.env.SECURITY_REPORT_DIRECTORY ??
      'artifacts/security';
    const evaluator = options.evaluateSecurityResults ?? evaluateSecurityResults;
    let securityEvaluation;
    try {
      securityEvaluation = evaluator({
        directory: reportDirectory,
        scope: 'static',
        currentDate: options.currentDate ?? process.env.SECURITY_CURRENT_DATE,
        maxAdvisoryAgeHours:
          options.maxAdvisoryAgeHours ??
          (process.env.SECURITY_MAX_ADVISORY_AGE_HOURS
            ? Number(process.env.SECURITY_MAX_ADVISORY_AGE_HOURS)
            : 24),
      });
    } catch (error) {
      return fail(`security static report evaluation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!securityEvaluation || securityEvaluation.passed !== true) {
      const details = securityEvaluation?.errors?.join('; ') || 'static report evaluation failed';
      return fail(`security static report evaluation failed: ${details}`);
    }
  }

  const anyDomainChanged = DOMAIN_OUTPUTS.some((service) => outputs[service] === 'true');
  const expectedSmokeAndSanityConclusion = anyDomainChanged ? 'success' : 'skipped';
  const smokeAndSanityConclusion = getConclusion(results, 'smoke-and-sanity');

  if (smokeAndSanityConclusion !== expectedSmokeAndSanityConclusion) {
    return fail(
      `smoke-and-sanity concluded ${String(smokeAndSanityConclusion)}, expected ${expectedSmokeAndSanityConclusion} because ${anyDomainChanged ? 'at least one domain changed' : 'all domains are unchanged'}`,
    );
  }

  return { passed: true, reason: 'all required CI jobs reached their expected conclusions' };
}

function parseCliInput(argv, stdin) {
  if (process.env.DETECT_CHANGES_RESULT !== undefined) {
    return {
      'detect-changes': process.env.DETECT_CHANGES_RESULT,
      api: process.env.API_CHANGED,
      web: process.env.WEB_CHANGED,
      agent: process.env.AGENT_CHANGED,
      security: process.env.SECURITY_CHANGED,
      'api-gate': process.env.API_GATE_RESULT,
      'api-unit-tests': process.env.API_UNIT_TESTS_RESULT,
      'api-interface-tests': process.env.API_INTERFACE_TESTS_RESULT,
      'api-integration-tests': process.env.API_INTEGRATION_TESTS_RESULT,
      'api-performance-tests': process.env.API_PERFORMANCE_TESTS_RESULT,
      'web-gate': process.env.WEB_GATE_RESULT,
      'web-build': process.env.WEB_BUILD_RESULT,
      'web-unit-tests': process.env.WEB_UNIT_TESTS_RESULT,
      'web-interface-tests': process.env.WEB_INTERFACE_TESTS_RESULT,
      'agent-gate': process.env.AGENT_GATE_RESULT,
      'agent-unit-tests': process.env.AGENT_UNIT_TESTS_RESULT,
      'agent-integration-tests': process.env.AGENT_INTEGRATION_TESTS_RESULT,
      'agent-performance-tests': process.env.AGENT_PERFORMANCE_TESTS_RESULT,
      'security-sast': process.env.SECURITY_SAST_RESULT,
      'security-supply-chain': process.env.SECURITY_SUPPLY_CHAIN_RESULT,
      'smoke-and-sanity': process.env.SMOKE_AND_SANITY_RESULT,
      securityReportDirectory: process.env.SECURITY_REPORT_DIRECTORY,
    };
  }
  const input = argv[2] ?? stdin.trim();
  if (!input) {
    throw new Error('provide a JSON result object as the first argument or via stdin');
  }
  return JSON.parse(input);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--help' || process.argv[2] === '-h') {
    process.stdout.write('Usage: node scripts/ci/evaluate-ci-status.mjs [results-json]\n');
  } else {
    try {
      const stdin =
        process.argv[2] === undefined && process.env.DETECT_CHANGES_RESULT === undefined
          ? readFileSync(0, 'utf8')
          : '';
      const result = evaluateCiStatus(parseCliInput(process.argv, stdin));
      process.stdout.write(`${JSON.stringify(result)}\n`);
      process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify(fail(error instanceof Error ? error.message : String(error)))}\n`,
      );
      process.exitCode = 1;
    }
  }
}
