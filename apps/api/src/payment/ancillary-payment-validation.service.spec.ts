import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AncillaryNormalizer } from '@/supplier/ancillary/ancillary.normalizer';
import { DuffelAncillaryAdapter } from '@/supplier/ancillary/duffel-ancillary.adapter';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

describe('AncillaryPaymentValidationService', () => {
  jest.setTimeout(30000);
  it('reprices once outside transactions and validates the leased current snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    let inTransaction = false;
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      supplierOfferId: 'offer-1',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: selection,
    };
    type PrismaFake = {
      $transaction: jest.Mock;
      $queryRaw: jest.Mock;
      bookingIntent: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
      };
      ancillarySelection: {
        updateMany: jest.Mock;
      };
    };
    const prisma: PrismaFake = {
      $transaction: jest.fn(),
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (transaction: PrismaFake) => Promise<unknown>): Promise<unknown> => {
        inTransaction = true;
        try {
          return await callback(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );
    const ancillaryService = {
      repriceOffer: jest.fn().mockImplementation(async () => {
        expect(inTransaction).toBe(false);
        return {
          totalAmount: '473.00',
          baseAmount: '420.00',
          serviceLines: [
            { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
            { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
          ],
          currency: 'USD',
          invalidServiceIdentities: [],
        };
      }),
    };
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      ancillaryService as unknown as DuffelAncillaryService,
    );

    const result = await service.validateForPayment({
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    });

    expect(result).toEqual({
      selectionId: 'selection-3',
      selectionVersion: 3,
      baseAmount: '420.00',
      grandTotal: '473.00',
      currency: 'USD',
      services: [
        { serviceId: 'bag-1', quantity: 1 },
        { serviceId: 'seat-1', quantity: 1 },
      ],
    });
    expect(ancillaryService.repriceOffer).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.ancillarySelection.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'selection-3',
          version: 3,
          validationLeaseToken: expect.any(String),
        }),
        data: expect.objectContaining({
          status: 'VALIDATED',
          validatedBaseAmount: '420.00',
          validatedGrandTotal: '473.00',
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        }),
      }),
    );
  });

  it('fails fast with GatewayTimeoutException and releases the lease when repricing exceeds 15 seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1 }],
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      supplierOfferId: 'offer-1',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: selection,
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: typeof transaction) => Promise<unknown>): Promise<unknown> =>
          callback(transaction),
      ),
      ancillarySelection: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    // Duffel repricing hangs past 15s timeout
    const ancillaryService = {
      repriceOffer: jest.fn().mockImplementation(() => new Promise(() => {})),
    };
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      ancillaryService as unknown as DuffelAncillaryService,
    );

    const validationPromise = service.validateForPayment({
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    });

    const errorPromise = expect(validationPromise).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_REPRICING_TIMEOUT',
        message: 'External ancillary repricing request timed out',
      },
    });

    await jest.runAllTimersAsync();
    await errorPromise;

    // Lease must be released
    expect(prisma.ancillarySelection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'selection-3',
          bookingIntentId: 'intent-1',
          version: 3,
          validationLeaseToken: expect.any(String),
        }),
        data: expect.objectContaining({
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        }),
      }),
    );
  });

  it('uses authoritative SDK repricing for duplicate baggage selections and persists its totals', async () => {
    jest.useRealTimers();
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '90.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [],
      baggageSelections: [
        {
          serviceId: 'ase_bag_1',
          intentPassengerId: 'p1',
          quantity: 1,
          segments: [{ segmentId: 'seg_1' }],
        },
        {
          serviceId: 'ase_bag_1',
          intentPassengerId: 'p2',
          quantity: 2,
          segments: [{ segmentId: 'seg_1' }],
        },
      ],
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: future,
      offerExpiresAt: future,
      supplierOfferId: 'off_123',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: selection,
    };
    type PaymentTransaction = {
      $queryRaw: jest.Mock;
      bookingIntent: {
        findUnique: jest.Mock;
        updateMany: jest.Mock;
      };
      ancillarySelection: {
        updateMany: jest.Mock;
      };
    };
    const selectionUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const bookingIntentUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const transaction: PaymentTransaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: bookingIntentUpdate,
      },
      ancillarySelection: {
        updateMany: selectionUpdate,
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (tx: PaymentTransaction) => Promise<unknown>): Promise<unknown> =>
          callback(transaction),
      ),
      ancillarySelection: {
        updateMany: selectionUpdate,
      },
    };
    const mockOffersGetPriced = jest.fn().mockResolvedValue({
      data: {
        total_amount: '510.00',
        base_amount: '420.00',
        total_currency: 'USD',
        service_lines: [
          {
            service_id: 'ase_bag_1',
            total_amount: '30.00',
            quantity: 3,
          },
        ],
      },
    });
    const sdk = {
      offers: { getPriced: mockOffersGetPriced },
    } as unknown as Duffel;
    // Keep the adapter and normalizer real; SDK, budget, and cache are external boundaries.
    const reserveAttempt = jest.fn().mockResolvedValue({ ok: true });
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      getTtl: jest.fn().mockResolvedValue(-2),
      set: jest.fn().mockResolvedValue(undefined),
    };
    const ancillaryService = new DuffelAncillaryService(
      new DuffelAncillaryAdapter(sdk, { reserveAttempt } as unknown as DuffelRateBudgetService),
      new AncillaryNormalizer(),
      cache as unknown as CacheService,
    );
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      ancillaryService,
    );

    const result = await service.validateForPayment({
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    });

    expect(result).toEqual({
      selectionId: 'selection-3',
      selectionVersion: 3,
      baseAmount: '420.00',
      grandTotal: '510.00',
      currency: 'USD',
      services: [{ serviceId: 'ase_bag_1', quantity: 3 }],
    });
    expect(mockOffersGetPriced).toHaveBeenCalledWith('off_123', {
      intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
      intended_services: [{ id: 'ase_bag_1', quantity: 3 }],
    });
    expect(reserveAttempt).toHaveBeenCalledTimes(1);
    expect(selectionUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'VALIDATED',
          validatedBaseAmount: '420.00',
          validatedGrandTotal: '510.00',
        }),
      }),
    );
    expect(bookingIntentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          ancillaryStatus: 'VALIDATED',
          validatedTotal: '510.00',
        }),
      }),
    );
  });

  describe('priced-offer validation in payment flows', () => {
    type MockPricing = {
      totalAmount: string;
      baseAmount: string;
      serviceLines: Array<{ serviceId: string; amount: string; quantity: number }>;
      currency: string;
      invalidServiceIdentities: string[];
    };

    type SeatSelectionFixture = {
      serviceId: string;
      intentPassengerId: string;
      segmentId: string;
    };

    type BaggageSelectionFixture = {
      serviceId: string;
      intentPassengerId: string;
      quantity: number;
      segments: Array<{ segmentId: string }>;
    };

    type SelectionFixture = {
      id: string;
      bookingIntentId: string;
      version: number;
      status: string;
      currency: string;
      total: string;
      validationLeaseToken: string | null;
      validationLeaseExpiresAt: Date | null;
      seatSelections: SeatSelectionFixture[];
      baggageSelections: BaggageSelectionFixture[];
    };

    type IntentFixture = {
      id: string;
      userId: string;
      status: string;
      intentExpiresAt: Date;
      offerExpiresAt: Date | null;
      supplierOfferId: string;
      confirmedPrice: string;
      currency: string;
      ancillaryVersion: number;
      currentAncillarySelectionId: string;
      currentAncillarySelection: SelectionFixture | null;
    };

    const createDefaultSelection = (): SelectionFixture => ({
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: null,
      validationLeaseExpiresAt: null,
      seatSelections: [
        {
          serviceId: 'seat-1',
          intentPassengerId: 'passenger-1',
          segmentId: 'segment-1',
        },
      ],
      baggageSelections: [
        {
          serviceId: 'bag-1',
          intentPassengerId: 'passenger-1',
          quantity: 1,
          segments: [{ segmentId: 'segment-1' }],
        },
      ],
    });

    const createDefaultIntent = (): IntentFixture => ({
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      supplierOfferId: 'offer-1',
      confirmedPrice: '420.00',
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: createDefaultSelection(),
    });

    const createHarness = (options?: {
      intent?: IntentFixture | null;
      pricing?: MockPricing;
      pricingError?: Error;
    }) => {
      const intent = options?.intent === undefined ? createDefaultIntent() : options.intent;
      const bookingIntentUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const selectionUpdate = jest.fn().mockResolvedValue({ count: 1 });

      const transaction = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: intent?.id ?? 'intent-1' }]),
        bookingIntent: {
          findUnique: jest.fn().mockResolvedValue(intent),
          updateMany: bookingIntentUpdate,
        },
        ancillarySelection: {
          updateMany: selectionUpdate,
        },
      };

      const prisma = {
        $transaction: jest.fn(
          async (callback: (tx: typeof transaction) => Promise<unknown>): Promise<unknown> =>
            callback(transaction),
        ),
        ancillarySelection: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      const defaultPricing: MockPricing = {
        totalAmount: '473.00',
        baseAmount: '420.00',
        serviceLines: [
          { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
          { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
        ],
        currency: 'USD',
        invalidServiceIdentities: [],
      };

      const ancillaryService = {
        repriceOffer: options?.pricingError
          ? jest.fn().mockRejectedValue(options.pricingError)
          : jest.fn().mockResolvedValue(options?.pricing ?? defaultPricing),
      };

      const service = new AncillaryPaymentValidationService(
        prisma as unknown as PrismaService,
        ancillaryService as unknown as DuffelAncillaryService,
      );

      return {
        service,
        prisma,
        transaction,
        ancillaryService,
        bookingIntentUpdate,
        selectionUpdate,
      };
    };

    const defaultInput = {
      userId: 'user-1',
      bookingIntentId: 'intent-1',
      ancillarySelectionId: 'selection-3',
      ancillarySelectionVersion: 3,
    };

    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    });

    describe('authoritative supplier total comparison against client request', () => {
      it('rejects with ANCILLARY_PRICE_CHANGED and marks stale when supplier base amount differs from client confirmedPrice', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '503.00',
            baseAmount: '450.00', // Changed from 420.00 to 450.00
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_PRICE_CHANGED',
            intentId: 'intent-1',
            currentVersion: 3,
            pricing: {
              previousGrandTotal: '473.00',
              currentGrandTotal: '503.00',
              currency: 'USD',
            },
          },
        });

        expect(harness.selectionUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'selection-3',
              version: 3,
              validationLeaseToken: expect.any(String),
            }),
            data: expect.objectContaining({
              status: 'STALE',
              validationLeaseToken: null,
              validationLeaseExpiresAt: null,
            }),
          }),
        );

        expect(harness.bookingIntentUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              ancillaryStatus: 'STALE',
              validatedTotal: null,
            }),
          }),
        );
      });

      it('rejects with ANCILLARY_PRICE_CHANGED and marks stale when supplier grand total differs (ancillary price changed)', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '485.00', // Changed from 473.00 to 485.00
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '30.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_PRICE_CHANGED',
            intentId: 'intent-1',
            currentVersion: 3,
            pricing: {
              previousGrandTotal: '473.00',
              currentGrandTotal: '485.00',
              currency: 'USD',
            },
          },
        });

        expect(harness.selectionUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'STALE' }),
          }),
        );
      });

      it('rejects with ANCILLARY_PRICE_CHANGED even when supplier total decreases', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '460.00', // Decreased from 473.00
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '5.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_PRICE_CHANGED',
            intentId: 'intent-1',
            pricing: {
              previousGrandTotal: '473.00',
              currentGrandTotal: '460.00',
              currency: 'USD',
            },
          },
        });
      });

      it('accepts repricing when decimal amounts match numerically despite trailing decimal formatting', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '473.000',
            baseAmount: '420.000',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        const result = await harness.service.validateForPayment(defaultInput);

        expect(result).toMatchObject({
          baseAmount: '420.00',
          grandTotal: '473.00',
          currency: 'USD',
        });
      });

      it('rejects with ANCILLARY_PRICE_CHANGED when price drifts by fractional sub-cent amounts', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '473.005', // Sub-cent discrepancy
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_PRICE_CHANGED',
            intentId: 'intent-1',
          },
        });
      });

      it('validates successfully with zero ancillaries when client selection has empty seat and baggage arrays', async () => {
        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.seatSelections = [];
          intent.currentAncillarySelection.baggageSelections = [];
          intent.currentAncillarySelection.total = '0.00';
        }

        const harness = createHarness({
          intent,
          pricing: {
            totalAmount: '420.00',
            baseAmount: '420.00',
            serviceLines: [],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        const result = await harness.service.validateForPayment(defaultInput);

        expect(result).toEqual({
          selectionId: 'selection-3',
          selectionVersion: 3,
          baseAmount: '420.00',
          grandTotal: '420.00',
          currency: 'USD',
          services: [],
        });
      });
    });

    describe('validation error emission on currency mismatch', () => {
      it('rejects with ANCILLARY_CURRENCY_MISMATCH and marks stale when supplier currency mismatches selection currency', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '473.00',
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'EUR', // Mismatched currency
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_CURRENCY_MISMATCH',
            intentId: 'intent-1',
          },
        });

        expect(harness.selectionUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'STALE' }),
          }),
        );
        expect(harness.bookingIntentUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ ancillaryStatus: 'STALE' }),
          }),
        );
      });

      it('accepts currency comparison case-insensitively (e.g. usd vs USD)', async () => {
        const intent = createDefaultIntent();
        intent.currency = 'usd';
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.currency = 'usd';
        }

        const harness = createHarness({
          intent,
          pricing: {
            totalAmount: '473.00',
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        const result = await harness.service.validateForPayment(defaultInput);

        expect(result.currency).toBe('USD');
      });
    });

    describe('validation error emission on passenger counts, service quantities, or unavailable services mismatch', () => {
      it('rejects with ANCILLARY_SELECTION_STALE when supplier confirms fewer service quantities than passenger selections', async () => {
        // Multi-passenger selection: 2 passengers selecting bag-1 (quantity = 2)
        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.seatSelections = [];
          intent.currentAncillarySelection.baggageSelections = [
            {
              serviceId: 'bag-1',
              intentPassengerId: 'passenger-1',
              quantity: 1,
              segments: [{ segmentId: 'segment-1' }],
            },
            {
              serviceId: 'bag-1',
              intentPassengerId: 'passenger-2',
              quantity: 1,
              segments: [{ segmentId: 'segment-1' }],
            },
          ];
          intent.currentAncillarySelection.total = '70.00';
        }

        const harness = createHarness({
          intent,
          pricing: {
            totalAmount: '455.00',
            baseAmount: '420.00',
            serviceLines: [
              // Supplier only confirmed quantity 1 instead of expected quantity 2 across both passengers
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
            currentVersion: 3,
            invalidSelections: expect.arrayContaining([
              expect.objectContaining({
                kind: 'BAGGAGE',
                serviceId: 'bag-1',
                intentPassengerId: 'passenger-1',
                reason: 'UNAVAILABLE',
              }),
              expect.objectContaining({
                kind: 'BAGGAGE',
                serviceId: 'bag-1',
                intentPassengerId: 'passenger-2',
                reason: 'UNAVAILABLE',
              }),
            ]),
          },
        });

        expect(harness.selectionUpdate).toHaveBeenLastCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: 'STALE' }),
          }),
        );
      });

      it('rejects with ANCILLARY_SELECTION_STALE when supplier omits a requested service line', async () => {
        // Client requested seat-1 and bag-1, supplier only returns bag-1
        const harness = createHarness({
          pricing: {
            totalAmount: '455.00',
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
          },
        });
      });

      it('rejects with ANCILLARY_SELECTION_STALE and details passenger info when supplier reports invalidServiceIdentities', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '0.00',
            baseAmount: '0.00',
            serviceLines: [],
            currency: 'USD',
            invalidServiceIdentities: ['seat-1'],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
            currentVersion: 3,
            invalidSelections: [
              {
                kind: 'SEAT',
                serviceId: 'seat-1',
                intentPassengerId: 'passenger-1',
                segmentIds: ['segment-1'],
                reason: 'UNAVAILABLE',
              },
            ],
          },
        });
      });

      it('identifies the exact passenger and segment for unavailable seats in multi-passenger bookings', async () => {
        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.seatSelections = [
            {
              serviceId: 'seat-1a',
              intentPassengerId: 'passenger-1',
              segmentId: 'segment-1',
            },
            {
              serviceId: 'seat-1b',
              intentPassengerId: 'passenger-2',
              segmentId: 'segment-1',
            },
          ];
          intent.currentAncillarySelection.baggageSelections = [];
          intent.currentAncillarySelection.total = '40.00';
        }

        // Only seat-1a for passenger-1 is invalid
        const harness = createHarness({
          intent,
          pricing: {
            totalAmount: '0.00',
            baseAmount: '0.00',
            serviceLines: [],
            currency: 'USD',
            invalidServiceIdentities: ['seat-1a'],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            invalidSelections: [
              {
                kind: 'SEAT',
                serviceId: 'seat-1a',
                intentPassengerId: 'passenger-1',
                segmentIds: ['segment-1'],
                reason: 'UNAVAILABLE',
              },
            ],
          },
        });
      });

      it('rejects with ANCILLARY_SELECTION_STALE when supplier confirms more quantity than client requested', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '491.00',
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 2 }, // Expected 1
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
          },
        });
      });

      it('rejects with ANCILLARY_SELECTION_STALE when supplier includes an unexpected unrequested service line', async () => {
        const harness = createHarness({
          pricing: {
            totalAmount: '498.00',
            baseAmount: '420.00',
            serviceLines: [
              { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
              { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
              { serviceId: 'extra-unrequested-service', amount: '25.00', quantity: 1 },
            ],
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
          },
        });
      });

      it('handles 9-passenger booking with multi-segment seats and baggage, validating complete passenger and segment mapping', async () => {
        const passengers = Array.from({ length: 9 }, (_, index) => `passenger-${index + 1}`);
        const seatSelections: SeatSelectionFixture[] = [];
        const baggageSelections: BaggageSelectionFixture[] = [];

        for (const paxId of passengers) {
          seatSelections.push({
            serviceId: `seat-outbound-${paxId}`,
            intentPassengerId: paxId,
            segmentId: 'segment-outbound',
          });
          seatSelections.push({
            serviceId: `seat-return-${paxId}`,
            intentPassengerId: paxId,
            segmentId: 'segment-return',
          });
          baggageSelections.push({
            serviceId: 'bag-standard-23kg',
            intentPassengerId: paxId,
            quantity: 1,
            segments: [{ segmentId: 'segment-outbound' }, { segmentId: 'segment-return' }],
          });
        }

        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.seatSelections = seatSelections;
          intent.currentAncillarySelection.baggageSelections = baggageSelections;
          // 18 seats @ $20 = 360, 9 bags @ $40 = 360 => 720 ancillary total
          intent.currentAncillarySelection.total = '720.00';
          intent.confirmedPrice = '3780.00'; // 9 * 420 base
        }

        const serviceLines = [
          ...seatSelections.map((s) => ({
            serviceId: s.serviceId,
            amount: '20.00',
            quantity: 1,
          })),
          {
            serviceId: 'bag-standard-23kg',
            amount: '360.00',
            quantity: 9,
          },
        ];

        const harness = createHarness({
          intent,
          pricing: {
            totalAmount: '4500.00', // 3780 base + 720 ancillaries
            baseAmount: '3780.00',
            serviceLines,
            currency: 'USD',
            invalidServiceIdentities: [],
          },
        });

        const result = await harness.service.validateForPayment(defaultInput);

        expect(result.grandTotal).toBe('4500.00');
        expect(result.baseAmount).toBe('3780.00');
        expect(result.services).toHaveLength(19); // 18 unique seats + 1 aggregated baggage service (qty 9)
        const bagService = result.services.find((s) => s.serviceId === 'bag-standard-23kg');
        expect(bagService).toEqual({ serviceId: 'bag-standard-23kg', quantity: 9 });
      });
    });

    describe('intent lifecycle, ownership, and error safety', () => {
      it('rejects with INTENT_EXPIRED when booking intent has expired', async () => {
        const intent = createDefaultIntent();
        intent.intentExpiresAt = new Date('2026-07-29T09:59:59.000Z'); // Expired

        const harness = createHarness({ intent });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: { code: 'INTENT_EXPIRED' },
        });
      });

      it('rejects with OFFER_EXPIRED when supplier offer has expired', async () => {
        const intent = createDefaultIntent();
        intent.offerExpiresAt = new Date('2026-07-29T09:59:59.000Z'); // Offer expired

        const harness = createHarness({ intent });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: { code: 'OFFER_EXPIRED' },
        });
      });

      it('rejects with INTENT_FORBIDDEN when user does not own intent', async () => {
        const harness = createHarness();

        await expect(
          harness.service.validateForPayment({
            ...defaultInput,
            userId: 'unauthorized-user',
          }),
        ).rejects.toMatchObject({
          response: { code: 'INTENT_FORBIDDEN' },
        });
      });

      it('rejects with INTENT_NOT_FOUND when intent does not exist', async () => {
        const harness = createHarness({ intent: null });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: { code: 'INTENT_NOT_FOUND' },
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when ancillary selection version mismatches intent', async () => {
        const harness = createHarness();

        await expect(
          harness.service.validateForPayment({
            ...defaultInput,
            ancillarySelectionVersion: 99,
          }),
        ).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('releases the lease and rethrows when supplier repricing throws an unexpected error', async () => {
        const repricingError = new Error('Upstream supplier connection reset');
        const harness = createHarness({ pricingError: repricingError });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toThrow(
          'Upstream supplier connection reset',
        );

        // Verify lease was released
        expect(harness.prisma.ancillarySelection.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'selection-3',
              bookingIntentId: 'intent-1',
              version: 3,
              validationLeaseToken: expect.any(String),
            }),
            data: expect.objectContaining({
              validationLeaseToken: null,
              validationLeaseExpiresAt: null,
            }),
          }),
        );
      });

      it('rejects with ANCILLARY_SELECTION_STALE when intent status is not PENDING (e.g. CONFIRMED)', async () => {
        const intent = createDefaultIntent();
        intent.status = 'CONFIRMED';
        const harness = createHarness({ intent });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_SELECTION_STALE',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when intent.currentAncillarySelection is null in database', async () => {
        const intent = createDefaultIntent();
        intent.currentAncillarySelection = null;
        const harness = createHarness({ intent });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when another concurrent request holds an active unexpired lease', async () => {
        const harness = createHarness();
        // Lease update returns 0 rows updated because another process holds the lease
        harness.selectionUpdate.mockResolvedValueOnce({ count: 0 });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('allows lease acquisition when existing lease has already expired (validationLeaseExpiresAt <= now)', async () => {
        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.validationLeaseToken = 'expired-token';
          intent.currentAncillarySelection.validationLeaseExpiresAt = new Date('2026-07-29T09:59:00.000Z');
        }

        const harness = createHarness({ intent });
        const result = await harness.service.validateForPayment(defaultInput);

        expect(result).toMatchObject({
          selectionId: 'selection-3',
          grandTotal: '473.00',
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when selection status is STALE', async () => {
        const intent = createDefaultIntent();
        if (intent.currentAncillarySelection) {
          intent.currentAncillarySelection.status = 'STALE';
        }

        const harness = createHarness({ intent });
        // Prisma updateMany for lease returns 0 because status is STALE (not DRAFT_COMMITTED or VALIDATED)
        harness.selectionUpdate.mockResolvedValueOnce({ count: 0 });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
          },
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when lease expires during external repricing before persistValidated', async () => {
        const harness = createHarness();
        // First selectionUpdate (acquireLease) succeeds, second selectionUpdate (persistValidated) returns 0 count
        harness.selectionUpdate
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('rejects with ANCILLARY_VERSION_CONFLICT when booking intent expires during repricing before persistValidated', async () => {
        const harness = createHarness();
        // Intent updateMany in persistValidated returns 0 (e.g. intentExpiresAt exceeded during repricing)
        harness.bookingIntentUpdate.mockResolvedValueOnce({ count: 0 });

        await expect(harness.service.validateForPayment(defaultInput)).rejects.toMatchObject({
          response: {
            code: 'ANCILLARY_VERSION_CONFLICT',
            intentId: 'intent-1',
            currentVersion: 3,
          },
        });
      });

      it('validates successfully when offerExpiresAt is null on the intent', async () => {
        const intent = createDefaultIntent();
        intent.offerExpiresAt = null;

        const harness = createHarness({ intent });
        const result = await harness.service.validateForPayment(defaultInput);

        expect(result.grandTotal).toBe('473.00');
        expect(result.currency).toBe('USD');
      });
    });
  });
});
