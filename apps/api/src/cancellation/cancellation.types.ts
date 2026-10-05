import { BookingStatus, RefundStatus } from '@prisma/client';
import { IsNotEmpty, IsString } from 'class-validator';

export type { CancellationQuoteResponseDto, CancellationResponseDto } from '@shared/booking-types';

export class CancelBookingDto {
  @IsString()
  @IsNotEmpty()
  quoteId!: string;
}

export class CancellationStatusResponseDto {
  bookingId!: string;
  bookingStatus!: BookingStatus;
  cancellationDeadline!: string | null;
  airlineRefundAmount!: string | null;
  customerRefundAmount!: string | null;
  duffelCancellationQuoteId!: string | null;
  refundStatus!: RefundStatus | 'NOT_REQUIRED' | null;
  retryCount!: number | null;
  nextRetryAt!: string | null;
  lastErrorCode!: string | null;
  escalationMessage!: string | null;
}

export interface ParsedSupplierCancellationQuoteId {
  quoteId: string | null;
  refundTo: string | null;
  nonRefundableAncillaryAmount: string | null;
  nonRefundableAncillaryCurrency: string | null;
}

export type ParsedDuffelCancellationQuoteId = ParsedSupplierCancellationQuoteId;

export function parseSupplierCancellationQuoteId(
  serialized: string | null | undefined,
): ParsedSupplierCancellationQuoteId {
  if (!serialized) {
    return {
      quoteId: null,
      refundTo: null,
      nonRefundableAncillaryAmount: null,
      nonRefundableAncillaryCurrency: null,
    };
  }
  if (serialized === 'PENDING_QUOTE') {
    return {
      quoteId: 'PENDING_QUOTE',
      refundTo: null,
      nonRefundableAncillaryAmount: null,
      nonRefundableAncillaryCurrency: null,
    };
  }
  const parts = serialized.split('|');
  if (parts.length === 1) {
    return {
      quoteId: parts[0],
      refundTo: null,
      nonRefundableAncillaryAmount: null,
      nonRefundableAncillaryCurrency: null,
    };
  }
  return {
    quoteId: parts[0] || null,
    refundTo: parts[1] || null,
    nonRefundableAncillaryAmount: parts[2] || null,
    nonRefundableAncillaryCurrency: parts[3] || null,
  };
}

export const parseDuffelCancellationQuoteId = parseSupplierCancellationQuoteId;

export function serializeSupplierCancellationQuoteId(
  quoteId: string,
  refundTo: string | null,
  nonRefundableAmount: string | null,
  nonRefundableCurrency: string | null,
): string {
  const parts = [quoteId, refundTo || '', nonRefundableAmount || '', nonRefundableCurrency || ''];
  return parts.join('|');
}

export const serializeDuffelCancellationQuoteId = serializeSupplierCancellationQuoteId;
