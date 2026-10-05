import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CacheService } from '@/cache/cache.service';
import type { AncillaryCatalog, AncillaryRepriceOutput } from '@shared/types';
import { DuffelAncillaryAdapter } from './duffel-ancillary.adapter';
import { AncillaryNormalizer } from './ancillary.normalizer';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSeatService(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.serviceId) &&
    isString(value.passengerId) &&
    isString(value.amount) &&
    isString(value.currency)
  );
}

function isSeatMap(value: unknown): boolean {
  return (
    isRecord(value) &&
    Array.isArray(value.cabins) &&
    value.cabins.every(
      (cabin) =>
        isRecord(cabin) &&
        isString(cabin.cabinClass) &&
        Array.isArray(cabin.rows) &&
        cabin.rows.every(
          (row) =>
            isRecord(row) &&
            typeof row.rowNumber === 'number' &&
            Array.isArray(row.elements) &&
            row.elements.every(
              (element) =>
                isRecord(element) &&
                isString(element.type) &&
                (element.designator === undefined || isString(element.designator)) &&
                (element.restricted === undefined || typeof element.restricted === 'boolean') &&
                (element.availableServices === undefined ||
                  (Array.isArray(element.availableServices) &&
                    element.availableServices.every(isSeatService))),
            ),
        ),
    )
  );
}

function isAncillaryCatalog(value: unknown): value is AncillaryCatalog {
  return (
    isRecord(value) &&
    isString(value.fetchedAt) &&
    isRecord(value.cache) &&
    (value.cache.status === 'HIT' || value.cache.status === 'MISS') &&
    typeof value.cache.ttlSeconds === 'number' &&
    Number.isFinite(value.cache.ttlSeconds) &&
    Array.isArray(value.segments) &&
    value.segments.every(
      (segment) =>
        isRecord(segment) &&
        isString(segment.segmentId) &&
        isString(segment.origin) &&
        isString(segment.destination) &&
        typeof segment.seatMapAvailable === 'boolean' &&
        (segment.seatMap === null || isSeatMap(segment.seatMap)),
    ) &&
    Array.isArray(value.baggageServices) &&
    value.baggageServices.every(
      (service) =>
        isRecord(service) &&
        isString(service.serviceId) &&
        isString(service.passengerId) &&
        isStringArray(service.segmentIds) &&
        isString(service.type) &&
        (service.weightValue === null ||
          (typeof service.weightValue === 'number' && Number.isFinite(service.weightValue))) &&
        (service.weightUnit === null || isString(service.weightUnit)) &&
        typeof service.maxQuantity === 'number' &&
        Number.isInteger(service.maxQuantity) &&
        service.maxQuantity > 0 &&
        isString(service.amount) &&
        isString(service.currency),
    )
  );
}

@Injectable()
export class DuffelAncillaryService {
  constructor(
    private readonly adapter: DuffelAncillaryAdapter,
    private readonly normalizer: AncillaryNormalizer,
    private readonly cacheService: CacheService,
  ) {}

  async getSeatMapsAndServices(offerId: string, forceRefresh = false): Promise<AncillaryCatalog> {
    const cacheKey = `seatmap:${offerId}`;
    if (!forceRefresh) {
      try {
        const ttl = await this.cacheService.getTtl(cacheKey);
        if (ttl > 3) {
          const cachedValue = await this.cacheService.get(cacheKey);
          if (cachedValue) {
            const catalog: unknown = JSON.parse(cachedValue);
            if (isAncillaryCatalog(catalog)) {
              return { ...catalog, cache: { status: 'HIT', ttlSeconds: ttl } };
            }
          }
        }
      } catch {
        // Cache failures are misses; supplier lookup will provide the authoritative result.
      }
    }

    const timeoutError = new Error('Duffel ancillary catalog timed out');
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(timeoutError), 4500);
    });
    let catalog: AncillaryCatalog;
    try {
      const [rawSeatMaps, rawOffer] = await Promise.race([
        this.adapter.getCatalogData(offerId),
        timeoutPromise,
      ]);
      catalog = this.normalizer.normalizeCatalog(rawSeatMaps, rawOffer);
    } catch (error: unknown) {
      throw this.toCatalogError(error, timeoutError);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }

    try {
      await this.cacheService.set(cacheKey, JSON.stringify(catalog), 60);
    } catch {
      // Cache writes are best effort; the normalized supplier response remains usable.
    }
    return catalog;
  }

  async repriceOffer(
    offerId: string,
    intendedServices: Array<{ serviceId: string; quantity: number }>,
  ): Promise<AncillaryRepriceOutput> {
    const quantities = new Map<string, number>();
    for (const service of intendedServices) {
      quantities.set(
        service.serviceId,
        (quantities.get(service.serviceId) ?? 0) + service.quantity,
      );
    }
    const deduplicatedServices = Array.from(quantities, ([id, quantity]) => ({ id, quantity }));

    try {
      const pricedOffer = await this.adapter.getPricedOffer(offerId, deduplicatedServices);
      return this.normalizer.normalizeRepricedOffer(pricedOffer, deduplicatedServices);
    } catch (error: unknown) {
      if (this.isBudgetException(error)) {
        throw error;
      }
      const status = this.statusOf(error);
      if (status === HttpStatus.BAD_REQUEST) {
        return this.normalizer.normalizeRepricedOffer(error, deduplicatedServices);
      }
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        throw new HttpException(
          { code: 'UPSTREAM_RATE_LIMITED', message: 'Duffel repricing is rate limited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Duffel repricing is unavailable' },
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  private toCatalogError(error: unknown, timeoutError: Error): HttpException {
    if (this.isBudgetException(error)) {
      return error;
    }
    if (this.isTimeoutError(error, timeoutError)) {
      return new HttpException(
        { code: 'UPSTREAM_UNAVAILABLE', message: 'Duffel ancillary catalog request timed out' },
        HttpStatus.GATEWAY_TIMEOUT,
      );
    }
    if (this.statusOf(error) === HttpStatus.TOO_MANY_REQUESTS) {
      return new HttpException(
        { code: 'UPSTREAM_RATE_LIMITED', message: 'Duffel ancillary service is rate limited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return new HttpException(
      { code: 'UPSTREAM_UNAVAILABLE', message: 'Duffel ancillary service is unavailable' },
      HttpStatus.BAD_GATEWAY,
    );
  }

  private isTimeoutError(error: unknown, timeoutError: Error): boolean {
    if (error === timeoutError) {
      return true;
    }
    if (!isRecord(error)) {
      return false;
    }
    const code = typeof error.code === 'string' ? error.code.toUpperCase() : '';
    return (
      error.name === 'TimeoutError' ||
      error.name === 'AbortError' ||
      code.includes('TIMEOUT') ||
      code === 'ETIMEDOUT' ||
      code === 'ECONNABORTED'
    );
  }

  private isBudgetException(error: unknown): error is HttpException {
    if (!(error instanceof HttpException)) {
      return false;
    }
    const response = error.getResponse();
    return (
      isRecord(response) &&
      (response.code === 'RATE_LIMIT_EXCEEDED' || response.code === 'BUDGET_UNAVAILABLE')
    );
  }

  private statusOf(error: unknown): number | undefined {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    if (!isRecord(error)) {
      return undefined;
    }
    if (typeof error.status === 'number') {
      return error.status;
    }
    if (typeof error.statusCode === 'number') {
      return error.statusCode;
    }
    return isRecord(error.meta) && typeof error.meta.status === 'number'
      ? error.meta.status
      : undefined;
  }
}
