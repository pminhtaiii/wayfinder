export type PaymentStatus =
  | 'PENDING'
  | 'CREATED'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'REFUND_PENDING'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'CHARGEBACK_LOST';

export function toPublicPaymentStatus(
  status: PaymentStatus | 'RESERVED',
): PaymentStatus {
  return status === 'RESERVED' ? 'PENDING' : status;
}

export type RefundStatus = 'REFUND_PENDING' | 'SUCCEEDED' | 'FAILED';

export type RefundTriggerType = 'USER' | 'ADMIN' | 'SYSTEM_AUTOMATED';

export type LedgerEntryType = 'DEBIT' | 'CREDIT';

export type PaymentEventSource = 'WEBHOOK' | 'API' | 'CRON' | 'SYSTEM';

export type Payment = {
  id: string;
  bookingIntentId: string;
  ancillarySelectionId?: string | null;
  ancillarySelectionVersion?: number | null;
  attemptNumber: number;
  idempotencyKeyId: string;
  stripePaymentIntentId?: string;
  stripeCustomerId?: string | null;
  amount: number;
  currency: string;
  paymentMethodType?: string | null;
  status: PaymentStatus;
  preDisputeStatus?: PaymentStatus | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RefundResponse = {
  refundId: string;
  paymentId: string;
  amount: number;
  currency: string;
  status: string;
  triggerType: RefundTriggerType;
};
