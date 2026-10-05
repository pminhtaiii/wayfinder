import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadIgnoredGhas } from '../../scripts/security/run-supply-chain.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bracesAdvisory = 'GHSA-VFJ7-8CJW-P6XM';
const workspaceAdvisory = 'GHSA-vfj7-8cjw-p6xm';
const fixtureFiles = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'docs/security/dependency-advisories.md',
  'patches/braces@3.0.3.patch',
];

let fixtureRoot;
let workspacePath;
let originalWorkspace;

before(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'workspace-audit-ignore-'));
  for (const relativePath of fixtureFiles) {
    const fixturePath = join(fixtureRoot, relativePath);
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, readFileSync(join(root, relativePath)));
  }
  workspacePath = join(fixtureRoot, 'pnpm-workspace.yaml');
  originalWorkspace = readFileSync(workspacePath, 'utf8');
});

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function loadFromWorkspace(content) {
  writeFileSync(workspacePath, content, 'utf8');
  return loadIgnoredGhas(fixtureRoot);
}

function hasReviewedPatchError(errors) {
  return errors.some((error) => error.includes('requires the registered, SHA-256-pinned reviewed braces patch'));
}

const workspaceCases = [
  {
    name: 'rejects an advisory found only in the later ignoreGhsas list',
    content: () => {
      const primaryList = originalWorkspace.replace('    - ' + workspaceAdvisory + '\n', '');
      return primaryList.replace(
        '  ignoreGhsas:\n',
        '  ignoreGhsas:\n    - ' + workspaceAdvisory + '\n',
      );
    },
    expectedIgnored: false,
  },
  {
    name: 'accepts ignoreGhas entries after blank lines',
    content: () => originalWorkspace.replace('  ignoreGhas:\n', '  ignoreGhas:\n\n\n'),
    expectedIgnored: true,
  },
  {
    name: 'stops at a sibling key indented by two spaces',
    content: () =>
      originalWorkspace.replace(
        '  ignoreGhas:\n',
        '  ignoreGhas:\n  laterGhas:\n    - ' + workspaceAdvisory + '\n',
      ),
    expectedIgnored: false,
  },
];

for (const { name, content, expectedIgnored } of workspaceCases) {
  test(name, () => {
    const ignored = loadFromWorkspace(content());
    assert.equal(ignored.has(bracesAdvisory), expectedIgnored);
    assert.equal(hasReviewedPatchError(ignored.errors), !expectedIgnored);
  });
}
