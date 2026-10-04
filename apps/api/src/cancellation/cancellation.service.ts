import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Booking,
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  RefundStatus,
} from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { PaymentRefundService } from '@/payment/payment-refund.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingEventPublisherService, PublishableEvent } from '@/domain-events';
import {
  CancellationQuoteResponseDto,
  CancellationResponseDto,
  CancellationStatusResponseDto,
  parseDuffelCancellationQuoteId,
  serializeDuffelCancellationQuoteId,
} from './cancellation.types';

@Injectable()
export class CancellationService {
  private readonly logger = new Logger(CancellationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly duffelCancellationService: DuffelCancellationService,
    private readonly duffelRecoveryService: DuffelRecoveryService,
    private readonly paymentRefundService: PaymentRefundService,
    private readonly bookingLifecycleService: BookingLifecycleService,
    private readonly publisher: BookingEventPublisherService,
  ) {}

  async getCancellationStatus(
    bookingId: string,
    userId: string,
  ): Promise<CancellationStatusResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        cancellationRefundObligation: {
          include: {
            refunds: {
              orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            },
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    const obligation = booking.cancellationRefundObligation;
    const refunds = obligation?.refunds ?? [];
    const isZeroValueObligation = obligation?.totalAmount === 0;
    const refundedAmount = refunds
      .filter((refund) => refund.status === RefundStatus.SUCCEEDED)
      .reduce((total, refund) => total + refund.amount, 0);
    const isFulfilled =
      obligation != null
        ? !isZeroValueObligation && refundedAmount >= obligation.totalAmount
        : booking.status === BookingStatus.CANCELLED_AND_REFUNDED;

    const selectHighestPriority = <
      T extends {
        status: RefundStatus;
        updatedAt: Date;
        id: string;
      },
    >(
      candidates: T[],
      priority: Partial<Record<RefundStatus, number>>,
    ): T | undefined => {
      const matching = candidates.filter((c) => priority[c.status] !== undefined);
      if (matching.length === 0) {
        return undefined;
      }
      return [...matching].sort((left, right) => {
        const priorityDifference =
          (priority[left.status] ?? Number.MAX_SAFE_INTEGER) -
          (priority[right.status] ?? Number.MAX_SAFE_INTEGER);
        if (priorityDifference !== 0) {
          return priorityDifference;
        }

        const updatedAtDifference = right.updatedAt.getTime() - left.updatedAt.getTime();
        return updatedAtDifference !== 0 ? updatedAtDifference : right.id.localeCompare(left.id);
      })[0];
    };

    const activeRefund = selectHighestPriority(refunds, {
      [RefundStatus.REFUND_PROCESSING]: 0,
      [RefundStatus.REFUND_RETRY_SCHEDULED]: 1,
      [RefundStatus.REFUND_PENDING]: 2,
    });
    const terminalRefund = selectHighestPriority(refunds, {
      [RefundStatus.REFUND_FAILED_NEEDS_ATTENTION]: 0,
      [RefundStatus.FAILED]: 1,
    });
    const projectedRefund =
      isFulfilled || isZeroValueObligation ? undefined : (activeRefund ?? terminalRefund);
    const refundStatus: RefundStatus | 'NOT_REQUIRED' | null = isZeroValueObligation
      ? 'NOT_REQUIRED'
      : isFulfilled
        ? RefundStatus.SUCCEEDED
        : (projectedRefund?.status ?? (obligation ? RefundStatus.REFUND_PENDING : null));

    let escalationMessage: string | null = null;
    if (refundStatus === RefundStatus.REFUND_FAILED_NEEDS_ATTENTION) {
      const updatedAt = projectedRefund?.updatedAt ?? booking.updatedAt;
      const hoursElapsed = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
      if (hoursElapsed < 48) {
        escalationMessage =
          'Refund is taking longer than expected. Our team is reviewing \u2014 no action needed.';
      } else {
        escalationMessage = 'Refund requires attention. Please contact support.';
      }
    }

    return {
      bookingId: booking.id,
      bookingStatus: booking.status,
      cancellationDeadline: booking.cancellationDeadline?.toISOString() ?? null,
      airlineRefundAmount: booking.airlineRefundAmount?.toString() ?? null,
      customerRefundAmount: booking.customerRefundAmount?.toString() ?? null,
      duffelCancellationQuoteId: parseDuffelCancellationQuoteId(
        booking.supplierCancellationQuoteId,
      ).quoteId,
      refundStatus,
      retryCount: projectedRefund?.retryCount ?? null,
      nextRetryAt: projectedRefund?.nextRetryAt?.toISOString() ?? null,
      lastErrorCode: projectedRefund?.lastErrorCode ?? null,
      escalationMessage,
    };
  }

  async getCancellationQuote(
    bookingId: string,
    userId: string,
  ): Promise<CancellationQuoteResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    if (
      booking.status !== BookingStatus.CONFIRMED ||
      (booking.departureAt && booking.departureAt <= new Date())
    ) {
      throw new BadRequestException('Booking is not eligible for cancellation quote');
    }

    if (!booking.supplierOrderId) {
      throw new BadRequestException('No Duffel order associated with booking');
    }

    const now = new Date();

    if (
      booking.supplierCancellationQuoteId &&
      booking.supplierCancellationQuoteId !== 'PENDING_QUOTE' &&
      booking.cancellationDeadline &&
      booking.cancellationDeadline > now
    ) {
      const parsed = parseDuffelCancellationQuoteId(booking.supplierCancellationQuoteId);
      return {
        quoteId: parsed.quoteId || '',
        bookingId: booking.id,
        duffelOrderId: booking.supplierOrderId,
        refundAmount: booking.customerRefundAmount
          ? booking.customerRefundAmount.toString()
          : '0.00',
        currency: booking.currency,
        expiresAt: booking.cancellationDeadline.toISOString(),
        refundable: booking.cancellationRefundable ?? false,
        cancellationDeadline: booking.cancellationDeadline.toISOString(),
        refundTo: parsed.refundTo,
        nonRefundableAncillaryAmount: parsed.nonRefundableAncillaryAmount,
        nonRefundableAncillaryCurrency: parsed.nonRefundableAncillaryCurrency,
      };
    }

    let claimed = false;

    if (booking.supplierCancellationQuoteId !== 'PENDING_QUOTE') {
      const claimResult = await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.CONFIRMED,
          OR: [
            { supplierCancellationQuoteId: null },
            {
              cancellationDeadline: { lte: now },
              supplierCancellationQuoteId: { not: 'PENDING_QUOTE' },
            },
          ],
        },
        data: {
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
      });
      claimed = claimResult.count > 0;
    }

    if (!claimed) {
      for (let attempt = 0; attempt < 25; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const updatedBooking = await this.prisma.booking.findUnique({ where: { id: booking.id } });
        if (
          updatedBooking &&
          updatedBooking.supplierCancellationQuoteId &&
          updatedBooking.supplierCancellationQuoteId !== 'PENDING_QUOTE' &&
          updatedBooking.cancellationDeadline &&
          updatedBooking.cancellationDeadline > new Date()
        ) {
          const parsed = parseDuffelCancellationQuoteId(
            updatedBooking.supplierCancellationQuoteId,
          );
          return {
            quoteId: parsed.quoteId || '',
            bookingId: updatedBooking.id,
            duffelOrderId: updatedBooking.supplierOrderId || booking.supplierOrderId,
            refundAmount: updatedBooking.customerRefundAmount
              ? updatedBooking.customerRefundAmount.toString()
              : '0.00',
            currency: updatedBooking.currency,
            expiresAt: updatedBooking.cancellationDeadline.toISOString(),
            refundable: updatedBooking.cancellationRefundable ?? false,
            cancellationDeadline: updatedBooking.cancellationDeadline.toISOString(),
            refundTo: parsed.refundTo,
            nonRefundableAncillaryAmount: parsed.nonRefundableAncillaryAmount,
            nonRefundableAncillaryCurrency: parsed.nonRefundableAncillaryCurrency,
          };
        }
      }
      throw new BadRequestException('Booking state changed or quote creation in progress');
    }

    try {
      const quote = await this.duffelCancellationService.createCancellationQuote(
        booking.supplierOrderId,
      );

      const quoteId = quote.id;
      const duffelOrderId = quote.order_id || booking.supplierOrderId;
      const refundAmount = quote.refund_amount ?? quote.total_refund_amount ?? '0.00';
      const currency = quote.refund_currency ?? quote.currency ?? booking.currency ?? 'GBP';
      const expiresAt =
        quote.expires_at ??
        quote.expiresAt ??
        new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const refundable =
        quote.refundable !== undefined
          ? Boolean(quote.refundable)
          : parseFloat(String(refundAmount)) > 0;
      const cancellationDeadline = expiresAt;

      const refundTo = quote.refund_to || null;
      const nonRefundableAmount = quote.non_refundable_ancillary_amount || null;
      const nonRefundableCurrency = quote.non_refundable_ancillary_currency || null;

      const serializedQuoteId = serializeDuffelCancellationQuoteId(
        quoteId,
        refundTo,
        nonRefundableAmount,
        nonRefundableCurrency,
      );

      const finalizeResult = await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          status: BookingStatus.CONFIRMED,
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: {
          supplierCancellationQuoteId: serializedQuoteId,
          customerRefundAmount: refundAmount,
          cancellationRefundable: refundable,
          cancellationDeadline: cancellationDeadline ? new Date(cancellationDeadline) : null,
        },
      });

      if (finalizeResult.count === 0) {
        throw new BadRequestException('Booking status changed while generating cancellation quote');
      }

      return {
        quoteId,
        bookingId: booking.id,
        duffelOrderId,
        refundAmount: String(refundAmount),
        currency,
        expiresAt,
        refundable,
        cancellationDeadline,
        refundTo,
        nonRefundableAncillaryAmount: nonRefundableAmount,
        nonRefundableAncillaryCurrency: nonRefundableCurrency,
      };
    } catch (error) {
      await this.prisma.booking.updateMany({
        where: {
          id: booking.id,
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: {
          supplierCancellationQuoteId: null,
        },
      });
      throw error;
    }
  }

  async cancelBooking(
    bookingId: string,
    userId: string,
    quoteId: string,
  ): Promise<CancellationResponseDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: { select: { id: true } } },
    });
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    if (booking.userId !== userId) {
      throw new ForbiddenException('You do not have access to this booking');
    }
    const parsed = parseDuffelCancellationQuoteId(booking.supplierCancellationQuoteId);
    if (!booking.supplierOrderId || parsed.quoteId !== quoteId) {
      throw new BadRequestException('Cancellation quote is invalid');
    }
    if (booking.cancellationDeadline && booking.cancellationDeadline <= new Date()) {
      throw new BadRequestException('Cancellation quote has expired');
    }

    const staleClaimThreshold = new Date(Date.now() - 2 * 60 * 1000);
    let claimEvents: PublishableEvent[] = [];
    const claim = await this.prisma.$transaction(async (tx) => {
      const claimContext = this.publisher.createContext(tx);
      const claimResult = await this.bookingLifecycleService.claimCancellation(
        bookingId,
        userId,
        staleClaimThreshold,
        tx,
        claimContext,
      );
      claimEvents = claimContext.events;
      return claimResult;
    });

    if (claimEvents.length > 0) {
      try {
        await this.publisher.publish(claimEvents);
      } catch (error) {
        this.logger.error(
          `[cancelBooking] Failed to dispatch cancellation pending events for booking ${bookingId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    if (claim.count === 0) {
      const canonical = await this.prisma.booking.findUnique({ where: { id: bookingId } });
      if (!canonical) {
        throw new NotFoundException('Booking not found');
      }
      return this.toCancellationResponse(canonical);
    }

    const recoveredOrder = await this.duffelRecoveryService.retrieveOrder(booking.supplierOrderId);
    let refundAmount = booking.customerRefundAmount?.toString() ?? '0.00';
    let refundable = booking.cancellationRefundable;
    if (recoveredOrder.status !== 'CANCELLED') {
      const confirmation = await this.confirmCancellationWithRetries(quoteId);
      if (confirmation.status !== 'CONFIRMED') {
        throw new BadGatewayException('Supplier cancellation could not be confirmed');
      }
      refundAmount = confirmation.refund_amount ?? refundAmount;
      refundable = confirmation.refundable;
    }

    const amountInMinorUnits = Math.round(Number(refundAmount) * 100);
    const cancellationStatus =
      refundable && amountInMinorUnits > 0
        ? BookingStatus.CANCELLED_PENDING_REFUND
        : BookingStatus.CANCELLED_NO_REFUND;

    let finalEvents: PublishableEvent[] = [];
    const persistedCount = await this.prisma.$transaction(async (tx) => {
      const cancelContext = this.publisher.createContext(tx);
      const cancelResult = await this.bookingLifecycleService.cancelBooking(
        bookingId,
        cancellationStatus,
        refundAmount,
        {
          resolvedByType: DisruptionActorType.TRAVELLER,
          resolvedById: userId,
        },
        tx,
        cancelContext,
      );

      if (cancelResult.count === 0) {
        return 0;
      }

      if (booking.payment) {
        const existingObligation = await tx.cancellationRefundObligation.findUnique({
          where: { bookingId },
          select: { id: true },
        });
        const obligation = await tx.cancellationRefundObligation.upsert({
          where: { bookingId },
          update: {
            paymentId: booking.payment.id,
            totalAmount: amountInMinorUnits,
            airlineRefundAmount: amountInMinorUnits,
            currency: booking.currency.toUpperCase(),
          },
          create: {
            bookingId,
            paymentId: booking.payment.id,
            totalAmount: amountInMinorUnits,
            airlineRefundAmount: amountInMinorUnits,
            currency: booking.currency.toUpperCase(),
          },
        });
        const obligationAuditId = `cancellation-obligation:${bookingId}`;
        await tx.auditLog.create({
          data: {
            userId,
            action: 'cancellation_refund_obligation_upserted',
            resourceType: 'CancellationRefundObligation',
            resourceId: obligation.id,
            metadata: {
              operation: existingObligation ? 'UPDATED' : 'CREATED',
              totalAmountMinorUnits: amountInMinorUnits,
              airlineRefundAmountMinorUnits: amountInMinorUnits,
              currency: booking.currency.toUpperCase(),
            },
            traceId: obligationAuditId,
            correlationId: obligationAuditId,
          },
        });
      }

      if (cancelResult.hasActiveDisruption) {
        await tx.disruptionAuditEvent.create({
          data: {
            bookingId,
            revisionId: cancelResult.activeDisruptionRevisionId,
            action: 'BOOKING_CANCELLED',
            fromStatus: cancelResult.previousDisruptionStatus,
            toStatus: DisruptionStatus.RESOLVED,
            actorType: DisruptionActorType.TRAVELLER,
            actorId: userId,
            correlationId: `cancel-${bookingId}-${Date.now()}`,
            traceId: `cancel-${bookingId}-${Date.now()}`,
            createdAt: new Date(),
          },
        });
      }

      finalEvents = cancelContext.events;
      return cancelResult.count;
    });

    if (finalEvents.length > 0) {
      try {
        await this.publisher.publish(finalEvents);
      } catch (error) {
        this.logger.error(
          `[cancelBooking] Failed to dispatch cancellation finalized events for booking ${bookingId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    if (persistedCount === 0) {
      const canonical = await this.prisma.booking.findUnique({ where: { id: bookingId } });
      if (!canonical) {
        throw new NotFoundException('Booking not found');
      }
      return this.toCancellationResponse(canonical);
    }
    if (cancellationStatus === BookingStatus.CANCELLED_NO_REFUND || !booking.payment) {
      return {
        bookingId,
        bookingStatus: cancellationStatus,
        cancellationStatus,
        refundStatus: 'NOT_REQUIRED',
        refundAmount,
      };
    }

    const refund = await this.paymentRefundService.processCancellationRefund({
      bookingId,
      paymentId: booking.payment.id,
      amount: amountInMinorUnits,
      currency: booking.currency,
    });
    return {
      bookingId,
      bookingStatus:
        refund.refundStatus === 'SUCCEEDED'
          ? BookingStatus.CANCELLED_AND_REFUNDED
          : cancellationStatus,
      cancellationStatus,
      refundStatus: refund.refundStatus,
      refundAmount: refund.refundAmount,
      nextRetryAt: refund.nextRetryAt,
    };
  }

  async confirmCancellationWithRetries(
    quoteId: string,
  ): Promise<Awaited<ReturnType<DuffelCancellationService['confirmCancellationQuote']>>> {
    const retryDelays = [1_000, 3_000, 5_000, 10_000];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        return await this.duffelCancellationService.confirmCancellationQuote(quoteId);
      } catch (error) {
        if (!this.isRetryableSupplierError(error) || attempt === retryDelays.length) {
          throw new BadGatewayException('Supplier cancellation could not be confirmed');
        }
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]));
      }
    }
    throw new BadGatewayException('Supplier cancellation could not be confirmed');
  }

  isRetryableSupplierError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
    return typeof status === 'number' && (status === 429 || status >= 500);
  }

  toCancellationResponse(booking: Booking): CancellationResponseDto {
    const refundStatus =
      booking.status === BookingStatus.CANCELLED_AND_REFUNDED
        ? 'SUCCEEDED'
        : booking.status === BookingStatus.FAILED &&
            booking.failureReason === BookingFailureReason.SYSTEM_ERROR
          ? 'REFUND_FAILED_NEEDS_ATTENTION'
          : 'PENDING';
    return {
      bookingId: booking.id,
      bookingStatus: booking.status,
      cancellationStatus: booking.status,
      refundStatus,
      refundAmount: booking.customerRefundAmount?.toString() ?? '0.00',
      duffelCancellationQuoteId: parseDuffelCancellationQuoteId(
        booking.supplierCancellationQuoteId,
      ).quoteId,
    };
  }
}
