import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode, ...playwrightArgs] = process.argv.slice(2);
if (mode !== 'interface' && mode !== 'system') {
  process.stderr.write('Usage: node scripts/run-playwright.mjs <interface|system>\n');
  process.exit(2);
}

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const playwrightCli = require.resolve('@playwright/test/cli');
const args = [
  ...(mode === 'interface'
    ? ['test', 'tests/characterization/', '--config=tests/playwright.config.ts']
    : ['test', 'tests/chat-t093-real-flow.spec.ts', '--config=tests/playwright.config.ts']),
  ...playwrightArgs,
];
const result = spawnSync(process.execPath, [playwrightCli, ...args], {
  cwd: webRoot,
  env: {
    ...process.env,
    PLAYWRIGHT_FRONTEND_ONLY: mode === 'interface' ? 'true' : 'false',
    T093_REAL_FLOW: mode === 'system' ? 'true' : 'false',
  },
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
