import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BookingFailureReason } from '@prisma/client';
import { PaymentFulfillmentSaga } from './payment-fulfillment.saga';
import {
  PaymentGatewayPort,
  FulfillmentGatewayPort,
  PortInvocationControl,
  PersistedOrderEvidence,
} from './ports';
import { PaymentIdempotencyService, SagaOwnership } from '@/idempotency/payment-idempotency.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AuditService } from '@/audit/audit.service';
import { BookingPassengerFinalValidatorService } from '@/booking-intent/booking-passenger-final-validator.service';
import { BookingEventPublisherService } from '@/domain-events';
import { ConfirmPaymentDto } from '@/payment/dto/confirm-payment.dto';
import type { FlightSnapshot } from '@shared/booking-types';
import type { FlightSearchPort } from '@/supplier/search/flight-search.port';

interface ConfirmPaymentResult {
  success?: boolean;
  status?: string;
  message?: string;
  pollUrl?: string;
  paymentId?: string;
  bookingReference?: string;
  duffelOrderId?: string;
  error?: string;
  bookingStatus?: string;
}

interface MockPrisma {
  $transaction: jest.Mock;
  payment: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  paymentEvent: {
    create: jest.Mock;
    findFirst: jest.Mock;
  };
  bookingIntent: {
    findUnique: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  booking: {
    findUnique: jest.Mock;
    findFirst: jest.Mock;
  };
  ledgerEntry: {
    createMany: jest.Mock;
  };
}

// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md

describe('PaymentFulfillmentSaga', () => {
  let saga: PaymentFulfillmentSaga;
  let mockPaymentGateway: {
    authorizeHold: jest.Mock;
    capturePayment: jest.Mock;
    voidHold: jest.Mock;
  };
  let mockFulfillmentGateway: {
    createOrder: jest.Mock;
    cancelOrder: jest.Mock;
    retrieveOrderSnapshot: jest.Mock;
  };
  let mockIdempotency: {
    computeHash: jest.Mock;
    acquireOrReplay: jest.Mock;
    assertOwned: jest.Mock;
    getResumePoint: jest.Mock;
    advanceSagaCheckpoint: jest.Mock;
    completeSagaKeyAtomic: jest.Mock;
  };
  let mockPaymentMethod: {
    saveMethod: jest.Mock;
  };
  let mockBookingLifecycle: {
    createBooking: jest.Mock;
    updateToConfirmed: jest.Mock;
    confirmBooking: jest.Mock;
    updateToFailed: jest.Mock;
  };
  let mockPublisher: {
    createContext: jest.Mock;
    publish: jest.Mock;
  };
  let mockPrisma: MockPrisma;
  let mockAudit: {
    createLog: jest.Mock;
  };
  let mockValidator: {
    validateAndMapPassengers: jest.Mock;
  };
  let mockFlightSearch: FlightSearchPort;
  let normalizeStoredFlightSnapshot: jest.Mock;
  let currentPaymentState: Record<string, unknown>;

  const userId = 'user-123';
  const idempotencyKey = 'idemp-key-123';
  const bookingId = '123e4567-e89b-42d3-a456-426614174000';
  const paymentId = 'pay-123';
  const dto: ConfirmPaymentDto = {
    bookingId,
    paymentId,
  };

  const baseBookingIntent = {
    id: 'intent-123',
    userId,
    supplierOfferId: 'off-123',
    paymentAttemptCount: 1,
    confirmedPrice: 15000,
    currency: 'USD',
    status: 'AWAITING_PAYMENT',
    passengers: [
      {
        id: 'p-1',
        givenName: 'Ada',
        familyName: 'Lovelace',
        firstName: 'Ada',
        lastName: 'Lovelace',
        dateOfBirth: new Date('1990-01-01'),
        passengerType: 'adult',
        type: 'ADULT',
        title: 'ms',
        email: 'ada@example.com',
        phoneNumber: '+15551234567',
      },
    ],
    user: { email: 'ada@example.com' },
  };

  const basePayment = {
    id: paymentId,
    amount: 15000,
    currency: 'USD',
    status: 'CREATED',
    stripePaymentIntentId: 'pi-123',
    stripeCustomerId: 'cus-123',
    bookingIntentId: 'intent-123',
    ancillarySelectionId: 'anc-123',
    ancillarySelectionVersion: 1,
    bookingIntent: baseBookingIntent,
    ancillarySelection: {
      id: 'anc-123',
      version: 1,
      status: 'PAYMENT_BOUND',
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    },
  };

  const baseSnapshots = {
    flightSnapshot: {
      slices: [],
      segments: [{ departureAt: '2026-10-01T10:00:00Z' }],
    },
    passengerSnapshot: {
      passengers: [{ id: 'p-1', name: 'Ada Lovelace' }],
    },
    departureAt: new Date('2026-10-01T10:00:00Z'),
  };

  beforeEach(() => {
    mockPaymentGateway = {
      authorizeHold: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          status: 'authorized',
          intentId: 'pi-123',
          amount: 15000,
          currency: 'USD',
        };
      }),
      capturePayment: jest.fn().mockImplementation(async (_id: string, _key: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          intentId: 'pi-123',
          status: 'succeeded',
          capturedAmount: 15000,
          currency: 'USD',
        };
      }),
      voidHold: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          intentId: 'pi-123',
          status: 'canceled',
        };
      }),
    };

    mockFulfillmentGateway = {
      createOrder: jest.fn().mockImplementation(async (_input: unknown, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          orderId: 'ord-123',
          bookingReference: 'PNR123',
          evidence: {
            id: 'ord-123',
            bookingReference: 'PNR123',
            booking_reference: 'PNR123',
          },
        };
      }),
      cancelOrder: jest.fn().mockImplementation(async (_id: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        return {
          success: true,
          orderId: 'ord-123',
          status: 'CANCELLED',
        };
      }),
      retrieveOrderSnapshot: jest.fn().mockImplementation(
        async (_id: string, _ev: unknown, _p: unknown, _e: unknown, control?: PortInvocationControl) => {
          if (control?.beforeInvoke) await control.beforeInvoke();
          return baseSnapshots;
        },
      ),
    };

    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('hash-123'),
      acquireOrReplay: jest.fn().mockResolvedValue({
        status: 'acquired',
        lockedAt: new Date('2026-09-16T12:00:00Z'),
      }),
      assertOwned: jest.fn().mockResolvedValue(undefined),
      getResumePoint: jest.fn().mockResolvedValue('started'),
      advanceSagaCheckpoint: jest.fn().mockResolvedValue(undefined),
      completeSagaKeyAtomic: jest.fn().mockResolvedValue(undefined),
    };

    mockPaymentMethod = {
      saveMethod: jest.fn().mockResolvedValue(undefined),
    };

    mockBookingLifecycle = {
      createBooking: jest.fn().mockResolvedValue({
        id: bookingId,
        userId,
        status: 'PROCESSING',
      }),
      updateToConfirmed: jest.fn().mockResolvedValue({
        id: bookingId,
        status: 'CONFIRMED',
      }),
      confirmBooking: jest.fn().mockImplementation(async (...args: unknown[]) => {
        return mockBookingLifecycle.updateToConfirmed(...args);
      }),
      updateToFailed: jest.fn().mockResolvedValue({
        id: bookingId,
        status: 'FAILED',
      }),
    };

    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
    };

    currentPaymentState = JSON.parse(JSON.stringify(basePayment));
    mockPrisma = {
      $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockPrisma)),
      payment: {
        findUnique: jest.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentPaymentState))),
        findFirst: jest.fn().mockImplementation(async () => JSON.parse(JSON.stringify(currentPaymentState))),
        update: jest.fn().mockImplementation(async (args: { data?: Record<string, unknown> }) => {
          if (args?.data) {
            for (const [key, value] of Object.entries(args.data)) {
              currentPaymentState[key] = value;
            }
          }
          return JSON.parse(JSON.stringify(currentPaymentState));
        }),
        updateMany: jest.fn().mockImplementation(async (args: { data?: Record<string, unknown>; where?: Record<string, unknown> }) => {
          if (args?.where?.status && typeof args.where.status === 'object') {
            const statusObj = args.where.status as Record<string, unknown>;
            if ('not' in statusObj && currentPaymentState.status === statusObj.not) {
              return { count: 0 };
            }
            if ('in' in statusObj && Array.isArray(statusObj.in) && !statusObj.in.includes(currentPaymentState.status)) {
              return { count: 0 };
            }
          }
          if (args?.data) {
            for (const [key, value] of Object.entries(args.data)) {
              currentPaymentState[key] = value;
            }
          }
          return { count: 1 };
        }),
      },
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(baseBookingIntent))),
        update: jest.fn().mockResolvedValue(JSON.parse(JSON.stringify(baseBookingIntent))),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      booking: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: bookingId, paymentId }),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'event-1',
          eventType: 'duffel_order_created',
          metadata: {
            id: 'ord-123',
            bookingReference: 'PNR123',
            booking_reference: 'PNR123',
          },
        }),
      },
      ledgerEntry: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    mockAudit = {
      createLog: jest.fn().mockResolvedValue(undefined),
    };

    mockValidator = {
      validateAndMapPassengers: jest.fn().mockReturnValue([
        {
          id: 'p-1',
          givenName: 'Ada',
          familyName: 'Lovelace',
          bornOn: '1990-01-01',
          passengerType: 'adult',
        },
      ]),
    };
    normalizeStoredFlightSnapshot = jest.fn().mockReturnValue(null);
    mockFlightSearch = {
      search: jest.fn().mockResolvedValue({ offers: [], searchHash: '', cached: false }),
      getOfferById: jest.fn(),
      normalizeStoredOffer: jest.fn().mockReturnValue(null),
      normalizeStoredOfferFacts: jest.fn().mockReturnValue({
        travelScope: null,
        tripCompletionDate: null,
        offerExpiresAt: null,
      }),
      normalizeStoredFlightSnapshot,
    };

    saga = new PaymentFulfillmentSaga(
      mockPaymentGateway as unknown as PaymentGatewayPort,
      mockFulfillmentGateway as unknown as FulfillmentGatewayPort,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockPaymentMethod as unknown as PaymentMethodService,
      mockBookingLifecycle as unknown as BookingLifecycleService,
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      mockFlightSearch,
      mockValidator as unknown as BookingPassengerFinalValidatorService,
      mockPublisher as unknown as BookingEventPublisherService,
    );
    saga.timeoutMs = 1000;
  });

  describe('nullable Stripe payment intent ID', () => {
    it('keeps confirmation pending without invoking provider gateways', async () => {
      currentPaymentState.stripePaymentIntentId = null;

      const result = await saga.executeConfirmPayment(dto, idempotencyKey, userId);

      expect(result).toEqual(expect.objectContaining({ status: 'PENDING' }));
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });
  });
  describe('rechecked payment Stripe ID', () => {
    it('keeps confirmation pending if the independently reloaded payment has no provider ID', async () => {
      mockPrisma.payment.findUnique
        .mockResolvedValueOnce({ ...basePayment })
        .mockResolvedValueOnce({
          ...basePayment,
          status: 'AUTHORIZED',
          stripePaymentIntentId: null,
        });

      const result = await saga.executeConfirmPayment(dto, idempotencyKey, userId);

      expect(result).toEqual(expect.objectContaining({ status: 'PENDING' }));
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });
  });
  describe('4-Stage Happy Path Pipeline', () => {
    it('normalizes the loaded raw snapshot and passes it in createBooking slot six', async () => {
      const rawOfferSnapshot = {
        slices: [{ segments: [{ id: 'seg_1' }] }],
      };
      const expectedSnapshot: FlightSnapshot = {
        segments: [
          {
            airline: { name: 'Delta Air Lines', iataCode: 'DL' },
            flightNumber: 'DL100',
            departureAirport: {
              iataCode: 'JFK',
              name: 'John F Kennedy Intl',
              city: 'New York',
            },
            arrivalAirport: {
              iataCode: 'LHR',
              name: 'London Heathrow',
              city: 'London',
            },
            departureAt: '2026-09-18T10:00:00Z',
            arrivalAt: '2026-09-18T18:00:00Z',
            duration: 'PT8H',
            supplierSegmentId: 'seg_1',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT8H',
        stops: 0,
        cabinClass: 'economy',
      };
      normalizeStoredFlightSnapshot.mockReturnValue(expectedSnapshot);
      currentPaymentState.bookingIntent = { ...baseBookingIntent, rawOfferSnapshot };

      await saga.confirmPayment(dto, idempotencyKey, userId);

      expect(normalizeStoredFlightSnapshot).toHaveBeenCalledTimes(1);
      expect(normalizeStoredFlightSnapshot).toHaveBeenCalledWith(rawOfferSnapshot);
      expect(mockBookingLifecycle.createBooking).toHaveBeenCalledWith(
        userId,
        bookingId,
        'intent-123',
        paymentId,
        undefined,
        expectedSnapshot,
      );
      expect(mockFlightSearch.search).not.toHaveBeenCalled();
      expect(mockFlightSearch.getOfferById).not.toHaveBeenCalled();
    });

    it('executes all 4 stages sequentially, persisting checkpoints and completing key atomically', async () => {
      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockIdempotency.acquireOrReplay).toHaveBeenCalledWith(
        idempotencyKey,
        'hash-123',
        userId,
        '/api/bookings/payment/confirm',
      );

      expect(mockBookingLifecycle.createBooking).toHaveBeenCalledWith(
        userId,
        bookingId,
        'intent-123',
        paymentId,
        undefined,
        undefined,
      );

      expect(mockPaymentGateway.authorizeHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'stripe_authorized',
      );

      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'off-123',
          idempotencyKey,
          services: [
            { serviceId: 'seat-1', quantity: 1 },
            { serviceId: 'bag-1', quantity: 1 },
          ],
        }),
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );

      expect(mockPaymentGateway.capturePayment).toHaveBeenCalledWith(
        'pi-123',
        `${idempotencyKey}-stripe-capture`,
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );

      expect(mockFulfillmentGateway.retrieveOrderSnapshot).toHaveBeenCalledWith(
        'ord-123',
        expect.anything(),
        expect.any(Array),
        'ada@example.com',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalledWith(
        bookingId,
        'PNR123',
        'ord-123',
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        expect.anything(),
        expect.anything(),
      );
      expect(mockPrisma.ledgerEntry.createMany).toHaveBeenCalled();
      expect(mockPaymentMethod.saveMethod).toHaveBeenCalledWith(userId, 'cus-123', 'pi-123');
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          status: 'SUCCEEDED',
          bookingReference: 'PNR123',
          duffelOrderId: 'ord-123',
        }),
      );

      expect(result).toEqual({
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'ord-123',
      });
    });

    it('returns cached replay body when key has already been executed', async () => {
      mockIdempotency.acquireOrReplay.mockResolvedValueOnce({
        status: 'replay',
        responseCode: 200,
        responseBody: JSON.stringify({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
          replayed: true,
        }),
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect((result as Record<string, unknown>).replayed).toBe(true);
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if payment does not belong to the user', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        bookingIntent: { ...baseBookingIntent, userId: 'other-user' },
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        'You do not own this payment',
      );
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
    });
  });

  describe('25-Second Handoff & Background Execution Invariant', () => {
    it('returns 202 PENDING when execution exceeds timeoutMs, while continuing in background', async () => {
      saga.timeoutMs = 15;

      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({
          orderId: 'ord-slow',
          bookingReference: 'PNR-SLOW',
          evidence: { id: 'ord-slow', bookingReference: 'PNR-SLOW' },
        }), 60)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result).toEqual({
        status: 'PENDING',
        message: 'Booking is being confirmed. Please poll status.',
        pollUrl: `/api/bookings/payment/${paymentId}/status`,
      });

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockPaymentGateway.capturePayment).toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          status: 'SUCCEEDED',
        }),
      );
    });

    it('invokes handleBackgroundError when background confirmation rejects after handoff', async () => {
      saga.timeoutMs = 15;

      mockFulfillmentGateway.createOrder.mockImplementation(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error('Duffel network drop')), 40)),
      );

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('PENDING');

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
    });

    // Human approval 2026-10-02: use fake time to exercise the public 25-second handoff without waiting.
    it('retains the authorized hold and order checkpoint when cancellation is denied after the 25-second handoff', async () => {
      jest.useFakeTimers();
      try {
        saga.timeoutMs = 25_000;
        let signalCaptureStarted: (() => void) | undefined;
        let rejectCapture: (() => void) | undefined;
        const captureStarted = new Promise<void>((resolve) => {
          signalCaptureStarted = () => resolve();
        });
        let signalCancelAttempted: (() => void) | undefined;
        const cancelAttempted = new Promise<void>((resolve) => {
          signalCancelAttempted = () => resolve();
        });
        mockPaymentGateway.capturePayment.mockImplementationOnce(
          async (_id: string, _key: string, control?: PortInvocationControl) => {
            if (control?.beforeInvoke) await control.beforeInvoke();
            return new Promise<never>((_resolve, reject) => {
              rejectCapture = () => reject(new Error('Stripe capture unavailable'));
              signalCaptureStarted?.();
            });
          },
        );
        mockPaymentGateway.authorizeHold
          .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
          .mockRejectedValueOnce(new Error('Stripe reconciliation unavailable'))
          .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
        mockFulfillmentGateway.cancelOrder.mockImplementationOnce(
          async (_id: string, control?: PortInvocationControl) => {
            if (control?.beforeInvoke) await control.beforeInvoke();
            signalCancelAttempted?.();
            throw new HttpException(
              {
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfterSeconds: 3600,
                resetAt: '2026-10-03T00:00:00.000Z',
              },
              HttpStatus.TOO_MANY_REQUESTS,
            );
          },
        );

        const confirmResult = saga.confirmPayment(dto, idempotencyKey, userId);
        await captureStarted;
        await jest.advanceTimersByTimeAsync(25_000);
        const result = await confirmResult;
        expect(result).toEqual(expect.objectContaining({ status: 'PENDING' }));
        if (!rejectCapture) throw new Error('Capture was not held for the handoff');
        rejectCapture();
        await cancelAttempted;
        await Promise.resolve();
        await Promise.resolve();

        expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledTimes(1);
        expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
        expect(currentPaymentState.status).toBe('AUTHORIZED');
        expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              eventType: 'duffel_order_created',
              metadata: expect.objectContaining({ id: 'ord-123' }),
            }),
          }),
        );
        expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
        expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
          expect.objectContaining({ key: idempotencyKey }),
          'duffel_order_created',
        );
        expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
    it.each([
      { name: 'success is false', success: false, status: 'CANCELLED' },
      { name: 'status is PENDING', success: true, status: 'PENDING' },
    ])('keeps the background hold when cancellation returns $name', async ({ success, status }) => {
      jest.useFakeTimers();
      try {
        saga.timeoutMs = 25_000;
        let signalCaptureStarted: (() => void) | undefined;
        let rejectCapture: (() => void) | undefined;
        const captureStarted = new Promise<void>((resolve) => {
          signalCaptureStarted = () => resolve();
        });
        let signalCancelAttempted: (() => void) | undefined;
        const cancelAttempted = new Promise<void>((resolve) => {
          signalCancelAttempted = () => resolve();
        });
        mockPaymentGateway.capturePayment.mockImplementationOnce(
          async (_id: string, _key: string, control?: PortInvocationControl) => {
            if (control?.beforeInvoke) await control.beforeInvoke();
            return new Promise<never>((_resolve, reject) => {
              rejectCapture = () => reject(new Error('Stripe capture unavailable'));
              signalCaptureStarted?.();
            });
          },
        );
        mockPaymentGateway.authorizeHold
          .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
          .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
          .mockResolvedValue({ status: 'authorized', intentId: 'pi-123' });
        mockFulfillmentGateway.cancelOrder.mockImplementation(
          async (_id: string, control?: PortInvocationControl) => {
            if (control?.beforeInvoke) await control.beforeInvoke();
            signalCancelAttempted?.();
            return { success, orderId: 'ord-123', status };
          },
        );

        const confirmResult = saga.confirmPayment(dto, idempotencyKey, userId);
        await captureStarted;
        await jest.advanceTimersByTimeAsync(25_000);
        const result = await confirmResult;
        expect(result).toEqual(expect.objectContaining({ status: 'PENDING' }));
        if (!rejectCapture) throw new Error('Capture was not held for the handoff');
        rejectCapture();
        await cancelAttempted;
        await jest.advanceTimersByTimeAsync(0);
        for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

        expect(mockPaymentGateway.authorizeHold).toHaveBeenCalledTimes(3);
        expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledTimes(2);
        expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
        expect(currentPaymentState.status).toBe('AUTHORIZED');
        expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
        expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('Fenced Ownership Assertion & Preflight Checks', () => {
    it('halts immediately if assertOwned rejects before paymentGateway.authorizeHold', async () => {
      mockPaymentGateway.authorizeHold.mockImplementation(
        async (_id: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { status: 'authorized', intentId: 'pi-123' };
        },
      );
      mockIdempotency.assertOwned.mockRejectedValueOnce(
        new ConflictException('Idempotency key ownership lost'),
      );

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('halts immediately without DB update if assertOwned rejects after authorizeHold', async () => {
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Preflight in authorizeHold
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Post-provider check

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects before fulfillmentGateway.createOrder without compensating', async () => {
      mockFulfillmentGateway.createOrder.mockImplementation(
        async (_input: unknown, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { orderId: 'ord-123', bookingReference: 'PNR', evidence: { id: 'ord-123' } };
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Stage 1 preflight
        .mockResolvedValueOnce(undefined) // Stage 1 post-provider
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Stage 2 preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
    });

    it('halts immediately without event creation if assertOwned rejects after fulfillmentGateway.createOrder', async () => {
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // Stage 1 preflight
        .mockResolvedValueOnce(undefined) // Stage 1 post-provider
        .mockResolvedValueOnce(undefined) // Stage 2 preflight
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // Stage 2 post-provider

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects before paymentGateway.capturePayment without destructive cancellation', async () => {
      mockPaymentGateway.capturePayment.mockImplementation(
        async (_id: string, _key: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { success: true, intentId: 'pi-123', status: 'succeeded' };
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold preflight
        .mockResolvedValueOnce(undefined) // authorizeHold post-provider
        .mockResolvedValueOnce(undefined) // createOrder preflight
        .mockResolvedValueOnce(undefined) // createOrder post-provider
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // capturePayment preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('halts immediately if assertOwned rejects during compensation', async () => {
      mockFulfillmentGateway.createOrder.mockImplementationOnce(
        async (_input: unknown, control: PortInvocationControl) => {
          await control.beforeInvoke();
          throw new Error('Airline rejected request');
        },
      );
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // authorizeHold preflight
        .mockResolvedValueOnce(undefined) // authorizeHold post-provider
        .mockResolvedValueOnce(undefined) // createOrder preflight
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // voidHold compensation preflight

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );
    });

    it('rejects with ConflictException if payment status is no longer CREATED when transitioning to AUTHORIZED', async () => {
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });
      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        new ConflictException(
          'Payment pay-123 status is no longer CREATED; cannot transition to AUTHORIZED',
        ),
      );

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalledWith(
        expect.anything(),
        'stripe_authorized',
      );
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });

    it('rejects with ConflictException if payment status is no longer AUTHORIZED before recording duffel_order_created', async () => {
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });
      mockFulfillmentGateway.createOrder.mockResolvedValueOnce({
        orderId: 'ord-123',
        bookingReference: 'PNR123',
        evidence: { id: 'ord-123' },
      });
      mockPrisma.payment.findUnique
        .mockResolvedValueOnce({ ...basePayment, status: 'CREATED' })
        .mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' })
        .mockResolvedValueOnce({ ...basePayment, status: 'CANCELLED' });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        ConflictException,
      );

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalledWith(
        expect.anything(),
        'duffel_order_created',
      );
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
    });

    it('rejects with BadRequestException if Stripe PaymentIntent is in invalid status on hold', async () => {
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'cancelled',
        rawStatus: 'canceled',
        intentId: 'pi-123',
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        new BadRequestException('Stripe PaymentIntent is in invalid status: canceled'),
      );

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
    });
  });

  describe('Redacted Evidence Storage in Payment Events', () => {
    it('persists fulfillment gateway evidence unchanged in duffel_order_created payment event metadata', async () => {
      const orderEvidence: PersistedOrderEvidence = {
        id: 'ord-123',
        bookingReference: 'PNR123',
        passengers: [
          {
            id: 'pas_1',
            type: 'adult',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
            born_on: 'REDACTED',
            email: 'REDACTED',
            phone_number: 'REDACTED',
          },
        ],
      };

      mockFulfillmentGateway.createOrder.mockResolvedValueOnce({
        orderId: 'ord-123',
        bookingReference: 'PNR123',
        evidence: orderEvidence,
      });

      await saga.confirmPayment(dto, idempotencyKey, userId);

      const duffelOrderCreatedCall = mockPrisma.paymentEvent.create.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as { data?: { eventType?: string } } | undefined;
          return arg?.data?.eventType === 'duffel_order_created';
        },
      );

      expect(duffelOrderCreatedCall).toBeDefined();
      const metadata = (duffelOrderCreatedCall![0] as { data: { metadata: unknown } }).data.metadata;
      expect(metadata).toEqual(orderEvidence);
    });
  });

  describe('BookingPassengerFinalValidatorService', () => {
    it('valid passenger snapshot passes validation and allows fulfillmentGateway.createOrder() to proceed', async () => {
      const ephemeralDto = [
        {
          id: 'p-1',
          givenName: 'Ada',
          familyName: 'Lovelace',
          bornOn: '1990-01-01',
          gender: 'female',
          title: 'ms',
          email: 'ada@example.com',
          phoneNumber: '+15551234567',
        },
      ];
      mockValidator.validateAndMapPassengers.mockReturnValue(ephemeralDto);

      await saga.confirmPayment(dto, idempotencyKey, userId, {
        traceId: 'trace-123',
        correlationId: 'corr-123',
      });

      expect(mockValidator.validateAndMapPassengers).toHaveBeenCalledTimes(1);
      expect(mockValidator.validateAndMapPassengers).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'intent-123' }),
        { traceId: 'trace-123', correlationId: 'corr-123' },
      );

      expect(mockAudit.createLog).toHaveBeenCalledWith(
        mockPrisma,
        expect.objectContaining({
          userId,
          action: 'final_passenger_validation_succeeded',
          resourceType: 'BookingIntent',
          resourceId: 'intent-123',
          metadata: expect.objectContaining({
            paymentId,
            passengerCount: 1,
          }),
          traceId: 'trace-123',
          correlationId: 'corr-123',
        }),
      );

      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledTimes(1);
      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'off-123',
          passengers: ephemeralDto,
          metadata: { bookingIntentId: 'intent-123', paymentId },
          idempotencyKey,
        }),
        expect.anything(),
      );

      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
    });

    it('invalid passenger snapshot (SNAPSHOT_INTEGRITY_FAILURE) prevents createOrder, voids Stripe hold, cancels payment, and logs safe audit', async () => {
      mockValidator.validateAndMapPassengers.mockImplementation(() => {
        throw new UnprocessableEntityException({
          code: 'SNAPSHOT_INTEGRITY_FAILURE',
          message: 'Passenger snapshot integrity failure',
        });
      });

      await expect(
        saga.confirmPayment(dto, idempotencyKey, userId, {
          traceId: 'trace-fail',
          correlationId: 'corr-fail',
        }),
      ).rejects.toThrow(HttpException);

      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith('pi-123', expect.anything());

      expect(mockPrisma.payment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: paymentId },
          data: { status: 'CANCELLED' },
        }),
      );
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            paymentId,
            eventType: 'payment_cancelled',
            newStatus: 'CANCELLED',
          }),
        }),
      );

      expect(mockPrisma.bookingIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intent-123' },
          data: { status: 'AWAITING_PAYMENT' },
        }),
      );

      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        mockPrisma,
        expect.anything(),
      );

      expect(mockAudit.createLog).toHaveBeenCalledWith(
        mockPrisma,
        expect.objectContaining({
          userId,
          action: 'final_passenger_validation_failed',
          resourceType: 'BookingIntent',
          resourceId: 'intent-123',
          metadata: expect.objectContaining({
            reasonCode: 'SNAPSHOT_INTEGRITY_FAILURE',
            intentId: 'intent-123',
            paymentId,
            passengerCount: 1,
          }),
          traceId: 'trace-fail',
          correlationId: 'corr-fail',
        }),
      );

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        expect.objectContaining({
          success: false,
          code: 'SNAPSHOT_INTEGRITY_FAILURE',
          bookingStatus: 'AWAITING_PAYMENT',
        }),
      );
    });

    it('invalid passenger snapshot (DOCUMENT_EXPIRED) with exhausted attempts cancels booking intent', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        ...baseBookingIntent,
        paymentAttemptCount: 2,
      });

      mockValidator.validateAndMapPassengers.mockImplementation(() => {
        throw new UnprocessableEntityException({
          code: 'DOCUMENT_EXPIRED',
          message: 'Travel document has expired',
        });
      });

      await expect(
        saga.confirmPayment(dto, idempotencyKey, userId),
      ).rejects.toThrow(HttpException);

      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith('pi-123', expect.anything());

      expect(mockPrisma.bookingIntent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'intent-123' },
          data: { status: 'CANCELLED' },
        }),
      );

      expect(mockAudit.createLog).toHaveBeenCalledWith(
        mockPrisma,
        expect.objectContaining({
          action: 'final_passenger_validation_failed',
          metadata: expect.objectContaining({
            reasonCode: 'DOCUMENT_EXPIRED',
          }),
        }),
      );

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        expect.objectContaining({
          success: false,
          code: 'DOCUMENT_EXPIRED',
          bookingStatus: 'CANCELLED',
        }),
      );
    });

    it('offer expired failure (OFFER_EXPIRED 409) completes key with 409 status and voids Stripe hold', async () => {
      mockValidator.validateAndMapPassengers.mockImplementation(() => {
        throw new HttpException(
          { code: 'OFFER_EXPIRED', message: 'Flight offer has expired' },
          HttpStatus.CONFLICT,
        );
      });

      await expect(
        saga.confirmPayment(dto, idempotencyKey, userId),
      ).rejects.toThrow(HttpException);

      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith('pi-123', expect.anything());

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.CONFLICT,
        expect.objectContaining({
          success: false,
          code: 'OFFER_EXPIRED',
        }),
      );
    });

    it('fallback when bookingPassengerFinalValidator is not injected', async () => {
      const fallbackSaga = new PaymentFulfillmentSaga(
        mockPaymentGateway as unknown as PaymentGatewayPort,
        mockFulfillmentGateway as unknown as FulfillmentGatewayPort,
        mockIdempotency as unknown as PaymentIdempotencyService,
        mockPaymentMethod as unknown as PaymentMethodService,
        mockBookingLifecycle as unknown as BookingLifecycleService,
        mockPrisma as unknown as PrismaService,
        mockAudit as unknown as AuditService,
        mockFlightSearch,
      );
      fallbackSaga.timeoutMs = 1000;

      await fallbackSaga.confirmPayment(dto, idempotencyKey, userId);

      expect(mockFulfillmentGateway.createOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          offerId: 'off-123',
          passengers: expect.arrayContaining([
            expect.objectContaining({ givenName: 'Ada', familyName: 'Lovelace' }),
          ]),
          idempotencyKey,
        }),
        expect.anything(),
      );
    });
  });

  describe('Compensation Matrix', () => {
    it('compensates via voidHold and marks booking FAILED when final passenger validation throws', async () => {
      mockValidator.validateAndMapPassengers.mockImplementationOnce(() => {
        throw new UnprocessableEntityException('Passenger passport expired');
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.UNPROCESSABLE_ENTITY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Passenger passport expired'),
        }),
      );
    });

    it('compensates via voidHold and marks booking FAILED when Duffel order creation fails', async () => {
      mockFulfillmentGateway.createOrder.mockRejectedValueOnce(new Error('Seats unavailable'));

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.SYSTEM_ERROR,
        undefined,
        undefined,
        undefined,
        expect.anything(),
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Seats unavailable'),
        }),
      );
    });

    it('compensates when capturePayment returns success: false with requires_capture status without throwing', async () => {
      mockPaymentGateway.capturePayment.mockResolvedValueOnce({
        success: false,
        intentId: 'pi-123',
        status: 'requires_capture',
      });
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(HttpException);

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith('ord-123', expect.any(Object));
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith('pi-123', expect.any(Object));
      expect(mockPrisma.payment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalled();
    });

    it('compensates via cancelOrder and voidHold when capture fails and reconciles to authorized/requires_capture', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalledWith(
        bookingId,
        BookingFailureReason.CAPTURE_FAILED,
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        baseSnapshots.departureAt,
        expect.anything(),
        expect.anything(),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Card declined on capture'),
        }),
      );
    });

    it('retains the authorized hold and checkpoint when nested order evidence cancellation is pending', async (): Promise<void> => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123', rawStatus: 'requires_capture' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { data: { id: 'ord-nested' } },
      });
      mockFulfillmentGateway.cancelOrder.mockResolvedValueOnce({
        success: true,
        orderId: 'ord-nested',
        status: 'PENDING',
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-nested', expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when inline order evidence has no usable ID', async (): Promise<void> => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123', rawStatus: 'requires_capture' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: {},
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when inline order evidence has an empty ID', async (): Promise<void> => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123', rawStatus: 'requires_capture' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: '   ' },
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when inline order evidence has a malformed ID', async (): Promise<void> => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123', rawStatus: 'requires_capture' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: 123, data: null },
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains the authorized hold, order evidence, and retryable checkpoint when cancellation is denied after capture failure', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
          rawStatus: 'requires_capture',
        });
      mockFulfillmentGateway.cancelOrder.mockRejectedValueOnce(
        new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterSeconds: 3600,
            resetAt: '2026-10-03T00:00:00.000Z',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        ),
      );

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith('ord-123', expect.any(Object));
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            eventType: 'duffel_order_created',
            metadata: expect.objectContaining({ id: 'ord-123' }),
          }),
        }),
      );
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'payment_cancelled' }),
        }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it.each([
      { name: 'success is false', success: false, status: 'CANCELLED' },
      { name: 'status is PENDING', success: true, status: 'PENDING' },
    ])('retains recoverable state when cancellation returns $name', async ({ success, status }) => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Card declined on capture'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' })
        .mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockFulfillmentGateway.cancelOrder.mockResolvedValueOnce({
        success,
        orderId: 'ord-123',
        status,
      });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toMatchObject({
        response: expect.objectContaining({ bookingStatus: 'PROCESSING' }),
      });

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledTimes(1);
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockPrisma.paymentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'duffel_order_created' }),
        }),
      );
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'payment_cancelled' }),
        }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'duffel_order_created',
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('aborts compensation cleanly and returns SUCCEEDED if payment was already completed as SUCCEEDED before compensation transaction in executeConfirmPayment', async () => {
      mockPaymentGateway.capturePayment.mockImplementationOnce(async () => {
        // Parallel execution takes over and completes payment to SUCCEEDED
        mockPrisma.payment.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
        currentPaymentState.status = 'SUCCEEDED';
        mockPrisma.payment.findUnique.mockResolvedValueOnce({
          ...basePayment,
          status: 'SUCCEEDED',
        });
        throw new Error('Stripe transient capture failure');
      });
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect(result.success).toBe(true);
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
        }),
      );
    });

    it('skips cancellation compensation and throws BAD_GATEWAY if payment is in non-cancellable status (e.g. FAILED) in executeConfirmPayment', async () => {
      mockPaymentGateway.capturePayment.mockImplementationOnce(async () => {
        // Parallel execution or another process moved payment to FAILED
        mockPrisma.payment.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
        currentPaymentState.status = 'FAILED';
        mockPrisma.payment.findUnique.mockResolvedValueOnce({
          ...basePayment,
          status: 'FAILED',
        });
        throw new Error('Stripe transient capture failure');
      });
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'payment_cancelled' }),
        }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Stripe capture failed'),
        }),
      );
    });

    it('builds failureResponse bookingStatus from freshly loaded bookingIntent status (e.g. PAYMENT_EXHAUSTED) in executeConfirmPayment', async () => {
      mockPaymentGateway.capturePayment.mockImplementationOnce(async () => {
        mockPrisma.payment.updateMany.mockImplementationOnce(async () => ({ count: 0 }));
        currentPaymentState.status = 'EXPIRED';
        mockPrisma.payment.findUnique.mockResolvedValueOnce({
          ...basePayment,
          status: 'EXPIRED',
        });
        mockPrisma.bookingIntent.findUnique.mockImplementation(async () => ({
          ...baseBookingIntent,
          status: 'PAYMENT_EXHAUSTED',
        }));
        throw new Error('Stripe transient capture failure');
      });
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          bookingStatus: 'PAYMENT_EXHAUSTED',
        }),
      );
    });

    it('does NOT compensate if capture fails but reconciles to captured/succeeded (continues to Stage 4)', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Network disconnect on return'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'captured',
          intentId: 'pi-123',
          rawStatus: 'succeeded',
        });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );
      expect(result.status).toBe('SUCCEEDED');
    });

    it('throws 502 without destructive compensation if capture reconciliation is nonfinal or unavailable', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Stripe 500'));
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockResolvedValueOnce({
          status: 'nonfinal',
          intentId: 'pi-123',
          rawStatus: 'processing',
        });

      await expect(saga.confirmPayment(dto, idempotencyKey, userId)).rejects.toThrow(
        HttpException,
      );

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
    });

    it('retains recoverable PROCESSING state without releasing holds prematurely against active upstream order when capture fails and reconciliation throws', async () => {
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(
        new Error('Network timeout during capture'),
      );
      mockPaymentGateway.authorizeHold
        .mockResolvedValueOnce({
          status: 'authorized',
          intentId: 'pi-123',
        })
        .mockRejectedValueOnce(new Error('Stripe API unreachable during capture reconciliation'));

      const error = await saga
        .confirmPayment(dto, idempotencyKey, userId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      const response = httpError.getResponse() as Record<string, unknown>;
      expect(response.bookingStatus).toBe('PROCESSING');
      expect(response.success).toBe(false);
      expect(response.error).toContain('Stripe capture outcome is unknown');

      // Crucial: Active upstream order must NOT be cancelled
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      // Crucial: Payment hold must NOT be voided prematurely
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      // Crucial: Payment must NOT transition to CANCELLED
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      // Crucial: Booking must NOT transition to FAILED
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      // Crucial: Saga key must NOT be finalized as failed, allowing retry
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable PROCESSING state on replay when resuming from duffel_order_created and capture fails with unknown reconciliation', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('duffel_order_created');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.capturePayment.mockRejectedValueOnce(new Error('Stripe capture 500'));
      mockPaymentGateway.authorizeHold.mockRejectedValueOnce(
        new Error('Stripe reconciliation timeout'),
      );

      const error = await saga
        .confirmPayment(dto, idempotencyKey, userId)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      const response = httpError.getResponse() as Record<string, unknown>;
      expect(response.bookingStatus).toBe('PROCESSING');

      // Verify no premature release of hold or cancellation of order on replay
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });
  });

  describe('Nonfatal Payment Method Saving', () => {
    it('does not abort confirmPayment if paymentMethodService.saveMethod throws', async () => {
      mockPaymentMethod.saveMethod.mockRejectedValueOnce(new Error('Stripe Customer not found'));

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({ status: 'SUCCEEDED' }),
      );
    });

    it('syncs the payment method after a successful capture', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        stripeCustomerId: 'cus-123',
        stripePaymentIntentId: 'pi-123',
        status: 'AUTHORIZED',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce('captured');

      await saga.confirmPayment(dto, idempotencyKey, userId);

      expect(mockPaymentMethod.saveMethod).toHaveBeenCalledWith(
        userId,
        'cus-123',
        'pi-123',
      );
    });
  });

  describe('confirmPayment recoveryPoint === completed', () => {
    it('returns successResponse and completes key when payment.status is SUCCEEDED', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: {
          id: 'duffel-order-abc',
          booking_reference: 'PNR123',
        },
      });

      const response = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
          bookingReference: 'PNR123',
          duffelOrderId: 'duffel-order-abc',
        }),
      );

      expect(response).toEqual({
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'duffel-order-abc',
      });
    });

    it('throws InternalServerErrorException if payment is SUCCEEDED but duffel event metadata is missing', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce(null);

      await expect(
        saga.confirmPayment(dto, idempotencyKey, userId),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('returns failureResponse and completes key with BAD_GATEWAY if status is CANCELLED and duffel event exists', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'CANCELLED',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'duffel-order-abc' },
      });
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        ...baseBookingIntent,
        status: 'CANCELLED',
      });

      const response = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.',
          bookingStatus: 'CANCELLED',
        }),
      );

      expect(response).toEqual({
        success: false,
        error: 'Stripe capture failed or background processing failed. Duffel order cancelled and hold released.',
        bookingStatus: 'CANCELLED',
      });
    });

    it('returns failureResponse and completes key with BAD_GATEWAY if status is CANCELLED and duffel event does not exist', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'CANCELLED',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce(null);
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        ...baseBookingIntent,
        status: 'AWAITING_PAYMENT',
      });

      const response = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: 'Duffel booking failed. Payment hold released.',
          bookingStatus: 'AWAITING_PAYMENT',
        }),
      );

      expect(response).toEqual({
        success: false,
        error: 'Duffel booking failed. Payment hold released.',
        bookingStatus: 'AWAITING_PAYMENT',
      });
    });
  });

  describe('Checkpoint Resume Capabilities', () => {
    it('skips Stage 1 and Stage 2 when resuming from captured', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('captured');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.capturePayment).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalled();
      expect(result.status).toBe('SUCCEEDED');
    });

    it('returns reconstructed success response when recoveryPoint is completed and payment is SUCCEEDED', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('completed');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result).toEqual({
        success: true,
        paymentId,
        status: 'SUCCEEDED',
        bookingReference: 'PNR123',
        duffelOrderId: 'ord-123',
      });
      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
    });

    it('resumes safely from duffel_order_created checkpoint without duplicate order creation and completes on successful capture', async () => {
      mockIdempotency.getResumePoint.mockResolvedValueOnce('duffel_order_created');
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.capturePayment.mockResolvedValueOnce({
        success: true,
        intentId: 'pi-123',
        status: 'succeeded',
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.createOrder).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'duffel_order_created' }),
        }),
      );
      expect(mockPaymentGateway.capturePayment).toHaveBeenCalledWith(
        'pi-123',
        `${idempotencyKey}-stripe-capture`,
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(
        expect.objectContaining({ key: idempotencyKey }),
        'captured',
      );
      expect(mockFulfillmentGateway.retrieveOrderSnapshot).toHaveBeenCalledWith(
        'ord-123',
        expect.anything(),
        expect.anything(),
        'ada@example.com',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToConfirmed).toHaveBeenCalled();
      expect(result.status).toBe('SUCCEEDED');
    });
  });

  describe('handleBackgroundError', () => {
    const ownership: SagaOwnership = {
      key: idempotencyKey,
      userId,
      requestPath: '/api/bookings/payment/confirm',
      requestHash: 'hash-123',
      lockedAt: new Date('2026-09-16T12:00:00Z'),
    };

    it('returns early if payment is already in terminal state', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('error'));

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
    });

    it('returns pending without provider or compensation calls when the reloaded payment has no Stripe ID', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
        stripePaymentIntentId: null,
      });

      await saga.handleBackgroundError(
        paymentId,
        idempotencyKey,
        userId,
        ownership,
        new Error('background crash'),
      );

      expect(mockPaymentGateway.authorizeHold).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
    });
    it('when Stripe retrieval returns status === succeeded, logs/updates recovery point to captured, returns early, and does NOT compensate', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'captured',
        intentId: 'pi-123',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce(null);

      await saga.handleBackgroundError(
        paymentId,
        idempotencyKey,
        userId,
        ownership,
        new Error('Some background error'),
      );

      expect(mockIdempotency.advanceSagaCheckpoint).toHaveBeenCalledWith(ownership, 'captured');
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('retains the authorized hold when background cancellation uses nested order evidence and is pending', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { data: { id: 'ord-nested' } },
      });
      mockFulfillmentGateway.cancelOrder.mockResolvedValueOnce({
        success: true,
        orderId: 'ord-nested',
        status: 'PENDING',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-nested', expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'payment_cancelled' }) }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when background order evidence has no usable ID', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: {},
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockPrisma.paymentEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ eventType: 'duffel_order_created' }) }),
      );
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookingIntent.update).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ eventType: 'payment_cancelled' }) }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when background order evidence has an empty ID', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: '   ' },
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookingIntent.update).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when background order evidence has a malformed ID', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: 123, data: null },
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.bookingIntent.update).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when background cancellation is denied by the Duffel budget', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: 'ord-123' },
      });
      mockFulfillmentGateway.cancelOrder.mockRejectedValueOnce(
        new HttpException({ code: 'BUDGET_UNAVAILABLE' }, HttpStatus.SERVICE_UNAVAILABLE),
      );

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123', expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('retains recoverable state when background cancellation times out over the network', async (): Promise<void> => {
      currentPaymentState.status = 'AUTHORIZED';
      mockPrisma.payment.findUnique.mockResolvedValueOnce({ ...basePayment, status: 'AUTHORIZED' });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({ status: 'authorized', intentId: 'pi-123' });
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        id: 'event-1',
        eventType: 'duffel_order_created',
        metadata: { id: 'ord-123' },
      });
      mockFulfillmentGateway.cancelOrder.mockRejectedValueOnce(new Error('Duffel network timeout'));

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123', expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(currentPaymentState.status).toBe('AUTHORIZED');
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });

    it('when Stripe retrieval returns status !== succeeded, continues compensation', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });
      mockIdempotency.getResumePoint.mockResolvedValueOnce(null);
      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'ord-123' },
      });
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        ...baseBookingIntent,
        paymentAttemptCount: 1,
      });

      await saga.handleBackgroundError(
        paymentId,
        idempotencyKey,
        userId,
        ownership,
        new Error('Some background error'),
      );

      expect(mockIdempotency.advanceSagaCheckpoint).not.toHaveBeenCalledWith(ownership, 'captured');
      expect(mockFulfillmentGateway.cancelOrder).toHaveBeenCalledWith(
        'ord-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockPaymentGateway.voidHold).toHaveBeenCalledWith(
        'pi-123',
        expect.objectContaining({ beforeInvoke: expect.any(Function) }),
      );
      expect(mockBookingLifecycle.updateToFailed).toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        ownership,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Some background error'),
        }),
      );
    });

    it('when Stripe retrieval fails (throws), it logs the error and returns early (recoverable)', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockRejectedValueOnce(new Error('Stripe API error'));

      await saga.handleBackgroundError(
        paymentId,
        idempotencyKey,
        userId,
        ownership,
        new Error('Some background error'),
      );

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
    });

    it('halts without action if assertOwned rejects during background recovery', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockImplementation(
        async (_id: string, control: PortInvocationControl) => {
          await control.beforeInvoke();
          return { status: 'authorized', intentId: 'pi-123' };
        },
      );
      mockIdempotency.assertOwned.mockRejectedValueOnce(
        new ConflictException('Idempotency key ownership lost'),
      );

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
    });

    it('terminalizes the owned key without updating booking to FAILED if payment is already SUCCEEDED in handleBackgroundError', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });

      // Payment was completed in parallel, so updateMany returns 0
      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'SUCCEEDED',
      });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        ownership,
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          paymentId,
          status: 'SUCCEEDED',
        }),
      );
    });

    it('skips cancellation compensation and completes key with BAD_GATEWAY if payment is in non-cancellable status (e.g. FAILED) in handleBackgroundError', async () => {
      mockPrisma.payment.findUnique
        .mockResolvedValueOnce({
          ...basePayment,
          status: 'AUTHORIZED',
        })
        .mockResolvedValueOnce({
          ...basePayment,
          status: 'FAILED',
        });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });

      // Payment is now FAILED, updateMany returns 0
      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.paymentEvent.create).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'payment_cancelled' }),
        }),
      );
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        ownership,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('background crash'),
        }),
      );
    });

    it('builds background failure response bookingStatus from freshly loaded bookingIntent status (e.g. PAYMENT_EXHAUSTED) in handleBackgroundError', async () => {
      mockPrisma.payment.findUnique
        .mockResolvedValueOnce({
          ...basePayment,
          status: 'AUTHORIZED',
        })
        .mockResolvedValueOnce({
          ...basePayment,
          status: 'EXPIRED',
        });
      mockPrisma.bookingIntent.findUnique
        .mockResolvedValueOnce({
          ...baseBookingIntent,
          status: 'AWAITING_PAYMENT',
        })
        .mockResolvedValueOnce({
          ...baseBookingIntent,
          status: 'PAYMENT_EXHAUSTED',
        });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });

      mockPrisma.payment.updateMany.mockResolvedValueOnce({ count: 0 });

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        ownership,
        HttpStatus.BAD_GATEWAY,
        expect.objectContaining({
          success: false,
          bookingStatus: 'PAYMENT_EXHAUSTED',
        }),
      );
    });

    it('halts without action if assertOwned rejects immediately before compensation transaction in handleBackgroundError', async () => {
      mockPrisma.payment.findUnique.mockResolvedValueOnce({
        ...basePayment,
        status: 'AUTHORIZED',
      });
      mockPaymentGateway.authorizeHold.mockResolvedValueOnce({
        status: 'authorized',
        intentId: 'pi-123',
      });

      // assertOwned succeeds during pre-provider checks, but rejects right before DB compensation transaction
      mockIdempotency.assertOwned
        .mockResolvedValueOnce(undefined) // cancelOrder beforeInvoke
        .mockResolvedValueOnce(undefined) // voidHold beforeInvoke
        .mockRejectedValueOnce(new ConflictException('Idempotency key ownership lost')); // pre-transaction assertion

      await saga.handleBackgroundError(paymentId, idempotencyKey, userId, ownership, new Error('background crash'));

      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockPrisma.payment.updateMany).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).not.toHaveBeenCalled();
    });
  });

  describe('Saga Post-Commit Event Dispatch (T024)', () => {
    it('asserts publisher.publish is called with collected events only after outer transaction resolves', async () => {
      const executionOrder: string[] = [];
      mockPrisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
        executionOrder.push('transaction:start');
        const result = await callback(mockPrisma);
        executionOrder.push('transaction:commit');
        return result;
      });

      const mockEvent = {
        name: 'booking.confirmed',
        bookingId,
        eventId: 'evt-123',
        timestamp: new Date(),
      };

      mockBookingLifecycle.confirmBooking.mockImplementation(
        async (
          _id: string,
          _pnr: string,
          _orderId: string,
          _flight: unknown,
          _pass: unknown,
          _tx: unknown,
          eventContext?: { events: unknown[] },
        ) => {
          if (eventContext) {
            eventContext.events.push(mockEvent);
          }
          return mockBookingLifecycle.updateToConfirmed(
            _id,
            _pnr,
            _orderId,
            _flight,
            _pass,
            _tx,
            eventContext,
          );
        },
      );

      mockPublisher.publish.mockImplementation(async () => {
        executionOrder.push('publisher:publish');
      });

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect(mockBookingLifecycle.confirmBooking).toHaveBeenCalledWith(
        bookingId,
        'PNR123',
        'ord-123',
        baseSnapshots.flightSnapshot,
        baseSnapshots.passengerSnapshot,
        expect.anything(),
        expect.anything(),
      );
      expect(mockPublisher.publish).toHaveBeenCalledWith([mockEvent]);
      const txCommitIndex = executionOrder.lastIndexOf('transaction:commit');
      const publishIndex = executionOrder.indexOf('publisher:publish');
      expect(txCommitIndex).toBeGreaterThan(-1);
      expect(publishIndex).toBeGreaterThan(txCommitIndex);
    });

    it('proves that if publisher.publish rejects or throws an error, payment confirmation still succeeds and does NOT trigger compensation', async () => {
      const mockEvent = {
        name: 'booking.confirmed',
        bookingId,
        eventId: 'evt-123',
        timestamp: new Date(),
      };

      mockBookingLifecycle.confirmBooking.mockImplementation(
        async (
          _id: string,
          _pnr: string,
          _orderId: string,
          _flight: unknown,
          _pass: unknown,
          _tx: unknown,
          eventContext?: { events: unknown[] },
        ) => {
          if (eventContext) {
            eventContext.events.push(mockEvent);
          }
          return mockBookingLifecycle.updateToConfirmed(
            _id,
            _pnr,
            _orderId,
            _flight,
            _pass,
            _tx,
            eventContext,
          );
        },
      );

      mockPublisher.publish.mockRejectedValue(new Error('Event bus dispatch failure'));

      const result = (await saga.confirmPayment(dto, idempotencyKey, userId)) as ConfirmPaymentResult;

      expect(result.status).toBe('SUCCEEDED');
      expect(mockPublisher.publish).toHaveBeenCalledWith([mockEvent]);
      expect(mockPaymentGateway.voidHold).not.toHaveBeenCalled();
      expect(mockFulfillmentGateway.cancelOrder).not.toHaveBeenCalled();
      expect(mockBookingLifecycle.updateToFailed).not.toHaveBeenCalled();
      expect(mockIdempotency.completeSagaKeyAtomic).toHaveBeenCalledWith(
        expect.anything(),
        HttpStatus.OK,
        expect.objectContaining({
          success: true,
          status: 'SUCCEEDED',
        }),
      );
    });
  });
});
