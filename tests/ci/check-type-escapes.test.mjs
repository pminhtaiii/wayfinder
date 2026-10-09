import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  collectChangedTypeScriptFiles,
  isGuardedTypeScriptPath,
  lintAddedTypeScriptSource,
  parseAddedLineRanges,
} from '../../scripts/ci/check-type-escapes.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const anyRule = '@typescript-eslint/no-explicit-any';
const assertionRule = 'no-new-type-assertion';

function lint(source, addedRanges, filename = 'fixture.ts') {
  return lintAddedTypeScriptSource(source, filename, addedRanges);
}

function git(cwd, ...args) {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function createGitRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'type-escape-'));
  git(directory, 'init', '--quiet');
  git(directory, 'config', 'user.name', 'Type Escape Test');
  git(directory, 'config', 'user.email', 'type-escape@example.invalid');
  return directory;
}

function commitFiles(directory, files) {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(directory, path), content);
  }
  git(directory, 'add', '--', ...Object.keys(files));
  git(directory, 'commit', '--quiet', '-m', 'baseline');
}

test('diff parser records added lines and ignores deletion-only hunks', () => {
  const patch = [
    'diff --git a/example.ts b/example.ts',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1,2 +1,3 @@',
    '+const added = 1;',
    '@@ -8 +9,0 @@',
    '-const removed = 2;',
  ].join('\n');

  assert.deepEqual(parseAddedLineRanges(patch).get('example.ts'), [{ start: 1, end: 3 }]);
});

test('diff parser does not treat added file-header text as a path header', () => {
  const patch = [
    'diff --git a/example.ts b/example.ts',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1 +1,2 @@',
    '+const marker = 1;',
    '+++ b/evil.ts',
    '@@ -3 +4 @@',
    '+const another = 2;',
  ].join('\n');

  assert.deepEqual(
    [...parseAddedLineRanges(patch)],
    [
      [
        'example.ts',
        [
          { start: 1, end: 2 },
          { start: 4, end: 4 },
        ],
      ],
    ],
  );
});

test('guards explicit any and assertions across TS extensions while allowing safe syntax', () => {
  const source = [
    'import { value as localValue } from "./value";',
    'const stable = { status: "ok" } as const;',
    'const unsafeAny: any = localValue;',
    'const unsafeAs = localValue as string;',
    'const unsafeAngle = <string>localValue;',
  ].join('\n');
  const diagnostics = lint(source, [{ start: 1, end: 5 }]);

  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.ruleId).sort(),
    [anyRule, assertionRule, assertionRule].sort(),
  );
  assert.equal(isGuardedTypeScriptPath('apps/web/.next/cache.ts'), false);
  assert.equal(isGuardedTypeScriptPath('apps/web/tests/example.spec.ts'), true);
  assert.equal(isGuardedTypeScriptPath('apps/api/src/example.mts'), true);
  assert.equal(isGuardedTypeScriptPath('apps/api/src/example.cts'), true);
  for (const filename of ['example.mts', 'example.cts']) {
    const typedDiagnostics = lint(
      'const unsafe: any = value as string;',
      [{ start: 1, end: 1 }],
      filename,
    );
    assert.deepEqual(
      typedDiagnostics.map((diagnostic) => diagnostic.ruleId).sort(),
      [anyRule, assertionRule].sort(),
    );
  }
});

test('checks the whole assertion span when either operand or type is changed', () => {
  const source = ['const legacy = replacement as', '  ExistingType;'].join('\n');

  const changedOperand = lint(source, [{ start: 1, end: 1 }]);
  assert.equal(changedOperand.length, 1);
  assert.equal(changedOperand[0].ruleId, assertionRule);

  const changedType = lint('const changed = value as\n  UpdatedType;', [{ start: 2, end: 2 }]);
  assert.equal(changedType.length, 1);
  assert.equal(changedType[0].ruleId, assertionRule);

  const untouchedLegacy = lint('const legacy = value as ExistingType;\nconst marker = 2;', [
    { start: 2, end: 2 },
  ]);
  assert.equal(untouchedLegacy.length, 0);
});

test('local HEAD comparison includes staged, unstaged, and untracked TypeScript files', () => {
  const directory = createGitRepository();
  try {
    commitFiles(directory, {
      'staged.ts': 'export const value = 1;\n',
      'unstaged.ts': 'export const value = 2;\n',
    });

    writeFileSync(join(directory, 'staged.ts'), 'const staged: any = 1;\n');
    git(directory, 'add', '--', 'staged.ts');
    writeFileSync(join(directory, 'unstaged.ts'), 'const unstaged = 2 as number;\n');
    writeFileSync(join(directory, 'new.ts'), 'const fresh = <number>3;\n');

    const changed = collectChangedTypeScriptFiles(directory);
    assert.deepEqual(
      changed.map((file) => file.relativePath),
      ['new.ts', 'staged.ts', 'unstaged.ts'],
    );
    assert.equal(
      changed.reduce(
        (count, file) => count + lint(file.source, file.addedRanges, file.absolutePath).length,
        0,
      ),
      3,
    );
    assert.throws(
      () => collectChangedTypeScriptFiles(directory, 'missing-base-ref'),
      /Unable to resolve Git base/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('changed paths with spaces and Unicode are checked', () => {
  const directory = createGitRepository();
  try {
    const path = 'módulo with space.ts';
    commitFiles(directory, { [path]: 'export const value = 1;\n' });
    writeFileSync(join(directory, path), 'export const value: any = 1;\n');

    const changed = collectChangedTypeScriptFiles(directory);
    assert.deepEqual(
      changed.map((file) => file.relativePath),
      [path],
    );
    assert.equal(lint(changed[0].source, changed[0].addedRanges).length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inline ESLint disables cannot suppress the changed-line guard', () => {
  const source =
    '// eslint-disable-next-line @typescript-eslint/no-explicit-any\nconst unsafe: any = 1;';
  const diagnostics = lint(source, [{ start: 2, end: 2 }]);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].ruleId, anyRule);
});

test('root and API/Web lint scripts invoke the local type guard', () => {
  const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const apiPackage = JSON.parse(readFileSync(join(root, 'apps', 'api', 'package.json'), 'utf8'));
  const webPackage = JSON.parse(readFileSync(join(root, 'apps', 'web', 'package.json'), 'utf8'));

  assert.equal(rootPackage.scripts['lint:types'], 'node scripts/ci/check-type-escapes.mjs');
  assert.match(rootPackage.scripts.lint, /lint:types/);
  assert.match(apiPackage.scripts.lint, /check-type-escapes\.mjs/);
  assert.match(webPackage.scripts.lint, /check-type-escapes\.mjs/);
});

test('API and Web CI gates use the two-commit checkout base for the guard', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

  for (const jobName of ['api-gate', 'web-gate']) {
    const job = workflow.match(
      new RegExp(
        '^  ' + jobName + ':[\\t ]*\\n([\\s\\S]*?)(?=^  [\\w-]+:[\\t ]*$|^(?!\\s)|$(?![\\s\\S]))',
        'm',
      ),
    )?.[0];
    assert.ok(job, 'expected ' + jobName + ' job');
    assert.match(job, /fetch-depth:\s+2/);
    assert.match(job, /node scripts\/ci\/check-type-escapes\.mjs --base HEAD\^1/);
    const installIndex = job.indexOf('Install Node dependencies');
    const guardIndex = job.indexOf('check-type-escapes.mjs');
    assert.ok(
      installIndex >= 0 && guardIndex > installIndex,
      'guard should run after the existing dependency install',
    );
  }
});
