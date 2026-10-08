import type {
  ProviderName as DomainProviderName,
  ProviderOperationPurpose as DomainProviderOperationPurpose,
} from '@/payment-fulfillment/provider-operation.service';

export type ProviderName = DomainProviderName;
export type ProviderOperationPurpose = DomainProviderOperationPurpose;

export type SimulatorFaultOutcome =
  | 'CONFIRMED'
  | 'DEFINITIVE_REJECTION'
  | 'NO_CREATE_LOST_RESPONSE'
  | 'CREATE_COMMITTED_LOST_RESPONSE'
  | 'UNCOMMITTED_LOST_RESPONSE'
  | 'PROCESSING'
  | 'UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'ZERO_CANDIDATES'
  | 'MULTIPLE_CANDIDATES'
  | 'UNLINKED_CANDIDATE'
  | 'HELD_LATE_RESPONSE';

export type SimulatorFaultSelection = {
  provider: ProviderName;
  purpose: ProviderOperationPurpose;
  bookingIntentId: string;
  outcome: SimulatorFaultOutcome;
};

export type StripePaymentIntentSummary = {
  id: string;
  amount: number;
  currency: string;
  captureMethod: 'manual';
  status: string;
};

export type StripeRefundSummary = {
  id: string;
  paymentIntentId: string;
  amount: number;
  status: string;
};

export type StripeLedgerSummary = {
  provider: 'STRIPE';
  paymentIntents: StripePaymentIntentSummary[];
  refunds: StripeRefundSummary[];
  requestsReceived: number;
  sideEffectCount: number;
  pendingEventIds: string[];
  pendingResponseIds: string[];
};

export type SupplierOrderSummary = {
  id: string;
  balanceAmount: string;
  balanceCurrency: string;
  status: string;
  serviceIds: string[];
};

export type SupplierLedgerSummary = {
  provider: 'DUFFEL';
  orders: SupplierOrderSummary[];
  requestsReceived: number;
  sideEffectCount: number;
  pendingEventIds: string[];
  pendingResponseIds: string[];
};

export type RedactedLedger = StripeLedgerSummary | SupplierLedgerSummary;

export type SignedWebhookFixture = {
  eventId: string;
  body: string;
  signature: string;
};

export type ProviderSimulator<TLedger extends RedactedLedger> = {
  readonly runId: string;
  readonly origin: string;
  readonly applicationCredential: string;
  inspect(runId: string): Promise<TLedger>;
  selectFault(runId: string, input: SimulatorFaultSelection): Promise<void>;
  waitForHeldResponse(runId: string, bookingIntentId: string): Promise<string>;
  releaseResponse(runId: string, responseId: string): Promise<void>;
  close(): Promise<void>;
};

export type StripeSimulator = ProviderSimulator<StripeLedgerSummary> & {
  readonly publishableKey: string;
  readonly webhookSecret: string;
  releaseEvent(runId: string, eventId: string): Promise<SignedWebhookFixture>;
};

export type SupplierSimulator = ProviderSimulator<SupplierLedgerSummary>;