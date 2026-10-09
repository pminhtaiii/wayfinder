import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  extractAdvisoryIdentifiers,
  loadDependencyAdvisoryRegister,
  loadIgnoredGhas,
  main,
  normalisePnpmAudit,
  runSupplyChainScan,
} from '../../scripts/security/run-supply-chain.mjs';
import { evaluateSupplyChain } from '../../scripts/security/evaluate-results.mjs';

test('writes a versioned clean report through the public scan interface', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-clean-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      execFn: (command) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        return { status: 0, stdout: '[]', stderr: '' };
      },
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      rawReportDir: join(tempDir, 'raw-reports'),
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.passed, true);
    assert.equal(result.report.version, '1.0.0');
    assert.deepEqual(result.report.counts, {
      Critical: 0,
      High: 0,
      Medium: 0,
      Low: 0,
      Informational: 0,
    });
    assert.ok(result.report.pipAudit);
    assert.ok(result.report.pnpmAudit);
    assert.ok(result.report.gitleaks);
    assert.equal(result.report.pipAudit.freshness.advisoryDatabaseTimestamp, undefined);
    assert.equal(result.report.pipAudit.freshness.advisoryQueriedAt, '2026-09-11T00:00:00.000Z');
    assert.equal(result.report.pnpmAudit.freshness.advisoryDatabaseTimestamp, undefined);
    assert.equal(result.report.pnpmAudit.freshness.advisoryQueriedAt, '2026-09-11T00:00:00.000Z');
    assert.equal(
      evaluateSupplyChain(result.report, { currentDate: '2026-09-11T00:00:00.000Z' }).passed,
      true,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('exports the locked agent dependency set before invoking pinned pip-audit', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-contract-'));
  const calls = [];
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        calls.push({ command, args });
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen agent requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0, result.errors.join('; '));
    const uvCalls = calls.filter(({ command }) => command === 'uv');
    assert.equal(uvCalls.length, 2);
    assert.deepEqual(uvCalls[0].args.slice(0, 8), [
      'export',
      '--package',
      'agent',
      '--locked',
      '--no-dev',
      '--format',
      'requirements-txt',
      '--output-file',
    ]);
    assert.equal(uvCalls[0].args[8], join(tempDir, 'raw', 'agent-requirements.txt'));
    assert.deepEqual(uvCalls[1].args.slice(0, 7), [
      'tool',
      'run',
      '--from',
      'pip-audit==2.7.3',
      'pip-audit',
      '--requirement',
      join(tempDir, 'raw', 'agent-requirements.txt'),
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('does not reuse an advisory cache when an explicit raw report directory is reused', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-cache-reuse-'));
  const rawReportDir = join(tempDir, 'raw');
  const cacheDirs = [];
  const execFn = (command, args) => {
    if (command === 'pnpm') return { status: 0, stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }), stderr: '' };
    if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'export') return { status: 0, stdout: '# requirements\n', stderr: '' };
    const cacheIndex = args.indexOf('--cache-dir');
    if (cacheIndex >= 0) cacheDirs.push(args[cacheIndex + 1]);
    return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
  };
  try {
    for (let index = 0; index < 2; index += 1) {
      const result = runSupplyChainScan({
        rootDir: process.cwd(),
        output: join(tempDir, `report-${index}.json`),
        strict: false,
        rawReportDir,
        execFn,
        now: () => new Date('2026-09-11T00:00:00.000Z'),
      });
      assert.equal(result.exitCode, 0);
    }
    assert.equal(cacheDirs.length, 2);
    assert.notEqual(cacheDirs[0], cacheDirs[1]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('runs Gitleaks over all history and the current working tree separately', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-gitleaks-'));
  const gitleaksCalls = [];
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      execFn: (command, args) => {
        if (command === 'gitleaks') gitleaksCalls.push(args);
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0, result.errors.join('; '));
    assert.equal(gitleaksCalls.length, 2);
    assert.ok(gitleaksCalls[0].includes('--log-opts=--all'));
    assert.ok(!gitleaksCalls[0].includes('--no-git'));
    assert.ok(gitleaksCalls[1].includes('--no-git'));
    assert.ok(!gitleaksCalls[1].includes('--log-opts=--all'));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('normalizes blocking vulnerabilities and redacts constructed secret controls', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-findings-'));
  const secretCanary = 'constructed-runtime-secret-9f5f';
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 1,
            stdout: JSON.stringify({
              advisories: {
                1001: {
                  id: 1001,
                  module_name: 'fixture-package',
                  severity: 'high',
                  title: 'Synthetic package vulnerability',
                },
              },
              metadata: { vulnerabilities: { high: 1 } },
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') {
          return {
            status: 1,
            stdout: JSON.stringify([
              {
                RuleID: 'jwt-secret',
                File: 'apps/api/src/config.ts',
                StartLine: 7,
                Secret: secretCanary,
                Match: secretCanary,
              },
            ]),
            stderr: '',
          };
        }
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return {
          status: 1,
          stdout: JSON.stringify({
            dependencies: [
              {
                name: 'fixture-python-package',
                version: '1.0.0',
                vulns: [
                  {
                    id: 'CVE-2099-0001',
                    severity: 'critical',
                    description: 'Synthetic Python vulnerability',
                  },
                ],
              },
            ],
          }),
          stderr: '',
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.equal(result.counts.Critical, 2);
    assert.equal(result.counts.High, 1);
    assert.equal(result.findings.length, 3);
    const serialized = JSON.stringify(result.report);
    assert.doesNotMatch(serialized, new RegExp(secretCanary));
    assert.doesNotMatch(serialized, /"(?:Secret|Match)"/);
    assert.ok(result.report.findings.every((finding) => finding.fingerprint.length === 64));
    const evaluation = evaluateSupplyChain(result.report, {
      currentDate: '2026-09-11T00:00:00.000Z',
    });
    assert.equal(evaluation.passed, false);
    assert.ok(evaluation.errors.some((error) => error.includes('Critical')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails closed on malformed reports and unavailable scanner execution while persisting evidence', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-errors-'));
  const outputPath = join(tempDir, 'supply-chain.json');
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: outputPath,
      strict: true,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'gitleaks') {
          const error = new Error('spawnSync gitleaks ENOENT');
          error.code = 'ENOENT';
          throw error;
        }
        if (command === 'pnpm') return { status: 1, stdout: '', stderr: 'registry unavailable' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: 'not-json', stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes('Parse Error')));
    assert.ok(result.errors.some((error) => error.includes('unavailable')));
    assert.ok(existsSync(outputPath));
    const persisted = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(persisted.version, '1.0.0');
    assert.ok(Array.isArray(persisted.errors));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails strict scans when an emitted advisory timestamp is stale', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-stale-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: true,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 0,
            stdout: JSON.stringify({
              advisories: {},
              metadata: { vulnerabilities: {} },
              advisoryDatabaseTimestamp: '2026-09-01T00:00:00.000Z',
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return {
          status: 0,
          stdout: JSON.stringify({
            dependencies: [],
            advisoryDatabaseTimestamp: '2026-09-01T00:00:00.000Z',
          }),
          stderr: '',
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.equal(
      result.report.pipAudit.freshness.advisoryDatabaseTimestamp,
      '2026-09-01T00:00:00.000Z',
    );
    assert.ok(result.errors.filter((error) => error.includes('Freshness Error')).length >= 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('fails closed when the sanitized report cannot be written', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-write-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: tempDir,
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      execFn: (command, args) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.ok(result.errors.some((error) => error.includes('Report Error')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('supports the strict CLI contract and rejects unknown options', () => {
  let exitCode;
  const helpLogs = [];
  assert.equal(
    main(['--help'], {
      exitFn: (code) => {
        exitCode = code;
        return code;
      },
      logFn: (message) => helpLogs.push(message),
      errFn: () => {},
    }),
    0,
  );
  assert.equal(exitCode, 0);
  assert.match(helpLogs.join('\n'), /--output/);

  const errors = [];
  assert.equal(
    main(['--unknown'], {
      exitFn: (code) => code,
      logFn: () => {},
      errFn: (message) => errors.push(message),
    }),
    1,
  );
  assert.match(errors.join('\n'), /Unknown option/);
});

test('filters ignored GHSA advisories from package.json and suppresses policy failure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-ignore-pass-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 1,
            stdout: JSON.stringify({
              advisories: {
                1105461: {
                  id: 1105461,
                  module_name: 'next',
                  severity: 'critical',
                  title: 'Next.js Image Optimization RCE',
                  url: 'https://github.com/advisories/GHSA-2xp9-vwfh-vxw4',
                  via: [
                    {
                      source: 1105461,
                      name: 'next',
                      url: 'https://github.com/advisories/GHSA-2xp9-vwfh-vxw4',
                      severity: 'critical',
                    },
                  ],
                },
                1105462: {
                  id: 'GHSA-36xv-jgw5-4q75',
                  module_name: '@nestjs/core',
                  severity: 'high',
                  title: '@nestjs/core injection vulnerability',
                },
              },
              metadata: {
                vulnerabilities: {
                  critical: 1,
                  high: 1,
                },
              },
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.passed, true);
    assert.equal(result.counts.Critical, 0);
    assert.equal(result.counts.High, 0);
    assert.equal(result.findings.length, 0);
    assert.ok(result.report.ignoredAdvisories.includes('GHSA-2XP9-VWFH-VXW4'));
    assert.ok(result.report.ignoredAdvisories.includes('GHSA-36XV-JGW5-4Q75'));
    assert.equal(result.report.pnpmAudit.ignoredFindings.length, 2);
    assert.ok(
      result.report.pnpmAudit.ignoredFindings.some(
        (finding) =>
          finding.ignoredReason.includes('GHSA-2xp9-vwfh-vxw4') ||
          finding.ignoredReason.includes('GHSA-2XP9-VWFH-VXW4'),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('includes unignored GHSA advisories in findings and causes policy failure', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-ignore-fail-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      rawReportDir: join(tempDir, 'raw'),
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm') {
          return {
            status: 1,
            stdout: JSON.stringify({
              advisories: {
                9999: {
                  id: 'GHSA-9999-9999-9999',
                  module_name: 'untrusted-package',
                  severity: 'high',
                  title: 'Unregistered high vulnerability',
                },
              },
              metadata: {
                vulnerabilities: {
                  high: 1,
                },
              },
            }),
            stderr: '',
          };
        }
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.equal(result.counts.High, 1);
    assert.equal(result.counts.Critical, 0);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].id, 'GHSA-9999-9999-9999');
    assert.ok(result.errors.some((err) => err.includes('High finding(s)')));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadIgnoredGhas reads from package.json, pnpm-workspace.yaml, and options', () => {
  const ignored = loadIgnoredGhas(process.cwd(), {
    ignoreGhas: ['GHSA-custom-1111-2222'],
  });
  assert.ok(ignored instanceof Set);
  assert.ok(ignored.has('GHSA-2XP9-VWFH-VXW4'));
  assert.ok(ignored.has('GHSA-CUSTOM-1111-2222'));
  assert.ok(ignored.size >= 98);
});

test('extractAdvisoryIdentifiers extracts all candidate IDs from advisory metadata', () => {
  const ids = extractAdvisoryIdentifiers('pkg-key', {
    id: 1105461,
    github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
    cve: 'CVE-2026-0001',
    url: 'https://github.com/advisories/GHSA-dddd-eeee-ffff',
    via: [
      'GHSA-gggg-hhhh-iiii',
      {
        source: 'GHSA-jjjj-kkkk-llll',
        url: 'https://github.com/advisories/GHSA-mmmm-nnnn-oooo',
      },
    ],
  });
  assert.ok(ids.includes('pkg-key'));
  assert.ok(ids.includes('1105461'));
  assert.ok(ids.includes('GHSA-aaaa-bbbb-cccc'));
  assert.ok(ids.includes('CVE-2026-0001'));
  assert.ok(ids.includes('GHSA-dddd-eeee-ffff'));
  assert.ok(ids.includes('GHSA-gggg-hhhh-iiii'));
  assert.ok(ids.includes('GHSA-jjjj-kkkk-llll'));
  assert.ok(ids.includes('GHSA-mmmm-nnnn-oooo'));
});

test('normalisePnpmAudit does not synthesize placeholders when explicit advisories are present', () => {
  const raw = JSON.stringify({
    advisories: {
      1001: {
        id: 'GHSA-2XP9-VWFH-VXW4',
        module_name: 'next',
        severity: 'critical',
      },
    },
    metadata: {
      vulnerabilities: {
        critical: 5,
        high: 10,
      },
    },
  });

  const parsed = normalisePnpmAudit(raw, {
    rootDir: process.cwd(),
    ignoredGhas: ['GHSA-2XP9-VWFH-VXW4'],
  });

  assert.equal(parsed.valid, true);
  assert.equal(parsed.findings.length, 0);
  assert.equal(parsed.ignoredFindings.length, 1);
  assert.equal(parsed.counts.Critical, 0);
  assert.equal(parsed.counts.High, 0);
});

test('report.exceptions contains structured exception objects with valid expiry dates', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-exceptions-'));
  try {
    const register = loadDependencyAdvisoryRegister(process.cwd());
    assert.equal(register.errors.length, 0);
    // Human-approved 2026-10-03: register includes the locally patched braces advisory.
    assert.equal(register.exceptions.length, 102);

    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 0, result.errors.join('; '));
    assert.equal(result.passed, true);
    assert.ok(Array.isArray(result.report.exceptions));
    assert.equal(result.report.exceptions.length, 102);

    for (const exc of result.report.exceptions) {
      assert.ok(/^GHSA-[A-Z0-9_-]+$/i.test(exc.id));
      assert.equal(exc.ruleId, exc.id);
      assert.ok(exc.package && typeof exc.package === 'string');
      assert.ok(exc.severity && typeof exc.severity === 'string');
      assert.equal(
        exc.rationale,
        'Upstream Next.js 14 -> 15 deferral documented in docs/security/dependency-advisories.md',
      );
      assert.equal(
        exc.compensatingControl,
        'Documented in docs/security/dependency-advisories.md',
      );
      assert.equal(exc.expiry, '2026-10-12T00:00:00.000Z');
      assert.ok(!Number.isNaN(Date.parse(exc.expiry)));
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an expired advisory register (Policy-Expires-At in the past) causes runSupplyChainScan to fail closed with exit code 1', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-expired-'));
  try {
    const result = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.passed, false);
    assert.ok(
      result.errors.some((err) =>
        err.includes('[Supply Chain Exception Error] Dependency advisory deferral policy expired on 2026-10-12T00:00:00.000Z'),
      ),
    );

    const mockDocPath = join(tempDir, 'expired-advisories.md');
    writeFileSync(
      mockDocPath,
      '# Test Advisories\n\n> **Policy-Version**: 1.0.0\n> **Policy-Expires-At**: 2026-08-01T00:00:00.000Z\n\n| GHSA ID | Package | Severity |\n|---|---|---|\n',
      'utf8',
    );
    const customResult = runSupplyChainScan({
      rootDir: process.cwd(),
      advisoriesDocPath: mockDocPath,
      output: join(tempDir, 'supply-chain-custom.json'),
      strict: false,
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });
    assert.equal(customResult.exitCode, 1);
    assert.equal(customResult.passed, false);
    assert.ok(
      customResult.errors.some((err) =>
        err.includes('[Supply Chain Exception Error] Dependency advisory deferral policy expired on 2026-08-01T00:00:00.000Z'),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('an uncataloged GHSA in options.ignoreGhas / package.json fails closed if not documented', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-uncataloged-'));
  try {
    const resultFromOptions = runSupplyChainScan({
      rootDir: process.cwd(),
      output: join(tempDir, 'supply-chain.json'),
      strict: false,
      ignoreGhas: ['GHSA-uncataloged-9999-xxxx'],
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: (command, args) => {
        if (command === 'pnpm')
          return {
            status: 0,
            stdout: JSON.stringify({ advisories: {}, metadata: { vulnerabilities: {} } }),
            stderr: '',
          };
        if (command === 'gitleaks') return { status: 0, stdout: '[]', stderr: '' };
        if (args[0] === 'export')
          return { status: 0, stdout: '# frozen requirements\n', stderr: '' };
        return { status: 0, stdout: JSON.stringify({ dependencies: [] }), stderr: '' };
      },
    });

    assert.equal(resultFromOptions.exitCode, 1);
    assert.equal(resultFromOptions.passed, false);
    assert.ok(
      resultFromOptions.errors.some((err) =>
        err.includes('[Supply Chain Policy Failure] Found uncataloged GHSA ignore: GHSA-UNCATALOGED-9999-XXXX without compensating controls'),
      ),
    );

    const ignoredDirect = loadIgnoredGhas(process.cwd(), {
      ignoreGhas: ['GHSA-fake-8888-yyyy'],
    });
    assert.ok(
      ignoredDirect.errors.some((err) =>
        err.includes('[Supply Chain Policy Failure] Found uncataloged GHSA ignore: GHSA-FAKE-8888-YYYY without compensating controls'),
      ),
    );

    const fakeProjectDir = join(tempDir, 'fake-project');
    mkdirSync(fakeProjectDir, { recursive: true });
    writeFileSync(
      join(fakeProjectDir, 'package.json'),
      JSON.stringify({
        pnpm: {
          auditConfig: {
            ignoreGhas: ['GHSA-fake-pkg-json-0001'],
          },
        },
      }),
      'utf8',
    );
    const resultFromPkg = runSupplyChainScan({
      rootDir: fakeProjectDir,
      output: join(tempDir, 'supply-chain-pkg.json'),
      strict: false,
      now: () => new Date('2026-09-11T00:00:00.000Z'),
      execFn: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });
    assert.equal(resultFromPkg.exitCode, 1);
    assert.equal(resultFromPkg.passed, false);
    assert.ok(
      resultFromPkg.errors.some((err) =>
        err.includes('[Supply Chain Policy Failure] Found uncataloged GHSA ignore: GHSA-FAKE-PKG-JSON-0001 without compensating controls'),
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const bracesPatchRelativePath = 'scripts/patches/braces@3.0.3.patch';
const bracesPatchAdvisory = 'GHSA-VFJ7-8CJW-P6XM';

function copyBracesScannerFixture(rootDir) {
  const sourceRoot = process.cwd();
  for (const relativePath of [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'docs/security/dependency-advisories.md',
    bracesPatchRelativePath,
  ]) {
    const destination = join(rootDir, relativePath);
    mkdirSync(join(destination, '..'), { recursive: true });
    writeFileSync(destination, readFileSync(join(sourceRoot, relativePath)));
  }
}

function replaceWorkspacePatchPath(content, replacement) {
  return content.replace(
    /(^patchedDependencies:\r?\n[\s\S]*?^\s{2}['"]?braces@3\.0\.3['"]?:\s*)[^\r\n]+/m,
    `$1${replacement}`,
  );
}

function replaceLockPatchHash(content) {
  return content.replace(
    /(^patchedDependencies:\r?\n[\s\S]*?^\s{2}['"]?braces@3\.0\.3['"]?:\r?\n\s{4}hash:\s*)[^\r\n]+/m,
    // Human-approved 2026-10-03: pnpm 10 lock hashes use SHA-256 hex.
    `$1${'0'.repeat(64)}`,
  );
}

function removeLockPatchHash(content) {
  return content.replace(
    /(^patchedDependencies:\r?\n[\s\S]*?^\s{2}['"]?braces@3\.0\.3['"]?:\r?\n)\s{4}hash:[^\r\n]*\r?\n/m,
    '$1',
  );
}

function replaceLockPatchPath(content, replacement) {
  return content.replace(
    /(^patchedDependencies:\r?\n[\s\S]*?^\s{2}['"]?braces@3\.0\.3['"]?:\r?\n\s{4}hash:\s*[^\r\n]+\r?\n\s{4}path:\s*)[^\r\n]+/m,
    `$1${replacement}`,
  );
}

function removeLockPatchPath(content) {
  return content.replace(
    /(^patchedDependencies:\r?\n[\s\S]*?^\s{2}['"]?braces@3\.0\.3['"]?:\r?\n\s{4}hash:\s*[^\r\n]+\r?\n)\s{4}path:[^\r\n]*\r?\n/m,
    '$1',
  );
}

test('ignores the braces advisory only when its reviewed patch and registrations match', () => {
  const valid = loadIgnoredGhas(process.cwd());
  assert.ok(valid.has(bracesPatchAdvisory));
  assert.deepEqual(valid.errors, []);

  const mutations = [
    ['missing patch', (rootDir) => rmSync(join(rootDir, bracesPatchRelativePath), { force: true })],
    [
      'modified patch',
      (rootDir) => {
        const patchPath = join(rootDir, bracesPatchRelativePath);
        writeFileSync(patchPath, `${readFileSync(patchPath, 'utf8')}\n`, 'utf8');
      },
    ],
    [
      'manifest ignore list',
      (rootDir) => {
        const manifestPath = join(rootDir, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.pnpm.auditConfig.ignoreGhas = manifest.pnpm.auditConfig.ignoreGhas.filter(
          (id) => id.toUpperCase() !== bracesPatchAdvisory,
        );
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      },
    ],
    [
      'workspace ignore list',
      (rootDir) => {
        const workspacePath = join(rootDir, 'pnpm-workspace.yaml');
        const workspace = readFileSync(workspacePath, 'utf8');
        const changed = workspace.replace(
          '    - GHSA-vfj7-8cjw-p6xm',
          '    - GHSA-vfj7-8cjw-p6xm-removed',
        );
        assert.notEqual(changed, workspace, 'workspace advisory ignore must exist in fixture');
        writeFileSync(workspacePath, changed, 'utf8');
      },
    ],
    [
      'manifest registration',
      (rootDir) => {
        const manifestPath = join(rootDir, 'package.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.pnpm.patchedDependencies['braces@3.0.3'] = 'scripts/patches/unregistered.patch';
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      },
    ],
    [
      'workspace registration',
      (rootDir) => {
        const workspacePath = join(rootDir, 'pnpm-workspace.yaml');
        const workspace = readFileSync(workspacePath, 'utf8');
        const changed = replaceWorkspacePatchPath(workspace, 'scripts/patches/unregistered.patch');
        assert.notEqual(changed, workspace, 'workspace patch entry must exist in fixture');
        writeFileSync(workspacePath, changed, 'utf8');
      },
    ],
    [
      'lock hash binding',
      (rootDir) => {
        const lockPath = join(rootDir, 'pnpm-lock.yaml');
        const lock = readFileSync(lockPath, 'utf8');
        const changed = replaceLockPatchHash(lock);
        assert.notEqual(changed, lock, 'lock patch hash must exist in fixture');
        writeFileSync(lockPath, changed, 'utf8');
      },
    ],
    [
      'missing lock hash',
      (rootDir) => {
        const lockPath = join(rootDir, 'pnpm-lock.yaml');
        const lock = readFileSync(lockPath, 'utf8');
        const changed = removeLockPatchHash(lock);
        assert.notEqual(changed, lock, 'lock patch hash must exist in fixture');
        writeFileSync(lockPath, changed, 'utf8');
      },
    ],
    [
      'lock path binding',
      (rootDir) => {
        const lockPath = join(rootDir, 'pnpm-lock.yaml');
        const lock = readFileSync(lockPath, 'utf8');
        const changed = replaceLockPatchPath(lock, 'scripts/patches/unregistered.patch');
        assert.notEqual(changed, lock, 'lock patch path must exist in fixture');
        writeFileSync(lockPath, changed, 'utf8');
      },
    ],
    [
      'missing lock path',
      (rootDir) => {
        const lockPath = join(rootDir, 'pnpm-lock.yaml');
        const lock = readFileSync(lockPath, 'utf8');
        const changed = removeLockPatchPath(lock);
        assert.notEqual(changed, lock, 'lock patch path must exist in fixture');
        writeFileSync(lockPath, changed, 'utf8');
      },
    ],
  ];

  for (const [label, mutate] of mutations) {
    const tempDir = mkdtempSync(join(tmpdir(), 'supply-chain-braces-patch-'));
    try {
      copyBracesScannerFixture(tempDir);
      mutate(tempDir);

      const ignored = loadIgnoredGhas(tempDir);
      assert.equal(ignored.has(bracesPatchAdvisory), false, `${label} must not be ignored`);
      assert.ok(
        ignored.errors.some((error) => error.includes('reviewed braces patch')),
        `${label} must produce a fail-closed patch error`,
      );
      assert.ok(ignored.has('GHSA-2XP9-VWFH-VXW4'), 'other registered exceptions remain active');

      const audit = normalisePnpmAudit(
        JSON.stringify({
          advisories: {
            'braces@3.0.3': {
              id: bracesPatchAdvisory,
              module_name: 'braces',
              severity: 'high',
            },
          },
        }),
        {
          ignoredGhas: new Set([...ignored, bracesPatchAdvisory]),
          rootDir: tempDir,
        },
      );
      assert.equal(audit.findings.length, 1, `${label} must leave the advisory active`);
      assert.equal(audit.counts.High, 1, `${label} must retain high severity`);
      assert.equal(audit.ignoredFindings.length, 0, `${label} must not classify it as ignored`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
