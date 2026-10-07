import { envSchema } from '../app.module';

const baseConfig = {
  STRIPE_SECRET_KEY: 'sk_test_123',
  STRIPE_WEBHOOK_SECRET: 'whsec_123',
};

const invalidRecoveryConfigs: Array<[string, Record<string, string>]> = [
  ['an unsupported switch value', { FEATURE_FLAG_FULFILLMENT_RECOVERY: 'yes' }],
  ['a zero lease', { FULFILLMENT_RECOVERY_LEASE_MS: '0' }],
  ['a fractional lease', { FULFILLMENT_RECOVERY_LEASE_MS: '180000.5' }],
  ['a zero renewal interval', { FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS: '0' }],
  [
    'a renewal interval equal to the lease',
    {
      FULFILLMENT_RECOVERY_LEASE_MS: '30000',
      FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS: '30000',
    },
  ],
  ['a zero escalation delay', { FULFILLMENT_RECOVERY_ESCALATION_AFTER_MS: '0' }],
  [
    'an enabled switch without an authorization margin',
    { FEATURE_FLAG_FULFILLMENT_RECOVERY: 'true' },
  ],
  [
    'a zero authorization margin',
    { FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS: '0' },
  ],
];

describe('fulfillment recovery environment configuration', (): void => {
  it('defaults recovery off and applies the reviewed policy timings', (): void => {
    const parsed = envSchema.parse(baseConfig);

    expect(parsed.FEATURE_FLAG_FULFILLMENT_RECOVERY).toBe('false');
    expect(parsed.FULFILLMENT_RECOVERY_LEASE_MS).toBe(180_000);
    expect(parsed.FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS).toBe(30_000);
    expect(parsed.FULFILLMENT_RECOVERY_ESCALATION_AFTER_MS).toBe(900_000);
    expect(parsed.FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS).toBeUndefined();
  });

  it('accepts explicit enablement only with an explicit positive authorization margin', (): void => {
    const parsed = envSchema.parse({
      ...baseConfig,
      FEATURE_FLAG_FULFILLMENT_RECOVERY: 'true',
      FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS: '180000',
    });

    expect(parsed.FEATURE_FLAG_FULFILLMENT_RECOVERY).toBe('true');
    expect(parsed.FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS).toBe(180_000);
  });

  it.each(invalidRecoveryConfigs)('rejects %s', (_reason: string, overrides: Record<string, string>): void => {
    expect((): unknown => envSchema.parse({ ...baseConfig, ...overrides })).toThrow();
  });
});