import Stripe from 'stripe';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import { StripePaymentAdapter } from '@/common/stripe-payment.adapter';
import { StripeService } from '@/common/stripe.service';
import {
  FULFILLMENT_GATEWAY_PORT,
  PAYMENT_GATEWAY_PORT,
  type FulfillmentGatewayPort,
  type PaymentGatewayPort,
  type PortInvocationControl,
} from '@/payment-fulfillment/ports';
import { DuffelCoreModule } from '@/supplier/core/duffel-core.module';
import { DuffelSearchAdapter } from '@/supplier/search/duffel-search.adapter';
import { SupplierOrderModule } from '@/supplier/order/supplier-order.module';
import { startStripeServer } from './stripe-server';
import { startSupplierServer } from './supplier-server';
import type {
  RedactedLedger,
  StripeSimulator,
  SupplierSimulator,
} from './simulator-types';

type TestHarness = {
  stripe: StripeSimulator;
  supplier: SupplierSimulator;
  stripeSdk: Stripe;
  testingModule: TestingModule;
  stripeService: StripeService;
  paymentGateway: PaymentGatewayPort;
  searchAdapter: DuffelSearchAdapter;
  fulfillmentGateway: FulfillmentGatewayPort;
};

const runId = 'provider-transport-contract';
const invocationControl: PortInvocationControl = {
  beforeInvoke: async (): Promise<void> => undefined,
};
let stripeSimulator: StripeSimulator | undefined;
let supplierSimulator: SupplierSimulator | undefined;
let testingModule: TestingModule | undefined;
let harness: TestHarness | undefined;

function currentHarness(): TestHarness {
  const current = harness;
  if (!current) {
    throw new Error('provider transport harness did not start');
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected a provider record');
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw new Error('expected a provider string field');
  }
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('expected a provider array');
  }
  return value;
}

async function supplierOfferId(testHarness: TestHarness): Promise<string> {
  const response = await testHarness.searchAdapter.searchOffers({
    origin: 'SFO',
    destination: 'JFK',
    departureDate: '2027-04-15',
    adults: 1,
    cabinClass: 'economy',
  });
  const offers = requireArray(requireRecord(response).offers);
  const firstOffer = offers[0];
  if (firstOffer === undefined) {
    throw new Error('supplier search returned no offer');
  }
  return requireString(requireRecord(firstOffer), 'id');
}

async function createSupplierOrder(
  testHarness: TestHarness,
  offerId: string,
  bookingIntentId: string,
): Promise<{ orderId: string; bookingReference: string }> {
  return testHarness.fulfillmentGateway.createOrder(
    {
      offerId,
      passengers: [
        {
          type: 'adult',
          givenName: 'Test',
          familyName: 'Traveler',
          dateOfBirth: '1990-01-01',
          phoneNumber: '+10000000000',
          email: 'traveler@example.test',
        },
      ],
      services: [{ serviceId: 'svc_bag_1', quantity: 1 }],
      metadata: { bookingIntentId, paymentId: 'payment-test-1' },
      idempotencyKey: 'supplier-order-' + bookingIntentId,
    },
    invocationControl,
  );
}

function requireLedger<TLedger extends RedactedLedger>(
  ledger: RedactedLedger,
  provider: TLedger['provider'],
): TLedger {
  if (ledger.provider !== provider) {
    throw new Error('simulator returned the wrong provider ledger');
  }
  return ledger;
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_feature030';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_feature030';
  process.env.DUFFEL_MOCK = '';

  stripeSimulator = await startStripeServer({ runId });
  supplierSimulator = await startSupplierServer({
    runId,
    balanceAmount: '137.25',
    balanceCurrency: 'EUR',
  });

  process.env.STRIPE_SECRET_KEY = stripeSimulator.applicationCredential;
  process.env.STRIPE_WEBHOOK_SECRET = stripeSimulator.webhookSecret;
  process.env.STRIPE_API_URL = stripeSimulator.origin;
  process.env.DUFFEL_ACCESS_TOKEN = supplierSimulator.applicationCredential;
  process.env.DUFFEL_API_URL = supplierSimulator.origin;
  delete process.env.DUFFEL_MOCK;

  const stripeUrl = new URL(stripeSimulator.origin);
  const stripeSdk = new Stripe(stripeSimulator.applicationCredential, {
    host: stripeUrl.hostname,
    port: Number(stripeUrl.port),
    protocol: stripeUrl.protocol === 'https:' ? 'https' : 'http',
  });

  testingModule = await Test.createTestingModule({
    imports: [DuffelCoreModule, SupplierOrderModule],
    providers: [
      StripeService,
      StripePaymentAdapter,
      DuffelSearchAdapter,
      { provide: PAYMENT_GATEWAY_PORT, useExisting: StripePaymentAdapter },
    ],
  })
    .overrideProvider(CacheService)
    .useValue({
      checkAndIncrement: async (): Promise<{ allowed: boolean; current: number }> => ({
        allowed: true,
        current: 1,
      }),
    })
    .compile();

  harness = {
    stripe: stripeSimulator,
    supplier: supplierSimulator,
    stripeSdk,
    testingModule,
    stripeService: testingModule.get(StripeService),
    paymentGateway: testingModule.get<PaymentGatewayPort>(PAYMENT_GATEWAY_PORT),
    searchAdapter: testingModule.get(DuffelSearchAdapter),
    fulfillmentGateway: testingModule.get<FulfillmentGatewayPort>(FULFILLMENT_GATEWAY_PORT),
  };
});

afterAll(async () => {
  await testingModule?.close();
  await stripeSimulator?.close();
  await supplierSimulator?.close();
});

describe('real provider transport contracts', () => {
  it('authorizes, captures, cancels, and refunds through the Stripe SDK and payment port', async () => {
    const testHarness = currentHarness();
    const created = await testHarness.stripeService.createPaymentIntent(
      42000,
      'usd',
      undefined,
      { bookingIntentId: 'stripe-ledger-booking' },
      'stripe-ledger-create',
      'pm_card_visa',
    );
    await testHarness.stripeSdk.paymentIntents.confirm(created.id);

    const authorization = await testHarness.paymentGateway.authorizeHold(
      created.id,
      invocationControl,
    );
    expect(authorization).toMatchObject({
      status: 'authorized',
      intentId: created.id,
      amount: 42000,
      currency: 'usd',
    });

    const capture = await testHarness.paymentGateway.capturePayment(
      created.id,
      'stripe-ledger-capture',
      invocationControl,
    );
    expect(capture).toMatchObject({ success: true, status: 'succeeded', currency: 'usd' });

    const refund = await testHarness.stripeService.createRefund(
      created.id,
      undefined,
      undefined,
      'stripe-ledger-refund',
    );
    expect(refund.payment_intent).toBe(created.id);
    expect(refund.status).toBe('succeeded');

    const secondIntent = await testHarness.stripeService.createPaymentIntent(
      8800,
      'usd',
      undefined,
      { bookingIntentId: 'stripe-void-booking' },
      'stripe-void-create',
      'pm_card_visa',
    );
    await testHarness.stripeSdk.paymentIntents.confirm(secondIntent.id);
    const voided = await testHarness.paymentGateway.voidHold(secondIntent.id, invocationControl);
    expect(voided).toMatchObject({ success: true, status: 'canceled' });

    const ledger = requireLedger<Extract<RedactedLedger, { provider: 'STRIPE' }>>(
      await testHarness.stripe.inspect(runId),
      'STRIPE',
    );
    expect(ledger.paymentIntents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.id,
          amount: 42000,
          currency: 'usd',
          captureMethod: 'manual',
          status: 'succeeded',
        }),
        expect.objectContaining({
          id: secondIntent.id,
          amount: 8800,
          currency: 'usd',
          captureMethod: 'manual',
          status: 'canceled',
        }),
      ]),
    );
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.sideEffectCount).toBeGreaterThanOrEqual(6);
  });

  it('replays a Stripe create only for the same idempotency key and request body', async () => {
    const testHarness = currentHarness();
    const params: Stripe.PaymentIntentCreateParams = {
      amount: 42000,
      currency: 'usd',
      capture_method: 'manual',
      metadata: { bookingIntentId: 'stripe-idempotency-booking' },
    };
    const first = await testHarness.stripeSdk.paymentIntents.create(params, {
      idempotencyKey: 'stripe-same-body-key',
    });
    const replay = await testHarness.stripeSdk.paymentIntents.create(params, {
      idempotencyKey: 'stripe-same-body-key',
    });
    expect(replay.id).toBe(first.id);

    await expect(
      testHarness.stripeSdk.paymentIntents.create(
        { ...params, amount: 43000 },
        { idempotencyKey: 'stripe-same-body-key' },
      ),
    ).rejects.toThrow();
    expect((await testHarness.stripeSdk.paymentIntents.retrieve(first.id)).amount).toBe(42000);
  });

  it('sends supplier search, offer, service, order, retrieve, and cancellation over Duffel transports', async () => {
    const testHarness = currentHarness();
    const offerId = await supplierOfferId(testHarness);
    const firstOrder = await createSupplierOrder(
      testHarness,
      offerId,
      'supplier-booking-one',
    );
    const secondOrder = await createSupplierOrder(
      testHarness,
      offerId,
      'supplier-booking-two',
    );
    expect(secondOrder.orderId).not.toBe(firstOrder.orderId);

    const retrieved = await testHarness.fulfillmentGateway.retrieveOrderSnapshot(
      firstOrder.orderId,
      { id: firstOrder.orderId },
      [],
      'traveler@example.test',
      invocationControl,
    );
    expect(retrieved.flightSnapshot.segments).toHaveLength(1);

    const cancellation = await testHarness.fulfillmentGateway.cancelOrder(
      firstOrder.orderId,
      invocationControl,
    );
    expect(cancellation).toMatchObject({ success: true, orderId: firstOrder.orderId });

    const supplierLedger = requireLedger<Extract<RedactedLedger, { provider: 'DUFFEL' }>>(
      await testHarness.supplier.inspect(runId),
      'DUFFEL',
    );
    expect(supplierLedger.orders).toHaveLength(2);
    expect(supplierLedger.orders[0]).toMatchObject({
      id: firstOrder.orderId,
      balanceAmount: '137.25',
      balanceCurrency: 'EUR',
      serviceIds: ['svc_bag_1'],
    });
    expect(supplierLedger.orders[0].status).toBe('CANCELLED');
    expect(supplierLedger.sideEffectCount).toBeGreaterThanOrEqual(3);

    const stripeLedger = requireLedger<Extract<RedactedLedger, { provider: 'STRIPE' }>>(
      await testHarness.stripe.inspect(runId),
      'STRIPE',
    );
    expect(stripeLedger.paymentIntents[0]).toMatchObject({
      amount: 42000,
      currency: 'usd',
    });
    expect(supplierLedger.orders[0].balanceAmount).not.toBe(
      String(stripeLedger.paymentIntents[0].amount),
    );
    expect(supplierLedger.orders[0].balanceCurrency).not.toBe(
      stripeLedger.paymentIntents[0].currency.toUpperCase(),
    );
  });

  it('does not deduplicate supplier creates by an idempotency header', async () => {
    const testHarness = currentHarness();
    const offerId = await supplierOfferId(testHarness);
    const firstOrder = await createSupplierOrder(
      testHarness,
      offerId,
      'supplier-same-key-booking',
    );
    const repeatedOrder = await createSupplierOrder(
      testHarness,
      offerId,
      'supplier-same-key-booking',
    );
    expect(repeatedOrder.orderId).not.toBe(firstOrder.orderId);
  });

  it('releases recorded Stripe events in an explicitly selected order', async () => {
    const testHarness = currentHarness();
    const created = await testHarness.stripeService.createPaymentIntent(
      6000,
      'usd',
      undefined,
      { bookingIntentId: 'reordered-events-booking' },
      'reordered-events-create',
      'pm_card_visa',
    );
    await testHarness.stripeSdk.paymentIntents.confirm(created.id);
    await testHarness.paymentGateway.capturePayment(
      created.id,
      'reordered-events-capture',
      invocationControl,
    );

    const ledger = requireLedger<Extract<RedactedLedger, { provider: 'STRIPE' }>>(
      await testHarness.stripe.inspect(runId),
      'STRIPE',
    );
    const count = ledger.pendingEventIds.length;
    const authorizationEventId = ledger.pendingEventIds[count - 2];
    const captureEventId = ledger.pendingEventIds[count - 1];
    if (!authorizationEventId || !captureEventId) {
      throw new Error('Stripe authorization and capture events were not recorded');
    }

    const captureEvent = await testHarness.stripe.releaseEvent(runId, captureEventId);
    const authorizationEvent = await testHarness.stripe.releaseEvent(runId, authorizationEventId);
    expect(
      testHarness.stripeSdk.webhooks.constructEvent(
        captureEvent.body,
        captureEvent.signature,
        testHarness.stripe.webhookSecret,
      ).type,
    ).toBe('payment_intent.succeeded');
    expect(
      testHarness.stripeSdk.webhooks.constructEvent(
        authorizationEvent.body,
        authorizationEvent.signature,
        testHarness.stripe.webhookSecret,
      ).type,
    ).toBe('payment_intent.amount_capturable_updated');
  });
  it('holds Stripe and supplier responses until the driver releases them in order', async () => {
    const testHarness = currentHarness();
    const offerId = await supplierOfferId(testHarness);
    await testHarness.stripe.selectFault(runId, {
      provider: 'STRIPE',
      purpose: 'PAYMENT_INTENT_CREATE',
      bookingIntentId: 'held-stripe-booking',
      outcome: 'HELD_LATE_RESPONSE',
    });
    await testHarness.supplier.selectFault(runId, {
      provider: 'DUFFEL',
      purpose: 'ORDER_CREATE',
      bookingIntentId: 'held-supplier-booking',
      outcome: 'HELD_LATE_RESPONSE',
    });

    const stripeResponseIdPromise = testHarness.stripe.waitForHeldResponse(
      runId,
      'held-stripe-booking',
    );
    const supplierResponseIdPromise = testHarness.supplier.waitForHeldResponse(
      runId,
      'held-supplier-booking',
    );
    let stripeSettled = false;
    const pendingPayment = testHarness.stripeService
      .createPaymentIntent(
        25000,
        'usd',
        undefined,
        { bookingIntentId: 'held-stripe-booking' },
        'held-stripe-key',
        'pm_card_visa',
      )
      .then((payment) => {
        stripeSettled = true;
        return payment;
      });
    const pendingOrder = createSupplierOrder(
      testHarness,
      offerId,
      'held-supplier-booking',
    );
    const [stripeResponseId, supplierResponseId] = await Promise.all([
      stripeResponseIdPromise,
      supplierResponseIdPromise,
    ]);

    await testHarness.supplier.releaseResponse(runId, supplierResponseId);
    const order = await pendingOrder;
    expect(order.orderId).toBeTruthy();
    expect(stripeSettled).toBe(false);

    await testHarness.stripe.releaseResponse(runId, stripeResponseId);
    expect((await pendingPayment).amount).toBe(25000);
  });

  it('releases only recorded, signed Stripe events and hides simulator controls from provider routes', async () => {
    const testHarness = currentHarness();
    const created = await testHarness.stripeService.createPaymentIntent(
      12000,
      'usd',
      undefined,
      { bookingIntentId: 'event-order-booking' },
      'event-order-create',
      'pm_card_visa',
    );
    await testHarness.stripeSdk.paymentIntents.confirm(created.id);
    await testHarness.paymentGateway.capturePayment(
      created.id,
      'event-order-capture',
      invocationControl,
    );

    const ledger = requireLedger<Extract<RedactedLedger, { provider: 'STRIPE' }>>(
      await testHarness.stripe.inspect(runId),
      'STRIPE',
    );
    expect(ledger.pendingEventIds.length).toBeGreaterThan(0);
    const eventId = ledger.pendingEventIds[ledger.pendingEventIds.length - 1];
    if (eventId === undefined) {
      throw new Error('Stripe event ledger was empty');
    }
    const releasedEvent = await testHarness.stripe.releaseEvent(runId, eventId);
    const event = testHarness.stripeSdk.webhooks.constructEvent(
      releasedEvent.body,
      releasedEvent.signature,
      testHarness.stripe.webhookSecret,
    );
    expect(event.id).toBe(eventId);
    expect(event.type).toBe('payment_intent.succeeded');

    const ledgerRoute = await fetch(testHarness.stripe.origin + '/driver/ledger');
    const controlRoute = await fetch(testHarness.supplier.origin + '/driver/runs/' + runId);
    expect(ledgerRoute.status).toBe(404);
    expect(controlRoute.status).toBe(404);
    expect(testHarness.stripe.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect(testHarness.supplier.origin).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it('rejects cross-run inspection and invalid application credentials', async () => {
    const testHarness = currentHarness();
    await expect(testHarness.stripe.inspect('another-run')).rejects.toThrow();
    await expect(testHarness.supplier.inspect('another-run')).rejects.toThrow();

    const stripeResponse = await fetch(testHarness.stripe.origin + '/v1/payment_intents', {
      headers: { Authorization: 'Bearer sk_test_wrong_run' },
    });
    const supplierResponse = await fetch(testHarness.supplier.origin + '/air/orders', {
      headers: { Authorization: 'Bearer duffel_test_wrong_run' },
    });
    expect(stripeResponse.status).toBe(401);
    expect(supplierResponse.status).toBe(401);
  });
});