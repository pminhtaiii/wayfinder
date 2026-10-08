import { Duffel } from '@duffel/api';

import { FULFILLMENT_SCENARIO_MANIFEST } from './scenarios';
import { startStripeServer } from './stripe-server';
import { startSupplierServer } from './supplier-server';
import type {
  SimulatorFaultOutcome,
  StripeSimulator,
  SupplierSimulator,
} from './simulator-types';

type HttpExpectation = number | 'CONNECTION_CLOSED';
type FaultCase = {
  outcome: SimulatorFaultOutcome;
  response: HttpExpectation;
  effectDelta: number;
};
type StatusFaultCase = {
  outcome: Extract<SimulatorFaultOutcome, 'DEFINITIVE_REJECTION' | 'PROCESSING' | 'UNAVAILABLE'>;
  response: number;
  status: string;
  effectDelta: number;
};
type ReadFaultCase = {
  outcome: Extract<SimulatorFaultOutcome, 'PROCESSING' | 'UNAVAILABLE' | 'RATE_LIMITED'>;
  response: number;
  errorCode?: string;
  retryAfter?: string;
};
type CandidateFaultCase = {
  outcome: Extract<SimulatorFaultOutcome, 'ZERO_CANDIDATES' | 'MULTIPLE_CANDIDATES' | 'UNLINKED_CANDIDATE'>;
  expectedCount: number;
};

const runId = 'transport-fault-contract';
let stripeSimulator: StripeSimulator | undefined;
let supplierSimulator: SupplierSimulator | undefined;
let duffelClient: Duffel | undefined;

function currentStripe(): StripeSimulator {
  const current = stripeSimulator;
  if (!current) throw new Error('Stripe simulator did not start');
  return current;
}

function currentSupplier(): SupplierSimulator {
  const current = supplierSimulator;
  if (!current) throw new Error('supplier simulator did not start');
  return current;
}



function currentDuffelClient(): Duffel {
  const current = duffelClient;
  if (!current) throw new Error('Duffel client did not start');
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected a provider record');
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error('expected a provider string field');
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('expected a provider array');
  return value;
}

function isHeaderReader(value: unknown): value is { get(name: string): string | null } {
  return isRecord(value) && typeof value.get === 'function';
}

function readDuffelErrorEvidence(error: unknown): {
  code: string;
  retryAfter: string | null;
} {
  const errorRecord = requireRecord(error);
  const errors = requireArray(errorRecord.errors);
  const firstError = requireRecord(errors[0]);
  const headers = errorRecord.headers;
  if (!isHeaderReader(headers)) throw new Error('expected Duffel response headers');
  return {
    code: requireString(firstError, 'code'),
    retryAfter: headers.get('retry-after'),
  };
}

function stripeHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer ' + currentStripe().applicationCredential,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

async function stripeRequest(
  path: string,
  method: 'GET' | 'POST',
  body?: URLSearchParams,
  idempotencyKey?: string,
): Promise<Response> {
  const headers = stripeHeaders();
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return fetch(currentStripe().origin + '/v1/' + path, {
    method,
    headers,
    ...(body ? { body } : {}),
  });
}

function paymentIntentParams(bookingIntentId: string): URLSearchParams {
  return new URLSearchParams({
    amount: '10000',
    currency: 'usd',
    capture_method: 'manual',
    payment_method: 'pm_card_visa',
    'metadata[bookingIntentId]': bookingIntentId,
  });
}

async function createStripeIntent(bookingIntentId: string): Promise<string> {
  const response = await stripeRequest(
    'payment_intents',
    'POST',
    paymentIntentParams(bookingIntentId),
    'create-' + bookingIntentId,
  );
  if (!response.ok) throw new Error('Stripe intent creation failed');
  return requireString(requireRecord(await response.json()), 'id');
}

async function authorizeStripeIntent(intentId: string): Promise<void> {
  const response = await stripeRequest(
    'payment_intents/' + intentId + '/confirm',
    'POST',
    new URLSearchParams(),
  );
  if (!response.ok) throw new Error('Stripe authorization failed');
}

async function createCapturedStripeIntent(bookingIntentId: string): Promise<string> {
  const intentId = await createStripeIntent(bookingIntentId);
  await authorizeStripeIntent(intentId);
  const response = await stripeRequest(
    'payment_intents/' + intentId + '/capture',
    'POST',
    new URLSearchParams(),
    'capture-' + bookingIntentId,
  );
  if (!response.ok) throw new Error('Stripe capture setup failed');
  return intentId;
}

async function createSupplierOffer(): Promise<string> {
  const response = await fetch(currentSupplier().origin + '/air/offer_requests', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + currentSupplier().applicationCredential,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      data: {
        slices: [{ origin: 'SFO', destination: 'JFK', departure_date: '2027-04-15' }],
        passengers: [{ type: 'adult' }],
      },
    }),
  });
  if (!response.ok) throw new Error('supplier offer creation failed');
  const data = requireRecord(requireRecord(await response.json()).data);
  const offers = requireArray(data.offers);
  const firstOffer = offers[0];
  if (firstOffer === undefined) throw new Error('supplier returned no offer');
  return requireString(requireRecord(firstOffer), 'id');
}

function supplierHeaders(): Record<string, string> {
  return {
    Authorization: 'Bearer ' + currentSupplier().applicationCredential,
    'Content-Type': 'application/json',
  };
}

async function createSupplierOrderResponse(
  offerId: string,
  bookingIntentId: string,
  userIds: string[] = [],
): Promise<Response> {
  return fetch(currentSupplier().origin + '/air/orders', {
    method: 'POST',
    headers: supplierHeaders(),
    body: JSON.stringify({
      data: {
        type: 'instant',
        selected_offers: [offerId],
        passengers: [{
          type: 'adult',
          given_name: 'Test',
          family_name: 'Traveler',
          born_on: '1990-01-01',
          email: 'traveler@example.test',
        }],
        ...(userIds.length > 0 ? { users: userIds } : {}),
        metadata: { bookingIntentId },
      },
    }),
  });
}

async function createSupplierOrder(
  bookingIntentId: string,
  userIds: string[] = [],
): Promise<{ orderId: string; bookingReference: string }> {
  const offerId = await createSupplierOffer();
  const response = await createSupplierOrderResponse(offerId, bookingIntentId, userIds);
  if (!response.ok) throw new Error('supplier order creation failed');
  const data = requireRecord(requireRecord(await response.json()).data);
  return {
    orderId: requireString(data, 'id'),
    bookingReference: requireString(data, 'booking_reference'),
  };
}

async function createCancellationQuote(orderId: string): Promise<string> {
  const response = await fetch(currentSupplier().origin + '/air/order_cancellations', {
    method: 'POST',
    headers: supplierHeaders(),
    body: JSON.stringify({ data: { order_id: orderId } }),
  });
  if (!response.ok) throw new Error('supplier cancellation quote failed');
  return requireString(requireRecord(requireRecord(await response.json()).data), 'id');
}

async function confirmCancellation(cancellationId: string): Promise<Response> {
  return fetch(
    currentSupplier().origin + '/air/order_cancellations/' + cancellationId + '/actions/confirm',
    { method: 'POST', headers: supplierHeaders(), body: JSON.stringify({ data: {} }) },
  );
}

async function readHttpStatus(
  promise: Promise<Response>,
  expected: HttpExpectation,
): Promise<Response | undefined> {
  if (expected === 'CONNECTION_CLOSED') {
    await expect(promise).rejects.toThrow();
    return undefined;
  }
  const response = await promise;
  expect(response.status).toBe(expected);
  return response;
}

beforeAll(async () => {
  stripeSimulator = await startStripeServer({ runId });
  supplierSimulator = await startSupplierServer({
    runId,
    balanceAmount: '137.25',
    balanceCurrency: 'EUR',
  });

  duffelClient = new Duffel({
    token: currentSupplier().applicationCredential,
    basePath: currentSupplier().origin,
  });
});

afterAll(async () => {
  await currentStripe().close();
  await currentSupplier().close();
});

describe('finite provider fault transport behavior', () => {
  it('accepts exactly the versioned registered provider operation and outcome tuples', async () => {
    let selectionNumber = 0;
    for (const scenario of FULFILLMENT_SCENARIO_MANIFEST) {
      const selection = {
        ...scenario,
        bookingIntentId: 'registered-scenario-' + selectionNumber,
      };
      selectionNumber += 1;
      if (selection.provider === 'STRIPE') {
        await currentStripe().selectFault(runId, selection);
      } else {
        await currentSupplier().selectFault(runId, selection);
      }
    }
    expect(selectionNumber).toBeGreaterThan(0);
  });

  const createCases: FaultCase[] = [
    { outcome: 'CONFIRMED', response: 200, effectDelta: 1 },
    { outcome: 'DEFINITIVE_REJECTION', response: 402, effectDelta: 0 },
    { outcome: 'NO_CREATE_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 0 },
    { outcome: 'CREATE_COMMITTED_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 1 },
    { outcome: 'PROCESSING', response: 200, effectDelta: 1 },
  ];

  it.each(createCases)(
    'applies Stripe PaymentIntent create outcome $outcome to only provider effects',
    async ({ outcome, response: expectedResponse, effectDelta }) => {
      const bookingIntentId = 'stripe-create-' + outcome;
      const before = await currentStripe().inspect(runId);
      await currentStripe().selectFault(runId, {
        provider: 'STRIPE',
        purpose: 'PAYMENT_INTENT_CREATE',
        bookingIntentId,
        outcome,
      });
      const response = await readHttpStatus(
        stripeRequest(
          'payment_intents',
          'POST',
          paymentIntentParams(bookingIntentId),
          'create-' + bookingIntentId,
        ),
        expectedResponse,
      );
      if (response?.ok) {
        const result = requireRecord(await response.json());
        expect(result.status).toBe(outcome === 'PROCESSING' ? 'processing' : 'requires_confirmation');
      }
      const after = await currentStripe().inspect(runId);
      expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    },
  );

  it('holds a committed Stripe create response until in-process release', async () => {
    const bookingIntentId = 'stripe-create-held';
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE',
      purpose: 'PAYMENT_INTENT_CREATE',
      bookingIntentId,
      outcome: 'HELD_LATE_RESPONSE',
    });
    const responseIdPromise = currentStripe().waitForHeldResponse(runId, bookingIntentId);
    const pendingResponse = stripeRequest(
      'payment_intents',
      'POST',
      paymentIntentParams(bookingIntentId),
      'create-' + bookingIntentId,
    );
    const responseId = await responseIdPromise;
    expect((await currentStripe().inspect(runId)).pendingResponseIds).toContain(responseId);
    await currentStripe().releaseResponse(runId, responseId);
    expect((await pendingResponse).status).toBe(200);
  });

  const authorizationCases: StatusFaultCase[] = [
    { outcome: 'DEFINITIVE_REJECTION', response: 402, status: 'requires_confirmation', effectDelta: 0 },
    { outcome: 'PROCESSING', response: 200, status: 'processing', effectDelta: 1 },
  ];  it.each(authorizationCases)('applies Stripe authorization outcome $outcome', async ({ outcome, response, status: expectedStatus, effectDelta }) => {
    const bookingIntentId = 'stripe-auth-' + outcome;
    const intentId = await createStripeIntent(bookingIntentId);
    const before = await currentStripe().inspect(runId);
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE', purpose: 'AUTHORIZATION', bookingIntentId, outcome,
    });
    const result = await stripeRequest('payment_intents/' + intentId + '/confirm', 'POST', new URLSearchParams());
    expect(result.status).toBe(response);
    if (result.ok) expect(requireRecord(await result.json()).status).toBe(expectedStatus);
    const after = await currentStripe().inspect(runId);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    expect(after.paymentIntents.find((intent) => intent.id === intentId)?.status).toBe(expectedStatus);
  });

  const captureCases: FaultCase[] = [
    { outcome: 'DEFINITIVE_REJECTION', response: 402, effectDelta: 0 },
    { outcome: 'CREATE_COMMITTED_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 1 },
    { outcome: 'UNCOMMITTED_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 0 },
    { outcome: 'PROCESSING', response: 200, effectDelta: 1 },
  ];

  it.each(captureCases)('applies Stripe capture outcome $outcome', async ({ outcome, response: expectedResponse, effectDelta }) => {
    const bookingIntentId = 'stripe-capture-' + outcome;
    const intentId = await createStripeIntent(bookingIntentId);
    await authorizeStripeIntent(intentId);
    const before = await currentStripe().inspect(runId);
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE', purpose: 'CAPTURE', bookingIntentId, outcome,
    });
    await readHttpStatus(
      stripeRequest('payment_intents/' + intentId + '/capture', 'POST', new URLSearchParams(), 'capture-' + bookingIntentId),
      expectedResponse,
    );
    const after = await currentStripe().inspect(runId);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    const status = after.paymentIntents.find((intent) => intent.id === intentId)?.status;
    expect(status).toBe(outcome === 'PROCESSING' ? 'processing' :
      outcome === 'CREATE_COMMITTED_LOST_RESPONSE' ? 'succeeded' : 'requires_capture');
  });

  const releaseCases: StatusFaultCase[] = [
    { outcome: 'DEFINITIVE_REJECTION', response: 402, status: 'requires_capture', effectDelta: 0 },
    { outcome: 'PROCESSING', response: 200, status: 'processing', effectDelta: 1 },
    { outcome: 'UNAVAILABLE', response: 503, status: 'requires_capture', effectDelta: 0 },
  ];  it.each(releaseCases)('applies Stripe authorization-release outcome $outcome', async ({ outcome, response, status, effectDelta }) => {
    const bookingIntentId = 'stripe-release-' + outcome;
    const intentId = await createStripeIntent(bookingIntentId);
    await authorizeStripeIntent(intentId);
    const before = await currentStripe().inspect(runId);
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE', purpose: 'AUTHORIZATION_RELEASE', bookingIntentId, outcome,
    });
    const result = await stripeRequest('payment_intents/' + intentId + '/cancel', 'POST', new URLSearchParams());
    expect(result.status).toBe(response);
    if (result.ok) expect(requireRecord(await result.json()).status).toBe(status);
    const after = await currentStripe().inspect(runId);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    expect(after.paymentIntents.find((intent) => intent.id === intentId)?.status).toBe(status);
  });

  const refundCases: Array<StatusFaultCase & { refundCount: number }> = [
    { outcome: 'DEFINITIVE_REJECTION', response: 402, status: '', refundCount: 0, effectDelta: 0 },
    { outcome: 'PROCESSING', response: 200, status: '', refundCount: 1, effectDelta: 1 },
    { outcome: 'UNAVAILABLE', response: 503, status: '', refundCount: 0, effectDelta: 0 },
  ];  it.each(refundCases)('applies Stripe refund outcome $outcome', async ({ outcome, response, refundCount, effectDelta }) => {
    const bookingIntentId = 'stripe-refund-' + outcome;
    const intentId = await createCapturedStripeIntent(bookingIntentId);
    const before = await currentStripe().inspect(runId);
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE', purpose: 'REFUND', bookingIntentId, outcome,
    });
    const result = await stripeRequest('refunds', 'POST', new URLSearchParams({ payment_intent: intentId }));
    expect(result.status).toBe(response);
    const after = await currentStripe().inspect(runId);
    expect(after.refunds.length - before.refunds.length).toBe(refundCount);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    if (refundCount > 0) expect(after.refunds.at(-1)?.status).toBe('pending');
  });

  const stripeReadCases: ReadFaultCase[] = [
    { outcome: 'PROCESSING', response: 200 },
    { outcome: 'UNAVAILABLE', response: 503 },
    { outcome: 'RATE_LIMITED', response: 429 },
  ];  it.each(stripeReadCases)('applies Stripe reconciliation read outcome $outcome', async ({ outcome, response }) => {
    const bookingIntentId = 'stripe-read-' + outcome;
    const intentId = await createStripeIntent(bookingIntentId);
    const before = await currentStripe().inspect(runId);
    await currentStripe().selectFault(runId, {
      provider: 'STRIPE', purpose: 'RECONCILE', bookingIntentId, outcome,
    });
    const result = await stripeRequest('payment_intents/' + intentId, 'GET');
    expect(result.status).toBe(response);
    if (result.ok) expect(requireRecord(await result.json()).status).toBe('processing');
    const after = await currentStripe().inspect(runId);
    expect(after.sideEffectCount).toBe(before.sideEffectCount);
    expect(after.paymentIntents.find((intent) => intent.id === intentId)?.status).toBe('requires_confirmation');
  });

  const supplierCreateCases: FaultCase[] = [
    { outcome: 'DEFINITIVE_REJECTION', response: 422, effectDelta: 0 },
    { outcome: 'NO_CREATE_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 0 },
    { outcome: 'CREATE_COMMITTED_LOST_RESPONSE', response: 'CONNECTION_CLOSED', effectDelta: 1 },
    { outcome: 'PROCESSING', response: 202, effectDelta: 1 },
  ];

  it.each(supplierCreateCases)('applies Duffel order-create outcome $outcome', async ({ outcome, response: expectedResponse, effectDelta }) => {
    const bookingIntentId = 'supplier-create-' + outcome;
    const offerId = await createSupplierOffer();
    const before = await currentSupplier().inspect(runId);
    await currentSupplier().selectFault(runId, {
      provider: 'DUFFEL', purpose: 'ORDER_CREATE', bookingIntentId, outcome,
    });
    const response = await readHttpStatus(
      createSupplierOrderResponse(offerId, bookingIntentId),
      expectedResponse,
    );
    const after = await currentSupplier().inspect(runId);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    if (effectDelta === 1) expect(after.orders.length - before.orders.length).toBe(1);
    if (response?.status === 202) expect(requireRecord(await response.json()).data).toBeUndefined();
  });

  it('holds a committed Duffel order response until in-process release', async () => {
    const bookingIntentId = 'supplier-create-held';
    const offerId = await createSupplierOffer();
    await currentSupplier().selectFault(runId, {
      provider: 'DUFFEL', purpose: 'ORDER_CREATE', bookingIntentId, outcome: 'HELD_LATE_RESPONSE',
    });
    const responseIdPromise = currentSupplier().waitForHeldResponse(runId, bookingIntentId);
    const pendingResponse = createSupplierOrderResponse(offerId, bookingIntentId);
    const responseId = await responseIdPromise;
    expect((await currentSupplier().inspect(runId)).pendingResponseIds).toContain(responseId);
    await currentSupplier().releaseResponse(runId, responseId);
    expect((await pendingResponse).status).toBe(200);
  });

  const supplierCancelCases: StatusFaultCase[] = [
    { outcome: 'DEFINITIVE_REJECTION', response: 422, status: 'ACTIVE', effectDelta: 0 },
    { outcome: 'PROCESSING', response: 503, status: 'CANCELLATION_PENDING', effectDelta: 1 },
    { outcome: 'UNAVAILABLE', response: 503, status: 'ACTIVE', effectDelta: 0 },
  ];  it.each(supplierCancelCases)('applies Duffel cancellation outcome $outcome', async ({ outcome, response, status, effectDelta }) => {
    const bookingIntentId = 'supplier-cancel-' + outcome;
    const order = await createSupplierOrder(bookingIntentId);
    const cancellationId = await createCancellationQuote(order.orderId);
    const before = await currentSupplier().inspect(runId);
    await currentSupplier().selectFault(runId, {
      provider: 'DUFFEL', purpose: 'ORDER_CANCEL', bookingIntentId, outcome,
    });
    expect((await confirmCancellation(cancellationId)).status).toBe(response);
    const after = await currentSupplier().inspect(runId);
    expect(after.sideEffectCount - before.sideEffectCount).toBe(effectDelta);
    expect(after.orders.find((candidate) => candidate.id === order.orderId)?.status).toBe(status);
  });

  it('uses Duffel orders.list and verified filters for candidate observations', async () => {
    const order = await createSupplierOrder('supplier-list-filter');
    const byBookingReference = await currentDuffelClient().orders.list({
      booking_reference: order.bookingReference,
    });
    expect(byBookingReference.data.map((candidate) => candidate.id)).toEqual([order.orderId]);
    const byPassengerName = await currentDuffelClient().orders.list({
      'passenger_name[]': ['Test Traveler'],
    });
    expect(byPassengerName.data.map((candidate) => candidate.id)).toContain(order.orderId);
  });

  it('matches Duffel user_id against the CreateOrder.users association', async () => {
    const userId = 'icu_transport_user_positive';
    const order = await createSupplierOrder('supplier-user-association-positive', [userId]);
    const candidates = await currentDuffelClient().orders.list({ user_id: userId });

    expect(candidates.data.map((candidate) => candidate.id)).toEqual([order.orderId]);
  });

  it('does not return a Duffel order for a different user_id', async () => {
    const order = await createSupplierOrder('supplier-user-association-negative', [
      'icu_transport_user_associated',
    ]);
    const candidates = await currentDuffelClient().orders.list({
      user_id: 'icu_transport_user_other',
    });

    expect(candidates.data.map((candidate) => candidate.id)).not.toContain(order.orderId);
    expect(candidates.data).toHaveLength(0);
  });

  const candidateCases: CandidateFaultCase[] = [
    { outcome: 'ZERO_CANDIDATES', expectedCount: 0 },
    { outcome: 'MULTIPLE_CANDIDATES', expectedCount: 2 },
    { outcome: 'UNLINKED_CANDIDATE', expectedCount: 1 },
  ];  it.each(candidateCases)('returns real Duffel order-list candidate fixtures for $outcome', async ({ outcome, expectedCount }) => {
    const bookingIntentId = 'supplier-candidates-' + outcome;
    await createSupplierOrder(bookingIntentId);
    const before = await currentSupplier().inspect(runId);
    await currentSupplier().selectFault(runId, {
      provider: 'DUFFEL', purpose: 'RECONCILE', bookingIntentId, outcome,
    });
    const candidates = await currentDuffelClient().orders.list({
      'passenger_name[]': ['Test Traveler'],
    });
    expect(candidates.data).toHaveLength(expectedCount);
    expect((await currentSupplier().inspect(runId)).sideEffectCount).toBe(before.sideEffectCount);
    if (outcome === 'UNLINKED_CANDIDATE') {
      expect(candidates.data[0]?.metadata.bookingIntentId).toBe('unlinked-candidate-fixture');
    }
  });

  const supplierReadCases: ReadFaultCase[] = [
    { outcome: 'PROCESSING', response: 200 },
    { outcome: 'UNAVAILABLE', response: 503, errorCode: 'provider_unavailable' },
    { outcome: 'RATE_LIMITED', response: 429, errorCode: 'rate_limited', retryAfter: '1' },
  ];  it.each(supplierReadCases)('applies Duffel reconciliation read outcome $outcome', async ({
    outcome,
    errorCode,
    retryAfter,
  }) => {
    const bookingIntentId = 'supplier-read-' + outcome;
    const order = await createSupplierOrder(bookingIntentId);
    await currentSupplier().selectFault(runId, {
      provider: 'DUFFEL', purpose: 'RECONCILE', bookingIntentId, outcome,
    });
    const errorEvidence = await currentDuffelClient().orders.get(order.orderId).then(
      () => undefined,
      (error: unknown) => readDuffelErrorEvidence(error),
    );

    if (outcome === 'PROCESSING') {
      expect(errorEvidence).toBeUndefined();
      return;
    }

    // Human approved 2026-10-08: DuffelError exposes provider errors and headers, not response.status.
    expect(errorEvidence?.code).toBe(errorCode);
    if (retryAfter !== undefined) {
      expect(errorEvidence?.retryAfter).toBe(retryAfter);
    }
  });
});