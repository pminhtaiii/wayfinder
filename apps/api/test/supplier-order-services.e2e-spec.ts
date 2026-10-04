import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { BudgetReservationResult } from '@/supplier/core/duffel-rate-budget.service';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelOrderAdapter } from '@/supplier/order/duffel-order.adapter';
import { OrderSnapshotNormalizer } from '@/supplier/order/order-snapshot.normalizer';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';

describe('Supplier order services (E2E)', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('supports quote, confirmation, snapshot recovery, and safe cancellation replay through Nest DI', async () => {
    const getOrder = jest.fn<Promise<{ data: unknown }>, [orderId: string]>()
      .mockResolvedValueOnce({
        data: {
          id: 'ord_active',
          cancelled_at: null,
          cancellation: { id: 'oc_pending', confirmed_at: null },
        },
      })
      .mockResolvedValueOnce({
        data: {
          id: 'ord_snapshot',
          slices: [
            {
              duration: 'PT2H',
              segments: [
                {
                  id: 'seg_snapshot',
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
      })
      .mockResolvedValueOnce({
        data: {
          id: 'ord_replay',
          cancelled_at: null,
          cancellation: {
            id: 'oc_replay',
            confirmed_at: '2026-10-02T10:00:00.000Z',
          },
        },
      });
    const createCancellation = jest
      .fn<Promise<{ data: unknown }>, [input: { order_id: string }]>()
      .mockResolvedValueOnce({
        data: {
          id: 'oc_quote',
          order_id: 'ord_snapshot',
          refund_amount: '75.00',
          refund_currency: 'GBP',
          expires_at: '2026-10-03T10:00:00.000Z',
          refundable: true,
          provider_extension: 'retained',
        },
      })
      .mockResolvedValueOnce({
        data: { id: 'oc_replay', order_id: 'ord_replay' },
      });
    const confirmCancellation = jest
      .fn<Promise<{ data: unknown }>, [quoteId: string]>()
      .mockResolvedValueOnce({
        data: {
          id: 'oc_quote',
          order_id: 'ord_snapshot',
          confirmed_at: '2026-10-02T09:00:00.000Z',
          refund_amount: '75.00',
          refund_currency: 'GBP',
        },
      })
      .mockRejectedValueOnce(new Error('supplier says this order was already cancelled'));
    const reserveAttempt = jest
      .fn<Promise<BudgetReservationResult>, [extraConstraint?: { key: string; limit: number }]>()
      .mockResolvedValue({ ok: true });

    const moduleRef = await Test.createTestingModule({
      providers: [
        DuffelCancellationService,
        DuffelRecoveryService,
        DuffelOrderAdapter,
        OrderSnapshotNormalizer,
        {
          provide: DUFFEL_SDK,
          useValue: {
            orders: { get: getOrder },
            orderCancellations: {
              create: createCancellation,
              confirm: confirmCancellation,
            },
          },
        },
        {
          provide: DUFFEL_SDK_CONFIGURATION,
          useValue: { token: 'test-token', basePath: 'http://127.0.0.1:4010' },
        },
        { provide: DuffelRateBudgetService, useValue: { reserveAttempt } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();

    const cancellationService = app.get(DuffelCancellationService);
    const recoveryService = app.get(DuffelRecoveryService);

    await expect(cancellationService.createCancellationQuote('ord_snapshot')).resolves.toStrictEqual({
      id: 'oc_quote',
      order_id: 'ord_snapshot',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      expires_at: '2026-10-03T10:00:00.000Z',
      refundable: true,
      provider_extension: 'retained',
    });
    await expect(cancellationService.confirmCancellationQuote('oc_quote')).resolves.toStrictEqual({
      id: 'oc_quote',
      order_id: 'ord_snapshot',
      status: 'CONFIRMED',
      refund_amount: '75.00',
      refund_currency: 'GBP',
      refundable: true,
      confirmed_at: '2026-10-02T09:00:00.000Z',
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(2);

    await expect(recoveryService.retrieveOrder('ord_active')).resolves.toStrictEqual({
      id: 'ord_active',
      order_id: 'ord_active',
      status: 'ACTIVE',
      cancelled_at: null,
      cancellation_id: 'oc_pending',
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(3);

    await expect(recoveryService.recoverOrderSnapshots('ord_snapshot')).resolves.toStrictEqual({
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
            supplierSegmentId: 'seg_snapshot',
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
    expect(getOrder).toHaveBeenCalledTimes(2);
    expect(reserveAttempt).toHaveBeenCalledTimes(4);

    await expect(cancellationService.cancelOrder('ord_replay')).resolves.toStrictEqual({
      id: 'ord_replay',
      order_id: 'ord_replay',
      status: 'CANCELLED',
      cancelled_at: null,
      cancellation_id: 'oc_replay',
    });

    expect(createCancellation).toHaveBeenNthCalledWith(1, { order_id: 'ord_snapshot' });
    expect(createCancellation).toHaveBeenNthCalledWith(2, { order_id: 'ord_replay' });
    expect(confirmCancellation).toHaveBeenNthCalledWith(1, 'oc_quote');
    expect(confirmCancellation).toHaveBeenNthCalledWith(2, 'oc_replay');
    expect(getOrder.mock.calls).toStrictEqual([
      ['ord_active'],
      ['ord_snapshot'],
      ['ord_replay'],
    ]);
    expect(getOrder).toHaveBeenCalledTimes(3);
    expect(reserveAttempt).toHaveBeenCalledTimes(7);
  });
});
