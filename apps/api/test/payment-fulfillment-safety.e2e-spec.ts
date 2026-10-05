import 'reflect-metadata';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingRecoveryService } from '@/booking-lifecycle/booking-recovery.service';
import { CacheService } from '@/cache/cache.service';
import { DuffelCancellationService } from '@/supplier/order/duffel-cancellation.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { BookingEventPublisherService } from '@/domain-events';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { PrismaService } from '@/prisma/prisma.service';
import { PAYMENT_GATEWAY_PORT, FULFILLMENT_GATEWAY_PORT, PortInvocationControl } from '@/payment-fulfillment/ports';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
import { RefundTransactionService } from '@/refund/refund-transaction.service';
import { RefundSettlementService } from '@/refund-settlement/refund-settlement.service';
import { StripeService } from '@/common/stripe.service';
import { FLIGHT_SEARCH_PORT } from '@/supplier/search/flight-search.port';

type QueryArgs = {
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
};

// Human approval for explicit fixture typing recorded 2026-10-02.
type SafetyFixture = {
  module: TestingModule;
  saga: PaymentFulfillmentSaga;
  recovery: BookingRecoveryService;
  lifecycle: BookingLifecycleService;
  cache: CacheService;
  stripe: { cancelPaymentIntent: jest.Mock<Promise<{ status: string }>, []> };
  duffel: { cancelOrder: jest.Mock<Promise<unknown>, []> };
  fulfillmentGateway: unknown;
  paymentGateway: {
    voidHold: jest.Mock<
      Promise<{ success: boolean; intentId: string; status: string }>,
      [intentId: string, control: PortInvocationControl]
    >;
  };
  state: {
    paymentRow: Record<string, unknown>;
    paymentEvents: Record<string, unknown>[];
    timeline: string[];
    getBooking: () => Record<string, unknown> | undefined;
    getIdempotency: () => Record<string, unknown> | undefined;
    getCancellationEffects: () => number;
  };
  duffelCancellationResults: unknown[];
  fakePrisma: {
    paymentEvent: {
      create: jest.Mock<
        Promise<Record<string, unknown> | undefined>,
        [args: QueryArgs]
      >;
    };
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesQuery(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, condition]) => {
    if (isRecord(condition)) {
      if (Array.isArray(condition.in) && !condition.in.includes(row[key])) return false;
      if (Array.isArray(condition.notIn) && condition.notIn.includes(row[key])) return false;
      if (Object.prototype.hasOwnProperty.call(condition, 'not') && row[key] === condition.not) {
        return false;
      }
      return true;
    }
    return row[key] === condition;
  });
}

function applyUpdate(row: Record<string, unknown>, data: Record<string, unknown> | undefined): void {
  for (const [key, value] of Object.entries(data ?? {})) {
    if (isRecord(value) && typeof value.increment === 'number' && typeof row[key] === 'number') {
      row[key] = row[key] + value.increment;
    } else {
      row[key] = value;
    }
  }
}

async function createSafetyFixture(): Promise<SafetyFixture> {
  const timeline: string[] = [];
  const paymentEvents: Record<string, unknown>[] = [];
  const duffelCancellationResults: unknown[] = [];
  const paymentRow: Record<string, unknown> = {
    id: 'payment-safety-1',
    amount: 15000,
    currency: 'USD',
    status: PaymentStatus.CREATED,
    stripePaymentIntentId: 'pi-safety-1',
    stripeCustomerId: 'cus-safety-1',
    bookingIntentId: 'intent-safety-1',
    ancillarySelectionId: null,
    ancillarySelectionVersion: null,
    ancillarySelection: null,
  };
  const bookingIntentRow: Record<string, unknown> = {
    id: 'intent-safety-1',
    userId: 'user-safety-1',
    supplierOfferId: 'offer-safety-1',
    paymentAttemptCount: 1,
    confirmedPrice: 15000,
    currency: 'USD',
    status: 'AWAITING_PAYMENT',
    passengers: [
      {
        id: 'passenger-safety-1',
        givenName: 'Ada',
        familyName: 'Lovelace',
        type: 'ADULT',
        dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
        email: 'ada@example.com',
      },
    ],
    user: { email: 'ada@example.com' },
    rawOfferSnapshot: null,
  };
  let bookingRow: Record<string, unknown> | undefined;
  let idempotencyRow: Record<string, unknown> | undefined;
  let cancellationEffects = 0;
  let prismaAdapter: object = {};

  function getBookingWithRelations(): Record<string, unknown> | null {
    if (!bookingRow) return null;
    return {
      ...bookingRow,
      payment: { ...paymentRow, bookingIntent: bookingIntentRow },
      bookingIntent: bookingIntentRow,
    };
  }

  function updateMany(
    row: Record<string, unknown> | undefined,
    args: QueryArgs,
    kind: 'payment' | 'booking' | 'bookingIntent' | 'idempotencyKey',
  ): { count: number } {
    if (!row || !matchesQuery(row, args.where)) return { count: 0 };
    const previousStatus = row.status;
    applyUpdate(row, args.data);
    if (kind === 'booking' && previousStatus === 'PROCESSING' && row.status === 'FAILED') {
      timeline.push('booking.failed');
    }
    return { count: 1 };
  }

  const fakePrisma = {
    $transaction: jest.fn(async (callback: (tx: object) => Promise<unknown>) =>
      callback(prismaAdapter),
    ),
    payment: {
      findUnique: jest.fn(async ({ where }: QueryArgs) =>
        where?.id === paymentRow.id
          ? { ...paymentRow, bookingIntent: bookingIntentRow }
          : null,
      ),
      findFirst: jest.fn(async ({ where }: QueryArgs) =>
        where?.id === paymentRow.id ? paymentRow : null,
      ),
      update: jest.fn(async ({ where, data }: QueryArgs) => {
        if (where?.id === paymentRow.id) applyUpdate(paymentRow, data);
        return paymentRow;
      }),
      updateMany: jest.fn(async (args: QueryArgs) => updateMany(paymentRow, args, 'payment')),
    },
    paymentEvent: {
      create: jest.fn(async ({ data }: QueryArgs) => {
        const event: Record<string, unknown> = {
          id: paymentEvents.length + 1,
          createdAt: new Date(),
          ...data,
        };
        paymentEvents.push(event);
        if (event.eventType === 'duffel_order_cancelled') timeline.push('order.cancelled.marker');
        return event;
      }),
      findFirst: jest.fn(async ({ where }: QueryArgs) =>
        paymentEvents.find((event) => matchesQuery(event, where)) ?? null,
      ),
    },
    bookingIntent: {
      findUnique: jest.fn(async ({ where }: QueryArgs) =>
        where?.id === bookingIntentRow.id ? bookingIntentRow : null,
      ),
      update: jest.fn(async ({ where, data }: QueryArgs) => {
        if (where?.id === bookingIntentRow.id) applyUpdate(bookingIntentRow, data);
        return bookingIntentRow;
      }),
      updateMany: jest.fn(async (args: QueryArgs) =>
        updateMany(bookingIntentRow, args, 'bookingIntent'),
      ),
    },
    booking: {
      findUnique: jest.fn(async ({ where }: QueryArgs) => {
        if (
          bookingRow &&
          (where?.id === bookingRow.id || where?.bookingIntentId === bookingRow.bookingIntentId)
        ) {
          return getBookingWithRelations();
        }
        return null;
      }),
      findFirst: jest.fn(async ({ where }: QueryArgs) =>
        bookingRow && where?.paymentId === bookingRow.paymentId ? getBookingWithRelations() : null,
      ),
      create: jest.fn(async ({ data }: QueryArgs) => {
        bookingRow = {
          ...data,
          createdAt: new Date(Date.now() - 16 * 60 * 1000),
          version: 1,
        };
        return bookingRow;
      }),
      update: jest.fn(async ({ where, data }: QueryArgs) => {
        if (bookingRow && where?.id === bookingRow.id) applyUpdate(bookingRow, data);
        return bookingRow;
      }),
      updateMany: jest.fn(async (args: QueryArgs) => updateMany(bookingRow, args, 'booking')),
    },
    idempotencyKey: {
      findUnique: jest.fn(async ({ where }: QueryArgs) =>
        where?.key === idempotencyRow?.key ? idempotencyRow : null,
      ),
      findFirst: jest.fn(async ({ where }: QueryArgs) =>
        idempotencyRow && matchesQuery(idempotencyRow, where) ? idempotencyRow : null,
      ),
      create: jest.fn(async ({ data }: QueryArgs) => {
        idempotencyRow = { id: 'idempotency-safety-1', responseBody: null, ...data };
        return idempotencyRow;
      }),
      update: jest.fn(async ({ where, data }: QueryArgs) => {
        if (idempotencyRow && where?.key === idempotencyRow.key) applyUpdate(idempotencyRow, data);
        return idempotencyRow;
      }),
      updateMany: jest.fn(async (args: QueryArgs) =>
        updateMany(idempotencyRow, args, 'idempotencyKey'),
      ),
    },
    auditLog: {
      create: jest.fn(async ({ data }: QueryArgs) => data),
    },
  };
  prismaAdapter = fakePrisma;

  const stripe = {
    retrievePaymentIntent: jest.fn(async () => ({ status: 'requires_capture' })),
    cancelPaymentIntent: jest.fn(async () => {
      timeline.push('stripe.cancel');
      return { status: 'canceled' };
    }),
  };
  const fulfillmentGateway = {
    createOrder: jest.fn(async (_input: unknown, control: PortInvocationControl) => {
      await control.beforeInvoke();
      return {
        orderId: 'order-safety-1',
        bookingReference: 'PNR-SAFETY-1',
        evidence: { id: 'order-safety-1', bookingReference: 'PNR-SAFETY-1' },
      };
    }),
    cancelOrder: jest.fn(async (_id: string, control: PortInvocationControl) => {
      await control.beforeInvoke();
      timeline.push('fulfillment.cancel');
      throw new HttpException(
        {
          code: 'RATE_LIMIT_EXCEEDED',
          retryAfterSeconds: 3600,
          resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          supplierPayload: 'private supplier detail',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }),
    retrieveOrderSnapshot: jest.fn(),
  };
  const paymentGateway = {
    authorizeHold: jest.fn(async (intentId: string, control: PortInvocationControl) => {
      await control.beforeInvoke();
      return { status: 'authorized', intentId };
    }),
    capturePayment: jest.fn(async (_intentId: string, _key: string, control: PortInvocationControl) => {
      await control.beforeInvoke();
      throw new Error('Capture outcome unavailable');
    }),
    voidHold: jest.fn(async (intentId: string, control: PortInvocationControl) => {
      await control.beforeInvoke();
      timeline.push('stripe.void');
      return { success: true, intentId, status: 'canceled' };
    }),
  };
  const duffel = {
    cancelOrder: jest.fn(async () => {
      timeline.push('duffel.cancel');
      const result = duffelCancellationResults.shift();
      if (result instanceof Error) {
        if (/already_cancelled|already cancelled/i.test(result.message)) {
          cancellationEffects += 1;
          timeline.push('duffel.already-cancelled');
        }
        throw result;
      }
      const isConfirmed = isRecord(result) && ['confirmed', 'cancelled', 'canceled'].includes(
        typeof result.status === 'string' ? result.status.toLowerCase() : '',
      );
      if (isConfirmed) {
        cancellationEffects += 1;
        timeline.push('duffel.confirmed');
      }
      if (isRecord(result)) {
        return {
          success: typeof result.success === 'boolean' ? result.success : isConfirmed,
          orderId: typeof result.id === 'string' ? result.id : 'order-safety-1',
          status: typeof result.status === 'string' ? result.status : undefined,
          ...result,
        };
      }
      return result;
    }),
  };

  const module = await Test.createTestingModule({
    providers: [
      { provide: PrismaService, useValue: fakePrisma },
      { provide: StripeService, useValue: stripe },
      { provide: DuffelCancellationService, useValue: duffel },
      { provide: DuffelRecoveryService, useValue: { mapOrderToSnapshots: jest.fn() } },
      { provide: PAYMENT_GATEWAY_PORT, useValue: paymentGateway },
      { provide: FULFILLMENT_GATEWAY_PORT, useValue: fulfillmentGateway },
      {
        provide: FLIGHT_SEARCH_PORT,
        useValue: {
          searchFlights: jest.fn(),
          normalizeStoredFlightSnapshot: jest.fn(),
          readStoredOfferFacts: jest.fn(),
          createNeutralStoredOfferMetadata: jest.fn(),
        },
      },
      PaymentIdempotencyService,
      PaymentMethodService,
      AuditService,
      BookingEventPublisherService,
      BookingLifecycleService,
      RefundTransactionService,
      RefundSettlementService,
      CacheService,
      PaymentFulfillmentSaga,
      BookingRecoveryService,
    ],
  }).compile();

  return {
    module,
    saga: module.get(PaymentFulfillmentSaga),
    recovery: module.get(BookingRecoveryService),
    lifecycle: module.get(BookingLifecycleService),
    cache: module.get(CacheService),
    stripe,
    duffel,
    fulfillmentGateway,
    paymentGateway,
    state: {
      paymentRow,
      paymentEvents,
      timeline,
      getBooking: () => bookingRow,
      getIdempotency: () => idempotencyRow,
      getCancellationEffects: () => cancellationEffects,
    },
    duffelCancellationResults,
    fakePrisma,
  };
}

describe('Payment fulfillment safety E2E', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps the order and hold through rate deferral and retries after the next-day reset', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T01:00:00.000Z'));
    const fixture = await createSafetyFixture();
    try {
      let sagaError: unknown;
      try {
        await fixture.saga.confirmPayment(
          { bookingId: 'booking-safety-1', paymentId: 'payment-safety-1' },
          'idempotency-safety-key',
          'user-safety-1',
        );
      } catch (error) {
        sagaError = error;
      }

      expect(sagaError).toBeInstanceOf(HttpException);
      if (!(sagaError instanceof HttpException)) {
        throw new Error('Expected an HTTP capture-compensation error');
      }
      expect(sagaError.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(sagaError.getResponse()).toMatchObject({ bookingStatus: 'PROCESSING' });
      expect(JSON.stringify(sagaError.getResponse())).not.toContain('private supplier detail');
      expect(fixture.state.paymentRow.status).toBe(PaymentStatus.AUTHORIZED);
      expect(fixture.state.getBooking()?.status).toBe('PROCESSING');
      expect(fixture.state.getIdempotency()?.recoveryPoint).toBe('duffel_order_created');
      expect(fixture.state.getIdempotency()?.responseBody).toBeNull();
      expect(fixture.state.paymentEvents.filter((event) => event.eventType === 'duffel_order_created')).toHaveLength(1);
      expect(fixture.paymentGateway.voidHold).not.toHaveBeenCalled();

      const resetAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      fixture.duffelCancellationResults.push(
        new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterSeconds: 24 * 60 * 60,
            resetAt,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
        { id: 'cancel-safety-1', status: 'pending' },
        { id: 'cancel-safety-1', status: 'confirmed' },
      );

      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });
      const deferKey = 'booking:recovery:defer:booking-safety-1';
      expect(await fixture.cache.getTtl(deferKey)).toBeGreaterThan(0);
      expect(fixture.state.getBooking()?.status).toBe('PROCESSING');
      expect(fixture.stripe.cancelPaymentIntent).not.toHaveBeenCalled();

      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });
      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(1);

      await fixture.cache.del(deferKey);
      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });
      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(2);
      expect(fixture.state.getBooking()?.status).toBe('PROCESSING');
      expect(fixture.stripe.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(fixture.state.paymentEvents.filter((event) => event.eventType === 'duffel_order_cancelled')).toHaveLength(0);
      expect(await fixture.cache.getTtl(deferKey)).toBeGreaterThan(0);

      jest.setSystemTime(new Date(resetAt));
      expect(await fixture.cache.getTtl(deferKey)).toBeLessThanOrEqual(0);
      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });

      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(3);
      expect(fixture.state.getCancellationEffects()).toBe(1);
      expect(fixture.stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(fixture.state.paymentRow.status).toBe(PaymentStatus.CANCELLED);
      expect(fixture.state.getBooking()?.status).toBe('FAILED');
      expect(fixture.state.paymentEvents.filter((event) => event.eventType === 'duffel_order_cancelled')).toHaveLength(1);
      expect(fixture.state.timeline.indexOf('duffel.confirmed')).toBeLessThan(
        fixture.state.timeline.indexOf('stripe.cancel'),
      );
      expect(fixture.state.timeline.indexOf('stripe.cancel')).toBeLessThan(
        fixture.state.timeline.indexOf('booking.failed'),
      );

      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });
      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(3);
      expect(fixture.stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    } finally {
      await fixture.module.close();
      jest.useRealTimers();
    }
  });

  it('treats already-cancelled provider state as one confirmed effect across recovery replay', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-02T01:00:00.000Z'));
    const fixture = await createSafetyFixture();
    try {
      await fixture.lifecycle.createBooking(
        'user-safety-1',
        'booking-safety-1',
        'intent-safety-1',
        'payment-safety-1',
      );
      fixture.state.paymentRow.status = PaymentStatus.AUTHORIZED;
      await fixture.fakePrisma.paymentEvent.create({
        data: {
          paymentId: 'payment-safety-1',
          eventType: 'duffel_order_created',
          metadata: { id: 'order-safety-1' },
        },
      });
      // Human approval 2026-10-02: replay success requires explicit provider CANCELLED evidence.
      fixture.duffelCancellationResults.push({ id: 'order-safety-1', status: 'CANCELLED' });

      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });

      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(1);
      expect(fixture.state.getCancellationEffects()).toBe(1);
      expect(fixture.state.paymentEvents.filter((event) => event.eventType === 'duffel_order_cancelled')).toHaveLength(1);
      expect(fixture.stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(fixture.state.getBooking()?.status).toBe('FAILED');

      await fixture.recovery.handleReconciliationRequested({ bookingId: 'booking-safety-1' });

      expect(fixture.duffel.cancelOrder).toHaveBeenCalledTimes(1);
      expect(fixture.state.getCancellationEffects()).toBe(1);
      expect(fixture.stripe.cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(fixture.state.paymentEvents.filter((event) => event.eventType === 'duffel_order_cancelled')).toHaveLength(1);
    } finally {
      await fixture.module.close();
      jest.useRealTimers();
    }
  });
});
