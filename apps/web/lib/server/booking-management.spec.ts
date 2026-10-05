import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testRequire = createRequire(import.meta.url);
type TestSession = { accessToken?: string } | null;

let session: TestSession = null;
const getServerSession = mock.fn(async () => session);
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

after(() => {
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

let listBookings: typeof import('./booking-management').listBookings;
let getBookingDetail: typeof import('./booking-management').getBookingDetail;
let getCancellationStatus: typeof import('./booking-management').getCancellationStatus;
let getCancellationQuote: typeof import('./booking-management').getCancellationQuote;
let cancelBooking: typeof import('./booking-management').cancelBooking;
let acknowledgeDisruption: typeof import('./booking-management').acknowledgeDisruption;
let acceptDisruption: typeof import('./booking-management').acceptDisruption;
let getItineraryRevisions: typeof import('./booking-management').getItineraryRevisions;

before(async () => {
  ({
    listBookings,
    getBookingDetail,
    getCancellationStatus,
    getCancellationQuote,
    cancelBooking,
    acknowledgeDisruption,
    acceptDisruption,
    getItineraryRevisions,
  } = await import('./booking-management.ts'));
});

const timestamp = '2027-11-15T08:00:00.000Z';
const arrivalTimestamp = '2027-11-15T16:30:00.000Z';

const mockUpstreamSegment = {
  airlineName: 'Mock Horizon Air',
  marketingCarrierIata: 'HZ',
  carrierCode: 'HZ',
  operatingCarrier: 'Mock Horizon Air',
  flightNumber: 'HZ789',
  departureAirportIata: 'SFO',
  departureAirportName: 'San Francisco International',
  departureCity: 'San Francisco',
  departureTerminal: '2',
  arrivalAirportIata: 'JFK',
  arrivalAirportName: 'John F Kennedy International',
  arrivalCity: 'New York',
  arrivalTerminal: '4',
  departureAt: timestamp,
  arrivalAt: arrivalTimestamp,
  durationMinutes: 510,
  duration: 'PT8H30M',
  aircraftType: 'B738',
  duffelSegmentId: 'seg_secret_provider_id',
  sliceOrder: 0,
  segmentOrder: 0,
  globalOrder: 0,
};

const mockUpstreamBookingListItem = {
  id: 'booking-uuid-001',
  status: 'CONFIRMED',
  failureReason: null,
  pnrReference: 'PNR123',
  totalAmount: '499.00',
  currency: 'USD',
  departureAt: timestamp,
  flightSnapshot: {
    segments: [mockUpstreamSegment],
    totalDuration: 'PT8H30M',
    stops: 0,
    cabinClass: 'economy',
    baggageAllowance: '1 piece',
    fareClass: 'Y',
  },
  currentItinerary: {
    source: 'ORIGINAL',
    revisionId: null,
    version: 1,
    segments: [mockUpstreamSegment],
    nextUnflownDepartureAt: timestamp,
    finalArrivalAt: arrivalTimestamp,
  },
  disruption: {
    status: 'NONE',
    activeRevisionId: null,
    isMaterial: false,
    materialReasons: [],
    stabilizationWarning: false,
    resolvedReason: null,
    resolvedAt: null,
  },
  createdAt: '2027-11-01T10:00:00.000Z',
};

const mockUpstreamBookingDetail = {
  ...mockUpstreamBookingListItem,
  duffelOrderId: 'ord_secret_provider_123',
  passengerSnapshot: [
    {
      type: 'ADULT',
      title: 'Ms',
      givenName: 'Ada',
      familyName: 'Lovelace',
      passportNumber: 'ENC:masked_1234',
    },
  ],
  payment: {
    id: 'pay-uuid-001',
    status: 'SUCCEEDED',
    stripePaymentIntentId: 'pi_secret_stripe_456',
  },
  bookingIntent: {
    id: 'intent-uuid-001',
    offerId: 'off_secret_duffel_789',
    passengers: [
      {
        id: 'pax-uuid-001',
        type: 'ADULT',
        title: 'Ms',
        givenName: 'Ada',
        familyName: 'Lovelace',
      },
    ],
  },
  cancellationDeadline: '2027-11-14T08:00:00.000Z',
  cancellationRefundable: true,
  airlineRefundAmount: '450.00',
  customerRefundAmount: '450.00',
  duffelCancellationQuoteId: 'cquo_secret_provider_999',
  createdAt: '2027-11-01T10:00:00.000Z',
  updatedAt: '2027-11-02T10:00:00.000Z',
  ancillarySummary: {
    seats: [
      {
        intentPassengerId: 'pax-uuid-001',
        passengerName: 'Ada Lovelace',
        segmentId: 'seg_secret_provider_id',
        seatDesignator: '12A',
        amount: '25.00',
        currency: 'USD',
      },
    ],
    baggage: [
      {
        intentPassengerId: 'pax-uuid-001',
        passengerName: 'Ada Lovelace',
        type: 'CHECKED',
        quantity: 1,
        amount: '35.00',
        currency: 'USD',
      },
    ],
  },
};

describe('booking-management server domain module', () => {
  const originalEnvironment = process.env;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env = { ...originalEnvironment, API_URL: 'http://private-api.example/' };
    session = { accessToken: 'session-token-abc' };
    getServerSession.mock.resetCalls();
  });

  afterEach(() => {
    process.env = originalEnvironment;
    globalThis.fetch = originalFetch;
    session = null;
  });

  describe('listBookings', () => {
    it('maps an authenticated upstream booking list to a shared view stripping provider IDs', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookings: [mockUpstreamBookingListItem],
            pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.tab, 'upcoming');
        assert.strictEqual(outcome.data.bookings.length, 1);
        assert.strictEqual(outcome.data.bookings[0].id, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookings[0].status, 'CONFIRMED');
        assert.strictEqual(outcome.data.bookings[0].pnrReference, 'PNR123');
        assert.strictEqual(outcome.data.bookings[0].totalAmount, '499.00');
        assert.strictEqual(outcome.data.bookings[0].currency, 'USD');
        assert.deepEqual(outcome.data.bookings[0].airline, {
          name: 'Mock Horizon Air',
          iataCode: 'HZ',
        });
        assert.deepEqual(outcome.data.bookings[0].origin, {
          iataCode: 'SFO',
          city: 'San Francisco',
        });
        assert.deepEqual(outcome.data.bookings[0].destination, {
          iataCode: 'JFK',
          city: 'New York',
        });
        assert.strictEqual(outcome.data.bookings[0].departureAt, timestamp);
        assert.strictEqual(outcome.data.bookings[0].arrivalAt, arrivalTimestamp);
      }
      assert.match(
        requestedUrl,
        /^http:\/\/private-api\.example\/api\/bookings\?tab=upcoming&page=1&limit=10$/,
      );
      assert.strictEqual(requestedInit?.method, 'GET');
      assert.strictEqual(
        (requestedInit?.headers as HeadersInit & { Authorization?: string }).Authorization,
        'Bearer session-token-abc',
      );

      // Verify no provider secrets leaked
      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('duffelSegmentId'), false);
      assert.strictEqual(serialized.includes('seg_secret'), false);
    });

    it('returns an unauthenticated outcome if session is missing without calling upstream', async () => {
      session = null;
      let requested = false;
      globalThis.fetch = async (): Promise<Response> => {
        requested = true;
        return new Response();
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Please sign in to view bookings.',
        retryable: false,
      });
      assert.strictEqual(requested, false);
    });

    it('preserves the established message for an upstream HTTP 401', async () => {
      globalThis.fetch = async (): Promise<Response> => new Response('{}', { status: 401 });

      assert.deepEqual(await listBookings('upcoming', 1, 10), {
        ok: false,
        reason: 'UNAUTHENTICATED',
        message: 'Please sign in to continue.',
        retryable: false,
      });
    });

    it('treats non-array bookings as an empty list, preserving the previous fallback', async () => {
      for (const bookings of [null, 'invalid']) {
        globalThis.fetch = async (): Promise<Response> =>
          new Response(JSON.stringify({ bookings }), { status: 200 });

        const outcome = await listBookings('upcoming', 1, 10);
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.deepEqual(outcome.data.bookings, []);
          assert.deepEqual(outcome.data.pagination, {
            page: 1,
            limit: 10,
            total: 0,
            totalPages: 0,
          });
        }
      }
    });

    it('falls back from malformed pagination fields as the previous mapper did', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ bookings: [], pagination: { page: 'wrong', limit: null, total: 3 } }), {
          status: 200,
        });

      const outcome = await listBookings('upcoming', 1, 10);
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.deepEqual(outcome.data.pagination, { page: 1, limit: 10, total: 3, totalPages: 0 });
      }
    });

    it('returns INVALID_COMMAND if tab is invalid', async () => {
      let requested = false;
      globalThis.fetch = async (): Promise<Response> => {
        requested = true;
        return new Response();
      };

      // @ts-expect-error test invalid runtime input
      const outcome = await listBookings('invalid_tab', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
      assert.strictEqual(requested, false);
    });

    it('retries bounded on 503 upstream failures for GET', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Service Unavailable', { status: 503 });
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        assert.strictEqual(outcome.retryable, true);
      }
      assert.strictEqual(attempts, 3);
    });

    it('handles 401 and 403 upstream errors properly', async () => {
      for (const [status, expectedReason] of [
        [401, 'UNAUTHENTICATED'],
        [403, 'FORBIDDEN'],
      ] as const) {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({ message: 'Forbidden' }), { status });
        };

        const outcome = await listBookings('upcoming', 1, 10);

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, expectedReason);
          assert.strictEqual(outcome.retryable, false);
        }
      }
    });

    it('rejects malformed upstream payload', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ bookings: [{ id: '' }] }), { status: 200 });
      };

      const outcome = await listBookings('upcoming', 1, 10);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
    });
  });

  describe('getBookingDetail', () => {
    it('maps an authenticated upstream detail response stripping internal Stripe and Duffel IDs', async () => {
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(JSON.stringify(mockUpstreamBookingDetail), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.id, 'booking-uuid-001');
        assert.strictEqual(outcome.data.status, 'CONFIRMED');
        assert.strictEqual(outcome.data.paymentStatus, 'SUCCEEDED');
        assert.strictEqual(outcome.data.offerId, 'off_secret_duffel_789');
        assert.strictEqual(outcome.data.pnrReference, 'PNR123');
        assert.strictEqual(outcome.data.totalAmount, '499.00');
        assert.strictEqual(outcome.data.currency, 'USD');
        assert.strictEqual(outcome.data.passengers.length, 1);
        assert.strictEqual(outcome.data.passengers[0].firstName, 'Ada');
        assert.strictEqual(outcome.data.passengers[0].lastName, 'Lovelace');
        assert.strictEqual(outcome.data.passengers[0].title, 'Ms');
        assert.strictEqual(outcome.data.ancillarySummary?.seats.length, 1);
        assert.strictEqual(outcome.data.ancillarySummary?.seats[0].seatDesignator, '12A');
        assert.strictEqual(outcome.data.ancillarySummary?.baggage.length, 1);
        assert.strictEqual(outcome.data.cancellation?.airlineRefundAmount, '450.00');
      }
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001$/);

      // Verify no provider secrets leaked
      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('ord_secret'), false);
      assert.strictEqual(serialized.includes('duffelOrderId'), false);
      assert.strictEqual(serialized.includes('pi_secret'), false);
      assert.strictEqual(serialized.includes('cquo_secret'), false);
      assert.strictEqual(serialized.includes('passportNumber'), false);
      assert.strictEqual(serialized.includes('stripePaymentIntentId'), false);
    });

    it('preserves disruption activeRevisionId and diff summaries for browser review', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            ...mockUpstreamBookingDetail,
            disruption: {
              status: 'DETECTED',
              activeRevisionId: 'rev-uuid-789',
              isMaterial: true,
              materialReasons: ['DEPARTURE_MOVED_LATER'],
              incrementalSummary: { isRoutingChanged: false, sliceSummaries: [] },
              cumulativeSummary: { isRoutingChanged: false, sliceSummaries: [] },
              stabilizationWarning: true,
              resolvedReason: null,
              resolvedAt: null,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.disruption?.status, 'DETECTED');
        assert.strictEqual(outcome.data.disruption?.activeRevisionId, 'rev-uuid-789');
        assert.strictEqual(outcome.data.disruption?.isMaterial, true);
        assert.strictEqual(outcome.data.disruption?.stabilizationWarning, true);
        assert.deepEqual(outcome.data.disruption?.incrementalSummary, {
          isRoutingChanged: false,
          sliceSummaries: [],
        });
        assert.deepEqual(outcome.data.disruption?.cumulativeSummary, {
          isRoutingChanged: false,
          sliceSummaries: [],
        });
      }
    });

    it('normalizes empty offerId, paymentStatus, and pnrReference to null instead of rejecting schema', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(
          JSON.stringify({
            ...mockUpstreamBookingDetail,
            bookingIntent: {
              id: 'intent-uuid-001',
              offerId: '', // Empty string from API when booking intent has no duffelOfferId
            },
            payment: {
              id: 'pay-uuid-001',
              status: '',
            },
            pnrReference: '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.offerId, null);
        assert.strictEqual(outcome.data.paymentStatus, null);
        assert.strictEqual(outcome.data.pnrReference, null);
      }
    });

    it('returns NOT_FOUND on 404 upstream', async () => {
      globalThis.fetch = async (): Promise<Response> => {
        return new Response(JSON.stringify({ message: 'Booking not found' }), { status: 404 });
      };

      const outcome = await getBookingDetail('nonexistent-uuid');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'NOT_FOUND');
        assert.strictEqual(outcome.retryable, false);
      }
    });

    it('returns INVALID_COMMAND if bookingId is empty', async () => {
      const outcome = await getBookingDetail('');
      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
    });

    it('retries on network timeout/abort error', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        throw new DOMException('Aborted', 'AbortError');
      };

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        assert.strictEqual(outcome.retryable, true);
      }
      assert.strictEqual(attempts, 3);
    });
  });

  describe('getCancellationStatus', () => {
    it('maps cancellation status stripping duffel quote and retry count internals', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            bookingStatus: 'CANCELLATION_PENDING',
            cancellationDeadline: '2027-11-14T08:00:00.000Z',
            airlineRefundAmount: '450.00',
            customerRefundAmount: '450.00',
            duffelCancellationQuoteId: 'cquo_provider_secret',
            refundStatus: 'PENDING',
            retryCount: 2,
            nextRetryAt: '2027-11-14T10:00:00.000Z',
            lastErrorCode: 'SUPPLIER_RATE_LIMITED',
            escalationMessage: null,
          }),
          { status: 200 },
        );
      };

      const outcome = await getCancellationStatus('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookingStatus, 'CANCELLATION_PENDING');
        assert.strictEqual(outcome.data.refundStatus, 'PENDING');
        assert.strictEqual(outcome.data.airlineRefundAmount, '450.00');
      }

      assert.strictEqual(
        new URL(requestedUrl).pathname,
        '/api/bookings/booking-uuid-001/cancellation',
      );
      assert.strictEqual(requestedInit?.method, 'GET');
      const headers = (requestedInit?.headers ?? {}) as Record<string, string>;
      assert.strictEqual(headers.Authorization, 'Bearer session-token-abc');

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('cquo_provider_secret'), false);
      assert.strictEqual(serialized.includes('SUPPLIER_RATE_LIMITED'), false);
      assert.strictEqual(serialized.includes('retryCount'), false);
    });

    it('handles upstream error status mapping (401, 403, 404, 500)', async () => {
      const errorCases = [
        { status: 401, expectedReason: 'UNAUTHENTICATED', retryable: false },
        { status: 403, expectedReason: 'FORBIDDEN', retryable: false },
        { status: 404, expectedReason: 'NOT_FOUND', retryable: false },
        { status: 500, expectedReason: 'UPSTREAM_UNAVAILABLE', retryable: true },
      ] as const;

      for (const { status, expectedReason, retryable } of errorCases) {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({ message: `Error ${status}` }), { status });
        };

        const outcome = await getCancellationStatus('booking-uuid-001');

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, expectedReason);
          assert.strictEqual(outcome.retryable, retryable);
        }
      }
    });
  });

  describe('getCancellationQuote', () => {
    it('requests cancellation quote and strips provider duffelOrderId with fast-fail mutation', async () => {
      let attempts = 0;
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            quoteId: 'quote-local-123',
            duffelOrderId: 'ord_secret_123',
            refundAmount: '450.00',
            currency: 'USD',
            expiresAt: '2027-11-14T12:00:00.000Z',
            refundable: true,
            refundTo: 'original_payment_card',
            nonRefundableAncillaryAmount: '49.00',
            nonRefundableAncillaryCurrency: 'USD',
          }),
          { status: 200 },
        );
      };

      const outcome = await getCancellationQuote('booking-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.quoteId, 'quote-local-123');
        assert.strictEqual(outcome.data.refundAmount, '450.00');
        assert.strictEqual(outcome.data.currency, 'USD');
        assert.strictEqual(outcome.data.refundable, true);
      }
      assert.strictEqual(attempts, 1);
      assert.strictEqual(
        new URL(requestedUrl).pathname,
        '/api/bookings/booking-uuid-001/cancellation/quote',
      );
      assert.strictEqual(requestedInit?.method, 'POST');
      const headers = (requestedInit?.headers ?? {}) as Record<string, string>;
      assert.strictEqual(headers.Authorization, 'Bearer session-token-abc');
      assert.strictEqual(headers['Content-Type'], 'application/json');

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('ord_secret_123'), false);
      assert.strictEqual(serialized.includes('duffelOrderId'), false);
    });

    it('fails fast on 500 and 503 errors for quote creation', async () => {
      for (const status of [500, 503]) {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response('Upstream unavailable', { status });
        };

        const outcome = await getCancellationQuote('booking-uuid-001');

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        }
        assert.strictEqual(attempts, 1);
      }
    });

    it('handles upstream error status mapping for quote request', async () => {
      const errorCases = [
        { status: 401, expectedReason: 'UNAUTHENTICATED', retryable: false },
        { status: 403, expectedReason: 'FORBIDDEN', retryable: false },
        { status: 404, expectedReason: 'NOT_FOUND', retryable: false },
        { status: 400, expectedReason: 'INVALID_COMMAND', retryable: false },
      ] as const;

      for (const { status, expectedReason, retryable } of errorCases) {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response(JSON.stringify({ message: `Error ${status}` }), { status });
        };

        const outcome = await getCancellationQuote('booking-uuid-001');

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, expectedReason);
          assert.strictEqual(outcome.retryable, retryable);
        }
        assert.strictEqual(attempts, 1);
      }
    });

    it('forwards 400/422 messages and falls back when the error body is unparseable', async () => {
      for (const status of [400, 422]) {
        for (const [body, expectedMessage] of [
          [JSON.stringify({ message: `Quote rejected ${status}` }), `Quote rejected ${status}`],
          ['not JSON', 'Invalid request. Please check your details and try again.'],
        ]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(body, { status });
          };

          const outcome = await getCancellationQuote('booking-uuid-001');

          assert.deepEqual(outcome, {
            ok: false,
            reason: 'INVALID_COMMAND',
            message: expectedMessage,
            retryable: false,
          });
          assert.strictEqual(attempts, 1);
        }
      }
    });
  });

  describe('cancelBooking', () => {
    it('executes cancellation mutation fast-fail and maps result', async () => {
      let attempts = 0;
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            bookingStatus: 'CANCELLED_PENDING_REFUND',
            cancellationStatus: 'CONFIRMED',
            refundStatus: 'PENDING',
            refundAmount: '450.00',
            duffelCancellationQuoteId: 'cquo_secret_123',
          }),
          { status: 200 },
        );
      };

      const outcome = await cancelBooking('booking-uuid-001', 'quote-local-123');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, 'booking-uuid-001');
        assert.strictEqual(outcome.data.bookingStatus, 'CANCELLED_PENDING_REFUND');
        assert.strictEqual(outcome.data.refundAmount, '450.00');
      }
      assert.strictEqual(attempts, 1);
      assert.strictEqual(
        new URL(requestedUrl).pathname,
        '/api/bookings/booking-uuid-001/cancellation',
      );
      assert.strictEqual(requestedInit?.method, 'POST');
      const headers = (requestedInit?.headers ?? {}) as Record<string, string>;
      assert.strictEqual(headers.Authorization, 'Bearer session-token-abc');
      assert.strictEqual(headers['Content-Type'], 'application/json');
      assert.strictEqual(requestedInit?.body, JSON.stringify({ quoteId: 'quote-local-123' }));

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('cquo_secret_123'), false);
    });

    it('fails fast on 500 and 503 errors for booking cancellation', async () => {
      for (const status of [500, 503]) {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response('Upstream unavailable', { status });
        };

        const outcome = await cancelBooking('booking-uuid-001', 'quote-local-123');

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
        }
        assert.strictEqual(attempts, 1);
      }
    });

    it('handles upstream error status mapping for cancelBooking (409, 400, 401, 403, 404)', async () => {
      const errorCases = [
        { status: 409, expectedReason: 'STALE_REVISION', retryable: false },
        { status: 400, expectedReason: 'INVALID_COMMAND', retryable: false },
        { status: 401, expectedReason: 'UNAUTHENTICATED', retryable: false },
        { status: 403, expectedReason: 'FORBIDDEN', retryable: false },
        { status: 404, expectedReason: 'NOT_FOUND', retryable: false },
      ] as const;

      for (const { status, expectedReason, retryable } of errorCases) {
        let attempts = 0;
        globalThis.fetch = async (): Promise<Response> => {
          attempts += 1;
          return new Response(JSON.stringify({ message: `Error ${status}` }), { status });
        };

        const outcome = await cancelBooking('booking-uuid-001', 'quote-local-123');

        assert.strictEqual(outcome.ok, false);
        if (!outcome.ok) {
          assert.strictEqual(outcome.reason, expectedReason);
          assert.strictEqual(outcome.retryable, retryable);
        }
        assert.strictEqual(attempts, 1);
      }
    });

    it('returns INVALID_COMMAND if quoteId is missing', async () => {
      const outcome = await cancelBooking('booking-uuid-001', '');
      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'INVALID_COMMAND');
      }
    });
  });

  describe('acknowledgeDisruption', () => {
    it('sends acknowledge disruption mutation and returns ok: true', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      let attempts = 0;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            activeRevisionId: 'rev-uuid-001',
            disruptionStatus: 'ACKNOWLEDGED',
          }),
          { status: 200 },
        );
      };

      const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.ok, true);
      }
      assert.strictEqual(attempts, 1);
      assert.match(
        requestedUrl,
        /\/api\/bookings\/booking-uuid-001\/disruptions\/rev-uuid-001\/acknowledge$/,
      );
      // User approved this correction on 2026-09-26: pre-unification acknowledge requests had no body.
      assert.strictEqual(requestedInit?.body, undefined);
    });

    it('maps 409 conflict upstream to STALE_REVISION reason', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            code: 'STALE_DISRUPTION_REVISION',
            message: 'A newer change exists and must be reviewed.',
          }),
          { status: 409 },
        );
      };

      const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'STALE_REVISION');
        assert.strictEqual(outcome.retryable, false);
      }
      assert.strictEqual(attempts, 1);
    });

    it('fails fast on 503 for acknowledge disruption', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Unavailable', { status: 503 });
      };

      const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        message: 'Booking service is temporarily unavailable. Please try again.',
        retryable: true,
      });
      assert.strictEqual(attempts, 1);
    });
  });

  describe('acceptDisruption', () => {
    it('sends accept disruption mutation and returns ok: true', async () => {
      let requestedUrl = '';
      let requestedInit: RequestInit | undefined;
      let attempts = 0;
      globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        attempts += 1;
        requestedUrl = String(input);
        requestedInit = init;
        return new Response(
          JSON.stringify({
            bookingId: 'booking-uuid-001',
            activeRevisionId: 'rev-uuid-001',
            disruptionStatus: 'RESOLVED',
          }),
          { status: 200 },
        );
      };

      const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.ok, true);
      }
      assert.strictEqual(attempts, 1);
      assert.match(
        requestedUrl,
        /\/api\/bookings\/booking-uuid-001\/disruptions\/rev-uuid-001\/accept$/,
      );
      // User approved this correction on 2026-09-26: pre-unification accept requests had no body.
      assert.strictEqual(requestedInit?.body, undefined);
    });

    it('maps 409 conflict upstream to STALE_REVISION reason on accept', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response(
          JSON.stringify({
            code: 'STALE_DISRUPTION_REVISION',
            message: 'A newer change exists and must be reviewed.',
          }),
          { status: 409 },
        );
      };

      const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'STALE_REVISION');
        assert.strictEqual(outcome.retryable, false);
      }
      assert.strictEqual(attempts, 1);
    });

    it('fails fast on 503 for accept disruption', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Unavailable', { status: 503 });
      };

      const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');

      assert.deepEqual(outcome, {
        ok: false,
        reason: 'UPSTREAM_UNAVAILABLE',
        message: 'Booking service is temporarily unavailable. Please try again.',
        retryable: true,
      });
      assert.strictEqual(attempts, 1);
    });
  });

  describe('getItineraryRevisions', () => {
    it('maps paginated revisions stripping baseline and diff internals', async () => {
      let requestedUrl = '';
      globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
        requestedUrl = String(input);
        return new Response(
          JSON.stringify({
            items: [
              {
                revisionId: 'rev-uuid-001',
                version: 2,
                observedAt: timestamp,
                isMaterial: true,
                materialReasons: ['SCHEDULE_CHANGE'],
                materialBaselines: [{ baseline: 'internal' }],
                incrementalSummary: { diff: 'internal' },
                cumulativeSummary: { diff: 'internal' },
                segments: [mockUpstreamSegment],
              },
            ],
            page: 1,
            limit: 5,
            total: 1,
            totalPages: 1,
          }),
          { status: 200 },
        );
      };

      const outcome = await getItineraryRevisions('booking-uuid-001', 1, 5);

      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.revisions.length, 1);
        assert.strictEqual(outcome.data.revisions[0].revisionId, 'rev-uuid-001');
        assert.strictEqual(outcome.data.revisions[0].version, 2);
        assert.strictEqual(outcome.data.revisions[0].isMaterial, true);
        assert.deepEqual(outcome.data.revisions[0].materialReasons, ['SCHEDULE_CHANGE']);
        assert.strictEqual(outcome.data.revisions[0].segments.length, 1);
        assert.strictEqual(outcome.data.total, 1);
        assert.strictEqual(outcome.data.totalPages, 1);
      }
      assert.match(requestedUrl, /\/api\/bookings\/booking-uuid-001\/disruptions\?page=1&limit=5$/);

      const serialized = JSON.stringify(outcome);
      assert.strictEqual(serialized.includes('materialBaselines'), false);
      assert.strictEqual(serialized.includes('incrementalSummary'), false);
      assert.strictEqual(serialized.includes('cumulativeSummary'), false);
    });

    it('retries bounded on 503 for getItineraryRevisions (idempotent read)', async () => {
      let attempts = 0;
      globalThis.fetch = async (): Promise<Response> => {
        attempts += 1;
        return new Response('Unavailable', { status: 503 });
      };

      const outcome = await getItineraryRevisions('booking-uuid-001', 1, 5);

      assert.strictEqual(outcome.ok, false);
      if (!outcome.ok) {
        assert.strictEqual(outcome.reason, 'UPSTREAM_UNAVAILABLE');
      }
      assert.strictEqual(attempts, 3);
    });
  });

  describe('Phase 5: backendClient transport mapping and single-send invariants', () => {
    it('preserves detail field defaults accepted by the previous mapper', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ ...mockUpstreamBookingListItem, totalAmount: {}, paymentStatus: false }));

      const outcome = await getBookingDetail('booking-uuid-001');
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.totalAmount, '0.00');
        assert.strictEqual(outcome.data.paymentStatus, undefined);
      }
    });

    it('preserves cancellation status coercions accepted by the previous mapper', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ bookingId: 123, bookingStatus: 456, airlineRefundAmount: 450, refundStatus: 7 }));

      const outcome = await getCancellationStatus('booking-uuid-001');
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, '123');
        assert.strictEqual(outcome.data.bookingStatus, '456');
        assert.strictEqual(outcome.data.airlineRefundAmount, '450');
        assert.strictEqual(outcome.data.refundStatus, '7');
      }
    });

    it('preserves cancellation quote coercions accepted by the previous mapper', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ bookingId: 123, quoteId: 456, refundAmount: {}, currency: 'USD', expiresAt: timestamp, refundable: 1 }));

      const outcome = await getCancellationQuote('booking-uuid-001');
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, '123');
        assert.strictEqual(outcome.data.quoteId, '456');
        assert.strictEqual(outcome.data.refundAmount, '0.00');
        assert.strictEqual(outcome.data.refundable, true);
      }
    });

    it('preserves cancellation result coercions accepted by the previous mapper', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ bookingId: 123, bookingStatus: 456, cancellationStatus: 7, refundStatus: 8, refundAmount: {} }));

      const outcome = await cancelBooking('booking-uuid-001', 'quote-local-123');
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.strictEqual(outcome.data.bookingId, '123');
        assert.strictEqual(outcome.data.bookingStatus, '456');
        assert.strictEqual(outcome.data.cancellationStatus, '7');
        assert.strictEqual(outcome.data.refundStatus, '8');
        assert.strictEqual(outcome.data.refundAmount, '0.00');
      }
    });

    it('falls back from non-array revisions and malformed pagination as the previous mapper did', async () => {
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify({ items: null, revisions: [], page: 'wrong', limit: null, total: 2 }));

      const outcome = await getItineraryRevisions('booking-uuid-001', 1, 5);
      assert.strictEqual(outcome.ok, true);
      if (outcome.ok) {
        assert.deepEqual(outcome.data.revisions, []);
        assert.strictEqual(outcome.data.page, 1);
        assert.strictEqual(outcome.data.limit, 5);
        assert.strictEqual(outcome.data.total, 2);
        assert.strictEqual(outcome.data.totalPages, 1);
      }
    });

    describe('1. Six JSON operation raw response schemas & optional field tolerance', () => {
      it('tolerates omitted bookings, omitted pagination, and sparse booking items while stripping provider IDs in listBookings', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              bookings: [
                {
                  id: 'booking-sparse-001',
                  status: 'CONFIRMED',
                  totalAmount: '150.00',
                  currency: 'USD',
                  duffelOrderId: 'ord_secret_list',
                  flightSnapshot: {
                    segments: [mockUpstreamSegment],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await listBookings('upcoming', 1, 10);
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.bookings.length, 1);
          assert.strictEqual(outcome.data.bookings[0].id, 'booking-sparse-001');
          assert.strictEqual(outcome.data.bookings[0].totalAmount, '150.00');
          assert.strictEqual(outcome.data.bookings[0].airline?.iataCode, 'HZ');
          assert.strictEqual(outcome.data.pagination.page, 1);
          assert.strictEqual(outcome.data.pagination.limit, 10);
          assert.strictEqual(outcome.data.pagination.total, 1);
          assert.strictEqual(outcome.data.pagination.totalPages, 1);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('ord_secret_list'), false);
        assert.strictEqual(serialized.includes('duffelOrderId'), false);
        assert.strictEqual(serialized.includes('duffelSegmentId'), false);

        globalThis.fetch = async (): Promise<Response> => {
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };
        const emptyOutcome = await listBookings('upcoming', 1, 10);
        assert.strictEqual(emptyOutcome.ok, true);
        if (emptyOutcome.ok) {
          assert.deepEqual(emptyOutcome.data.bookings, []);
          assert.strictEqual(emptyOutcome.data.pagination.total, 0);
        }
      });

      it('tolerates omitted optional fields and maps sparse upstream detail while stripping provider and payment IDs in getBookingDetail', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              id: 'booking-uuid-002',
              status: 'CONFIRMED',
              totalAmount: '250.00',
              currency: 'USD',
              createdAt: timestamp,
              updatedAt: timestamp,
              flightSnapshot: {
                segments: [mockUpstreamSegment],
              },
              passengerSnapshot: [
                {
                  type: 'ADULT',
                  givenName: 'Grace',
                  familyName: 'Hopper',
                  duffelPassengerId: 'pax_secret_id',
                  passportNumber: 'ENC:masked_5678',
                },
              ],
              duffelOrderId: 'ord_secret_999',
              payment: {
                id: 'pay-002',
                status: 'SUCCEEDED',
                stripePaymentIntentId: 'pi_secret_999',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await getBookingDetail('booking-uuid-002');
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.id, 'booking-uuid-002');
          assert.strictEqual(outcome.data.passengers.length, 1);
          assert.strictEqual(outcome.data.passengers[0].firstName, 'Grace');
          assert.strictEqual(outcome.data.passengers[0].lastName, 'Hopper');
          assert.strictEqual(outcome.data.itinerary.segments.length, 1);
          assert.strictEqual(outcome.data.cancellation, undefined);
          assert.strictEqual(outcome.data.ancillarySummary, undefined);
          assert.strictEqual(outcome.data.disruption, undefined);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('ord_secret_999'), false);
        assert.strictEqual(serialized.includes('duffelOrderId'), false);
        assert.strictEqual(serialized.includes('pi_secret_999'), false);
        assert.strictEqual(serialized.includes('stripePaymentIntentId'), false);
        assert.strictEqual(serialized.includes('pax_secret_id'), false);
        assert.strictEqual(serialized.includes('passportNumber'), false);
      });

      it('tolerates nullable optional fields and maps sparse cancellation status while stripping internal retry and quote IDs in getCancellationStatus', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              bookingId: 'booking-uuid-003',
              bookingStatus: 'CONFIRMED',
              cancellationDeadline: null,
              airlineRefundAmount: null,
              customerRefundAmount: null,
              refundStatus: null,
              nextRetryAt: null,
              escalationMessage: null,
              duffelCancellationQuoteId: 'cquo_secret_provider_abc',
              retryCount: 0,
              lastErrorCode: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await getCancellationStatus('booking-uuid-003');
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.bookingId, 'booking-uuid-003');
          assert.strictEqual(outcome.data.bookingStatus, 'CONFIRMED');
          assert.strictEqual(outcome.data.cancellationDeadline, null);
          assert.strictEqual(outcome.data.airlineRefundAmount, null);
          assert.strictEqual(outcome.data.customerRefundAmount, null);
          assert.strictEqual(outcome.data.refundStatus, null);
          assert.strictEqual(outcome.data.nextRetryAt, null);
          assert.strictEqual(outcome.data.escalationMessage, null);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('cquo_secret_provider_abc'), false);
        assert.strictEqual(serialized.includes('duffelCancellationQuoteId'), false);
        assert.strictEqual(serialized.includes('retryCount'), false);
      });

      it('tolerates omitted optional cancellation fields and maps quote while stripping provider order ID in getCancellationQuote', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              bookingId: 'booking-uuid-004',
              quoteId: 'quote-local-456',
              refundAmount: '350.00',
              currency: 'USD',
              expiresAt: timestamp,
              refundable: false,
              duffelOrderId: 'ord_secret_quote_456',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await getCancellationQuote('booking-uuid-004');
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.bookingId, 'booking-uuid-004');
          assert.strictEqual(outcome.data.quoteId, 'quote-local-456');
          assert.strictEqual(outcome.data.refundAmount, '350.00');
          assert.strictEqual(outcome.data.refundable, false);
          assert.strictEqual(outcome.data.cancellationDeadline, undefined);
          assert.strictEqual(outcome.data.refundTo, undefined);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('ord_secret_quote_456'), false);
        assert.strictEqual(serialized.includes('duffelOrderId'), false);
      });

      it('tolerates omitted optional nextRetryAt and maps cancellation result while stripping provider quote ID in cancelBooking', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              bookingId: 'booking-uuid-005',
              bookingStatus: 'CANCELLED',
              cancellationStatus: 'CONFIRMED',
              refundStatus: 'SUCCEEDED',
              refundAmount: '350.00',
              duffelCancellationQuoteId: 'cquo_secret_cancel_567',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await cancelBooking('booking-uuid-005', 'quote-local-456');
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.bookingId, 'booking-uuid-005');
          assert.strictEqual(outcome.data.bookingStatus, 'CANCELLED');
          assert.strictEqual(outcome.data.cancellationStatus, 'CONFIRMED');
          assert.strictEqual(outcome.data.refundStatus, 'SUCCEEDED');
          assert.strictEqual(outcome.data.refundAmount, '350.00');
          assert.strictEqual(outcome.data.nextRetryAt, undefined);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('cquo_secret_cancel_567'), false);
        assert.strictEqual(serialized.includes('duffelCancellationQuoteId'), false);
      });

      it('tolerates alternative revisions key, omitted pagination fields, and maps revisions while stripping baselines and diffs in getItineraryRevisions', async () => {
        globalThis.fetch = async (): Promise<Response> => {
          return new Response(
            JSON.stringify({
              revisions: [
                {
                  revisionId: 'rev-sparse-001',
                  version: 1,
                  observedAt: timestamp,
                  isMaterial: false,
                  materialReasons: [],
                  segments: [mockUpstreamSegment],
                  materialBaselines: [{ baselineKey: 'secret_val' }],
                  incrementalSummary: { diffData: 'secret_diff' },
                  cumulativeSummary: { diffData: 'secret_diff' },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        };

        const outcome = await getItineraryRevisions('booking-uuid-006', 1, 5);
        assert.strictEqual(outcome.ok, true);
        if (outcome.ok) {
          assert.strictEqual(outcome.data.revisions.length, 1);
          assert.strictEqual(outcome.data.revisions[0].revisionId, 'rev-sparse-001');
          assert.strictEqual(outcome.data.total, 1);
          assert.strictEqual(outcome.data.totalPages, 1);
        }
        const serialized = JSON.stringify(outcome);
        assert.strictEqual(serialized.includes('materialBaselines'), false);
        assert.strictEqual(serialized.includes('incrementalSummary'), false);
        assert.strictEqual(serialized.includes('cumulativeSummary'), false);
        assert.strictEqual(serialized.includes('duffelSegmentId'), false);
      });
    });

    describe('2. 400 and 422 error body forwarding and fallback', () => {
      it('forwards custom data.message for 400 and 422 across all operations when message is a string', async () => {
        const operations: Array<{
          name: string;
          run: () => Promise<{ ok: boolean; reason?: string; message?: string }>;
        }> = [
          { name: 'listBookings', run: () => listBookings('upcoming', 1, 10) },
          { name: 'getBookingDetail', run: () => getBookingDetail('booking-uuid-001') },
          { name: 'getCancellationStatus', run: () => getCancellationStatus('booking-uuid-001') },
          { name: 'getCancellationQuote', run: () => getCancellationQuote('booking-uuid-001') },
          { name: 'cancelBooking', run: () => cancelBooking('booking-uuid-001', 'quote-001') },
          {
            name: 'acknowledgeDisruption',
            run: () => acknowledgeDisruption('booking-uuid-001', 'rev-001'),
          },
          { name: 'acceptDisruption', run: () => acceptDisruption('booking-uuid-001', 'rev-001') },
          {
            name: 'getItineraryRevisions',
            run: () => getItineraryRevisions('booking-uuid-001', 1, 5),
          },
        ];

        for (const op of operations) {
          for (const status of [400, 422]) {
            const customMessage = `Custom upstream error for ${op.name} with status ${status}`;
            globalThis.fetch = async (): Promise<Response> => {
              return new Response(JSON.stringify({ message: customMessage }), {
                status,
                headers: { 'Content-Type': 'application/json' },
              });
            };

            const outcome = await op.run();
            assert.strictEqual(outcome.ok, false, `${op.name} on ${status} should return ok: false`);
            if (!outcome.ok) {
              assert.strictEqual(
                outcome.reason,
                'INVALID_COMMAND',
                `${op.name} reason should be INVALID_COMMAND on ${status}`,
              );
              assert.strictEqual(
                outcome.message,
                customMessage,
                `${op.name} should forward custom message on ${status}`,
              );
            }
          }
        }
      });

      it('falls back to default error message on 400 and 422 when body is malformed JSON, empty, or non-string message', async () => {
        const operations: Array<{
          name: string;
          run: () => Promise<{ ok: boolean; reason?: string; message?: string }>;
        }> = [
          { name: 'listBookings', run: () => listBookings('upcoming', 1, 10) },
          { name: 'getBookingDetail', run: () => getBookingDetail('booking-uuid-001') },
          { name: 'getCancellationStatus', run: () => getCancellationStatus('booking-uuid-001') },
          { name: 'getCancellationQuote', run: () => getCancellationQuote('booking-uuid-001') },
          { name: 'cancelBooking', run: () => cancelBooking('booking-uuid-001', 'quote-001') },
          {
            name: 'acknowledgeDisruption',
            run: () => acknowledgeDisruption('booking-uuid-001', 'rev-001'),
          },
          { name: 'acceptDisruption', run: () => acceptDisruption('booking-uuid-001', 'rev-001') },
          {
            name: 'getItineraryRevisions',
            run: () => getItineraryRevisions('booking-uuid-001', 1, 5),
          },
        ];

        const defaultMessage = 'Invalid request. Please check your details and try again.';
        const badBodies = [
          'not valid json',
          '{}',
          JSON.stringify({ message: 12345 }),
          JSON.stringify({ message: null }),
          JSON.stringify({ error: 'different field' }),
        ];

        for (const op of operations) {
          for (const status of [400, 422]) {
            for (const body of badBodies) {
              globalThis.fetch = async (): Promise<Response> => {
                return new Response(body, {
                  status,
                  headers: { 'Content-Type': 'application/json' },
                });
              };

              const outcome = await op.run();
              assert.strictEqual(
                outcome.ok,
                false,
                `${op.name} on ${status} should return ok: false`,
              );
              if (!outcome.ok) {
                assert.strictEqual(
                  outcome.reason,
                  'INVALID_COMMAND',
                  `${op.name} reason should be INVALID_COMMAND on ${status}`,
                );
                assert.strictEqual(
                  outcome.message,
                  defaultMessage,
                  `${op.name} should fallback to default message`,
                );
              }
            }
          }
        }
      });
    });

    describe('3. Malformed successful JSON handling across operations', () => {
      it('maps unparseable 200 JSON to UPSTREAM_UNAVAILABLE with retryable true without throwing', async () => {
        const operations: Array<{
          name: string;
          run: () => Promise<{ ok: boolean; reason?: string; retryable?: boolean }>;
        }> = [
          { name: 'listBookings', run: () => listBookings('upcoming', 1, 10) },
          { name: 'getBookingDetail', run: () => getBookingDetail('booking-uuid-001') },
          { name: 'getCancellationStatus', run: () => getCancellationStatus('booking-uuid-001') },
          { name: 'getCancellationQuote', run: () => getCancellationQuote('booking-uuid-001') },
          { name: 'cancelBooking', run: () => cancelBooking('booking-uuid-001', 'quote-001') },
          {
            name: 'getItineraryRevisions',
            run: () => getItineraryRevisions('booking-uuid-001', 1, 5),
          },
        ];

        for (const op of operations) {
          globalThis.fetch = async (): Promise<Response> => {
            return new Response('<html>502 Bad Gateway or unparseable text</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' },
            });
          };

          const outcome = await op.run();
          assert.strictEqual(
            outcome.ok,
            false,
            `${op.name} should return ok: false on unparseable JSON`,
          );
          if (!outcome.ok) {
            assert.strictEqual(
              outcome.reason,
              'UPSTREAM_UNAVAILABLE',
              `${op.name} should fail with UPSTREAM_UNAVAILABLE`,
            );
            assert.strictEqual(outcome.retryable, true, `${op.name} should be retryable`);
          }
        }
      });

      it('maps schema validation mismatch to UPSTREAM_UNAVAILABLE with retryable true without throwing', async () => {
        const mismatchCases: Array<{
          name: string;
          run: () => Promise<{ ok: boolean; reason?: string; retryable?: boolean }>;
          mismatchPayload: unknown;
        }> = [
          {
            name: 'listBookings',
            run: () => listBookings('upcoming', 1, 10),
            mismatchPayload: { bookings: [{ id: '' }] },
          },
          {
            name: 'getBookingDetail',
            run: () => getBookingDetail('booking-uuid-001'),
            mismatchPayload: { unexpectedStructure: 42 },
          },
          {
            name: 'getCancellationStatus',
            run: () => getCancellationStatus('booking-uuid-001'),
            mismatchPayload: { bookingId: '' },
          },
          {
            name: 'getCancellationQuote',
            run: () => getCancellationQuote('booking-uuid-001'),
            mismatchPayload: { quoteId: '' },
          },
          {
            name: 'cancelBooking',
            run: () => cancelBooking('booking-uuid-001', 'quote-001'),
            mismatchPayload: { bookingId: '' },
          },
          {
            name: 'getItineraryRevisions',
            run: () => getItineraryRevisions('booking-uuid-001', 1, 5),
            mismatchPayload: { items: [{ revisionId: '', segments: [{}] }] },
          },
        ];

        for (const testCase of mismatchCases) {
          globalThis.fetch = async (): Promise<Response> => {
            return new Response(JSON.stringify(testCase.mismatchPayload), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          };

          const outcome = await testCase.run();
          assert.strictEqual(
            outcome.ok,
            false,
            `${testCase.name} should return ok: false on schema mismatch`,
          );
          if (!outcome.ok) {
            assert.strictEqual(
              outcome.reason,
              'UPSTREAM_UNAVAILABLE',
              `${testCase.name} should fail with UPSTREAM_UNAVAILABLE`,
            );
            assert.strictEqual(outcome.retryable, true, `${testCase.name} should be retryable`);
          }
        }
      });
    });

    describe('4. Empty-body disruption acknowledge & accept success', () => {
      it('returns { ok: true, data: { ok: true } } on 200 and 204 empty responses for acknowledgeDisruption', async () => {
        for (const status of [200, 204]) {
          globalThis.fetch = async (): Promise<Response> => {
            return new Response(status === 204 ? null : '', { status });
          };

          const outcome = await acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001');
          assert.deepEqual(outcome, {
            ok: true,
            data: { ok: true },
          });
        }
      });

      it('returns { ok: true, data: { ok: true } } on 200 and 204 empty responses for acceptDisruption', async () => {
        for (const status of [200, 204]) {
          globalThis.fetch = async (): Promise<Response> => {
            return new Response(status === 204 ? null : '', { status });
          };

          const outcome = await acceptDisruption('booking-uuid-001', 'rev-uuid-001');
          assert.deepEqual(outcome, {
            ok: true,
            data: { ok: true },
          });
        }
      });
    });

    describe('5. Mutation single-send guarantee (zero replay)', () => {
      const mutationOperations: Array<{
        name: string;
        run: () => Promise<{ ok: boolean; reason?: string }>;
      }> = [
        { name: 'getCancellationQuote', run: () => getCancellationQuote('booking-uuid-001') },
        { name: 'cancelBooking', run: () => cancelBooking('booking-uuid-001', 'quote-local-123') },
        {
          name: 'acknowledgeDisruption',
          run: () => acknowledgeDisruption('booking-uuid-001', 'rev-uuid-001'),
        },
        {
          name: 'acceptDisruption',
          run: () => acceptDisruption('booking-uuid-001', 'rev-uuid-001'),
        },
      ];

      it('dispatches mutations at most once on 502, 503, and 504 gateway responses', async () => {
        for (const op of mutationOperations) {
          for (const status of [502, 503, 504]) {
            let attempts = 0;
            globalThis.fetch = async (): Promise<Response> => {
              attempts += 1;
              return new Response(JSON.stringify({ message: `Gateway error ${status}` }), {
                status,
              });
            };

            const outcome = await op.run();
            assert.strictEqual(outcome.ok, false, `${op.name} should fail on ${status}`);
            assert.strictEqual(attempts, 1, `${op.name} must dispatch exactly once on ${status}`);
          }
        }
      });

      it('dispatches mutations at most once on 429 response even with Retry-After header', async () => {
        for (const op of mutationOperations) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(JSON.stringify({ message: 'Rate limit exceeded' }), {
              status: 429,
              headers: { 'Retry-After': '10' },
            });
          };

          const outcome = await op.run();
          assert.strictEqual(outcome.ok, false, `${op.name} should fail on 429`);
          assert.strictEqual(attempts, 1, `${op.name} must dispatch exactly once on 429`);
        }
      });

      it('dispatches mutations at most once on network connection error', async () => {
        for (const op of mutationOperations) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            throw new TypeError('Failed to fetch');
          };

          const outcome = await op.run();
          assert.strictEqual(outcome.ok, false, `${op.name} should fail on network error`);
          assert.strictEqual(
            attempts,
            1,
            `${op.name} must dispatch exactly once on network error`,
          );
        }
      });

      it('dispatches mutations at most once on timeout abort error', async () => {
        for (const op of mutationOperations) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            throw new DOMException('The operation was aborted', 'AbortError');
          };

          const outcome = await op.run();
          assert.strictEqual(outcome.ok, false, `${op.name} should fail on abort timeout`);
          assert.strictEqual(attempts, 1, `${op.name} must dispatch exactly once on timeout`);
        }
      });
    });

    describe('6. GET retry policy & recovery', () => {
      const getOperations: Array<{
        name: string;
        run: () => Promise<{ ok: boolean; reason?: string; retryable?: boolean }>;
        successResponse: () => Response;
      }> = [
        {
          name: 'listBookings',
          run: () => listBookings('upcoming', 1, 10),
          successResponse: () =>
            new Response(
              JSON.stringify({
                bookings: [mockUpstreamBookingListItem],
                pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
        {
          name: 'getBookingDetail',
          run: () => getBookingDetail('booking-uuid-001'),
          successResponse: () =>
            new Response(JSON.stringify(mockUpstreamBookingDetail), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
        },
        {
          name: 'getCancellationStatus',
          run: () => getCancellationStatus('booking-uuid-001'),
          successResponse: () =>
            new Response(
              JSON.stringify({
                bookingId: 'booking-uuid-001',
                bookingStatus: 'CONFIRMED',
                cancellationDeadline: null,
                airlineRefundAmount: null,
                customerRefundAmount: null,
                refundStatus: null,
                nextRetryAt: null,
                escalationMessage: null,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
        {
          name: 'getItineraryRevisions',
          run: () => getItineraryRevisions('booking-uuid-001', 1, 5),
          successResponse: () =>
            new Response(
              JSON.stringify({
                items: [],
                page: 1,
                limit: 5,
                total: 0,
                totalPages: 0,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        },
      ];

      it('retries transient 503 failures up to 3 attempts across all GET operations', async () => {
        for (const op of getOperations) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response('Service Unavailable', { status: 503 });
          };

          const outcome = await op.run();
          assert.strictEqual(outcome.ok, false, `${op.name} should fail on 503`);
          if (!outcome.ok) {
            assert.strictEqual(
              outcome.reason,
              'UPSTREAM_UNAVAILABLE',
              `${op.name} reason should be UPSTREAM_UNAVAILABLE`,
            );
            assert.strictEqual(outcome.retryable, true, `${op.name} should be retryable`);
          }
          assert.strictEqual(attempts, 3, `${op.name} should retry up to 3 attempts on 503`);
        }
      });

      it('retries transient 502 and 504 gateway failures across GET operations', async () => {
        for (const status of [502, 504]) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(`Gateway error ${status}`, { status });
          };

          const outcome = await listBookings('upcoming', 1, 10);
          assert.strictEqual(outcome.ok, false);
          assert.strictEqual(attempts, 3, `GET should retry 3 times on status ${status}`);
        }
      });

      it('recovers successfully on subsequent attempt when transient error clears across GET operations', async () => {
        for (const op of getOperations) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            if (attempts === 1) {
              return new Response('Transient 503', { status: 503 });
            }
            return op.successResponse();
          };

          const outcome = await op.run();
          assert.strictEqual(outcome.ok, true, `${op.name} should recover on attempt 2`);
          assert.strictEqual(
            attempts,
            2,
            `${op.name} expected 2 attempts for transient recovery`,
          );
        }
      });

      it('dispatches non-transient HTTP errors (400, 401, 403, 404, 409, 422) exactly once across GET operations', async () => {
        const nonTransientStatuses = [400, 401, 403, 404, 409, 422];
        for (const status of nonTransientStatuses) {
          let attempts = 0;
          globalThis.fetch = async (): Promise<Response> => {
            attempts += 1;
            return new Response(JSON.stringify({ message: `Non-transient ${status}` }), {
              status,
              headers: { 'Content-Type': 'application/json' },
            });
          };

          const outcome = await getBookingDetail('booking-uuid-001');
          assert.strictEqual(outcome.ok, false);
          assert.strictEqual(attempts, 1, `GET must not retry non-transient status ${status}`);
        }
      });
    });
  });

  describe('Feature 029 browser identity boundary baseline', (): void => {
    it('omits Duffel and supplier identity fields while preserving booking display fields', async (): Promise<void> => {
      const providerIdentityBooking = {
        ...mockUpstreamBookingDetail,
        duffelOfferId: 'off_provider_offer_secret',
        supplierOfferId: 'supplier_offer_secret',
        currentItinerary: {
          ...mockUpstreamBookingDetail.currentItinerary,
          segments: [
            {
              ...mockUpstreamSegment,
              supplierSegmentId: 'supplier_segment_secret',
            },
          ],
        },
      };
      globalThis.fetch = async (): Promise<Response> =>
        new Response(JSON.stringify(providerIdentityBooking), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });

      const outcome = await getBookingDetail('booking-uuid-001');

      assert.equal(outcome.ok, true);
      if (outcome.ok) {
        assert.equal(outcome.data.id, 'booking-uuid-001');
        assert.equal(outcome.data.status, 'CONFIRMED');
        assert.equal(outcome.data.totalAmount, '499.00');
        assert.equal(outcome.data.currency, 'USD');
        assert.equal(outcome.data.passengers[0].firstName, 'Ada');
        assert.equal(outcome.data.itinerary.segments[0].flightNumber, 'HZ789');
      }

      const serialized = JSON.stringify(outcome);
      for (const identityKey of [
        'duffelOrderId',
        'duffelOfferId',
        'duffelSegmentId',
        'supplierOfferId',
        'supplierSegmentId',
      ]) {
        assert.equal(serialized.includes(identityKey), false);
      }
      for (const identityValue of [
        'ord_secret_provider_123',
        'off_provider_offer_secret',
        'seg_secret_provider_id',
        'supplier_offer_secret',
        'supplier_segment_secret',
      ]) {
        assert.equal(serialized.includes(identityValue), false);
      }
    });
  });
});
