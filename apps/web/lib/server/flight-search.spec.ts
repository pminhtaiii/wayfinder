import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { FlightSearchOfferView, FlightSearchQuery } from '@shared/types/flight-search.types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);
type TestSession = { accessToken?: string } | null;

let session: TestSession = null;
const getServerSession = mock.fn(async (): Promise<TestSession> => session);
const resolvePath = (specifier: string): string => {
  try {
    return testRequire.resolve(specifier);
  } catch {
    return require.resolve(specifier, {
      paths: [
        path.resolve(__dirname, '../../node_modules'),
        path.resolve(process.cwd(), 'apps/web/node_modules'),
        path.resolve(process.cwd(), 'node_modules'),
      ],
    });
  }
};

const nextAuthPath = resolvePath('next-auth');
const originalNextAuthModule = testRequire.cache[nextAuthPath];
testRequire.cache[nextAuthPath] = {
  exports: { getServerSession, default: { getServerSession } },
} as NodeModule;
const serverOnlyPath = resolvePath('server-only');
const originalServerOnlyModule = testRequire.cache[serverOnlyPath];
testRequire.cache[serverOnlyPath] = { exports: {} } as NodeModule;

after((): void => {
  if (originalNextAuthModule) {
    testRequire.cache[nextAuthPath] = originalNextAuthModule;
  } else {
    delete testRequire.cache[nextAuthPath];
  }

  if (originalServerOnlyModule) {
    testRequire.cache[serverOnlyPath] = originalServerOnlyModule;
    return;
  }

  delete testRequire.cache[serverOnlyPath];
});

let searchFlights: typeof import('./flight-search').searchFlights;
let selectFlightOffer: typeof import('./flight-search').selectFlightOffer;

before(async (): Promise<void> => {
  ({ searchFlights, selectFlightOffer } = await import('./flight-search.ts'));
});

const validQuery: FlightSearchQuery = {
  origin: 'SFO',
  destination: 'JFK',
  departureDate: '2027-11-15',
  returnDate: null,
  adults: 2,
  children: 1,
  infants: 0,
  cabinClass: 'economy',
};

const upstreamOffer = {
  id: 'local-offer-001',
  duffelOfferId: 'off_provider_secret',
  airline: 'Mock Horizon Air',
  flightNumber: 'HZ789',
  departureAirport: 'SFO',
  arrivalAirport: 'JFK',
  departureTime: '2027-11-15T08:00:00.000Z',
  arrivalTime: '2027-11-15T16:30:00.000Z',
  duration: 510,
  stops: 0,
  price: 285,
  currency: 'USD',
  fareClass: 'Y',
  requestedCabinClass: 'economy',
  cabinClassMatch: 'full',
  cabinMismatchDetails: null,
  baggageAllowance: null,
  segments: [
    {
      carrierCode: 'HZ',
      flightNumber: '789',
      operatingCarrier: 'Mock Horizon Air',
      departureAirport: 'SFO',
      departureTerminal: null,
      departureTime: '2027-11-15T08:00:00.000Z',
      arrivalAirport: 'JFK',
      arrivalTerminal: null,
      arrivalTime: '2027-11-15T16:30:00.000Z',
      duration: 510,
      aircraft: null,
      cabinClass: 'economy',
    },
  ],
  returnSegments: null,
};

// On 2026-09-02 the user approved strict-contract fixture corrections so intended-valid payloads include required metadata and normalized eligible breakdowns.
const validBreakdown = [
  {
    dimension: 'PRICE',
    score: 0.88,
    weight: 1,
    contribution: 0.88,
    signal: 'POSITIVE',
    explanation: {
      key: 'match.price.below_median',
      params: { percentDiff: 12 },
    },
  },
];

const validMatchResult = {
  eligibility: { eligible: true, violations: [] },
  score: 88,
  matchLevel: 'STRONG',
  breakdown: validBreakdown,
  metadata: {
    scoringVersion: 'flight-match-v1',
    activeWeights: {
      PRICE: 0.35,
      AIRLINE: 0.15,
      ARRIVAL_SCHEDULE: 0.1,
      STOPS: 0.1,
      CABIN: 0.1,
      DEPARTURE_SCHEDULE: 0.1,
      BAGGAGE: 0.05,
      DURATION: 0.05,
    },
  },
};

const validSearchMetaBase = {
  totalResults: 1,
  searchHash: 'search-hash-001',
  cached: false,
  requestedCabinClass: 'economy',
};

const validRankedMeta = {
  ...validSearchMetaBase,
  scoringVersion: null,
};

const validMatchedMeta = {
  ...validSearchMetaBase,
  scoringVersion: 'flight-match-v1',
  eligibleCount: 1,
  matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0, WEAK: 0 },
};

describe('flight-search server seam', () => {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach((): void => {
    process.env = { ...originalEnvironment, API_URL: 'http://private-api.example/' };
    session = { accessToken: 'session-token' };
    getServerSession.mock.resetCalls();
  });

  afterEach((): void => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    session = null;
  });

  it('maps an authenticated upstream response to an opaque shared view', async (): Promise<void> => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [{ ...upstreamOffer, matchResult: null }],
          meta: validRankedMeta,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: true,
      mode: 'RANKED',
      offers: [
        {
          id: 'local-offer-001',
          price: 285,
          currency: 'USD',
          airline: 'Mock Horizon Air',
          flightNumber: 'HZ789',
          origin: 'SFO',
          destination: 'JFK',
          departureAt: '2027-11-15T08:00:00.000Z',
          arrivalAt: '2027-11-15T16:30:00.000Z',
          duration: 'PT8H30M',
          stops: 0,
          slices: [
            {
              origin: 'SFO',
              destination: 'JFK',
              departureAt: '2027-11-15T08:00:00.000Z',
              arrivalAt: '2027-11-15T16:30:00.000Z',
              duration: 'PT8H30M',
              stops: 0,
              segments: [
                {
                  airline: 'Mock Horizon Air',
                  flightNumber: 'HZ789',
                  origin: 'SFO',
                  destination: 'JFK',
                  departureAt: '2027-11-15T08:00:00.000Z',
                  arrivalAt: '2027-11-15T16:30:00.000Z',
                  duration: 'PT8H30M',
                  cabinClass: 'economy',
                },
              ],
            },
          ],
          matchResult: null,
        },
      ],
      meta: {
        totalCount: 1,
        currency: 'USD',
        minPrice: 285,
        maxPrice: 285,
        airlines: ['Mock Horizon Air'],
        scoringVersion: null,
      },
    });
    assert.match(requestedUrl, /^http:\/\/private-api\.example\/api\/flights\/search$/);
    assert.strictEqual(requestedInit?.method, 'POST');
    assert.strictEqual(
      (requestedInit?.headers as HeadersInit & { Authorization?: string }).Authorization,
      'Bearer session-token',
    );
    assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
  });

  it('rejects provider-prefixed public offer identifiers case-insensitively', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [{ ...upstreamOffer, id: 'OFF_provider-visible', matchResult: null }],
          meta: validRankedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('preserves ranked local IDs and upstream order while stripping provider IDs', async (): Promise<void> => {
    const firstOffer = { ...upstreamOffer, id: 'local-id_001~opaque', price: 310, matchResult: null };
    const secondOffer = { ...upstreamOffer, id: 'local-id_002~opaque', price: 285, matchResult: null };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [firstOffer, secondOffer],
          meta: { ...validRankedMeta, totalResults: 2 },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.deepEqual(
        outcome.offers.map((offer: FlightSearchOfferView): { id: string; price: number } => ({
          id: offer.id,
          price: offer.price,
        })),
        [
          { id: 'local-id_001~opaque', price: 310 },
          { id: 'local-id_002~opaque', price: 285 },
        ],
      );
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('rejects MATCHED and RANKED responses containing more than 20 offers', async (): Promise<void> => {
    const modes: Array<'MATCHED' | 'RANKED'> = ['MATCHED', 'RANKED'];

    for (const mode of modes) {
      const results: Array<Record<string, unknown>> = Array.from(
        { length: 21 },
        (_value: undefined, index: number): Record<string, unknown> => ({
          ...upstreamOffer,
          id: `local-offer-${index}`,
          matchResult: mode === 'MATCHED' ? validMatchResult : null,
        }),
      );
      const meta =
        mode === 'MATCHED'
          ? {
              ...validMatchedMeta,
              totalResults: 21,
              eligibleCount: 21,
              matchLevelCounts: { STRONG: 21, GOOD: 0, FAIR: 0, WEAK: 0 },
            }
          : { ...validRankedMeta, totalResults: 21 };
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ mode, results, meta }), { status: 200 });

      const outcome = await searchFlights(validQuery);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        message: 'Flight search returned an invalid response. Please try again.',
        retryable: true,
      });
    }
  });

  it('rejects MATCHED and RANKED responses missing required base metadata', async (): Promise<void> => {
    const modes: Array<'MATCHED' | 'RANKED'> = ['MATCHED', 'RANKED'];
    const requiredFields: string[] = [
      'totalResults',
      'searchHash',
      'cached',
      'requestedCabinClass',
    ];

    for (const mode of modes) {
      for (const requiredField of requiredFields) {
        const meta: Record<string, unknown> = {
          ...(mode === 'MATCHED' ? validMatchedMeta : validRankedMeta),
        };
        delete meta[requiredField];
        const results = [
          {
            ...upstreamOffer,
            matchResult: mode === 'MATCHED' ? validMatchResult : null,
          },
        ];
        globalThis.fetch = async (): Promise<Response> =>
          new Response(JSON.stringify({ mode, results, meta }), { status: 200 });

        const outcome = await searchFlights(validQuery);

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Flight search returned an invalid response. Please try again.',
          retryable: true,
        });
      }
    }
  });

  // On 2026-09-02 the user approved replacing the legacy-response fallback test because the post-producer strict contract supersedes the legacy fallback.
  it('rejects legacy untagged responses as invalid upstream data', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(JSON.stringify({ results: [upstreamOffer], meta: { totalResults: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('parses MATCHED responses with eligible and ineligible offers and preserves scoring metadata', async (): Promise<void> => {
    const matchedOffer = {
      ...upstreamOffer,
      id: 'local-offer-matched-001',
      matchResult: {
        eligibility: {
          eligible: true,
          violations: [],
        },
        score: 88,
        matchLevel: 'STRONG',
        breakdown: [
          {
            dimension: 'PRICE',
            score: 0.9,
            weight: 1,
            contribution: 0.9,
            signal: 'POSITIVE',
            explanation: {
              key: 'match.price.below_median',
              params: { difference: '10%' },
            },
          },
        ],
        metadata: {
          scoringVersion: 'flight-match-v1',
          activeWeights: {
            PRICE: 0.35,
            AIRLINE: 0.15,
            ARRIVAL_SCHEDULE: 0.1,
            STOPS: 0.1,
            CABIN: 0.1,
            DEPARTURE_SCHEDULE: 0.1,
            BAGGAGE: 0.05,
            DURATION: 0.05,
          },
        },
      },
    };

    const ineligibleOffer = {
      ...upstreamOffer,
      id: 'local-offer-ineligible-002',
      matchResult: {
        eligibility: {
          eligible: false,
          violations: [
            {
              constraint: 'BLACKLISTED_AIRLINE',
              explanation: {
                key: 'constraint.airline.blacklisted',
                params: { airline: 'Mock Horizon Air' },
              },
            },
          ],
        },
        score: null,
        matchLevel: null,
        breakdown: [],
        metadata: {
          scoringVersion: 'flight-match-v1',
          activeWeights: {
            PRICE: 0.35,
            AIRLINE: 0.15,
            ARRIVAL_SCHEDULE: 0.1,
            STOPS: 0.1,
            CABIN: 0.1,
            DEPARTURE_SCHEDULE: 0.1,
            BAGGAGE: 0.05,
            DURATION: 0.05,
          },
        },
      },
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [matchedOffer, ineligibleOffer],
          meta: {
            ...validSearchMetaBase,
            totalResults: 2,
            scoringVersion: 'flight-match-v1',
            eligibleCount: 1,
            matchLevelCounts: {
              STRONG: 1,
              GOOD: 0,
              FAIR: 0,
              WEAK: 0,
            },
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.mode, 'MATCHED');
      assert.strictEqual(outcome.offers.length, 2);
      assert.deepEqual(outcome.offers[0].matchResult, matchedOffer.matchResult);
      assert.deepEqual(outcome.offers[1].matchResult, ineligibleOffer.matchResult);
      assert.strictEqual(outcome.meta.scoringVersion, 'flight-match-v1');
      assert.strictEqual(outcome.meta.eligibleCount, 1);
      assert.deepEqual(outcome.meta.matchLevelCounts, {
        STRONG: 1,
        GOOD: 0,
        FAIR: 0,
        WEAK: 0,
      });
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('projects a matched offer without provider IDs while retaining match data and local ID', async (): Promise<void> => {
    const matchedOffer = {
      ...upstreamOffer,
      id: 'local-matched~opaque',
      matchResult: validMatchResult,
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [matchedOffer],
          meta: { ...validMatchedMeta, totalResults: 1 },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.offers[0].id, 'local-matched~opaque');
      assert.deepEqual(outcome.offers[0].matchResult, validMatchResult);
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('rejects an eligible match result with an empty breakdown', async (): Promise<void> => {
    const emptyBreakdownMatchResult = { ...validMatchResult, breakdown: [] };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: emptyBreakdownMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects an eligible match result when breakdown weights sum outside tolerance', async (): Promise<void> => {
    const invalidWeightBreakdown = [
      {
        dimension: 'PRICE' as const,
        score: 1,
        weight: 0.95,
        contribution: 0.95,
        signal: 'POSITIVE' as const,
        explanation: {
          key: 'match.price.below_median',
          params: { percentDiff: 12 },
        },
      },
    ];
    const invalidWeightMatchResult = {
      ...validMatchResult,
      breakdown: invalidWeightBreakdown,
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: invalidWeightMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a score below zero', async (): Promise<void> => {
    const malformedMatchResult = { ...validMatchResult, score: -0.01 };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a score above one', async (): Promise<void> => {
    const malformedMatchResult = { ...validMatchResult, score: 1.01 };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a negative active dimension weight', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      metadata: {
        ...validMatchResult.metadata,
        activeWeights: { ...validMatchResult.metadata.activeWeights, PRICE: -0.01 },
      },
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with an active dimension weight above one', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      metadata: {
        ...validMatchResult.metadata,
        activeWeights: { ...validMatchResult.metadata.activeWeights, PRICE: 1.01 },
      },
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a negative dimension contribution', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      breakdown: [
        {
          dimension: 'PRICE',
          score: 0.9,
          weight: 0.35,
          contribution: -0.01,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.price.below_median',
            params: { difference: '10%' },
          },
        },
      ],
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a dimension contribution above one', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      breakdown: [
        {
          dimension: 'PRICE',
          score: 0.9,
          weight: 0.35,
          contribution: 1.01,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.price.below_median',
            params: { difference: '10%' },
          },
        },
      ],
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response when active weights round to a sum below one', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      metadata: {
        ...validMatchResult.metadata,
        activeWeights: { ...validMatchResult.metadata.activeWeights, PRICE: 0.349998 },
      },
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a dimension score below zero', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      breakdown: [
        {
          dimension: 'PRICE',
          score: -0.01,
          weight: 0.35,
          contribution: 0.315,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.price.below_median',
            params: { difference: '10%' },
          },
        },
      ],
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects a matched response with a dimension score above one', async (): Promise<void> => {
    const malformedMatchResult = {
      ...validMatchResult,
      breakdown: [
        {
          dimension: 'PRICE',
          score: 1.01,
          weight: 0.35,
          contribution: 0.315,
          signal: 'POSITIVE',
          explanation: {
            key: 'match.price.below_median',
            params: { difference: '10%' },
          },
        },
      ],
    };
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: malformedMatchResult }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('parses explicit RANKED responses with matchResult null', async (): Promise<void> => {
    const rankedOffer = {
      ...upstreamOffer,
      id: 'local-offer-ranked-001',
      matchResult: null,
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [rankedOffer],
          meta: validRankedMeta,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.mode, 'RANKED');
      assert.strictEqual(outcome.offers.length, 1);
      assert.strictEqual(outcome.offers[0].matchResult, null);
      assert.strictEqual(JSON.stringify(outcome).includes('duffelOfferId'), false);
    }
  });

  it('fails gracefully with UPSTREAM_UNAVAILABLE when matchResult is malformed', async (): Promise<void> => {
    const malformedOffer = {
      ...upstreamOffer,
      id: 'local-offer-malformed-001',
      matchResult: {
        eligibility: {
          eligible: 'not-a-boolean',
        },
      },
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [malformedOffer],
          meta: validMatchedMeta,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses when an offer omits matchResult', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({ mode: 'MATCHED', results: [upstreamOffer], meta: validMatchedMeta }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses when an offer has a null matchResult', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: null }],
          meta: validMatchedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses when scoringVersion is missing or wrong', async (): Promise<void> => {
    for (const scoringVersion of [undefined, 'flight-match-v2']) {
      const meta = { ...validMatchedMeta, scoringVersion };
      globalThis.fetch = async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            mode: 'MATCHED',
            results: [{ ...upstreamOffer, matchResult: validMatchResult }],
            meta,
          }),
          { status: 200 },
        );

      const outcome = await searchFlights(validQuery);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        message: 'Flight search returned an invalid response. Please try again.',
        retryable: true,
      });
    }
  });

  it('rejects MATCHED responses with an invalid eligibleCount', async (): Promise<void> => {
    for (const eligibleCount of [-1, 1.5]) {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            mode: 'MATCHED',
            results: [{ ...upstreamOffer, matchResult: validMatchResult }],
            meta: { ...validMatchedMeta, eligibleCount },
          }),
          { status: 200 },
        );

      const outcome = await searchFlights(validQuery);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        message: 'Flight search returned an invalid response. Please try again.',
        retryable: true,
      });
    }
  });

  it('rejects MATCHED responses when eligibleCount does not equal eligible offers', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: validMatchResult }],
          meta: { ...validMatchedMeta, eligibleCount: 0 },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses with incomplete matchLevelCounts', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: validMatchResult }],
          meta: {
            ...validMatchedMeta,
            matchLevelCounts: { STRONG: 1, GOOD: 0, FAIR: 0 },
          },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses with negative matchLevelCounts', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: validMatchResult }],
          meta: {
            ...validMatchedMeta,
            matchLevelCounts: { STRONG: -1, GOOD: 0, FAIR: 0, WEAK: 0 },
          },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects MATCHED responses when matchLevelCounts do not equal eligible offer levels', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'MATCHED',
          results: [{ ...upstreamOffer, matchResult: validMatchResult }],
          meta: {
            ...validMatchedMeta,
            matchLevelCounts: { STRONG: 0, GOOD: 1, FAIR: 0, WEAK: 0 },
          },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects RANKED responses when an offer has a non-null matchResult', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [{ ...upstreamOffer, matchResult: validMatchResult }],
          meta: validRankedMeta,
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('rejects RANKED responses when scoringVersion is non-null', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [{ ...upstreamOffer, matchResult: null }],
          meta: { ...validRankedMeta, scoringVersion: 'flight-match-v1' },
        }),
        { status: 200 },
      );

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('maps upstream responses containing empty string or zero fallbacks', async (): Promise<void> => {
    const fallbackOffer = {
      id: 'local-offer-fallback',
      duffelOfferId: 'off_fallback_123',
      airline: '',
      flightNumber: '',
      departureAirport: '',
      arrivalAirport: '',
      departureTime: '',
      arrivalTime: '',
      duration: 0,
      stops: 0,
      price: 150,
      currency: 'USD',
      fareClass: null,
      baggageAllowance: null,
      requestedCabinClass: 'economy',
      cabinClassMatch: 'full',
      cabinMismatchDetails: null,
      segments: [
        {
          carrierCode: '',
          flightNumber: '',
          operatingCarrier: '',
          departureAirport: '',
          departureTerminal: null,
          departureTime: '',
          arrivalAirport: '',
          arrivalTerminal: null,
          arrivalTime: '',
          duration: 0,
          aircraft: null,
          cabinClass: 'economy',
        },
      ],
      returnSegments: null,
    };

    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({
          mode: 'RANKED',
          results: [{ ...fallbackOffer, matchResult: null }],
          meta: validRankedMeta,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    };

    const outcome = await searchFlights(validQuery);

    assert.strictEqual(outcome.ok, true);
    if (outcome.ok) {
      assert.strictEqual(outcome.offers.length, 1);
      assert.strictEqual(outcome.offers[0].id, 'local-offer-fallback');
      assert.strictEqual(outcome.offers[0].duration, 'PT0M');
      assert.strictEqual(outcome.offers[0].slices[0].duration, 'PT0M');
      assert.strictEqual(outcome.offers[0].slices[0].segments[0].duration, 'PT0M');
    }
  });

  it('returns an unauthenticated outcome before making an upstream call', async (): Promise<void> => {
    session = null;
    let requested = false;
    globalThis.fetch = async (): Promise<Response> => {
      requested = true;
      return new Response();
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UNAUTHENTICATED',
      message: 'Please sign in to search for flights.',
      retryable: false,
    });
    assert.strictEqual(requested, false);
  });

  it('returns an unauthenticated selection outcome before making an upstream call', async (): Promise<void> => {
    session = null;
    let requested = false;
    globalThis.fetch = async (): Promise<Response> => {
      requested = true;
      return new Response();
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UNAUTHENTICATED',
      message: 'Please sign in to continue.',
      retryable: false,
    });
    assert.strictEqual(requested, false);
  });

  it('fails fast on 503 search response without repeating supplier-backed searches', async (): Promise<void> => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      return new Response('Unavailable', { status: 503 });
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search is temporarily unavailable. Please try again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 1);
  });

  it('retries a 503 read failure on offer selection before returning the validated response', async (): Promise<void> => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      if (attempts === 1) return new Response('Unavailable', { status: 503 });
      return new Response(JSON.stringify({ id: 'opaque-offer' }), { status: 200 });
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.strictEqual(outcome.ok, true);
    assert.strictEqual(attempts, 2);
  });

  it('maps expired selection responses without retrying them', async (): Promise<void> => {
    for (const status of [404, 410]) {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Unavailable', { status });
      };

      const outcome = await selectFlightOffer('opaque-offer');

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'OFFER_EXPIRED',
        message: 'This flight offer has expired. Please search again.',
        retryable: false,
      });
      assert.strictEqual(attempts, 1);
    }
  });

  it('normalizes upstream validation responses without retrying them', async (): Promise<void> => {
    for (const status of [400, 422]) {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response(JSON.stringify({ message: 'Provider implementation detail' }), {
          status,
        });
      };

      const outcome = await searchFlights(validQuery);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'INVALID_SEARCH',
        message: 'Please check your search details and try again.',
        retryable: false,
      });
      assert.strictEqual(attempts, 1);
    }
  });

  it('normalizes a timed-out search request without repeating supplier-backed searches', async (): Promise<void> => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      throw new DOMException('Aborted', 'AbortError');
    };

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search is temporarily unavailable. Please try again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 1);
  });

  it('normalizes a timed-out read request after the bounded retry budget', async (): Promise<void> => {
    let attempts = 0;
    globalThis.fetch = async (): Promise<Response> => {
      attempts += 1;
      throw new DOMException('Aborted', 'AbortError');
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'OFFER_UNAVAILABLE',
      message: 'This flight offer is unavailable. Please search again.',
      retryable: true,
    });
    assert.strictEqual(attempts, 3);
  });

  it('rejects malformed upstream results instead of forwarding them', async (): Promise<void> => {
    globalThis.fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ results: [{ id: 'local-offer-001' }] }), { status: 200 });

    const outcome = await searchFlights(validQuery);

    assert.deepEqual(outcome, {
      ok: false,
      reason: 'UPSTREAM_UNAVAILABLE',
      message: 'Flight search returned an invalid response. Please try again.',
      retryable: true,
    });
  });

  it('uses a no-store GET to verify a selected offer and preserves the Slice 5B checkout path contract', async (): Promise<void> => {
    let requestedUrl = '';
    let requestedInit: RequestInit | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({ id: 'opaque-offer' }), { status: 200 });
    };

    const outcome = await selectFlightOffer('opaque-offer');

    assert.deepEqual(outcome, { ok: true, checkoutPath: '/checkout?offerId=opaque-offer' });
    assert.match(requestedUrl, /\/api\/flights\/opaque-offer$/);
    assert.strictEqual(requestedInit?.method, 'GET');
    assert.strictEqual(requestedInit?.cache, 'no-store');
  });

  describe('Phase 4: transport result mapping, single-send, and recovery invariants', (): void => {
    describe('1. Search POST single-send', (): void => {
      it('verifies flight search POST is dispatched exactly once on 502, 503, and 504 responses', async (): Promise<void> => {
        for (const status of [502, 503, 504]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(JSON.stringify({ message: `HTTP ${status}` }), { status });
          };

          const outcome = await searchFlights(validQuery);

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'UPSTREAM_UNAVAILABLE',
            message: 'Flight search is temporarily unavailable. Please try again.',
            retryable: true,
          });
          assert.strictEqual(attempts, 1, `expected 1 attempt for status ${status}`);
        }
      });

      it('verifies flight search POST is dispatched exactly once on 429 response', async (): Promise<void> => {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response(JSON.stringify({ message: 'Rate limited' }), {
            status: 429,
            headers: { 'Retry-After': '5' },
          });
        };

        const outcome = await searchFlights(validQuery);

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'RATE_LIMITED',
          message: 'Flight search is busy. Please try again shortly.',
          retryable: true,
        });
        assert.strictEqual(attempts, 1, 'expected 1 attempt for 429 response');
      });

      it('verifies flight search POST is dispatched exactly once on network error and AbortError timeout', async (): Promise<void> => {
        let networkAttempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          networkAttempts += 1;
          throw new TypeError('Network connection refused');
        };

        const networkOutcome = await searchFlights(validQuery);

        assert.deepEqual(networkOutcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Flight search is temporarily unavailable. Please try again.',
          retryable: true,
        });
        assert.strictEqual(networkAttempts, 1, 'expected 1 attempt for network error');

        let timeoutAttempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          timeoutAttempts += 1;
          throw new DOMException('Operation timed out', 'AbortError');
        };

        const timeoutOutcome = await searchFlights(validQuery);

        assert.deepEqual(timeoutOutcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Flight search is temporarily unavailable. Please try again.',
          retryable: true,
        });
        assert.strictEqual(timeoutAttempts, 1, 'expected 1 attempt for timeout');
      });
    });

    describe('2. Offer selection GET bounded recovery', (): void => {
      it('recovers when first attempt returns 502, 503, or 504 and second attempt succeeds', async (): Promise<void> => {
        for (const status of [502, 503, 504]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            if (attempts === 1) {
              return new Response(JSON.stringify({ message: `HTTP ${status}` }), { status });
            }
            return new Response(JSON.stringify({ id: 'opaque-offer' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          };

          const outcome = await selectFlightOffer('opaque-offer');

          assert.deepEqual(outcome, {
            ok: true,
            checkoutPath: '/checkout?offerId=opaque-offer',
          });
          assert.strictEqual(attempts, 2, `expected 2 attempts for status ${status} recovery`);
        }
      });

      it('recovers when first attempt encounters network timeout and second attempt succeeds', async (): Promise<void> => {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          if (attempts === 1) {
            throw new DOMException('Request aborted due to timeout', 'AbortError');
          }
          return new Response(JSON.stringify({ id: 'opaque-offer' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };

        const outcome = await selectFlightOffer('opaque-offer');

        assert.deepEqual(outcome, {
          ok: true,
          checkoutPath: '/checkout?offerId=opaque-offer',
        });
        assert.strictEqual(attempts, 2, 'expected 2 attempts for timeout recovery');
      });
    });

    describe('3. Transport failure mapping', (): void => {
      it('maps malformed upstream JSON to UPSTREAM_UNAVAILABLE with retryable true', async (): Promise<void> => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response('<html>502 Bad Gateway</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          });
        };

        const outcome = await searchFlights(validQuery);

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Flight search returned an invalid response. Please try again.',
          retryable: true,
        });
      });

      it('maps schema validation failure on upstream results to UPSTREAM_UNAVAILABLE with retryable true', async (): Promise<void> => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              mode: 'RANKED',
              results: [{ id: 'local-offer-001' }],
              meta: validRankedMeta,
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        };

        const outcome = await searchFlights(validQuery);

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'UPSTREAM_UNAVAILABLE',
          message: 'Flight search returned an invalid response. Please try again.',
          retryable: true,
        });
      });
    });

    describe('4. Missing token short-circuit', (): void => {
      it('short-circuits searchFlights with UNAUTHENTICATED without calling fetch when session is null or lacks accessToken', async (): Promise<void> => {
        const unauthenticatedSessions: TestSession[] = [null, {}];

        for (const authSession of unauthenticatedSessions) {
          session = authSession;
          let fetchAttempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            fetchAttempts += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          };

          const outcome = await searchFlights(validQuery);

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'UNAUTHENTICATED',
            message: 'Please sign in to search for flights.',
            retryable: false,
          });
          assert.strictEqual(fetchAttempts, 0, 'fetch must not be called when unauthenticated');
        }
      });

      it('short-circuits selectFlightOffer with UNAUTHENTICATED without calling fetch when session is null or lacks accessToken', async (): Promise<void> => {
        const unauthenticatedSessions: TestSession[] = [null, {}];

        for (const authSession of unauthenticatedSessions) {
          session = authSession;
          let fetchAttempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            fetchAttempts += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          };

          const outcome = await selectFlightOffer('opaque-offer');

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'UNAUTHENTICATED',
            message: 'Please sign in to continue.',
            retryable: false,
          });
          assert.strictEqual(fetchAttempts, 0, 'fetch must not be called when unauthenticated');
        }
      });
    });

    describe('5. HTTP status mapping parity', (): void => {
      it('maps 401 and 403 to UNAUTHENTICATED with single send on search and offer selection', async (): Promise<void> => {
        for (const status of [401, 403]) {
          let searchAttempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            searchAttempts += 1;
            return new Response(JSON.stringify({ message: 'Unauthorized' }), { status });
          };

          const searchOutcome = await searchFlights(validQuery);

          assert.deepEqual(searchOutcome, {
            ok: false,
            reason: 'UNAUTHENTICATED',
            message: 'Please sign in to search for flights.',
            retryable: false,
          });
          assert.strictEqual(searchAttempts, 1, `search must dispatch exactly once on ${status}`);

          let selectionAttempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            selectionAttempts += 1;
            return new Response(JSON.stringify({ message: 'Unauthorized' }), { status });
          };

          const selectionOutcome = await selectFlightOffer('opaque-offer');

          assert.deepEqual(selectionOutcome, {
            ok: false,
            reason: 'UNAUTHENTICATED',
            message: 'Please sign in to continue.',
            retryable: false,
          });
          assert.strictEqual(selectionAttempts, 1, `selection must dispatch exactly once on ${status}`);
        }
      });

      it('maps 429 to RATE_LIMITED with single send on search', async (): Promise<void> => {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response(JSON.stringify({ message: 'Too Many Requests' }), { status: 429 });
        };

        const outcome = await searchFlights(validQuery);

        assert.deepEqual(outcome, {
          ok: false,
          reason: 'RATE_LIMITED',
          message: 'Flight search is busy. Please try again shortly.',
          retryable: true,
        });
        assert.strictEqual(attempts, 1, 'search must dispatch exactly once on 429');
      });

      it('maps 400 and 422 to INVALID_SEARCH with single send on search', async (): Promise<void> => {
        for (const status of [400, 422]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(JSON.stringify({ message: 'Validation Error' }), { status });
          };

          const outcome = await searchFlights(validQuery);

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'INVALID_SEARCH',
            message: 'Please check your search details and try again.',
            retryable: false,
          });
          assert.strictEqual(attempts, 1, `search must dispatch exactly once on ${status}`);
        }
      });

      it('maps 404 and 410 to OFFER_EXPIRED with single send on offer selection', async (): Promise<void> => {
        for (const status of [404, 410]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(JSON.stringify({ message: 'Offer Expired' }), { status });
          };

          const outcome = await selectFlightOffer('opaque-offer');

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'OFFER_EXPIRED',
            message: 'This flight offer has expired. Please search again.',
            retryable: false,
          });
          assert.strictEqual(attempts, 1, `selection must dispatch exactly once on ${status}`);
        }
      });
    });
  });

  describe('Feature 029 browser identity boundary baseline', (): void => {
    it('rejects a future supplier identity field without serializing provider identifiers', async (): Promise<void> => {
      const responseOffer = {
        ...upstreamOffer,
        supplierOfferId: 'supplier_offer_secret',
      };
      globalThis.fetch = async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            mode: 'RANKED',
            results: [{ ...responseOffer, matchResult: null }],
            meta: validRankedMeta,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );

      const outcome = await searchFlights(validQuery);

      assert.equal(outcome.ok, false);
      if (!outcome.ok) {
        assert.equal(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
      const serialized = JSON.stringify(outcome);
      assert.equal(serialized.includes('duffelOfferId'), false);
      assert.equal(serialized.includes('supplierOfferId'), false);
      assert.equal(serialized.includes('off_provider_secret'), false);
      assert.equal(serialized.includes('supplier_offer_secret'), false);
    });
  });
});
