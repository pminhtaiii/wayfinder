import { z } from 'zod';

const positiveIntegerDuration = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer string')
  .transform((value: string): number => Number(value))
  .refine(Number.isSafeInteger, 'must be a safe integer');

const durationWithDefault = (
  defaultMs: number,
): z.ZodEffects<z.ZodOptional<typeof positiveIntegerDuration>, number, string | undefined> =>
  positiveIntegerDuration
    .optional()
    .transform((value: number | undefined): number => value ?? defaultMs);

export const fulfillmentRecoveryEnvSchema = z.object({
  FEATURE_FLAG_FULFILLMENT_RECOVERY: z.enum(['true', 'false']).default('false'),
  FULFILLMENT_RECOVERY_LEASE_MS: durationWithDefault(180_000),
  FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS: durationWithDefault(30_000),
  FULFILLMENT_RECOVERY_ESCALATION_AFTER_MS: durationWithDefault(900_000),
  FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS:
    positiveIntegerDuration.optional(),
});

export type FulfillmentRecoveryEnvironment = z.infer<typeof fulfillmentRecoveryEnvSchema>;

export function addFulfillmentRecoveryConfigIssues(
  config: FulfillmentRecoveryEnvironment,
  context: z.RefinementCtx,
): void {
  if (
    config.FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS >=
    config.FULFILLMENT_RECOVERY_LEASE_MS
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FULFILLMENT_RECOVERY_LEASE_RENEW_INTERVAL_MS'],
      message: 'must be shorter than FULFILLMENT_RECOVERY_LEASE_MS',
    });
  }

  if (
    config.FEATURE_FLAG_FULFILLMENT_RECOVERY === 'true' &&
    config.FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS === undefined
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FULFILLMENT_RECOVERY_PRE_CREATE_AUTHORIZATION_MARGIN_MS'],
      message: 'is required when FEATURE_FLAG_FULFILLMENT_RECOVERY is true',
    });
  }
}
