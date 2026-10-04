import { PrismaService } from '@/prisma/prisma.service';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

type Pricing = {
  totalAmount: string;
  baseAmount: string;
  serviceLines: Array<{ serviceId: string; amount: string; quantity: number }>;
  currency: string;
  invalidServiceIdentities: string[];
};

const createHarness = (pricing: Pricing) => {
  const selectionUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const bookingIntentUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const intent = {
    id: 'intent-1',
    userId: 'user-1',
    status: 'PENDING',
    intentExpiresAt: new Date(Date.now() + 60_000),
    offerExpiresAt: new Date(Date.now() + 60_000),
    supplierOfferId: 'offer-1',
    confirmedPrice: '420.00',
    currency: 'USD',
    ancillaryVersion: 3,
    currentAncillarySelectionId: 'selection-3',
    currentAncillarySelection: {
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
        },
      ],
    },
  };
  const transaction = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
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
  const ancillaryService = { repriceOffer: jest.fn().mockResolvedValue(pricing) };
  const service = new AncillaryPaymentValidationService(
    prisma as unknown as PrismaService,
    ancillaryService as unknown as DuffelAncillaryService,
  );
  return { bookingIntentUpdate, ancillaryService, selectionUpdate, service };
};

const input = {
  userId: 'user-1',
  bookingIntentId: 'intent-1',
  ancillarySelectionId: 'selection-3',
  ancillarySelectionVersion: 3,
};

describe('AncillaryPaymentValidationService targeted conflicts', () => {
  it.each([
    {
      name: 'unavailable service',
      code: 'ANCILLARY_SELECTION_STALE',
      pricing: {
        totalAmount: '0.00',
        baseAmount: '0.00',
        serviceLines: [],
        currency: 'USD',
        invalidServiceIdentities: ['seat-1'],
      },
    },
    {
      name: 'authoritative price change',
      code: 'ANCILLARY_PRICE_CHANGED',
      pricing: {
        totalAmount: '485.00',
        baseAmount: '420.00',
        serviceLines: [
          { serviceId: 'seat-1', amount: '30.00', quantity: 1 },
          { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
        ],
        currency: 'USD',
        invalidServiceIdentities: [],
      },
    },
    {
      name: 'authoritative currency mismatch',
      code: 'ANCILLARY_CURRENCY_MISMATCH',
      pricing: {
        totalAmount: '473.00',
        baseAmount: '420.00',
        serviceLines: [
          { serviceId: 'seat-1', amount: '18.00', quantity: 1 },
          { serviceId: 'bag-1', amount: '35.00', quantity: 1 },
        ],
        currency: 'EUR',
        invalidServiceIdentities: [],
      },
    },
  ])('marks only the lease-owned current snapshot stale for $name', async ({ code, pricing }) => {
    const harness = createHarness(pricing);

    await expect(harness.service.validateForPayment(input)).rejects.toMatchObject({
      response: { code, intentId: 'intent-1' },
    });

    expect(harness.ancillaryService.repriceOffer).toHaveBeenCalledTimes(1);
    expect(harness.selectionUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ validationLeaseToken: expect.any(String) }),
        data: expect.objectContaining({
          status: 'STALE',
          validationLeaseToken: null,
          validationLeaseExpiresAt: null,
        }),
      }),
    );
    expect(harness.bookingIntentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ancillaryStatus: 'STALE' }) }),
    );
  });
});
