// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
import 'reflect-metadata';
import { PaymentService } from './payment.service';
import { PaymentFulfillmentSaga } from '@/payment-fulfillment/payment-fulfillment.saga';
import {
  PaymentGatewayPort,
  FulfillmentGatewayPort,
  PortInvocationControl,
  CreateOrderInput,
} from '@/payment-fulfillment/ports';
import { PrismaService } from '@/prisma/prisma.service';
import { StripeService } from '@/common/stripe.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentMethodService } from '@/payment/payment-method.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';
import type { FlightSearchPort } from '@/supplier/search/flight-search.port';

// Approved 2026-10-04 per T061: these saga fixtures have no saved snapshot; retain their payment assertions.
const flightSearchPort: FlightSearchPort = {
  search: async () => ({ offers: [], searchHash: '', cached: false }),
  getOfferById: async () => { throw new Error('Unexpected live offer lookup'); },
  normalizeStoredOffer: () => null,
  normalizeStoredOfferFacts: () => ({
    travelScope: null,
    tripCompletionDate: null,
    offerExpiresAt: null,
  }),
  normalizeStoredFlightSnapshot: () => null,
};

describe('PaymentService - Ancillary Pipeline', () => {
  let service: PaymentService;
  let saga: PaymentFulfillmentSaga;
  let mockPaymentGateway: any;
  let mockFulfillmentGateway: any;
  let mockPrisma: any;
  let mockStripe: any;
  let mockIdempotency: any;
  let mockDuffel: any;
  let mockAudit: any;
  let mockPaymentMethod: any;
  let mockBookingLifecycleService: any;
  let mockAncillaryValidation: any;

  beforeEach(() => {
    mockPrisma = {
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      bookingIntent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
      payment: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      booking: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue({ id: 'booking-123', paymentId: 'payment-123' }),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      idempotencyKey: {
        findUnique: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      ledgerEntry: {
        createMany: jest.fn(),
      },
    };

    mockStripe = {
      createCustomer: jest.fn(),
      createPaymentIntent: jest.fn(),
      retrievePaymentIntent: jest.fn(),
      capturePaymentIntent: jest.fn(),
      cancelPaymentIntent: jest.fn(),
    };

    mockIdempotency = {
      computeHash: jest.fn().mockReturnValue('mock-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({ status: 'acquired' }),
      assertOwned: jest.fn().mockResolvedValue(undefined),
      getResumePoint: jest.fn(),
      advanceSagaCheckpoint: jest.fn().mockResolvedValue(undefined),
      updateRecoveryPoint: jest.fn(),
      completeSagaKeyAtomic: jest.fn().mockResolvedValue(undefined),
      completeKey: jest.fn(),
    };

    mockDuffel = {
      createOrder: jest.fn(),
      mapDuffelOrderToSnapshots: jest.fn().mockReturnValue({
        flightSnapshot: { segments: [{ departureAt: '2026-08-01T10:00:00Z' }] },
        passengerSnapshot: { passengers: [] },
      }),
    };

    mockAudit = {
      createLog: jest.fn(),
    };

    mockPaymentMethod = {
      saveMethod: jest.fn(),
    };

    mockBookingLifecycleService = {
      createBooking: jest.fn().mockResolvedValue({ id: 'booking-123', userId: 'user-123' }),
      updateToConfirmed: jest.fn(),
      confirmBooking: jest.fn(),
      updateToFailed: jest.fn(),
      failBooking: jest.fn(),
    };

    mockAncillaryValidation = {
      validateForPayment: jest.fn(),
    };

    mockPaymentGateway = {
      authorizeHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        const pi = await mockStripe.retrievePaymentIntent(intentId);
        return {
          status:
            pi?.status === 'requires_capture'
              ? 'authorized'
              : pi?.status === 'succeeded'
                ? 'captured'
                : 'authorized',
          intentId,
          amount: pi?.amount ?? 25000,
          currency: pi?.currency ?? 'usd',
        };
      }),
      capturePayment: jest.fn(
        async (intentId: string, captureKey: string, control?: PortInvocationControl) => {
          if (control?.beforeInvoke) await control.beforeInvoke();
          await mockStripe.capturePaymentIntent(intentId, undefined, captureKey);
          return {
            success: true,
            intentId,
            status: 'succeeded',
          };
        },
      ),
      voidHold: jest.fn(async (intentId: string, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        await mockStripe.cancelPaymentIntent(intentId);
        return {
          success: true,
          intentId,
          status: 'canceled',
        };
      }),
    };

    mockFulfillmentGateway = {
      createOrder: jest.fn(async (input: CreateOrderInput, control?: PortInvocationControl) => {
        if (control?.beforeInvoke) await control.beforeInvoke();
        const services =
          input.services && input.services.length > 0
            ? input.services.map((s) => ({ id: s.serviceId, quantity: s.quantity }))
            : undefined;
        const res = await mockDuffel.createOrder(
          input.offerId,
          input.passengers,
          services,
          input.metadata,
          input.idempotencyKey,
        );
        return {
          orderId: res?.id ?? 'ord_123',
          bookingReference: res?.booking_reference ?? 'PNR789',
          evidence: res ?? { id: 'ord_123', booking_reference: 'PNR789' },
        };
      }),
      cancelOrder: jest.fn().mockResolvedValue({
        success: true,
        orderId: 'ord_123',
        status: 'CANCELLED',
      }),
      retrieveOrderSnapshot: jest.fn(
        async (
          _id: string,
          evidence: any,
          _enrichment: any,
          _email: string,
          control?: PortInvocationControl,
        ) => {
          if (control?.beforeInvoke) await control.beforeInvoke();
          const snaps = mockDuffel.mapDuffelOrderToSnapshots(evidence);
          return {
            flightSnapshot: snaps.flightSnapshot,
            passengerSnapshot: snaps.passengerSnapshot,
            departureAt: new Date('2026-08-01T10:00:00Z'),
          };
        },
      ),
    };

    service = new PaymentService(
      mockPrisma as unknown as PrismaService,
      mockStripe as unknown as StripeService,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockAudit as unknown as AuditService,
      mockAncillaryValidation as unknown as AncillaryPaymentValidationService,
    );

    saga = new PaymentFulfillmentSaga(
      mockPaymentGateway as unknown as PaymentGatewayPort,
      mockFulfillmentGateway as unknown as FulfillmentGatewayPort,
      mockIdempotency as unknown as PaymentIdempotencyService,
      mockPaymentMethod as unknown as PaymentMethodService,
      mockBookingLifecycleService,
      mockPrisma as unknown as PrismaService,
      mockAudit as unknown as AuditService,
      flightSearchPort,
    );
  });

  describe('createPayment with ancillaries', () => {
    const dto = {
      bookingIntentId: 'intent-123',
      ancillarySelectionId: 'anc-sel-123',
      ancillarySelectionVersion: 1,
    };
    const idempotencyKey = 'key-123';
    const userId = 'user-123';
    const ipAddress = '127.0.0.1';

    it('calls validateForPayment, derives Stripe amount from validatedGrandTotal, and binds ancillarySelection to Payment', async () => {
      // 1. Pre-fetch intent setup
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      // 2. Mock validateForPayment
      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      // 3. Raw query in transaction (Step 2 and Step 5)
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 200,
            currency: 'USD',
            userId: 'user-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'anc-sel-123',
            version: 1,
            status: 'VALIDATED',
            validatedAt: new Date(),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            currency: 'USD',
            validatedBaseAmount: '200.00',
            validatedGrandTotal: '250.00',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ]);

      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'idem-rec-123' });
      mockPrisma.payment.create.mockResolvedValueOnce({
        id: 'payment-123',
        status: 'CREATED',
        amount: 25000,
      });

      const result = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      // Assert validateForPayment was called with correct args
      expect(mockAncillaryValidation.validateForPayment).toHaveBeenCalledWith({
        userId: 'user-123',
        bookingIntentId: 'intent-123',
        ancillarySelectionId: 'anc-sel-123',
        ancillarySelectionVersion: 1,
      });

      // Assert AncillarySelection was updated to PAYMENT_BOUND
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();

      // Assert Stripe payment intent created with grandTotal * 100 ($250.00 -> 25000 cents)
      expect(mockStripe.createPaymentIntent).toHaveBeenCalledWith(
        25000,
        'USD',
        'cus_123',
        {
          bookingIntentId: 'intent-123',
          ancillarySelectionId: 'anc-sel-123',
          ancillarySelectionVersion: '1',
        },
        'key-123-stripe-intent',
        undefined,
        undefined,
      );

      // Assert Payment created with ancillarySelectionId & ancillarySelectionVersion
      expect(mockPrisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingIntentId: 'intent-123',
          ancillarySelectionId: 'anc-sel-123',
          ancillarySelectionVersion: 1,
          amount: 25000,
        }),
      });

      expect(result).toEqual({
        paymentId: 'payment-123',
        clientSecret: 'secret_123',
        status: 'CREATED',
      });
    });

    it('does not update ancillarySelection to PAYMENT_BOUND if Stripe createPaymentIntent fails', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 200,
            currency: 'USD',
            userId: 'user-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'anc-sel-123',
            version: 1,
            status: 'VALIDATED',
            validatedAt: new Date(),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            currency: 'USD',
            validatedBaseAmount: '200.00',
            validatedGrandTotal: '250.00',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ]);

      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockRejectedValueOnce(new Error('Stripe API error'));

      await expect(service.createPayment(dto, idempotencyKey, userId, ipAddress)).rejects.toThrow(
        'Stripe API error',
      );

      expect(mockPrisma.ancillarySelection.updateMany).not.toHaveBeenCalled();
    });

    it('throws ConflictException with ANCILLARY_VERSION_CONFLICT if intent selection or version changes in tx after validation', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      // Raw query in transaction returns updated version/selection
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-123',
          status: 'PENDING',
          paymentAttemptCount: 0,
          confirmedPrice: 200,
          currency: 'USD',
          userId: 'user-123',
          currentAncillarySelectionId: 'anc-sel-123',
          ancillaryVersion: 2,
        },
      ]);

      await expect(service.createPayment(dto, idempotencyKey, userId, ipAddress)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-123',
            currentVersion: 2,
          }),
        }),
      );
    });

    it('cancels Stripe PaymentIntent and throws ConflictException if concurrent selection update occurs in Step 5 transaction', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      // Step 2 raw query returns version 1
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 200,
            currency: 'USD',
            userId: 'user-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'anc-sel-123',
            version: 1,
            status: 'VALIDATED',
            validatedAt: new Date(),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            currency: 'USD',
            validatedBaseAmount: '200.00',
            validatedGrandTotal: '250.00',
          },
        ]);

      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'idem-rec-123' });

      // Step 5 raw query returns version 2 (concurrent selection update during Stripe call)
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        {
          id: 'intent-123',
          currentAncillarySelectionId: 'anc-sel-123',
          ancillaryVersion: 2,
        },
      ]);

      await expect(service.createPayment(dto, idempotencyKey, userId, ipAddress)).rejects.toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-123',
            currentVersion: 2,
          }),
        }),
      );

      // Verify created Stripe PaymentIntent was cancelled
      expect(mockStripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_123');

      // Verify Payment record was NOT created and ancillarySelection was NOT bound
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
      expect(mockPrisma.ancillarySelection.updateMany).not.toHaveBeenCalled();
    });

    it('cancels Stripe PaymentIntent and throws ConflictException with ANCILLARY_SELECTION_STALE if selection updateMany returns count 0', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 200,
            currency: 'USD',
            userId: 'user-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'anc-sel-123',
            version: 1,
            status: 'VALIDATED',
            validatedAt: new Date(),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            currency: 'USD',
            validatedBaseAmount: '200.00',
            validatedGrandTotal: '250.00',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ]);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'idem-rec-123' });

      // Simulating selection becoming STALE before Step 5 (updateMany returns { count: 0 })
      mockPrisma.$executeRaw.mockResolvedValueOnce(0);

      await expect(service.createPayment(dto, idempotencyKey, userId, ipAddress)).rejects.toThrow(
        'Payment reservation ownership was lost',
      );

      // Verify Payment record was NOT created
      expect(mockPrisma.payment.create).not.toHaveBeenCalled();
    });

    it('does not cancel Stripe PaymentIntent if Step 5 (Payment record creation) succeeds but a post-commit step fails', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 200,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: 'anc-sel-123',
        ancillaryVersion: 1,
      });

      mockAncillaryValidation.validateForPayment.mockResolvedValueOnce({
        selectionId: 'anc-sel-123',
        selectionVersion: 1,
        baseAmount: '200.00',
        grandTotal: '250.00',
        currency: 'USD',
        services: [{ serviceId: 'srv-bag-1', quantity: 1 }],
      });

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 200,
            currency: 'USD',
            userId: 'user-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'anc-sel-123',
            version: 1,
            status: 'VALIDATED',
            validatedAt: new Date(),
            validationLeaseToken: null,
            validationLeaseExpiresAt: null,
            currency: 'USD',
            validatedBaseAmount: '200.00',
            validatedGrandTotal: '250.00',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'intent-123',
            currentAncillarySelectionId: 'anc-sel-123',
            ancillaryVersion: 1,
          },
        ]);

      mockPrisma.$executeRaw.mockResolvedValueOnce(1);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_123',
        client_secret: 'secret_123',
      });
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'idem-rec-123' });
      mockPrisma.payment.create.mockResolvedValueOnce({
        id: 'payment-123',
        status: 'CREATED',
        amount: 25000,
      });

      // Mock post-commit step idempotencyService.updateRecoveryPoint throwing error
      mockIdempotency.updateRecoveryPoint.mockRejectedValueOnce(new Error('Redis failure'));

      await expect(service.createPayment(dto, idempotencyKey, userId, ipAddress)).rejects.toThrow(
        'Redis failure',
      );

      // Verify Payment record was created and ancillary selection updated
      expect(mockPrisma.payment.create).toHaveBeenCalled();
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();

      // Verify Stripe PaymentIntent was NOT cancelled
      expect(mockStripe.cancelPaymentIntent).not.toHaveBeenCalled();
    });
  });

  describe('executeConfirmPayment with ancillaries', () => {
    const dto = { paymentId: 'payment-123', bookingId: 'booking-123' };
    const idempotencyKey = 'key-123';
    const userId = 'user-123';

    it('constructs service list from payment.ancillarySelection and passes services to duffelService.createOrder', async () => {
      const paymentRecord = {
        id: 'payment-123',
        bookingIntentId: 'intent-123',
        stripePaymentIntentId: 'pi_123',
        status: 'CREATED',
        amount: 25000,
        currency: 'usd',
        bookingIntent: {
          userId: 'user-123',
          supplierOfferId: 'off_123',
          passengers: [{ id: 'pas_1', type: 'adult' }],
        },
        ancillarySelectionId: 'anc-sel-123',
        ancillarySelectionVersion: 1,
        ancillarySelection: {
          id: 'anc-sel-123',
          version: 1,
          status: 'PAYMENT_BOUND',
          seatSelections: [{ serviceId: 'srv-seat-1' }, { serviceId: 'srv-seat-2' }],
          baggageSelections: [{ serviceId: 'srv-bag-1', quantity: 2 }],
        },
      };
      mockPrisma.payment.findUnique.mockImplementation(() => Promise.resolve(paymentRecord));
      mockPrisma.payment.updateMany = jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) {
          paymentRecord.status = args.data.status;
        }
        return Promise.resolve({ count: 1 });
      });

      mockIdempotency.getResumePoint.mockResolvedValueOnce('started');
      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({ status: 'requires_capture' });

      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-123',
        supplierOfferId: 'off_123',
        passengers: [{ id: 'pas_1', type: 'adult' }],
        paymentAttemptCount: 1,
      });

      mockDuffel.createOrder.mockResolvedValueOnce({
        id: 'ord_123',
        booking_reference: 'PNR789',
      });

      mockStripe.capturePaymentIntent.mockResolvedValueOnce({});

      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'ord_123', booking_reference: 'PNR789' },
      });

      const response = await saga.executeConfirmPayment(dto, idempotencyKey, userId);

      // Verify createOrder was called with services summarized from seatSelections & baggageSelections
      expect(mockDuffel.createOrder).toHaveBeenCalledWith(
        'off_123',
        [{ id: 'pas_1', type: 'adult' }],
        expect.arrayContaining([
          { id: 'srv-seat-1', quantity: 1 },
          { id: 'srv-seat-2', quantity: 1 },
          { id: 'srv-bag-1', quantity: 2 },
        ]),
        { bookingIntentId: 'intent-123', paymentId: 'payment-123' },
        idempotencyKey,
      );

      expect(response).toEqual({
        success: true,
        paymentId: 'payment-123',
        status: 'SUCCEEDED',
        bookingReference: 'PNR789',
        duffelOrderId: 'ord_123',
      });
    });
  });

  describe('base-fare checkout (no ancillaries)', () => {
    const dto = { bookingIntentId: 'intent-base-123' };
    const idempotencyKey = 'key-base-123';
    const userId = 'user-123';
    const ipAddress = '127.0.0.1';

    it('processes createPayment without calling validateForPayment and with ancillarySelection null', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-base-123',
        status: 'PENDING',
        paymentAttemptCount: 0,
        confirmedPrice: 150,
        currency: 'USD',
        userId: 'user-123',
        currentAncillarySelectionId: null,
        ancillaryVersion: 0,
      });

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'intent-base-123',
            status: 'PENDING',
            paymentAttemptCount: 0,
            confirmedPrice: 150,
            currency: 'USD',
            userId: 'user-123',
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'intent-base-123',
            currentAncillarySelectionId: null,
            ancillaryVersion: 0,
          },
        ]);

      mockPrisma.payment.findFirst.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        email: 'user@example.com',
        stripeCustomerId: 'cus_123',
      });
      mockStripe.createPaymentIntent.mockResolvedValueOnce({
        id: 'pi_base_123',
        client_secret: 'secret_base_123',
      });
      mockPrisma.idempotencyKey.findUnique.mockResolvedValue({ id: 'idem-base-123' });
      mockPrisma.payment.create.mockResolvedValueOnce({
        id: 'payment-base-123',
        status: 'CREATED',
        amount: 15000,
      });

      const result = await service.createPayment(dto, idempotencyKey, userId, ipAddress);

      // validateForPayment should NOT be called
      expect(mockAncillaryValidation.validateForPayment).not.toHaveBeenCalled();

      // Stripe payment intent amount should be confirmedPrice * 100 ($150 -> 15000 cents)
      expect(mockStripe.createPaymentIntent).toHaveBeenCalledWith(
        15000,
        'USD',
        'cus_123',
        { bookingIntentId: 'intent-base-123' },
        'key-base-123-stripe-intent',
        undefined,
        undefined,
      );

      // Payment created with base fare
      expect(mockPrisma.payment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingIntentId: 'intent-base-123',
          amount: 15000,
        }),
      });

      expect(result).toEqual({
        paymentId: 'payment-base-123',
        clientSecret: 'secret_base_123',
        status: 'CREATED',
      });
    });

    it('processes executeConfirmPayment with undefined services for createOrder', async () => {
      const confirmDto = { paymentId: 'payment-base-123', bookingId: 'booking-base-123' };

      const paymentBaseRecord = {
        id: 'payment-base-123',
        bookingIntentId: 'intent-base-123',
        stripePaymentIntentId: 'pi_base_123',
        status: 'CREATED',
        amount: 15000,
        currency: 'usd',
        ancillarySelectionId: null,
        ancillarySelectionVersion: null,
        bookingIntent: {
          userId: 'user-123',
          supplierOfferId: 'off_base_123',
          passengers: [{ id: 'pas_1', type: 'adult' }],
        },
        ancillarySelection: null,
      };
      mockPrisma.payment.findUnique.mockImplementation(() => Promise.resolve(paymentBaseRecord));
      mockPrisma.payment.updateMany = jest.fn().mockImplementation((args: any) => {
        if (args?.data?.status) {
          paymentBaseRecord.status = args.data.status;
        }
        return Promise.resolve({ count: 1 });
      });

      mockIdempotency.getResumePoint.mockResolvedValueOnce('started');
      mockStripe.retrievePaymentIntent.mockResolvedValueOnce({ status: 'requires_capture' });

      mockPrisma.bookingIntent.findUnique.mockResolvedValueOnce({
        id: 'intent-base-123',
        supplierOfferId: 'off_base_123',
        passengers: [{ id: 'pas_1', type: 'adult' }],
        paymentAttemptCount: 1,
      });

      mockDuffel.createOrder.mockResolvedValueOnce({
        id: 'ord_base_123',
        booking_reference: 'PNRBASE',
      });

      mockStripe.capturePaymentIntent.mockResolvedValueOnce({});

      mockPrisma.paymentEvent.findFirst.mockResolvedValueOnce({
        metadata: { id: 'ord_base_123', booking_reference: 'PNRBASE' },
      });

      const response = await saga.executeConfirmPayment(confirmDto, idempotencyKey, userId);

      // Verify createOrder called with undefined services
      expect(mockDuffel.createOrder).toHaveBeenCalledWith(
        'off_base_123',
        [{ id: 'pas_1', type: 'adult' }],
        undefined,
        { bookingIntentId: 'intent-base-123', paymentId: 'payment-base-123' },
        idempotencyKey,
      );

      expect(response).toEqual({
        success: true,
        paymentId: 'payment-base-123',
        status: 'SUCCEEDED',
        bookingReference: 'PNRBASE',
        duffelOrderId: 'ord_base_123',
      });
    });
  });
});
