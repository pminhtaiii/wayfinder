import { Test, TestingModule } from '@nestjs/testing';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';
import { DuffelCancellationService } from './duffel-cancellation.service';
import { DuffelOrderAdapter } from './duffel-order.adapter';

type SdkResponse = { data: unknown };

describe('DuffelCancellationService', () => {
  let moduleRef: TestingModule | undefined;
  let service: DuffelCancellationService;
  let reserveAttempt: jest.Mock<Promise<BudgetReservationResult>, []>;
  let createCancellation: jest.Mock<Promise<SdkResponse>, [{ order_id: string }]>;
  let confirmCancellation: jest.Mock<Promise<SdkResponse>, [quoteId: string]>;
  let getOrder: jest.Mock<Promise<SdkResponse>, [orderId: string]>;

  beforeEach(async () => {
    reserveAttempt = jest.fn<Promise<BudgetReservationResult>, []>().mockResolvedValue({ ok: true });
    createCancellation = jest.fn<Promise<SdkResponse>, [{ order_id: string }]>();
    confirmCancellation = jest.fn<Promise<SdkResponse>, [quoteId: string]>();
    getOrder = jest.fn<Promise<SdkResponse>, [orderId: string]>();

    moduleRef = await Test.createTestingModule({
      providers: [
        DuffelCancellationService,
        DuffelOrderAdapter,
        {
          provide: DUFFEL_SDK,
          useValue: {
            orderCancellations: {
              create: createCancellation,
              confirm: confirmCancellation,
            },
            orders: { get: getOrder },
          },
        },
        {
          provide: DUFFEL_SDK_CONFIGURATION,
          useValue: { token: 'duffel-test-token', basePath: 'http://127.0.0.1:4010' },
        },
        { provide: DuffelRateBudgetService, useValue: { reserveAttempt } },
      ],
    }).compile();

    service = moduleRef.get(DuffelCancellationService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    jest.restoreAllMocks();
  });

  it('returns the cancellation quote and extension fields after the adapter reserves budget', async () => {
    const quote = {
      id: 'oc_1',
      order_id: 'ord_1',
      refund_amount: null,
      refund_currency: null,
      expires_at: '2026-10-03T00:00:00.000Z',
      refundable: false,
      refund_to: 'original_form_of_payment',
      supplier_extension: { reason: 'non_refundable' },
    };
    createCancellation.mockResolvedValue({ data: quote });

    await expect(service.createCancellationQuote('ord_1')).resolves.toEqual(quote);

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(createCancellation).toHaveBeenCalledWith({ order_id: 'ord_1' });
  });

  it('preserves a pending cancellation confirmation and nullable refund fields', async () => {
    confirmCancellation.mockResolvedValue({
      data: {
        id: 'oc_pending',
        order_id: 'ord_pending',
        confirmed_at: null,
        refund_amount: null,
        refund_currency: null,
      },
    });

    await expect(service.confirmCancellationQuote('oc_pending')).resolves.toEqual({
      id: 'oc_pending',
      order_id: 'ord_pending',
      status: 'PENDING',
      refund_amount: null,
      refund_currency: null,
      refundable: false,
      confirmed_at: null,
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(confirmCancellation).toHaveBeenCalledWith('oc_pending');
  });

  it('preserves a confirmed cancellation refund and confirmation timestamp', async () => {
    confirmCancellation.mockResolvedValue({
      data: {
        id: 'oc_confirmed',
        order_id: 'ord_confirmed',
        confirmed_at: '2026-10-02T10:00:00.000Z',
        refund_amount: '75.00',
        refund_currency: 'GBP',
      },
    });

    await expect(service.confirmCancellationQuote('oc_confirmed')).resolves.toEqual({
      id: 'oc_confirmed',
      order_id: 'ord_confirmed',
      status: 'CONFIRMED',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      refundable: true,
      confirmed_at: '2026-10-02T10:00:00.000Z',
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(confirmCancellation).toHaveBeenCalledWith('oc_confirmed');
  });

  // User-approved 2026-10-02: confirmation failure models a lost response after quote creation, so replay retrieval adds a third budget reservation; quote creation failure needs only two.
  it('accepts a failed cancellation replay only when retrieved order evidence is CANCELLED', async () => {
    createCancellation.mockResolvedValue({ data: { id: 'oc_replay_quote' } });
    confirmCancellation.mockRejectedValue(new Error('Already cancelled by supplier'));
    getOrder.mockResolvedValue({
      data: {
        id: 'ord_replayed',
        cancelled_at: null,
        cancellation: {
          id: 'oc_existing',
          confirmed_at: '2026-10-02T10:00:00.000Z',
        },
      },
    });

    // User-approved 2026-10-04: the cancellation service now returns its existing typed outcome for a confirmed replay; replay lookup/accounting assertions remain unchanged.
    await expect(service.cancelOrder('ord_replayed')).resolves.toEqual({
      success: true,
      orderId: 'ord_replayed',
      status: 'CANCELLED',
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(3);
    expect(createCancellation).toHaveBeenCalledWith({ order_id: 'ord_replayed' });
    expect(confirmCancellation).toHaveBeenCalledWith('oc_replay_quote');
    expect(getOrder).toHaveBeenCalledWith('ord_replayed');
  });

  // User-approved 2026-10-04: assert the existing CancelOrderOutcome at this service boundary while keeping the provider-shaped fixture and budget assertions.
  it('returns a typed unconfirmed outcome without treating pending cancellation as success', async () => {
    const pendingCancellation = {
      id: 'oc_pending',
      order_id: 'ord_pending',
      status: 'pending',
      confirmed_at: null,
      refund_amount: null,
      refund_currency: null,
    };
    createCancellation.mockResolvedValue({ data: { id: 'oc_pending' } });
    confirmCancellation.mockResolvedValue({ data: pendingCancellation });

    await expect(service.cancelOrder('ord_pending')).resolves.toEqual({
      success: false,
      orderId: 'ord_pending',
      status: 'pending',
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a non-empty confirmation timestamp',
      response: { id: 'oc_confirmed', confirmed_at: '2026-10-02T10:00:00.000Z' },
      expected: { success: true, orderId: 'ord_123', status: 'CANCELLED' },
    },
    {
      name: 'a confirmed status',
      response: { id: 'oc_confirmed', status: 'CONFIRMED', confirmed_at: null },
      expected: { success: true, orderId: 'ord_123', status: 'CANCELLED' },
    },
    {
      name: 'a timestamp-first pending status',
      response: {
        id: 'oc_pending_with_timestamp',
        status: 'PENDING',
        confirmed_at: '2026-10-02T10:00:00.000Z',
      },
      expected: { success: true, orderId: 'ord_123', status: 'CANCELLED' },
    },
    {
      name: 'a missing timestamp and status',
      response: { id: 'oc_unconfirmed' },
      expected: { success: false, orderId: 'ord_123', status: undefined },
    },
    {
      name: 'a blank timestamp',
      response: { id: 'oc_unconfirmed', confirmed_at: '   ' },
      expected: { success: false, orderId: 'ord_123', status: undefined },
    },
    {
      name: 'a null timestamp',
      response: { id: 'oc_unconfirmed', confirmed_at: null },
      expected: { success: false, orderId: 'ord_123', status: undefined },
    },
    {
      name: 'explicit success false with otherwise confirming evidence',
      response: {
        id: 'oc_negative',
        success: false,
        status: 'CONFIRMED',
        confirmed_at: '2026-10-02T10:00:00.000Z',
      },
      expected: { success: false, orderId: 'ord_123', status: 'CONFIRMED' },
    },
  ])('normalizes $name to the cancellation outcome contract', async ({ response, expected }) => {
    createCancellation.mockResolvedValue({ data: { id: 'oc_matrix_quote' } });
    confirmCancellation.mockResolvedValue({ data: response });

    await expect(service.cancelOrder('ord_123')).resolves.toEqual(expected);

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(createCancellation).toHaveBeenCalledWith({ order_id: 'ord_123' });
    expect(confirmCancellation).toHaveBeenCalledWith('oc_matrix_quote');
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('preserves an active order cancellation failure even when its message says already cancelled', async () => {
    createCancellation.mockResolvedValue({ data: { id: 'oc_quote' } });
    confirmCancellation.mockRejectedValue(new Error('Order is already cancelled'));
    getOrder.mockResolvedValue({ data: { id: 'ord_active', cancelled_at: null } });

    await expect(service.cancelOrder('ord_active')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        message: 'Failed to confirm Duffel cancellation quote',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(3);
    expect(getOrder).toHaveBeenCalledWith('ord_active');
  });

  it('does not retrieve an order after cancellation budget denial', async () => {
    reserveAttempt.mockResolvedValueOnce({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 37,
      resetAt: '2026-10-03T00:00:00.000Z',
    });

    await expect(service.cancelOrder('ord_budgeted')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-03T00:00:00.000Z',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(createCancellation).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('preserves budget store unavailability without attempting reconciliation', async () => {
    reserveAttempt.mockResolvedValueOnce({
      ok: false,
      error: 'UNAVAILABLE',
      retryAfterSeconds: 30,
    });

    await expect(service.cancelOrder('ord_budget_unavailable')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'BUDGET_UNAVAILABLE',
        retryAfterSeconds: 30,
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(createCancellation).not.toHaveBeenCalled();
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('preserves the cancellation failure when order reconciliation also fails', async () => {
    createCancellation.mockResolvedValue({ data: { id: 'oc_quote' } });
    confirmCancellation.mockRejectedValue(new Error('Confirmation outcome is unknown'));
    getOrder.mockRejectedValue(new Error('Order retrieval unavailable'));

    await expect(service.cancelOrder('ord_unavailable')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        message: 'Failed to confirm Duffel cancellation quote',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(3);
    expect(getOrder).toHaveBeenCalledWith('ord_unavailable');
  });

  it('rejects malformed quotes without dropping the adapter error boundary', async () => {
    createCancellation.mockResolvedValue({
      data: { id: 'oc_invalid', order_id: 'ord_invalid', refund_amount: 75 },
    });

    await expect(service.createCancellationQuote('ord_invalid')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_CANCELLATION_QUOTE_FAILED',
        message: 'Invalid Duffel cancellation quote',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('preserves the adapter status and code for malformed confirmation responses', async () => {
    confirmCancellation.mockResolvedValue({ data: { id: 'oc_invalid' } });

    await expect(service.confirmCancellationQuote('oc_invalid')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        message: 'Invalid Duffel cancellation response',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });
});
