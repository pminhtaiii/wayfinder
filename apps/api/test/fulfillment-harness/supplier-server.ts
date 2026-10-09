import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { assertSupportedFaultSelection } from './scenarios';
import type {
  ProviderOperationPurpose,
  SimulatorFaultSelection,
  SupplierLedgerSummary,
  SupplierSimulator,
  SupplierOrderSummary,
} from './simulator-types';

type StartSupplierServerOptions = {
  runId: string;
  balanceAmount: string;
  balanceCurrency: string;
};
type SupplierOffer = {
  id: string;
  data: Record<string, unknown>;
};
type SupplierOrder = {
  summary: SupplierOrderSummary;
  data: Record<string, unknown>;
  bookingIntentId: string | null;
  userIds: string[];
};
type CancellationQuote = {
  id: string;
  orderId: string;
};
type HeldResponse = {
  bookingIntentId: string;
  release: () => void;
  cancel: () => void;
};
type ResponseWaiter = {
  resolve: (responseId: string) => void;
  reject: (error: Error) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function requireRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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

function readJsonRecord(body: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

function id(prefix: string): string {
  return prefix + randomUUID().replace(/-/g, '');
}

function responseData(data: Record<string, unknown>): Record<string, unknown> {
  return { data };
}

function sendDuffelError(
  response: ServerResponse,
  status: number,
  code: string,
  title: string,
  type: string,
): void {
  sendJson(response, status, {
    errors: [{
      code,
      documentation_url: 'https://duffel.com/docs/api/overview/errors',
      message: title,
      title,
      type,
    }],
  });
}

export async function startSupplierServer(
  options: StartSupplierServerOptions,
): Promise<SupplierSimulator> {
  const runId = options.runId.trim();
  if (!runId) throw new Error('simulator run ID is required');
  if (!/^\d+(\.\d{1,2})?$/.test(options.balanceAmount)) {
    throw new Error('supplier balance amount is invalid');
  }
  if (!/^[A-Z]{3}$/.test(options.balanceCurrency)) {
    throw new Error('supplier balance currency is invalid');
  }

  const applicationCredential = 'duffel_test_sim_' + randomUUID().replace(/-/g, '');
  const offers = new Map<string, SupplierOffer>();
  const orders = new Map<string, SupplierOrder>();
  const cancellations = new Map<string, CancellationQuote>();
  const faults: SimulatorFaultSelection[] = [];
  const heldResponses = new Map<string, HeldResponse>();
  const responseWaiters = new Map<string, ResponseWaiter[]>();
  let requestsReceived = 0;
  let sideEffectCount = 0;
  let closed = false;

  function assertRun(requestedRunId: string): void {
    if (requestedRunId !== runId) throw new Error('simulator run mismatch');
    if (closed) throw new Error('simulator is closed');
  }

  function consumeFault(
    purpose: ProviderOperationPurpose,
    bookingIntentId: string | null,
    outcomes?: readonly SimulatorFaultSelection['outcome'][],
  ): SimulatorFaultSelection | undefined {
    if (!bookingIntentId) return undefined;
    const index = faults.findIndex(
      (fault) => fault.purpose === purpose && fault.bookingIntentId === bookingIntentId &&
        (!outcomes || outcomes.includes(fault.outcome)),
    );
    if (index < 0) return undefined;
    const selected = faults[index];
    if (!selected) return undefined;
    faults.splice(index, 1);
    return selected;
  }

  function consumeListFault(candidates: SupplierOrder[]): SimulatorFaultSelection | undefined {
    const outcomes: readonly SimulatorFaultSelection['outcome'][] = [
      'UNAVAILABLE', 'RATE_LIMITED', 'ZERO_CANDIDATES', 'MULTIPLE_CANDIDATES', 'UNLINKED_CANDIDATE',
    ];
    const index = faults.findIndex(
      (fault) => fault.purpose === 'RECONCILE' &&
        outcomes.includes(fault.outcome) &&
        candidates.some((order) => order.bookingIntentId === fault.bookingIntentId),
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

  function airport(iataCode: string): Record<string, unknown> {
    return {
      id: 'arp_' + iataCode.toLowerCase(),
      type: 'airport',
      iata_code: iataCode,
      name: iataCode + ' International Airport',
      city_name: iataCode,
    };
  }

  function offerFor(originCode: string, destinationCode: string, departureDate: string): SupplierOffer {
    const offerId = id('off_');
    const passengerId = id('pas_');
    const originAirport = airport(originCode);
    const destinationAirport = airport(destinationCode);
    const departureAt = departureDate + 'T12:00:00';
    const arrivalAt = departureDate + 'T20:00:00';
    const segment = {
      id: id('seg_'),
      departing_at: departureAt,
      arriving_at: arrivalAt,
      duration: 'PT8H',
      origin: originAirport,
      destination: destinationAirport,
      operating_carrier: { id: 'arl_test', name: 'Test Air', iata_code: 'TA' },
      marketing_carrier: { id: 'arl_test', name: 'Test Air', iata_code: 'TA' },
      marketing_carrier_flight_number: '100',
      aircraft: { id: 'arc_test', name: 'Airbus A320', iata_code: '320' },
      passengers: [{ passenger_id: passengerId, cabin_class: 'economy' }],
    };
    const slice = {
      id: id('sli_'),
      origin: originAirport,
      destination: destinationAirport,
      duration: 'PT8H',
      segments: [segment],
    };
    const data: Record<string, unknown> = {
      id: offerId,
      type: 'flight_offer',
      total_amount: options.balanceAmount,
      total_currency: options.balanceCurrency,
      base_amount: options.balanceAmount,
      base_currency: options.balanceCurrency,
      tax_amount: '0.00',
      tax_currency: options.balanceCurrency,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      owner: { id: 'own_test', name: 'Test Air', iata_code: 'TA' },
      slices: [slice],
      passengers: [{ id: passengerId, type: 'adult' }],
      conditions: {
        refund_before_departure: { allowed: true, penalty_amount: '0.00', penalty_currency: options.balanceCurrency },
        change_before_departure: { allowed: true, penalty_amount: '0.00', penalty_currency: options.balanceCurrency },
      },
      available_services: [
        {
          id: 'svc_bag_1',
          type: 'baggage',
          total_amount: '0.00',
          total_currency: options.balanceCurrency,
          maximum_quantity: 1,
        },
      ],
    };
    return { id: offerId, data };
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (!path.startsWith('/air/')) {
      sendJson(response, 404, { errors: [{ title: 'Not found' }] });
      return;
    }

    requestsReceived += 1;
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || authorization !== 'Bearer ' + applicationCredential) {
      sendJson(response, 401, { errors: [{ title: 'Unauthenticated' }] });
      return;
    }

    if (request.method === 'POST' && path === '/air/offer_requests') {
      const body = readJsonRecord(await readBody(request));
      const data = requireRecord(body?.data);
      const firstSlice = requireRecord(readArray(data?.slices)[0]);
      const originCode = stringField(firstSlice ?? {}, 'origin') ?? 'SFO';
      const destinationCode = stringField(firstSlice ?? {}, 'destination') ?? 'JFK';
      const departureDate = stringField(firstSlice ?? {}, 'departure_date') ?? '2027-04-15';
      const offer = offerFor(originCode, destinationCode, departureDate);
      offers.set(offer.id, offer);
      sideEffectCount += 1;
      const offerRequest = {
        id: id('orq_'),
        type: 'offer_request',
        created_at: new Date().toISOString(),
        live_mode: false,
        slices: data?.slices ?? [],
        passengers: data?.passengers ?? [],
        offers: [offer.data],
      };
      sendJson(response, 200, responseData(offerRequest));
      return;
    }

    const offerPath = /^\/air\/offers\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && offerPath?.[1]) {
      const offer = offers.get(decodeURIComponent(offerPath[1]));
      if (!offer) {
        sendJson(response, 404, { errors: [{ title: 'Offer not found' }] });
        return;
      }
      sendJson(response, 200, responseData(offer.data));
      return;
    }

    if (request.method === 'POST' && path === '/air/orders') {
      const body = readJsonRecord(await readBody(request));
      const data = requireRecord(body?.data);
      const selectedOffers = readArray(data?.selected_offers).filter(
        (value): value is string => typeof value === 'string',
      );
      const selectedOfferId = selectedOffers[0];
      const selectedOffer = selectedOfferId ? offers.get(selectedOfferId) : undefined;
      if (!data || !selectedOffer) {
        sendJson(response, 422, { errors: [{ title: 'Selected offer not found' }] });
        return;
      }

      const services = readArray(data.services)
        .map((value) => requireRecord(value))
        .filter((value): value is Record<string, unknown> => value !== undefined);
      const serviceIds = services
        .map((service) => stringField(service, 'id'))
        .filter((serviceId): serviceId is string => serviceId !== undefined);
      const requestedMetadata = requireRecord(data.metadata);
      const orderMetadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(requestedMetadata ?? {})) {
        if (typeof value === 'string') orderMetadata[key] = value;
      }
      const bookingIntentId = orderMetadata.bookingIntentId ?? null;
      const userIds = readArray(data.users).filter(
        (value): value is string => typeof value === 'string',
      );
      const fault = consumeFault('ORDER_CREATE', bookingIntentId);
      if (fault?.outcome === 'DEFINITIVE_REJECTION') {
        sendDuffelError(response, 422, 'invalid_order', 'Order creation was rejected', 'invalid_request_error');
        return;
      }
      if (fault?.outcome === 'NO_CREATE_LOST_RESPONSE') {
        response.destroy();
        return;
      }

      const orderId = id('ord_');
      const createdAt = new Date().toISOString();
      const orderData: Record<string, unknown> = {
        id: orderId,
        booking_reference: 'TEST' + randomUUID().slice(0, 8).toUpperCase(),
        created_at: createdAt,
        live_mode: false,
        total_amount: options.balanceAmount,
        total_currency: options.balanceCurrency,
        base_amount: options.balanceAmount,
        base_currency: options.balanceCurrency,
        tax_amount: '0.00',
        tax_currency: options.balanceCurrency,
        payment_status: { awaiting_payment: false },
        owner: selectedOffer.data.owner ?? { id: 'own_test', name: 'Test Air', iata_code: 'TA' },
        metadata: orderMetadata,
        available_actions: ['cancel', 'change', 'update'],
        conditions: selectedOffer.data.conditions ?? {},
        airline_initiated_changes: [],
        synced_at: createdAt,
        selected_offers: selectedOffers,
        services,
        slices: selectedOffer.data.slices,
        passengers: readArray(data.passengers),
        cancelled_at: null,
        cancellation: null,
      };
      const summary: SupplierOrderSummary = {
        id: orderId,
        balanceAmount: options.balanceAmount,
        balanceCurrency: options.balanceCurrency,
        status: fault?.outcome === 'PROCESSING' ? 'PROCESSING' : 'ACTIVE',
        serviceIds,
      };
      const order: SupplierOrder = { summary, data: orderData, bookingIntentId, userIds };
      orders.set(orderId, order);
      sideEffectCount += 1;
      if (fault?.outcome === 'CREATE_COMMITTED_LOST_RESPONSE') {
        response.destroy();
        return;
      }
      if (fault?.outcome === 'PROCESSING') {
        sendJson(response, 202, { meta: { status: 202 } });
        return;
      }
      await respondOrHold(response, 200, responseData(orderData), fault);
      return;
    }

    if (request.method === 'GET' && path === '/air/orders') {
      const bookingReference = url.searchParams.get('booking_reference');
      const passengerNames = url.searchParams.getAll('passenger_name[]').map((name) => name.toLowerCase());
      const userId = url.searchParams.get('user_id');
      const awaitingPayment = url.searchParams.get('awaiting_payment');
      const matchingOrders = Array.from(orders.values()).filter((order) => {
        if (bookingReference && order.data.booking_reference !== bookingReference) return false;
        if (userId && !order.userIds.includes(userId)) return false;
        if (awaitingPayment !== null) {
          const paymentStatus = requireRecord(order.data.payment_status);
          if (String(paymentStatus?.awaiting_payment) !== awaitingPayment) return false;
        }
        if (passengerNames.length > 0) {
          const passengers = readArray(order.data.passengers)
            .map((passenger) => requireRecord(passenger))
            .filter((passenger): passenger is Record<string, unknown> => passenger !== undefined);
          const matchesPassenger = passengers.some((passenger) => {
            const givenName = stringField(passenger, 'given_name')?.toLowerCase() ?? '';
            const familyName = stringField(passenger, 'family_name')?.toLowerCase() ?? '';
            const fullName = (givenName + ' ' + familyName).trim();
            return passengerNames.some((name) =>
              givenName.includes(name) || familyName.includes(name) || fullName.includes(name),
            );
          });
          if (!matchesPassenger) return false;
        }
        return true;
      });
      const fault = consumeListFault(matchingOrders);
      if (fault?.outcome === 'UNAVAILABLE') {
        sendDuffelError(response, 503, 'provider_unavailable', 'Provider temporarily unavailable', 'server_error');
        return;
      }
      if (fault?.outcome === 'RATE_LIMITED') {
        response.setHeader('Retry-After', '1');
        sendDuffelError(response, 429, 'rate_limited', 'Provider rate limit exceeded', 'rate_limit_error');
        return;
      }

      let candidateData = matchingOrders.map((order) => order.data);
      if (fault?.outcome === 'ZERO_CANDIDATES') {
        candidateData = [];
      } else if (fault?.outcome === 'MULTIPLE_CANDIDATES') {
        const first = matchingOrders.find((order) => order.bookingIntentId === fault.bookingIntentId);
        if (first) {
          const metadata = requireRecord(first.data.metadata) ?? {};
          candidateData = [
            first.data,
            {
              ...first.data,
              id: id('ord_'),
              booking_reference: 'TEST' + randomUUID().slice(0, 8).toUpperCase(),
              metadata: { ...metadata, bookingIntentId: 'ambiguous-candidate-fixture' },
            },
          ];
        }
      } else if (fault?.outcome === 'UNLINKED_CANDIDATE') {
        const first = matchingOrders.find((order) => order.bookingIntentId === fault.bookingIntentId);
        if (first) {
          const metadata = requireRecord(first.data.metadata) ?? {};
          candidateData = [{
            ...first.data,
            metadata: { ...metadata, bookingIntentId: 'unlinked-candidate-fixture' },
          }];
        }
      }

      const requestedLimit = Number(url.searchParams.get('limit') ?? '50');
      const limit = Number.isInteger(requestedLimit) && requestedLimit > 0 && requestedLimit <= 200
        ? requestedLimit
        : 50;
      const after = url.searchParams.get('after');
      const before = url.searchParams.get('before');
      let startIndex = 0;
      let endIndex = candidateData.length;
      if (after) {
        const cursorIndex = candidateData.findIndex((candidate) => stringField(candidate, 'id') === after);
        if (cursorIndex >= 0) startIndex = cursorIndex + 1;
      }
      if (before) {
        const cursorIndex = candidateData.findIndex((candidate) => stringField(candidate, 'id') === before);
        if (cursorIndex >= 0) endIndex = cursorIndex;
      }
      const window = candidateData.slice(startIndex, endIndex);
      const page = window.slice(0, limit);
      const last = page[page.length - 1];
      const hasMore = window.length > page.length;
      sendJson(response, 200, {
        data: page,
        meta: {
          limit,
          after: hasMore && last ? stringField(last, 'id') ?? null : null,
          ...(before ? { before } : {}),
        },
      });
      return;
    }

    const orderPath = /^\/air\/orders\/([^/]+)$/.exec(path);
    if (request.method === 'GET' && orderPath?.[1]) {
      const order = orders.get(decodeURIComponent(orderPath[1]));
      if (!order) {
        sendJson(response, 404, { errors: [{ title: 'Order not found' }] });
        return;
      }
      const fault = consumeFault('RECONCILE', order.bookingIntentId, ['PROCESSING', 'UNAVAILABLE', 'RATE_LIMITED']);
      if (fault?.outcome === 'UNAVAILABLE') {
        sendDuffelError(response, 503, 'provider_unavailable', 'Provider temporarily unavailable', 'server_error');
      } else if (fault?.outcome === 'RATE_LIMITED') {
        response.setHeader('Retry-After', '1');
        sendDuffelError(response, 429, 'rate_limited', 'Provider rate limit exceeded', 'rate_limit_error');
      } else {
        sendJson(response, 200, responseData(order.data));
      }
      return;
    }

    if (request.method === 'POST' && path === '/air/order_cancellations') {
      const body = readJsonRecord(await readBody(request));
      const data = requireRecord(body?.data);
      const orderId = stringField(data ?? {}, 'order_id');
      const order = orderId ? orders.get(orderId) : undefined;
      if (!order) {
        sendJson(response, 404, { errors: [{ title: 'Order not found' }] });
        return;
      }
      const cancellationId = id('can_');
      cancellations.set(cancellationId, { id: cancellationId, orderId: order.summary.id });
      sendJson(response, 200, responseData({
        id: cancellationId,
        order_id: orderId,
        refund_amount: options.balanceAmount,
        refund_currency: options.balanceCurrency,
        refundable: true,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }));
      return;
    }

    const confirmCancellationPath = /^\/air\/order_cancellations\/([^/]+)\/actions\/confirm$/.exec(path);
    if (request.method === 'POST' && confirmCancellationPath?.[1]) {
      const cancellation = cancellations.get(decodeURIComponent(confirmCancellationPath[1]));
      const order = cancellation ? orders.get(cancellation.orderId) : undefined;
      if (!cancellation || !order) {
        sendJson(response, 404, { errors: [{ title: 'Cancellation not found' }] });
        return;
      }
      const fault = consumeFault('ORDER_CANCEL', order.bookingIntentId);
      if (fault?.outcome === 'DEFINITIVE_REJECTION') {
        sendDuffelError(response, 422, 'cancellation_rejected', 'Order cancellation was rejected', 'invalid_request_error');
        return;
      }
      if (fault?.outcome === 'UNAVAILABLE') {
        sendDuffelError(response, 503, 'provider_unavailable', 'Provider temporarily unavailable', 'server_error');
        return;
      }
      if (fault?.outcome === 'PROCESSING') {
        order.summary.status = 'CANCELLATION_PENDING';
        sideEffectCount += 1;
        sendDuffelError(response, 503, 'cancellation_processing', 'Order cancellation is still processing', 'server_error');
        return;
      }

      const confirmedAt = new Date().toISOString();
      order.summary.status = 'CANCELLED';
      order.data.cancelled_at = confirmedAt;
      order.data.cancellation = {
        id: cancellation.id,
        created_at: confirmedAt,
        confirmed_at: confirmedAt,
        expires_at: confirmedAt,
        live_mode: false,
        order_id: cancellation.orderId,
        refund_amount: options.balanceAmount,
        refund_currency: options.balanceCurrency,
      };
      sideEffectCount += 1;
      await respondOrHold(response, 200, responseData({
        id: cancellation.id,
        created_at: confirmedAt,
        confirmed_at: confirmedAt,
        expires_at: confirmedAt,
        live_mode: false,
        order_id: cancellation.orderId,
        refund_amount: options.balanceAmount,
        refund_currency: options.balanceCurrency,
      }), fault);
      return;
    }

    sendJson(response, 404, { errors: [{ title: 'Not found' }] });
  }

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (response.headersSent) {
        if (!response.destroyed) response.destroy();
      } else {
        sendJson(response, 500, { errors: [{ title: 'Simulator request failed' }] });
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
  const origin = 'http://127.0.0.1:' + address.port;

  const simulator: SupplierSimulator = {
    runId,
    origin,
    applicationCredential,
    inspect: async (requestedRunId: string): Promise<SupplierLedgerSummary> => {
      assertRun(requestedRunId);
      return {
        provider: 'DUFFEL',
        orders: Array.from(orders.values(), (order) => ({
          ...order.summary,
          serviceIds: [...order.summary.serviceIds],
        })),
        requestsReceived,
        sideEffectCount,
        pendingEventIds: [],
        pendingResponseIds: Array.from(heldResponses.keys()),
      };
    },
    selectFault: async (requestedRunId: string, input: SimulatorFaultSelection): Promise<void> => {
      assertRun(requestedRunId);
      if (input.provider !== 'DUFFEL') throw new Error('fault provider does not match simulator');
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
