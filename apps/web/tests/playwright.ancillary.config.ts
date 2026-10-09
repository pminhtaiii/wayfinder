import { defineConfig, devices } from '@playwright/test';
import path from 'path';

export default defineConfig({
  testDir: './',
  outputDir: path.resolve(__dirname, '../../../.agent-work/test_results/ancillary'),
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: 'node node_modules/next/dist/bin/next dev -p 3000',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: false,
    timeout: 180000,
    cwd: path.resolve(__dirname, '..'),
    env: {
      CI: 'true',
      NEXTAUTH_SECRET: 'test_secret',
      NEXTAUTH_URL: 'http://127.0.0.1:3000',
      NEXT_PUBLIC_API_URL: 'http://127.0.0.1:3001',
    },
  },
});
