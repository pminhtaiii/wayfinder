// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { AuditService } from '@/audit/audit.service';
import { PaymentIdempotencyService } from '@/idempotency/payment-idempotency.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AncillaryNormalizer } from '@/supplier/ancillary/ancillary.normalizer';
import { DuffelAncillaryAdapter } from '@/supplier/ancillary/duffel-ancillary.adapter';
import { DuffelAncillaryService } from '@/supplier/ancillary/duffel-ancillary.service';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import type { AncillaryCatalog } from '@shared/types';
import { AncillaryCatalogService } from './ancillary-catalog.service';
import { AncillariesService } from './ancillaries.service';
import { CommitAncillarySelectionDto } from './dto/commit-ancillary-selection.dto';

type BaggageFixture = {
  id: string;
  passengerId: string;
  amount: string;
  currency: string;
};

type RawOffer = {
  slices: Array<{
    segments: Array<{
      id: string;
      origin: { iata_code: string };
      destination: { iata_code: string };
    }>;
  }>;
  available_services: Array<{
    id: string;
    type: 'baggage';
    passenger_ids: string[];
    segment_ids: string[];
    total_amount: string;
    total_currency: string;
    metadata: {
      type: 'checked';
      weight: number;
      weight_unit: 'kg';
      maximum_quantity: number;
    };
  }>;
};

type CommitTransaction = {
  $queryRaw: jest.Mock;
  bookingIntent: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  ancillarySelection: {
    create: jest.Mock;
  };
  auditLog: {
    create: jest.Mock;
  };
  idempotencyKey: {
    update: jest.Mock;
  };
};

type CommitFixture = {
  service: AncillariesService;
  selectionCreate: jest.Mock;
  offerGet: jest.Mock;
  reserveAttempt: jest.Mock;
  catalogFingerprint: string;
};

const baggageFixtures: BaggageFixture[] = [
  { id: 'ase_bag_1', passengerId: 'pas_1', amount: '30.00', currency: 'USD' },
  { id: 'ase_bag_p2', passengerId: 'pas_2', amount: '30.00', currency: 'USD' },
  { id: 'ase_bag_eur', passengerId: 'pas_1', amount: '25.00', currency: 'EUR' },
];

const rawOffer = (services: BaggageFixture[]): RawOffer => ({
  slices: [
    {
      segments: [
        {
          id: 'seg_1',
          origin: { iata_code: 'SGN' },
          destination: { iata_code: 'SIN' },
        },
      ],
    },
  ],
  available_services: services.map((service) => ({
    id: service.id,
    type: 'baggage',
    passenger_ids: [service.passengerId],
    segment_ids: ['seg_1'],
    total_amount: service.amount,
    total_currency: service.currency,
    metadata: {
      type: 'checked',
      weight: 23,
      weight_unit: 'kg',
      maximum_quantity: 2,
    },
  })),
});

const catalogForFingerprint = (services: BaggageFixture[]): AncillaryCatalog => ({
  fetchedAt: '2026-10-01T00:00:00.000Z',
  cache: { status: 'MISS', ttlSeconds: 60 },
  segments: [
    {
      segmentId: 'seg_1',
      origin: 'SGN',
      destination: 'SIN',
      seatMapAvailable: false,
      seatMap: null,
    },
  ],
  baggageServices: services.map((service) => ({
    serviceId: service.id,
    passengerId: service.passengerId,
    segmentIds: ['seg_1'],
    type: 'checked',
    weightValue: 23,
    weightUnit: 'kg',
    maxQuantity: 2,
    amount: service.amount,
    currency: service.currency,
  })),
});

const createFixture = (services: BaggageFixture[] = baggageFixtures): CommitFixture => {
  // Exercise the real supplier capability; only SDK, budget, and cache boundaries are doubled.
  const offerGet = jest.fn().mockResolvedValue({ data: rawOffer(services) });
  const seatMapsGet = jest.fn().mockResolvedValue({ data: [] });
  const cache = {
    get: jest.fn().mockResolvedValue(null),
    getTtl: jest.fn().mockResolvedValue(-2),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const reserveAttempt = jest.fn().mockResolvedValue({ ok: true });
  const sdk = {
    seatMaps: { get: seatMapsGet },
    offers: { get: offerGet },
  } as unknown as Duffel;
  const ancillaryService = new DuffelAncillaryService(
    new DuffelAncillaryAdapter(sdk, { reserveAttempt } as unknown as DuffelRateBudgetService),
    new AncillaryNormalizer(),
    cache as unknown as CacheService,
  );
  const catalogService = new AncillaryCatalogService(ancillaryService);
  const intent = {
    id: 'intent-1',
    userId: 'user-1',
    status: 'PENDING',
    supplierOfferId: 'off_123',
    confirmedPrice: '420.00',
    currency: 'USD',
    ancillaryVersion: 0,
    currentAncillarySelectionId: null,
    currentAncillarySelection: null,
    intentExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    passengers: [
      {
        id: 'p1',
        givenName: 'Alex',
        type: 'ADULT',
        supplierPassengerId: 'pas_1',
        position: 0,
      },
      {
        id: 'p2',
        givenName: 'Blair',
        type: 'ADULT',
        supplierPassengerId: 'pas_2',
        position: 1,
      },
    ],
  };
  const selectionCreate = jest.fn().mockResolvedValue({ id: 'selection-1' });
  const transaction: CommitTransaction = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'intent-1' }]),
    bookingIntent: {
      findUnique: jest.fn().mockResolvedValue({
        ancillaryVersion: 0,
        currentAncillarySelection: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ancillarySelection: { create: selectionCreate },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    idempotencyKey: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    bookingIntent: { findUnique: jest.fn().mockResolvedValue(intent) },
    idempotencyKey: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(
      async (callback: (tx: CommitTransaction) => Promise<unknown>): Promise<unknown> =>
        callback(transaction),
    ),
  };
  const idempotency = new PaymentIdempotencyService(prisma as unknown as PrismaService);
  const audit = new AuditService(prisma as unknown as PrismaService);
  const service = new AncillariesService(
    prisma as unknown as PrismaService,
    catalogService,
    idempotency,
    audit,
  );

  return {
    service,
    selectionCreate,
    offerGet,
    reserveAttempt,
    catalogFingerprint: catalogService.fingerprint(catalogForFingerprint(services)),
  };
};

const commitDto = (
  catalogFingerprint: string,
  baggage: CommitAncillarySelectionDto['baggage'],
): CommitAncillarySelectionDto => ({
  expectedVersion: 0,
  catalogFingerprint,
  seats: [],
  baggage,
});

describe('AncillariesService commit parity', () => {
  it('uses the supplier catalog amount and currency for a valid owned selection', async () => {
    const fixture = createFixture();

    const result = await fixture.service.commit(
      'user-1',
      'intent-1',
      'key-valid',
      commitDto(fixture.catalogFingerprint, [
        { intentPassengerId: 'p1', serviceId: 'ase_bag_1', quantity: 2 },
      ]),
    );

    expect(result.selection.baggage).toEqual([
      {
        intentPassengerId: 'p1',
        serviceId: 'ase_bag_1',
        type: 'checked',
        weightValue: 23,
        weightUnit: 'kg',
        quantity: 2,
        amount: '30.00',
        currency: 'USD',
        segmentIds: ['seg_1'],
      },
    ]);
    expect(result.selection.totals).toEqual({
      seats: '0.00',
      baggage: '60.00',
      ancillaries: '60.00',
      estimatedGrandTotal: '480.00',
      currency: 'USD',
    });
    expect(fixture.selectionCreate).toHaveBeenCalledTimes(1);
    expect(fixture.offerGet).toHaveBeenCalledWith('off_123', {
      return_available_services: true,
    });
    expect(fixture.reserveAttempt).toHaveBeenCalledTimes(2);
  });

  it('rejects a catalog service owned by a different passenger with scoped details', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.commit(
        'user-1',
        'intent-1',
        'key-passenger-mismatch',
        commitDto(fixture.catalogFingerprint, [
          { intentPassengerId: 'p1', serviceId: 'ase_bag_p2', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_SCOPE_INVALID',
        invalidSelections: expect.arrayContaining([
          expect.objectContaining({
            kind: 'BAGGAGE',
            serviceId: 'ase_bag_p2',
            intentPassengerId: 'p1',
            reason: 'SERVICE_SCOPE_INVALID',
          }),
        ]),
      },
    });
    expect(fixture.selectionCreate).not.toHaveBeenCalled();
  });

  it('returns HTTP 400 for a catalog service owned by a different passenger', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.commit(
        'user-1',
        'intent-1',
        'key-passenger-mismatch-status',
        commitDto(fixture.catalogFingerprint, [
          { intentPassengerId: 'p1', serviceId: 'ase_bag_p2', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'ANCILLARY_SCOPE_INVALID',
        invalidSelections: expect.arrayContaining([
          expect.objectContaining({
            serviceId: 'ase_bag_p2',
            intentPassengerId: 'p1',
          }),
        ]),
      },
    });
  });

  it('rejects an unknown service identity with scoped details and no selection write', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.commit(
        'user-1',
        'intent-1',
        'key-unknown-service',
        commitDto(fixture.catalogFingerprint, [
          { intentPassengerId: 'p1', serviceId: 'ase_unknown', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_SCOPE_INVALID',
        invalidSelections: expect.arrayContaining([
          expect.objectContaining({
            kind: 'BAGGAGE',
            serviceId: 'ase_unknown',
            intentPassengerId: 'p1',
            reason: 'SERVICE_SCOPE_INVALID',
          }),
        ]),
      },
    });
    expect(fixture.selectionCreate).not.toHaveBeenCalled();
  });

  it('returns HTTP 400 for an unknown service identity', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.commit(
        'user-1',
        'intent-1',
        'key-unknown-service-status',
        commitDto(fixture.catalogFingerprint, [
          { intentPassengerId: 'p1', serviceId: 'ase_unknown', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      status: 400,
      response: {
        code: 'ANCILLARY_SCOPE_INVALID',
        invalidSelections: expect.arrayContaining([
          expect.objectContaining({
            serviceId: 'ase_unknown',
            intentPassengerId: 'p1',
          }),
        ]),
      },
    });
  });

  it('rejects a selected service whose catalog currency differs from the offer currency', async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.commit(
        'user-1',
        'intent-1',
        'key-currency-mismatch',
        commitDto(fixture.catalogFingerprint, [
          { intentPassengerId: 'p1', serviceId: 'ase_bag_eur', quantity: 1 },
        ]),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'ANCILLARY_CURRENCY_MISMATCH',
        invalidSelections: expect.arrayContaining([
          expect.objectContaining({
            kind: 'BAGGAGE',
            serviceId: 'ase_bag_eur',
            intentPassengerId: 'p1',
            reason: 'CURRENCY_MISMATCH',
          }),
        ]),
      },
    });
    expect(fixture.selectionCreate).not.toHaveBeenCalled();
  });
});
