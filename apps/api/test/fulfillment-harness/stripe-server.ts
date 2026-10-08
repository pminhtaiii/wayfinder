import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { assertSupportedFaultSelection } from './scenarios';
import type {
  ProviderOperationPurpose,
  SignedWebhookFixture,
  SimulatorFaultSelection,
  StripeLedgerSummary,
  StripeSimulator,
} from './simulator-types';

type StartStripeServerOptions = { runId: string };
type StripeIntent = {
  id: string;
  amount: number;
  currency: string;
  capture_method: 'manual';
  amount_capturable: number;
  amount_received: number;
  status: string;
  payment_method: string | null;
  metadata: Record<string, string>;
  created: number;
};
type IdempotentCreate = { fingerprint: string; intentId: string };
type HeldResponse = {
  bookingIntentId: string;
  release: () => void;
  cancel: () => void;
};
type ResponseWaiter = {
  resolve: (responseId: string) => void;
  reject: (error: Error) => void;
};
type StripeEventRecord = SignedWebhookFixture;


function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(value);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function stripeError(
  response: ServerResponse,
  status: number,
  type: string,
  message: string,
  code?: string,
): void {
  sendJson(response, status, { error: { type, message, ...(code ? { code } : {}) } });
}

function id(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, '');
}

function parseMetadata(form: URLSearchParams): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    const match = /^metadata\[([^\]]+)\]$/.exec(key);
    const field = match?.[1];
    if (field) metadata[field] = value;
  }
  return metadata;
}

function intentResponse(intent: StripeIntent): Record<string, unknown> {
  return {
    id: intent.id,
    object: 'payment_intent',
    amount: intent.amount,
    amount_capturable: intent.amount_capturable,
    amount_received: intent.amount_received,
    capture_method: intent.capture_method,
    client_secret: intent.id + '_secret_simulated',
    confirmation_method: 'automatic',
    created: intent.created,
    currency: intent.currency,
    livemode: false,
    metadata: intent.metadata,
    payment_method: intent.payment_method,
    status: intent.status,
  };
}

export async function startStripeServer(
  options: StartStripeServerOptions,
): Promise<StripeSimulator> {
  const runId = options.runId.trim();
  if (!runId) throw new Error('simulator run ID is required');

  const applicationCredential = 'sk_test_sim_' + randomUUID().replace(/-/g, '');
  const publishableKey = 'pk_test_sim_' + randomUUID().replace(/-/g, '');
  const webhookSecret = 'whsec_test_sim_' + randomUUID().replace(/-/g, '');
  const intents = new Map<string, StripeIntent>();
  const refunds = new Map<string, { id: string; paymentIntentId: string; amount: number; status: string }>();
  const idempotency = new Map<string, IdempotentCreate>();
  const faults: SimulatorFaultSelection[] = [];
  const heldResponses = new Map<string, HeldResponse>();
  const responseWaiters = new Map<string, ResponseWaiter[]>();
  const events = new Map<string, StripeEventRecord>();
  let requestsReceived = 0;
  let sideEffectCount = 0;
  let origin = '';
  let closed = false;

  function assertRun(requestedRunId: string): void {
    if (requestedRunId !== runId) throw new Error('simulator run mismatch');
    if (closed) throw new Error('simulator is closed');
  }

  function consumeFault(
    purpose: ProviderOperationPurpose,
    bookingIntentId: string | null,
  ): SimulatorFaultSelection | undefined {
    if (!bookingIntentId) return undefined;
    const index = faults.findIndex(
      (fault) => fault.purpose === purpose && fault.bookingIntentId === bookingIntentId,
    );
    if (index < 0) return undefined;
    const selected = faults[index];
    if (!selected) return undefined;
    faults.splice(index, 1);
    return selected;
  }

  function notifyHeldResponse(responseId: string, bookingIntentId: string): void {
    const waiters = responseWaiters.get(bookingIntentId);
    const waiter = waiters?.shift();
    if (!waiter) return;
    if (waiters?.length === 0) responseWaiters.delete(bookingIntentId);
    waiter.resolve(responseId);
  }

  async function respondOrHold(
    response: ServerResponse,
    status: number,
    body: unknown,
    fault: SimulatorFaultSelection | undefined,
  ): Promise<void> {
    if (fault?.outcome !== 'HELD_LATE_RESPONSE') {
      sendJson(response, status, body);
      return;
    }

    const responseId = id('resp_');
    let finishGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      finishGate = resolve;
    });
    const held: HeldResponse = {
      bookingIntentId: fault.bookingIntentId,
      release: () => {
        sendJson(response, status, body);
        finishGate();
      },
      cancel: () => {
        if (!response.destroyed) response.destroy();
        finishGate();
      },
    };
    heldResponses.set(responseId, held);
    notifyHeldResponse(responseId, fault.bookingIntentId);
    await gate;
    heldResponses.delete(responseId);
  }

  function recordEvent(eventType: string, intent: StripeIntent): void {
    const eventId = id('evt_');
    const timestamp = Math.floor(Date.now() / 1000);
    const eventBody = JSON.stringify({
      id: eventId,
      object: 'event',
      api_version: '2026-05-27.dahlia',
      created: timestamp,
      data: { object: intentResponse(intent) },
      livemode: false,
      pending_webhooks: 1,
      type: eventType,
    });
    const digest = createHmac('sha256', webhookSecret)
      .update(timestamp + '.' + eventBody)
      .digest('hex');
    events.set(eventId, {
      eventId,
      body: eventBody,
      signature: 't=' + timestamp + ',v1=' + digest,
    });
  }

  function findIntent(intentId: string, response: ServerResponse): StripeIntent | undefined {
    const intent = intents.get(intentId);
    if (!intent) {
      stripeError(response, 404, 'invalid_request_error', 'No such payment_intent: ' + intentId, 'resource_missing');
    }
    return intent;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!path.startsWith('/v1/')) {
      stripeError(response, 404, 'invalid_request_error', 'Unrecognized request URL');
      return;
    }

    requestsReceived += 1;
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || authorization !== 'Bearer ' + applicationCredential) {
      stripeError(response, 401, 'authentication_error', 'Invalid API key provided');
      return;
    }

    if (request.method === 'POST' && path === '/v1/payment_intents') {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      const amount = Number(form.get('amount'));
      const currency = form.get('currency')?.toLowerCase();
      const captureMethod = form.get('capture_method') ?? 'automatic';
      if (!Number.isInteger(amount) || amount < 1 || !currency) {
        stripeError(response, 400, 'invalid_request_error', 'Invalid payment intent parameters');
        return;
      }
      if (captureMethod !== 'manual') {
        stripeError(response, 400, 'invalid_request_error', 'Only manual capture is supported');
        return;
      }

      const entries = Array.from(form.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
      );
      const fingerprint = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
      const idempotencyKey = request.headers['idempotency-key'];
      const key = typeof idempotencyKey === 'string' ? idempotencyKey : undefined;
      const existing = key ? idempotency.get(key) : undefined;
      if (existing && existing.fingerprint !== fingerprint) {
        stripeError(response, 400, 'idempotency_error', 'Idempotency key reused with different parameters');
        return;
      }

      const metadata = parseMetadata(form);
      const bookingIntentId = metadata.bookingIntentId ?? null;
      const fault = consumeFault('PAYMENT_INTENT_CREATE', bookingIntentId);
      if (fault?.outcome === 'DEFINITIVE_REJECTION') {
        stripeError(response, 402, 'card_error', 'Payment method was declined', 'card_declined');
        return;
      }
      if (fault?.outcome === 'NO_CREATE_LOST_RESPONSE') {
        response.destroy();
        return;
      }

      let intent = existing ? intents.get(existing.intentId) : undefined;
      if (!intent) {
        const paymentMethod = form.get('payment_method');
        intent = {
          id: id('pi_'),
          amount,
          currency,
          capture_method: 'manual',
          amount_capturable: 0,
          amount_received: 0,
          status: fault?.outcome === 'PROCESSING'
            ? 'processing'
            : paymentMethod ? 'requires_confirmation' : 'requires_payment_method',
          payment_method: paymentMethod,
          metadata,
          created: Math.floor(Date.now() / 1000),
        };
        intents.set(intent.id, intent);
        if (key) idempotency.set(key, { fingerprint, intentId: intent.id });
        sideEffectCount += 1;
      }

      if (fault?.outcome === 'CREATE_COMMITTED_LOST_RESPONSE') {
        response.destroy();
        return;
      }
      await respondOrHold(response, 200, intentResponse(intent), fault);
      return;
    }

    const intentPath = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && intentPath?.[1]) {
      const intent = findIntent(decodeURIComponent(intentPath[1]), response);
      if (!intent) return;
      const fault = consumeFault('RECONCILE', intent.metadata.bookingIntentId ?? null);
      if (fault?.outcome === 'UNAVAILABLE') {
        stripeError(response, 503, 'api_error', 'Provider temporarily unavailable');
      } else if (fault?.outcome === 'RATE_LIMITED') {
        response.setHeader('Retry-After', '1');
        stripeError(response, 429, 'rate_limit_error', 'Rate limit exceeded');
      } else if (fault?.outcome === 'PROCESSING') {
        sendJson(response, 200, { ...intentResponse(intent), status: 'processing' });
      } else {
        sendJson(response, 200, intentResponse(intent));
      }
      return;
    }

    const intentActionPath = /^\/v1\/payment_intents\/([^/]+)\/(confirm|capture|cancel)$/.exec(path);
    if (request.method === 'POST' && intentActionPath?.[1] && intentActionPath[2]) {
      const intentId = decodeURIComponent(intentActionPath[1]);
      const action = intentActionPath[2];
      const intent = findIntent(intentId, response);
      if (!intent) return;
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      const purpose: ProviderOperationPurpose =
        action === 'confirm' ? 'AUTHORIZATION' : action === 'capture' ? 'CAPTURE' : 'AUTHORIZATION_RELEASE';
      const fault = consumeFault(purpose, intent.metadata.bookingIntentId ?? null);
      if (fault?.outcome === 'DEFINITIVE_REJECTION') {
        stripeError(response, 402, 'card_error', 'Provider declined the operation', 'card_declined');
        return;
      }
      if (fault?.outcome === 'UNAVAILABLE') {
        stripeError(response, 503, 'api_error', 'Provider temporarily unavailable');
        return;
      }
      if (fault?.outcome === 'UNCOMMITTED_LOST_RESPONSE') {
        response.destroy();
        return;
      }
      const processing = fault?.outcome === 'PROCESSING';

      if (action === 'confirm') {
        if (intent.status !== 'requires_confirmation' && intent.status !== 'requires_payment_method') {
          stripeError(response, 400, 'invalid_request_error', 'Payment intent cannot be confirmed');
          return;
        }
        if (!intent.payment_method && form.get('payment_method')) {
          intent.payment_method = form.get('payment_method');
        }
        intent.status = processing ? 'processing' : 'requires_capture';
        intent.amount_capturable = processing ? 0 : intent.amount;
        sideEffectCount += 1;
        recordEvent(processing ? 'payment_intent.processing' : 'payment_intent.amount_capturable_updated', intent);
      } else if (action === 'capture') {
        if (intent.status !== 'requires_capture') {
          stripeError(response, 400, 'invalid_request_error', 'Payment intent is not capturable');
          return;
        }
        const requestedAmount = form.get('amount_to_capture');
        const capturedAmount = requestedAmount ? Number(requestedAmount) : intent.amount;
        if (!Number.isInteger(capturedAmount) || capturedAmount < 1 || capturedAmount > intent.amount) {
          stripeError(response, 400, 'invalid_request_error', 'Invalid capture amount');
          return;
        }
        intent.status = processing ? 'processing' : 'succeeded';
        intent.amount_capturable = 0;
        intent.amount_received = processing ? 0 : capturedAmount;
        sideEffectCount += 1;
        recordEvent(processing ? 'payment_intent.processing' : 'payment_intent.succeeded', intent);
      } else {
        if (intent.status !== 'requires_capture' && intent.status !== 'requires_confirmation') {
          stripeError(response, 400, 'invalid_request_error', 'Payment intent cannot be canceled');
          return;
        }
        intent.status = processing ? 'processing' : 'canceled';
        intent.amount_capturable = 0;
        sideEffectCount += 1;
        recordEvent(processing ? 'payment_intent.processing' : 'payment_intent.canceled', intent);
      }

      if (fault?.outcome === 'CREATE_COMMITTED_LOST_RESPONSE') {
        response.destroy();
        return;
      }
      await respondOrHold(response, 200, intentResponse(intent), fault);
      return;
    }

    if (request.method === 'POST' && path === '/v1/refunds') {
      const body = await readBody(request);
      const form = new URLSearchParams(body);
      const paymentIntentId = form.get('payment_intent');
      if (!paymentIntentId) {
        stripeError(response, 400, 'invalid_request_error', 'payment_intent is required');
        return;
      }
      const intent = intents.get(paymentIntentId);
      if (!intent || intent.status !== 'succeeded') {
        stripeError(response, 400, 'invalid_request_error', 'Payment intent is not refundable');
        return;
      }
      const refundAmount = form.get('amount') ? Number(form.get('amount')) : intent.amount_received;
      if (!Number.isInteger(refundAmount) || refundAmount < 1 || refundAmount > intent.amount_received) {
        stripeError(response, 400, 'invalid_request_error', 'Invalid refund amount');
        return;
      }
      const fault = consumeFault('REFUND', intent.metadata.bookingIntentId ?? null);
      if (fault?.outcome === 'DEFINITIVE_REJECTION') {
        stripeError(response, 402, 'card_error', 'Provider declined the refund', 'card_declined');
        return;
      }
      if (fault?.outcome === 'UNAVAILABLE') {
        stripeError(response, 503, 'api_error', 'Provider temporarily unavailable');
        return;
      }
      const refund = {
        id: id('re_'),
        paymentIntentId,
        amount: refundAmount,
        status: fault?.outcome === 'PROCESSING' ? 'pending' : 'succeeded',
      };
      refunds.set(refund.id, refund);
      sideEffectCount += 1;
      await respondOrHold(response, 200, {
        id: refund.id,
        object: 'refund',
        amount: refund.amount,
        currency: intent.currency,
        payment_intent: refund.paymentIntentId,
        status: refund.status,
      }, fault);
      return;
    }

    stripeError(response, 404, 'invalid_request_error', 'Unrecognized request URL');
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
      } else {
        stripeError(response, 500, 'api_error', 'Simulator request failed');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('simulator failed to bind a TCP port');
  }
  origin = 'http://127.0.0.1:' + address.port;

  const simulator: StripeSimulator = {
    runId,
    origin,
    applicationCredential,
    publishableKey,
    webhookSecret,
    inspect: async (requestedRunId: string): Promise<StripeLedgerSummary> => {
      assertRun(requestedRunId);
      const pendingIntents = Array.from(intents.values()).map((intent) => ({
        id: intent.id,
        amount: intent.amount,
        currency: intent.currency,
        captureMethod: intent.capture_method,
        status: intent.status,
      }));
      const pendingRefunds = Array.from(refunds.values()).map((refund) => ({ ...refund }));
      return {
        provider: 'STRIPE',
        paymentIntents: pendingIntents,
        refunds: pendingRefunds,
        requestsReceived,
        sideEffectCount,
        pendingEventIds: Array.from(events.keys()),
        pendingResponseIds: Array.from(heldResponses.keys()),
      };
    },
    selectFault: async (requestedRunId: string, input: SimulatorFaultSelection): Promise<void> => {
      assertRun(requestedRunId);
      if (input.provider !== 'STRIPE') throw new Error('fault provider does not match simulator');
      assertSupportedFaultSelection(input);
      faults.push({ ...input });
    },
    waitForHeldResponse: async (requestedRunId: string, bookingIntentId: string): Promise<string> => {
      assertRun(requestedRunId);
      for (const [responseId, held] of heldResponses) {
        if (held.bookingIntentId === bookingIntentId) return responseId;
      }
      return new Promise<string>((resolve, reject) => {
        const waiters = responseWaiters.get(bookingIntentId) ?? [];
        waiters.push({ resolve, reject });
        responseWaiters.set(bookingIntentId, waiters);
      });
    },
    releaseResponse: async (requestedRunId: string, responseId: string): Promise<void> => {
      assertRun(requestedRunId);
      const held = heldResponses.get(responseId);
      if (!held) throw new Error('held response was not found');
      heldResponses.delete(responseId);
      held.release();
    },
    releaseEvent: async (requestedRunId: string, eventId: string): Promise<SignedWebhookFixture> => {
      assertRun(requestedRunId);
      const event = events.get(eventId);
      if (!event) throw new Error('Stripe event was not found in this run');
      return { ...event };
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      for (const [responseId, held] of heldResponses) {
        heldResponses.delete(responseId);
        held.cancel();
      }
      for (const waiters of responseWaiters.values()) {
        for (const waiter of waiters) waiter.reject(new Error('simulator closed'));
      }
      responseWaiters.clear();
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };

  return simulator;
}