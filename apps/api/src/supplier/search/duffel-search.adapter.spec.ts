import {
  HttpException,
  HttpStatus,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK, DuffelRateBudgetService } from '@/supplier/core/duffel-core.module';
import { DuffelSearchAdapter, DuffelTimeoutError } from './duffel-search.adapter';
import { FlightSearchCriteria } from './flight-search.port';

function isInjectionClass(value: unknown): value is Type<unknown> {
  return typeof value === 'function';
}

describe('DuffelSearchAdapter', () => {
  let adapter: DuffelSearchAdapter;
  let mockOfferRequestsCreate: jest.Mock<Promise<{ data: unknown }>, [unknown]>;
  let mockOffersGet: jest.Mock<Promise<{ data: unknown }>, [string]>;
  let mockDuffel: Duffel;
  let mockReserveAttempt: jest.Mock<
    Promise<
      | { ok: true }
      | { ok: false; error: 'EXHAUSTED'; retryAfterSeconds: number; resetAt: string }
      | { ok: false; error: 'UNAVAILABLE'; retryAfterSeconds: number }
    >,
    [unknown?]
  >;
  let mockBudgetService: DuffelRateBudgetService;

  beforeEach(() => {
    mockOfferRequestsCreate = jest.fn();
    mockOffersGet = jest.fn();

    mockDuffel = {
      offerRequests: {
        create: mockOfferRequestsCreate,
      },
      offers: {
        get: mockOffersGet,
      },
    } as unknown as Duffel;

    mockReserveAttempt = jest.fn();
    mockBudgetService = {
      reserveAttempt: mockReserveAttempt,
    } as unknown as DuffelRateBudgetService;

    adapter = new DuffelSearchAdapter(mockDuffel, mockBudgetService);
  });

  it('uses the injected SDK when a legacy provider also has an SDK client', async (): Promise<void> => {
    const constructorParams: unknown = Reflect.getMetadata(
      'design:paramtypes',
      DuffelSearchAdapter,
    );
    const legacyProvider =
      Array.isArray(constructorParams) && isInjectionClass(constructorParams[2])
        ? constructorParams[2]
        : Symbol('legacy provider');
    const legacyOfferRequestsCreate = jest
      .fn<Promise<{ data: unknown }>, [unknown]>()
      .mockResolvedValue({ data: { id: 'legacy' } });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DuffelSearchAdapter,
        { provide: DUFFEL_SDK, useValue: mockDuffel },
        { provide: DuffelRateBudgetService, useValue: mockBudgetService },
        {
          provide: legacyProvider,
          useValue: { duffel: { offerRequests: { create: legacyOfferRequestsCreate } } },
        },
      ],
    }).compile();

    try {
      mockOfferRequestsCreate.mockResolvedValueOnce({ data: { id: 'injected' } });
      const adapterWithLegacyProvider = moduleRef.get(DuffelSearchAdapter);

      await adapterWithLegacyProvider.searchOffers({
        origin: 'SFO',
        destination: 'JFK',
        departureDate: '2026-10-01',
        adults: 1,
      });

      expect(mockOfferRequestsCreate).toHaveBeenCalledTimes(1);
      expect(legacyOfferRequestsCreate).not.toHaveBeenCalled();
    } finally {
      await moduleRef.close();
    }
  });

  describe('searchOffers', () => {
    const oneWayCriteria: FlightSearchCriteria = {
      origin: '  sfo ',
      destination: ' jfk  ',
      departureDate: '2026-10-01',
      adults: 1,
      cabinClass: 'economy',
    };

    it('maps one-way flight criteria correctly into slices, passengers, and cabin class', async () => {
      const mockRawResponse = {
        id: 'or_test_123',
        slices: [],
        passengers: [{ id: 'pas_1', type: 'adult' }],
        offers: [],
      };
      mockOfferRequestsCreate.mockResolvedValueOnce({ data: mockRawResponse });

      const result = await adapter.searchOffers(oneWayCriteria);

      expect(mockOfferRequestsCreate).toHaveBeenCalledTimes(1);
      expect(mockOfferRequestsCreate).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'SFO',
            destination: 'JFK',
            departure_date: '2026-10-01',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      });
      expect(result).toEqual(mockRawResponse);
    });

    it('maps round-trip flight criteria with return slice having reversed origin and destination', async () => {
      const roundTripCriteria: FlightSearchCriteria = {
        origin: 'sfo',
        destination: 'jfk',
        departureDate: '2026-10-01',
        returnDate: '2026-10-10',
        adults: 1,
        cabinClass: 'economy',
      };

      mockOfferRequestsCreate.mockResolvedValueOnce({ data: { id: 'or_roundtrip' } });

      await adapter.searchOffers(roundTripCriteria);

      expect(mockOfferRequestsCreate).toHaveBeenCalledWith({
        slices: [
          {
            origin: 'SFO',
            destination: 'JFK',
            departure_date: '2026-10-01',
            arrival_time: null,
            departure_time: null,
          },
          {
            origin: 'JFK',
            destination: 'SFO',
            departure_date: '2026-10-10',
            arrival_time: null,
            departure_time: null,
          },
        ],
        passengers: [{ type: 'adult' }],
        cabin_class: 'economy',
      });
    });

    it('maps multiple passengers (adults, children, infants) into Duffel types correctly', async () => {
      const multiPassengerCriteria: FlightSearchCriteria = {
        origin: 'LAX',
        destination: 'ORD',
        departureDate: '2026-11-15',
        adults: 2,
        children: 1,
        infants: 1,
      };

      mockOfferRequestsCreate.mockResolvedValueOnce({ data: { id: 'or_family' } });

      await adapter.searchOffers(multiPassengerCriteria);

      expect(mockOfferRequestsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          passengers: [
            { type: 'adult' },
            { type: 'adult' },
            { type: 'child' },
            { type: 'infant_without_seat' },
          ],
        }),
      );
    });

    it.each([
      ['business', 'business'],
      ['first', 'first'],
      ['premium_economy', 'premium_economy'],
      ['economy', 'economy'],
      ['BUSINESS', 'business'],
      ['FIRST', 'first'],
      [undefined, 'economy'],
      ['invalid_cabin', 'economy'],
    ])('maps cabin class "%s" to "%s"', async (inputCabin, expectedCabin) => {
      mockOfferRequestsCreate.mockResolvedValueOnce({ data: { id: 'or_cabin_test' } });

      await adapter.searchOffers({
        origin: 'SFO',
        destination: 'JFK',
        departureDate: '2026-10-01',
        adults: 1,
        cabinClass: inputCabin,
      });

      expect(mockOfferRequestsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          cabin_class: expectedCabin,
        }),
      );
    });

    it('returns mock response fallback when DUFFEL_MOCK is set to true', async () => {
      const prevMock = process.env.DUFFEL_MOCK;
      try {
        process.env.DUFFEL_MOCK = 'true';

        const result = (await adapter.searchOffers({
          origin: 'SGN',
          destination: 'SIN',
          departureDate: '2026-12-01',
          returnDate: '2026-12-10',
          adults: 2,
          children: 1,
          infants: 1,
          cabinClass: 'business',
        })) as {
          id: string;
          slices: Array<{ origin: { iata_code: string }; destination: { iata_code: string } }>;
          passengers: Array<{ id: string; type: string }>;
          offers: Array<{ id: string; total_amount: string; total_currency: string }>;
        };

        expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
        expect(result.id).toBe('or_mock_123');
        expect(result.slices).toHaveLength(2);
        expect(result.slices[0].origin.iata_code).toBe('SGN');
        expect(result.slices[0].destination.iata_code).toBe('SIN');
        expect(result.slices[1].origin.iata_code).toBe('SIN');
        expect(result.slices[1].destination.iata_code).toBe('SGN');
        expect(result.passengers).toHaveLength(4);
        expect(result.offers).toHaveLength(1);
        expect(result.offers[0].id).toBe('off_mock_123');
        expect(result.offers[0].total_amount).toBe('125.50');
        expect(result.offers[0].total_currency).toBe('USD');
        await expect(adapter.getOffer(result.offers[0].id)).resolves.toEqual(result.offers[0]);
        expect(mockOffersGet).not.toHaveBeenCalled();
        expect(mockReserveAttempt).not.toHaveBeenCalled();
      } finally {
        if (prevMock !== undefined) {
          process.env.DUFFEL_MOCK = prevMock;
        } else {
          delete process.env.DUFFEL_MOCK;
        }
      }
    });

    it('returns mock response fallback when token is mock and not in Jest worker', async () => {
      const prevJest = process.env.JEST_WORKER_ID;
      const prevToken = process.env.DUFFEL_ACCESS_TOKEN;
      const prevUrl = process.env.DUFFEL_API_URL;
      const prevNodeEnv = process.env.NODE_ENV;
      try {
        delete process.env.JEST_WORKER_ID;
        delete process.env.DUFFEL_API_URL;
        process.env.NODE_ENV = 'test';
        process.env.DUFFEL_ACCESS_TOKEN = 'mock';

        const result = (await adapter.searchOffers(oneWayCriteria)) as {
          id: string;
          offers: Array<{ id: string }>;
        };

        expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
        expect(result.id).toBe('or_mock_123');
        expect(result.offers).toHaveLength(1);
        await expect(adapter.getOffer(result.offers[0].id)).resolves.toEqual(result.offers[0]);
        expect(mockOffersGet).not.toHaveBeenCalled();
        expect(mockReserveAttempt).not.toHaveBeenCalled();
      } finally {
        if (prevJest !== undefined) {
          process.env.JEST_WORKER_ID = prevJest;
        } else {
          delete process.env.JEST_WORKER_ID;
        }
        if (prevToken !== undefined) {
          process.env.DUFFEL_ACCESS_TOKEN = prevToken;
        } else {
          delete process.env.DUFFEL_ACCESS_TOKEN;
        }
        if (prevUrl !== undefined) {
          process.env.DUFFEL_API_URL = prevUrl;
        } else {
          delete process.env.DUFFEL_API_URL;
        }
        if (prevNodeEnv !== undefined) {
          process.env.NODE_ENV = prevNodeEnv;
        } else {
          delete process.env.NODE_ENV;
        }
      }
    });

    it('maps upstream failure to BAD_GATEWAY HttpException', async () => {
      mockOfferRequestsCreate.mockRejectedValueOnce(new Error('Duffel API timeout'));

      let caught: HttpException | undefined;
      try {
        await adapter.searchOffers(oneWayCriteria);
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          caught = err;
        }
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(caught?.getResponse()).toEqual({
        message: 'Duffel API timeout',
        code: 'UPSTREAM_UNAVAILABLE',
      });
    });

    it('rethrows existing HttpException from searchOffers', async () => {
      const existingError = new HttpException('Forbidden', HttpStatus.FORBIDDEN);
      mockOfferRequestsCreate.mockRejectedValueOnce(existingError);

      await expect(adapter.searchOffers(oneWayCriteria)).rejects.toThrow(existingError);
    });
  });

  describe('getOffer', () => {
    it('retrieves each mock offer after searches for different routes', async () => {
      const prevMock = process.env.DUFFEL_MOCK;
      try {
        process.env.DUFFEL_MOCK = 'true';
        const firstSearch = await adapter.searchOffers({
          origin: 'SFO',
          destination: 'JFK',
          departureDate: '2026-10-01',
          adults: 1,
        });
        const secondSearch = await adapter.searchOffers({
          origin: 'LAX',
          destination: 'ORD',
          departureDate: '2026-10-02',
          adults: 2,
        });
        // Mock search responses have the same offer envelope as the supplier API.
        const firstOffer = (firstSearch as { offers: Array<{ id: string }> }).offers[0];
        const secondOffer = (secondSearch as { offers: Array<{ id: string }> }).offers[0];

        expect(firstOffer.id).not.toBe(secondOffer.id);
        await expect(adapter.getOffer(firstOffer.id)).resolves.toEqual(firstOffer);
        await expect(adapter.getOffer(secondOffer.id)).resolves.toEqual(secondOffer);
        expect(mockOfferRequestsCreate).not.toHaveBeenCalled();
        expect(mockOffersGet).not.toHaveBeenCalled();
        expect(mockReserveAttempt).not.toHaveBeenCalled();
      } finally {
        if (prevMock !== undefined) {
          process.env.DUFFEL_MOCK = prevMock;
        } else {
          delete process.env.DUFFEL_MOCK;
        }
      }
    });

    it('resolves searched mock offers without an SDK and rejects missing mock fixtures', async () => {
      const prevMock = process.env.DUFFEL_MOCK;
      try {
        process.env.DUFFEL_MOCK = 'true';
        const mockAdapter = new DuffelSearchAdapter(undefined, mockBudgetService);
        await expect(mockAdapter.getOffer('off_mock_123')).rejects.toThrow(NotFoundException);
        const result = await mockAdapter.searchOffers({
          origin: 'SFO',
          destination: 'JFK',
          departureDate: '2026-10-01',
          adults: 1,
        });
        const offer = await mockAdapter.getOffer('off_mock_123');
        expect(result).toEqual(expect.objectContaining({ offers: [offer] }));
        expect(mockReserveAttempt).not.toHaveBeenCalled();
      } finally {
        if (prevMock !== undefined) {
          process.env.DUFFEL_MOCK = prevMock;
        } else {
          delete process.env.DUFFEL_MOCK;
        }
      }
    });

    it('keeps live offers on the SDK path even when mock mode is enabled', async () => {
      const prevMock = process.env.DUFFEL_MOCK;
      try {
        process.env.DUFFEL_MOCK = 'true';
        mockReserveAttempt.mockResolvedValueOnce({ ok: true });
        const rawOffer = { id: 'off_live_123' };
        mockOffersGet.mockResolvedValueOnce({ data: rawOffer });
        await expect(adapter.getOffer(rawOffer.id)).resolves.toEqual(rawOffer);
        expect(mockReserveAttempt).toHaveBeenCalledTimes(1);
        expect(mockOffersGet).toHaveBeenCalledWith(rawOffer.id);
      } finally {
        if (prevMock !== undefined) {
          process.env.DUFFEL_MOCK = prevMock;
        } else {
          delete process.env.DUFFEL_MOCK;
        }
      }
    });

    it('reserves budget and retrieves offer data successfully', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      const rawOffer = { id: 'off_valid_123', total_amount: '350.00', total_currency: 'USD' };
      mockOffersGet.mockResolvedValueOnce({ data: rawOffer });

      const result = await adapter.getOffer('off_valid_123');

      expect(mockReserveAttempt).toHaveBeenCalledTimes(1);
      expect(mockOffersGet).toHaveBeenCalledWith('off_valid_123');
      expect(result).toEqual(rawOffer);
    });

    it('succeeds without budget service when rateBudgetService is omitted', async () => {
      const adapterWithoutBudget = new DuffelSearchAdapter(mockDuffel);
      const rawOffer = { id: 'off_no_budget_123' };
      mockOffersGet.mockResolvedValueOnce({ data: rawOffer });

      const result = await adapterWithoutBudget.getOffer('off_no_budget_123');

      expect(mockOffersGet).toHaveBeenCalledWith('off_no_budget_123');
      expect(result).toEqual(rawOffer);
    });

    it('throws INTERNAL_SERVER_ERROR without reserving budget when Duffel SDK is missing', async () => {
      const adapterWithoutDuffel = new DuffelSearchAdapter(undefined, mockBudgetService);

      let caught: HttpException | undefined;
      try {
        await adapterWithoutDuffel.getOffer('off_no_sdk');
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          caught = err;
        }
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(caught?.getResponse()).toEqual({
        message: 'Duffel SDK is not available',
        code: 'SDK_UNAVAILABLE',
      });
      expect(mockReserveAttempt).not.toHaveBeenCalled();
      expect(mockOffersGet).not.toHaveBeenCalled();
    });

    it('throws 429 RATE_LIMIT_EXCEEDED when rate budget is exhausted', async () => {
      mockReserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'EXHAUSTED',
        retryAfterSeconds: 3600,
        resetAt: '2026-10-01T00:00:00.000Z',
      });

      let caught: HttpException | undefined;
      try {
        await adapter.getOffer('off_exhausted');
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          caught = err;
        }
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(caught?.getResponse()).toEqual({
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 3600,
        resetAt: '2026-10-01T00:00:00.000Z',
      });
      expect(mockOffersGet).not.toHaveBeenCalled();
    });

    it('throws 429 BUDGET_UNAVAILABLE when rate budget store is unavailable', async () => {
      mockReserveAttempt.mockResolvedValueOnce({
        ok: false,
        error: 'UNAVAILABLE',
        retryAfterSeconds: 60,
      });

      let caught: HttpException | undefined;
      try {
        await adapter.getOffer('off_unavailable');
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          caught = err;
        }
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(caught?.getResponse()).toEqual({
        code: 'BUDGET_UNAVAILABLE',
        retryAfterSeconds: 60,
      });
      expect(mockOffersGet).not.toHaveBeenCalled();
    });

    it('maps upstream HTTP 404 to NotFoundException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce({
        status: 404,
        message: 'Duffel offer off_missing_404 was not found',
      });

      await expect(adapter.getOffer('off_missing_404')).rejects.toThrow(NotFoundException);
    });

    it('maps upstream Duffel error code "not_found" to NotFoundException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce({
        errors: [{ code: 'not_found', message: 'Offer missing' }],
      });

      await expect(adapter.getOffer('off_missing_code')).rejects.toThrow(NotFoundException);
    });

    it('maps upstream HTTP 410 to GoneException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce({
        status: 410,
        message: 'Duffel offer off_expired_410 has expired',
      });

      await expect(adapter.getOffer('off_expired_410')).rejects.toThrow(GoneException);
    });

    it('maps upstream Duffel error code "airline_offer_no_longer_available" to GoneException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce({
        errors: [{ code: 'airline_offer_no_longer_available' }],
      });

      await expect(adapter.getOffer('off_no_longer_avail')).rejects.toThrow(GoneException);
    });

    it('maps upstream message with "expired" to GoneException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce({
        message: 'The requested offer has expired',
      });

      await expect(adapter.getOffer('off_msg_expired')).rejects.toThrow(GoneException);
    });

    it('times out and rejects with DuffelTimeoutError when upstream call exceeds timeoutMs', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockImplementation(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: { id: 'off_slow' } }), 100);
          }),
      );

      await expect(adapter.getOffer('off_slow', 20)).rejects.toThrow(DuffelTimeoutError);
    });

    it('rethrows existing HttpException without rewrapping', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      const customHttpException = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);
      mockOffersGet.mockRejectedValueOnce(customHttpException);

      await expect(adapter.getOffer('off_custom_error')).rejects.toThrow(customHttpException);
    });

    it('maps unexpected upstream error to BAD_GATEWAY HttpException', async () => {
      mockReserveAttempt.mockResolvedValueOnce({ ok: true });
      mockOffersGet.mockRejectedValueOnce(new Error('Internal Duffel failure'));

      let caught: HttpException | undefined;
      try {
        await adapter.getOffer('off_internal_err');
      } catch (err: unknown) {
        if (err instanceof HttpException) {
          caught = err;
        }
      }

      expect(caught).toBeDefined();
      expect(caught?.getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect(caught?.getResponse()).toEqual({
        code: 'UPSTREAM_UNAVAILABLE',
        message: 'Internal Duffel failure',
      });
    });
  });
});
