import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import tsEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { Linter } from 'eslint';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ignoredDirectories = new Set(['.git', '.next', 'coverage', 'dist', 'node_modules', 'out']);
const guardedRules = new Set(['@typescript-eslint/no-explicit-any', 'no-new-type-assertion']);

const noTypeAssertion = {
  meta: {
    type: 'problem',
    messages: {
      assertion: 'Avoid type assertions; narrow the value or validate it at runtime.',
    },
    schema: [],
  },
  create(context) {
    function report(assertion) {
      context.report({ node: assertion, messageId: 'assertion' });
    }

    return {
      TSAsExpression(node) {
        const typeName =
          node.typeAnnotation.type === 'TSTypeReference' ? node.typeAnnotation.typeName : undefined;
        if (typeName?.type !== 'Identifier' || typeName.name !== 'const') {
          report(node);
        }
      },
      TSTypeAssertion(node) {
        report(node);
      },
    };
  },
};

const linter = new Linter();
linter.defineParser('@typescript-eslint/parser', tsParser);
linter.defineRule('@typescript-eslint/no-explicit-any', tsEslint.rules['no-explicit-any']);
linter.defineRule('no-new-type-assertion', noTypeAssertion);

function normalizePath(value) {
  return value.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

export function isGuardedTypeScriptPath(path) {
  const normalized = normalizePath(path);
  return (
    ['.ts', '.tsx', '.mts', '.cts'].includes(extname(normalized).toLowerCase()) &&
    !normalized.split('/').some((segment) => ignoredDirectories.has(segment))
  );
}

export function parseAddedLineRanges(patch, relativePath) {
  const changed = new Map();
  let path = relativePath ? normalizePath(relativePath) : undefined;
  let inHunk = false;
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      if (!relativePath) {
        path = undefined;
      }
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      if (relativePath) {
        continue;
      }
      path = line.match(/^\+\+\+ b\/(.+)$/)?.[1];
      if (!path && line !== '+++ /dev/null') {
        throw new Error('Unable to parse a quoted or malformed Git diff path');
      }
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!path || !hunk) {
      continue;
    }
    inHunk = true;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) {
      const ranges = changed.get(normalizePath(path)) ?? [];
      ranges.push({ start, end: start + count - 1 });
      changed.set(normalizePath(path), ranges);
    }
  }
  for (const [file, ranges] of changed) {
    ranges.sort((left, right) => left.start - right.start);
    changed.set(
      file,
      ranges.reduce((merged, range) => {
        const previous = merged.at(-1);
        if (previous && range.start <= previous.end + 1) {
          previous.end = Math.max(previous.end, range.end);
        } else {
          merged.push({ ...range });
        }
        return merged;
      }, []),
    );
  }
  return changed;
}

function git(rootPath, args) {
  const result = spawnSync('git', ['-C', rootPath, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      'git ' + args[0] + ' failed: ' + (result.error?.message ?? (result.stderr || '').trim()),
    );
  }
  return result.stdout ?? '';
}

export function collectChangedTypeScriptFiles(rootPath = root, baseRef = 'HEAD') {
  const cwd = resolve(rootPath);
  let base;
  try {
    base = git(cwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      baseRef + '^{commit}',
    ]).trim();
  } catch (error) {
    throw new Error(
      'Unable to resolve Git base "' +
        baseRef +
        '": ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  const trackedPaths = git(cwd, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--text',
    '--no-textconv',
    '--no-color',
    '--no-ext-diff',
    '--no-renames',
    '--name-only',
    '-z',
    base,
    '--',
  ])
    .split('\0')
    .filter(Boolean)
    .map(normalizePath);
  const changed = new Map();
  for (const relativePath of trackedPaths) {
    if (!isGuardedTypeScriptPath(relativePath)) {
      continue;
    }
    const patch = git(cwd, [
      '-c',
      'core.quotePath=false',
      '--literal-pathspecs',
      'diff',
      '--text',
      '--no-textconv',
      '--no-color',
      '--no-ext-diff',
      '--no-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--diff-algorithm=myers',
      '--no-indent-heuristic',
      '--unified=0',
      '--inter-hunk-context=0',
      base,
      '--',
      relativePath,
    ]);
    changed.set(relativePath, parseAddedLineRanges(patch, relativePath).get(relativePath) ?? []);
  }
  const untracked = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const file of untracked.split('\0').filter(Boolean).map(normalizePath)) {
    if (isGuardedTypeScriptPath(file) && !changed.has(file)) {
      changed.set(file, [{ start: 1, end: Number.MAX_SAFE_INTEGER }]);
    }
  }

  return [...changed]
    .filter(([file]) => isGuardedTypeScriptPath(file))
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([relativePath, addedRanges]) => {
      const absolutePath = resolve(cwd, relativePath);
      return existsSync(absolutePath)
        ? [{ relativePath, absolutePath, source: readFileSync(absolutePath, 'utf8'), addedRanges }]
        : [];
    });
}

function overlapsChangedLines(diagnostic, ranges) {
  const start = diagnostic.line ?? diagnostic.endLine ?? 1;
  const end = diagnostic.endLine ?? start;
  return ranges.some((range) => start <= range.end && end >= range.start);
}

export function lintAddedTypeScriptSource(source, filename, addedRanges) {
  const diagnostics = linter.verify(
    source,
    {
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      rules: {
        '@typescript-eslint/no-explicit-any': 'error',
        'no-new-type-assertion': 'error',
      },
    },
    { filename, allowInlineConfig: false },
  );
  return diagnostics.filter(
    (diagnostic) =>
      diagnostic.fatal ||
      !diagnostic.ruleId ||
      (guardedRules.has(diagnostic.ruleId) && overlapsChangedLines(diagnostic, addedRanges)),
  );
}

export async function runTypeEscapeCheck({ rootPath = root, baseRef = 'HEAD' } = {}) {
  const files = collectChangedTypeScriptFiles(rootPath, baseRef);
  const violations = files.flatMap((file) =>
    lintAddedTypeScriptSource(file.source, file.absolutePath, file.addedRanges).map(
      (diagnostic) => ({ file: file.relativePath, diagnostic }),
    ),
  );
  if (violations.length > 0) {
    for (const { file, diagnostic } of violations) {
      console.error(
        file +
          ':' +
          (diagnostic.line ?? 1) +
          ':' +
          (diagnostic.column ?? 1) +
          ' ' +
          (diagnostic.ruleId ?? 'typescript-parser') +
          ': ' +
          diagnostic.message,
      );
    }
    return false;
  }
  console.log(
    files.length === 0
      ? 'No changed TypeScript files to check.'
      : 'Checked ' +
          files.length +
          ' changed TypeScript file(s); no new explicit any or type assertions.',
  );
  return true;
}

function parseArguments(argv) {
  let baseRef = 'HEAD';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') {
      return { help: true, baseRef };
    }
    if (argv[index] === '--base') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--base requires a Git commit or ref');
      }
      baseRef = value;
      index += 1;
    } else {
      throw new Error('Unknown argument: ' + argv[index]);
    }
  }
  return { help: false, baseRef };
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log('Usage: node scripts/ci/check-type-escapes.mjs [--base <git-ref>]');
    return true;
  }
  return runTypeEscapeCheck({ baseRef: options.baseRef });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then((passed) => {
      if (!passed) {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(
        'TypeScript guard failed: ' + (error instanceof Error ? error.message : String(error)),
      );
      process.exitCode = 1;
    });
}
