import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { CronExpression, ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { SupplierSearchModule } from './supplier-search.module';
import { FLIGHT_SEARCH_PORT, FlightSearchPort } from './flight-search.port';
import { DuffelSearchService } from './duffel-search.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import { FlightOfferNormalizer } from './flight-offer.normalizer';
import { FlightOfferCleanupService } from './flight-offer-cleanup.service';

describe('SupplierSearchModule & FlightOfferCleanupService (T020)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.DUFFEL_ACCESS_TOKEN = 'test_token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe('Strict Architectural Invariants & Port Encapsulation', () => {
    it('exports ONLY FLIGHT_SEARCH_PORT to enforce boundary encapsulation', () => {
      const exports = Reflect.getMetadata('exports', SupplierSearchModule) as unknown[];

      expect(exports).toBeDefined();
      expect(exports).toHaveLength(1);
      expect(exports[0]).toBe(FLIGHT_SEARCH_PORT);

      // Verify internal implementation services are strictly NOT exported
      expect(exports).not.toContain(DuffelSearchService);
      expect(exports).not.toContain(DuffelSearchAdapter);
      expect(exports).not.toContain(FlightOfferNormalizer);
      expect(exports).not.toContain(FlightOfferCleanupService);
    });

    it('declares all expected internal providers and the aliased FLIGHT_SEARCH_PORT provider', () => {
      const providers = Reflect.getMetadata('providers', SupplierSearchModule) as unknown[];

      expect(providers).toBeDefined();
      expect(providers).toEqual(
        expect.arrayContaining([
          DuffelSearchService,
          DuffelSearchAdapter,
          FlightOfferNormalizer,
          FlightOfferCleanupService,
          expect.objectContaining({
            provide: FLIGHT_SEARCH_PORT,
            useExisting: DuffelSearchService,
          }),
        ]),
      );
    });
  });

  describe('Module Compilation and Dependency Injection Resolution', () => {
    let moduleRef: TestingModule;
    const mockPrisma = {
      flightOffer: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      offerRecovery: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      searchHistory: {
        count: jest.fn().mockResolvedValue(0),
      },
    };

    const mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
    };

    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot(), SupplierSearchModule],
      })
        .overrideProvider(PrismaService)
        .useValue(mockPrisma)
        .overrideProvider(CacheService)
        .useValue(mockCache)
        .compile();
    });

    it('compiles successfully and resolves FLIGHT_SEARCH_PORT as an instance of DuffelSearchService', () => {
      const searchPort = moduleRef.get<FlightSearchPort>(FLIGHT_SEARCH_PORT);

      expect(searchPort).toBeDefined();
      expect(searchPort).toBeInstanceOf(DuffelSearchService);
      expect(typeof searchPort.search).toBe('function');
      expect(typeof searchPort.getOfferById).toBe('function');
      expect(typeof searchPort.normalizeStoredOffer).toBe('function');
    });

    it('resolves FLIGHT_SEARCH_PORT to the exact same instance as DuffelSearchService via useExisting', () => {
      const searchPort = moduleRef.get<FlightSearchPort>(FLIGHT_SEARCH_PORT);
      const concreteService = moduleRef.get<DuffelSearchService>(DuffelSearchService);

      expect(searchPort).toBe(concreteService);
    });

    it('resolves internal FlightOfferCleanupService within the module context', () => {
      const cleanupService = moduleRef.get<FlightOfferCleanupService>(FlightOfferCleanupService);

      expect(cleanupService).toBeDefined();
      expect(cleanupService).toBeInstanceOf(FlightOfferCleanupService);
      expect(typeof cleanupService.handleCleanup).toBe('function');
    });
  });

  describe('Cron De-duplication Verification', () => {
    it('attaches @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) to FlightOfferCleanupService.handleCleanup', () => {
      const cronOptions = Reflect.getMetadata(
        SCHEDULE_CRON_OPTIONS,
        FlightOfferCleanupService.prototype.handleCleanup,
      ) as { cronTime?: string } | undefined;

      expect(cronOptions).toBeDefined();
      expect(cronOptions?.cronTime).toBe(CronExpression.EVERY_DAY_AT_MIDNIGHT);
    });

  });

  describe('FlightOfferCleanupService.handleCleanup()', () => {
    let cleanupService: FlightOfferCleanupService;
    let prismaMock: {
      flightOffer: { deleteMany: jest.Mock };
      offerRecovery: { deleteMany: jest.Mock };
      searchHistory: { count: jest.Mock };
    };

    beforeEach(() => {
      prismaMock = {
        flightOffer: {
          deleteMany: jest.fn().mockResolvedValue({ count: 12 }),
        },
        offerRecovery: {
          deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
        },
        searchHistory: {
          count: jest.fn().mockResolvedValue(500),
        },
      };

      cleanupService = new FlightOfferCleanupService(
        prismaMock as unknown as PrismaService,
      );
    });

    it('purges expired flight offers and recoveries with default retention (7 days and 30 days) and preserves search history', async () => {
      const beforeCall = new Date();
      await cleanupService.handleCleanup();
      const afterCall = new Date();

      expect(prismaMock.flightOffer.deleteMany).toHaveBeenCalledTimes(1);
      const offerCallArg = prismaMock.flightOffer.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffOffer = offerCallArg.where.createdAt.lt;
      const expectedOfferMin = new Date(beforeCall.getTime() - 7 * 24 * 60 * 60 * 1000);
      const expectedOfferMax = new Date(afterCall.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(cutoffOffer.getTime()).toBeGreaterThanOrEqual(expectedOfferMin.getTime() - 1000);
      expect(cutoffOffer.getTime()).toBeLessThanOrEqual(expectedOfferMax.getTime() + 1000);

      expect(prismaMock.offerRecovery.deleteMany).toHaveBeenCalledTimes(1);
      const recoveryCallArg = prismaMock.offerRecovery.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffRecovery = recoveryCallArg.where.createdAt.lt;
      const expectedRecMin = new Date(beforeCall.getTime() - 30 * 24 * 60 * 60 * 1000);
      const expectedRecMax = new Date(afterCall.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(cutoffRecovery.getTime()).toBeGreaterThanOrEqual(expectedRecMin.getTime() - 1000);
      expect(cutoffRecovery.getTime()).toBeLessThanOrEqual(expectedRecMax.getTime() + 1000);

      expect(prismaMock.searchHistory.count).toHaveBeenCalledTimes(1);
    });

    it('respects custom retention days configured via environment variables', async () => {
      process.env.FLIGHT_OFFERS_RETENTION_DAYS = '3';
      process.env.OFFER_RECOVERY_RETENTION_DAYS = '10';

      const beforeCall = new Date();
      await cleanupService.handleCleanup();
      const afterCall = new Date();

      const offerCallArg = prismaMock.flightOffer.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffOffer = offerCallArg.where.createdAt.lt;
      const expectedOfferMin = new Date(beforeCall.getTime() - 3 * 24 * 60 * 60 * 1000);
      const expectedOfferMax = new Date(afterCall.getTime() - 3 * 24 * 60 * 60 * 1000);
      expect(cutoffOffer.getTime()).toBeGreaterThanOrEqual(expectedOfferMin.getTime() - 1000);
      expect(cutoffOffer.getTime()).toBeLessThanOrEqual(expectedOfferMax.getTime() + 1000);

      const recoveryCallArg = prismaMock.offerRecovery.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffRecovery = recoveryCallArg.where.createdAt.lt;
      const expectedRecMin = new Date(beforeCall.getTime() - 10 * 24 * 60 * 60 * 1000);
      const expectedRecMax = new Date(afterCall.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(cutoffRecovery.getTime()).toBeGreaterThanOrEqual(expectedRecMin.getTime() - 1000);
      expect(cutoffRecovery.getTime()).toBeLessThanOrEqual(expectedRecMax.getTime() + 1000);
    });

    it('falls back to default retention days when environment variables are invalid or negative', async () => {
      process.env.FLIGHT_OFFERS_RETENTION_DAYS = 'not-a-number';
      process.env.OFFER_RECOVERY_RETENTION_DAYS = '-5';

      const beforeCall = new Date();
      await cleanupService.handleCleanup();
      const afterCall = new Date();

      const offerCallArg = prismaMock.flightOffer.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffOffer = offerCallArg.where.createdAt.lt;
      const expectedOfferMin = new Date(beforeCall.getTime() - 7 * 24 * 60 * 60 * 1000);
      const expectedOfferMax = new Date(afterCall.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(cutoffOffer.getTime()).toBeGreaterThanOrEqual(expectedOfferMin.getTime() - 1000);
      expect(cutoffOffer.getTime()).toBeLessThanOrEqual(expectedOfferMax.getTime() + 1000);

      const recoveryCallArg = prismaMock.offerRecovery.deleteMany.mock.calls[0][0] as {
        where: { createdAt: { lt: Date } };
      };
      const cutoffRecovery = recoveryCallArg.where.createdAt.lt;
      const expectedRecMin = new Date(beforeCall.getTime() - 30 * 24 * 60 * 60 * 1000);
      const expectedRecMax = new Date(afterCall.getTime() - 30 * 24 * 60 * 60 * 1000);
      expect(cutoffRecovery.getTime()).toBeGreaterThanOrEqual(expectedRecMin.getTime() - 1000);
      expect(cutoffRecovery.getTime()).toBeLessThanOrEqual(expectedRecMax.getTime() + 1000);
    });

    it('catches database errors gracefully without throwing an unhandled exception', async () => {
      prismaMock.flightOffer.deleteMany.mockRejectedValueOnce(new Error('Prisma connection timeout'));

      await expect(cleanupService.handleCleanup()).resolves.toBeUndefined();
    });
  });
});
