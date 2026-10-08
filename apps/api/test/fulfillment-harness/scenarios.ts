import type {
  ProviderName,
  ProviderOperationPurpose,
} from '@/payment-fulfillment/provider-operation.service';
import type {
  SimulatorFaultOutcome,
  SimulatorFaultSelection,
} from './simulator-types';

export type RegisteredFaultScenario = Readonly<
  Pick<SimulatorFaultSelection, 'provider' | 'purpose' | 'outcome'>
>;

type OperationScenarios = {
  provider: ProviderName;
  purpose: ProviderOperationPurpose;
  outcomes: readonly SimulatorFaultOutcome[];
};

const compensationOutcomes: readonly SimulatorFaultOutcome[] = [
  'CONFIRMED',
  'DEFINITIVE_REJECTION',
  'PROCESSING',
  'UNAVAILABLE',
];

const operationScenarios: readonly OperationScenarios[] = [
  {
    provider: 'STRIPE',
    purpose: 'PAYMENT_INTENT_CREATE',
    outcomes: [
      'CONFIRMED',
      'DEFINITIVE_REJECTION',
      'NO_CREATE_LOST_RESPONSE',
      'CREATE_COMMITTED_LOST_RESPONSE',
      'PROCESSING',
      'HELD_LATE_RESPONSE',
    ],
  },
  {
    provider: 'STRIPE',
    purpose: 'AUTHORIZATION',
    outcomes: ['CONFIRMED', 'DEFINITIVE_REJECTION', 'PROCESSING'],
  },
  {
    provider: 'DUFFEL',
    purpose: 'ORDER_CREATE',
    outcomes: [
      'CONFIRMED',
      'DEFINITIVE_REJECTION',
      'NO_CREATE_LOST_RESPONSE',
      'CREATE_COMMITTED_LOST_RESPONSE',
      'PROCESSING',
      'HELD_LATE_RESPONSE',
    ],
  },
  {
    provider: 'STRIPE',
    purpose: 'CAPTURE',
    outcomes: [
      'CONFIRMED',
      'DEFINITIVE_REJECTION',
      'CREATE_COMMITTED_LOST_RESPONSE',
      'UNCOMMITTED_LOST_RESPONSE',
      'PROCESSING',
    ],
  },
  { provider: 'DUFFEL', purpose: 'ORDER_CANCEL', outcomes: compensationOutcomes },
  {
    provider: 'STRIPE',
    purpose: 'AUTHORIZATION_RELEASE',
    outcomes: compensationOutcomes,
  },
  { provider: 'STRIPE', purpose: 'REFUND', outcomes: compensationOutcomes },
  {
    provider: 'STRIPE',
    purpose: 'RECONCILE',
    outcomes: ['PROCESSING', 'UNAVAILABLE', 'RATE_LIMITED'],
  },
  {
    provider: 'DUFFEL',
    purpose: 'RECONCILE',
    outcomes: [
      'PROCESSING',
      'UNAVAILABLE',
      'RATE_LIMITED',
      'ZERO_CANDIDATES',
      'MULTIPLE_CANDIDATES',
      'UNLINKED_CANDIDATE',
    ],
  },
];

export const FULFILLMENT_SCENARIO_MANIFEST_VERSION = 1;

export const FULFILLMENT_SCENARIO_MANIFEST: readonly RegisteredFaultScenario[] =
  Object.freeze(
    operationScenarios.flatMap(({ provider, purpose, outcomes }) =>
      outcomes.map((outcome) => ({ provider, purpose, outcome })),
    ),
  );

export function assertSupportedFaultSelection(selection: SimulatorFaultSelection): void {
  const supported = FULFILLMENT_SCENARIO_MANIFEST.some(
    (scenario) =>
      scenario.provider === selection.provider &&
      scenario.purpose === selection.purpose &&
      scenario.outcome === selection.outcome,
  );
  if (!supported) {
    throw new Error('Unsupported fulfillment fault scenario');
  }
}
