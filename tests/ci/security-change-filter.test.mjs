import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

test('security change detection includes pnpm workspace configuration', () => {
  const lines = workflow.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line === '            security:');
  assert.notEqual(headerIndex, -1, 'expected the security routing filter');

  const filterLines = [];
  for (const line of lines.slice(headerIndex + 1)) {
    const indentation = line.length - line.trimStart().length;
    if (line.trim() && indentation <= 12) break;
    filterLines.push(line.trim());
  }

  assert.ok(
    filterLines.includes("- 'pnpm-workspace.yaml'"),
    'security changes must include the pnpm workspace manifest',
  );
});

test('CI runs the security change filter regression test', () => {
  assert.match(
    workflow,
    /run: node --test tests\/ci\/ci-workflow\.contract\.test\.mjs tests\/ci\/security-change-filter\.test\.mjs/,
  );
});
