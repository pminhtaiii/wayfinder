import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import {
  BudgetReservationResult,
  DuffelRateBudgetService,
} from '@/supplier/core/duffel-rate-budget.service';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { AncillaryCatalog } from '@shared/types';
import { AncillaryNormalizer } from './ancillary.normalizer';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';
import { DuffelAncillaryService } from './duffel-ancillary.service';

type RawSeatMap = Record<string, unknown>;
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
    type: string;
    passenger_ids: string[];
    segment_ids: string[];
    total_amount: string;
    total_currency: string;
    metadata: {
      type: string;
      weight: number;
      weight_unit: string;
      maximum_quantity: number;
    };
  }>;
};

const mockSeatMapsGet = jest.fn<Promise<{ data: RawSeatMap[] }>, [{ offer_id: string }]>();
const mockOffersGet = jest.fn<
  Promise<{ data: RawOffer }>,
  [string, { return_available_services: boolean }]
>();

const rawOffer: RawOffer = {
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
  available_services: [
    {
      id: 'ase_bag_1',
      type: 'baggage',
      passenger_ids: ['pas_1'],
      segment_ids: ['seg_1'],
      total_amount: '30.00',
      total_currency: 'USD',
      metadata: {
        type: 'checked',
        weight: 23,
        weight_unit: 'kg',
        maximum_quantity: 2,
      },
    },
  ],
};

const missingSeatMapCatalog = (): AncillaryCatalog => ({
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
  baggageServices: [
    {
      serviceId: 'ase_bag_1',
      passengerId: 'pas_1',
      segmentIds: ['seg_1'],
      type: 'checked',
      weightValue: 23,
      weightUnit: 'kg',
      maxQuantity: 2,
      amount: '30.00',
      currency: 'USD',
    },
  ],
});

const deferred = <T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} => {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

describe('DuffelAncillaryService catalog contract', () => {
  let moduleRef: TestingModule | undefined;
  let service: DuffelAncillaryService;
  let cache: jest.Mocked<Pick<CacheService, 'get' | 'set' | 'getTtl'>>;
  let rateBudget: jest.Mocked<Pick<DuffelRateBudgetService, 'reserveAttempt'>>;

  beforeEach(async (): Promise<void> => {
    mockSeatMapsGet.mockReset();
    mockOffersGet.mockReset();
    cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      getTtl: jest.fn().mockResolvedValue(-2),
    };
    rateBudget = {
      reserveAttempt: jest.fn<
        Promise<BudgetReservationResult>,
        [{ key: string; limit: number }?]
      >().mockResolvedValue({ ok: true }),
    };

    const sdk = {
      seatMaps: { get: mockSeatMapsGet },
      offers: { get: mockOffersGet },
    };
    moduleRef = await Test.createTestingModule({
      providers: [
        DuffelAncillaryService,
        DuffelAncillaryAdapter,
        AncillaryNormalizer,
        { provide: DUFFEL_SDK, useValue: sdk },
        { provide: DuffelRateBudgetService, useValue: rateBudget },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = moduleRef.get(DuffelAncillaryService);
  });

  afterEach(async (): Promise<void> => {
    await moduleRef?.close();
    moduleRef = undefined;
  });

  it('returns a seat-map-unavailable segment while retaining baggage on a supplier 404', async () => {
    mockSeatMapsGet.mockRejectedValue({ status: 404, message: 'Seat map not found' });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const catalog = await service.getSeatMapsAndServices('off_123', true);

    expect(catalog.segments).toEqual([
      {
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: false,
        seatMap: null,
      },
    ]);
    expect(catalog.baggageServices).toContainEqual(
      expect.objectContaining({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        amount: '30.00',
        currency: 'USD',
      }),
    );
  });

  it('returns cache metadata for a TTL 4 hit without reserving or calling the supplier', async () => {
    cache.getTtl.mockResolvedValue(4);
    cache.get.mockResolvedValue(JSON.stringify(missingSeatMapCatalog()));

    const catalog = await service.getSeatMapsAndServices('off_123');

    expect(catalog.cache).toEqual({ status: 'HIT', ttlSeconds: 4 });
    expect(rateBudget.reserveAttempt).not.toHaveBeenCalled();
    expect(mockSeatMapsGet).not.toHaveBeenCalled();
    expect(mockOffersGet).not.toHaveBeenCalled();
  });

  it.each([3, 0])('fetches both supplier endpoints and meters twice at TTL %s', async (ttl) => {
    cache.getTtl.mockResolvedValue(ttl);
    mockSeatMapsGet.mockResolvedValue({ data: [] });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    await service.getSeatMapsAndServices('off_123');

    expect(rateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
    expect(mockSeatMapsGet).toHaveBeenCalledWith({ offer_id: 'off_123' });
    expect(mockOffersGet).toHaveBeenCalledWith('off_123', {
      return_available_services: true,
    });
  });

  it('fetches both supplier endpoints when force refresh bypasses a fresh cache', async () => {
    cache.getTtl.mockResolvedValue(30);
    mockSeatMapsGet.mockResolvedValue({ data: [] });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    await service.getSeatMapsAndServices('off_123', true);

    expect(rateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
    expect(mockSeatMapsGet).toHaveBeenCalledTimes(1);
    expect(mockOffersGet).toHaveBeenCalledTimes(1);
  });

  it('starts the seat-map and offer lookups before either supplier response settles', async () => {
    const seatMaps = deferred<{ data: RawSeatMap[] }>();
    const offer = deferred<{ data: RawOffer }>();
    let seatMapsStarted = false;
    let offerStarted = false;
    mockSeatMapsGet.mockImplementation(() => {
      seatMapsStarted = true;
      return seatMaps.promise;
    });
    mockOffersGet.mockImplementation(() => {
      offerStarted = true;
      return offer.promise;
    });

    const lookup = service.getSeatMapsAndServices('off_123', true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(seatMapsStarted).toBe(true);
    expect(offerStarted).toBe(true);
    seatMaps.resolve({ data: [] });
    offer.resolve({ data: rawOffer });
    await lookup;
  });

  it('makes no supplier calls when the first budget reservation is exhausted', async () => {
    rateBudget.reserveAttempt.mockResolvedValue({
      ok: false,
      error: 'EXHAUSTED',
      retryAfterSeconds: 60,
      resetAt: '2026-10-02T00:00:00.000Z',
    });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'RATE_LIMIT_EXCEEDED' },
    });
    expect(rateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(mockSeatMapsGet).not.toHaveBeenCalled();
    expect(mockOffersGet).not.toHaveBeenCalled();
  });

  it('makes no supplier calls when the first budget reservation is unavailable', async () => {
    rateBudget.reserveAttempt.mockResolvedValue({
      ok: false,
      error: 'UNAVAILABLE',
      retryAfterSeconds: 60,
    });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'BUDGET_UNAVAILABLE' },
    });
    expect(rateBudget.reserveAttempt).toHaveBeenCalledTimes(1);
    expect(mockSeatMapsGet).not.toHaveBeenCalled();
    expect(mockOffersGet).not.toHaveBeenCalled();
  });

  it('makes no supplier calls when the second budget reservation is denied', async () => {
    rateBudget.reserveAttempt
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 60,
        resetAt: '2026-10-02T00:00:00.000Z',
      });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'RATE_LIMIT_EXCEEDED' },
    });
    expect(rateBudget.reserveAttempt).toHaveBeenCalledTimes(2);
    expect(mockSeatMapsGet).not.toHaveBeenCalled();
    expect(mockOffersGet).not.toHaveBeenCalled();
  });

  it('keeps baggage services when the supplier returns an empty seat-map list', async () => {
    mockSeatMapsGet.mockResolvedValue({ data: [] });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const catalog = await service.getSeatMapsAndServices('off_123', true);

    expect(catalog.segments[0]).toEqual({
      segmentId: 'seg_1',
      origin: 'SGN',
      destination: 'SIN',
      seatMapAvailable: false,
      seatMap: null,
    });
    expect(catalog.baggageServices).toContainEqual(
      expect.objectContaining({ serviceId: 'ase_bag_1', passengerId: 'pas_1' }),
    );
  });

  it('treats a seat-map statusCode 404 as an unavailable map', async () => {
    mockSeatMapsGet.mockRejectedValue({ statusCode: 404, message: 'Seat map not found' });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const catalog = await service.getSeatMapsAndServices('off_123', true);

    expect(catalog.segments[0].seatMapAvailable).toBe(false);
    expect(catalog.baggageServices).toHaveLength(1);
  });

  it('treats an HttpException 404 as an unavailable map', async () => {
    mockSeatMapsGet.mockRejectedValue(new HttpException('Seat map not found', HttpStatus.NOT_FOUND));
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const catalog = await service.getSeatMapsAndServices('off_123', true);

    expect(catalog.segments[0].seatMapAvailable).toBe(false);
    expect(catalog.baggageServices).toHaveLength(1);
  });

  it('treats the installed SDK meta.status 404 as an unavailable map', async () => {
    mockSeatMapsGet.mockRejectedValue({
      meta: { status: 404 },
      message: 'Seat map not found',
    });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const catalog = await service.getSeatMapsAndServices('off_123', true);

    expect(catalog.segments[0].seatMapAvailable).toBe(false);
    expect(catalog.segments[0].seatMap).toBeNull();
    expect(catalog.baggageServices).toContainEqual(
      expect.objectContaining({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        amount: '30.00',
        currency: 'USD',
      }),
    );
  });

  it('propagates a seat-map 500 as UPSTREAM_UNAVAILABLE', async () => {
    mockSeatMapsGet.mockRejectedValue({ status: 500, message: 'Supplier internal failure' });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE' },
    });
  });

  it('propagates the installed SDK meta.status 500 as UPSTREAM_UNAVAILABLE', async () => {
    mockSeatMapsGet.mockRejectedValue({
      meta: { status: 500 },
      message: 'Supplier internal failure',
    });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE' },
    });
  });

  it('propagates an offer 404 instead of treating it as a missing seat map', async () => {
    mockSeatMapsGet.mockResolvedValue({ data: [] });
    mockOffersGet.mockRejectedValue({ status: 404, message: 'Offer not found' });

    await expect(service.getSeatMapsAndServices('off_123', true)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE' },
    });
  });
});
