import {
  Injectable,
  Inject,
  Optional,
  HttpException,
  HttpStatus,
  NotFoundException,
  GoneException,
} from '@nestjs/common';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK, DuffelRateBudgetService } from '@/supplier/core/duffel-core.module';
import { FlightSearchCriteria } from './flight-search.port';

export class DuffelTimeoutError extends Error {
  readonly code = 'DUFFEL_TIMEOUT';
  constructor(message = 'Duffel offer lookup timed out.') {
    super(message);
    this.name = 'DuffelTimeoutError';
    Object.setPrototypeOf(this, DuffelTimeoutError.prototype);
  }
}

@Injectable()
export class DuffelSearchAdapter {
  private readonly mockOffers = new Map<string, { id: string } & Record<string, unknown>>();

  constructor(
    @Optional() @Inject(DUFFEL_SDK) private readonly duffel?: Duffel,
    @Optional() private readonly rateBudgetService?: DuffelRateBudgetService,
  ) {}

  async searchOffers(criteria: FlightSearchCriteria): Promise<unknown> {
    const origin = criteria.origin.trim().toUpperCase();
    const destination = criteria.destination.trim().toUpperCase();
    const departureDate = criteria.departureDate;

    const slices = [
      {
        origin,
        destination,
        departure_date: departureDate,
        arrival_time: null,
        departure_time: null,
      },
    ];

    if (criteria.returnDate) {
      slices.push({
        origin: destination,
        destination: origin,
        departure_date: criteria.returnDate,
        arrival_time: null,
        departure_time: null,
      });
    }

    const adults = Math.max(1, Number(criteria.adults) || 1);
    const children = Math.max(0, Number(criteria.children) || 0);
    const infants = Math.max(0, Number(criteria.infants) || 0);

    const passengers: Array<{ type: 'adult' | 'child' | 'infant_without_seat' }> = [];
    for (let i = 0; i < adults; i++) {
      passengers.push({ type: 'adult' });
    }
    for (let i = 0; i < children; i++) {
      passengers.push({ type: 'child' });
    }
    for (let i = 0; i < infants; i++) {
      passengers.push({ type: 'infant_without_seat' });
    }

    const cabinClassMap: Record<string, 'first' | 'business' | 'premium_economy' | 'economy'> = {
      first: 'first',
      business: 'business',
      premium_economy: 'premium_economy',
      economy: 'economy',
    };
    const cabinClass =
      (criteria.cabinClass && cabinClassMap[criteria.cabinClass.toLowerCase()]) || 'economy';

    if (this.isMockMode()) {
      const mockPassengers: Array<{
        id: string;
        type: 'adult' | 'child' | 'infant_without_seat';
      }> = [];
      for (let i = 0; i < adults; i++) {
        mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'adult' });
      }
      for (let i = 0; i < children; i++) {
        mockPassengers.push({ id: `pas_mock_${mockPassengers.length + 1}`, type: 'child' });
      }
      for (let i = 0; i < infants; i++) {
        mockPassengers.push({
          id: `pas_mock_${mockPassengers.length + 1}`,
          type: 'infant_without_seat',
        });
      }

      const mockSlices: Record<string, unknown>[] = [
        {
          id: 'sli_mock_1',
          duration: 'PT2H10M',
          origin: {
            id: origin,
            name: `${origin} Airport`,
            iata_code: origin,
            type: 'airport',
          },
          destination: {
            id: destination,
            name: `${destination} Airport`,
            iata_code: destination,
            type: 'airport',
          },
          segments: [
            {
              id: 'seg_mock_1',
              duration: 'PT2H10M',
              departing_at: `${departureDate}T08:00:00`,
              arriving_at: `${departureDate}T10:10:00`,
              origin: {
                id: origin,
                name: `${origin} Airport`,
                iata_code: origin,
                type: 'airport',
              },
              destination: {
                id: destination,
                name: `${destination} Airport`,
                iata_code: destination,
                type: 'airport',
              },
              operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier_flight_number: '123',
              aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
              passengers: mockPassengers.map((p) => ({
                passenger_id: p.id,
                cabin_class: cabinClass,
                baggages: [{ type: 'checked', quantity: 1 }],
              })),
            },
          ],
        },
      ];

      if (criteria.returnDate) {
        mockSlices.push({
          id: 'sli_mock_2',
          duration: 'PT2H10M',
          origin: {
            id: destination,
            name: `${destination} Airport`,
            iata_code: destination,
            type: 'airport',
          },
          destination: {
            id: origin,
            name: `${origin} Airport`,
            iata_code: origin,
            type: 'airport',
          },
          segments: [
            {
              id: 'seg_mock_2',
              duration: 'PT2H10M',
              departing_at: `${criteria.returnDate}T15:00:00`,
              arriving_at: `${criteria.returnDate}T17:10:00`,
              origin: {
                id: destination,
                name: `${destination} Airport`,
                iata_code: destination,
                type: 'airport',
              },
              destination: {
                id: origin,
                name: `${origin} Airport`,
                iata_code: origin,
                type: 'airport',
              },
              operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
              marketing_carrier_flight_number: '124',
              aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
              passengers: mockPassengers.map((p) => ({
                passenger_id: p.id,
                cabin_class: cabinClass,
                baggages: [{ type: 'checked', quantity: 1 }],
              })),
            },
          ],
        });
      }

      const offers = [
        {
          id: `off_mock_${123 + this.mockOffers.size}`,
          total_amount: '125.50',
          total_currency: 'USD',
          slices: mockSlices.map((s) => {
            const segments = (s.segments as Record<string, unknown>[]) || [];
            return {
              ...s,
              segments: segments.map((seg) => ({
                ...seg,
                passengers: seg.passengers,
              })),
            };
          }),
          passengers: mockPassengers,
          passenger_identity_documents_required: false,
        },
      ];

      for (const offer of offers) {
        this.mockOffers.set(offer.id, offer);
      }

      return {
        id: 'or_mock_123',
        slices: mockSlices,
        passengers: mockPassengers,
        offers,
      };
    }

    const duffelClient = this.duffel;
    if (!duffelClient) {
      throw new HttpException(
        {
          message: 'Duffel SDK is not available',
          code: 'SDK_UNAVAILABLE',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    try {
      const duffelResponse = await duffelClient.offerRequests.create({
        slices,
        // Type assertion required: map domain passenger array to Duffel SDK parameter type
        passengers:
          passengers as unknown as Parameters<Duffel['offerRequests']['create']>[0]['passengers'],
        cabin_class: cabinClass,
      });

      return duffelResponse.data;
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          message:
            err instanceof Error
              ? err.message
              : 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private isMockMode(): boolean {
    const isJest = process.env.JEST_WORKER_ID !== undefined;
    const hasDuffelApiUrl = Boolean(
      process.env.DUFFEL_API_URL && process.env.DUFFEL_API_URL.trim() !== '',
    );
    const token = process.env.DUFFEL_ACCESS_TOKEN;
    return (
      process.env.DUFFEL_MOCK === 'true' ||
      (!isJest && !hasDuffelApiUrl && (process.env.NODE_ENV === 'test' || token === 'mock'))
    );
  }

  async getOffer(supplierOfferId: string, timeoutMs = 4500): Promise<unknown> {
    if (this.isMockMode() && supplierOfferId.startsWith('off_mock_')) {
      const mockOffer = this.mockOffers.get(supplierOfferId);
      if (mockOffer) {
        return mockOffer;
      }
      throw new NotFoundException(`Duffel mock offer ${supplierOfferId} was not found`);
    }

    const duffelClient = this.duffel;
    if (!duffelClient) {
      throw new HttpException(
        {
          message: 'Duffel SDK is not available',
          code: 'SDK_UNAVAILABLE',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    if (this.rateBudgetService) {
      const res = await this.rateBudgetService.reserveAttempt();
      if (!res.ok) {
        if (res.error === 'UNAVAILABLE') {
          throw new HttpException(
            {
              code: 'BUDGET_UNAVAILABLE',
              retryAfterSeconds: res.retryAfterSeconds,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        throw new HttpException(
          {
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfterSeconds: res.retryAfterSeconds,
            resetAt: res.resetAt,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const timeoutError = new DuffelTimeoutError();
    let timeoutHandle: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), timeoutMs);
    });

    try {
      const offerPromise = duffelClient.offers.get(supplierOfferId);
      const result = await Promise.race([offerPromise, timeoutPromise]);
      // Safe cast: Duffel SDK wraps retrieved resource in a data property
      return (result as { data: unknown }).data;
    } catch (err: unknown) {
      if (
        err instanceof DuffelTimeoutError ||
        (err instanceof Error && err.name === 'DuffelTimeoutError') ||
        // Safe check: duck-typed inspection of timeout error code
        (err as { code?: string })?.code === 'DUFFEL_TIMEOUT'
      ) {
        throw err;
      }

      if (err instanceof NotFoundException || err instanceof GoneException) {
        throw err;
      }

      // Safe cast: error narrowed to object dictionary for status and code extraction
      const errObj = err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
      const status =
        typeof errObj?.status === 'number'
          ? errObj.status
          : typeof errObj?.statusCode === 'number'
          ? errObj.statusCode
          : undefined;
      const message = typeof errObj?.message === 'string' ? errObj.message : '';
      // Safe cast: error detail array narrowed to object list
      const errors = Array.isArray(errObj?.errors)
        ? (errObj?.errors as Array<Record<string, unknown>>)
        : [];
      const duffelCodes = errors
        .map((e) => (typeof e?.code === 'string' ? e.code.toLowerCase() : ''))
        .filter(Boolean);

      if (
        status === 404 ||
        duffelCodes.includes('not_found') ||
        message.toLowerCase().includes('not found')
      ) {
        throw new NotFoundException(
          err instanceof Error && err.message
            ? err.message
            : `Duffel offer ${supplierOfferId} was not found`,
        );
      }

      if (
        status === 410 ||
        duffelCodes.some(
          (c) =>
            c.includes('expired') || c.includes('gone') || c.includes('no_longer_available'),
        ) ||
        message.toLowerCase().includes('expired') ||
        message.toLowerCase().includes('gone') ||
        message.toLowerCase().includes('no longer available')
      ) {
        throw new GoneException(
          err instanceof Error && err.message
            ? err.message
            : `Duffel offer ${supplierOfferId} has expired`,
        );
      }

      if (err instanceof HttpException) {
        throw err;
      }

      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message:
            err instanceof Error
              ? err.message
              : `Failed to retrieve Duffel offer ${supplierOfferId}`,
        },
        HttpStatus.BAD_GATEWAY,
      );
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }
}
