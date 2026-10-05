import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function findInstalledBraces() {
  const projectRequire = createRequire(fileURLToPath(import.meta.url));
  const cliManifestPath = projectRequire.resolve('@nestjs/cli/package.json', {
    paths: [path.join(projectRoot, 'apps', 'api')],
  });
  const cliRequire = createRequire(cliManifestPath);
  const coreRequire = createRequire(cliRequire.resolve('@angular-devkit/core'));
  const chokidarRequire = createRequire(coreRequire.resolve('chokidar'));
  const bracesEntryPath = chokidarRequire.resolve('braces');
  const packageRoot = path.dirname(bracesEntryPath);
  const bracesManifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));

  if (bracesManifest.name !== 'braces' || bracesManifest.version !== '3.0.3') {
    throw new Error(`Expected transitive braces@3.0.3, found ${bracesManifest.version}.`);
  }

  return {
    packageRoot,
    require: createRequire(path.join(packageRoot, 'package.json')),
  };
}

const installedBraces = await findInstalledBraces();
const braces = installedBraces.require(installedBraces.packageRoot);

function nestedBraces(depth) {
  return `${'{'.repeat(depth)}a,b${'}'.repeat(depth)}`;
}

function mixedNesting(depth) {
  return `${'{('.repeat(depth)}value${')}'.repeat(depth)}${'}'.repeat(depth)}`;
}

function nestedBraceAst(depth) {
  let node = { type: 'text', value: 'value' };
  for (let index = 0; index < depth; index += 1) {
    node = { type: 'brace', nodes: [node] };
  }
  return { type: 'root', nodes: [node] };
}

function isDepthSyntaxError(error) {
  return error instanceof SyntaxError && /exceeds max depth/.test(error.message);
}

function isDepthRangeError(error) {
  return error instanceof RangeError && /exceeds max depth/.test(error.message);
}

test('preserves ordinary brace compile and expansion results', () => {
  assert.deepEqual(braces('{a,b}'), ['(a|b)']);
  assert.deepEqual(braces('src/{a,b}', { expand: true }), ['src/a', 'src/b']);
});

test('allows the safe 100-level brace boundary and rejects level 101', () => {
  assert.doesNotThrow(() => braces.parse(nestedBraces(100)));
  assert.throws(() => braces.parse(nestedBraces(101)), isDepthSyntaxError);
});

test('rejects over-deep unmatched nesting before the parser can unwind', () => {
  assert.throws(() => braces.parse(`${'{'.repeat(101)}value`), isDepthSyntaxError);
  assert.throws(() => braces.parse(`${'('.repeat(101)}value`), isDepthSyntaxError);
});

test('counts parenthesis and brace nesting together', () => {
  assert.throws(() => braces.parse(mixedNesting(51)), isDepthSyntaxError);
  assert.throws(() => braces.parse(`${'('.repeat(101)}${')'.repeat(101)}`), isDepthSyntaxError);
});

test('does not let a caller supplied maxDepth raise the safe ceiling', () => {
  assert.throws(
    () => braces.parse(nestedBraces(101), { maxDepth: Number.MAX_SAFE_INTEGER }),
    isDepthSyntaxError,
  );
});

test('guards compile, expand, and stringify at depth 101 for direct AST input', () => {
  const errors = [braces.compile, braces.expand, braces.stringify].map((walk) => {
    try {
      walk(nestedBraceAst(101));
      return null;
    } catch (error) {
      return error;
    }
  });

  assert.deepEqual(errors.map(isDepthRangeError), [true, true, true]);
});

test('does not let direct AST maxDepth options bypass any walker guard', () => {
  const errors = [braces.compile, braces.expand, braces.stringify].map((walk) => {
    try {
      walk(nestedBraceAst(101), { maxDepth: Number.MAX_SAFE_INTEGER });
      return null;
    } catch (error) {
      return error;
    }
  });

  assert.deepEqual(errors.map(isDepthRangeError), [true, true, true]);
});
