import { DuffelError } from '@duffel/api';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { Test, TestingModule } from '@nestjs/testing';
import { DuffelOrderAdapter } from './duffel-order.adapter';

describe('Duffel order request parity', () => {
  let moduleRef: TestingModule | undefined;
  let previousApiUrl: string | undefined;
  let previousAccessToken: string | undefined;

  beforeEach(() => {
    previousApiUrl = process.env.DUFFEL_API_URL;
    previousAccessToken = process.env.DUFFEL_ACCESS_TOKEN;
    process.env.DUFFEL_API_URL = 'http://127.0.0.1:4010';
    process.env.DUFFEL_ACCESS_TOKEN = 'duffel-test-token';
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    jest.restoreAllMocks();
    if (previousApiUrl === undefined) {
      delete process.env.DUFFEL_API_URL;
    } else {
      process.env.DUFFEL_API_URL = previousApiUrl;
    }
    if (previousAccessToken === undefined) {
      delete process.env.DUFFEL_ACCESS_TOKEN;
    } else {
      process.env.DUFFEL_ACCESS_TOKEN = previousAccessToken;
    }
  });

  it('posts a manual order with mapped passengers, services, metadata, and idempotency', async (): Promise<void> => {
    const reserveAttempt = jest
      .fn<Promise<BudgetReservationResult>, [extraConstraint?: { key: string; limit: number }]>()
      .mockResolvedValue({ ok: true });
    const getOffer = jest.fn<
      Promise<{ data: { passengers: Array<{ id: string; type: string }> } }>,
      [offerId: string]
    >().mockResolvedValue({
      data: { passengers: [{ id: 'pas_adult_1', type: 'adult' }] },
    });
    const order = { id: 'ord_1', booking_reference: 'ABC123' };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: order }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );

    moduleRef = await Test.createTestingModule({
      providers: [
        DuffelOrderAdapter,
        { provide: DuffelRateBudgetService, useValue: { reserveAttempt } },
        { provide: DUFFEL_SDK, useValue: { offers: { get: getOffer } } },
        {
          provide: DUFFEL_SDK_CONFIGURATION,
          useValue: { token: 'duffel-test-token', basePath: 'http://127.0.0.1:4010' },
        },
      ],
    }).compile();

    const adapter = moduleRef.get(DuffelOrderAdapter);
    await adapter.getOfferById('off_1');
    await expect(
      adapter.createOrder({
        selected_offers: ['off_1'],
        passengers: [
          {
            id: 'pas_adult_1',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            gender: 'f',
            title: 'ms',
            phone_number: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        services: [{ id: 'aseat_1', quantity: 1 }],
        metadata: { paymentId: 'pay_1' },
        idempotencyKey: 'attempt-1',
      }),
    ).resolves.toEqual(order);

    expect(getOffer).toHaveBeenCalledWith('off_1');
    expect(reserveAttempt).toHaveBeenCalledTimes(2);

    const request = fetchSpy.mock.calls[0];
    if (request === undefined) {
      throw new Error('Expected Duffel order POST request');
    }
    const [url, requestOptions] = request;
    expect(url).toBe('http://127.0.0.1:4010/air/orders');
    expect(requestOptions?.method).toBe('POST');
    const headers = new Headers(requestOptions?.headers);
    expect(headers.get('Authorization')).toBe('Bearer duffel-test-token');
    expect(headers.get('Duffel-Version')).toBe('v2');
    expect(headers.get('Idempotency-Key')).toBe('attempt-1-duffel-order');

    const requestBodyText = requestOptions?.body;
    if (typeof requestBodyText !== 'string') {
      throw new Error('Expected serialized Duffel order body');
    }
    const requestBody: unknown = JSON.parse(requestBodyText);
    expect(requestBody).toEqual({
      data: {
        type: 'instant',
        selected_offers: ['off_1'],
        passengers: [
          {
            id: 'pas_adult_1',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            gender: 'f',
            title: 'ms',
            phone_number: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        services: [{ id: 'aseat_1', quantity: 1 }],
        metadata: { paymentId: 'pay_1' },
      },
    });
  });
});

describe('DuffelOrderAdapter', () => {
  type SdkResponse = { data: unknown };

  let moduleRef: TestingModule | undefined;
  let adapter: DuffelOrderAdapter;
  let reserveAttempt: jest.Mock<Promise<BudgetReservationResult>, []>;
  let createCancellation: jest.Mock<Promise<SdkResponse>, [{ order_id: string }]>;
  let confirmCancellation: jest.Mock<Promise<SdkResponse>, [quoteId: string]>;
  let getOrder: jest.Mock<Promise<SdkResponse>, [orderId: string]>;

  beforeEach(async () => {
    reserveAttempt = jest.fn<Promise<BudgetReservationResult>, []>().mockResolvedValue({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 37,
      resetAt: '2026-10-02T00:00:00.000Z',
    });
    createCancellation = jest.fn<Promise<SdkResponse>, [{ order_id: string }]>();
    confirmCancellation = jest.fn<Promise<SdkResponse>, [quoteId: string]>();
    getOrder = jest.fn<Promise<SdkResponse>, [orderId: string]>();

    moduleRef = await Test.createTestingModule({
      providers: [
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

    adapter = moduleRef.get(DuffelOrderAdapter);
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('denies order creation before the manual POST when the daily budget is exhausted', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await expect(
      adapter.createOrder({
        selected_offers: ['off_1'],
        passengers: [{ id: 'pas_1', given_name: 'Amina', family_name: 'Nguyen' }],
        idempotencyKey: 'attempt-1',
      }),
    ).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      },
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts already mapped order values after one reservation', async () => {
    const calls: string[] = [];
    reserveAttempt.mockImplementationOnce(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    const order = { id: 'ord_1', booking_reference: 'ABC123' };
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls.push('fetch');
      return new Response(JSON.stringify({ data: order }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    await expect(
      adapter.createOrder({
        selected_offers: ['off_1'],
        passengers: [
          {
            id: 'pas_1',
            type: 'adult',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            gender: 'f',
            title: 'ms',
            phone_number: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        services: [{ id: 'aseat_1', quantity: 1 }],
        metadata: { paymentId: 'pay_1' },
        idempotencyKey: 'attempt-1',
      }),
    ).resolves.toEqual(order);

    expect(calls).toEqual(['reserve', 'fetch']);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0];
    if (request === undefined) {
      throw new Error('Expected Duffel order POST request');
    }
    const [url, requestOptions] = request;
    expect(url).toBe('http://127.0.0.1:4010/air/orders');
    expect(requestOptions?.method).toBe('POST');
    const headers = new Headers(requestOptions?.headers);
    expect(headers.get('Authorization')).toBe('Bearer duffel-test-token');
    expect(headers.get('Duffel-Version')).toBe('v2');
    expect(headers.get('Idempotency-Key')).toBe('attempt-1-duffel-order');
    const requestBodyText = requestOptions?.body;
    if (typeof requestBodyText !== 'string') {
      throw new Error('Expected serialized Duffel order body');
    }
    const requestBody: unknown = JSON.parse(requestBodyText);
    expect(requestBody).toEqual({
      data: {
        type: 'instant',
        selected_offers: ['off_1'],
        passengers: [
          {
            id: 'pas_1',
            type: 'adult',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            gender: 'f',
            title: 'ms',
            phone_number: '+84901234567',
            email: 'amina@example.com',
          },
        ],
        services: [{ id: 'aseat_1', quantity: 1 }],
        metadata: { paymentId: 'pay_1' },
      },
    });
  });

  it('preserves a safe 429 mapping when Duffel rejects the order request', async () => {
    reserveAttempt.mockResolvedValueOnce({ ok: true });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ message: 'Duffel rate limit exceeded' }] }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      adapter.createOrder({
        selected_offers: ['off_1'],
        passengers: [{ id: 'pas_1', given_name: 'Amina', family_name: 'Nguyen' }],
        idempotencyKey: 'attempt-1',
      }),
    ).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'UPSTREAM_RATE_LIMITED',
        message: 'Duffel API rate limit exceeded',
      },
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      upstreamStatus: 429,
      status: 429,
      code: 'UPSTREAM_RATE_LIMITED',
      message: 'Duffel API rate limit exceeded',
    },
    {
      upstreamStatus: 502,
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Failed to create Duffel order',
    },
    {
      upstreamStatus: 201,
      status: 502,
      code: 'UPSTREAM_UNAVAILABLE',
      message: 'Failed to create Duffel order',
    },
  ])(
    'safely maps a non-JSON $upstreamStatus order response',
    async ({ upstreamStatus, status, code, message }) => {
      reserveAttempt.mockResolvedValueOnce({ ok: true });
      jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<html>private upstream details</html>', {
          status: upstreamStatus,
          headers: { 'content-type': 'text/html' },
        }),
      );

      await expect(
        adapter.createOrder({ selected_offers: ['off_1'], passengers: [] }),
      ).rejects.toMatchObject({
        status,
        response: { code, message },
      });
      expect(reserveAttempt).toHaveBeenCalledTimes(1);
    },
  );

  it('aborts a stalled manual order request after 30 seconds', async () => {
    jest.useFakeTimers();
    reserveAttempt.mockResolvedValueOnce({ ok: true });
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => new Promise<Response>(() => {}));

    const orderPromise = adapter.createOrder({
      selected_offers: ['off_1'],
      passengers: [{ id: 'pas_1', given_name: 'Amina', family_name: 'Nguyen' }],
      idempotencyKey: 'attempt-1',
    });
    // Approved by the user on 2026-10-02: attach the rejection matcher before advancing timers.
    const timeoutAssertion = expect(orderPromise).rejects.toMatchObject({ status: 504 });
    await jest.advanceTimersByTimeAsync(30000);
    await timeoutAssertion;

    const request = fetchSpy.mock.calls[0];
    if (request === undefined) {
      throw new Error('Expected Duffel order POST request');
    }
    const [, requestOptions] = request;
    expect(requestOptions?.signal?.aborted).toBe(true);
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('returns the raw cancellation quote after reserving immediately before SDK create', async () => {
    const calls: string[] = [];
    const quote = {
      id: 'oc_1',
      order_id: 'ord_1',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      expires_at: '2026-10-03T00:00:00.000Z',
      refundable: true,
    };
    reserveAttempt.mockImplementationOnce(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    createCancellation.mockImplementationOnce(async () => {
      calls.push('quote');
      return { data: quote };
    });

    await expect(adapter.createCancellationQuote('ord_1')).resolves.toEqual(quote);

    expect(calls).toEqual(['reserve', 'quote']);
    expect(createCancellation).toHaveBeenCalledWith({ order_id: 'ord_1' });
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('maps a confirmed quote while reserving immediately before SDK confirm', async () => {
    const calls: string[] = [];
    const cancellation = {
      id: 'oc_1',
      order_id: 'ord_1',
      confirmed_at: '2026-10-02T10:00:00.000Z',
      refund_amount: '75.00',
      refund_currency: 'GBP',
    };
    reserveAttempt.mockImplementationOnce(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    confirmCancellation.mockImplementationOnce(async () => {
      calls.push('confirm');
      return { data: cancellation };
    });

    await expect(adapter.confirmCancellationQuote('oc_1')).resolves.toEqual({
      id: 'oc_1',
      order_id: 'ord_1',
      status: 'CONFIRMED',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      refundable: true,
      confirmed_at: '2026-10-02T10:00:00.000Z',
    });

    expect(calls).toEqual(['reserve', 'confirm']);
    expect(confirmCancellation).toHaveBeenCalledWith('oc_1');
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('cancels through separately reserved quote and confirm requests', async () => {
    const calls: string[] = [];
    const confirmation = { id: 'oc_1', status: 'confirmed' };
    reserveAttempt.mockImplementation(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    createCancellation.mockImplementationOnce(async () => {
      calls.push('quote');
      return { data: { id: 'oc_1' } };
    });
    confirmCancellation.mockImplementationOnce(async () => {
      calls.push('confirm');
      return { data: confirmation };
    });

    await expect(adapter.cancelOrder('ord_1')).resolves.toEqual(confirmation);

    expect(calls).toEqual(['reserve', 'quote', 'reserve', 'confirm']);
    expect(createCancellation).toHaveBeenCalledWith({ order_id: 'ord_1' });
    expect(confirmCancellation).toHaveBeenCalledWith('oc_1');
    expect(reserveAttempt).toHaveBeenCalledTimes(2);
  });

  it('returns the active recovery snapshot after reserving before order retrieval', async () => {
    const calls: string[] = [];
    const order = { id: 'ord_1', cancelled_at: null, cancellation: null };
    reserveAttempt.mockImplementationOnce(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    getOrder.mockImplementationOnce(async () => {
      calls.push('get');
      return { data: order };
    });

    await expect(adapter.retrieveOrder('ord_1')).resolves.toEqual({
      id: 'ord_1',
      order_id: 'ord_1',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: null,
    });

    expect(calls).toEqual(['reserve', 'get']);
    expect(getOrder).toHaveBeenCalledWith('ord_1');
  });

  it('returns the cancelled recovery snapshot when Duffel confirms cancellation', async () => {
    reserveAttempt.mockResolvedValueOnce({ ok: true });
    getOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_2',
        cancelled_at: null,
        cancellation: { id: 'oc_2', confirmed_at: '2026-10-02T10:00:00.000Z' },
      },
    });

    await expect(adapter.retrieveOrder('ord_2')).resolves.toEqual({
      id: 'ord_2',
      order_id: 'ord_2',
      status: 'CANCELLED',
      cancelled_at: null,
      cancellation_id: 'oc_2',
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledWith('ord_2');
  });

  it('returns the complete raw order after reserving before order retrieval', async () => {
    const calls: string[] = [];
    const order = {
      id: 'ord_3',
      booking_reference: 'DEF456',
      slices: [{ id: 'sli_1' }],
      passengers: [{ id: 'pas_1', email: 'amina@example.com' }],
    };
    reserveAttempt.mockImplementationOnce(async () => {
      calls.push('reserve');
      return { ok: true };
    });
    getOrder.mockImplementationOnce(async () => {
      calls.push('get');
      return { data: order };
    });

    await expect(adapter.retrieveCompleteOrder('ord_3')).resolves.toEqual(order);

    expect(calls).toEqual(['reserve', 'get']);
    expect(getOrder).toHaveBeenCalledWith('ord_3');
  });

  it('denies standalone cancellation calls before reaching either SDK operation', async () => {
    const expectedDenial = {
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      },
    };

    await expect(adapter.createCancellationQuote('ord_4')).rejects.toMatchObject(expectedDenial);
    await expect(adapter.confirmCancellationQuote('oc_4')).rejects.toMatchObject(expectedDenial);

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(createCancellation).not.toHaveBeenCalled();
    expect(confirmCancellation).not.toHaveBeenCalled();
  });

  it('stops cancellation when the confirm reservation is denied', async () => {
    reserveAttempt
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      });
    createCancellation.mockResolvedValueOnce({ data: { id: 'oc_5' } });

    await expect(adapter.cancelOrder('ord_5')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(createCancellation).toHaveBeenCalledTimes(1);
    expect(confirmCancellation).not.toHaveBeenCalled();
  });

  it('denies both retrieval operations before order SDK calls', async () => {
    const expectedDenial = {
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-02T00:00:00.000Z',
      },
    };

    await expect(adapter.retrieveOrder('ord_6')).rejects.toMatchObject(expectedDenial);
    await expect(adapter.retrieveCompleteOrder('ord_6')).rejects.toMatchObject(expectedDenial);

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('returns generic errors for cancellation confirmation and order retrieval failures', async () => {
    const privateProviderMessage = 'Private Duffel provider response details';
    const sdkError = new DuffelError({
      meta: { request_id: 'req_private', status: 502 },
      errors: [
        {
          code: 'private_provider_error',
          documentation_url: 'https://duffel.com/docs/api/overview/errors',
          message: privateProviderMessage,
          title: 'Private provider failure',
          type: 'invalid_request_error',
        },
      ],
      headers: Object.assign(new Headers(), { raw: () => ({}) }),
    });
    sdkError.message = privateProviderMessage;
    reserveAttempt.mockResolvedValue({ ok: true });
    confirmCancellation.mockRejectedValue(sdkError);
    getOrder.mockRejectedValue(sdkError);

    await expect(adapter.confirmCancellationQuote('oc_private')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_CANCELLATION_CONFIRM_FAILED',
        message: 'Failed to confirm Duffel cancellation quote',
      },
    });
    await expect(adapter.retrieveOrder('ord_private')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
        message: 'Failed to retrieve Duffel order',
      },
    });
    await expect(adapter.retrieveCompleteOrder('ord_private')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
        message: 'Failed to retrieve Duffel order',
      },
    });
  });
});
