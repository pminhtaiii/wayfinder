import {
  Injectable,
  Inject,
  BadRequestException,
  Logger,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import {
  FLIGHT_SEARCH_PORT,
  FlightSearchPort,
  FlightOffer,
  FlightSearchCriteria,
  FlightSegment,
} from '@/supplier/search/flight-search.port';
import { AuditService } from '@/audit/audit.service';
import { FlightSearchOrchestratorService } from './flight-search-orchestrator.service';
import {
  FlightSearchRequestDto,
  FlightSearchResponseDto,
  FlightOfferDto,
  FlightSegmentDto,
  CabinMismatchDetail,
} from './dto/search-flight.dto';
import { FlightDetailResponseDto } from './dto/detail-flight.dto';
import { Prisma } from '@prisma/client';

export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';

type FlightSearchOptions = {
  persistence?: 'deferred' | 'required';
  caller?: 'user' | 'agent';
};

function isInputJsonValue(value: unknown): value is Prisma.InputJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isInputJsonValue);
  }
  if (typeof value === 'object') {
    return Object.entries(value).every(
      ([key, val]) => typeof key === 'string' && (val === undefined || isInputJsonValue(val)),
    );
  }
  return false;
}

function mapFlightSegment(segment: FlightSegment): FlightSegmentDto {
  const aircraftName = segment.aircraft || '';
  const aircraft = aircraftName.includes('Airbus')
    ? aircraftName.replace('Airbus ', '')
    : aircraftName || null;
  return {
    carrierCode: segment.carrierCode,
    flightNumber: segment.flightNumber,
    operatingCarrier: segment.operatingCarrier,
    departureAirport: segment.departureAirport,
    departureTerminal: segment.departureTerminal,
    departureTime: segment.departureTime,
    arrivalAirport: segment.arrivalAirport,
    arrivalTerminal: segment.arrivalTerminal,
    arrivalTime: segment.arrivalTime,
    duration: segment.duration,
    aircraft,
    cabinClass: segment.cabinClass,
  };
}

function mapFlightOffer(
  offer: FlightOffer,
  id: string,
  requestedCabinClass: CabinClass,
): FlightOfferDto {
  const segments: FlightSegmentDto[] = offer.segments.map(mapFlightSegment);
  const returnSegments: FlightSegmentDto[] | null = offer.returnSegments
    ? offer.returnSegments.map(mapFlightSegment)
    : null;

  const { cabinClassMatch, cabinMismatchDetails } = computeCabinMatch(
    requestedCabinClass,
    segments,
    returnSegments,
  );

  return {
    id,
    duffelOfferId: offer.supplierOfferId,
    airline: offer.airline,
    flightNumber: offer.flightNumber,
    departureAirport: offer.departureAirport,
    arrivalAirport: offer.arrivalAirport,
    departureTime: offer.departureTime,
    arrivalTime: offer.arrivalTime,
    duration: offer.duration,
    stops: offer.stops,
    price: offer.price,
    currency: offer.currency,
    fareClass: offer.fareClass,
    baggageAllowance: offer.baggageAllowance,
    requestedCabinClass,
    cabinClassMatch,
    cabinMismatchDetails,
    segments,
    returnSegments,
    matchResult: null,
  };
}

const CABIN_RANK: Record<CabinClass, number> = {
  economy: 0,
  premium_economy: 1,
  business: 2,
  first: 3,
};

function computeCabinMatch(
  requestedCabinClass: CabinClass,
  segments: FlightSegmentDto[],
  returnSegments: FlightSegmentDto[] | null,
): {
  cabinClassMatch: 'full' | 'mixed' | 'downgraded';
  cabinMismatchDetails: CabinMismatchDetail[] | null;
} {
  const allSegments = [...segments, ...(returnSegments || [])];
  if (allSegments.length === 0) {
    return { cabinClassMatch: 'full', cabinMismatchDetails: null };
  }

  let longestSegment = allSegments[0];
  for (const seg of allSegments) {
    if (seg.duration > longestSegment.duration) {
      longestSegment = seg;
    }
  }

  const requestedRank = CABIN_RANK[requestedCabinClass] ?? 0;
  const longestRank = CABIN_RANK[longestSegment.cabinClass] ?? 0;

  let cabinClassMatch: 'full' | 'mixed' | 'downgraded' = 'full';
  if (longestRank < requestedRank) {
    cabinClassMatch = 'downgraded';
  } else if (allSegments.some((seg) => seg.cabinClass !== requestedCabinClass)) {
    cabinClassMatch = 'mixed';
  }

  const mismatchDetailsList: CabinMismatchDetail[] = [];
  segments.forEach((seg, idx) => {
    if (seg.cabinClass !== requestedCabinClass) {
      mismatchDetailsList.push({
        segmentIndex: idx,
        leg: 'outbound',
        expected: requestedCabinClass,
        actual: seg.cabinClass,
        route: `${seg.departureAirport} → ${seg.arrivalAirport}`,
      });
    }
  });

  if (returnSegments) {
    returnSegments.forEach((seg, idx) => {
      if (seg.cabinClass !== requestedCabinClass) {
        mismatchDetailsList.push({
          segmentIndex: idx,
          leg: 'return',
          expected: requestedCabinClass,
          actual: seg.cabinClass,
          route: `${seg.departureAirport} → ${seg.arrivalAirport}`,
        });
      }
    });
  }

  return {
    cabinClassMatch,
    cabinMismatchDetails: cabinClassMatch === 'full' ? null : mismatchDetailsList,
  };
}


@Injectable()
export class FlightsService {
  private readonly logger = new Logger(FlightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: CacheService,
    @Inject(FLIGHT_SEARCH_PORT) private readonly flightSearchPort: FlightSearchPort,
    private readonly auditService: AuditService,
    private readonly flightSearchOrchestratorService: FlightSearchOrchestratorService,
  ) {}

  async search(
    userId: string,
    query: FlightSearchRequestDto,
    traceId?: string,
    correlationId?: string,
    options: FlightSearchOptions = {},
  ): Promise<FlightSearchResponseDto> {
    const startTime = Date.now();
    const origin = query.origin.trim().toUpperCase();
    const destination = query.destination.trim().toUpperCase();

    if (origin === destination) {
      throw new BadRequestException('Origin and destination must be different');
    }

    if (query.returnDate) {
      const depDate = new Date(query.departureDate);
      const retDate = new Date(query.returnDate);
      if (retDate < depDate) {
        throw new BadRequestException('Return date must be on or after departure date');
      }
    }

    // Validate that origin and destination airports exist in the Airport table
    const [originAirport, destAirport] = await Promise.all([
      this.prisma.airport.findUnique({ where: { iataCode: origin } }),
      this.prisma.airport.findUnique({ where: { iataCode: destination } }),
    ]);

    if (!originAirport) {
      throw new BadRequestException(`Origin airport with code ${origin} does not exist`);
    }
    if (!destAirport) {
      throw new BadRequestException(`Destination airport with code ${destination} does not exist`);
    }

    const passengersInfo = {
      adults: Number(query.adults),
      children: Number(query.children || 0),
      infants: Number(query.infants || 0),
      cabinClass: (query.cabinClass || 'economy') as CabinClass,
    };

    const forSearch: FlightSearchCriteria = {
      origin,
      destination,
      departureDate: query.departureDate,
      returnDate: query.returnDate || undefined,
      ...passengersInfo,
    };

    const searchResult = await this.flightSearchPort.search(forSearch, options.caller ?? 'user');
    const offers = searchResult.offers;
    const cached = searchResult.cached;
    const sha256 = searchResult.searchHash;

    const orchestrated = await this.flightSearchOrchestratorService.orchestrateSearch({
      offers,
      query: {
        origin,
        destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate,
        adults: passengersInfo.adults,
        children: passengersInfo.children,
        infants: passengersInfo.infants,
        cabinClass: query.cabinClass,
      },
      userId,
      searchHash: sha256,
      cached,
    });

    // Map each OrchestratedFlightResult from orchestrated.results to FlightOfferDto
    const results: FlightOfferDto[] = orchestrated.results.map((res) => {
      const offer = res.offer;
      if (!offer) {
        throw new ServiceUnavailableException('Missing offer in search results');
      }
      const offerDto = mapFlightOffer(offer, res.scoredOffer.offer.id, passengersInfo.cabinClass);
      return {
        ...offerDto,
        matchResult: res.scoredOffer.matchResult,
      };
    });

    const persistSearch = async (): Promise<void> => {
      try {
        const prices = results.map((r) => r.price);
        const minPrice = prices.length > 0 ? Math.min(...prices) : null;
        const maxPrice = prices.length > 0 ? Math.max(...prices) : null;
        const currency = results.length > 0 ? results[0].currency : 'USD';

        await this.prisma.$transaction(async (tx) => {
          await tx.searchHistory.create({
            data: {
              userId,
              origin,
              destination,
              departureDate: new Date(query.departureDate),
              returnDate: query.returnDate ? new Date(query.returnDate) : null,
              ...passengersInfo,
              resultCount: results.length,
              minPrice,
              maxPrice,
              currency,
              searchHash: sha256,
            },
          });

          const flightOffersData = orchestrated.results.map((res) => {
            const offer = res.offer;
            if (!offer) {
              throw new ServiceUnavailableException('Missing offer in search results');
            }
            const rawPayload = offer.rawSupplierPayload;
            const rawOffer: Prisma.InputJsonValue = isInputJsonValue(rawPayload)
              ? rawPayload
              : {};
            return {
              id: res.scoredOffer.offer.id,
              searchHash: sha256,
              supplierOfferId: offer.supplierOfferId,
              rawOffer,
              origin,
              destination,
              departureDate: new Date(query.departureDate),
              returnDate: query.returnDate ? new Date(query.returnDate) : null,
              ...passengersInfo,
              price: new Prisma.Decimal(offer.price),
              currency: offer.currency,
            };
          });

          const offerRecoveriesData = orchestrated.results.map((res) => ({
            id: res.scoredOffer.offer.id,
            searchHash: sha256,
          }));

          if (flightOffersData.length > 0) {
            await tx.flightOffer.createMany({
              data: flightOffersData,
              skipDuplicates: true,
            });
            await tx.offerRecovery.createMany({
              data: offerRecoveriesData,
              skipDuplicates: true,
            });
          }
        });
      } catch (error) {
        this.logger.error('Failed to save search history and offers atomically', error);
        if (options.persistence === 'required') {
          throw new ServiceUnavailableException('Flight search results could not be saved');
        }
      }
    };

    // Attestations must reference committed rows; ordinary searches retain write-behind.
    if (options.persistence === 'required') {
      await persistSearch();
    } else {
      setImmediate(() => {
        void persistSearch();
      });
    }

    const responseTime = Date.now() - startTime;

    // Create audit log entry (synchronous so test can immediately assert it)
    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'flight_search',
      resourceType: 'Flight',
      metadata: {
        origin,
        destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        ...passengersInfo,
        searchHash: sha256,
        resultCount: results.length,
        responseTime,
      },
      traceId,
      correlationId,
    });

    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'search.completed',
      resourceType: 'Flight',
      metadata: {
        origin,
        destination,
        departureDate: query.departureDate,
        returnDate: query.returnDate || null,
        adults: passengersInfo.adults,
        children: passengersInfo.children,
        infants: passengersInfo.infants,
        cabinClass: passengersInfo.cabinClass,
        mode: orchestrated.mode,
        resultCount: results.length,
        eligibleCount: orchestrated.meta.eligibleCount,
        duration: responseTime,
        searchHash: sha256,
      },
      traceId,
      correlationId,
    });

    return {
      mode: orchestrated.mode,
      results,
      meta: {
        ...orchestrated.meta,
        totalResults: results.length,
        searchHash: sha256,
        cached,
        requestedCabinClass: query.cabinClass || 'economy',
      },
    };
  }

  async getFlightDetail(id: string, userId: string): Promise<FlightDetailResponseDto> {
    // 1. Look up flight offer in database
    const flightOffer = await this.prisma.flightOffer.findUnique({
      where: { id },
    });

    if (!flightOffer) {
      // 2. Fallback: check if the offer existed in offerRecovery
      const recoveryRecord = await this.prisma.offerRecovery.findUnique({
        where: { id },
      });

      if (recoveryRecord) {
        // Find the original search history
        const searchHistory = await this.prisma.searchHistory.findFirst({
          where: { searchHash: recoveryRecord.searchHash },
          orderBy: { createdAt: 'desc' },
        });

        if (searchHistory) {
          throw new HttpException(
            {
              message:
                'This flight offer has expired. Use the search parameters below to find current availability.',
              code: 'OFFER_EXPIRED',
              recovery: {
                origin: searchHistory.origin,
                destination: searchHistory.destination,
                departureDate: searchHistory.departureDate.toISOString().slice(0, 10),
                returnDate: searchHistory.returnDate
                  ? searchHistory.returnDate.toISOString().slice(0, 10)
                  : null,
                adults: searchHistory.adults,
                children: searchHistory.children,
                infants: searchHistory.infants,
                cabinClass: searchHistory.cabinClass,
              },
            },
            HttpStatus.GONE,
          );
        }
      }

      // If not in recovery either, check if it's a valid UUID
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(id)) {
        throw new BadRequestException('Invalid UUID format');
      }

      throw new HttpException(
        {
          message: `Flight offer with ID ${id} never existed or has been completely removed.`,
          code: 'NOT_FOUND',
        },
        HttpStatus.NOT_FOUND,
      );
    }

    // 3. Offer found: Retrieve live details from FlightSearchPort
    let liveOffer: FlightOffer;
    try {
      liveOffer = await this.flightSearchPort.getOfferById(flightOffer.supplierOfferId);
    } catch (err: unknown) {
      const errorObj = err as {
        status?: number;
        statusCode?: number;
        message?: string;
        stack?: string;
      };
      const errStatus =
        (err instanceof HttpException ? err.getStatus() : undefined) ??
        errorObj?.status ??
        errorObj?.statusCode ??
        500;

      if (errStatus === 404 || errStatus === 410) {
        this.logger.warn(
          `Flight offer ${flightOffer.supplierOfferId} expired on supplier side. Purging from DB.`,
        );

        // Delete the flight offer row
        await this.prisma.flightOffer.delete({ where: { id } }).catch(() => {});

        throw new HttpException(
          {
            message:
              'This flight offer has expired. Use the search parameters below to find current availability.',
            code: 'OFFER_EXPIRED',
            recovery: {
              origin: flightOffer.origin,
              destination: flightOffer.destination,
              departureDate: flightOffer.departureDate.toISOString().slice(0, 10),
              returnDate: flightOffer.returnDate
                ? flightOffer.returnDate.toISOString().slice(0, 10)
                : null,
              adults: flightOffer.adults,
              children: flightOffer.children,
              infants: flightOffer.infants,
              cabinClass: flightOffer.cabinClass,
            },
          },
          HttpStatus.GONE,
        );
      }

      this.logger.error(
        `Failed to retrieve offer from supplier: ${errorObj?.message || 'Unknown error'}`,
        errorObj?.stack,
      );
      throw new HttpException(
        {
          message: 'Upstream flight search service is temporarily unavailable',
          code: 'UPSTREAM_UNAVAILABLE',
        },
        HttpStatus.BAD_GATEWAY,
      );
    }

    // 4. Map live offer to DTO and check for price changes
    const originalPrice = Number(flightOffer.price);
    const confirmedPrice = Number(liveOffer.totalAmount ?? liveOffer.price);
    const priceChanged = originalPrice !== confirmedPrice;

    const segments: FlightSegmentDto[] = liveOffer.segments.map(mapFlightSegment);
    const returnSegments: FlightSegmentDto[] | null = liveOffer.returnSegments
      ? liveOffer.returnSegments.map(mapFlightSegment)
      : null;

    const { cabinClassMatch, cabinMismatchDetails } = computeCabinMatch(
      flightOffer.cabinClass as CabinClass,
      segments,
      returnSegments,
    );

    const conditions = {
      refundable: liveOffer.conditions?.refundable ?? false,
      changeable: liveOffer.conditions?.changeable ?? false,
      changeBeforeDeparture: liveOffer.conditions?.changeBeforeDeparture
        ? {
            allowed: liveOffer.conditions.changeBeforeDeparture.allowed,
            penaltyAmount: liveOffer.conditions.changeBeforeDeparture.penaltyAmount || null,
            penaltyCurrency: liveOffer.conditions.changeBeforeDeparture.penaltyCurrency || null,
          }
        : null,
    };

    const passengers = (liveOffer.passengers || []).map((passenger) => ({
      id: passenger.supplierPassengerId,
      type: passenger.type,
    }));

    // 5. Create audit log
    await this.auditService.createLog(this.prisma, {
      userId,
      action: 'flight_detail_view',
      resourceType: 'Flight',
      resourceId: id,
      metadata: {
        flightId: id,
        duffelOfferId: flightOffer.supplierOfferId,
        priceChanged,
        originalPrice,
        confirmedPrice,
      },
    });

    return {
      id,
      airline: liveOffer.airline,
      flightNumber: liveOffer.flightNumber,
      departureAirport: liveOffer.departureAirport,
      arrivalAirport: liveOffer.arrivalAirport,
      departureTime: liveOffer.departureTime,
      arrivalTime: liveOffer.arrivalTime,
      duration: liveOffer.duration,
      stops: liveOffer.stops,
      originalPrice,
      confirmedPrice,
      priceChanged,
      currency: liveOffer.currency,
      fareClass: liveOffer.fareClass,
      baggageAllowance: liveOffer.baggageAllowance,
      requestedCabinClass: flightOffer.cabinClass as CabinClass,
      cabinClassMatch,
      cabinMismatchDetails,
      segments,
      returnSegments,
      expiresAt: liveOffer.offerExpiresAt ?? '',
      conditions,
      adults: flightOffer.adults,
      children: flightOffer.children,
      infants: flightOffer.infants,
      passengers,
    };
  }
}
