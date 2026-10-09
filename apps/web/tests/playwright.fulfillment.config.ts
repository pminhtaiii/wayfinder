import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: __dirname,
  outputDir: path.resolve(__dirname, '../../../.agent-work/test_results/fulfillment'),
  testMatch: 'fulfillment-startup.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 15000,
  expect: { timeout: 5000 },
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3000',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
