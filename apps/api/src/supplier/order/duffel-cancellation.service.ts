import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { CancelOrderOutcome } from '@/payment-fulfillment/ports';
import { DuffelOrderAdapter } from './duffel-order.adapter';

export type DuffelCancellationQuote = {
  id: string;
  order_id: string;
  refund_amount?: string | null;
  total_refund_amount?: string | null;
  refund_currency?: string | null;
  currency?: string | null;
  expires_at?: string | null;
  expiresAt?: string | null;
  refundable?: boolean;
  refund_to?: string | null;
  non_refundable_ancillary_amount?: string | null;
  non_refundable_ancillary_currency?: string | null;
  [key: string]: unknown;
};

export type DuffelConfirmedCancellation = {
  id: string;
  order_id: string;
  status: 'PENDING' | 'CONFIRMED';
  refund_amount: string | null;
  refund_currency: string | null;
  refundable: boolean;
  confirmed_at: string | null;
};

@Injectable()
export class DuffelCancellationService {
  constructor(private readonly orderAdapter: DuffelOrderAdapter) {}

  async createCancellationQuote(orderId: string): Promise<DuffelCancellationQuote> {
    const quote = await this.orderAdapter.createCancellationQuote(orderId);
    if (!this.isCancellationQuote(quote)) {
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_QUOTE_FAILED',
          message: 'Invalid Duffel cancellation quote',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return quote;
  }

  async confirmCancellationQuote(quoteId: string): Promise<DuffelConfirmedCancellation> {
    const cancellation = await this.orderAdapter.confirmCancellationQuote(quoteId);
    if (!this.isRecord(cancellation)) {
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
          message: 'Invalid Duffel cancellation response',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    const { id, order_id: orderId, status, refundable } = cancellation;
    if (
      typeof id !== 'string' ||
      typeof orderId !== 'string' ||
      (status !== 'PENDING' && status !== 'CONFIRMED') ||
      typeof refundable !== 'boolean' ||
      !this.isNullableStringOrMissing(cancellation.refund_amount) ||
      !this.isNullableStringOrMissing(cancellation.refund_currency) ||
      !this.isNullableStringOrMissing(cancellation.confirmed_at)
    ) {
      throw new HttpException(
        {
          code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
          message: 'Invalid Duffel cancellation response',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
    return {
      id,
      order_id: orderId,
      status,
      refund_amount: this.stringOrNull(cancellation.refund_amount),
      refund_currency: this.stringOrNull(cancellation.refund_currency),
      refundable,
      confirmed_at: this.stringOrNull(cancellation.confirmed_at),
    };
  }

  async cancelOrder(orderId: string): Promise<CancelOrderOutcome> {
    try {
      const cancellation = await this.orderAdapter.cancelOrder(orderId);
      return this.normalizeCancellationOutcome(orderId, cancellation);
    } catch (error: unknown) {
      if (this.isBudgetDenial(error)) {
        throw error;
      }
      try {
        const recoveredOrder = await this.orderAdapter.retrieveOrder(orderId);
        if (recoveredOrder.status === 'CANCELLED') {
          return this.normalizeCancellationOutcome(orderId, recoveredOrder);
        }
      } catch {
        // Keep the original cancellation failure when retrieval cannot confirm completion.
      }
      throw error;
    }
  }

  private normalizeCancellationOutcome(orderId: string, value: unknown): CancelOrderOutcome {
    const response = this.isRecord(value) ? value : undefined;
    const success = this.isCancellationConfirmed(response);

    return {
      success,
      orderId,
      status: success
        ? 'CANCELLED'
        : response && typeof response.status === 'string'
          ? response.status
          : undefined,
    };
  }

  private isCancellationConfirmed(response: Record<string, unknown> | undefined): boolean {
    if (!response || response.success === false) return false;

    if (typeof response.confirmed_at === 'string' && response.confirmed_at.trim().length > 0) {
      return true;
    }

    return (
      typeof response.status === 'string' &&
      ['confirmed', 'cancelled', 'canceled'].includes(response.status.toLowerCase())
    );
  }

  private isCancellationQuote(value: unknown): value is DuffelCancellationQuote {
    if (!this.isRecord(value) || typeof value.id !== 'string' || typeof value.order_id !== 'string') {
      return false;
    }
    const stringFields = [
      'refund_amount',
      'total_refund_amount',
      'refund_currency',
      'currency',
      'expires_at',
      'expiresAt',
      'refund_to',
      'non_refundable_ancillary_amount',
      'non_refundable_ancillary_currency',
    ];
    if (stringFields.some((field) => !this.isOptionalNullableString(value, field))) {
      return false;
    }
    return !('refundable' in value) || typeof value.refundable === 'boolean';
  }

  private isOptionalNullableString(value: Record<string, unknown>, field: string): boolean {
    return !(field in value) || this.isNullableStringOrMissing(value[field]);
  }

  private isNullableStringOrMissing(value: unknown): boolean {
    return value === undefined || value === null || typeof value === 'string';
  }

  private stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isBudgetDenial(error: unknown): boolean {
    if (!(error instanceof HttpException) || error.getStatus() !== HttpStatus.TOO_MANY_REQUESTS) {
      return false;
    }
    const response: unknown = error.getResponse();
    if (!this.isRecord(response)) {
      return false;
    }
    return response.code === 'RATE_LIMIT_EXCEEDED' || response.code === 'BUDGET_UNAVAILABLE';
  }
}
