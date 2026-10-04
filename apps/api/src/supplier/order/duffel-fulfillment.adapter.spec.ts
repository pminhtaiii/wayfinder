import {
  AdmissionQueueFullException,
  AdmissionTimeoutException,
  BoundedSemaphore,
} from '@/payment-fulfillment/utils/bounded-semaphore';
import {
  CreateOrderInput,
  FulfillmentGatewayPort,
  PassengerEnrichmentInput,
  PersistedOrderEvidence,
  PortInvocationControl,
} from '@/payment-fulfillment/ports';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CacheService } from '@/cache/cache.service';
import { DUFFEL_SDK, DUFFEL_SDK_CONFIGURATION } from '@/supplier/core/duffel-core.module';
import { DuffelRateBudgetService } from '@/supplier/core/duffel-rate-budget.service';
import { DuffelCancellationService } from './duffel-cancellation.service';
import { DuffelFulfillmentAdapter } from './duffel-fulfillment.adapter';
import { DuffelOrderAdapter } from './duffel-order.adapter';
import { DuffelRecoveryService } from './duffel-recovery.service';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';

type SdkResponse = { data: unknown };
type DuffelSdkDouble = {
  offers: { get: jest.Mock<Promise<SdkResponse>, [offerId: string]> };
  orders: { get: jest.Mock<Promise<SdkResponse>, [orderId: string]> };
  orderCancellations: {
    create: jest.Mock<Promise<SdkResponse>, [input: { order_id: string }]>
    confirm: jest.Mock<Promise<SdkResponse>, [quoteId: string]>;
  };
};

describe('DuffelFulfillmentAdapter', () => {
  let adapter: DuffelFulfillmentAdapter;
  let mockOffersGet: DuffelSdkDouble['offers']['get'];
  let mockOrdersGet: DuffelSdkDouble['orders']['get'];
  let mockCancellationCreate: DuffelSdkDouble['orderCancellations']['create'];
  let mockCancellationConfirm: DuffelSdkDouble['orderCancellations']['confirm'];
  let cacheCheck: (...args: unknown[]) => Promise<{ allowed: boolean; storeError: boolean }>;
  let fetchResponseBody: unknown;
  let fetchResponseStatus: number;
  let fetchError: unknown;
  let fetchCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
  let boundaryOrder: string[];
  let testModules: TestingModule[] = [];
  let mockControl: PortInvocationControl;

  const validCreateOrderInput: CreateOrderInput = {
    offerId: 'off_test_123',
    passengers: [
      {
        id: 'pas_test_1',
        givenName: 'John',
        familyName: 'Doe',
        email: 'john.doe@example.com',
        phoneNumber: '+1234567890',
        bornOn: '1990-01-01',
        type: 'adult',
      },
    ],
    services: [{ serviceId: 'srv_bag_123', quantity: 2 }],
    metadata: {
      bookingIntentId: 'intent_123',
      paymentId: 'pay_123',
    },
    idempotencyKey: 'idem_key_123',
  };

  const rawDuffelOrder = {
    id: 'ord_duffel_123',
    booking_reference: 'ABCDEF',
    slices: [
      {
        duration: 'PT2H',
        segments: [
          {
            id: 'seg_1',
            departing_at: '2026-10-01T10:00:00Z',
            arriving_at: '2026-10-01T12:00:00Z',
          },
        ],
      },
    ],
    passengers: [
      {
        id: 'pas_test_1',
        given_name: 'John',
        family_name: 'Doe',
        born_on: '1990-01-01',
        email: 'john.doe@example.com',
        phone_number: '+1234567890',
        type: 'adult',
      },
    ],
  };

  const fallbackEvidence: PersistedOrderEvidence = {
    id: 'ord_fallback_123',
    bookingReference: 'REF123',
    passengers: [
      {
        id: 'pas_1',
        given_name: 'REDACTED',
        family_name: 'REDACTED',
        born_on: 'REDACTED',
        email: 'REDACTED',
        phone_number: 'REDACTED',
        type: 'adult',
      },
    ],
    slices: [
      {
        duration: 'PT2H',
        segments: [
          {
            id: 'seg_1',
            departing_at: '2026-10-01T10:00:00Z',
            arriving_at: '2026-10-01T12:00:00Z',
          },
        ],
      },
    ],
  };

  const passengerEnrichment: PassengerEnrichmentInput[] = [
    {
      id: 'pas_1',
      firstName: 'Jane',
      lastName: 'Smith',
      dateOfBirth: '1985-05-20',
      email: 'jane@example.com',
      phoneNumber: '+1987654321',
    },
  ];

  function parsedRequestBody(index = 0): unknown {
    const body = fetchCalls[index]?.init?.body;
    return typeof body === 'string' ? JSON.parse(body) : undefined;
  }

  async function createTestModule(semaphore?: BoundedSemaphore): Promise<TestingModule> {
    const sdk: DuffelSdkDouble = {
      offers: { get: mockOffersGet },
      orders: { get: mockOrdersGet },
      orderCancellations: {
        create: mockCancellationCreate,
        confirm: mockCancellationConfirm,
      },
    };
    const providers: Provider[] = [
      DuffelFulfillmentAdapter,
      DuffelOrderAdapter,
      DuffelCancellationService,
      DuffelRecoveryService,
      OrderSnapshotNormalizer,
      DuffelRateBudgetService,
      { provide: DUFFEL_SDK, useValue: sdk },
      {
        provide: DUFFEL_SDK_CONFIGURATION,
        useValue: { token: 'test-token', basePath: 'http://127.0.0.1:4010' },
      },
      { provide: CacheService, useValue: { checkAndIncrement: cacheCheck } },
    ];
    if (semaphore) providers.push({ provide: BoundedSemaphore, useValue: semaphore });
    const moduleRef = await Test.createTestingModule({ providers }).compile();
    testModules.push(moduleRef);
    return moduleRef;
  }

  beforeEach(async () => {
    mockOffersGet = jest.fn<Promise<SdkResponse>, [string]>().mockImplementation(async () => {
      boundaryOrder.push('offerLookup');
      return { data: { passengers: [{ id: 'pas_test_1', type: 'adult' }] } };
    });
    mockOrdersGet = jest.fn<Promise<SdkResponse>, [string]>().mockImplementation(async () => {
      boundaryOrder.push('orderGet');
      throw new Error('Duffel order retrieval failed');
    });
    mockCancellationCreate = jest
      .fn<Promise<SdkResponse>, [{ order_id: string }]>()
      .mockImplementation(async () => {
        boundaryOrder.push('cancelQuote');
        return { data: { id: 'cancel_123', order_id: 'ord_123' } };
      });
    mockCancellationConfirm = jest
      .fn<Promise<SdkResponse>, [string]>()
      .mockImplementation(async () => {
        boundaryOrder.push('cancelConfirm');
        return {
          data: {
            id: 'cancel_123',
            order_id: 'ord_123',
            confirmed_at: '2026-10-02T10:00:00.000Z',
          },
        };
      });
    cacheCheck = jest.fn().mockResolvedValue({ allowed: true, storeError: false });
    fetchResponseBody = { data: rawDuffelOrder };
    fetchResponseStatus = 201;
    fetchError = undefined;
    fetchCalls = [];
    boundaryOrder = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      boundaryOrder.push('orderPost');
      fetchCalls.push({ input, init });
      if (fetchError !== undefined) throw fetchError;
      return new Response(JSON.stringify(fetchResponseBody), {
        status: fetchResponseStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    mockControl = {
      beforeInvoke: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await createTestModule();
    adapter = moduleRef.get(DuffelFulfillmentAdapter);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(testModules.map((moduleRef) => moduleRef.close()));
    testModules = [];
  });

  describe('Semaphore Configuration & Defaults', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it('initializes with default semaphore parameters (10, 100, 5000) when env vars are absent', async () => {
      delete process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT;
      delete process.env.DUFFEL_ADMISSION_QUEUE_LIMIT;
      delete process.env.DUFFEL_ADMISSION_TIMEOUT_MS;

      const sem = (await createTestModule()).get(DuffelFulfillmentAdapter).semaphore;

      expect(sem.activeLimit).toBe(10);
      expect(sem.queueLimit).toBe(100);
      expect(sem.timeoutMs).toBe(5000);
    });

    it('configures semaphore limits from environment variables when provided', async () => {
      process.env.DUFFEL_ADMISSION_ACTIVE_LIMIT = '5';
      process.env.DUFFEL_ADMISSION_QUEUE_LIMIT = '15';
      process.env.DUFFEL_ADMISSION_TIMEOUT_MS = '2500';

      const sem = (await createTestModule()).get(DuffelFulfillmentAdapter).semaphore;

      expect(sem.activeLimit).toBe(5);
      expect(sem.queueLimit).toBe(15);
      expect(sem.timeoutMs).toBe(2500);
    });

    it.each([
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '5workers'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '2.5'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '-1'],
      ['DUFFEL_ADMISSION_ACTIVE_LIMIT', '0'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '5workers'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '2.5'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '-1'],
      ['DUFFEL_ADMISSION_QUEUE_LIMIT', '0'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '5workers'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '2.5'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '-1'],
      ['DUFFEL_ADMISSION_TIMEOUT_MS', '0'],
    ])(
      'throws an Error naming the variable when %s is set to %p',
      async (envVar, invalidValue) => {
        process.env[envVar] = invalidValue;
        await expect(createTestModule()).rejects.toThrow(
          `Invalid configuration for ${envVar}: "${invalidValue}"`,
        );
      },
    );
  });

  describe('createOrder', () => {
    it('maps the provider request, calls beforeInvoke before offer lookup, and redacts PII', async () => {
      mockControl.beforeInvoke = jest.fn().mockImplementation(async () => {
        boundaryOrder.push('beforeInvoke');
      });

      const outcome = await adapter.createOrder(validCreateOrderInput, mockControl);

      expect(boundaryOrder).toEqual(['beforeInvoke', 'offerLookup', 'orderPost']);
      expect(mockOffersGet).toHaveBeenCalledWith('off_test_123');
      expect(fetchCalls[0]?.input).toBe('http://127.0.0.1:4010/air/orders');
      expect(fetchCalls[0]?.init?.method).toBe('POST');
      expect(fetchCalls[0]?.init?.headers).toMatchObject({
        'Idempotency-Key': 'idem_key_123-duffel-order',
      });
      expect(parsedRequestBody()).toEqual({
        data: {
          type: 'instant',
          selected_offers: ['off_test_123'],
          passengers: [
            {
              id: 'pas_test_1',
              given_name: 'John',
              family_name: 'Doe',
              born_on: '1990-01-01',
              gender: 'u',
              title: 'mr',
              phone_number: '+1234567890',
              email: 'john.doe@example.com',
            },
          ],
          services: [{ id: 'srv_bag_123', quantity: 2 }],
          metadata: { bookingIntentId: 'intent_123', paymentId: 'pay_123' },
        },
      });

      expect(outcome.orderId).toBe('ord_duffel_123');
      expect(outcome.bookingReference).toBe('ABCDEF');

      // Verify PII redaction on evidence
      const passengerEvidence = outcome.evidence.passengers?.[0];
      expect(passengerEvidence?.email).toBe('REDACTED');
      expect(passengerEvidence?.born_on).toBe('REDACTED');
      expect(passengerEvidence?.given_name).toBe('REDACTED');
      expect(passengerEvidence?.family_name).toBe('REDACTED');
      expect(passengerEvidence?.phone_number).toBe('REDACTED');
      expect(passengerEvidence?.id).toBe('pas_test_1');

      // Verify original raw order was not mutated
      expect(rawDuffelOrder.passengers[0].email).toBe('john.doe@example.com');
    });

    it('passes undefined services when services list is empty or omitted', async () => {
      const inputWithoutServices: CreateOrderInput = {
        ...validCreateOrderInput,
        services: [],
      };

      await adapter.createOrder(inputWithoutServices, mockControl);

      expect(parsedRequestBody()).not.toHaveProperty('data.services');
      // Human approved 2026-10-02: legacy createOrder omits metadata without a services array.
      expect(parsedRequestBody()).not.toHaveProperty('data.metadata');
      expect(parsedRequestBody()).toMatchObject({ data: { selected_offers: ['off_test_123'] } });
    });

    it('releases permit and never calls the SDK if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(adapter.createOrder(validCreateOrderInput, mockControl)).rejects.toThrow(
        'Pre-flight lock failed',
      );

      expect(mockOffersGet).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and propagates upstream error when duffelService.createOrder throws', async () => {
      fetchError = new Error('Upstream Duffel error on createOrder');

      await expect(adapter.createOrder(validCreateOrderInput, mockControl)).rejects.toThrow(
        'Upstream Duffel error on createOrder',
      );

      expect(mockControl.beforeInvoke).toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('persists redacted evidence without leaking passenger passports, emails, or phone numbers', async () => {
      const duffelOrderWithSensitivePii = {
        ...rawDuffelOrder,
        passengers: [
          {
            id: 'pas_test_1',
            given_name: 'John',
            family_name: 'Doe',
            born_on: '1990-01-01',
            email: 'john.doe@example.com',
            phone_number: '+1234567890',
            passport_number: 'US-PASS-999888',
            identity_documents: [{ unique_identifier: 'US-PASS-999888' }],
          },
        ],
      };

      fetchResponseBody = { data: duffelOrderWithSensitivePii };

      const outcome = await adapter.createOrder(validCreateOrderInput, mockControl);

      const serializedEvidence = JSON.stringify(outcome.evidence);
      expect(serializedEvidence).not.toContain('US-PASS-999888');
      expect(serializedEvidence).not.toContain('john.doe@example.com');
      expect(serializedEvidence).not.toContain('+1234567890');
      expect(serializedEvidence).toContain('"email":"REDACTED"');
      expect(serializedEvidence).toContain('"phone_number":"REDACTED"');
    });
  });

  describe('cancelOrder', () => {
    it('calls beforeInvoke before Duffel cancellation requests and returns CancelOrderOutcome', async () => {
      mockControl.beforeInvoke = jest.fn().mockImplementation(async () => {
        boundaryOrder.push('beforeInvoke');
      });

      const outcome = await adapter.cancelOrder('ord_123', mockControl);

      expect(boundaryOrder).toEqual(['beforeInvoke', 'cancelQuote', 'cancelConfirm']);
      expect(mockCancellationCreate).toHaveBeenCalledWith({ order_id: 'ord_123' });
      expect(mockCancellationConfirm).toHaveBeenCalledWith('cancel_123');
      expect(outcome).toEqual({
        success: true,
        orderId: 'ord_123',
        status: 'CANCELLED',
      });
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('normalizes Duffel confirmed cancellation response to the port contract', async () => {
      mockCancellationConfirm.mockResolvedValueOnce({
        data: { id: 'cancel_123', status: 'confirmed' },
      });

      await expect(adapter.cancelOrder('ord_123', mockControl)).resolves.toEqual({
        success: true,
        orderId: 'ord_123',
        status: 'CANCELLED',
      });
    });

    it('does not confirm a status-less Duffel object', async () => {
      mockCancellationConfirm.mockResolvedValueOnce({ data: { id: 'cancel_123' } });

      await expect(adapter.cancelOrder('ord_123', mockControl)).resolves.toEqual({
        success: false,
        orderId: 'ord_123',
        status: undefined,
      });
    });

    it('confirms a status-less cancellation with a non-empty confirmed_at', async () => {
      mockCancellationConfirm.mockResolvedValueOnce({
        data: { id: 'cancel_123', confirmed_at: '2026-10-02T10:00:00.000Z' },
      });

      await expect(adapter.cancelOrder('ord_123', mockControl)).resolves.toEqual({
        success: true,
        orderId: 'ord_123',
        status: 'CANCELLED',
      });
    });

    it.each([
      { name: 'pending', result: { id: 'cancel_123', status: 'pending' }, status: 'pending' },
      {
        name: 'explicitly negative',
        result: { success: false, status: 'CANCELLED' },
        status: 'CANCELLED',
      },
      { name: 'invalid', result: null, status: undefined },
      { name: 'empty timestamp', result: { confirmed_at: '' }, status: undefined },
      { name: 'blank timestamp', result: { confirmed_at: '  ' }, status: undefined },
      { name: 'null timestamp', result: { confirmed_at: null }, status: undefined },
      {
        name: 'explicitly negative with timestamp',
        result: { success: false, confirmed_at: '2026-10-02T10:00:00.000Z' },
        status: undefined,
      },
    ])('returns an unconfirmed outcome for a $name Duffel result', async ({ result, status }) => {
      mockCancellationConfirm.mockResolvedValueOnce({ data: result });

      const outcome = await adapter.cancelOrder('ord_123', mockControl);

      expect(outcome.success).toBe(false);
      expect(outcome.orderId).toBe('ord_123');
      expect(outcome.status).toBe(status);
    });

    it('releases permit and never calls the SDK if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(adapter.cancelOrder('ord_123', mockControl)).rejects.toThrow(
        'Pre-flight lock failed',
      );

      expect(mockCancellationCreate).not.toHaveBeenCalled();
      expect(mockCancellationConfirm).not.toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and propagates upstream error when duffelService.cancelOrder throws', async () => {
      mockCancellationCreate.mockRejectedValueOnce(
        new HttpException('Upstream Duffel cancellation rejected', HttpStatus.BAD_GATEWAY),
      );

      await expect(adapter.cancelOrder('ord_123', mockControl)).rejects.toThrow(
        'Upstream Duffel cancellation rejected',
      );

      expect(mockControl.beforeInvoke).toHaveBeenCalled();
      expect(mockOrdersGet).toHaveBeenCalledWith('ord_123');
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('retrieveOrderSnapshot', () => {
    // Human approved this exact legacy-normalizer output when replacing the old service mock.
    // Explicit user approval 2026-10-03: this current fulfillment snapshot uses supplierSegmentId; provider order input and legacy JSON/wire fields remain unchanged.
    const mockSnapshots = {
      flightSnapshot: {
        segments: [
          {
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: 'BA123',
            departureAirport: {
              iataCode: 'LHR',
              name: 'Heathrow',
              city: 'London',
              terminal: undefined,
            },
            arrivalAirport: {
              iataCode: 'JFK',
              name: 'JFK',
              city: 'New York',
              terminal: undefined,
            },
            departureAt: '2026-10-01T10:00:00.000Z',
            arrivalAt: '2026-10-01T13:00:00.000Z',
            duration: 'PT8H',
            aircraftType: undefined,
            supplierSegmentId: 'seg_1',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT8H',
        stops: 0,
        cabinClass: 'economy',
      },
      passengerSnapshot: {
        passengers: [
          {
            type: 'ADULT',
            firstName: 'Jane',
            lastName: 'Smith',
            dateOfBirth: '1985-05-20',
          },
        ],
        contactEmail: 'jane@example.com',
        contactPhone: '+1987654321',
      },
    };

    it('returns snapshots and departureAt Date on retrieveCompleteOrder success', async () => {
      const freshOrder = {
        id: 'ord_123',
        slices: [
          {
            duration: 'PT8H',
            segments: [
              {
                id: 'seg_1',
                departing_at: '2026-10-01T10:00:00.000Z',
                arriving_at: '2026-10-01T13:00:00.000Z',
                duration: 'PT8H',
                marketing_carrier_flight_number: 'BA123',
                operating_carrier: { name: 'British Airways', iata_code: 'BA' },
                origin: { iata_code: 'LHR', name: 'Heathrow', city_name: 'London' },
                destination: { iata_code: 'JFK', name: 'JFK', city_name: 'New York' },
              },
            ],
          },
        ],
        passengers: [
          {
            id: 'pas_1',
            type: 'adult',
            given_name: 'Jane',
            family_name: 'Smith',
            born_on: '1985-05-20',
            email: 'jane@example.com',
            phone_number: '+1987654321',
          },
        ],
      };
      mockOrdersGet.mockResolvedValueOnce({ data: freshOrder });

      const outcome = await adapter.retrieveOrderSnapshot(
        'ord_123',
        fallbackEvidence,
        passengerEnrichment,
        'contact@example.com',
        mockControl,
      );

      expect(mockControl.beforeInvoke).toHaveBeenCalled();
      expect(mockOrdersGet).toHaveBeenCalledWith('ord_123');
      expect(outcome.flightSnapshot).toEqual(mockSnapshots.flightSnapshot);
      expect(outcome.passengerSnapshot).toEqual(mockSnapshots.passengerSnapshot);
      expect(outcome.departureAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('falls back to enrichRedactedDuffelOrder when retrieveCompleteOrder throws', async () => {
      mockOrdersGet.mockRejectedValueOnce(new Error('Upstream Duffel error'));

      const outcome = await adapter.retrieveOrderSnapshot(
        'ord_123',
        fallbackEvidence,
        passengerEnrichment,
        'contact@example.com',
        mockControl,
      );

      expect(mockOrdersGet).toHaveBeenCalledWith('ord_123');
      expect(outcome.passengerSnapshot.passengers[0]?.firstName).toBe('Jane');
      expect(outcome.passengerSnapshot.passengers[0]?.lastName).toBe('Smith');
      expect(outcome.passengerSnapshot.passengers[0]?.dateOfBirth).toBe('1985-05-20');
      expect(outcome.passengerSnapshot.contactEmail).toBe('jane@example.com');
      expect(outcome.departureAt).toEqual(new Date('2026-10-01T10:00:00.000Z'));
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and never calls the SDK if beforeInvoke fails', async () => {
      mockControl.beforeInvoke = jest.fn().mockRejectedValue(new Error('Pre-flight lock failed'));

      await expect(
        adapter.retrieveOrderSnapshot(
          'ord_123',
          fallbackEvidence,
          passengerEnrichment,
          'contact@example.com',
          mockControl,
        ),
      ).rejects.toThrow('Pre-flight lock failed');

      expect(mockOrdersGet).not.toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });

    it('releases permit and propagates a malformed retrieved order error', async () => {
      // Human approved migrating this old service mock to the real normalizer boundary.
      const brokenOrder = new Proxy({ id: 'ord_123' }, {
        get: (target, property) => {
          if (property === 'id') return target.id;
          if (property === 'slices') {
          throw new Error('Fallback mapping failed');
          }
          return undefined;
        },
      });
      mockOrdersGet.mockResolvedValueOnce({ data: brokenOrder });

      await expect(
        adapter.retrieveOrderSnapshot(
          'ord_123',
          fallbackEvidence,
          passengerEnrichment,
          'contact@example.com',
          mockControl,
        ),
      ).rejects.toThrow('Fallback mapping failed');

      expect(mockControl.beforeInvoke).toHaveBeenCalled();
      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('BoundedSemaphore admission control', () => {
    it('rejects with AdmissionQueueFullException on queue overflow and does not invoke beforeInvoke or SDK', async () => {
      // Create adapter with tiny semaphore: activeLimit = 1, queueLimit = 1, timeoutMs = 2000
      const tightSemaphore = new BoundedSemaphore(1, 1, 2000);
      const tightAdapter = (await createTestModule(tightSemaphore)).get(
        DuffelFulfillmentAdapter,
      );

      let releaseTask1: (() => void) | undefined;
      const task1Promise = new Promise<void>((resolve) => {
        releaseTask1 = resolve;
      });

      // Call 1 occupies active permit
      mockControl.beforeInvoke = jest.fn().mockImplementation(() => task1Promise);
      const call1 = tightAdapter.cancelOrder('ord_1', mockControl);

      // Give event loop tick so call 1 acquires permit and awaits beforeInvoke
      await new Promise((r) => setImmediate(r));
      expect(tightAdapter.semaphore.activeCount).toBe(1);

      // Call 2 queues up
      const call2Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      const call2 = tightAdapter.cancelOrder('ord_2', call2Control);
      expect(tightAdapter.semaphore.waitingCount).toBe(1);

      // Call 3 exceeds queue limit and rejects immediately
      const call3Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      await expect(tightAdapter.cancelOrder('ord_3', call3Control)).rejects.toThrow(
        AdmissionQueueFullException,
      );

      expect(call3Control.beforeInvoke).not.toHaveBeenCalled();
      expect(mockCancellationCreate).not.toHaveBeenCalled();

      // Clean up Call 1 and Call 2
      if (!releaseTask1) throw new Error('Expected the first task to hold its permit.');
      releaseTask1();
      await call1;
      await call2;
      expect(tightAdapter.semaphore.activeCount).toBe(0);
    });

    it('rejects with AdmissionTimeoutException on admission timeout and does not invoke beforeInvoke or SDK', async () => {
      const timeoutSemaphore = new BoundedSemaphore(1, 2, 50); // 50ms timeout
      const timeoutAdapter = (await createTestModule(timeoutSemaphore)).get(
        DuffelFulfillmentAdapter,
      );

      let releaseTask1: (() => void) | undefined;
      const task1Promise = new Promise<void>((resolve) => {
        releaseTask1 = resolve;
      });

      mockControl.beforeInvoke = jest.fn().mockImplementation(() => task1Promise);
      const call1 = timeoutAdapter.cancelOrder('ord_1', mockControl);

      await new Promise((r) => setImmediate(r));
      expect(timeoutAdapter.semaphore.activeCount).toBe(1);

      // Call 2 queues up and will time out after 50ms
      const call2Control: PortInvocationControl = { beforeInvoke: jest.fn() };
      const call2 = timeoutAdapter.cancelOrder('ord_2', call2Control);

      await expect(call2).rejects.toThrow(AdmissionTimeoutException);
      expect(call2Control.beforeInvoke).not.toHaveBeenCalled();
      expect(mockCancellationCreate).not.toHaveBeenCalled();

      // Clean up Call 1
      if (!releaseTask1) throw new Error('Expected the first task to hold its permit.');
      releaseTask1();
      await call1;
      expect(timeoutAdapter.semaphore.activeCount).toBe(0);
    });
  });

  describe('Privacy helpers: redactDuffelOrder and enrichRedactedDuffelOrder', () => {
    it('redactDuffelOrder redacts passenger PII while preserving ID and structure', () => {
      const order = {
        id: 'ord_privacy_123',
        booking_reference: 'XYZ987',
        private_provider_payload: 'must-not-persist',
        passengers: [
          {
            id: 'pas_1',
            given_name: 'John',
            family_name: 'Doe',
            born_on: '1990-01-01',
            email: 'john@example.com',
            phone_number: '+1234567890',
          },
          {
            id: 'pas_2',
            given_name: 'Jane',
            family_name: 'Doe',
            born_on: '1992-02-02',
            email: 'jane@example.com',
            phone_number: '+1234567891',
          },
        ],
      };

      const redacted = adapter.redactDuffelOrder(order);

      expect(redacted.id).toBe('ord_privacy_123');
      expect(redacted.bookingReference).toBe('XYZ987');
      const passengers = redacted.passengers ?? [];
      const p1 = passengers[0];
      const p2 = passengers[1];
      expect(p1?.email).toBe('REDACTED');
      expect(p1?.born_on).toBe('REDACTED');
      expect(p1?.given_name).toBe('REDACTED');
      expect(p1?.family_name).toBe('REDACTED');
      expect(p1?.phone_number).toBe('REDACTED');
      expect(p2?.email).toBe('REDACTED');
      expect(p2?.born_on).toBe('REDACTED');
      expect(p2?.given_name).toBe('REDACTED');
      expect(p2?.family_name).toBe('REDACTED');
      expect(p2?.phone_number).toBe('REDACTED');
      expect(redacted).not.toHaveProperty('private_provider_payload');
      expect(Object.keys(redacted).sort()).toEqual(
        ['bookingReference', 'booking_reference', 'id', 'passengers'].sort(),
      );
    });

    it('enrichRedactedDuffelOrder restores passenger PII matching by id or index', () => {
      const redactedOrder = {
        id: 'ord_privacy_123',
        booking_reference: 'XYZ987',
        passengers: [
          {
            id: 'pas_1',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
            born_on: 'REDACTED',
            email: 'REDACTED',
            phone_number: 'REDACTED',
          },
          {
            id: 'pas_unknown_id',
            given_name: 'REDACTED',
            family_name: 'REDACTED',
            born_on: 'REDACTED',
            email: 'REDACTED',
            phone_number: 'REDACTED',
          },
        ],
      };

      const passengerEnrichment: PassengerEnrichmentInput[] = [
        {
          id: 'pas_1',
          firstName: 'Alice',
          lastName: 'Wonderland',
          dateOfBirth: '1995-03-15',
          email: 'alice@example.com',
          phoneNumber: '+1112223333',
        },
        {
          // Matched by index 1
          firstName: 'Bob',
          lastName: 'Builder',
          dateOfBirth: '1988-08-08',
          phoneNumber: '+4445556666',
        },
      ];

      const enriched = adapter.enrichRedactedDuffelOrder(
        redactedOrder,
        passengerEnrichment,
        'primary@example.com',
      );

      expect(enriched).toMatchObject({
        passengers: [
          {
            given_name: 'Alice',
            family_name: 'Wonderland',
            born_on: '1995-03-15',
            email: 'alice@example.com',
            phone_number: '+1112223333',
          },
          {
            given_name: 'Bob',
            family_name: 'Builder',
            born_on: '1988-08-08',
            phone_number: '+4445556666',
          },
        ],
      });
    });

    it('redactDuffelOrder strictly strips identity documents, passports, and non-allowlisted PII fields while redacting emails and phone numbers', () => {
      const orderWithSensitivePii: Record<string, unknown> = {
        id: 'ord_privacy_passport_123',
        booking_reference: 'XYZ987',
        passengers: [
          {
            id: 'pas_1',
            given_name: 'John',
            family_name: 'Doe',
            born_on: '1990-01-01',
            email: 'john@example.com',
            phone_number: '+1234567890',
            passport_number: 'AB1234567',
            passport_expiry: '2030-01-01',
            identity_documents: [
              {
                unique_identifier: 'AB1234567',
                type: 'passport',
                issuing_country_code: 'US',
                expires_on: '2030-01-01',
              },
            ],
            emergency_contact: {
              name: 'Jane Doe',
              phone_number: '+1987654321',
            },
            loyalty_programme_accounts: [
              {
                airline_iata_code: 'BA',
                account_number: 'BA987654',
              },
            ],
          },
        ],
        slices: [
          {
            duration: 'PT2H',
            segments: [
              {
                id: 'seg_1',
                departing_at: '2026-10-01T10:00:00Z',
                arriving_at: '2026-10-01T12:00:00Z',
                operating_carrier: { iata_code: 'BA', name: 'British Airways' },
                marketing_carrier: { iata_code: 'BA', name: 'British Airways' },
                marketing_carrier_flight_number: '123',
                passengers: [
                  {
                    cabin_class: 'economy',
                    seat_number: '12A',
                    passenger_id: 'pas_1',
                  },
                ],
              },
            ],
          },
        ],
      };

      const redacted = adapter.redactDuffelOrder(orderWithSensitivePii);

      expect(redacted.id).toBe('ord_privacy_passport_123');
      expect(redacted.bookingReference).toBe('XYZ987');
      expect(redacted.booking_reference).toBe('XYZ987');

      const passengers = redacted.passengers ?? [];
      expect(passengers).toHaveLength(1);
      const p1 = passengers[0];

      // Assert PII is strictly redacted
      expect(p1.id).toBe('pas_1');
      expect(p1.email).toBe('REDACTED');
      expect(p1.phone_number).toBe('REDACTED');
      expect(p1.born_on).toBe('REDACTED');
      expect(p1.given_name).toBe('REDACTED');
      expect(p1.family_name).toBe('REDACTED');

      // Assert non-allowlisted PII fields (passports, emergency contacts, loyalty) are completely absent
      expect(p1).not.toHaveProperty('passport_number');
      expect(p1).not.toHaveProperty('passport_expiry');
      expect(p1).not.toHaveProperty('identity_documents');
      expect(p1).not.toHaveProperty('emergency_contact');
      expect(p1).not.toHaveProperty('loyalty_programme_accounts');

      // Assert segment passenger data only keeps cabin_class and strips seat/passenger PII
      const segmentPassenger = redacted.slices?.[0]?.segments?.[0]?.passengers?.[0];
      expect(segmentPassenger?.cabin_class).toBe('economy');
      expect(segmentPassenger).not.toHaveProperty('seat_number');
      expect(segmentPassenger).not.toHaveProperty('passenger_id');

      // JSON serialization does not contain sensitive raw strings anywhere
      const serialized = JSON.stringify(redacted);
      expect(serialized).not.toContain('AB1234567');
      expect(serialized).not.toContain('john@example.com');
      expect(serialized).not.toContain('+1234567890');
      expect(serialized).not.toContain('+1987654321');
    });

    it('redactDuffelOrder preserves null fields when optional PII values are explicitly null', () => {
      const orderWithNullPii = {
        id: 'ord_privacy_null_123',
        booking_reference: 'XYZ987',
        passengers: [
          {
            id: 'pas_null',
            given_name: null,
            family_name: null,
            born_on: null,
            email: null,
            phone_number: null,
          },
        ],
      };

      const redacted = adapter.redactDuffelOrder(orderWithNullPii);
      const p = redacted.passengers?.[0];
      expect(p?.email).toBeNull();
      expect(p?.phone_number).toBeNull();
      expect(p?.given_name).toBeNull();
      expect(p?.family_name).toBeNull();
      expect(p?.born_on).toBeNull();
    });
  });

  describe('FULFILLMENT_GATEWAY_PORT contract conformance', () => {
    it('implements FulfillmentGatewayPort interface with createOrder, cancelOrder, and retrieveOrderSnapshot', () => {
      const port: FulfillmentGatewayPort = adapter;
      expect(typeof port.createOrder).toBe('function');
      expect(typeof port.cancelOrder).toBe('function');
      expect(typeof port.retrieveOrderSnapshot).toBe('function');
    });

    it('characterizes that cancellation quote generation is handled outside the fulfillment port', () => {
      // The port is intentionally narrow (governs execution and retrieval).
      // Cancellation quotes are generated by cancellation domain services rather than the fulfillment gateway port.
      expect('createCancellationQuote' in adapter).toBe(false);
    });

    it('requires PortInvocationControl with beforeInvoke for all port operations', async () => {
      const rejectControl: PortInvocationControl = {
        beforeInvoke: jest.fn().mockRejectedValue(new Error('Fencing token rejected')),
      };

      await expect(adapter.createOrder(validCreateOrderInput, rejectControl)).rejects.toThrow(
        'Fencing token rejected',
      );
      await expect(adapter.cancelOrder('ord_123', rejectControl)).rejects.toThrow(
        'Fencing token rejected',
      );
      await expect(
        adapter.retrieveOrderSnapshot(
          'ord_123',
          fallbackEvidence,
          passengerEnrichment,
          'contact@example.com',
          rejectControl,
        ),
      ).rejects.toThrow('Fencing token rejected');

      expect(adapter.semaphore.activeCount).toBe(0);
    });
  });

});
