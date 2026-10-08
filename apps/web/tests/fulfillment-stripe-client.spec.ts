import { createServer, type IncomingMessage } from 'node:http';
import { expect, test } from '@playwright/test';
import { installFulfillmentStripeClient } from './fixtures/fulfillment-stripe-client';

type StripeError = { message: string };
type StripePaymentIntent = { id: string; status: string };
type StripeCardElement = {
  mount(target: string): void;
  unmount(): void;
  destroy(): void;
};
type StripeTokenResult = { token?: { id: string }; error?: StripeError };
type StripePaymentResult = { paymentIntent?: StripePaymentIntent; error?: StripeError };
type StripeClient = {
  elements(): { create(type: 'card'): StripeCardElement };
  createToken(card: StripeCardElement): Promise<StripeTokenResult>;
  confirmCardPayment(
    clientSecret: string,
    options: { payment_method: { card: { number: string } } },
  ): Promise<StripePaymentResult>;
  retrievePaymentIntent(clientSecret: string): Promise<StripePaymentResult>;
  redirectToCheckout(options: { sessionId: string }): Promise<{ error?: StripeError }>;
};

declare global {
  interface Window {
    Stripe: (publishableKey: string) => StripeClient;
  }
}

type StripeStub = {
  origin: string;
  requests: string[];
  traces: string[];
  close(): Promise<void>;
};

async function readRequestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (typeof chunk === 'string') {
        chunks.push(Buffer.from(chunk));
      }
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function startStripeStub(status: 'requires_capture' | 'processing'): Promise<StripeStub> {
  const requests: string[] = [];
  const traces: string[] = [];
  const server = createServer((request, response) => {
    void readRequestBody(request)
      .then((body) => {
        const method = request.method ?? '';
        const url = request.url ?? '';
        traces.push([method, url, body].join(' '));
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        if (method === 'OPTIONS') {
          response.statusCode = 204;
          response.end();
          return;
        }
        if (method === 'GET' && url === '/') {
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end('<!doctype html><html><body></body></html>');
          return;
        }
        if (method !== 'POST' || (url !== '/v1/payment_intents/confirm' && url !== '/v1/payment_intents/retrieve')) {
          response.statusCode = 404;
          response.end('{}');
          return;
        }
        requests.push(body);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ id: 'pi_fixture_1', status }));
      })
      .catch(() => {
        response.statusCode = 500;
        response.end('{}');
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error('Stripe fixture stub did not bind to a TCP address');
  }

  return {
    origin: 'http://127.0.0.1:' + address.port,
    requests,
    traces,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('keeps PAN in the Stripe shim and sends tokenized requests', async ({ page }) => {
  const stub = await startStripeStub('requires_capture');
  const browserTrace: string[] = [];
  const rawPan = '4242424242424242';
  const driverToken = 'driver_token_fixture_only';
  page.on('request', (request) => {
    browserTrace.push([request.method(), request.url(), request.postData() ?? ''].join(' '));
  });

  try {
    // A loopback page gives browser requests to the stub a secure context.
    await page.goto(stub.origin);
    await page.setContent('<main id="checkout"></main>');
    await installFulfillmentStripeClient(page, stub.origin, 'pk_test_feature030');
    const result = await page.evaluate(async () => {
      const stripe = window.Stripe('pk_test_feature030');
      const card = stripe.elements().create('card');
      card.mount('#checkout');
      const tokenized = await stripe.createToken(card);
      const confirmed = await stripe.confirmCardPayment('pi_fixture_1_secret_fixture', {
        payment_method: { card: { number: '4242424242424242' } },
      });
      const retrieved = await stripe.retrievePaymentIntent('pi_fixture_1_secret_fixture');
      const redirect = await stripe.redirectToCheckout({ sessionId: 'cs_fixture_1' });
      return {
        tokenId: tokenized.token?.id,
        confirmedStatus: confirmed.paymentIntent?.status,
        retrievedStatus: retrieved.paymentIntent?.status,
        redirectError: redirect.error?.message,
      };
    });

    expect(result).toEqual({
      tokenId: 'tok_fixture_1',
      confirmedStatus: 'requires_capture',
      retrievedStatus: 'requires_capture',
      redirectError: undefined,
    });
    expect(stub.requests).toEqual([
      '{"payment_method":"tok_fixture_1"}',
      '{"payment_intent_id":"pi_fixture_1"}',
    ]);
    const trace = [stub.requests.join('\n'), stub.traces.join('\n'), browserTrace.join('\n')].join('\n');
    expect(trace).not.toContain(rawPan);
    expect(trace).not.toContain(driverToken);
  } finally {
    await stub.close();
  }
});

test('surfaces a pending status from the Stripe shim', async ({ page }) => {
  const stub = await startStripeStub('processing');
  try {
    // A loopback page gives browser requests to the stub a secure context.
    await page.goto(stub.origin);
    await page.setContent('<main id="checkout"></main>');
    await installFulfillmentStripeClient(page, stub.origin, 'pk_test_feature030');
    const result = await page.evaluate(async () => {
      const stripe = window.Stripe('pk_test_feature030');
      return stripe.retrievePaymentIntent('pi_fixture_1_secret_fixture');
    });

    expect(result.paymentIntent?.status).toBe('processing');
    expect(stub.requests).toEqual(['{"payment_intent_id":"pi_fixture_1"}']);
  } finally {
    await stub.close();
  }
});
