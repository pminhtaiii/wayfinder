import { BadRequestException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';

const ALLOWED_TRANSITIONS: Record<PaymentStatus, Set<PaymentStatus>> = {
  [PaymentStatus.RESERVED]: new Set([
    PaymentStatus.CREATED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ]),
  [PaymentStatus.CREATED]: new Set([
    PaymentStatus.AUTHORIZED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ]),
  [PaymentStatus.AUTHORIZED]: new Set([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED,
  ]),
  [PaymentStatus.SUCCEEDED]: new Set([PaymentStatus.REFUND_PENDING, PaymentStatus.DISPUTED]),
  [PaymentStatus.REFUND_PENDING]: new Set([
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.SUCCEEDED,
  ]),
  [PaymentStatus.PARTIALLY_REFUNDED]: new Set([
    PaymentStatus.REFUND_PENDING,
    PaymentStatus.DISPUTED,
  ]),
  [PaymentStatus.REFUNDED]: new Set([PaymentStatus.DISPUTED]),
  [PaymentStatus.DISPUTED]: new Set([
    PaymentStatus.SUCCEEDED,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.CHARGEBACK_LOST,
  ]),
  [PaymentStatus.FAILED]: new Set(),
  [PaymentStatus.EXPIRED]: new Set(),
  [PaymentStatus.CANCELLED]: new Set(),
  [PaymentStatus.CHARGEBACK_LOST]: new Set(),
};

/**
 * Checks if a transition from currentStatus to targetStatus is allowed.
 */
export function canTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  return allowed ? allowed.has(targetStatus) : false;
}

/**
 * Enforces a state transition, throwing a BadRequestException if invalid.
 */
export function enforceTransition(currentStatus: PaymentStatus, targetStatus: PaymentStatus): void {
  if (!canTransition(currentStatus, targetStatus)) {
    throw new BadRequestException(
      `Invalid payment status transition from ${currentStatus} to ${targetStatus}`,
    );
  }
}

/**
 * Returns the current status when entering DISPUTED (for storing pre_dispute_status).
 */
export function getPreDisputeStatus(currentStatus: PaymentStatus): PaymentStatus {
  if (
    currentStatus === PaymentStatus.SUCCEEDED ||
    currentStatus === PaymentStatus.PARTIALLY_REFUNDED ||
    currentStatus === PaymentStatus.REFUNDED
  ) {
    return currentStatus;
  }
  throw new BadRequestException(`Cannot enter dispute from status: ${currentStatus}`);
}

/**
 * Resolves the dispute status based on the outcome and preDisputeStatus.
 */
export function resolveDisputeStatus(
  outcome: 'won' | 'lost',
  preDisputeStatus: PaymentStatus,
): PaymentStatus {
  if (outcome === 'won') {
    return preDisputeStatus;
  }
  if (outcome === 'lost') {
    return PaymentStatus.CHARGEBACK_LOST;
  }
  throw new BadRequestException(`Invalid dispute outcome: ${outcome}`);
}
