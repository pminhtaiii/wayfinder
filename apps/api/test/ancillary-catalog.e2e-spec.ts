import { CanActivate, ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { Duffel } from '@duffel/api';
import { CacheService } from '@/cache/cache.service';
import { PrismaService } from '@/prisma/prisma.service';
import { AncillariesModule } from '@/ancillaries/ancillaries.module';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { JwtAuthGuard } from '@/auth/guards/jwt-auth.guard';

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

const intentId = '11111111-1111-4111-8111-111111111111';
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

describe('Ancillary catalog HTTP contract (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let cacheBoundary: {
    get: jest.Mock<Promise<string | null>, [string]>;
    set: jest.Mock<Promise<void>, [string, string, number?]>;
    getTtl: jest.Mock<Promise<number>, [string]>;
    checkAndIncrement: jest.Mock<
      Promise<{ allowed: boolean; current: number; storeError?: boolean }>,
      [
        { key: string; limit: number; ttlSeconds: number },
        { key: string; limit: number; ttlSeconds: number }?
      ]
    >;
  };
  let prismaBoundary: {
    bookingIntent: { findUnique: jest.Mock<Promise<unknown>, [unknown]> };
  };
  let mockSeatMapsGet: jest.Mock<Promise<{ data: Record<string, unknown>[] }>, [{ offer_id: string }]>;
  let mockOffersGet: jest.Mock<
    Promise<{ data: RawOffer }>,
    [string, { return_available_services: boolean }]
  >;
  const originalEnvironment = {
    nodeEnv: process.env.NODE_ENV,
    duffelToken: process.env.DUFFEL_ACCESS_TOKEN,
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.DUFFEL_ACCESS_TOKEN = 'test-token';

    cacheBoundary = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue(undefined),
      getTtl: jest.fn(),
      checkAndIncrement: jest.fn(),
    };
    prismaBoundary = {
      bookingIntent: { findUnique: jest.fn() },
    };
    mockSeatMapsGet = jest.fn();
    mockOffersGet = jest.fn();

    const sdk = {
      seatMaps: { get: mockSeatMapsGet },
      offers: { get: mockOffersGet },
    } as unknown as Duffel;
    const authGuard: CanActivate = {
      canActivate(context: ExecutionContext): boolean {
        const httpRequest = context.switchToHttp().getRequest<{ user?: { id: string } }>();
        httpRequest.user = { id: 'user-1' };
        return true;
      },
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AncillariesModule],
    })
      // These doubles implement only external persistence/cache/SDK methods reached by GET.
      .overrideProvider(PrismaService)
      .useValue(prismaBoundary)
      .overrideProvider(CacheService)
      .useValue(cacheBoundary)
      .overrideProvider(DUFFEL_SDK)
      .useValue(sdk)
      .overrideGuard(JwtAuthGuard)
      .useValue(authGuard)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    cacheBoundary.get.mockResolvedValue(null);
    cacheBoundary.getTtl.mockResolvedValue(-2);
    cacheBoundary.checkAndIncrement.mockResolvedValue({ allowed: true, current: 1 });
    prismaBoundary.bookingIntent.findUnique.mockResolvedValue({
      id: intentId,
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
          id: 'intent-pas-1',
          position: 0,
          supplierPassengerId: 'pas_1',
          givenName: 'Alex',
          type: 'ADULT',
        },
      ],
    });
    mockSeatMapsGet.mockReset();
    mockOffersGet.mockReset();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
    if (originalEnvironment.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment.nodeEnv;
    if (originalEnvironment.duffelToken === undefined) delete process.env.DUFFEL_ACCESS_TOKEN;
    else process.env.DUFFEL_ACCESS_TOKEN = originalEnvironment.duffelToken;
  });

  it('returns 200 with missing seats and retained baggage when seat maps return 404', async () => {
    mockSeatMapsGet.mockRejectedValue({ status: 404, message: 'Seat map not found' });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const response = await request(app.getHttpServer())
      .get(`/bookings/intent/${intentId}/ancillaries`)
      .query({ refresh: true })
      .expect(200);

    expect(response.body.catalog.segments).toEqual([
      {
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: false,
        seatMap: null,
      },
    ]);
    expect(response.body.catalog.baggageServices).toContainEqual(
      expect.objectContaining({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        amount: '30.00',
        currency: 'USD',
      }),
    );
    expect(cacheBoundary.checkAndIncrement).toHaveBeenCalledTimes(2);
  });

  it('returns 200 with missing seats and retained baggage for an SDK meta.status 404', async () => {
    mockSeatMapsGet.mockRejectedValue({
      meta: { status: 404 },
      message: 'Seat map not found',
    });
    mockOffersGet.mockResolvedValue({ data: rawOffer });

    const response = await request(app.getHttpServer())
      .get(`/bookings/intent/${intentId}/ancillaries`)
      .query({ refresh: true })
      .expect(200);

    expect(response.body.catalog.segments).toEqual([
      {
        segmentId: 'seg_1',
        origin: 'SGN',
        destination: 'SIN',
        seatMapAvailable: false,
        seatMap: null,
      },
    ]);
    expect(response.body.catalog.baggageServices).toContainEqual(
      expect.objectContaining({
        serviceId: 'ase_bag_1',
        passengerId: 'pas_1',
        amount: '30.00',
        currency: 'USD',
      }),
    );
  });

  it('returns 429 without an upstream call when the real budget denies the operation', async () => {
    cacheBoundary.checkAndIncrement.mockResolvedValue({ allowed: false, current: 1500 });

    await request(app.getHttpServer())
      .get(`/bookings/intent/${intentId}/ancillaries`)
      .query({ refresh: true })
      .expect(429);

    expect(mockSeatMapsGet).not.toHaveBeenCalled();
    expect(mockOffersGet).not.toHaveBeenCalled();
  });
});
