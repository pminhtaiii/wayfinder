import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import path from 'path';

const t093RealFlow = process.env.T093_REAL_FLOW === 'true';
const flightSearchFixtureApiUrl =
  process.env.FLIGHT_SEARCH_FIXTURE_API_URL || 'http://127.0.0.1:3101';
const generatedSecret = (): string => randomBytes(32).toString('base64url');
const t093Secrets = {
  agent: process.env.AGENT_SERVICE_API_KEY || generatedSecret(),
  attestation: process.env.ATTESTATION_SECRET || generatedSecret(),
  claim: process.env.CLAIM_TOKEN_SECRET || generatedSecret(),
  encryption: process.env.CHAT_ENCRYPTION_KEY || randomBytes(32).toString('hex'),
  handoff: process.env.CHAT_HANDOFF_SECRET || generatedSecret(),
  jwt: process.env.JWT_SECRET || generatedSecret(),
  mimo: process.env.MIMO_API_KEY || generatedSecret(),
  stripe: process.env.STRIPE_SECRET_KEY || `sk_test_${generatedSecret()}`,
  stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET || `whsec_${generatedSecret()}`,
};

const nextAuthSecret =
  process.env.NEXTAUTH_SECRET ||
  (t093RealFlow ? t093Secrets.jwt : 'test_secret');
process.env.NEXTAUTH_SECRET = nextAuthSecret;

const frontendEnv = {
  CI: 'true',
  NEXTAUTH_SECRET: nextAuthSecret,
  NEXTAUTH_URL: t093RealFlow ? 'http://localhost:3000' : 'http://127.0.0.1:3000',
  // Search Server Actions run in Next.js, so their upstream fixture must be reachable
  // from the Next process rather than intercepted from the browser.
  API_URL: t093RealFlow ? 'http://127.0.0.1:3001' : flightSearchFixtureApiUrl,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:3001',
  NEXT_PUBLIC_FEATURE_FLAG_BOOKING_READINESS: 'true',
  NEXT_PUBLIC_FEATURE_FLAG_CHAT_HANDOFF: 'true',
  NEXT_PUBLIC_AGENT_URL: 'http://127.0.0.1:3002',
};

export default defineConfig({
  testDir: './',
  outputDir: path.resolve(__dirname, '../../../.agent-work/test_results/default'),
  testIgnore: t093RealFlow ? [] : '**/chat-t093-real-flow.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: {
    timeout: 30000,
  },
  reporter: process.env.CI
    ? 'line'
    : [
        [
          'html',
          {
            open: 'never',
            outputFolder: path.resolve(__dirname, '../../../.agent-work/test_results/html'),
          },
        ],
      ],
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    actionTimeout: 30000,
    launchOptions: {
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: [
    ...(process.env.PLAYWRIGHT_FRONTEND_ONLY !== 'true'
      ? [
          {
            command: t093RealFlow
              ? 'node -r ts-node/register -r tsconfig-paths/register test/t093-server.ts'
              : 'pnpm start:prod',
            url: t093RealFlow
              ? 'http://127.0.0.1:3001/test/t093/ready'
              : 'http://127.0.0.1:3001/health',
            reuseExistingServer: t093RealFlow ? false : !process.env.CI,
            timeout: 600000,
            cwd: path.resolve(__dirname, '../../api'),
            env: {
              NODE_ENV: 'test',
              // User-approved 2026-10-04: T093's API server and Prisma assertions must use the same disposable DATABASE_URL for phase-7 isolation.
              DATABASE_URL:
                process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/test_db',
              REDIS_URL: 'redis://127.0.0.1:6379/1',
              FEATURE_FLAG_BOOKING_READINESS: 'true',
              FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
              FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
              CHAT_HANDOFF_SECRET: t093Secrets.handoff,
              ATTESTATION_SECRET: t093Secrets.attestation,
              CHAT_ENCRYPTION_KEY: t093Secrets.encryption,
              ENCRYPTION_KEY: randomBytes(32).toString('hex'),
              JWT_SECRET: t093Secrets.jwt,
              AGENT_SERVICE_API_KEY: t093Secrets.agent,
              CLAIM_TOKEN_SECRET: t093Secrets.claim,
              STRIPE_SECRET_KEY: t093Secrets.stripe,
              STRIPE_WEBHOOK_SECRET: t093Secrets.stripeWebhook,
              DUFFEL_ACCESS_TOKEN: generatedSecret(),
              FRONTEND_URL: t093RealFlow ? 'http://localhost:3000' : 'http://127.0.0.1:3000',
            },
          },
        ]
      : []),
    ...(t093RealFlow
      ? [
          {
            command: 'python tests/helpers/t093_mimo_server.py --port 3003',
            url: 'http://127.0.0.1:3003/health',
            reuseExistingServer: false,
            timeout: 600000,
            cwd: path.resolve(__dirname, '../../agent'),
          },
          {
            command: 'uv run uvicorn agent.main:app --app-dir src --host 127.0.0.1 --port 3002',
            url: 'http://127.0.0.1:3002/health',
            reuseExistingServer: false,
            timeout: 600000,
            cwd: path.resolve(__dirname, '../../agent'),
            env: {
              NODE_ENV: 'test',
              FRONTEND_URL: t093RealFlow ? 'http://localhost:3000' : 'http://127.0.0.1:3000',
              NESTJS_API_URL: 'http://127.0.0.1:3001/api',
              REDIS_URL: 'redis://127.0.0.1:6379/1',
              JWT_SECRET: t093Secrets.jwt,
              AGENT_SERVICE_API_KEY: t093Secrets.agent,
              CLAIM_TOKEN_SECRET: t093Secrets.claim,
              ATTESTATION_SECRET: t093Secrets.attestation,
              MIMO_API_URL: 'http://127.0.0.1:3003/v1',
              MIMO_API_KEY: t093Secrets.mimo,
              MIMO_MODEL_NAME: 't093',
              FEATURE_FLAG_CHAT_MULTI_AGENT: 'true',
              FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
              FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'true',
              FEATURE_FLAG_CHAT_PERSISTENCE_ENCRYPTION: 'true',
              SESSION_LOCK_TTL_MS: process.env.T093_SESSION_LOCK_TTL_MS || '120000',
              SESSION_LOCK_REFRESH_INTERVAL_SECONDS:
                process.env.T093_SESSION_LOCK_REFRESH_INTERVAL_SECONDS || '1',
            },
          },
        ]
      : []),
    {
      command: 'node node_modules/next/dist/bin/next dev -p 3000',
      url: t093RealFlow ? 'http://127.0.0.1:3000/api/auth/csrf' : 'http://127.0.0.1:3000',
      reuseExistingServer: t093RealFlow ? false : !process.env.CI,
      timeout: 600000,
      cwd: path.resolve(__dirname, '..'),
      env: frontendEnv,
    },
  ],
});
