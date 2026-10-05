import { Test, TestingModule } from '@nestjs/testing';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';
import type { PassengerEnrichmentInput } from '@/payment-fulfillment/ports';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';
import { DuffelOrderAdapter } from './duffel-order.adapter';
import { DuffelRecoveryService } from './duffel-recovery.service';

describe('DuffelRecoveryService', () => {
  let moduleRef: TestingModule | undefined;
  let recoveryService: DuffelRecoveryService;
  let getOrder: jest.Mock<Promise<{ data: unknown }>, [orderId: string]>;
  let reserveAttempt: jest.Mock<
    Promise<BudgetReservationResult>,
    [extraConstraint?: { key: string; limit: number }]
  >;

  beforeEach(async () => {
    getOrder = jest.fn<Promise<{ data: unknown }>, [orderId: string]>();
    reserveAttempt = jest
      .fn<Promise<BudgetReservationResult>, [extraConstraint?: { key: string; limit: number }]>()
      .mockResolvedValue({ ok: true });

    moduleRef = await Test.createTestingModule({
      providers: [
        DuffelRecoveryService,
        DuffelOrderAdapter,
        OrderSnapshotNormalizer,
        { provide: DUFFEL_SDK, useValue: { orders: { get: getOrder } } },
        {
          provide: DUFFEL_SDK_CONFIGURATION,
          useValue: { token: 'test-token', basePath: 'http://127.0.0.1:4010' },
        },
        { provide: DuffelRateBudgetService, useValue: { reserveAttempt } },
      ],
    }).compile();
    recoveryService = moduleRef.get(DuffelRecoveryService);
  });

  afterEach(async () => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('returns an active order snapshot through the adapter', async () => {
    getOrder.mockResolvedValueOnce({
      data: { id: 'ord_active', cancelled_at: null, cancellation: null },
    });

    await expect(recoveryService.retrieveOrder('ord_active')).resolves.toStrictEqual({
      id: 'ord_active',
      order_id: 'ord_active',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: null,
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledWith('ord_active');
  });

  it('returns a cancelled order when cancelled_at is present', async () => {
    getOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_cancelled_at',
        cancelled_at: '2026-10-02T10:00:00.000Z',
        cancellation: null,
      },
    });

    await expect(recoveryService.retrieveOrder('ord_cancelled_at')).resolves.toStrictEqual({
      id: 'ord_cancelled_at',
      order_id: 'ord_cancelled_at',
      status: 'CANCELLED',
      cancelled_at: '2026-10-02T10:00:00.000Z',
      cancellation_id: null,
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('returns a cancelled order when the supplier confirms the cancellation', async () => {
    getOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_confirmed_cancel',
        cancelled_at: null,
        cancellation: {
          id: 'oc_confirmed_cancel',
          confirmed_at: '2026-10-02T10:00:00.000Z',
        },
      },
    });

    await expect(recoveryService.retrieveOrder('ord_confirmed_cancel')).resolves.toStrictEqual({
      id: 'ord_confirmed_cancel',
      order_id: 'ord_confirmed_cancel',
      status: 'CANCELLED',
      cancelled_at: null,
      cancellation_id: 'oc_confirmed_cancel',
    });
  });

  it('keeps an unconfirmed cancellation ID active', async () => {
    getOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_pending_cancel',
        cancelled_at: null,
        cancellation: { id: 'oc_pending_cancel', confirmed_at: null },
      },
    });

    await expect(recoveryService.retrieveOrder('ord_pending_cancel')).resolves.toStrictEqual({
      id: 'ord_pending_cancel',
      order_id: 'ord_pending_cancel',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: 'oc_pending_cancel',
    });
  });

  it('returns the complete raw order', async () => {
    const completeOrder = {
      id: 'ord_complete',
      slices: [{ id: 'sli_1' }],
      passengers: [{ id: 'pas_1', email: 'amina@example.com' }],
      supplierField: { retained: true },
    };
    getOrder.mockResolvedValueOnce({ data: completeOrder });

    await expect(recoveryService.retrieveCompleteOrder('ord_complete')).resolves.toBe(completeOrder);

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledWith('ord_complete');
  });

  it('recovers flight and passenger snapshots with one complete-order retrieval', async () => {
    getOrder.mockResolvedValueOnce({
      data: {
        id: 'ord_recovery',
        slices: [
          {
            duration: 'PT2H',
            segments: [
              {
                id: 'seg_recovery',
                marketing_carrier_flight_number: '123',
                departing_at: '2026-10-10T10:00:00-07:00',
                arriving_at: '2026-10-10T12:00:00-07:00',
                duration: 'PT2H',
                origin: { iata_code: 'SFO', name: 'San Francisco International' },
                destination: { iata_code: 'LAX', name: 'Los Angeles International' },
                origin_terminal: '2',
                destination_terminal: 'B',
                operating_carrier: { name: 'Air Canada', iata_code: 'AC' },
                marketing_carrier: { name: 'United Airlines', iata_code: 'UA' },
                aircraft: { name: 'Boeing 737' },
                passengers: [{ cabin_class: 'business' }],
              },
            ],
          },
        ],
        passengers: [
          {
            type: 'adult',
            title: 'ms',
            given_name: 'Amina',
            family_name: 'Nguyen',
            born_on: '1990-01-02',
            email: 'amina@example.com',
            phone_number: '+84901234567',
          },
        ],
      },
    });

    // Explicit user approval 2026-10-03: this current internal recovery snapshot uses supplierSegmentId; persisted JSON, history, and HTTP keys remain unchanged.
    await expect(recoveryService.recoverOrderSnapshots('ord_recovery')).resolves.toStrictEqual({
      flightSnapshot: {
        segments: [
          {
            airline: { name: 'Air Canada', iataCode: 'AC' },
            flightNumber: '123',
            departureAirport: {
              iataCode: 'SFO',
              name: 'San Francisco International',
              city: 'San Francisco International',
              terminal: '2',
            },
            arrivalAirport: {
              iataCode: 'LAX',
              name: 'Los Angeles International',
              city: 'Los Angeles International',
              terminal: 'B',
            },
            departureAt: '2026-10-10T10:00:00-07:00',
            arrivalAt: '2026-10-10T12:00:00-07:00',
            duration: 'PT2H',
            aircraftType: 'Boeing 737',
            supplierSegmentId: 'seg_recovery',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT2H',
        stops: 0,
        cabinClass: 'business',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'ADULT',
            title: 'ms',
            firstName: 'Amina',
            lastName: 'Nguyen',
            dateOfBirth: '1990-01-02',
          },
        ],
        contactEmail: 'amina@example.com',
        contactPhone: '+84901234567',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledWith('ord_recovery');
  });

  it('keeps legacy defaults for partial orders', async () => {
    getOrder.mockResolvedValueOnce({
      data: { id: 'ord_partial', passengers: [{ type: 'child' }] },
    });

    await expect(recoveryService.recoverOrderSnapshots('ord_partial')).resolves.toStrictEqual({
      flightSnapshot: {
        segments: [],
        totalDuration: 'PT0H',
        stops: 0,
        cabinClass: 'economy',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'CHILD',
            title: undefined,
            firstName: 'Unknown',
            lastName: 'Unknown',
            dateOfBirth: '1990-01-01',
          },
        ],
        contactEmail: null,
        contactPhone: null,
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
  });

  it('enriches redacted recovery passenger evidence on a copy before snapshot normalization', () => {
    const redactedOrderEvidence = {
      id: 'ord_enrichment',
      passengers: [
        {
          id: 'pas_1',
          type: 'adult',
          title: 'ms',
          given_name: 'REDACTED',
          family_name: 'REDACTED',
          born_on: 'REDACTED',
          email: 'REDACTED',
          phone_number: 'REDACTED',
        },
        {
          id: 'pas_2',
          type: 'adult',
          title: 'mr',
          given_name: 'Existing',
          family_name: 'Value',
          born_on: '2000-05-06',
          email: 'REDACTED',
          phone_number: 'REDACTED',
        },
        {
          type: 'adult',
          given_name: 'REDACTED',
          family_name: 'REDACTED',
          born_on: 'REDACTED',
          email: 'REDACTED',
          phone_number: 'REDACTED',
        },
      ],
    };
    const passengerEnrichment: PassengerEnrichmentInput[] = [
      { id: 'pas_1', firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1985-05-20' },
      { firstName: 'Changed', lastName: 'Changed', dateOfBirth: '1980-01-01' },
      { firstName: 'Third', lastName: 'Passenger', dateOfBirth: '1995-07-08' },
    ];
    const originalEvidenceJson = JSON.stringify(redactedOrderEvidence);
    const normalizerSpy = jest.spyOn(OrderSnapshotNormalizer.prototype, 'mapDuffelOrderToSnapshots');

    const snapshots = recoveryService.mapOrderToSnapshots(
      redactedOrderEvidence,
      passengerEnrichment,
      'traveler@example.com',
    );
    const orderSentToNormalizer = normalizerSpy.mock.calls[0]?.[0];
    normalizerSpy.mockRestore();

    expect(orderSentToNormalizer).toStrictEqual({
      id: 'ord_enrichment',
      passengers: [
        {
          id: 'pas_1',
          type: 'adult',
          title: 'ms',
          given_name: 'Jane',
          family_name: 'Doe',
          born_on: '1985-05-20',
          email: 'traveler@example.com',
          phone_number: 'REDACTED',
        },
        {
          id: 'pas_2',
          type: 'adult',
          title: 'mr',
          given_name: 'Existing',
          family_name: 'Value',
          born_on: '2000-05-06',
          email: 'traveler@example.com',
          phone_number: 'REDACTED',
        },
        {
          type: 'adult',
          given_name: 'Third',
          family_name: 'Passenger',
          born_on: '1995-07-08',
          email: 'traveler@example.com',
          phone_number: 'REDACTED',
        },
      ],
    });
    expect(orderSentToNormalizer).not.toBe(redactedOrderEvidence);
    expect(JSON.stringify(redactedOrderEvidence)).toBe(originalEvidenceJson);
    expect(snapshots.passengerSnapshot.passengers).toStrictEqual([
      {
        type: 'ADULT',
        title: 'ms',
        firstName: 'Jane',
        lastName: 'Doe',
        dateOfBirth: '1985-05-20',
      },
      {
        type: 'ADULT',
        title: 'mr',
        firstName: 'Existing',
        lastName: 'Value',
        dateOfBirth: '2000-05-06',
      },
      {
        type: 'ADULT',
        title: undefined,
        firstName: 'Third',
        lastName: 'Passenger',
        dateOfBirth: '1995-07-08',
      },
    ]);
    expect(snapshots.passengerSnapshot.contactEmail).toBe('traveler@example.com');
    expect(snapshots.passengerSnapshot.contactPhone).toBe('REDACTED');
  });

  it('preserves the upstream retrieval failure for malformed complete orders', async () => {
    getOrder.mockResolvedValueOnce({ data: null });

    await expect(recoveryService.recoverOrderSnapshots('ord_malformed')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
        message: 'Invalid Duffel order response',
      },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(getOrder).toHaveBeenCalledWith('ord_malformed');
  });

  it('maps supplier retrieval errors to the existing safe upstream error', async () => {
    getOrder.mockRejectedValueOnce(new Error('private supplier details'));

    await expect(recoveryService.retrieveOrder('ord_unavailable')).rejects.toMatchObject({
      status: 502,
      response: {
        code: 'UPSTREAM_ORDER_RETRIEVAL_FAILED',
        message: 'Failed to retrieve Duffel order',
      },
    });
  });

  it('preserves both typed budget denial codes before requesting an order', async () => {
    reserveAttempt
      .mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-03T00:00:00.000Z',
      })
      .mockResolvedValueOnce({ ok: false, error: 'UNAVAILABLE', retryAfterSeconds: 30 });

    await expect(recoveryService.retrieveCompleteOrder('ord_exhausted')).rejects.toMatchObject({
      status: 429,
      response: {
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 37,
        resetAt: '2026-10-03T00:00:00.000Z',
      },
    });
    await expect(recoveryService.retrieveCompleteOrder('ord_budget_unavailable')).rejects.toMatchObject({
      status: 429,
      response: { code: 'BUDGET_UNAVAILABLE', retryAfterSeconds: 30 },
    });

    expect(reserveAttempt).toHaveBeenCalledTimes(2);
    expect(getOrder).not.toHaveBeenCalled();
  });
});
