import * as crypto from 'crypto';
import { Injectable, Optional, HttpException, HttpStatus } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import type { FlightSnapshot } from '@shared/booking-types';
import { DuffelRateBudgetService } from '../core/duffel-rate-budget.service';
import { DuffelSearchAdapter } from './duffel-search.adapter';
import { FlightOfferNormalizer, validateAndNormalizeOffer } from './flight-offer.normalizer';
import { DuffelOffer } from '@/duffel/duffel.types';
import {
  FlightOffer,
  FlightStoredOfferFacts,
  FlightSearchCriteria,
  FlightSearchPort,
  FlightSearchResult,
  NeutralStoredOfferMetadata,
  StoredOfferExpiryPolicy,
} from './flight-search.port';

@Injectable()
export class DuffelSearchService implements FlightSearchPort {
  private readonly normalizerInstance: FlightOfferNormalizer;

  constructor(
    @Optional() private readonly cacheService?: CacheService,
    @Optional() private readonly rateBudgetService?: DuffelRateBudgetService,
    @Optional() private readonly searchAdapter?: DuffelSearchAdapter,
    @Optional() private readonly normalizer?: FlightOfferNormalizer,
  ) {
    // Injected via SupplierSearchModule. Fallback to new instance allows legacy/unit tests to construct without DI.
    this.normalizerInstance = normalizer ?? new FlightOfferNormalizer();
  }

  private computeSearchHash(criteria: FlightSearchCriteria): string {
    const normalized = {
      origin: criteria.origin.trim().toUpperCase(),
      destination: criteria.destination.trim().toUpperCase(),
      departureDate: criteria.departureDate,
      returnDate: criteria.returnDate || null,
      adults: Number(criteria.adults),
      children: Number(criteria.children || 0),
      infants: Number(criteria.infants || 0),
      cabinClass: criteria.cabinClass || 'economy',
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  async search(
    criteria: FlightSearchCriteria,
    caller: 'user' | 'agent',
  ): Promise<FlightSearchResult> {
    const searchHash = this.computeSearchHash(criteria);
    const cacheKey = `flight:search:${searchHash}`;
    const rawCacheKey = `flights:raw:${searchHash}`;

    if (this.cacheService) {
      const cachedData = await this.cacheService.get(cacheKey);
      if (cachedData) {
        const parsed = JSON.parse(cachedData) as FlightSearchResult;
        return {
          ...parsed,
          searchHash,
          cached: true,
        };
      }

      const cachedRaw = await this.cacheService.get(rawCacheKey);
      if (cachedRaw) {
        try {
          const parsedRaw = JSON.parse(cachedRaw) as { offers?: unknown[] };
          const rawOffers = Array.isArray(parsedRaw?.offers) ? parsedRaw.offers : [];
          const offers: FlightOffer[] = [];
          for (let i = 0; i < rawOffers.length; i++) {
            const item = rawOffers[i];
            if (!item || typeof item !== 'object') continue;
            try {
              // Rebuild cached neutral offers from their supplier payload so stale
              // or malformed normalized fields cannot bypass supplier validation.
              const rawOffer = 'supplierOfferId' in item && 'rawSupplierPayload' in item
                ? item.rawSupplierPayload
                : item;
              // The validator checks the unknown cached supplier payload before admission.
              const supplierOffer = rawOffer as DuffelOffer;
              if (!validateAndNormalizeOffer(supplierOffer, i).success) continue;
              const normalizedOffer = this.normalizerInstance.normalizeOffer(
                supplierOffer,
                criteria.cabinClass,
                i,
              );
              if (normalizedOffer) offers.push(normalizedOffer);
            } catch {
              // Malformed cached entries must not discard other valid results.
            }
          }
          if (offers.length > 0) {
            return { offers, searchHash, cached: true };
          }
        } catch {
          // A corrupt raw cache entry must not prevent a live search.
        }
      }
    }

    if (!this.searchAdapter) {
      throw new Error('Search adapter unavailable');
    }

    if (this.rateBudgetService) {
      const today = new Date().toISOString().split('T')[0];
      const limit = caller === 'user' ? 1000 : 500;
      const key = `budget:duffel:daily:${caller}:${today}`;
      const reservation = await this.rateBudgetService.reserveAttempt({ key, limit });
      if (!reservation.ok) {
        if (reservation.error === 'EXHAUSTED') {
          throw new HttpException(
            {
              code: 'RATE_LIMIT_EXCEEDED',
              retryAfterSeconds: reservation.retryAfterSeconds,
              resetAt: reservation.resetAt,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        throw new HttpException(
          {
            code: 'BUDGET_UNAVAILABLE',
            retryAfterSeconds: reservation.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const adapterResponse = (await this.searchAdapter.searchOffers(criteria)) as
      | { id?: string; offers?: unknown[] }
      | undefined;
    const rawOffers = adapterResponse?.offers || [];
    const offers: FlightOffer[] = [];

    for (let i = 0; i < rawOffers.length; i++) {
      const raw = rawOffers[i];
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      try {
        // The validator checks the unknown supplier payload before admission.
        const rawOffer = raw as DuffelOffer;
        if (!validateAndNormalizeOffer(rawOffer, i).success) {
          continue;
        }
        const normalizedOffer = this.normalizerInstance.normalizeOffer(
          rawOffer,
          criteria.cabinClass,
          i,
        );
        if (normalizedOffer) {
          offers.push(normalizedOffer);
        }
      } catch {
        // Malformed nested supplier data must not discard the other search results.
        continue;
      }
    }

    const result: FlightSearchResult = {
      offers,
      searchHash,
      cached: false,
    };

    if (this.cacheService) {
      await this.cacheService.set(cacheKey, JSON.stringify(result), 900);
      const offerRequestId = adapterResponse?.id || `or_${searchHash}`;
      await this.cacheService.set(
        rawCacheKey,
        JSON.stringify({ id: offerRequestId, offers: rawOffers }),
        900,
      );
    }

    return result;
  }

  async getOfferById(
    supplierOfferId: string,
    timeoutMs?: number,
  ): Promise<FlightOffer> {
    if (!this.searchAdapter) {
      throw new Error('Search adapter unavailable');
    }
    const rawOffer = await this.searchAdapter.getOffer(supplierOfferId, timeoutMs);
    try {
      // Safe cast: raw offer from Duffel live lookup conforms to DuffelOffer structure
      const offer = this.normalizerInstance.normalizeOffer(rawOffer as unknown as DuffelOffer);
      if (!offer || !offer.id) {
        throw new Error('Invalid normalized offer structure');
      }
      return offer;
    } catch (err: unknown) {
      if (err instanceof HttpException) {
        throw err;
      }
      throw new HttpException(
        {
          code: 'UPSTREAM_UNAVAILABLE',
          message: `Failed to normalize offer: ${supplierOfferId}`,
        },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  normalizeStoredOffer(
    rawOffer: unknown,
    metadata?: NeutralStoredOfferMetadata,
  ): FlightOffer | null {
    return this.normalizerInstance.normalizeStoredOffer(rawOffer, metadata);
  }

  normalizeStoredOfferFacts(
    rawOffer: unknown,
    expiryPolicy?: StoredOfferExpiryPolicy,
  ): FlightStoredOfferFacts {
    return this.normalizerInstance.normalizeStoredOfferFacts(rawOffer, expiryPolicy);
  }

  normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null {
    return this.normalizerInstance.normalizeStoredFlightSnapshot(rawOffer);
  }
}
