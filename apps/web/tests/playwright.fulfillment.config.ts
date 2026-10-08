import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: __dirname,
  testMatch: 'fulfillment-startup.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 15000,
  expect: { timeout: 5000 },
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3000',
  },
});
