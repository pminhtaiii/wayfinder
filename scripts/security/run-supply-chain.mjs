import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { redactSensitiveText, stripDisallowedFields } from './write-report.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultRepoRoot = resolve(__dirname, '..', '..');

const REPORT_VERSION = '1.0.0';
const PIP_AUDIT_VERSION = '2.7.3';
const DEFAULT_OUTPUT = 'artifacts/security/supply-chain.json';
const PIP_MAX_ADVISORY_AGE_HOURS = 24;
const VERIFIED_BRACES_ADVISORY = 'GHSA-VFJ7-8CJW-P6XM';
const VERIFIED_BRACES_PACKAGE = 'braces@3.0.3';
const VERIFIED_BRACES_PATCH_PATH = 'scripts/patches/braces@3.0.3.patch';
const VERIFIED_BRACES_PATCH_SHA256 =
  '795ff4ec62054830af82791060bccad7e6b551a7399488cbbd5dcb6017931861';
const VERIFIED_BRACES_PATCH_ERROR = `[Supply Chain Exception Error] ${VERIFIED_BRACES_ADVISORY} requires the registered, SHA-256-pinned reviewed braces patch`;

function emptyCounts() {
  return {
    Critical: 0,
    High: 0,
    Medium: 0,
    Low: 0,
    Informational: 0,
  };
}

function makeCounts(findings = []) {
  const counts = emptyCounts();
  for (const finding of findings) {
    if (finding && Object.hasOwn(counts, finding.severity)) counts[finding.severity] += 1;
  }
  return counts;
}

function parseJson(raw, label) {
  if (raw && typeof raw === 'object') return { value: raw, error: null };
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { value: null, error: `[${label} Parse Error] Scanner returned no JSON evidence` };
  }

  const text = raw.trim();
  try {
    return { value: JSON.parse(text), error: null };
  } catch {
    // Scanner loggers sometimes prefix a JSON report. Only parse a bounded JSON
    // slice; no raw scanner output is ever copied into the resulting report.
    const starts = [text.indexOf('['), text.indexOf('{')]
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    const start = starts[0];
    const end = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (start >= 0 && end > start) {
      try {
        return { value: JSON.parse(text.slice(start, end + 1)), error: null };
      } catch {
        // Fall through to the safe generic error below.
      }
    }
    return {
      value: null,
      error: `[${label} Parse Error] Scanner returned malformed JSON evidence`,
    };
  }
}

function isoTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function safeNow(nowFn) {
  return (
    isoTimestamp(typeof nowFn === 'function' ? nowFn() : new Date()) || new Date().toISOString()
  );
}

function normalizeSeverity(value, fallback = 'Informational') {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 9) return 'Critical';
    if (value >= 7) return 'High';
    if (value >= 4) return 'Medium';
    if (value > 0) return 'Low';
    return 'Informational';
  }

  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized.includes('critical') || normalized === 'crit') return 'Critical';
  if (normalized.includes('high') || normalized === 'error') return 'High';
  if (normalized.includes('moderate') || normalized.includes('medium') || normalized === 'warning')
    return 'Medium';
  if (normalized.includes('low')) return 'Low';
  if (normalized.includes('info')) return 'Informational';
  return fallback;
}

function safeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = redactSensitiveText(String(value));
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function safeFile(value, fallback = 'unknown-file') {
  const text = safeText(value, fallback).replaceAll('\\', '/');
  return text || fallback;
}

function safeLine(value) {
  const line = Number(value);
  return Number.isInteger(line) && line > 0 ? line : 1;
}

function fingerprintFor(scanner, id, file, line, message) {
  return createHash('sha256').update(`${scanner}|${id}|${file}|${line}|${message}`).digest('hex');
}

function normalizedFinding({ scanner, id, severity, file, line, message }) {
  const ruleId = safeText(id, 'unknown-rule');
  const normalizedFile = safeFile(file);
  const normalizedLine = safeLine(line);
  const normalizedMessage = safeText(message, `${scanner} finding`);
  return {
    id: ruleId,
    ruleId,
    scanner,
    severity: normalizeSeverity(severity),
    file: normalizedFile,
    line: normalizedLine,
    message: normalizedMessage,
    fingerprint: fingerprintFor(scanner, ruleId, normalizedFile, normalizedLine, normalizedMessage),
  };
}

function advisoryTimestampFrom(value) {
  if (!value || typeof value !== 'object') return null;
  const candidates = [
    value.advisoryDatabaseTimestamp,
    value.advisory_database_timestamp,
    value.databaseTimestamp,
    value.database_timestamp,
    value.auditTimestamp,
    value.audit_timestamp,
    value.generatedAt,
    value.generated_at,
    value.metadata?.advisoryDatabaseTimestamp,
    value.metadata?.advisory_database_timestamp,
    value.metadata?.databaseTimestamp,
    value.metadata?.database_timestamp,
    value.metadata?.auditTimestamp,
    value.metadata?.audit_timestamp,
  ];
  for (const candidate of candidates) {
    const timestamp = isoTimestamp(candidate);
    if (timestamp) return timestamp;
  }
  return null;
}

function freshnessRecord({
  source,
  mode,
  checkedAt,
  maxAdvisoryAgeHours,
  advisoryDatabaseTimestamp,
  advisoryQueriedAt,
  advisoryTimestampKind,
  advisoryTimestampEvidence,
  usedOfflineCache,
}) {
  const freshness = {
    source,
    mode,
    checkedAt,
    usedOfflineCache: usedOfflineCache === true,
  };
  if (maxAdvisoryAgeHours !== undefined) freshness.maxAdvisoryAgeHours = maxAdvisoryAgeHours;
  if (advisoryDatabaseTimestamp) freshness.advisoryDatabaseTimestamp = advisoryDatabaseTimestamp;
  if (advisoryQueriedAt) freshness.advisoryQueriedAt = advisoryQueriedAt;
  if (advisoryTimestampKind) freshness.advisoryTimestampKind = advisoryTimestampKind;
  if (advisoryTimestampEvidence) freshness.advisoryTimestampEvidence = advisoryTimestampEvidence;
  return freshness;
}

function normalisePipAudit(raw, options = {}) {
  const parsed = parseJson(raw, 'pip-audit');
  if (parsed.error) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: [parsed.error],
      freshness: null,
    };
  }
  const data = parsed.value;
  const dependencies = Array.isArray(data)
    ? data
    : data && Array.isArray(data.dependencies)
      ? data.dependencies
      : null;
  if (!dependencies) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: ['[pip-audit Parse Error] Expected a dependencies array'],
      freshness: null,
    };
  }

  const findings = [];
  for (const dependency of dependencies) {
    if (!dependency || typeof dependency !== 'object') continue;
    const vulnerabilities = Array.isArray(dependency.vulns)
      ? dependency.vulns
      : Array.isArray(dependency.vulnerabilities)
        ? dependency.vulnerabilities
        : [];
    for (const vulnerability of vulnerabilities) {
      if (!vulnerability || typeof vulnerability !== 'object') continue;
      const id =
        vulnerability.id ||
        vulnerability.aliases?.[0] ||
        `pip-audit:${dependency.name || 'unknown'}`;
      const description =
        vulnerability.description ||
        `Known vulnerability in ${dependency.name || 'Python dependency'}`;
      findings.push(
        normalizedFinding({
          scanner: 'pip-audit',
          id,
          severity: vulnerability.severity ?? vulnerability.cvss,
          fallback: 'High',
          file: 'apps/agent/pyproject.toml',
          line: 1,
          message: `${dependency.name || 'Python dependency'}: ${description}`,
        }),
      );
      findings[findings.length - 1].severity = normalizeSeverity(
        vulnerability.severity ?? vulnerability.cvss,
        'High',
      );
    }
  }

  const advisoryDatabaseTimestamp =
    advisoryTimestampFrom(data) || isoTimestamp(options.advisoryDatabaseTimestamp);
  const freshness = freshnessRecord({
    source: 'PyPI advisory database via pip-audit',
    mode: data?.freshness?.mode || 'live',
    checkedAt: options.checkedAt,
    maxAdvisoryAgeHours: PIP_MAX_ADVISORY_AGE_HOURS,
    advisoryDatabaseTimestamp,
    advisoryQueriedAt: options.advisoryQueriedAt,
    advisoryTimestampKind: options.advisoryTimestampKind,
    advisoryTimestampEvidence: options.advisoryTimestampEvidence,
    usedOfflineCache: data?.freshness?.usedOfflineCache,
  });
  return { valid: true, counts: makeCounts(findings), findings, errors: [], freshness };
}

function advisoryEntries(data) {
  const entries = [];
  if (data && typeof data.advisories === 'object' && data.advisories !== null) {
    for (const [key, value] of Object.entries(data.advisories)) {
      const values = Array.isArray(value) ? value : [value];
      for (const advisory of values) entries.push({ key, advisory });
    }
  }
  if (data && typeof data.vulnerabilities === 'object' && data.vulnerabilities !== null) {
    for (const [key, value] of Object.entries(data.vulnerabilities)) {
      const values = Array.isArray(value) ? value : [value];
      for (const advisory of values) entries.push({ key, advisory });
    }
  }
  return entries;
}

export function loadDependencyAdvisoryRegister(rootDir, options = {}) {
  const baseDir = resolve(rootDir || defaultRepoRoot);
  let docPath =
    options.advisoriesDocPath ||
    join(baseDir, 'docs', 'security', 'dependency-advisories.md');
  if (!existsSync(docPath) && !options.advisoriesDocPath) {
    const fallback = join(defaultRepoRoot, 'docs', 'security', 'dependency-advisories.md');
    if (existsSync(fallback)) {
      docPath = fallback;
    }
  }

  const errors = [];
  const exceptions = [];
  const catalogedGhas = new Set();
  const catalogedAdvisories = new Map();

  if (!existsSync(docPath)) {
    errors.push(
      `[Supply Chain Exception Error] Dependency advisories register document not found: ${docPath}`,
    );
    return {
      policyVersion: null,
      policyExpiresAt: null,
      catalogedGhas,
      catalogedAdvisories,
      exceptions,
      errors,
    };
  }

  let docContent = '';
  try {
    docContent = readFileSync(docPath, 'utf8');
  } catch {
    errors.push(
      `[Supply Chain Exception Error] Failed to read dependency advisories register: ${docPath}`,
    );
    return {
      policyVersion: null,
      policyExpiresAt: null,
      catalogedGhas,
      catalogedAdvisories,
      exceptions,
      errors,
    };
  }

  const expiresMatch =
    docContent.match(/Policy-Expires-At(?:\*\*|\b)[^:\r\n]*:\s*[`"']?([0-9T:.-]+Z?)[`"']?/i) ||
    docContent.match(/(?:expires[_-]?at|expiry)(?:\*\*|\b)[^:\r\n]*:\s*[`"']?([0-9T:.-]+Z?)[`"']?/i);
  const policyExpiresAt = expiresMatch ? expiresMatch[1].trim() : null;

  const versionMatch = docContent.match(/Policy-Version(?:\*\*|\b)[^:\r\n]*:\s*[`"']?([0-9.]+)[`"']?/i);
  const policyVersion = versionMatch ? versionMatch[1].trim() : '1.0.0';

  if (!policyExpiresAt) {
    errors.push(
      '[Supply Chain Exception Error] Dependency advisory deferral policy missing Policy-Expires-At',
    );
  } else {
    const expiryMs = Date.parse(policyExpiresAt);
    if (Number.isNaN(expiryMs)) {
      errors.push(
        `[Supply Chain Exception Error] Dependency advisory deferral policy has invalid Policy-Expires-At: ${policyExpiresAt}`,
      );
    } else {
      const currentDate = options.currentDate || (options.now ? options.now() : new Date());
      const currentMs = new Date(currentDate).getTime();
      if (currentMs > expiryMs) {
        errors.push(
          `[Supply Chain Exception Error] Dependency advisory deferral policy expired on ${policyExpiresAt}`,
        );
      }
    }
  }

  const lines = docContent.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').map((cell) => cell.trim());
    if (cells.length >= 4) {
      const idCell = cells[1];
      const pkgCell = cells[2];
      const sevCell = cells[3];
      const ghsaMatch = idCell.match(/GHSA-[a-zA-Z0-9_-]+/i);
      if (ghsaMatch) {
        const ghsaId = ghsaMatch[0].toUpperCase();
        const pkgName = pkgCell.replace(/[`*]/g, '').trim();
        const rawSeverity = sevCell.replace(/[`*]/g, '').trim();
        const severity = normalizeSeverity(rawSeverity, 'Medium');
        catalogedGhas.add(ghsaId);
        const exc = {
          id: ghsaId,
          ruleId: ghsaId,
          package: pkgName,
          severity,
          rationale:
            'Upstream Next.js 14 -> 15 deferral documented in docs/security/dependency-advisories.md',
          compensatingControl:
            'Documented in docs/security/dependency-advisories.md',
          expiry: policyExpiresAt,
        };
        catalogedAdvisories.set(ghsaId, exc);
        exceptions.push(exc);
      }
    }
  }

  return {
    policyVersion,
    policyExpiresAt,
    catalogedGhas,
    catalogedAdvisories,
    exceptions,
    errors,
  };
}

function readTopLevelYamlSection(content, name) {
  const lines = content.split(/\r?\n/);
  const headers = lines.flatMap((line, index) =>
    new RegExp(`^${name}:\\s*$`).test(line) ? [index] : [],
  );
  if (headers.length !== 1) return [];
  const header = headers[0];

  let end = header + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() !== '' && !/^\s/.test(line) && !line.startsWith('#')) break;
    end += 1;
  }
  return lines.slice(header + 1, end);
}

function workspacePatchRegistrationMatches(content) {
  const section = readTopLevelYamlSection(content, 'patchedDependencies');
  const matches = section
    .map((line) => line.match(/^\s{2}(['"]?)braces@3\.0\.3\1\s*:\s*(.*?)\s*$/))
    .filter(Boolean);
  return matches.length === 1 && matches[0][2] === VERIFIED_BRACES_PATCH_PATH;
}

function workspaceAuditIgnoreMatches(content) {
  const section = readTopLevelYamlSection(content, 'auditConfig');
  const ignoreHeaders = section.flatMap((line, index) =>
    /^\s{2}ignoreGhas:\s*$/.test(line) ? [index] : [],
  );
  if (ignoreHeaders.length !== 1) return false;
  for (const line of section.slice(ignoreHeaders[0] + 1)) {
    const indentation = line.length - line.trimStart().length;
    if (line.trim() && indentation <= 2) return false;
    if (/^\s{4}-\s*['"]?GHSA-vfj7-8cjw-p6xm['"]?\s*(?:#.*)?$/i.test(line)) return true;
  }
  return false;
}

function lockPatchRegistrationMatches(content) {
  const section = readTopLevelYamlSection(content, 'patchedDependencies');
  const entryIndexes = section.flatMap((line, index) =>
    /^\s{2}braces@3\.0\.3:\s*$/.test(line) ? [index] : [],
  );
  if (entryIndexes.length !== 1) return false;
  const entry = section.slice(entryIndexes[0] + 1, entryIndexes[0] + 3);
  return (
    entry[0] === `    hash: ${VERIFIED_BRACES_PATCH_SHA256}` &&
    entry[1] === `    path: ${VERIFIED_BRACES_PATCH_PATH}`
  );
}

function verifyReviewedBracesPatch(rootDir) {
  try {
    const manifest = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    const workspace = readFileSync(join(rootDir, 'pnpm-workspace.yaml'), 'utf8');
    const lock = readFileSync(join(rootDir, 'pnpm-lock.yaml'), 'utf8');
    const patch = readFileSync(join(rootDir, VERIFIED_BRACES_PATCH_PATH));
    const manifestIgnoreList = manifest.pnpm?.auditConfig?.ignoreGhas;
    const manifestPatch = manifest.pnpm?.patchedDependencies?.[VERIFIED_BRACES_PACKAGE];
    const patchHash = createHash('sha256').update(patch).digest('hex');

    return (
      Array.isArray(manifestIgnoreList) &&
      manifestIgnoreList.some((id) => String(id).toUpperCase() === VERIFIED_BRACES_ADVISORY) &&
      manifestPatch === VERIFIED_BRACES_PATCH_PATH &&
      workspaceAuditIgnoreMatches(workspace) &&
      workspacePatchRegistrationMatches(workspace) &&
      lockPatchRegistrationMatches(lock) &&
      patchHash === VERIFIED_BRACES_PATCH_SHA256
    );
  } catch {
    return false;
  }
}

export function loadIgnoredGhas(rootDir, options = {}) {
  const register = loadDependencyAdvisoryRegister(rootDir, options);
  const errors = [...register.errors];
  const ignored = new Set();
  const configuredGhas = new Set();
  const bracesPatchVerified =
    register.catalogedGhas.has(VERIFIED_BRACES_ADVISORY) &&
    verifyReviewedBracesPatch(resolve(rootDir || defaultRepoRoot));

  if (register.catalogedGhas.has(VERIFIED_BRACES_ADVISORY) && !bracesPatchVerified) {
    errors.push(VERIFIED_BRACES_PATCH_ERROR);
  }

  const explicit = options.ignoreGhas || options.ignoreGhsas || options.ignoredGhas;
  if (explicit) {
    if (typeof explicit === 'string' && explicit.trim()) {
      configuredGhas.add(explicit.trim().toUpperCase());
    } else if (typeof explicit[Symbol.iterator] === 'function') {
      for (const item of explicit) {
        if (typeof item === 'string' && item.trim()) {
          configuredGhas.add(item.trim().toUpperCase());
        }
      }
    }
  }

  const baseDir = resolve(rootDir || defaultRepoRoot);
  const pkgPath = join(baseDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const lists = [
        pkg.pnpm?.auditConfig?.ignoreGhas,
        pkg.pnpm?.auditConfig?.ignoreGhsas,
        pkg.auditConfig?.ignoreGhas,
        pkg.auditConfig?.ignoreGhsas,
      ];
      for (const list of lists) {
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item === 'string' && item.trim()) {
              configuredGhas.add(item.trim().toUpperCase());
            }
          }
        }
      }
    } catch {
      // Safe fallback if package.json cannot be parsed
    }
  }

  const workspacePath = join(baseDir, 'pnpm-workspace.yaml');
  if (existsSync(workspacePath)) {
    try {
      const yamlContent = readFileSync(workspacePath, 'utf8');
      const matches = yamlContent.match(/GHSA-[a-zA-Z0-9_-]+/gi) || [];
      for (const match of matches) {
        configuredGhas.add(match.trim().toUpperCase());
      }
    } catch {
      // Safe fallback if pnpm-workspace.yaml cannot be read
    }
  }

  for (const id of configuredGhas) {
    if (id === VERIFIED_BRACES_ADVISORY && !bracesPatchVerified) continue;
    ignored.add(id);
    if (!register.catalogedGhas.has(id)) {
      errors.push(
        `[Supply Chain Policy Failure] Found uncataloged GHSA ignore: ${id} without compensating controls`,
      );
    }
  }

  ignored.ignoredGhas = ignored;
  ignored.exceptions = register.exceptions;
  ignored.errors = errors;
  ignored.policyExpiresAt = register.policyExpiresAt;
  ignored.policyVersion = register.policyVersion;
  ignored.catalogedGhas = register.catalogedGhas;
  ignored.verifiedBracesPatch = bracesPatchVerified;

  return ignored;
}

export function extractAdvisoryIdentifiers(key, advisory) {
  const identifiers = new Set();
  const addCandidate = (val) => {
    if (val === undefined || val === null) return;
    const str = String(val).trim();
    if (!str) return;
    identifiers.add(str);
    const ghsaMatches = str.match(/GHSA-[a-zA-Z0-9_-]+/gi);
    if (ghsaMatches) {
      for (const match of ghsaMatches) {
        identifiers.add(match.trim());
      }
    }
  };

  addCandidate(key);
  if (advisory && typeof advisory === 'object') {
    addCandidate(advisory.id);
    addCandidate(advisory.github_advisory_id);
    addCandidate(advisory.cve);
    addCandidate(advisory.url);

    const via = Array.isArray(advisory.via)
      ? advisory.via
      : advisory.via !== undefined && advisory.via !== null
        ? [advisory.via]
        : [];
    for (const item of via) {
      if (typeof item === 'string') {
        addCandidate(item);
      } else if (item && typeof item === 'object') {
        addCandidate(item.source);
        addCandidate(item.url);
        addCandidate(item.github_advisory_id);
        addCandidate(item.cve);
        addCandidate(item.name);
        addCandidate(item.id);
      }
    }
  }

  return [...identifiers];
}

export function normalisePnpmAudit(raw, options = {}) {
  const parsed = parseJson(raw, 'pnpm audit');
  if (parsed.error) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      ignoredFindings: [],
      errors: [parsed.error],
      freshness: null,
    };
  }
  const data = parsed.value;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      ignoredFindings: [],
      errors: ['[pnpm audit Parse Error] Expected an audit object'],
      freshness: null,
    };
  }

  const rawIgnored =
    options.ignoredGhas ||
    (options.rootDir
      ? loadIgnoredGhas(options.rootDir, options)
      : loadIgnoredGhas(defaultRepoRoot, options));
  const ignoredGhas =
    rawIgnored instanceof Set
      ? new Set([...rawIgnored].map((id) => String(id).trim().toUpperCase()))
      : new Set(Array.from(rawIgnored || []).map((id) => String(id).trim().toUpperCase()));
  if (ignoredGhas.has(VERIFIED_BRACES_ADVISORY)) {
    const policyIgnored = loadIgnoredGhas(options.rootDir || defaultRepoRoot, options);
    if (!policyIgnored.verifiedBracesPatch) ignoredGhas.delete(VERIFIED_BRACES_ADVISORY);
  }

  const findings = [];
  const ignoredFindings = [];
  for (const { key, advisory } of advisoryEntries(data)) {
    if (!advisory || typeof advisory !== 'object') continue;
    const via = Array.isArray(advisory.via) ? advisory.via : [];
    const viaObject = via.find((item) => item && typeof item === 'object') || {};
    const candidateIds = extractAdvisoryIdentifiers(key, advisory);
    const matchedIgnoredGhsa = candidateIds.find((candidate) =>
      ignoredGhas.has(candidate.toUpperCase()),
    );
    const ghsaId = candidateIds.find((candidate) => /^GHSA-[a-zA-Z0-9_-]+$/i.test(candidate));
    const packageName = advisory.module_name || advisory.package || advisory.name || key;
    const message =
      advisory.title ||
      advisory.overview ||
      viaObject.title ||
      `Known vulnerability in ${packageName || 'Node dependency'}`;

    if (matchedIgnoredGhsa) {
      ignoredFindings.push({
        ...normalizedFinding({
          scanner: 'pnpm-audit',
          id: matchedIgnoredGhsa || ghsaId || advisory.cve || advisory.id || viaObject.source || key || 'pnpm-audit:advisory',
          severity: advisory.severity || viaObject.severity || 'Medium',
          file: 'package.json',
          line: 1,
          message: `${packageName || 'Node dependency'}: ${message}`,
        }),
        ignoredReason: `Matched ignored GHSA advisory ${matchedIgnoredGhsa}`,
      });
    } else {
      const id =
        ghsaId ||
        advisory.cve ||
        advisory.id ||
        viaObject.source ||
        key ||
        'pnpm-audit:advisory';
      findings.push(
        normalizedFinding({
          scanner: 'pnpm-audit',
          id,
          severity: advisory.severity || viaObject.severity || 'Medium',
          file: 'package.json',
          line: 1,
          message: `${packageName || 'Node dependency'}: ${message}`,
        }),
      );
    }
  }

  const hasExplicitAdvisories =
    (data && typeof data.advisories === 'object' && data.advisories !== null) ||
    (data && typeof data.vulnerabilities === 'object' && data.vulnerabilities !== null);
  const metadataCounts = data.metadata?.vulnerabilities;
  if (!hasExplicitAdvisories && metadataCounts && typeof metadataCounts === 'object') {
    const targets = [
      ['critical', 'Critical'],
      ['high', 'High'],
      ['moderate', 'Medium'],
      ['medium', 'Medium'],
      ['low', 'Low'],
      ['info', 'Informational'],
      ['informational', 'Informational'],
    ];
    const represented = makeCounts(findings);
    for (const [sourceKey, severity] of targets) {
      const total = Number(metadataCounts[sourceKey]);
      if (!Number.isInteger(total) || total <= represented[severity]) continue;
      for (let index = represented[severity]; index < total; index += 1) {
        findings.push(
          normalizedFinding({
            scanner: 'pnpm-audit',
            id: `pnpm-audit:${severity.toLowerCase()}:${index + 1}`,
            severity,
            file: 'package.json',
            line: 1,
            message: `${severity} advisory reported by npm registry`,
          }),
        );
      }
      represented[severity] = total;
    }
  }

  const advisoryDatabaseTimestamp =
    advisoryTimestampFrom(data) || isoTimestamp(options.advisoryDatabaseTimestamp);
  const freshness = freshnessRecord({
    source: 'npm advisory registry via pnpm audit',
    mode: data?.freshness?.mode || 'live',
    checkedAt: options.checkedAt,
    maxAdvisoryAgeHours: PIP_MAX_ADVISORY_AGE_HOURS,
    advisoryDatabaseTimestamp,
    advisoryQueriedAt: options.advisoryQueriedAt,
    advisoryTimestampKind: options.advisoryTimestampKind,
    advisoryTimestampEvidence: options.advisoryTimestampEvidence,
    usedOfflineCache: data?.freshness?.usedOfflineCache,
  });
  return { valid: true, counts: makeCounts(findings), findings, ignoredFindings, errors: [], freshness };
}

function normaliseGitleaks(raw, options = {}) {
  const parsed = parseJson(raw, 'gitleaks');
  if (parsed.error) {
    return { valid: false, counts: emptyCounts(), findings: [], errors: [parsed.error] };
  }
  const data = parsed.value;
  const records = Array.isArray(data)
    ? data
    : Array.isArray(data?.findings)
      ? data.findings
      : Array.isArray(data?.Leaks)
        ? data.Leaks
        : Array.isArray(data?.leaks)
          ? data.leaks
          : null;
  if (!records) {
    return {
      valid: false,
      counts: emptyCounts(),
      findings: [],
      errors: ['[gitleaks Parse Error] Expected a findings array'],
    };
  }

  const findings = [];
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ruleId = record.RuleID || record.ruleID || record.ruleId || 'gitleaks-secret';
    const file = record.File || record.file || 'unknown-file';
    const line = record.StartLine || record.startLine || 1;
    // Never copy Secret, Match, Author, Email, Commit, or Message into a report.
    findings.push(
      normalizedFinding({
        scanner: 'gitleaks',
        id: ruleId,
        severity: 'Critical',
        file,
        line,
        message: `Secret detected by gitleaks rule ${ruleId}`,
      }),
    );
  }

  return {
    valid: true,
    counts: makeCounts(findings),
    findings,
    errors: [],
    freshness: freshnessRecord({
      source: 'Gitleaks static detection rules',
      mode: options.mode || 'local',
      checkedAt: options.checkedAt,
      usedOfflineCache: false,
    }),
  };
}

function commandResult(execFn, command, args, rootDir) {
  try {
    const isCmd =
      process.platform === 'win32' &&
      (command === 'pnpm' || command.endsWith('.cmd') || command.endsWith('.bat'));
    const result = execFn(command, args, {
      cwd: rootDir,
      encoding: 'utf8',
      shell: isCmd,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!result || typeof result !== 'object') {
      return { status: null, stdout: '', stderr: '', error: new Error('invalid scanner result') };
    }
    return {
      status: Number.isInteger(result.status) ? result.status : null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      error: result.error || null,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

function executionError(label, result) {
  if (result.error?.code === 'ENOENT')
    return `[${label} Execution Error] Scanner executable unavailable`;
  if (result.error?.code === 'ETIMEDOUT')
    return `[${label} Execution Error] Scanner execution timed out`;
  if (result.error) return `[${label} Execution Error] Scanner execution failed`;
  if (result.status === null || result.status === undefined)
    return `[${label} Execution Error] Scanner did not return an exit status`;
  return `[${label} Execution Error] Scanner exited without parseable evidence (status ${result.status})`;
}

function readReportFile(path) {
  if (!path || !existsSync(path)) return '';
  try {
    const content = readFileSync(path, 'utf8');
    unlinkSync(path);
    return content;
  } catch {
    return '';
  }
}

function prepareRawReportDir(rootDir, requested) {
  if (requested) {
    const dir = isAbsolute(requested) ? requested : resolve(rootDir, requested);
    mkdirSync(dir, { recursive: true });
    return { dir, cleanup: false };
  }
  const dir = mkdtempSync(join(tmpdir(), 'flight-booking-supply-chain-'));
  return { dir, cleanup: true };
}

function runPipAudit(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const rawReportDir =
    options.rawReportDir || mkdtempSync(join(tmpdir(), 'flight-booking-pip-audit-'));
  const ownsReportDir = !options.rawReportDir;
  mkdirSync(rawReportDir, { recursive: true });
  const requirementsPath = join(rawReportDir, 'agent-requirements.txt');
  const reportPath = join(rawReportDir, 'pip-audit.json');
  const cacheDir = mkdtempSync(join(rawReportDir, 'pip-audit-cache-'));
  const errors = [];
  let parsed = null;

  try {
    const exportResult = commandResult(
      execFn,
      'uv',
      [
        'export',
        '--package',
        'agent',
        '--locked',
        '--no-dev',
        '--format',
        'requirements-txt',
        '--output-file',
        requirementsPath,
      ],
      rootDir,
    );
    if (exportResult.error || exportResult.status !== 0) {
      errors.push(executionError('pip-audit lock export', exportResult));
    } else {
      if (!existsSync(requirementsPath) && exportResult.stdout) {
        writeFileSync(requirementsPath, exportResult.stdout, 'utf8');
      }
      const auditResult = commandResult(
        execFn,
        'uv',
        [
          'tool',
          'run',
          `--from`,
          `pip-audit==${PIP_AUDIT_VERSION}`,
          'pip-audit',
          '--requirement',
          requirementsPath,
          '--format',
          'json',
          '--output',
          reportPath,
          '--cache-dir',
          cacheDir,
        ],
        rootDir,
      );
      const raw = readReportFile(reportPath) || auditResult.stdout;
      parsed = normalisePipAudit(raw, {
        checkedAt,
        advisoryDatabaseTimestamp:
          options.advisoryDatabaseTimestamp ||
          null,
        advisoryQueriedAt:
          raw.trim() && (auditResult.status === 0 || auditResult.status === 1) ? checkedAt : null,
        advisoryTimestampKind: options.advisoryDatabaseTimestamp ? 'database' : 'queried-at',
        advisoryTimestampEvidence: options.advisoryDatabaseTimestamp
          ? 'scanner-provided advisory database timestamp'
          : 'live registry query observed at checkedAt',
      });
      if (!parsed.valid) errors.push(...parsed.errors);
      if (auditResult.error || (auditResult.status !== 0 && auditResult.status !== 1)) {
        errors.push(executionError('pip-audit', auditResult));
      }
      if ((auditResult.status === 0 || auditResult.status === 1) && !raw.trim()) {
        errors.push('[pip-audit Error] Scanner returned no report evidence');
      }
    }
  } catch {
    errors.push('[pip-audit Execution Error] Scanner execution failed');
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    if (ownsReportDir) rmSync(rawReportDir, { recursive: true, force: true });
  }

  return {
    timestamp: checkedAt,
    advisoryDatabaseTimestamp: parsed?.freshness?.advisoryDatabaseTimestamp || null,
    freshness:
      parsed?.freshness ||
      freshnessRecord({
        source: 'PyPI advisory database via pip-audit',
        mode: 'live',
        checkedAt,
        maxAdvisoryAgeHours: PIP_MAX_ADVISORY_AGE_HOURS,
        advisoryDatabaseTimestamp: null,
        advisoryQueriedAt: null,
        advisoryTimestampKind: 'unknown',
        advisoryTimestampEvidence: 'no successful scanner evidence',
        usedOfflineCache: false,
      }),
    counts: parsed?.counts || emptyCounts(),
    findings: parsed?.findings || [],
    errors,
  };
}

export function runPnpmAudit(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const result = commandResult(
    execFn,
    'pnpm',
    ['audit', '--audit-level', 'moderate', '--json'],
    rootDir,
  );
  const ignoredGhas = options.ignoredGhas || loadIgnoredGhas(rootDir, options);
  const parsed = normalisePnpmAudit(result.stdout, {
    ...options,
    rootDir,
    ignoredGhas,
    checkedAt,
    advisoryDatabaseTimestamp:
      options.advisoryDatabaseTimestamp ||
      null,
    advisoryQueriedAt:
      result.stdout.trim() && (result.status === 0 || result.status === 1) ? checkedAt : null,
    advisoryTimestampKind: options.advisoryDatabaseTimestamp ? 'database' : 'queried-at',
    advisoryTimestampEvidence: options.advisoryDatabaseTimestamp
      ? 'scanner-provided advisory database timestamp'
      : 'live registry query observed at checkedAt',
  });
  const errors = parsed.errors ? [...parsed.errors] : [];
  if (result.error || (result.status !== 0 && result.status !== 1))
    errors.push(executionError('pnpm audit', result));
  if ((result.status === 0 || result.status === 1) && !result.stdout.trim()) {
    errors.push('[pnpm audit Error] Scanner returned no report evidence');
  }
  return {
    timestamp: checkedAt,
    advisoryDatabaseTimestamp: parsed.freshness?.advisoryDatabaseTimestamp || null,
    freshness:
      parsed.freshness ||
      freshnessRecord({
        source: 'npm advisory registry via pnpm audit',
        mode: 'live',
        checkedAt,
        advisoryDatabaseTimestamp: null,
        advisoryQueriedAt: null,
        advisoryTimestampKind: 'unknown',
        advisoryTimestampEvidence: 'no successful scanner evidence',
        usedOfflineCache: false,
      }),
    counts: parsed.counts,
    findings: parsed.findings,
    ignoredFindings: parsed.ignoredFindings || [],
    errors,
  };
}

function runSecretScan(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const execFn = options.execFn || spawnSync;
  const checkedAt = options.checkedAt || new Date().toISOString();
  const rawReportDir =
    options.rawReportDir || mkdtempSync(join(tmpdir(), 'flight-booking-gitleaks-'));
  const ownsReportDir = !options.rawReportDir;
  mkdirSync(rawReportDir, { recursive: true });
  const errors = [];
  const findings = [];
  const configFile = join(rootDir, '.gitleaks.toml');
  const configArgs = existsSync(configFile) ? ['--config', configFile] : [];
  const scanDefinitions = [
    {
      label: 'gitleaks history',
      reportPath: join(rawReportDir, 'gitleaks-history.json'),
      args: [
        'detect',
        '--source',
        rootDir,
        ...configArgs,
        '--verbose',
        '--report-format',
        'json',
        '--report-path',
        join(rawReportDir, 'gitleaks-history.json'),
        '--redact',
        '--log-opts=--all',
      ],
      mode: 'history',
    },
    {
      label: 'gitleaks working tree',
      reportPath: join(rawReportDir, 'gitleaks-working-tree.json'),
      args: [
        'detect',
        '--source',
        rootDir,
        ...configArgs,
        '--verbose',
        '--report-format',
        'json',
        '--report-path',
        join(rawReportDir, 'gitleaks-working-tree.json'),
        '--redact',
        '--no-git',
      ],
      mode: 'working-tree',
    },
  ];

  try {
    for (const definition of scanDefinitions) {
      const result = commandResult(execFn, 'gitleaks', definition.args, rootDir);
      // Gitleaks writes a JSON file, while logs remain on stdout/stderr. Read,
      // normalize, and delete the redacted intermediate immediately.
      const reportContent = readReportFile(definition.reportPath);
      const cleanReport = reportContent && reportContent.trim() !== 'null' ? reportContent : '';
      const hasJsonStdout = Boolean(
        result.stdout &&
          (result.stdout.trim().startsWith('[') || result.stdout.trim().startsWith('{')),
      );
      const raw =
        cleanReport || (result.status === 0 && !hasJsonStdout ? '[]' : result.stdout);
      const parsed = normaliseGitleaks(raw, { checkedAt, mode: definition.mode });
      const hasEvidence = parsed.valid && (raw.trim() !== '' || result.status === 0);
      if (!hasEvidence) {
        if (parsed.errors.length > 0) errors.push(...parsed.errors);
        else errors.push(`[${definition.label} Error] Scanner returned no report evidence`);
      }
      if (result.error || (result.status !== 0 && result.status !== 1))
        errors.push(executionError(definition.label, result));
      findings.push(...parsed.findings);
    }
  } finally {
    if (ownsReportDir) rmSync(rawReportDir, { recursive: true, force: true });
  }

  const dedupedFindings = [
    ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
  ];
  return {
    timestamp: checkedAt,
    freshness: freshnessRecord({
      source: 'Gitleaks static detection rules',
      mode: 'history-and-working-tree',
      checkedAt,
      usedOfflineCache: false,
    }),
    counts: makeCounts(dedupedFindings),
    findings: dedupedFindings,
    errors,
  };
}

function deepSanitize(value) {
  const stripped = stripDisallowedFields(value);
  if (typeof stripped === 'string') return redactSensitiveText(stripped);
  if (Array.isArray(stripped)) return stripped.map((item) => deepSanitize(item));
  if (stripped && typeof stripped === 'object') {
    return Object.fromEntries(
      Object.entries(stripped).map(([key, item]) => [key, deepSanitize(item)]),
    );
  }
  return stripped;
}

function staleFreshnessError(scanner, freshness, checkedAt) {
  const timestamp = freshness?.advisoryDatabaseTimestamp || freshness?.advisoryQueriedAt;
  const maxHours = Number(freshness?.maxAdvisoryAgeHours);
  if (!timestamp || !Number.isFinite(maxHours)) return null;
  const advisoryMs = Date.parse(timestamp);
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(advisoryMs) || !Number.isFinite(checkedMs))
    return `[${scanner} Freshness Error] Advisory timestamp is invalid`;
  if (advisoryMs > checkedMs || checkedMs - advisoryMs > maxHours * 60 * 60 * 1000) {
    return `[${scanner} Freshness Error] Advisory data is stale or from the future`;
  }
  return null;
}

export function runSupplyChainScan(options = {}) {
  const rootDir = resolve(options.rootDir || defaultRepoRoot);
  const strict = options.strict !== false;
  const nowFn = options.now || (() => new Date());
  const timestamp = safeNow(nowFn);
  const outputPath = resolve(rootDir, options.output || DEFAULT_OUTPUT);
  const temp = prepareRawReportDir(rootDir, options.rawReportDir);

  const advisoryRegister = loadDependencyAdvisoryRegister(rootDir, {
    ...options,
    currentDate: timestamp,
    now: nowFn,
  });
  const ignoredInfo = loadIgnoredGhas(rootDir, {
    ...options,
    currentDate: timestamp,
    now: nowFn,
  });
  const ignoredGhas = new Set(
    options.ignoredGhas
      ? typeof options.ignoredGhas === 'string'
        ? [options.ignoredGhas]
        : Array.from(options.ignoredGhas)
      : ignoredInfo,
  );
  if (options.ignoredGhas && options.ignoredGhas !== ignoredInfo) {
    const rawExplicit = options.ignoredGhas;
    const explicitList =
      typeof rawExplicit === 'string'
        ? [rawExplicit]
        : Array.from(rawExplicit || []);
    for (const item of explicitList) {
      if (typeof item === 'string' && item.trim()) {
        const upper = item.trim().toUpperCase();
        if (ignoredGhas instanceof Set) {
          ignoredGhas.add(upper);
        }
        if (!advisoryRegister.catalogedGhas.has(upper)) {
          ignoredInfo.errors.push(
            `[Supply Chain Policy Failure] Found uncataloged GHSA ignore: ${upper} without compensating controls`,
          );
        }
      }
    }
  }
  if (!ignoredInfo.verifiedBracesPatch) {
    for (const id of ignoredGhas) {
      if (String(id).trim().toUpperCase() === VERIFIED_BRACES_ADVISORY) ignoredGhas.delete(id);
    }
  }

  let pipAudit;
  let pnpmAudit;
  let gitleaks;
  try {
    pipAudit = runPipAudit({
      ...options,
      rootDir,
      checkedAt: timestamp,
      rawReportDir: temp.dir,
    });
    pnpmAudit = runPnpmAudit({ ...options, rootDir, checkedAt: timestamp, ignoredGhas });
    gitleaks = runSecretScan({
      ...options,
      rootDir,
      checkedAt: timestamp,
      rawReportDir: temp.dir,
    });
  } finally {
    if (temp.cleanup) rmSync(temp.dir, { recursive: true, force: true });
  }

  const findings = [pipAudit, pnpmAudit, gitleaks]
    .flatMap((scanner) => scanner.findings || [])
    .map((finding) => deepSanitize(finding));
  const dedupedFindings = [
    ...new Map(findings.map((finding) => [finding.fingerprint, finding])).values(),
  ];
  const counts = makeCounts(dedupedFindings);
  const errors = [pipAudit, pnpmAudit, gitleaks].flatMap((scanner) => scanner.errors || []);
  if (ignoredInfo.errors && ignoredInfo.errors.length > 0) {
    errors.push(...ignoredInfo.errors);
  }
  for (const [name, scanner] of [
    ['pip-audit', pipAudit],
    ['pnpm audit', pnpmAudit],
  ]) {
    const staleError = staleFreshnessError(name, scanner.freshness, timestamp);
    if (staleError) errors.push(staleError);
    if (strict) {
      const freshness = scanner.freshness || {};
      const kind = freshness.advisoryTimestampKind;
      const timestamp = freshness.advisoryDatabaseTimestamp || freshness.advisoryQueriedAt;
      const evidence = freshness.advisoryTimestampEvidence;
      const validProvenance =
        (kind === 'database' && Boolean(freshness.advisoryDatabaseTimestamp) &&
          evidence === 'scanner-provided advisory database timestamp') ||
        (kind === 'queried-at' && Boolean(freshness.advisoryQueriedAt) &&
          evidence === 'live registry query observed at checkedAt');
      if (!timestamp || !validProvenance) {
        errors.push(`[${name} Freshness Error] Advisory evidence has no verifiable timestamp/provenance`);
      }
    }
  }
  if (counts.Critical > 0)
    errors.push(`[Supply Chain Policy Failure] Found ${counts.Critical} Critical finding(s)`);
  if (counts.High > 0)
    errors.push(`[Supply Chain Policy Failure] Found ${counts.High} High finding(s)`);

  const report = deepSanitize({
    version: REPORT_VERSION,
    timestamp,
    counts,
    findings: dedupedFindings,
    pipAudit,
    pnpmAudit,
    gitleaks,
    ignoredAdvisories: [...(ignoredGhas instanceof Set ? ignoredGhas : loadIgnoredGhas(rootDir, options))],
    exceptions: advisoryRegister.exceptions,
    errors,
  });

  let writeError = null;
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    writeError = '[Supply Chain Report Error] Failed to write sanitized report';
    errors.push(writeError);
  }

  const passed = errors.length === 0 && counts.Critical === 0 && counts.High === 0;
  return {
    passed,
    exitCode: passed && !writeError ? 0 : 1,
    counts,
    findings: dedupedFindings,
    errors,
    report: deepSanitize({ ...report, errors }),
    outputPath,
  };
}

/* eslint-disable no-console */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const logFn = dependencies.logFn || console.log;
  const errFn = dependencies.errFn || console.error;
  const exitFn = dependencies.exitFn || process.exit;
  let output;
  let strict = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      logFn('Usage: node scripts/security/run-supply-chain.mjs [--output <path>] [--strict]');
      return exitFn(0);
    }
    if (arg === '--strict') {
      strict = true;
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      output = argv[index + 1];
      index += 1;
      if (!output) {
        errFn(`Missing output path after ${arg}`);
        return exitFn(1);
      }
      continue;
    }
    errFn(`Unknown option: ${arg}`);
    return exitFn(1);
  }

  const result = runSupplyChainScan({ ...dependencies, output, strict });
  logFn(`Supply-chain report: ${result.outputPath}`);
  logFn(
    `Findings: ${result.findings.length} (Critical ${result.counts.Critical}, High ${result.counts.High})`,
  );
  if (!result.passed) {
    for (const error of result.errors) errFn(error);
  }
  return exitFn(result.exitCode);
}
/* eslint-enable no-console */

const isMain =
  process.argv[1] &&
  (import.meta.url === pathToFileURL(process.argv[1]).href ||
    resolve(process.argv[1]) === resolve(__filename));

if (isMain) main();
