import { Prisma } from '@prisma/client';
import { AncillariesService } from './ancillaries.service';

describe('AncillariesService validation lease', () => {
  it('rejects an edit while the current snapshot has an active payment-validation lease', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T10:00:00.000Z'));
    const currentSelection = {
      id: 'selection-3',
      version: 3,
      seatSelections: [],
      baggageSelections: [],
      seatTotal: new Prisma.Decimal('0.00'),
      baggageTotal: new Prisma.Decimal('0.00'),
      total: new Prisma.Decimal('0.00'),
      validationLeaseToken: 'lease-in-flight',
      validationLeaseExpiresAt: new Date('2026-07-29T10:00:30.000Z'),
    };
    const intent = {
      id: 'intent-1',
      userId: 'user-1',
      status: 'PENDING',
      supplierOfferId: 'offer-1',
      confirmedPrice: new Prisma.Decimal('420.00'),
      currency: 'USD',
      ancillaryVersion: 3,
      currentAncillarySelectionId: 'selection-3',
      currentAncillarySelection: currentSelection,
      intentExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      offerExpiresAt: new Date('2026-07-29T11:00:00.000Z'),
      passengers: [],
    };
    const transaction = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue({
          ancillaryVersion: 3,
          currentAncillarySelection: currentSelection,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ancillarySelection: {
        create: jest.fn().mockResolvedValue({ id: 'selection-4', version: 4 }),
      },
      idempotencyKey: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      bookingIntent: {
        findUnique: jest.fn().mockResolvedValue(intent),
      },
      $transaction: jest.fn(async (callback: (value: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
      ),
    };
    const catalog = {
      offerId: 'offer-1',
      currency: 'USD',
      fetchedAt: '2026-07-29T10:00:00.000Z',
      expiresAt: '2026-07-29T10:01:00.000Z',
      cache: { status: 'HIT', ttlSeconds: 60 },
      segments: [],
      baggageServices: [],
    };
    const catalogService = {
      getCatalog: jest.fn().mockResolvedValue(catalog),
      fingerprint: jest.fn().mockReturnValue('fingerprint-1'),
    };
    const idempotency = {
      computeHash: jest.fn().mockReturnValue('request-hash'),
      acquireOrReplay: jest.fn().mockResolvedValue({
        status: 'acquired',
        lockedAt: new Date('2026-07-29T10:00:00.000Z'),
      }),
      abandonAcquiredKey: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AncillariesService(
      prisma as never,
      catalogService as never,
      idempotency as never,
      { createLog: jest.fn().mockResolvedValue({}) } as never,
    );

    await expect(
      service.commit('user-1', 'intent-1', 'commit-key-1', {
        expectedVersion: 3,
        catalogFingerprint: 'fingerprint-1',
        seats: [],
        baggage: [],
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_VERSION_CONFLICT',
        intentId: 'intent-1',
        currentVersion: 3,
      },
    });

    expect(transaction.ancillarySelection.create).not.toHaveBeenCalled();
  });
});
