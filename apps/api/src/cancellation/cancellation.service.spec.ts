import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  RefundStatus,
} from '@prisma/client';
import { CancellationService } from './cancellation.service';
import {
  parseDuffelCancellationQuoteId,
  serializeDuffelCancellationQuoteId,
} from './cancellation.types';
import {
  BookingCancellationPendingEvent,
  BookingCancelledEvent,
  BookingEventPublisherService,
} from '@/domain-events';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';

describe('CancellationService', () => {
  let service: CancellationService;
  let mockPrisma: any;
  let mockDuffelService: any;
  let mockPaymentRefundService: any;
  let mockBookingLifecycleService: any;
  let mockPublisher: jest.Mocked<BookingEventPublisherService>;

  beforeEach(() => {
    mockPrisma = {
      booking: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      cancellationRefundObligation: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'obligation-default' }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-default' }),
      },
      disruptionAuditEvent: {
        create: jest.fn().mockResolvedValue({ id: 'disr-default' }),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };

    mockDuffelService = {
      cancellation: {
        createCancellationQuote: jest.fn(),
        confirmCancellationQuote: jest.fn(),
      },
      recovery: { retrieveOrder: jest.fn() },
    };

    mockPaymentRefundService = {
      processCancellationRefund: jest.fn().mockResolvedValue({
        refundStatus: 'SUCCEEDED',
        refundAmount: '100.00',
        nextRetryAt: null,
      }),
    };

    mockBookingLifecycleService = {
      claimCancellation: jest.fn().mockResolvedValue({ count: 1 }),
      cancelBooking: jest.fn().mockResolvedValue({
        count: 1,
        hasActiveDisruption: false,
        activeDisruptionRevisionId: null,
        previousDisruptionStatus: null,
      }),
    };

    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
      resolveEventName: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<BookingEventPublisherService>;

    service = new CancellationService(
      mockPrisma,
      mockDuffelService.cancellation,
      mockDuffelService.recovery,
      mockPaymentRefundService,
      mockBookingLifecycleService as unknown as BookingLifecycleService,
      mockPublisher,
    );
  });

  describe('parseDuffelCancellationQuoteId and serializeDuffelCancellationQuoteId', () => {
    it('handles null, undefined, empty string, and PENDING_QUOTE', () => {
      expect(parseDuffelCancellationQuoteId(null)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });

      expect(parseDuffelCancellationQuoteId(undefined)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });

      expect(parseDuffelCancellationQuoteId('')).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });

      expect(parseDuffelCancellationQuoteId('PENDING_QUOTE')).toEqual({
        quoteId: 'PENDING_QUOTE',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses legacy simple quoteId without delimiter', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses serialized multi-part quoteId string', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123|balance|15.00|USD')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: 'balance',
        nonRefundableAncillaryAmount: '15.00',
        nonRefundableAncillaryCurrency: 'USD',
      });
    });

    it('serializes and round-trips quote metadata', () => {
      const serialized = serializeDuffelCancellationQuoteId(
        'can_quo_999',
        'airline_credits',
        '25.00',
        'GBP',
      );
      expect(serialized).toBe('can_quo_999|airline_credits|25.00|GBP');
      expect(parseDuffelCancellationQuoteId(serialized)).toEqual({
        quoteId: 'can_quo_999',
        refundTo: 'airline_credits',
        nonRefundableAncillaryAmount: '25.00',
        nonRefundableAncillaryCurrency: 'GBP',
      });
    });
  });

  describe('getCancellationStatus', () => {
    const baseBooking = {
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CANCELLED_PENDING_REFUND,
      updatedAt: new Date('2026-08-23T12:00:00.000Z'),
      cancellationDeadline: null,
      airlineRefundAmount: { toString: () => '100.00' },
      customerRefundAmount: { toString: () => '100.00' },
      supplierCancellationQuoteId: 'quote-1',
    };

    const refund = (overrides: Record<string, unknown>) => ({
      id: 'refund-1',
      status: RefundStatus.REFUND_PENDING,
      amount: 0,
      retryCount: 0,
      nextRetryAt: null,
      lastErrorCode: null,
      updatedAt: new Date('2026-08-23T11:00:00.000Z'),
      ...overrides,
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);
      await expect(service.getCancellationStatus('b-unknown', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if user does not own booking', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        userId: 'other-user',
      });
      await expect(service.getCancellationStatus('booking-1', 'user-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('reports SUCCEEDED for a fulfilled booking even when stale failed and retrying transactions remain linked', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        cancellationRefundObligation: {
          totalAmount: 10_000,
          refunds: [
            refund({ id: 'refund-succeeded', status: RefundStatus.SUCCEEDED, amount: 10_000 }),
            refund({
              id: 'refund-retrying',
              status: RefundStatus.REFUND_RETRY_SCHEDULED,
              retryCount: 2,
              nextRetryAt: new Date('2026-08-24T11:00:00.000Z'),
            }),
            refund({
              id: 'refund-failed',
              status: RefundStatus.FAILED,
              lastErrorCode: 'STALE_FAILURE',
            }),
          ],
        },
      });

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
        refundStatus: RefundStatus.SUCCEEDED,
        retryCount: null,
        nextRetryAt: null,
        lastErrorCode: null,
      });
    });

    it('prioritizes the active processing transaction over partial success and terminal failures', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        cancellationRefundObligation: {
          totalAmount: 10_000,
          refunds: [
            refund({ id: 'refund-succeeded', status: RefundStatus.SUCCEEDED, amount: 3_000 }),
            refund({
              id: 'refund-scheduled',
              status: RefundStatus.REFUND_RETRY_SCHEDULED,
              retryCount: 2,
              nextRetryAt: new Date('2026-08-24T11:00:00.000Z'),
              lastErrorCode: 'RATE_LIMIT',
            }),
            refund({
              id: 'refund-processing',
              status: RefundStatus.REFUND_PROCESSING,
              retryCount: 3,
              lastErrorCode: 'PROVIDER_DELAY',
            }),
            refund({
              id: 'refund-attention',
              status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
              lastErrorCode: 'STALE_FAILURE',
            }),
          ],
        },
      });

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: RefundStatus.REFUND_PROCESSING,
        retryCount: 3,
        nextRetryAt: null,
        lastErrorCode: 'PROVIDER_DELAY',
        escalationMessage: null,
      });
    });

    it('does not treat a partial success as fulfilled and surfaces the terminal attention transaction', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        cancellationRefundObligation: {
          totalAmount: 10_000,
          refunds: [
            refund({ id: 'refund-partial', status: RefundStatus.SUCCEEDED, amount: 3_000 }),
            refund({
              id: 'refund-attention',
              status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
              lastErrorCode: 'PROVIDER_DECLINED',
              updatedAt: new Date(Date.now() - 10 * 60 * 60 * 1000), // 10h ago (<48h)
            }),
          ],
        },
      });

      const result = await service.getCancellationStatus('booking-1', 'user-1');
      expect(result).toMatchObject({
        refundStatus: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
        lastErrorCode: 'PROVIDER_DECLINED',
        escalationMessage:
          'Refund is taking longer than expected. Our team is reviewing \u2014 no action needed.',
      });
    });

    it('sets escalation message for REFUND_FAILED_NEEDS_ATTENTION when > 48h elapsed', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        cancellationRefundObligation: {
          totalAmount: 10_000,
          refunds: [
            refund({
              id: 'refund-attention',
              status: RefundStatus.REFUND_FAILED_NEEDS_ATTENTION,
              lastErrorCode: 'EXPIRED',
              updatedAt: new Date(Date.now() - 50 * 60 * 60 * 1000), // 50h ago (>48h)
            }),
          ],
        },
      });

      const result = await service.getCancellationStatus('booking-1', 'user-1');
      expect(result.escalationMessage).toBe('Refund requires attention. Please contact support.');
    });

    it('reports NOT_REQUIRED with no provider metadata for a zero-value obligation', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.CANCELLED_NO_REFUND,
        cancellationRefundObligation: {
          totalAmount: 0,
          refunds: [],
        },
      });

      await expect(service.getCancellationStatus('booking-1', 'user-1')).resolves.toMatchObject({
        refundStatus: 'NOT_REQUIRED',
        retryCount: null,
        nextRetryAt: null,
        lastErrorCode: null,
      });
    });

    it('handles booking without obligation when CANCELLED_AND_REFUNDED vs not', async () => {
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        ...baseBooking,
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        cancellationRefundObligation: null,
      });

      const res1 = await service.getCancellationStatus('booking-1', 'user-1');
      expect(res1.refundStatus).toBe(RefundStatus.SUCCEEDED);

      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        ...baseBooking,
        status: BookingStatus.CONFIRMED,
        cancellationRefundObligation: null,
      });

      const res2 = await service.getCancellationStatus('booking-1', 'user-1');
      expect(res2.refundStatus).toBeNull();
    });

    it('breaks ties between equal-priority refunds using updatedAt desc, then id', async () => {
      const dateA = new Date('2026-08-23T10:00:00.000Z');
      const dateB = new Date('2026-08-23T12:00:00.000Z');
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...baseBooking,
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        cancellationRefundObligation: {
          totalAmount: 5_000,
          refunds: [
            refund({
              id: 'refund-a',
              status: RefundStatus.REFUND_PENDING,
              updatedAt: dateA,
              retryCount: 1,
            }),
            refund({
              id: 'refund-b',
              status: RefundStatus.REFUND_PENDING,
              updatedAt: dateB,
              retryCount: 2,
            }),
          ],
        },
      });

      const res = await service.getCancellationStatus('booking-1', 'user-1');
      expect(res.retryCount).toBe(2);
    });
  });

  describe('getCancellationQuote', () => {
    beforeEach(() => {
      jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
        if (typeof fn === 'function') fn();
        return 0 as any;
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('throws NotFoundException if booking is not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);
      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if user is not booking owner', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        userId: 'other-user',
      });
      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException if booking status is not CONFIRMED', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
      });
      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if departureAt is in the past', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() - 3600000),
      });
      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException if supplierOrderId is missing', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() + 3600000),
        supplierOrderId: null,
      });
      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(
        'No Duffel order associated with booking',
      );
    });

    it('returns existing cached quote if non-expired', async () => {
      const futureDate = new Date(Date.now() + 3600000);
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: 'quote-cached',
        cancellationDeadline: futureDate,
        customerRefundAmount: '100.00',
        currency: 'GBP',
        cancellationRefundable: true,
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);

      const result = await service.getCancellationQuote('b-1', 'u-1');
      expect(result.quoteId).toBe('quote-cached');
      expect(result.refundAmount).toBe('100.00');
    });

    it('creates new quote and updates booking when no quote exists', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockDuffelService.cancellation.createCancellationQuote.mockResolvedValue({
        id: 'quote-new',
        refund_amount: '100.00',
        refund_currency: 'GBP',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        refundable: true,
      });

      const result = await service.getCancellationQuote('b-1', 'u-1');
      expect(result.quoteId).toBe('quote-new');
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          OR: [
            { supplierCancellationQuoteId: null },
            {
              cancellationDeadline: { lte: expect.any(Date) },
              supplierCancellationQuoteId: { not: 'PENDING_QUOTE' },
            },
          ],
        },
        data: {
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
      });
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: expect.objectContaining({
          supplierCancellationQuoteId: 'quote-new|||',
        }),
      });
    });

    it('preserves supplier refund destination and disclosed non-refundable ancillary value', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockDuffelService.cancellation.createCancellationQuote.mockResolvedValue({
        id: 'quote-new',
        refund_amount: '80.00',
        refund_currency: 'GBP',
        refund_to: 'airline_credits',
        non_refundable_ancillary_amount: '20.00',
        non_refundable_ancillary_currency: 'GBP',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        refundable: true,
      });

      await expect(service.getCancellationQuote('b-1', 'u-1')).resolves.toMatchObject({
        refundAmount: '80.00',
        currency: 'GBP',
        refundTo: 'airline_credits',
        nonRefundableAncillaryAmount: '20.00',
        nonRefundableAncillaryCurrency: 'GBP',
      });
    });

    it('reverts PENDING_QUOTE to null on Duffel API failure', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockDuffelService.cancellation.createCancellationQuote.mockRejectedValue(new Error('Duffel API error'));

      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow('Duffel API error');
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'b-1',
          supplierCancellationQuoteId: 'PENDING_QUOTE',
        },
        data: {
          supplierCancellationQuoteId: null,
        },
      });
    });

    it('returns updated booking quote if updateMany count is 0 but concurrent request populated valid quote', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      const futureDate = new Date(Date.now() + 3600000);
      const concurrentBooking = {
        id: 'b-1',
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: 'quote-concurrent',
        cancellationDeadline: futureDate,
        customerRefundAmount: '100.00',
        currency: 'GBP',
        cancellationRefundable: true,
      };
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(booking)
        .mockResolvedValueOnce(concurrentBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

      const result = await service.getCancellationQuote('b-1', 'u-1');
      expect(result.quoteId).toBe('quote-concurrent');
    });

    it('throws BadRequestException if updateMany count is 0 and polling loop exhausts', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      const cancelledBooking = {
        id: 'b-1',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        supplierCancellationQuoteId: null,
      };
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(booking)
        .mockResolvedValue(cancelledBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(
        'Booking state changed or quote creation in progress',
      );
    });

    it('throws BadRequestException if finalize update count is 0', async () => {
      const booking = {
        id: 'b-1',
        userId: 'u-1',
        status: BookingStatus.CONFIRMED,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: null,
        cancellationDeadline: null,
        currency: 'GBP',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 1 }) // Claim successful
        .mockResolvedValueOnce({ count: 0 }); // Finalize failed
      mockDuffelService.cancellation.createCancellationQuote.mockResolvedValue({
        id: 'quote-new',
        refund_amount: '100.00',
        currency: 'GBP',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });

      await expect(service.getCancellationQuote('b-1', 'u-1')).rejects.toThrow(
        'Booking status changed while generating cancellation quote',
      );
    });
  });

  describe('cancelBooking', () => {
    const booking = {
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      supplierOrderId: 'order-1',
      supplierCancellationQuoteId: 'quote-1',
      cancellationDeadline: new Date(Date.now() + 60_000),
      customerRefundAmount: { toString: () => '100.00' },
      cancellationRefundable: true,
      currency: 'USD',
      payment: { id: 'payment-1' },
    };

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);
      await expect(service.cancelBooking('b-unknown', 'user-1', 'quote-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if user is not booking owner', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        userId: 'other-user',
      });
      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException if quoteId is invalid or supplierOrderId missing', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...booking,
        supplierCancellationQuoteId: 'quote-different',
      });
      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        'Cancellation quote is invalid',
      );

      mockPrisma.booking.findUnique.mockResolvedValue({
        ...booking,
        supplierOrderId: null,
      });
      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        'Cancellation quote is invalid',
      );
    });

    it('throws BadRequestException if cancellation quote has expired', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...booking,
        cancellationDeadline: new Date(Date.now() - 60_000),
      });
      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        'Cancellation quote has expired',
      );
    });

    it('reports a permanent cancellation refund failure without claiming it is pending if claim fails', async () => {
      const failedBooking = {
        id: 'booking-1',
        userId: 'user-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.SYSTEM_ERROR,
        supplierOrderId: 'ord-1',
        supplierCancellationQuoteId: 'quote-1',
        cancellationDeadline: new Date(Date.now() + 60_000),
        customerRefundAmount: { toString: () => '125.00' },
      };
      mockPrisma.booking.findUnique.mockResolvedValue(failedBooking);
      mockBookingLifecycleService.claimCancellation.mockResolvedValue({ count: 0 });

      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).resolves.toEqual({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.FAILED,
        cancellationStatus: BookingStatus.FAILED,
        duffelCancellationQuoteId: 'quote-1',
        refundStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
        refundAmount: '125.00',
      });
    });

    it('throws NotFoundException if claim fails and booking no longer exists', async () => {
      mockPrisma.booking.findUnique.mockResolvedValueOnce(booking).mockResolvedValueOnce(null);
      mockBookingLifecycleService.claimCancellation.mockResolvedValue({ count: 0 });

      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('confirms cancellation with Duffel if not already CANCELLED', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CONFIRMED' });
      mockDuffelService.cancellation.confirmCancellationQuote.mockResolvedValue({
        status: 'CONFIRMED',
        refund_amount: '100.00',
        refundable: true,
      });

      const transactionClient = {
        cancellationRefundObligation: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ id: 'obligation-1' }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        },
        disruptionAuditEvent: {
          create: jest.fn(),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(transactionClient));

      mockPaymentRefundService.processCancellationRefund.mockResolvedValue({
        refundStatus: 'SUCCEEDED',
        refundAmount: '100.00',
        nextRetryAt: null,
      });

      const result = await service.cancelBooking('booking-1', 'user-1', 'quote-1');
      expect(mockDuffelService.cancellation.confirmCancellationQuote).toHaveBeenCalledWith('quote-1');
      expect(mockBookingLifecycleService.cancelBooking).toHaveBeenCalledWith(
        'booking-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        '100.00',
        {
          resolvedByType: DisruptionActorType.TRAVELLER,
          resolvedById: 'user-1',
        },
        transactionClient,
        expect.any(Object),
      );
      expect(mockPaymentRefundService.processCancellationRefund).toHaveBeenCalledWith({
        bookingId: 'booking-1',
        paymentId: 'payment-1',
        amount: 10000,
        currency: 'USD',
      });
      expect(result).toEqual({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
        cancellationStatus: BookingStatus.CANCELLED_PENDING_REFUND,
        refundStatus: 'SUCCEEDED',
        refundAmount: '100.00',
        nextRetryAt: null,
      });
    });

    it('throws BadGatewayException if supplier confirmation status is not CONFIRMED', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CONFIRMED' });
      mockDuffelService.cancellation.confirmCancellationQuote.mockResolvedValue({
        status: 'FAILED',
      });

      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        BadGatewayException,
      );
    });

    it('aborts cancellation persistence before a provider refund when obligation auditing fails in the transaction', async () => {
      const transactionClient = {
        cancellationRefundObligation: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ id: 'obligation-1' }),
        },
        auditLog: {
          create: jest.fn().mockRejectedValue(new Error('audit write failed')),
        },
      };
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });
      mockPrisma.$transaction.mockImplementation(async (callback: any) =>
        callback(transactionClient),
      );

      await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
        'audit write failed',
      );

      expect(transactionClient.cancellationRefundObligation.upsert).toHaveBeenCalledTimes(1);
      expect(transactionClient.auditLog.create).toHaveBeenCalledTimes(1);
      expect(mockPaymentRefundService.processCancellationRefund).not.toHaveBeenCalled();
    });

    it('resolves active disruption and logs disruption audit event when cancelling disrupted booking', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });
      mockBookingLifecycleService.cancelBooking.mockResolvedValueOnce({
        count: 1,
        hasActiveDisruption: true,
        activeDisruptionRevisionId: 'disruption-rev-1',
        previousDisruptionStatus: DisruptionStatus.DETECTED,
      });

      const transactionClient = {
        cancellationRefundObligation: {
          findUnique: jest.fn().mockResolvedValue({ id: 'obligation-1' }),
          upsert: jest.fn().mockResolvedValue({ id: 'obligation-1' }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        },
        disruptionAuditEvent: {
          create: jest.fn().mockResolvedValue({ id: 'disr-audit-1' }),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(transactionClient));

      mockPaymentRefundService.processCancellationRefund.mockResolvedValue({
        refundStatus: 'PENDING',
        refundAmount: '100.00',
        nextRetryAt: '2026-08-24T12:00:00.000Z',
      });

      const result = await service.cancelBooking('booking-1', 'user-1', 'quote-1');
      expect(mockBookingLifecycleService.cancelBooking).toHaveBeenCalledWith(
        'booking-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        '100.00',
        {
          resolvedByType: DisruptionActorType.TRAVELLER,
          resolvedById: 'user-1',
        },
        transactionClient,
        expect.any(Object),
      );
      expect(transactionClient.disruptionAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId: 'booking-1',
            revisionId: 'disruption-rev-1',
            action: 'BOOKING_CANCELLED',
            fromStatus: DisruptionStatus.DETECTED,
            toStatus: DisruptionStatus.RESOLVED,
            actorType: DisruptionActorType.TRAVELLER,
            actorId: 'user-1',
          }),
        }),
      );
      expect(result.refundStatus).toBe('PENDING');
      expect(result.bookingStatus).toBe(BookingStatus.CANCELLED_PENDING_REFUND);
    });

    it('returns NOT_REQUIRED without calling payment refund when no refund is due', async () => {
      const noRefundBooking = {
        ...booking,
        cancellationRefundable: false,
        customerRefundAmount: { toString: () => '0.00' },
      };
      mockPrisma.booking.findUnique.mockResolvedValue(noRefundBooking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });

      const transactionClient = {
        cancellationRefundObligation: {
          findUnique: jest.fn().mockResolvedValue(null),
          upsert: jest.fn().mockResolvedValue({ id: 'obligation-0' }),
        },
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: 'audit-0' }),
        },
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(transactionClient));

      const result = await service.cancelBooking('booking-1', 'user-1', 'quote-1');
      expect(result).toEqual({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.CANCELLED_NO_REFUND,
        cancellationStatus: BookingStatus.CANCELLED_NO_REFUND,
        refundStatus: 'NOT_REQUIRED',
        refundAmount: '0.00',
      });
      expect(mockPaymentRefundService.processCancellationRefund).not.toHaveBeenCalled();
    });

    it('returns NOT_REQUIRED without calling payment refund when booking has no payment', async () => {
      const noPaymentBooking = {
        ...booking,
        payment: null,
      };
      mockPrisma.booking.findUnique.mockResolvedValue(noPaymentBooking);
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });

      const transactionClient = {};
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(transactionClient));

      const result = await service.cancelBooking('booking-1', 'user-1', 'quote-1');
      expect(result).toEqual({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.CANCELLED_PENDING_REFUND,
        cancellationStatus: BookingStatus.CANCELLED_PENDING_REFUND,
        refundStatus: 'NOT_REQUIRED',
        refundAmount: '100.00',
      });
      expect(mockPaymentRefundService.processCancellationRefund).not.toHaveBeenCalled();
    });

    it('returns canonical response when transaction persistedCount is 0', async () => {
      mockPrisma.booking.findUnique.mockResolvedValueOnce(booking).mockResolvedValueOnce({
        ...booking,
        status: BookingStatus.CANCELLED_AND_REFUNDED,
      });
      mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });
      mockBookingLifecycleService.cancelBooking.mockResolvedValueOnce({ count: 0 });

      const result = await service.cancelBooking('booking-1', 'user-1', 'quote-1');
      expect(result).toEqual({
        bookingId: 'booking-1',
        bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
        cancellationStatus: BookingStatus.CANCELLED_AND_REFUNDED,
        duffelCancellationQuoteId: 'quote-1',
        refundStatus: 'SUCCEEDED',
        refundAmount: '100.00',
      });
    });

    describe('lifecycle event routing and invariants', () => {
      it('claim acquisition: status transition from CONFIRMED emits BookingCancellationPendingEvent post-commit', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        mockBookingLifecycleService.claimCancellation.mockImplementation(
          async (id: string, userId: string, threshold: Date, tx: any, context: any) => {
            if (context) {
              context.events.push(
                new BookingCancellationPendingEvent({
                  bookingId: id,
                  eventId: 'claim-event-1',
                  sourceVersion: 2,
                  status: BookingStatus.CANCELLATION_PENDING,
                }),
              );
            }
            return { count: 1 };
          },
        );
        mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });

        await service.cancelBooking('booking-1', 'user-1', 'quote-1');

        expect(mockBookingLifecycleService.claimCancellation).toHaveBeenCalledWith(
          'booking-1',
          'user-1',
          expect.any(Date),
          mockPrisma,
          expect.objectContaining({ events: expect.any(Array) }),
        );
        expect(mockPublisher.publish).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              bookingId: 'booking-1',
              sourceVersion: 2,
              status: BookingStatus.CANCELLATION_PENDING,
            }),
          ]),
        );
      });

      it('claim acquisition: stale lease refresh does not emit BookingCancellationPendingEvent', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        // Stale lease refresh: claim succeeded (count: 1) but NO event added to context
        mockBookingLifecycleService.claimCancellation.mockResolvedValueOnce({ count: 1 });
        mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });

        await service.cancelBooking('booking-1', 'user-1', 'quote-1');

        expect(mockBookingLifecycleService.claimCancellation).toHaveBeenCalled();
        const publishCalls = mockPublisher.publish.mock.calls;
        const emittedCancellationPending = publishCalls.some(([events]) =>
          events?.some((e: any) => e instanceof BookingCancellationPendingEvent),
        );
        expect(emittedCancellationPending).toBe(false);
      });

      it('final cancellation: version incremented, BookingCancelledEvent published strictly post-commit', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });
        mockBookingLifecycleService.cancelBooking.mockImplementation(
          async (id: string, status: any, refund: string, disr: any, tx: any, context: any) => {
            if (context) {
              context.events.push(
                new BookingCancelledEvent({
                  bookingId: id,
                  eventId: 'cancel-event-1',
                  sourceVersion: 3,
                  status,
                }),
              );
            }
            return {
              count: 1,
              hasActiveDisruption: false,
              activeDisruptionRevisionId: null,
              previousDisruptionStatus: null,
            };
          },
        );

        let publishCalledDuringTransaction = false;
        mockPrisma.$transaction.mockImplementation(async (cb: any) => {
          const res = await cb(mockPrisma);
          // Check whether publisher was called before transaction resolved
          publishCalledDuringTransaction = mockPublisher.publish.mock.calls.some(([events]) =>
            events?.some((e: any) => e instanceof BookingCancelledEvent),
          );
          return res;
        });

        await service.cancelBooking('booking-1', 'user-1', 'quote-1');

        expect(publishCalledDuringTransaction).toBe(false);
        expect(mockPublisher.publish).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              bookingId: 'booking-1',
              sourceVersion: 3,
              status: BookingStatus.CANCELLED_PENDING_REFUND,
            }),
          ]),
        );
      });

      it('final cancellation: obligation and disruption bundle committed atomically in transaction', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });
        mockBookingLifecycleService.cancelBooking.mockResolvedValueOnce({
          count: 1,
          hasActiveDisruption: true,
          activeDisruptionRevisionId: 'rev-atomic-1',
          previousDisruptionStatus: DisruptionStatus.DETECTED,
        });

        const txClient = {
          cancellationRefundObligation: {
            findUnique: jest.fn().mockResolvedValue(null),
            upsert: jest.fn().mockResolvedValue({ id: 'obl-atomic' }),
          },
          auditLog: {
            create: jest.fn().mockResolvedValue({ id: 'audit-atomic' }),
          },
          disruptionAuditEvent: {
            create: jest.fn().mockResolvedValue({ id: 'disr-atomic' }),
          },
        };

        mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(txClient));

        await service.cancelBooking('booking-1', 'user-1', 'quote-1');

        expect(txClient.cancellationRefundObligation.upsert).toHaveBeenCalled();
        expect(txClient.auditLog.create).toHaveBeenCalled();
        expect(txClient.disruptionAuditEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              bookingId: 'booking-1',
              revisionId: 'rev-atomic-1',
              toStatus: DisruptionStatus.RESOLVED,
            }),
          }),
        );
      });

      it('guarantees zero calls to BookingAgentProjectionService', async () => {
        // Assert service does not have or call BookingAgentProjectionService
        expect((service as any).bookingAgentProjectionService).toBeUndefined();
      });

      it('rollback: zero events published on claim transaction rollback', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        mockPrisma.$transaction.mockRejectedValueOnce(new Error('Claim transaction rollback'));

        await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
          'Claim transaction rollback',
        );

        expect(mockPublisher.publish).not.toHaveBeenCalled();
      });

      it('rollback: zero cancellation events published on final cancellation transaction rollback', async () => {
        mockPrisma.booking.findUnique.mockResolvedValue(booking);
        mockDuffelService.recovery.retrieveOrder.mockResolvedValue({ status: 'CANCELLED' });

        mockBookingLifecycleService.cancelBooking.mockImplementation(
          async (id: string, status: any, refund: string, disr: any, tx: any, context: any) => {
            if (context) {
              context.events.push(
                new BookingCancelledEvent({
                  bookingId: id,
                  eventId: 'cancel-event-err',
                  sourceVersion: 3,
                  status,
                }),
              );
            }
            return {
              count: 1,
              hasActiveDisruption: false,
              activeDisruptionRevisionId: null,
              previousDisruptionStatus: null,
            };
          },
        );

        // Fail second transaction (final cancellation transaction)
        let txCallCount = 0;
        mockPrisma.$transaction.mockImplementation(async (cb: any) => {
          txCallCount += 1;
          if (txCallCount === 1) {
            return cb(mockPrisma);
          }
          throw new Error('Final cancellation transaction failed');
        });

        await expect(service.cancelBooking('booking-1', 'user-1', 'quote-1')).rejects.toThrow(
          'Final cancellation transaction failed',
        );

        const publishedCancellationEvent = mockPublisher.publish.mock.calls.some(([events]) =>
          events?.some((e: any) => e instanceof BookingCancelledEvent),
        );
        expect(publishedCancellationEvent).toBe(false);
      });
    });
  });

  describe('helper methods', () => {
    describe('isRetryableSupplierError', () => {
      it('returns true for 429 and 500+ status codes', () => {
        expect(service.isRetryableSupplierError({ status: 429 })).toBe(true);
        expect(service.isRetryableSupplierError({ statusCode: 500 })).toBe(true);
        expect(service.isRetryableSupplierError({ status: 502 })).toBe(true);
        expect(service.isRetryableSupplierError({ statusCode: 503 })).toBe(true);
      });

      it('returns false for non-retryable errors, null, primitives', () => {
        expect(service.isRetryableSupplierError({ status: 400 })).toBe(false);
        expect(service.isRetryableSupplierError({ statusCode: 404 })).toBe(false);
        expect(service.isRetryableSupplierError(null)).toBe(false);
        expect(service.isRetryableSupplierError(undefined)).toBe(false);
        expect(service.isRetryableSupplierError('error string')).toBe(false);
        expect(service.isRetryableSupplierError(500)).toBe(false);
      });
    });

    describe('confirmCancellationWithRetries', () => {
      beforeEach(() => {
        jest.spyOn(global, 'setTimeout').mockImplementation((fn: any) => {
          if (typeof fn === 'function') fn();
          return 0 as any;
        });
      });

      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('retries on retryable supplier error and returns confirmation', async () => {
        mockDuffelService.cancellation.confirmCancellationQuote
          .mockRejectedValueOnce({ status: 429 })
          .mockRejectedValueOnce({ statusCode: 503 })
          .mockResolvedValueOnce({ id: 'confirmed-quote', status: 'CONFIRMED' });

        const result = await service.confirmCancellationWithRetries('quote-1');
        expect(result).toEqual({ id: 'confirmed-quote', status: 'CONFIRMED' });
        expect(mockDuffelService.cancellation.confirmCancellationQuote).toHaveBeenCalledTimes(3);
      });

      it('throws BadGatewayException immediately on non-retryable error', async () => {
        mockDuffelService.cancellation.confirmCancellationQuote.mockRejectedValueOnce({ status: 400 });

        await expect(service.confirmCancellationWithRetries('quote-1')).rejects.toThrow(
          BadGatewayException,
        );
        expect(mockDuffelService.cancellation.confirmCancellationQuote).toHaveBeenCalledTimes(1);
      });

      it('throws BadGatewayException when retries are exhausted', async () => {
        mockDuffelService.cancellation.confirmCancellationQuote.mockRejectedValue({ status: 500 });

        await expect(service.confirmCancellationWithRetries('quote-1')).rejects.toThrow(
          BadGatewayException,
        );
        expect(mockDuffelService.cancellation.confirmCancellationQuote).toHaveBeenCalledTimes(5);
      });
    });

    describe('toCancellationResponse', () => {
      it('maps CANCELLED_AND_REFUNDED correctly', () => {
        const res = service.toCancellationResponse({
          id: 'b-1',
          status: BookingStatus.CANCELLED_AND_REFUNDED,
          customerRefundAmount: '50.00',
          supplierCancellationQuoteId: 'can_quo_1',
        } as any);

        expect(res).toEqual({
          bookingId: 'b-1',
          bookingStatus: BookingStatus.CANCELLED_AND_REFUNDED,
          cancellationStatus: BookingStatus.CANCELLED_AND_REFUNDED,
          refundStatus: 'SUCCEEDED',
          refundAmount: '50.00',
          duffelCancellationQuoteId: 'can_quo_1',
        });
      });

      it('maps FAILED with SYSTEM_ERROR correctly', () => {
        const res = service.toCancellationResponse({
          id: 'b-1',
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.SYSTEM_ERROR,
          customerRefundAmount: null,
          supplierCancellationQuoteId: null,
        } as any);

        expect(res).toEqual({
          bookingId: 'b-1',
          bookingStatus: BookingStatus.FAILED,
          cancellationStatus: BookingStatus.FAILED,
          refundStatus: 'REFUND_FAILED_NEEDS_ATTENTION',
          refundAmount: '0.00',
          duffelCancellationQuoteId: null,
        });
      });

      it('maps other statuses to PENDING', () => {
        const res = service.toCancellationResponse({
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          failureReason: null,
          customerRefundAmount: '20.00',
          supplierCancellationQuoteId: 'can_quo_2|balance||',
        } as any);

        expect(res).toEqual({
          bookingId: 'b-1',
          bookingStatus: BookingStatus.CONFIRMED,
          cancellationStatus: BookingStatus.CONFIRMED,
          refundStatus: 'PENDING',
          refundAmount: '20.00',
          duffelCancellationQuoteId: 'can_quo_2',
        });
      });
    });
  });
});
