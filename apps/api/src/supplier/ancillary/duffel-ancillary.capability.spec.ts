import { HttpException, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { AncillaryCatalog } from '@shared/types';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';
import { AncillaryNormalizer } from './ancillary.normalizer';
import { DuffelAncillaryService } from './duffel-ancillary.service';

const rawOffer = {
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
  available_services: [],
};
const rawOfferWithBaggage = {
  ...rawOffer,
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

type AncillaryCacheDouble = {
  getTtl: jest.Mock<Promise<number>, [string]>;
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<void>, [string, string, number?]>;
  checkAndIncrement: jest.Mock<
    Promise<{ allowed: boolean; current: number; storeError?: boolean }>,
    [
      { key: string; limit: number; ttlSeconds: number },
      { key: string; limit: number; ttlSeconds: number }?,
    ]
  >;
};

type AncillarySdkDouble = {
  seatMaps: {
    get: jest.Mock<Promise<{ data: unknown }>, [{ offer_id: string }]>;
  };
  offers: {
    get: jest.Mock<
      Promise<{ data: unknown }>,
      [string, { return_available_services: boolean }]
    >;
    getPriced: jest.Mock<
      Promise<{ data: unknown }>,
      [
        string,
        {
          intended_payment_methods: Array<{ type: 'card'; card_id: string }>;
          intended_services: Array<{ id: string; quantity: number }>;
        },
      ]
    >;
  };
};

type CapabilityHarness = {
  module: TestingModule;
  service: DuffelAncillaryService;
  cache: AncillaryCacheDouble;
  sdk: AncillarySdkDouble;
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function createHarness(): Promise<CapabilityHarness> {
  const cache: AncillaryCacheDouble = {
    getTtl: jest.fn<Promise<number>, [string]>().mockResolvedValue(-2),
    get: jest.fn<Promise<string | null>, [string]>().mockResolvedValue(null),
    set: jest.fn<Promise<void>, [string, string, number?]>().mockResolvedValue(undefined),
    checkAndIncrement: jest
      .fn<
        Promise<{ allowed: boolean; current: number; storeError?: boolean }>,
        [
          { key: string; limit: number; ttlSeconds: number },
          { key: string; limit: number; ttlSeconds: number }?,
        ]
      >()
      .mockResolvedValue({ allowed: true, current: 1 }),
  };
  const sdk: AncillarySdkDouble = {
    seatMaps: {
      get: jest.fn<Promise<{ data: unknown }>, [{ offer_id: string }]>().mockResolvedValue({
        data: [],
      }),
    },
    offers: {
      get: jest
        .fn<Promise<{ data: unknown }>, [string, { return_available_services: boolean }]>()
        .mockResolvedValue({ data: rawOffer }),
      getPriced: jest
        .fn<
          Promise<{ data: unknown }>,
          [
            string,
            {
              intended_payment_methods: Array<{ type: 'card'; card_id: string }>;
              intended_services: Array<{ id: string; quantity: number }>;
            },
          ]
        >()
        .mockResolvedValue({ data: {} }),
    },
  };
  const module = await Test.createTestingModule({
    providers: [
      DuffelAncillaryService,
      DuffelAncillaryAdapter,
      AncillaryNormalizer,
      DuffelRateBudgetService,
      // This double covers the adapter's required SDK subset; the real adapter, budget, and normalizer stay wired.
      { provide: DUFFEL_SDK, useValue: sdk as unknown as Duffel },
      { provide: CacheService, useValue: cache },
    ],
  }).compile();
  return { module, service: module.get(DuffelAncillaryService), cache, sdk };
}

describe('DuffelAncillaryService capability', () => {
  it('serves a fresh catalog cache hit without reserving budget or calling Duffel', async () => {
    const cachedCatalog: AncillaryCatalog = {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      cache: { status: 'MISS', ttlSeconds: 60 },
      segments: [],
      baggageServices: [],
    };
    const { module, service, cache, sdk } = await createHarness();
    cache.getTtl.mockResolvedValue(4);
    cache.get.mockResolvedValue(JSON.stringify(cachedCatalog));

    const catalog = await service.getSeatMapsAndServices('off_test');

    expect(catalog.cache).toEqual({ status: 'HIT', ttlSeconds: 4 });
    expect(cache.checkAndIncrement).not.toHaveBeenCalled();
    expect(sdk.seatMaps.get).not.toHaveBeenCalled();
    expect(sdk.offers.get).not.toHaveBeenCalled();
    await module.close();
  });

  it.each([3, 0])('fetches and caches a normalized catalog when TTL is %i', async (ttl) => {
    const { module, service, cache, sdk } = await createHarness();
    cache.getTtl.mockResolvedValue(ttl);

    const catalog = await service.getSeatMapsAndServices('off_test');

    expect(catalog.cache.status).toBe('MISS');
    expect(catalog.segments).toEqual([
      {
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: false,
        seatMap: null,
      },
    ]);
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    expect(sdk.seatMaps.get).toHaveBeenCalledWith({ offer_id: 'off_test' });
    expect(sdk.offers.get).toHaveBeenCalledWith('off_test', {
      return_available_services: true,
    });
    expect(cache.set).toHaveBeenCalledWith('seatmap:off_test', JSON.stringify(catalog), 60);
    await module.close();
  });

  it('fetches when a fresh TTL has no cached catalog value', async () => {
    const { module, service, cache, sdk } = await createHarness();
    cache.getTtl.mockResolvedValue(8);

    await service.getSeatMapsAndServices('off_test');

    expect(cache.get).toHaveBeenCalledWith('seatmap:off_test');
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    expect(sdk.offers.get).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it.each(['{', JSON.stringify({ segments: [] })])(
    'falls back to Duffel for invalid cached data: %s',
    async (cachedValue) => {
      const { module, service, cache, sdk } = await createHarness();
      cache.getTtl.mockResolvedValue(8);
      cache.get.mockResolvedValue(cachedValue);

      await service.getSeatMapsAndServices('off_test');

      expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
      expect(sdk.offers.get).toHaveBeenCalledTimes(1);
      await module.close();
    },
  );

  it('falls back to Duffel when a cache read fails', async () => {
    const { module, service, cache, sdk } = await createHarness();
    cache.getTtl.mockRejectedValue(new Error('cache internals'));

    await service.getSeatMapsAndServices('off_test');

    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    expect(sdk.offers.get).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('returns the fresh supplier catalog when writing the cache fails', async () => {
    const { module, service, cache } = await createHarness();
    cache.set.mockRejectedValue(new Error('cache internals'));

    const catalog = await service.getSeatMapsAndServices('off_test');

    expect(catalog.segments[0].segmentId).toBe('seg_1');
    await module.close();
  });

  it('skips cache reads when force refresh is requested', async () => {
    const { module, service, cache, sdk } = await createHarness();
    cache.getTtl.mockResolvedValue(30);
    cache.get.mockResolvedValue('invalid cache data');

    await service.getSeatMapsAndServices('off_test', true);

    expect(cache.getTtl).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    expect(sdk.offers.get).toHaveBeenCalledTimes(1);
    await module.close();
  });

  it('starts both supplier requests before either response settles', async () => {
    const { module, service, sdk } = await createHarness();
    const seatMaps = deferred<{ data: unknown }>();
    const offer = deferred<{ data: unknown }>();
    sdk.seatMaps.get.mockReturnValue(seatMaps.promise);
    sdk.offers.get.mockReturnValue(offer.promise);

    const lookup = service.getSeatMapsAndServices('off_test', true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sdk.seatMaps.get).toHaveBeenCalledTimes(1);
    expect(sdk.offers.get).toHaveBeenCalledTimes(1);
    seatMaps.resolve({ data: [] });
    offer.resolve({ data: rawOffer });
    await lookup;
    await module.close();
  });

  it('keeps baggage when the supplier returns no seat maps', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.get.mockResolvedValue({ data: rawOfferWithBaggage });

    const catalog = await service.getSeatMapsAndServices('off_test', true);

    expect(catalog.segments[0].seatMapAvailable).toBe(false);
    expect(catalog.baggageServices).toContainEqual(
      expect.objectContaining({ serviceId: 'ase_bag_1', amount: '30.00', currency: 'USD' }),
    );
    await module.close();
  });

  it.each([
    ['status', { status: 404 }],
    ['statusCode', { statusCode: 404 }],
    ['meta.status', { meta: { status: 404 } }],
    ['HttpException', new HttpException('missing', HttpStatus.NOT_FOUND)],
  ])('keeps baggage when seat map is absent with %s', async (_shape, error) => {
    const { module, service, sdk } = await createHarness();
    sdk.seatMaps.get.mockRejectedValue(error);
    sdk.offers.get.mockResolvedValue({ data: rawOfferWithBaggage });

    const catalog = await service.getSeatMapsAndServices('off_test', true);

    expect(catalog.segments[0].seatMapAvailable).toBe(false);
    expect(catalog.baggageServices).toContainEqual(
      expect.objectContaining({ serviceId: 'ase_bag_1', passengerId: 'pas_1' }),
    );
    await module.close();
  });

  it.each([
    ['offer 404', 'offer', { status: 404 }],
    ['seat-map 500', 'seatMap', { status: 500 }],
  ])('maps %s to a safe upstream error', async (_label, source, error) => {
    const { module, service, sdk } = await createHarness();
    if (source === 'offer') {
      sdk.offers.get.mockRejectedValue(error);
    } else {
      sdk.seatMaps.get.mockRejectedValue(error);
    }

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE' },
    });
    await module.close();
  });

  it.each([
    ['status', { status: 429 }],
    ['statusCode', { statusCode: 429 }],
    ['meta.status', { meta: { status: 429 } }],
    ['HttpException', new HttpException('supplier detail', HttpStatus.TOO_MANY_REQUESTS)],
  ])('maps supplier %s rate limits to UPSTREAM_RATE_LIMITED', async (_shape, error) => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.get.mockRejectedValue(error);

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'UPSTREAM_RATE_LIMITED' },
    });
    await module.close();
  });

  it('hides raw supplier messages when the catalog lookup fails', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.get.mockRejectedValue(new Error('supplier private response body'));

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE', message: expect.not.stringContaining('private') },
    });
    await module.close();
  });

  it.each([
    ['exhausted', { allowed: false, current: 1500 }, 'RATE_LIMIT_EXCEEDED'],
    ['store failure', { allowed: false, current: 0, storeError: true }, 'BUDGET_UNAVAILABLE'],
  ])('preserves %s budget errors and retry metadata', async (_label, admission, code) => {
    const { module, service, cache, sdk } = await createHarness();
    cache.checkAndIncrement.mockResolvedValue(admission);

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code, retryAfterSeconds: expect.any(Number) },
    });
    expect(sdk.seatMaps.get).not.toHaveBeenCalled();
    expect(sdk.offers.get).not.toHaveBeenCalled();
    await module.close();
  });

  it('makes no supplier calls when the second catalog reservation is denied', async () => {
    const { module, service, cache, sdk } = await createHarness();
    cache.checkAndIncrement
      .mockResolvedValueOnce({ allowed: true, current: 1 })
      .mockResolvedValueOnce({ allowed: false, current: 1 });

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'RATE_LIMIT_EXCEEDED' },
    });
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(2);
    // Human-approved 2026-10-02: retain legacy all-or-nothing catalog admission before SDK calls.
    expect(sdk.seatMaps.get).not.toHaveBeenCalled();
    expect(sdk.offers.get).not.toHaveBeenCalled();
    await module.close();
  });

  it('returns a safe 504 at the 4500 ms catalog deadline', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.seatMaps.get.mockImplementation(() => new Promise(() => undefined));
    sdk.offers.get.mockImplementation(() => new Promise(() => undefined));
    jest.useFakeTimers();
    const lookup = service.getSeatMapsAndServices('off_test', true);
    const outcome: { status: 'pending' | 'resolved' | 'rejected' } = { status: 'pending' };
    void lookup.then(
      () => {
        outcome.status = 'resolved';
      },
      () => {
        outcome.status = 'rejected';
      },
    );

    try {
      await jest.advanceTimersByTimeAsync(4500);
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        await expect(lookup).rejects.toMatchObject({
          status: HttpStatus.GATEWAY_TIMEOUT,
          response: { code: 'UPSTREAM_UNAVAILABLE' },
        });
      }
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await module.close();
      jest.useRealTimers();
    }
  });

  it('maps network timeout errors to a safe 504', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.get.mockRejectedValue({ code: 'ETIMEDOUT', message: 'private timeout detail' });

    await expect(service.getSeatMapsAndServices('off_test', true)).rejects.toMatchObject({
      status: HttpStatus.GATEWAY_TIMEOUT,
      response: { code: 'UPSTREAM_UNAVAILABLE' },
    });
    await module.close();
  });

  it.each(['success', 'failure'])('clears the catalog deadline timer after %s', async (result) => {
    const { module, service, sdk } = await createHarness();
    if (result === 'failure') {
      sdk.offers.get.mockRejectedValue(new Error('supplier failure'));
    }
    jest.useFakeTimers();
    const lookup = service.getSeatMapsAndServices('off_test', true);
    void lookup.catch(() => undefined);

    try {
      expect(jest.getTimerCount()).toBe(1);
      if (result === 'failure') {
        await expect(lookup).rejects.toMatchObject({
          status: HttpStatus.BAD_GATEWAY,
          response: { code: 'UPSTREAM_UNAVAILABLE' },
        });
      } else {
        await lookup;
      }
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await module.close();
      jest.useRealTimers();
    }
  });

  it('deduplicates repricing services in first-seen order and returns supplier prices verbatim', async () => {
    const { module, service, cache, sdk } = await createHarness();
    const intendedServices = [
      { serviceId: 'ase_bag_1', quantity: 1 },
      { serviceId: 'ase_seat_1', quantity: 1 },
      { serviceId: 'ase_bag_1', quantity: 2 },
    ];
    const originalServices = intendedServices.map((service) => ({ ...service }));
    sdk.offers.getPriced.mockResolvedValue({
      data: {
        total_amount: '100.005',
        base_amount: '80.50',
        total_currency: 'USD',
        service_lines: [
          { service_id: 'ase_bag_1', total_amount: '19.505', quantity: 3 },
          { service_id: 'ase_seat_1', total_amount: '0.00', quantity: 1 },
        ],
      },
    });

    const result = await service.repriceOffer('off_test', intendedServices);

    expect(sdk.offers.getPriced).toHaveBeenCalledWith('off_test', {
      intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
      intended_services: [
        { id: 'ase_bag_1', quantity: 3 },
        { id: 'ase_seat_1', quantity: 1 },
      ],
    });
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(1);
    expect(intendedServices).toEqual(originalServices);
    expect(result).toEqual({
      totalAmount: '100.005',
      baseAmount: '80.50',
      currency: 'USD',
      serviceLines: [
        { serviceId: 'ase_bag_1', amount: '19.505', quantity: 3 },
        { serviceId: 'ase_seat_1', amount: '0.00', quantity: 1 },
      ],
      invalidServiceIdentities: [],
    });
    await module.close();
  });

  it('returns identified invalid service identities from a raw supplier 400', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.getPriced.mockRejectedValue(
      Object.assign(new Error('Invalid intended service'), {
        status: 400,
        errors: [{ detail: 'Service ase_invalid_1 is invalid' }],
      }),
    );

    const result = await service.repriceOffer('off_test', [
      { serviceId: 'ase_invalid_1', quantity: 1 },
      { serviceId: 'ase_valid_2', quantity: 1 },
    ]);

    expect(result.invalidServiceIdentities).toEqual(['ase_invalid_1']);
    expect(result.totalAmount).toBe('0.00');
    await module.close();
  });

  it('falls back to all intended service identities for an unidentified supplier 400', async () => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.getPriced.mockRejectedValue(
      Object.assign(new Error('Invalid request'), { meta: { status: 400 } }),
    );

    const result = await service.repriceOffer('off_test', [
      { serviceId: 'ase_one', quantity: 1 },
      { serviceId: 'ase_two', quantity: 1 },
    ]);

    expect(result.invalidServiceIdentities).toEqual(['ase_one', 'ase_two']);
    await module.close();
  });

  it.each([
    ['status', { status: 429 }],
    ['statusCode', { statusCode: 429 }],
    ['meta.status', { meta: { status: 429 } }],
    ['HttpException', new HttpException('supplier detail', HttpStatus.TOO_MANY_REQUESTS)],
  ])('maps repricing supplier %s rate limits safely', async (_shape, error) => {
    const { module, service, sdk } = await createHarness();
    sdk.offers.getPriced.mockRejectedValue(error);

    await expect(service.repriceOffer('off_test', [])).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code: 'UPSTREAM_RATE_LIMITED' },
    });
    await module.close();
  });

  it.each([
    ['exhausted', { allowed: false, current: 1500 }, 'RATE_LIMIT_EXCEEDED'],
    ['store failure', { allowed: false, current: 0, storeError: true }, 'BUDGET_UNAVAILABLE'],
  ])('preserves repricing %s budget errors', async (_label, admission, code) => {
    const { module, service, cache, sdk } = await createHarness();
    cache.checkAndIncrement.mockResolvedValue(admission);

    await expect(service.repriceOffer('off_test', [])).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: { code, retryAfterSeconds: expect.any(Number) },
    });
    expect(cache.checkAndIncrement).toHaveBeenCalledTimes(1);
    expect(sdk.offers.getPriced).not.toHaveBeenCalled();
    await module.close();
  });

  it.each([
    ['supplier failure', new Error('supplier private response body')],
    [
      'malformed successful price',
      undefined,
    ],
  ])('maps repricing %s to a safe upstream error', async (_label, error) => {
    const { module, service, sdk } = await createHarness();
    if (error) {
      sdk.offers.getPriced.mockRejectedValue(error);
    } else {
      sdk.offers.getPriced.mockResolvedValue({ data: { total_amount: 'invalid' } });
    }

    await expect(service.repriceOffer('off_test', [])).rejects.toMatchObject({
      status: HttpStatus.BAD_GATEWAY,
      response: { code: 'UPSTREAM_UNAVAILABLE', message: expect.not.stringContaining('private') },
    });
    await module.close();
  });
});
