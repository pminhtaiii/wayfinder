import { Injectable, Logger } from '@nestjs/common';
import { CABIN_RANK, CabinClass } from '@/flight-match/flight-match.policy';
import { FlightOffer } from '@/supplier/search/flight-search.port';
import {
  FlightMatchInput,
  RankedOffer,
  ScoredOffer,
  ScoringPreferences,
} from '@/flight-match/flight-match.types';
import { ProfileService } from '@/profile/profile.service';
import { FlightMatchScorerService } from '@/flight-match/flight-match-scorer.service';
import { CategoryRankerService } from '@/flight-match/category-ranker.service';

export interface OrchestratorParams {
  readonly offers: readonly FlightOffer[];
  readonly query: {
    readonly origin: string;
    readonly destination: string;
    readonly departureDate: string;
    readonly returnDate?: string;
    readonly adults: number;
    readonly children?: number;
    readonly infants?: number;
    readonly cabinClass?: string;
  };
  readonly userId?: string | null;
  readonly searchHash: string;
  readonly cached: boolean;
}

export interface OrchestratedFlightResult {
  readonly offer: FlightOffer;
  readonly scoredOffer: ScoredOffer | RankedOffer;
}

export interface SearchMeta {
  readonly totalResults: number;
  readonly searchHash: string;
  readonly cached: boolean;
  readonly requestedCabinClass: string;
  readonly scoringVersion: 'flight-match-v1' | null;
  readonly eligibleCount?: number;
  readonly matchLevelCounts?: {
    readonly STRONG: number;
    readonly GOOD: number;
    readonly FAIR: number;
    readonly WEAK: number;
  };
}

export interface OrchestratedSearchResponse {
  readonly mode: 'MATCHED' | 'RANKED';
  readonly results: readonly OrchestratedFlightResult[];
  readonly meta: SearchMeta;
  readonly droppedCount: number;
  readonly rejectionCounts: Readonly<Record<string, number>>;
}

function isCabinClass(key: string): key is CabinClass {
  return key in CABIN_RANK;
}

export function normalizeCabinClass(cabin: string | null | undefined): CabinClass | null {
  if (!cabin || typeof cabin !== 'string') return null;
  const key = cabin.trim().toLowerCase();
  return isCabinClass(key) ? key : null;
}

export function hasEffectivePreferences(preferences: ScoringPreferences): boolean {
  if (!preferences) return false;
  if (preferences.preferredAirlines && preferences.preferredAirlines.length > 0) return true;
  if (preferences.blacklistedAirlines && preferences.blacklistedAirlines.length > 0) return true;
  if (
    preferences.classPreference !== null &&
    preferences.classPreference !== undefined &&
    preferences.classPreference.trim() !== ''
  ) {
    return true;
  }
  if (preferences.preferredDepartureWindow !== null && preferences.preferredDepartureWindow !== undefined) {
    return true;
  }
  if (preferences.preferredArrivalWindow !== null && preferences.preferredArrivalWindow !== undefined) {
    return true;
  }
  if (preferences.maxStops !== null && preferences.maxStops !== undefined) {
    return true;
  }
  if (preferences.priceSensitivity !== null && preferences.priceSensitivity !== undefined) {
    return true;
  }
  if (preferences.requiresCheckedBaggage !== null && preferences.requiresCheckedBaggage !== undefined) {
    return true;
  }
  return false;
}

@Injectable()
export class FlightSearchOrchestratorService {
  readonly logger = new Logger(FlightSearchOrchestratorService.name);

  constructor(
    private readonly profileService: ProfileService,
    private readonly scorer: FlightMatchScorerService,
    private readonly categoryRanker: CategoryRankerService,
  ) {}

  async orchestrateSearch(params: OrchestratorParams): Promise<OrchestratedSearchResponse> {
    const currency = params.offers[0]?.matchInput.currency;
    const sameCurrencyOffers = params.offers.filter((o) => o.matchInput.currency === currency);
    const canonicalOffers: readonly FlightMatchInput[] = sameCurrencyOffers.slice(0, 20).map((o) => o.matchInput);
    const droppedCount = params.offers.length - sameCurrencyOffers.length;
    const rejectionCounts: Readonly<Record<string, number>> =
      droppedCount > 0 ? { MIXED_CURRENCY: droppedCount } : {};

    const resolveFlightOffer = (index: number, id?: string): FlightOffer => {
      const found = id ? params.offers.find((o) => o.id === id) : params.offers[index];
      if (found) {
        return found;
      }
      const byIndex = params.offers[index];
      if (byIndex) {
        return byIndex;
      }
      throw new Error(`FlightOffer not found for id=${id ?? 'undefined'}, index=${index}`);
    };

    if (droppedCount > 0) {
      this.logger.warn(
        `Dropped ${droppedCount} invalid offers for searchHash ${params.searchHash}`,
        {
          searchHash: params.searchHash,
          droppedCount,
          rejectionCounts,
        },
      );
    }

    let profilePrefs: ScoringPreferences;
    const trimmedUserId = params.userId?.trim();

    if (trimmedUserId) {
      const fetched = await this.profileService.getScoringPreferences(trimmedUserId);
      profilePrefs = {
        preferredAirlines: fetched.preferredAirlines,
        blacklistedAirlines: fetched.blacklistedAirlines,
        classPreference: fetched.classPreference,
        preferredDepartureWindow: fetched.preferredDepartureWindow,
        preferredArrivalWindow: fetched.preferredArrivalWindow,
        maxStops: fetched.maxStops,
        priceSensitivity: fetched.priceSensitivity,
        requiresCheckedBaggage: fetched.requiresCheckedBaggage,
      };
    } else {
      profilePrefs = {
        preferredAirlines: [],
        blacklistedAirlines: [],
        classPreference: null,
        preferredDepartureWindow: null,
        preferredArrivalWindow: null,
        maxStops: null,
        priceSensitivity: null,
        requiresCheckedBaggage: null,
      };
    }

    const normalizedStoredCabin = normalizeCabinClass(profilePrefs.classPreference);
    const normalizedQueryCabin = normalizeCabinClass(params.query.cabinClass);

    const hasStoredPreference =
      profilePrefs.classPreference !== null &&
      profilePrefs.classPreference.trim() !== '';

    const effectiveClassPreference = hasStoredPreference
      ? (normalizedQueryCabin ?? normalizedStoredCabin)
      : null;

    const effectivePreferences: ScoringPreferences = {
      ...profilePrefs,
      classPreference: effectiveClassPreference,
    };

    const hasPersonalization = hasEffectivePreferences(effectivePreferences);

    if (!hasPersonalization) {
      const rankedOffers = this.categoryRanker.rank([...canonicalOffers]);
      const results: OrchestratedFlightResult[] = rankedOffers.map((offer) => ({
        offer: resolveFlightOffer(offer.originalIndex, offer.id),
        scoredOffer: {
          offer,
          matchResult: null,
        },
      }));

      const meta: SearchMeta = {
        totalResults: canonicalOffers.length,
        searchHash: params.searchHash,
        cached: params.cached,
        requestedCabinClass: params.query.cabinClass || 'economy',
        scoringVersion: null,
      };

      return {
        mode: 'RANKED',
        results,
        meta,
        droppedCount,
        rejectionCounts,
      };
    }

    const scoredOffers = this.scorer.scoreAll([...canonicalOffers], effectivePreferences);

    const results: OrchestratedFlightResult[] = scoredOffers.map((scoredOffer) => ({
      offer: resolveFlightOffer(scoredOffer.offer.originalIndex, scoredOffer.offer.id),
      scoredOffer,
    }));

    let eligibleCount = 0;
    const matchLevelCounts = { STRONG: 0, GOOD: 0, FAIR: 0, WEAK: 0 };

    for (const scored of scoredOffers) {
      if (scored.matchResult.eligibility.eligible) {
        eligibleCount++;
        if (scored.matchResult.matchLevel) {
          matchLevelCounts[scored.matchResult.matchLevel]++;
        }
      }
    }

    const meta: SearchMeta = {
      totalResults: canonicalOffers.length,
      searchHash: params.searchHash,
      cached: params.cached,
      requestedCabinClass: params.query.cabinClass || 'economy',
      scoringVersion: 'flight-match-v1',
      eligibleCount,
      matchLevelCounts,
    };

    return {
      mode: 'MATCHED',
      results,
      meta,
      droppedCount,
      rejectionCounts,
    };
  }
}
