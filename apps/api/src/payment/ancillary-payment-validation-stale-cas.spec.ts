import { PrismaService } from '@/prisma/prisma.service';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { AncillaryPaymentValidationService } from './ancillary-payment-validation.service';

describe('AncillaryPaymentValidationService stale CAS', () => {
  it('does not mark the intent stale after the validation lease is lost', async () => {
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
      baggageSelections: [],
    };
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
      currentAncillarySelection: selection,
    };
    const bookingIntentUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const selectionUpdate = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    type Transaction = {
      $queryRaw: jest.Mock;
      bookingIntent: { findUnique: jest.Mock; updateMany: jest.Mock };
      ancillarySelection: { updateMany: jest.Mock };
    };
    const transaction: Transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
        updateMany: bookingIntentUpdate,
      },
      ancillarySelection: { updateMany: selectionUpdate },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (value: Transaction) => Promise<unknown>): Promise<unknown> =>
          callback(transaction),
      ),
      ancillarySelection: { updateMany: jest.fn() },
    };
    const ancillaryService = {
      repriceOffer: jest.fn().mockResolvedValue({
        totalAmount: '0.00',
        baseAmount: '0.00',
        serviceLines: [],
        currency: 'USD',
        invalidServiceIdentities: ['seat-1'],
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
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_VERSION_CONFLICT',
        intentId: 'intent-1',
        currentVersion: 3,
      },
    });

    expect(bookingIntentUpdate).not.toHaveBeenCalled();
  });
});
