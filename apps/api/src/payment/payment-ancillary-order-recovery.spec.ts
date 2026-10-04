// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
import { AuditService } from '@/audit/audit.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { PaymentIdempotencyService, SagaOwnership } from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
import {
  PaymentGatewayPort,
  PaymentAuthorizationStatus,
  FulfillmentGatewayPort,
  PortInvocationControl,
  CreateOrderInput,
  PersistedOrderEvidence,
} from '@/payment-fulfillment/ports';
import { PrismaService } from '@/prisma/prisma.service';

const order = { id: 'order-1', booking_reference: 'PNR123' };
const boundSelection = {
  id: 'selection-3',
  bookingIntentId: 'intent-1',
  version: 3,
  status: 'PAYMENT_BOUND',
  seatSelections: [{ serviceId: 'seat-b' }, { serviceId: 'seat-a' }, { serviceId: 'seat-a' }],
  baggageSelections: [
    { serviceId: 'bag-1', quantity: 2 },
    { serviceId: 'bag-1', quantity: 2 },
  ],
};

type HarnessOptions = {
  recoveryPoint?: string;
  paymentStatus?: string;
  paymentFindResults?: unknown[];
  supplierError?: Error;
  captureError?: Error;
  createOrder?: jest.Mock;
};

function buildHarness(options: HarnessOptions = {}) {
  const payment = {
    id: 'payment-1',
    bookingIntentId: 'intent-1',
    ancillarySelectionId: 'selection-3',
    ancillarySelectionVersion: 3,
    stripePaymentIntentId: 'pi-1',
    stripeCustomerId: null,
    amount: 15300,
    currency: 'usd',
    status: options.paymentStatus ?? 'AUTHORIZED',
    bookingIntent: {
      id: 'intent-1',
      userId: 'user-1',
      currentAncillarySelectionId: 'selection-4',
      ancillaryVersion: 4,
    },
    ancillarySelection: boundSelection,
  };
  const paymentState = { ...payment };
  const paymentFindUnique = jest.fn();
  const paymentFindResults = options.paymentFindResults ?? [paymentState];
  for (const result of paymentFindResults) {
    paymentFindUnique.mockResolvedValueOnce(result ? { ...result } : result);
  }
  paymentFindUnique.mockImplementation(() => Promise.resolve({ ...paymentState }));

  const transaction = {
    payment: {
      findUnique: paymentFindUnique,
      update: jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) paymentState.status = args.data.status;
        return Promise.resolve({ ...paymentState });
      }),
      updateMany: jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) paymentState.status = args.data.status;
        return Promise.resolve({ count: 1 });
      }),
    },
    paymentEvent: { create: jest.fn().mockResolvedValue(undefined) },
    bookingIntent: {
      update: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'intent-1',
        supplierOfferId: 'offer-1',
        currentAncillarySelectionId: 'selection-4',
        ancillaryVersion: 4,
        paymentAttemptCount: 1,
        passengers: [{ id: 'passenger-1', type: 'adult' }],
      }),
    },
    ledgerEntry: { createMany: jest.fn().mockResolvedValue(undefined) },
  };
  const prisma = {
    payment: {
      findUnique: paymentFindUnique,
      update: jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) paymentState.status = args.data.status;
        return Promise.resolve({ ...paymentState });
      }),
      updateMany: jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) paymentState.status = args.data.status;
        return Promise.resolve({ count: 1 });
      }),
    },
    bookingIntent: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'intent-1',
        supplierOfferId: 'offer-1',
        currentAncillarySelectionId: 'selection-4',
        ancillaryVersion: 4,
        paymentAttemptCount: 1,
        passengers: [{ id: 'passenger-1', type: 'adult' }],
      }),
      update: jest.fn(),
    },
    booking: { findFirst: jest.fn().mockResolvedValue(null) },
    paymentEvent: {
      create: jest.fn().mockResolvedValue(undefined),
      findFirst: jest.fn().mockResolvedValue({ metadata: order }),
    },
    ledgerEntry: { createMany: jest.fn() },
    $transaction: jest.fn().mockImplementation(async (callback) => callback(transaction)),
  };
  const stripe = {
    retrievePaymentIntent: jest.fn().mockResolvedValue({ status: 'requires_capture' }),
    capturePaymentIntent: options.captureError
      ? jest.fn().mockRejectedValue(options.captureError)
      : jest.fn().mockResolvedValue({ status: 'succeeded' }),
    cancelPaymentIntent: jest.fn().mockResolvedValue(undefined),
  };
  const idempotency = {
    computeHash: jest.fn().mockReturnValue('confirm-hash'),
    acquireOrReplay: jest.fn().mockResolvedValue({
      status: 'acquired',
      lockedAt: new Date('2026-09-16T12:00:00Z'),
    }),
    assertOwned: jest.fn().mockResolvedValue(undefined),
    getResumePoint: jest.fn().mockResolvedValue(options.recoveryPoint ?? 'stripe_authorized'),
    advanceSagaCheckpoint: jest.fn().mockImplementation(async (ownership: any, checkpoint: string) => {
      const key = typeof ownership === 'string' ? ownership : ownership?.key;
      await idempotency.updateRecoveryPoint(key, checkpoint);
    }),
    updateRecoveryPoint: jest.fn().mockResolvedValue(undefined),
    completeSagaKeyAtomic: jest.fn().mockImplementation(async (ownership: any, _status: number, _response: any) => {
      const key = typeof ownership === 'string' ? ownership : ownership?.key;
      await idempotency.updateRecoveryPoint(key, 'completed');
    }),
    completeKey: jest.fn().mockResolvedValue(undefined),
  };
  const duffel = {
    createOrder:
      options.createOrder ??
      (options.supplierError
        ? jest.fn().mockRejectedValue(options.supplierError)
        : jest.fn().mockResolvedValue(order)),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
    retrieveCompleteOrder: jest.fn().mockResolvedValue(order),
    mapDuffelOrderToSnapshots: jest.fn().mockReturnValue({
      flightSnapshot: { segments: [] },
      passengerSnapshot: { passengers: [] },
    }),
  };
  const booking = {
    createBooking: jest.fn().mockResolvedValue({ id: 'booking-1', userId: 'user-1' }),
    updateToConfirmed: jest.fn().mockResolvedValue(undefined),
    confirmBooking: jest.fn().mockResolvedValue(undefined),
    updateToFailed: jest.fn().mockResolvedValue(undefined),
    failBooking: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { createLog: jest.fn().mockResolvedValue(undefined) };

  const paymentGateway: PaymentGatewayPort = {
    authorizeHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
      if (control?.beforeInvoke) await control.beforeInvoke();
      const pi = await stripe.retrievePaymentIntent(intentId);
      const status: PaymentAuthorizationStatus =
        pi?.status === 'requires_capture'
          ? 'authorized'
          : pi?.status === 'succeeded'
            ? 'captured'
            : 'invalid';
      return {
        status,
        intentId,
        amount: pi?.amount ?? 15300,
        currency: pi?.currency ?? 'usd',
        rawStatus: pi?.status,
      };
    }),
    capturePayment: jest.fn(
      async (intentId: string, captureKey: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        const pi = await stripe.capturePaymentIntent(intentId, undefined, captureKey);
        return {
          success: pi?.status === 'succeeded',
          intentId,
          status: pi?.status ?? 'succeeded',
          capturedAmount: pi?.amount ?? 15300,
          currency: 'usd',
        };
      },
    ),
    voidHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
      if (control?.beforeInvoke) await control.beforeInvoke();
      await stripe.cancelPaymentIntent(intentId);
      return {
        success: true,
        intentId,
        status: 'canceled',
      };
    }),
  };

  const fulfillmentGateway: FulfillmentGatewayPort = {
    createOrder: jest.fn(async (input: CreateOrderInput, control?: PortInvocationControl) => {
      if (control?.beforeInvoke) await control.beforeInvoke();
      const services =
        input.services && input.services.length > 0
          ? input.services.map((s) => ({ id: s.serviceId, quantity: s.quantity }))
          : undefined;
      const res = await duffel.createOrder(
        input.offerId,
        input.passengers,
        services,
        input.metadata,
        input.idempotencyKey,
      );
      return {
        orderId: res?.id ?? 'order-1',
        bookingReference: res?.booking_reference ?? 'PNR123',
        evidence: res,
      };
    }),
    cancelOrder: jest.fn(async (orderId: string, control?: PortInvocationControl) => {
      if (control?.beforeInvoke) await control.beforeInvoke();
      await duffel.cancelOrder(orderId);
      return {
        success: true,
        orderId,
        status: 'CANCELLED',
      };
    }),
    retrieveOrderSnapshot: jest.fn(
      async (
        orderId: string,
        evidence: PersistedOrderEvidence,
        _enrichment: any,
        _email: string,
        control?: PortInvocationControl,
      ) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        const completeOrder = await duffel.retrieveCompleteOrder(orderId);
        const snaps = duffel.mapDuffelOrderToSnapshots(completeOrder ?? evidence);
        return {
          flightSnapshot: snaps?.flightSnapshot ?? { segments: [] },
          passengerSnapshot: snaps?.passengerSnapshot ?? { passengers: [] },
          departureAt: undefined,
        };
      },
    ),
  };

  const saga = new PaymentFulfillmentSaga(
    paymentGateway,
    fulfillmentGateway,
    idempotency as unknown as PaymentIdempotencyService,
    {} as PaymentMethodService,
    booking as unknown as BookingLifecycleService,
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );

  return {
    service: saga as PaymentFulfillmentSaga,
    saga,
    payment,
    prisma,
    stripe,
    idempotency,
    duffel,
    booking,
    paymentGateway,
    fulfillmentGateway,
  };
}

describe('PaymentService ancillary order recovery', () => {
  it('creates the supplier order from the immutable Payment-bound version N after version N+1 becomes current', async () => {
    const { service, duffel } = buildHarness();

    await expect(
      service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).resolves.toMatchObject({ success: true, duffelOrderId: 'order-1' });

    expect(duffel.createOrder).toHaveBeenCalledTimes(1);
    expect(duffel.createOrder).toHaveBeenCalledWith(
      'offer-1',
      [{ id: 'passenger-1', type: 'adult' }],
      [
        { id: 'seat-b', quantity: 1 },
        { id: 'seat-a', quantity: 2 },
        { id: 'bag-1', quantity: 4 },
      ],
      { bookingIntentId: 'intent-1', paymentId: 'payment-1' },
      'confirm-key-1',
    );
  });

  it('rechecks the exact PAYMENT_BOUND selection immediately before supplier order creation', async () => {
    const seed = buildHarness();
    const harness = buildHarness({
      paymentFindResults: [
        seed.payment,
        {
          ...seed.payment,
          ancillarySelection: {
            ...boundSelection,
            status: 'VALIDATED',
          },
        },
      ],
    });

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(harness.prisma.payment.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.duffel.createOrder).not.toHaveBeenCalled();
    expect(harness.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(harness.stripe.capturePaymentIntent).not.toHaveBeenCalled();
  });

  it('cancels the authorization and never captures when the supplier order fails', async () => {
    const harness = buildHarness({
      supplierError: new Error('supplier unavailable'),
    });

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(harness.duffel.createOrder).toHaveBeenCalledTimes(1);
    expect(harness.stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-1');
    expect(harness.stripe.capturePaymentIntent).not.toHaveBeenCalled();
    expect(harness.booking.updateToFailed).toHaveBeenCalledTimes(1);
    expect(harness.idempotency.updateRecoveryPoint).toHaveBeenLastCalledWith(
      'confirm-key-1',
      'completed',
    );
  });

  it('cancels the supplier order and authorization when capture fails', async () => {
    const harness = buildHarness({ captureError: new Error('capture failed') });

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(harness.duffel.createOrder).toHaveBeenCalledTimes(1);
    expect(harness.stripe.capturePaymentIntent).toHaveBeenCalledWith(
      'pi-1',
      undefined,
      'confirm-key-1-stripe-capture',
    );
    expect(harness.duffel.cancelOrder).toHaveBeenCalledWith('order-1');
    expect(harness.stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi-1');
    expect(harness.booking.updateToFailed).toHaveBeenCalledTimes(1);
  });

  it('recovers when capture times out after Stripe authoritatively reports success', async () => {
    const harness = buildHarness({
      recoveryPoint: 'duffel_order_created',
      captureError: new Error('capture request timed out'),
    });
    harness.stripe.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).resolves.toMatchObject({ success: true, duffelOrderId: 'order-1' });

    expect(harness.stripe.capturePaymentIntent).toHaveBeenCalledWith(
      'pi-1',
      undefined,
      'confirm-key-1-stripe-capture',
    );
    expect(harness.stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi-1');
    expect(harness.duffel.cancelOrder).not.toHaveBeenCalled();
    expect(harness.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(harness.booking.updateToFailed).not.toHaveBeenCalled();
  });

  it('keeps the supplier order and payment recoverable when Stripe capture reconciliation is unavailable', async () => {
    const harness = buildHarness({
      recoveryPoint: 'duffel_order_created',
      captureError: new Error('capture request timed out'),
    });
    harness.stripe.retrievePaymentIntent.mockRejectedValue(new Error('Stripe retrieval outage'));

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 502 });

    expect(harness.duffel.cancelOrder).not.toHaveBeenCalled();
    expect(harness.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    expect(harness.booking.updateToFailed).not.toHaveBeenCalled();
    expect(harness.prisma.payment.update).not.toHaveBeenCalled();
    expect(harness.idempotency.updateRecoveryPoint).not.toHaveBeenCalled();
    expect(harness.idempotency.completeKey).not.toHaveBeenCalled();
  });

  it.each([
    {
      checkpoint: 'started',
      paymentStatus: 'CREATED',
      retrieveCalls: 1,
      orderCalls: 1,
      captureCalls: 1,
      paymentLoads: 3,
    },
    {
      checkpoint: 'stripe_authorized',
      paymentStatus: 'AUTHORIZED',
      retrieveCalls: 0,
      orderCalls: 1,
      captureCalls: 1,
      paymentLoads: 3,
    },
    {
      checkpoint: 'duffel_order_created',
      paymentStatus: 'AUTHORIZED',
      retrieveCalls: 0,
      orderCalls: 0,
      captureCalls: 1,
      paymentLoads: 1,
    },
    {
      checkpoint: 'captured',
      paymentStatus: 'AUTHORIZED',
      retrieveCalls: 0,
      orderCalls: 0,
      captureCalls: 0,
      paymentLoads: 1,
    },
    {
      checkpoint: 'completed',
      paymentStatus: 'SUCCEEDED',
      retrieveCalls: 0,
      orderCalls: 0,
      captureCalls: 0,
      paymentLoads: 1,
    },
  ])(
    'resumes $checkpoint from the Payment-bound snapshot without duplicating completed steps',
    async ({
      checkpoint,
      paymentStatus,
      retrieveCalls,
      orderCalls,
      captureCalls,
      paymentLoads,
    }) => {
      const harness = buildHarness({ recoveryPoint: checkpoint, paymentStatus });

      await expect(
        harness.service.executeConfirmPayment(
          { paymentId: 'payment-1', bookingId: 'booking-1' },
          'confirm-key-1',
          'user-1',
        ),
      ).resolves.toMatchObject({ success: true, duffelOrderId: 'order-1' });

      expect(harness.prisma.payment.findUnique).toHaveBeenCalledWith({
        where: { id: 'payment-1' },
        include: {
          bookingIntent: true,
          ancillarySelection: {
            include: {
              seatSelections: true,
              baggageSelections: {
                include: {
                  segments: true,
                },
              },
            },
          },
        },
      });
      expect(harness.prisma.payment.findUnique).toHaveBeenCalledTimes(paymentLoads);
      expect(harness.stripe.retrievePaymentIntent).toHaveBeenCalledTimes(retrieveCalls);
      expect(harness.duffel.createOrder).toHaveBeenCalledTimes(orderCalls);
      expect(harness.stripe.capturePaymentIntent).toHaveBeenCalledTimes(captureCalls);
      expect(harness.duffel.cancelOrder).not.toHaveBeenCalled();
      expect(harness.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
    },
  );

  it('loads the immutable Payment-bound snapshot during background recovery', async () => {
    const harness = buildHarness();
    harness.stripe.retrievePaymentIntent.mockResolvedValue({ status: 'succeeded' });
    harness.idempotency.getResumePoint.mockResolvedValue(null);
    const ownership: SagaOwnership = {
      key: 'confirm-key-1',
      userId: 'user-1',
      requestPath: '/api/bookings/payment/confirm',
      requestHash: '',
      lockedAt: new Date(),
    };

    await harness.saga.handleBackgroundError(
      'payment-1',
      'confirm-key-1',
      'user-1',
      ownership,
      new Error('background handoff'),
    );

    expect(harness.prisma.payment.findUnique).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      include: {
        ancillarySelection: {
          include: {
            seatSelections: true,
            baggageSelections: true,
          },
        },
      },
    });
    expect(harness.prisma.bookingIntent.findUnique).not.toHaveBeenCalled();
  });

  it('retries a crash after supplier order with one idempotent order and one capture', async () => {
    const supplierOrders = new Map<string, typeof order>();
    const createOrder = jest.fn(async (...args: unknown[]) => {
      const idempotencyKey = String(args[4]);
      const existing = supplierOrders.get(idempotencyKey);
      if (existing) {
        return existing;
      }
      supplierOrders.set(idempotencyKey, order);
      return order;
    });
    const harness = buildHarness({ createOrder });
    let crashed = false;
    harness.idempotency.updateRecoveryPoint.mockImplementation(
      async (_key: string, recoveryPoint: string) => {
        if (recoveryPoint === 'duffel_order_created' && !crashed) {
          crashed = true;
          throw new Error('crash after supplier order');
        }
      },
    );

    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).rejects.toThrow('crash after supplier order');
    await expect(
      harness.service.executeConfirmPayment(
        { paymentId: 'payment-1', bookingId: 'booking-1' },
        'confirm-key-1',
        'user-1',
      ),
    ).resolves.toMatchObject({ success: true, duffelOrderId: 'order-1' });

    expect(supplierOrders.size).toBe(1);
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(createOrder.mock.calls.map((call) => call.slice(2))).toEqual([
      [
        [
          { id: 'seat-b', quantity: 1 },
          { id: 'seat-a', quantity: 2 },
          { id: 'bag-1', quantity: 4 },
        ],
        { bookingIntentId: 'intent-1', paymentId: 'payment-1' },
        'confirm-key-1',
      ],
      [
        [
          { id: 'seat-b', quantity: 1 },
          { id: 'seat-a', quantity: 2 },
          { id: 'bag-1', quantity: 4 },
        ],
        { bookingIntentId: 'intent-1', paymentId: 'payment-1' },
        'confirm-key-1',
      ],
    ]);
    expect(harness.stripe.capturePaymentIntent).toHaveBeenCalledTimes(1);
    expect(harness.stripe.capturePaymentIntent).toHaveBeenCalledWith(
      'pi-1',
      undefined,
      'confirm-key-1-stripe-capture',
    );
  });
});
