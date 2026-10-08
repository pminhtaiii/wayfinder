import type {
  ProviderName,
  ProviderOperationPurpose,
  SimulatorFaultOutcome,
} from './simulator-types';
import type { DrainResult } from './scheduler';

export type RunAllocationRequest = {
  scenario: string;
  seed: string;
  startTime: string;
};

export type GeneratedCustomerFixture = { id: string; email: string; password: string };

export type RunAllocation = {
  runId: string;
  frontendUrl: string;
  apiUrl: string;
  providerUrls: { stripe: string; supplier: string };
  applicationCredentials: {
    stripeApiKey: string;
    stripePublishableKey: string;
    stripeWebhookSecret: string;
    supplierApiKey: string;
  };
  driverToken: string;
  customer: GeneratedCustomerFixture;
};

export type FaultSelection = {
  provider: ProviderName;
  purpose: ProviderOperationPurpose;
  bookingIntentId: string;
  outcome: SimulatorFaultOutcome;
};

export type StripeLedgerSummary = {
  provider: 'STRIPE';
  paymentIntents: Array<{ id: string; amount: number; currency: string; captureMethod: 'manual'; status: string }>;
  refunds: Array<{ id: string; paymentIntentId: string; amount: number; status: string }>;
  requestsReceived: number;
  sideEffectCount: number;
  pendingEventIds: string[];
  pendingResponseIds: string[];
};

export type SupplierLedgerSummary = {
  provider: 'DUFFEL';
  orders: Array<{ id: string; balanceAmount: string; balanceCurrency: string; status: string; serviceIds: string[] }>;
  requestsReceived: number;
  sideEffectCount: number;
  pendingEventIds: string[];
  pendingResponseIds: string[];
};

export type RedactedLedger = StripeLedgerSummary | SupplierLedgerSummary;

export type IngressResult = { eventId: string; acceptedStatuses: number[] };

export type CleanupReport = {
  runId: string;
  terminatedProcessIds: number[];
  droppedSchema: string;
  removedRedisPrefix: string;
  leakedResourceCount: number;
};

export interface FulfillmentHarnessDriver {
  allocate(input: RunAllocationRequest): Promise<RunAllocation>;
  selectFault(runId: string, input: FaultSelection): Promise<void>;
  inspect(runId: string, provider: ProviderName): Promise<RedactedLedger>;
  releaseEvent(runId: string, eventId: string, copies: number, deliveryOrder: number[]): Promise<IngressResult>;
  releaseResponse(runId: string, responseId: string): Promise<void>;
  advanceClock(runId: string, milliseconds: number, maxJobs: number): Promise<DrainResult>;
  drainScheduler(runId: string, maxJobs: number): Promise<DrainResult>;
  teardown(runId: string): Promise<CleanupReport>;
}
