import { defineConfig } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './',
  outputDir: path.resolve(__dirname, '../../../.agent-work/test_results/state'),
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  projects: [{ name: 'state' }],
});
