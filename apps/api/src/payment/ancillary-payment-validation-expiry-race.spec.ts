import { PrismaService } from '@/prisma/prisma.service';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

describe('AncillaryPaymentValidationService expiry races', () => {
  it('uses lock-acquisition time when taking over an expired validation lease', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    const expiredAtLockTime = new Date('2026-07-29T10:00:05.000Z');
    const selection = {
      id: 'selection-3',
      bookingIntentId: 'intent-1',
      version: 3,
      status: 'DRAFT_COMMITTED',
      currency: 'USD',
      total: '53.00',
      validationLeaseToken: 'previous-lease',
      validationLeaseExpiresAt: expiredAtLockTime,
      seatSelections: [{ serviceId: 'seat-1' }],
      baggageSelections: [{ serviceId: 'bag-1', quantity: 1, segments: [] }],
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
    const selectionUpdate = jest
      .fn()
      .mockImplementation(
        async (args: { where: { OR?: Array<{ validationLeaseExpiresAt?: { lte: Date } }> } }) => {
          const expiryThreshold = args.where.OR?.[1]?.validationLeaseExpiresAt?.lte;
          if (expiryThreshold) {
            return { count: expiryThreshold >= expiredAtLockTime ? 1 : 0 };
          }
          return { count: 1 };
        },
      );
    const queryRaw = jest.fn().mockImplementation(async () => {
      if (queryRaw.mock.calls.length === 1) {
        jest.setSystemTime(new Date('2026-07-29T10:00:10.000Z'));
      }
      return [{ id: 'intent-1' }];
    });
    const transaction = {
      $queryRaw: queryRaw,
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: { updateMany: selectionUpdate },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (value: typeof transaction) => Promise<unknown>): Promise<unknown> =>
          callback(transaction),
      ),
      ancillarySelection: { updateMany: jest.fn() },
    };
    const ancillaryService = {
      repriceOffer: jest.fn().mockResolvedValue({
        totalAmount: '473.00',
        baseAmount: '420.00',
        serviceLines: [
          { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
          { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
        ],
        currency: 'USD',
        invalidServiceIdentities: [],
      }),
    };
    const service = new AncillaryPaymentValidationService(
      prisma as unknown as PrismaService,
      ancillaryService as unknown as DuffelAncillaryService,
    );

    await expect(
      service.validateForPayment({
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        ancillarySelectionId: 'selection-3',
        ancillarySelectionVersion: 3,
      }),
    ).resolves.toMatchObject({
      selectionId: 'selection-3',
      selectionVersion: 3,
    });
  });

  it.each(['validated', 'stale'] as const)(
    'rejects the %s completion when the validation lease expires while waiting for the row lock',
    async (completion) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
      const leaseExpiresAt = new Date('2026-07-29T10:00:30.000Z');
      const selection = {
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
            segments: [],
          },
        ],
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
      const selectionUpdate = jest
        .fn()
        .mockImplementation(
          async (args: { where: { OR?: unknown; validationLeaseExpiresAt?: { gt: Date } } }) => {
            if (args.where.OR) {
              return { count: 1 };
            }
            const completionThreshold = args.where.validationLeaseExpiresAt?.gt;
            return {
              count:
                completionThreshold === undefined || leaseExpiresAt > completionThreshold ? 1 : 0,
            };
          },
        );
      const bookingIntentUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const queryRaw = jest.fn().mockImplementation(async () => {
        if (queryRaw.mock.calls.length === 2) {
          jest.setSystemTime(new Date('2026-07-29T10:00:31.000Z'));
        }
        return [{ id: 'intent-1' }];
      });
      const transaction = {
        $queryRaw: queryRaw,
        bookingIntent: {
          findUnique: jest.fn().mockResolvedValue(intent),
          updateMany: bookingIntentUpdate,
        },
        ancillarySelection: { updateMany: selectionUpdate },
      };
      const prisma = {
        $transaction: jest.fn(
          async (callback: (value: typeof transaction) => Promise<unknown>): Promise<unknown> =>
            callback(transaction),
        ),
        ancillarySelection: { updateMany: jest.fn() },
      };
      const validPricing = {
        totalAmount: '473.00',
        baseAmount: '420.00',
        serviceLines: [
          { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
          { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
        ],
        currency: 'USD',
        invalidServiceIdentities: [],
      };
      const stalePricing = {
        totalAmount: '0.00',
        baseAmount: '0.00',
        serviceLines: [],
        currency: 'USD',
        invalidServiceIdentities: ['seat-1'],
      };
      const ancillaryService = {
        repriceOffer: jest
          .fn()
          .mockResolvedValue(completion === 'validated' ? validPricing : stalePricing),
      };
      const service = new AncillaryPaymentValidationService(
        prisma as unknown as PrismaService,
        ancillaryService as unknown as DuffelAncillaryService,
      );

      await expect(
        service.validateForPayment({
          userId: 'user-1',
          bookingIntentId: 'intent-1',
          ancillarySelectionId: 'selection-3',
          ancillarySelectionVersion: 3,
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'ANCILLARY_VERSION_CONFLICT',
          intentId: 'intent-1',
          currentVersion: 3,
        },
      });

      expect(bookingIntentUpdate).not.toHaveBeenCalled();
    },
  );
});
