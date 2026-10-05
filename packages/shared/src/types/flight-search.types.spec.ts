import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActiveWeightsSchema,
  CONSTRAINT_EXPLANATION_KEYS,
  ConstraintTypeSchema,
  ConstraintViolationSchema,
  DIMENSION_EXPLANATION_KEYS,
  DimensionScoreSchema,
  DimensionSignalSchema,
  EligibleFlightMatchResultSchema,
  ExplanationKeySchema,
  ExplanationSchema,
  FlightMatchDimensionSchema,
  FlightMatchMetadataSchema,
  FlightMatchResultSchema,
  FlightSearchMetaSchema,
  FlightSearchOfferViewSchema,
  FlightSearchOutcomeSchema,
  FlightSearchQuerySchema,
  FlightSearchSuccessOutcomeSchema,
  FlightSelectionOutcomeSchema,
  IneligibleFlightMatchResultSchema,
  MatchLevelSchema,
  getExpectedMatchLevel,
  type ActiveWeights,
  type ConstraintType,
  type ConstraintViolation,
  type DimensionScore,
  type DimensionSignal,
  type EligibleFlightMatchResult,
  type Explanation,
  type ExplanationKey,
  type FlightMatchDimension,
  type FlightMatchMetadata,
  type FlightMatchResult,
  type FlightSearchOutcome,
  type FlightSearchSuccessOutcome,
  type FlightSelectionOutcome,
  type IneligibleFlightMatchResult,
  type MatchLevel,
} from './flight-search.types';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type ExpectedFlightSelectionOutcome =
  | { ok: true; checkoutPath: string }
  | {
      ok: false;
      reason: 'OFFER_EXPIRED' | 'OFFER_UNAVAILABLE' | 'UNAUTHENTICATED';
      message: string;
      retryable: boolean;
    };
type FlightSelectionOutcomeInferenceParity = Assert<
  Equal<FlightSelectionOutcome, ExpectedFlightSelectionOutcome>
>;
void (0 as unknown as FlightSelectionOutcomeInferenceParity);

type ExpectedDimension =
  | 'PRICE'
  | 'AIRLINE'
  | 'ARRIVAL_SCHEDULE'
  | 'STOPS'
  | 'CABIN'
  | 'DEPARTURE_SCHEDULE'
  | 'BAGGAGE'
  | 'DURATION';
type DimensionInferenceParity = Assert<Equal<FlightMatchDimension, ExpectedDimension>>;
void (0 as unknown as DimensionInferenceParity);

type ExpectedSignal = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type SignalInferenceParity = Assert<Equal<DimensionSignal, ExpectedSignal>>;
void (0 as unknown as SignalInferenceParity);

type ExpectedMatchLevel = 'STRONG' | 'GOOD' | 'FAIR' | 'WEAK';
type MatchLevelInferenceParity = Assert<Equal<MatchLevel, ExpectedMatchLevel>>;
void (0 as unknown as MatchLevelInferenceParity);

type ExpectedExplanationKey =
  | 'match.price.below_median'
  | 'match.price.at_median'
  | 'match.price.above_median'
  | 'match.airline.preferred'
  | 'match.airline.neutral'
  | 'match.arrival.in_window'
  | 'match.arrival.near_window'
  | 'match.arrival.outside_window'
  | 'match.stops.within_preference'
  | 'match.stops.exceeds_preference'
  | 'match.stops.relative'
  | 'match.cabin.exact'
  | 'match.cabin.adjacent'
  | 'match.cabin.mismatch'
  | 'match.departure.in_window'
  | 'match.departure.near_window'
  | 'match.departure.outside_window'
  | 'match.baggage.checked_included'
  | 'match.baggage.checked_missing'
  | 'match.baggage.not_required'
  | 'match.duration.below_median'
  | 'match.duration.at_median'
  | 'match.duration.above_median'
  | 'constraint.airline.blacklisted';
type ExplanationKeyInferenceParity = Assert<Equal<ExplanationKey, ExpectedExplanationKey>>;
void (0 as unknown as ExplanationKeyInferenceParity);

type PriceParams = {
  difference?: string | number;
  percentDiff?: number;
  percentBelow?: number;
  currency?: string;
  isBest?: boolean;
};

type AirlineParams = {
  airline?: string;
};

type ScheduleParams = {
  time?: string;
  windowStart?: string | number;
  windowEnd?: string | number;
};

type StopsParams = {
  actual?: number;
  preferred?: number;
  stops?: number;
  maxStops?: number;
  minStops?: number;
};

type CabinParams = {
  expected?: string;
  actual?: string;
  cabin?: string;
};

type BaggageParams = {
  checkedBags?: number;
  required?: boolean;
};

type DurationParams = {
  difference?: string | number;
  percentDiff?: number;
  percentBelow?: number;
  minutes?: number;
};

type BlacklistedAirlineParams = {
  airline?: string;
};

type ExpectedExplanation =
  | { key: 'match.price.below_median'; params: PriceParams }
  | { key: 'match.price.at_median'; params: PriceParams }
  | { key: 'match.price.above_median'; params: PriceParams }
  | { key: 'match.airline.preferred'; params: AirlineParams }
  | { key: 'match.airline.neutral'; params: AirlineParams }
  | { key: 'match.arrival.in_window'; params: ScheduleParams }
  | { key: 'match.arrival.near_window'; params: ScheduleParams }
  | { key: 'match.arrival.outside_window'; params: ScheduleParams }
  | { key: 'match.stops.within_preference'; params: StopsParams }
  | { key: 'match.stops.exceeds_preference'; params: StopsParams }
  | { key: 'match.stops.relative'; params: StopsParams }
  | { key: 'match.cabin.exact'; params: CabinParams }
  | { key: 'match.cabin.adjacent'; params: CabinParams }
  | { key: 'match.cabin.mismatch'; params: CabinParams }
  | { key: 'match.departure.in_window'; params: ScheduleParams }
  | { key: 'match.departure.near_window'; params: ScheduleParams }
  | { key: 'match.departure.outside_window'; params: ScheduleParams }
  | { key: 'match.baggage.checked_included'; params: BaggageParams }
  | { key: 'match.baggage.checked_missing'; params: BaggageParams }
  | { key: 'match.baggage.not_required'; params: BaggageParams }
  | { key: 'match.duration.below_median'; params: DurationParams }
  | { key: 'match.duration.at_median'; params: DurationParams }
  | { key: 'match.duration.above_median'; params: DurationParams }
  | { key: 'constraint.airline.blacklisted'; params: BlacklistedAirlineParams };
type ExplanationInferenceParity = Assert<Equal<Explanation, ExpectedExplanation>>;
void (0 as unknown as ExplanationInferenceParity);

type ExpectedDimensionScore = {
  dimension: ExpectedDimension;
  score: number;
  weight: number;
  contribution: number;
  signal: ExpectedSignal;
  explanation: ExpectedExplanation;
};
type DimensionScoreInferenceParity = Assert<Equal<DimensionScore, ExpectedDimensionScore>>;
void (0 as unknown as DimensionScoreInferenceParity);

type ExpectedConstraintType = 'BLACKLISTED_AIRLINE';
type ConstraintTypeInferenceParity = Assert<Equal<ConstraintType, ExpectedConstraintType>>;
void (0 as unknown as ConstraintTypeInferenceParity);

type ExpectedConstraintViolation = {
  constraint: ExpectedConstraintType;
  explanation: ExpectedExplanation;
};
type ConstraintViolationInferenceParity = Assert<
  Equal<ConstraintViolation, ExpectedConstraintViolation>
>;
void (0 as unknown as ConstraintViolationInferenceParity);

type ExpectedActiveWeights = {
  PRICE: number;
  AIRLINE: number;
  ARRIVAL_SCHEDULE: number;
  STOPS: number;
  CABIN: number;
  DEPARTURE_SCHEDULE: number;
  BAGGAGE: number;
  DURATION: number;
};
type ActiveWeightsInferenceParity = Assert<Equal<ActiveWeights, ExpectedActiveWeights>>;
void (0 as unknown as ActiveWeightsInferenceParity);

type ExpectedFlightMatchMetadata = {
  scoringVersion: 'flight-match-v1';
  activeWeights: ExpectedActiveWeights;
};
type MetadataInferenceParity = Assert<
  Equal<FlightMatchMetadata, ExpectedFlightMatchMetadata>
>;
void (0 as unknown as MetadataInferenceParity);

type ExpectedEligibleResult = {
  eligibility: {
    eligible: true;
    violations: ConstraintViolation[];
  };
  score: number;
  matchLevel: ExpectedMatchLevel;
  breakdown: DimensionScore[];
  metadata: FlightMatchMetadata;
};
type EligibleResultParity = Assert<Equal<EligibleFlightMatchResult, ExpectedEligibleResult>>;
void (0 as unknown as EligibleResultParity);

type ExpectedIneligibleResult = {
  eligibility: {
    eligible: false;
    violations: ConstraintViolation[];
  };
  score: null;
  matchLevel: null;
  breakdown: DimensionScore[];
  metadata: FlightMatchMetadata;
};
type IneligibleResultParity = Assert<Equal<IneligibleFlightMatchResult, ExpectedIneligibleResult>>;
void (0 as unknown as IneligibleResultParity);

type FlightMatchResultParity = Assert<
  Equal<FlightMatchResult, EligibleFlightMatchResult | IneligibleFlightMatchResult>
>;
void (0 as unknown as FlightMatchResultParity);

const offer = {
  id: 'local-offer-01',
  price: 250.5,
  currency: 'USD',
  airline: 'Vietnam Airlines',
  flightNumber: 'VN123',
  origin: 'SGN',
  destination: 'HAN',
  departureAt: '2026-09-01T09:00:00Z',
  arrivalAt: '2026-09-01T11:10:00Z',
  duration: 'PT2H10M',
  stops: 0,
  slices: [
    {
      origin: 'SGN',
      destination: 'HAN',
      departureAt: '2026-09-01T09:00:00Z',
      arrivalAt: '2026-09-01T11:10:00Z',
      duration: 'PT2H10M',
      stops: 0,
      segments: [
        {
          airline: 'Vietnam Airlines',
          flightNumber: 'VN123',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: '2026-09-01T09:00:00Z',
          arrivalAt: '2026-09-01T11:10:00Z',
          duration: 'PT2H10M',
          cabinClass: 'economy',
        },
      ],
    },
  ],
};

const futureDate = (daysFromToday: number): string => {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + daysFromToday);
  return date.toISOString().slice(0, 10);
};

const validQuery = {
  origin: 'SGN',
  destination: 'HAN',
  departureDate: futureDate(2),
  returnDate: null,
  adults: 1,
  children: 0,
  infants: 0,
  cabinClass: 'economy' as const,
};

describe('Flight Search shared contracts', () => {
  it('parses valid query and success outcome', () => {
    assert.equal(FlightSearchQuerySchema.parse(validQuery).origin, 'SGN');

    const parsed: FlightSearchOutcome = FlightSearchOutcomeSchema.parse({
      ok: true,
      offers: [offer],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(parsed.ok, true);
  });

  it('parses valid search and selection failure outcomes', () => {
    assert.deepEqual(
      FlightSearchOutcomeSchema.parse({
        ok: false,
        reason: 'RATE_LIMITED',
        message: 'Try again shortly',
        retryable: true,
      }),
      { ok: false, reason: 'RATE_LIMITED', message: 'Try again shortly', retryable: true },
    );
    assert.deepEqual(
      FlightSelectionOutcomeSchema.parse({
        ok: false,
        reason: 'OFFER_EXPIRED',
        message: 'Choose another offer',
        retryable: true,
      }),
      { ok: false, reason: 'OFFER_EXPIRED', message: 'Choose another offer', retryable: true },
    );
  });

  it('parses a valid selection success outcome', () => {
    assert.deepEqual(
      FlightSelectionOutcomeSchema.parse({ ok: true, checkoutPath: '/checkout/local-offer-01' }),
      { ok: true, checkoutPath: '/checkout/local-offer-01' },
    );
  });

  it('rejects unexpected provider fields, malformed values, and unsupported reasons', () => {
    assert.throws(() => FlightSearchOfferViewSchema.parse({ ...offer, duffelOfferId: 'off_123' }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({
        origin: 'sgn',
        destination: 'HAN',
        departureDate: '2026/09/01',
        returnDate: null,
        adults: 0,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
      }),
    );
    assert.throws(() =>
      FlightSearchOutcomeSchema.parse({
        ok: false,
        reason: 'PROVIDER_ERROR',
        message: 'No',
        retryable: false,
      }),
    );
    assert.throws(() => FlightSelectionOutcomeSchema.parse({ ok: true }));
  });

  it('rejects semantically invalid search queries', () => {
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, destination: 'SGN' }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, adults: 8, children: 1, infants: 1 }),
    );
    assert.throws(() => FlightSearchQuerySchema.parse({ ...validQuery, infants: 2 }));
    assert.throws(() =>
      FlightSearchQuerySchema.parse({
        ...validQuery,
        departureDate: futureDate(3),
        returnDate: futureDate(2),
      }),
    );
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2026-02-31' }),
    );
    assert.throws(() =>
      FlightSearchQuerySchema.parse({ ...validQuery, departureDate: '2000-01-01' }),
    );
  });
});

const validDimensionScore: DimensionScore = {
  dimension: 'PRICE',
  score: 0.85,
  weight: 0.2,
  contribution: 0.17,
  signal: 'POSITIVE',
  explanation: {
    key: 'match.price.below_median',
    params: { difference: '15%' },
  },
};

const validMetadata: FlightMatchMetadata = {
  scoringVersion: 'flight-match-v1',
  activeWeights: {
    PRICE: 0.2,
    AIRLINE: 0.15,
    ARRIVAL_SCHEDULE: 0.15,
    STOPS: 0.12,
    CABIN: 0.1,
    DEPARTURE_SCHEDULE: 0.1,
    BAGGAGE: 0.1,
    DURATION: 0.08,
  },
};

const validEligibleMatchResult: EligibleFlightMatchResult = {
  eligibility: {
    eligible: true,
    violations: [],
  },
  score: 82,
  matchLevel: 'STRONG',
  breakdown: [validDimensionScore],
  metadata: validMetadata,
};

const validIneligibleMatchResult: IneligibleFlightMatchResult = {
  eligibility: {
    eligible: false,
    violations: [
      {
        constraint: 'BLACKLISTED_AIRLINE',
        explanation: {
          key: 'constraint.airline.blacklisted',
          params: { airline: 'XX' },
        },
      },
    ],
  },
  score: null,
  matchLevel: null,
  breakdown: [],
  metadata: validMetadata,
};

describe('T001: MATCHED eligibility, score, matchLevel, and breakdown schemas', () => {
  it('parses valid dimensions, signals, and match levels', () => {
    const dimensions = [
      'PRICE',
      'AIRLINE',
      'ARRIVAL_SCHEDULE',
      'STOPS',
      'CABIN',
      'DEPARTURE_SCHEDULE',
      'BAGGAGE',
      'DURATION',
    ] as const;
    for (const d of dimensions) {
      assert.equal(FlightMatchDimensionSchema.parse(d), d);
    }
    assert.throws(() => FlightMatchDimensionSchema.parse('DISTANCE'));

    for (const s of ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const) {
      assert.equal(DimensionSignalSchema.parse(s), s);
    }
    assert.throws(() => DimensionSignalSchema.parse('AVERAGE'));

    for (const l of ['STRONG', 'GOOD', 'FAIR', 'WEAK'] as const) {
      assert.equal(MatchLevelSchema.parse(l), l);
    }
    assert.throws(() => MatchLevelSchema.parse('EXCELLENT'));
  });

  it('parses valid EligibleFlightMatchResult and enforces score range (0..100) and match levels', () => {
    const parsed = EligibleFlightMatchResultSchema.parse(validEligibleMatchResult);
    assert.equal(parsed.eligibility.eligible, true);
    assert.equal(parsed.score, 82);
    assert.equal(parsed.matchLevel, 'STRONG');
    assert.equal(parsed.breakdown.length, 1);

    // Score boundary tests (valid score and matching level)
    assert.equal(
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score: 0,
        matchLevel: 'WEAK',
      }).score,
      0,
    );
    assert.equal(
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score: 100,
        matchLevel: 'STRONG',
      }).score,
      100,
    );

    // Rejects out of bound scores or float scores
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score: -1,
        matchLevel: 'WEAK',
      }),
    );
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score: 101,
        matchLevel: 'STRONG',
      }),
    );
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score: 82.5,
        matchLevel: 'STRONG',
      }),
    );

    // Rejects eligible with non-empty violations
    assert.throws(() =>
      EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        eligibility: {
          eligible: true,
          violations: [
            {
              constraint: 'BLACKLISTED_AIRLINE',
              explanation: { key: 'constraint.airline.blacklisted', params: {} },
            },
          ],
        },
      }),
    );
  });

  it('correlates scores to expected match levels with getExpectedMatchLevel helper', () => {
    assert.equal(getExpectedMatchLevel(0), 'WEAK');
    assert.equal(getExpectedMatchLevel(24), 'WEAK');
    assert.equal(getExpectedMatchLevel(25), 'FAIR');
    assert.equal(getExpectedMatchLevel(49), 'FAIR');
    assert.equal(getExpectedMatchLevel(50), 'GOOD');
    assert.equal(getExpectedMatchLevel(74), 'GOOD');
    assert.equal(getExpectedMatchLevel(75), 'STRONG');
    assert.equal(getExpectedMatchLevel(100), 'STRONG');
  });

  it('enforces score and matchLevel correlation in EligibleFlightMatchResultSchema', () => {
    // Valid boundary combinations
    const validPairs: [number, MatchLevel][] = [
      [0, 'WEAK'],
      [24, 'WEAK'],
      [25, 'FAIR'],
      [49, 'FAIR'],
      [50, 'GOOD'],
      [74, 'GOOD'],
      [75, 'STRONG'],
      [100, 'STRONG'],
    ];
    for (const [score, matchLevel] of validPairs) {
      const parsed = EligibleFlightMatchResultSchema.parse({
        ...validEligibleMatchResult,
        score,
        matchLevel,
      });
      assert.equal(parsed.score, score);
      assert.equal(parsed.matchLevel, matchLevel);
    }

    // Invalid / mismatched score and matchLevel pairs
    const invalidPairs: [number, MatchLevel][] = [
      [60, 'STRONG'],
      [80, 'FAIR'],
      [20, 'GOOD'],
      [45, 'WEAK'],
      [70, 'STRONG'],
      [10, 'FAIR'],
      [50, 'STRONG'],
      [74, 'FAIR'],
      [75, 'GOOD'],
      [0, 'STRONG'],
      [100, 'WEAK'],
    ];
    for (const [score, matchLevel] of invalidPairs) {
      assert.throws(() =>
        EligibleFlightMatchResultSchema.parse({
          ...validEligibleMatchResult,
          score,
          matchLevel,
        }),
      );
    }
  });

  it('parses valid IneligibleFlightMatchResult and enforces null score/level and empty breakdown', () => {
    const parsed = IneligibleFlightMatchResultSchema.parse(validIneligibleMatchResult);
    assert.equal(parsed.eligibility.eligible, false);
    assert.equal(parsed.score, null);
    assert.equal(parsed.matchLevel, null);
    assert.deepEqual(parsed.breakdown, []);
    assert.equal(parsed.eligibility.violations.length, 1);

    // Rejects non-null score or level for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({ ...validIneligibleMatchResult, score: 50 }),
    );
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({ ...validIneligibleMatchResult, matchLevel: 'FAIR' }),
    );

    // Rejects empty violations for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({
        ...validIneligibleMatchResult,
        eligibility: { eligible: false, violations: [] },
      }),
    );

    // Rejects non-empty breakdown for ineligible
    assert.throws(() =>
      IneligibleFlightMatchResultSchema.parse({
        ...validIneligibleMatchResult,
        breakdown: [validDimensionScore],
      }),
    );
  });

  it('parses FlightMatchResult union for both eligible and ineligible variants', () => {
    const parsedEligible = FlightMatchResultSchema.parse(validEligibleMatchResult);
    assert.equal(parsedEligible.eligibility.eligible, true);

    const parsedIneligible = FlightMatchResultSchema.parse(validIneligibleMatchResult);
    assert.equal(parsedIneligible.eligibility.eligible, false);

    assert.throws(() => FlightMatchResultSchema.parse({ unknown: true }));
  });

  it('validates DIMENSION_EXPLANATION_KEYS and CONSTRAINT_EXPLANATION_KEYS map all expected keys', () => {
    const dimensions: FlightMatchDimension[] = [
      'PRICE',
      'AIRLINE',
      'ARRIVAL_SCHEDULE',
      'STOPS',
      'CABIN',
      'DEPARTURE_SCHEDULE',
      'BAGGAGE',
      'DURATION',
    ];
    for (const d of dimensions) {
      assert.ok(DIMENSION_EXPLANATION_KEYS[d].length > 0);
      for (const key of DIMENSION_EXPLANATION_KEYS[d]) {
        assert.equal(ExplanationKeySchema.parse(key), key);
      }
    }

    assert.ok(CONSTRAINT_EXPLANATION_KEYS.BLACKLISTED_AIRLINE.length > 0);
    for (const key of CONSTRAINT_EXPLANATION_KEYS.BLACKLISTED_AIRLINE) {
      assert.equal(ExplanationKeySchema.parse(key), key);
    }
  });

  it('validates DimensionScore constraints', () => {
    assert.equal(DimensionScoreSchema.parse(validDimensionScore).dimension, 'PRICE');

    // Rejects score / weight / contribution out of range [0, 1]
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, score: -0.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, score: 1.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, weight: -0.01 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, weight: 1.01 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, contribution: -0.1 }));
    assert.throws(() => DimensionScoreSchema.parse({ ...validDimensionScore, contribution: 1.5 }));
  });

  it('validates DimensionScoreSchema accepts valid dimension-explanation pairs for all 8 dimensions', () => {
    const validScores: DimensionScore[] = [
      // PRICE (3 keys)
      {
        dimension: 'PRICE',
        score: 0.9,
        weight: 0.2,
        contribution: 0.18,
        signal: 'POSITIVE',
        explanation: { key: 'match.price.below_median', params: { difference: '15%' } },
      },
      {
        dimension: 'PRICE',
        score: 0.6,
        weight: 0.2,
        contribution: 0.12,
        signal: 'NEUTRAL',
        explanation: { key: 'match.price.at_median', params: { currency: 'USD' } },
      },
      {
        dimension: 'PRICE',
        score: 0.2,
        weight: 0.2,
        contribution: 0.04,
        signal: 'NEGATIVE',
        explanation: { key: 'match.price.above_median', params: { percentDiff: -20 } },
      },
      // AIRLINE (2 keys)
      {
        dimension: 'AIRLINE',
        score: 1.0,
        weight: 0.15,
        contribution: 0.15,
        signal: 'POSITIVE',
        explanation: { key: 'match.airline.preferred', params: { airline: 'Vietnam Airlines' } },
      },
      {
        dimension: 'AIRLINE',
        score: 0.5,
        weight: 0.15,
        contribution: 0.075,
        signal: 'NEUTRAL',
        explanation: { key: 'match.airline.neutral', params: { airline: 'VietJet Air' } },
      },
      // ARRIVAL_SCHEDULE (3 keys)
      {
        dimension: 'ARRIVAL_SCHEDULE',
        score: 1.0,
        weight: 0.15,
        contribution: 0.15,
        signal: 'POSITIVE',
        explanation: { key: 'match.arrival.in_window', params: { time: '14:30' } },
      },
      {
        dimension: 'ARRIVAL_SCHEDULE',
        score: 0.5,
        weight: 0.15,
        contribution: 0.075,
        signal: 'NEUTRAL',
        explanation: { key: 'match.arrival.near_window', params: { time: '19:00' } },
      },
      {
        dimension: 'ARRIVAL_SCHEDULE',
        score: 0.1,
        weight: 0.15,
        contribution: 0.015,
        signal: 'NEGATIVE',
        explanation: { key: 'match.arrival.outside_window', params: { time: '22:00' } },
      },
      // STOPS (3 keys)
      {
        dimension: 'STOPS',
        score: 1.0,
        weight: 0.1,
        contribution: 0.1,
        signal: 'POSITIVE',
        explanation: { key: 'match.stops.within_preference', params: { actual: 0, preferred: 0 } },
      },
      {
        dimension: 'STOPS',
        score: 0.3,
        weight: 0.1,
        contribution: 0.03,
        signal: 'NEGATIVE',
        explanation: { key: 'match.stops.exceeds_preference', params: { actual: 2, preferred: 1 } },
      },
      {
        dimension: 'STOPS',
        score: 0.7,
        weight: 0.1,
        contribution: 0.07,
        signal: 'NEUTRAL',
        explanation: { key: 'match.stops.relative', params: { actual: 1, preferred: 0 } },
      },
      // CABIN (3 keys)
      {
        dimension: 'CABIN',
        score: 1.0,
        weight: 0.1,
        contribution: 0.1,
        signal: 'POSITIVE',
        explanation: { key: 'match.cabin.exact', params: { expected: 'economy', actual: 'economy' } },
      },
      {
        dimension: 'CABIN',
        score: 0.6,
        weight: 0.1,
        contribution: 0.06,
        signal: 'NEUTRAL',
        explanation: { key: 'match.cabin.adjacent', params: { expected: 'premium_economy', actual: 'economy' } },
      },
      {
        dimension: 'CABIN',
        score: 0.0,
        weight: 0.1,
        contribution: 0.0,
        signal: 'NEGATIVE',
        explanation: { key: 'match.cabin.mismatch', params: { expected: 'business', actual: 'economy' } },
      },
      // DEPARTURE_SCHEDULE (3 keys)
      {
        dimension: 'DEPARTURE_SCHEDULE',
        score: 1.0,
        weight: 0.1,
        contribution: 0.1,
        signal: 'POSITIVE',
        explanation: { key: 'match.departure.in_window', params: { time: '09:00' } },
      },
      {
        dimension: 'DEPARTURE_SCHEDULE',
        score: 0.5,
        weight: 0.1,
        contribution: 0.05,
        signal: 'NEUTRAL',
        explanation: { key: 'match.departure.near_window', params: { time: '07:30' } },
      },
      {
        dimension: 'DEPARTURE_SCHEDULE',
        score: 0.1,
        weight: 0.1,
        contribution: 0.01,
        signal: 'NEGATIVE',
        explanation: { key: 'match.departure.outside_window', params: { time: '23:00' } },
      },
      // BAGGAGE (3 keys)
      {
        dimension: 'BAGGAGE',
        score: 1.0,
        weight: 0.1,
        contribution: 0.1,
        signal: 'POSITIVE',
        explanation: { key: 'match.baggage.checked_included', params: { checkedBags: 1, required: true } },
      },
      {
        dimension: 'BAGGAGE',
        score: 0.2,
        weight: 0.1,
        contribution: 0.02,
        signal: 'NEGATIVE',
        explanation: { key: 'match.baggage.checked_missing', params: { checkedBags: 0, required: true } },
      },
      {
        dimension: 'BAGGAGE',
        score: 0.8,
        weight: 0.1,
        contribution: 0.08,
        signal: 'NEUTRAL',
        explanation: { key: 'match.baggage.not_required', params: { checkedBags: 0, required: false } },
      },
      // DURATION (3 keys)
      {
        dimension: 'DURATION',
        score: 0.9,
        weight: 0.1,
        contribution: 0.09,
        signal: 'POSITIVE',
        explanation: { key: 'match.duration.below_median', params: { difference: '30m', minutes: 120 } },
      },
      {
        dimension: 'DURATION',
        score: 0.5,
        weight: 0.1,
        contribution: 0.05,
        signal: 'NEUTRAL',
        explanation: { key: 'match.duration.at_median', params: { percentDiff: 0, minutes: 150 } },
      },
      {
        dimension: 'DURATION',
        score: 0.2,
        weight: 0.1,
        contribution: 0.02,
        signal: 'NEGATIVE',
        explanation: { key: 'match.duration.above_median', params: { minutes: 195 } },
      },
    ];

    for (const score of validScores) {
      const parsed = DimensionScoreSchema.parse(score);
      assert.equal(parsed.dimension, score.dimension);
      assert.equal(parsed.explanation.key, score.explanation.key);
    }
  });

  it('rejects mismatched dimension-explanation pairs in DimensionScoreSchema', () => {
    const invalidPairs: { dimension: FlightMatchDimension; explanation: Explanation }[] = [
      {
        dimension: 'PRICE',
        explanation: { key: 'match.airline.preferred', params: { airline: 'VN' } },
      },
      {
        dimension: 'CABIN',
        explanation: { key: 'match.price.below_median', params: { difference: '15%' } },
      },
      {
        dimension: 'DURATION',
        explanation: { key: 'match.stops.relative', params: { actual: 1 } },
      },
      {
        dimension: 'AIRLINE',
        explanation: { key: 'match.arrival.in_window', params: { time: '12:00' } },
      },
      {
        dimension: 'ARRIVAL_SCHEDULE',
        explanation: { key: 'match.departure.in_window', params: { time: '12:00' } },
      },
      {
        dimension: 'STOPS',
        explanation: { key: 'match.baggage.checked_included', params: { checkedBags: 1 } },
      },
      {
        dimension: 'DEPARTURE_SCHEDULE',
        explanation: { key: 'match.cabin.exact', params: { expected: 'economy' } },
      },
      {
        dimension: 'BAGGAGE',
        explanation: { key: 'match.duration.below_median', params: { minutes: 120 } },
      },
      {
        dimension: 'PRICE',
        explanation: { key: 'constraint.airline.blacklisted', params: { airline: 'XX' } },
      },
    ];

    for (const { dimension, explanation } of invalidPairs) {
      assert.throws(() =>
        DimensionScoreSchema.parse({
          dimension,
          score: 0.8,
          weight: 0.2,
          contribution: 0.16,
          signal: 'POSITIVE',
          explanation,
        }),
      );
    }
  });
});

describe('T002: RANKED nullability, active weights, explanation params, and provider-ID rejection', () => {
  it('allows matchResult to be null, omitted, or a valid FlightMatchResult in FlightSearchOfferViewSchema', () => {
    // matchResult null (RANKED mode)
    const offerWithNullMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: null,
    });
    assert.equal(offerWithNullMatch.matchResult, null);

    // matchResult omitted (legacy/unspecified)
    const offerWithoutMatch = FlightSearchOfferViewSchema.parse(offer);
    assert.equal(offerWithoutMatch.matchResult, undefined);

    // matchResult with eligible match result (MATCHED mode)
    const offerWithEligibleMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: validEligibleMatchResult,
    });
    assert.equal(offerWithEligibleMatch.matchResult?.score, 82);

    // matchResult with ineligible match result
    const offerWithIneligibleMatch = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: validIneligibleMatchResult,
    });
    assert.equal(offerWithIneligibleMatch.matchResult?.score, null);
  });

  it('strictly rejects provider-ID and supplier keys in FlightSearchOfferViewSchema', () => {
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        duffelOfferId: 'off_123456',
      }),
    );
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        supplierOfferId: 'sup_999',
      }),
    );
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        rawOffer: {},
      }),
    );
  });

  it('validates ActiveWeightsSchema requiring all 8 dimensions and exact 1.000000 normalized sum', () => {
    // Valid base weights
    const parsedBase = ActiveWeightsSchema.parse(validMetadata.activeWeights);
    assert.equal(parsedBase.PRICE, 0.2);

    // Valid equal distribution
    const equalWeights: ActiveWeights = {
      PRICE: 0.125,
      AIRLINE: 0.125,
      ARRIVAL_SCHEDULE: 0.125,
      STOPS: 0.125,
      CABIN: 0.125,
      DEPARTURE_SCHEDULE: 0.125,
      BAGGAGE: 0.125,
      DURATION: 0.125,
    };
    assert.deepEqual(ActiveWeightsSchema.parse(equalWeights), equalWeights);

    // Valid six-decimal rounded sum
    const sixDecimalWeights: ActiveWeights = {
      PRICE: 0.333334,
      AIRLINE: 0.333333,
      ARRIVAL_SCHEDULE: 0.333333,
      STOPS: 0,
      CABIN: 0,
      DEPARTURE_SCHEDULE: 0,
      BAGGAGE: 0,
      DURATION: 0,
    };
    assert.deepEqual(ActiveWeightsSchema.parse(sixDecimalWeights), sixDecimalWeights);

    // Rejects missing dimensions (e.g. missing DURATION)
    const missingDuration = { ...validMetadata.activeWeights };
    delete (missingDuration as { DURATION?: number }).DURATION;
    assert.throws(() => ActiveWeightsSchema.parse(missingDuration));

    // Rejects missing all except some dimensions
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        PRICE: 0.5,
        AIRLINE: 0.5,
      }),
    );

    // Rejects sums less than 1.000000 (e.g. sum = 0.8)
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        PRICE: 0.0,
      }),
    );

    // Rejects sums greater than 1.000000 (e.g. sum = 1.2)
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        PRICE: 0.4,
      }),
    );

    // Rejects small precision deviations not rounding to 1.000000
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        PRICE: 0.200005,
      }),
    );

    // Rejects negative weights or weights > 1
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        PRICE: -0.1,
        AIRLINE: 0.45,
      }),
    );
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        PRICE: 1.05,
      }),
    );

    // Rejects extra/unknown keys (strict)
    assert.throws(() =>
      ActiveWeightsSchema.parse({
        ...validMetadata.activeWeights,
        UNKNOWN_DIM: 0,
      }),
    );
  });

  it('validates FlightMatchMetadata active weights precision and keys', () => {
    const parsed = FlightMatchMetadataSchema.parse(validMetadata);
    assert.equal(parsed.scoringVersion, 'flight-match-v1');
    assert.equal(parsed.activeWeights.PRICE, 0.2);

    // Rejects unknown scoring version
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        scoringVersion: 'flight-match-v2',
      }),
    );

    // Rejects metadata with non-normalized weights
    assert.throws(() =>
      FlightMatchMetadataSchema.parse({
        ...validMetadata,
        activeWeights: { ...validMetadata.activeWeights, PRICE: 0.1 },
      }),
    );
  });

  it('validates ExplanationKeySchema parsing all 24 allowlisted keys and rejecting unknown keys', () => {
    const all24Keys = [
      'match.price.below_median',
      'match.price.at_median',
      'match.price.above_median',
      'match.airline.preferred',
      'match.airline.neutral',
      'match.arrival.in_window',
      'match.arrival.near_window',
      'match.arrival.outside_window',
      'match.stops.within_preference',
      'match.stops.exceeds_preference',
      'match.stops.relative',
      'match.cabin.exact',
      'match.cabin.adjacent',
      'match.cabin.mismatch',
      'match.departure.in_window',
      'match.departure.near_window',
      'match.departure.outside_window',
      'match.baggage.checked_included',
      'match.baggage.checked_missing',
      'match.baggage.not_required',
      'match.duration.below_median',
      'match.duration.at_median',
      'match.duration.above_median',
      'constraint.airline.blacklisted',
    ] as const;

    for (const key of all24Keys) {
      assert.equal(ExplanationKeySchema.parse(key), key);
    }

    assert.throws(() => ExplanationKeySchema.parse('match.price.unknown'));
    assert.throws(() => ExplanationKeySchema.parse('match.foo'));
    assert.throws(() => ExplanationKeySchema.parse(''));
    assert.throws(() => ExplanationKeySchema.parse('constraint.unknown'));
  });

  it('validates ExplanationSchema with all 24 allowlisted keys, key-specific params, and empty params', () => {
    const validExplanations: Explanation[] = [
      {
        key: 'match.price.below_median',
        params: {
          difference: '15%',
          percentDiff: 15.5,
          percentBelow: 15.5,
          currency: 'USD',
          isBest: true,
        },
      },
      { key: 'match.price.at_median', params: { percentDiff: 0, currency: 'USD' } },
      {
        key: 'match.price.above_median',
        params: { difference: 50, percentDiff: -20, currency: 'USD' },
      },
      { key: 'match.airline.preferred', params: { airline: 'Vietnam Airlines' } },
      { key: 'match.airline.neutral', params: { airline: 'VietJet Air' } },
      { key: 'match.arrival.in_window', params: { time: '14:30', windowStart: 12, windowEnd: 18 } },
      {
        key: 'match.arrival.near_window',
        params: { time: '19:00', windowStart: '12:00', windowEnd: '18:00' },
      },
      {
        key: 'match.arrival.outside_window',
        params: { time: '22:00', windowStart: 8, windowEnd: 12 },
      },
      {
        key: 'match.stops.within_preference',
        params: { actual: 0, preferred: 0, stops: 0, maxStops: 1, minStops: 0 },
      },
      {
        key: 'match.stops.exceeds_preference',
        params: { actual: 2, preferred: 1, stops: 2, maxStops: 1 },
      },
      { key: 'match.stops.relative', params: { actual: 1, preferred: 0, stops: 1 } },
      {
        key: 'match.cabin.exact',
        params: { expected: 'economy', actual: 'economy', cabin: 'economy' },
      },
      {
        key: 'match.cabin.adjacent',
        params: { expected: 'premium_economy', actual: 'economy', cabin: 'economy' },
      },
      {
        key: 'match.cabin.mismatch',
        params: { expected: 'business', actual: 'economy', cabin: 'economy' },
      },
      {
        key: 'match.departure.in_window',
        params: { time: '09:00', windowStart: 8, windowEnd: 12 },
      },
      {
        key: 'match.departure.near_window',
        params: { time: '07:30', windowStart: 8, windowEnd: 12 },
      },
      {
        key: 'match.departure.outside_window',
        params: { time: '23:00', windowStart: 8, windowEnd: 12 },
      },
      { key: 'match.baggage.checked_included', params: { checkedBags: 1, required: true } },
      { key: 'match.baggage.checked_missing', params: { checkedBags: 0, required: true } },
      { key: 'match.baggage.not_required', params: { checkedBags: 0, required: false } },
      {
        key: 'match.duration.below_median',
        params: { difference: '30m', percentDiff: 10, percentBelow: 10, minutes: 120 },
      },
      { key: 'match.duration.at_median', params: { percentDiff: 0, minutes: 150 } },
      {
        key: 'match.duration.above_median',
        params: { difference: 45, percentDiff: -15, minutes: 195 },
      },
      { key: 'constraint.airline.blacklisted', params: { airline: 'XX' } },
    ];

    for (const exp of validExplanations) {
      const parsed = ExplanationSchema.parse(exp);
      assert.equal(parsed.key, exp.key);
      assert.deepEqual(parsed.params, exp.params);

      // Also verify empty params object {} is accepted for all keys
      const emptyParsed = ExplanationSchema.parse({ key: exp.key, params: {} });
      assert.equal(emptyParsed.key, exp.key);
      assert.deepEqual(emptyParsed.params, {});
    }
  });

  it('strictly rejects unknown keys, unpermitted params on known keys, and non-primitives in ExplanationSchema', () => {
    // Unknown keys
    assert.throws(() => ExplanationSchema.parse({ key: 'match.unknown', params: {} }));
    assert.throws(() => ExplanationSchema.parse({ key: '', params: {} }));
    assert.throws(() => ExplanationSchema.parse({ key: 'match.price.unknown_key', params: {} }));

    // Unpermitted params on price explanation
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: { airline: 'VN' },
      }),
    );
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: { unexpectedParam: 123 },
      }),
    );

    // Unpermitted params on airline explanation
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.airline.preferred',
        params: { percentDiff: 10 },
      }),
    );

    // Unpermitted params on stops explanation
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.stops.within_preference',
        params: { currency: 'USD' },
      }),
    );

    // Unpermitted params on baggage explanation
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.baggage.checked_included',
        params: { minutes: 100 },
      }),
    );

    // Non-primitive params (nested objects or arrays)
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: { percentDiff: { value: 15 } as unknown as number },
      }),
    );
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.airline.preferred',
        params: { airline: ['VN'] as unknown as string },
      }),
    );

    // Extra keys on top-level explanation object
    assert.throws(() =>
      ExplanationSchema.parse({
        key: 'match.price.below_median',
        params: {},
        extra: true,
      }),
    );
  });

  it('validates ConstraintViolation schema', () => {
    assert.equal(ConstraintTypeSchema.parse('BLACKLISTED_AIRLINE'), 'BLACKLISTED_AIRLINE');
    assert.throws(() => ConstraintTypeSchema.parse('WHITELISTED'));

    const violation: ConstraintViolation = {
      constraint: 'BLACKLISTED_AIRLINE',
      explanation: {
        key: 'constraint.airline.blacklisted',
        params: { airline: 'XX' },
      },
    };
    const parsed = ConstraintViolationSchema.parse(violation);
    assert.equal(parsed.constraint, 'BLACKLISTED_AIRLINE');
    assert.equal(parsed.explanation.key, 'constraint.airline.blacklisted');
    if (parsed.explanation.key === 'constraint.airline.blacklisted') {
      assert.equal(parsed.explanation.params.airline, 'XX');
    }

    assert.throws(() =>
      ConstraintViolationSchema.parse({
        constraint: 'INVALID_CONSTRAINT',
        explanation: { key: 'foo', params: {} },
      }),
    );
  });

  it('validates ConstraintViolationSchema accepts valid BLACKLISTED_AIRLINE with constraint.airline.blacklisted and rejects other explanation keys', () => {
    const validViolation: ConstraintViolation = {
      constraint: 'BLACKLISTED_AIRLINE',
      explanation: {
        key: 'constraint.airline.blacklisted',
        params: { airline: 'XX' },
      },
    };
    const parsed = ConstraintViolationSchema.parse(validViolation);
    assert.equal(parsed.constraint, 'BLACKLISTED_AIRLINE');
    assert.equal(parsed.explanation.key, 'constraint.airline.blacklisted');

    // Rejects other explanation keys
    const nonConstraintExplanations: Explanation[] = [
      { key: 'match.airline.preferred', params: { airline: 'XX' } },
      { key: 'match.price.below_median', params: { difference: '10%' } },
      { key: 'match.stops.relative', params: { actual: 1 } },
      { key: 'match.arrival.in_window', params: { time: '12:00' } },
      { key: 'match.cabin.exact', params: { expected: 'economy' } },
      { key: 'match.departure.in_window', params: { time: '12:00' } },
      { key: 'match.baggage.checked_included', params: { checkedBags: 1 } },
      { key: 'match.duration.below_median', params: { minutes: 120 } },
    ];

    for (const explanation of nonConstraintExplanations) {
      assert.throws(() =>
        ConstraintViolationSchema.parse({
          constraint: 'BLACKLISTED_AIRLINE',
          explanation,
        }),
      );
    }
  });

  it('validates FlightSearchMetaSchema with optional scoringVersion, eligibleCount, and matchLevelCounts', () => {
    const metaWithScoring = FlightSearchMetaSchema.parse({
      totalCount: 1,
      currency: 'USD',
      minPrice: 250.5,
      maxPrice: 250.5,
      airlines: ['Vietnam Airlines'],
      scoringVersion: 'flight-match-v1',
      eligibleCount: 1,
      matchLevelCounts: {
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      },
    });
    assert.equal(metaWithScoring.scoringVersion, 'flight-match-v1');
    assert.equal(metaWithScoring.eligibleCount, 1);
    assert.equal(metaWithScoring.matchLevelCounts?.STRONG, 1);

    // Accepts meta without optional scoring fields
    const baseMeta = FlightSearchMetaSchema.parse({
      totalCount: 1,
      currency: 'USD',
      minPrice: 250.5,
      maxPrice: 250.5,
      airlines: ['Vietnam Airlines'],
    });
    assert.equal(baseMeta.scoringVersion, undefined);
    assert.equal(baseMeta.eligibleCount, undefined);

    // Rejects invalid matchLevelCounts (e.g. negative numbers)
    assert.throws(() =>
      FlightSearchMetaSchema.parse({
        ...metaWithScoring,
        matchLevelCounts: { STRONG: -1, GOOD: 0, FAIR: 0, WEAK: 0 },
      }),
    );

    // Rejects unexpected provider fields in meta
    assert.throws(() =>
      FlightSearchMetaSchema.parse({
        ...metaWithScoring,
        duffelSearchId: 'sea_123',
      }),
    );
  });

  it('validates FlightSearchSuccessOutcomeSchema with mode MATCHED, RANKED, or omitted', () => {
    const matchedOutcome: FlightSearchSuccessOutcome = FlightSearchSuccessOutcomeSchema.parse({
      ok: true,
      mode: 'MATCHED',
      offers: [{ ...offer, matchResult: validEligibleMatchResult }],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(matchedOutcome.mode, 'MATCHED');

    const rankedOutcome: FlightSearchSuccessOutcome = FlightSearchSuccessOutcomeSchema.parse({
      ok: true,
      mode: 'RANKED',
      offers: [{ ...offer, matchResult: null }],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 250.5,
        maxPrice: 250.5,
        airlines: ['Vietnam Airlines'],
      },
    });
    assert.equal(rankedOutcome.mode, 'RANKED');

    // Also parses through FlightSearchOutcomeSchema union
    const parsedViaUnion = FlightSearchOutcomeSchema.parse(matchedOutcome);
    assert.equal(parsedViaUnion.ok, true);

    // Rejects invalid mode
    assert.throws(() =>
      FlightSearchSuccessOutcomeSchema.parse({
        ...matchedOutcome,
        mode: 'CUSTOM_SORT',
      }),
    );
  });
});

describe('T044 FlightSearchOfferView compatibility baseline', () => {
  it('pins the RANKED offer JSON keys and rejects both provider identity spellings', (): void => {
    const parsedOffer = FlightSearchOfferViewSchema.parse({
      ...offer,
      matchResult: null,
    });

    assert.equal(parsedOffer.matchResult, null);
    assert.deepEqual(Object.keys(parsedOffer).sort(), [
      'airline',
      'arrivalAt',
      'currency',
      'departureAt',
      'destination',
      'duration',
      'flightNumber',
      'id',
      'matchResult',
      'origin',
      'price',
      'slices',
      'stops',
    ]);
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        duffelOfferId: 'off_123456',
      }),
    );
    assert.throws(() =>
      FlightSearchOfferViewSchema.parse({
        ...offer,
        supplierOfferId: 'sup_999',
      }),
    );
  });
});
