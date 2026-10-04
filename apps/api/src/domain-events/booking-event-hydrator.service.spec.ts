import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import {
  BookingEventHydratorService,
  CoherentBookingSnapshot,
} from './booking-event-hydrator.service';
import { BookingProjectionModule } from '@/booking-projection/booking-projection.module';

describe('BookingEventHydratorService', () => {
  let service: BookingEventHydratorService;
  let prisma: {
    booking: {
      findUnique: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const sampleDate = new Date('2026-09-17T12:00:00.000Z');

  const createSampleSnapshot = (bookingId: string): CoherentBookingSnapshot =>
    ({
      id: bookingId,
      userId: 'user_123',
      bookingIntentId: 'intent_123',
      paymentId: 'pay_123',
      status: 'CONFIRMED',
      failureReason: null,
      pnrReference: 'PNR123',
      supplierOrderId: 'ord_123',
      flightSnapshot: { summary: 'flight-snap' },
      passengerSnapshot: {
        passengers: [
          {
            id: 'pas_1',
            firstName: 'Alice',
            lastName: 'Smith',
          },
        ],
      },
      totalAmount: 45000 as any,
      currency: 'GBP',
      departureAt: sampleDate,
      cancellationDeadline: null,
      cancellationRefundable: false,
      airlineRefundAmount: null,
      customerRefundAmount: null,
      supplierCancellationQuoteId: null,
      createdAt: sampleDate,
      updatedAt: sampleDate,
      version: 3,
      disruptionStatus: 'NONE',
      activeDisruptionRevisionId: 'rev_002',
      syncLockedAt: null,
      syncLockToken: null,
      lastSupplierSyncedAt: null,
      nextSupplierSyncAt: null,
      currentDepartureAt: null,
      nextUnflownDepartureAt: null,
      currentFinalArrivalAt: null,
      disruptionResolvedReason: null,
      disruptionResolvedAt: null,
      disruptionResolvedByType: null,
      disruptionResolvedById: null,
      disruptionNeedsAttention: false,
      disruptionAttentionReason: null,
      disruptionAttentionAt: null,
      itineraryRevisions: [
        {
          id: 'rev_002',
          bookingId,
          version: 2,
          source: 'DUFFEL_POLL',
          sourceEventId: 'evt_sync_001',
          supplierObservedAt: sampleDate,
          fingerprint: 'fp_abc',
          isMaterial: true,
          materialReasons: [],
          materialBaselines: [],
          incrementalDiff: {},
          cumulativeDiff: {},
          rulesetVersion: 'disruption-v1',
          createdAt: sampleDate,
          segments: [
            {
              id: 'seg_001',
              revisionId: 'rev_002',
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
              supplierSegmentId: 'seg_d1',
              marketingCarrierIata: 'BA',
              operatingCarrierIata: 'BA',
              airlineName: 'British Airways',
              flightNumber: 'BA117',
              departureAirportIata: 'LHR',
              departureAirportName: 'Heathrow',
              departureCity: 'London',
              departureTerminal: '5',
              departureAt: sampleDate,
              departureLocalDate: sampleDate,
              arrivalAirportIata: 'JFK',
              arrivalAirportName: 'John F Kennedy',
              arrivalCity: 'New York',
              arrivalTerminal: '7',
            },
            {
              id: 'seg_002',
              revisionId: 'rev_002',
              sliceOrder: 0,
              segmentOrder: 1,
              globalOrder: 1,
              supplierSegmentId: 'seg_d2',
              marketingCarrierIata: 'AA',
              operatingCarrierIata: 'AA',
              airlineName: 'American Airlines',
              flightNumber: 'AA100',
              departureAirportIata: 'JFK',
              departureAirportName: 'John F Kennedy',
              departureCity: 'New York',
              departureTerminal: '8',
              departureAt: new Date('2026-09-17T18:00:00.000Z'),
              departureLocalDate: new Date('2026-09-17T00:00:00.000Z'),
              arrivalAirportIata: 'LAX',
              arrivalAirportName: 'Los Angeles International',
              arrivalCity: 'Los Angeles',
              arrivalTerminal: '4',
            },
          ],
        },
      ],
    }) as unknown as CoherentBookingSnapshot;

  beforeEach(() => {
    const findUnique = jest.fn();
    prisma = {
      booking: { findUnique },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
        callback({ booking: { findUnique } }),
      ),
    };

    service = new BookingEventHydratorService(prisma as unknown as PrismaService);
  });

  describe('a) Concurrent hydration sharing single database fetch', () => {
    it('shares a single database query when called concurrently with the same bookingId', async () => {
      let resolveQuery: (value: any) => void;
      const delayedPromise = new Promise((resolve) => {
        resolveQuery = resolve;
      });

      prisma.booking.findUnique.mockReturnValue(delayedPromise);

      const snapshot = createSampleSnapshot('book_concurrent_01');

      // Call hydrate concurrently twice
      const promise1 = service.hydrate('book_concurrent_01');
      const promise2 = service.hydrate('book_concurrent_01');
      const promise3 = service.hydrate('book_concurrent_01');

      // Release query
      resolveQuery!(snapshot);

      const [res1, res2, res3] = await Promise.all([promise1, promise2, promise3]);

      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: { id: 'book_concurrent_01' },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              segments: {
                orderBy: { globalOrder: 'asc' },
              },
            },
          },
        },
      });

      expect(res1).toBe(snapshot);
      expect(res2).toBe(snapshot);
      expect(res3).toBe(snapshot);
    });

    it('queries independently for different bookingIds called concurrently', async () => {
      const snapA = createSampleSnapshot('book_A');
      const snapB = createSampleSnapshot('book_B');

      prisma.booking.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
        if (where.id === 'book_A') return snapA;
        if (where.id === 'book_B') return snapB;
        return null;
      });

      const [resA, resB] = await Promise.all([
        service.hydrate('book_A'),
        service.hydrate('book_B'),
      ]);

      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(2);
      expect(resA).toBe(snapA);
      expect(resB).toBe(snapB);
    });

    it('shares a single database query when concurrent calls have the same or satisfied minVersion', async () => {
      let resolveQuery: (value: any) => void;
      const delayedPromise = new Promise((resolve) => {
        resolveQuery = resolve;
      });

      prisma.booking.findUnique.mockReturnValue(delayedPromise);

      const snapshotV2 = {
        ...createSampleSnapshot('book_concurrent_min'),
        version: 2,
      };

      const promise1 = service.hydrate('book_concurrent_min');
      const promise2 = service.hydrate('book_concurrent_min', 1);
      const promise3 = service.hydrate('book_concurrent_min', 2);

      resolveQuery!(snapshotV2);

      const [res1, res2, res3] = await Promise.all([promise1, promise2, promise3]);

      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);
      expect(res1).toBe(snapshotV2);
      expect(res2).toBe(snapshotV2);
      expect(res3).toBe(snapshotV2);
    });

    it('triggers a fresh query and receives version 2 when pending query returns version 1 and caller needs minVersion 2', async () => {
      let resolveQuery1: (value: any) => void;
      const delayedPromise1 = new Promise((resolve) => {
        resolveQuery1 = resolve;
      });

      let resolveQuery2: (value: any) => void;
      const delayedPromise2 = new Promise((resolve) => {
        resolveQuery2 = resolve;
      });

      prisma.booking.findUnique
        .mockReturnValueOnce(delayedPromise1)
        .mockReturnValueOnce(delayedPromise2);

      const snapshotV1 = {
        ...createSampleSnapshot('book_min_ver_01'),
        version: 1,
      };
      const snapshotV2 = {
        ...createSampleSnapshot('book_min_ver_01'),
        version: 2,
      };

      // Call 1 begins first query (in-flight)
      const p1 = service.hydrate('book_min_ver_01', 1);

      // Call 2 arrives while query 1 is in-flight, but requires minVersion 2
      const p2 = service.hydrate('book_min_ver_01', 2);

      // Release first query
      resolveQuery1!(snapshotV1);

      const res1 = await p1;
      expect(res1).toBe(snapshotV1);

      // Wait a microtask turn so p2 resumes and initiates second query
      await Promise.resolve();

      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(2);

      // Release second query
      resolveQuery2!(snapshotV2);

      const res2 = await p2;
      expect(res2).toBe(snapshotV2);
    });
  });

  describe('b) Subsequent calls trigger fresh database read after previous resolves', () => {
    it('triggers a fresh database query on subsequent calls after resolution', async () => {
      const snapshotV1 = createSampleSnapshot('book_subsequent_01');
      const snapshotV2 = {
        ...createSampleSnapshot('book_subsequent_01'),
        version: 4,
      };

      prisma.booking.findUnique
        .mockResolvedValueOnce(snapshotV1)
        .mockResolvedValueOnce(snapshotV2);

      const firstResult = await service.hydrate('book_subsequent_01');
      expect(firstResult).toBe(snapshotV1);
      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);

      const secondResult = await service.hydrate('book_subsequent_01');
      expect(secondResult).toBe(snapshotV2);
      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('f) Cycle-scoped coherent reads', () => {
    it('uses a RepeatableRead transaction and isolates concurrent processing cycles', async () => {
      let resolveCycleOne: (value: CoherentBookingSnapshot) => void = () => {};
      let resolveCycleTwo: (value: CoherentBookingSnapshot) => void = () => {};
      const cycleOne = new Promise<CoherentBookingSnapshot>((resolve) => {
        resolveCycleOne = resolve;
      });
      const cycleTwo = new Promise<CoherentBookingSnapshot>((resolve) => {
        resolveCycleTwo = resolve;
      });

      prisma.booking.findUnique
        .mockReturnValueOnce(cycleOne)
        .mockReturnValueOnce(cycleTwo);

      const eventOne = service.hydrate('book_cycle_01', 3, 'event-1');
      const eventOneDuplicate = service.hydrate('book_cycle_01', 3, 'event-1');
      const eventTwo = service.hydrate('book_cycle_01', 3, 'event-2');

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.$transaction).toHaveBeenNthCalledWith(
        1,
        expect.any(Function),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

      const snapshotOne = createSampleSnapshot('book_cycle_01');
      const snapshotTwo = { ...snapshotOne, version: 4 };
      resolveCycleOne(snapshotOne);
      resolveCycleTwo(snapshotTwo);

      const [resultOne, duplicateResult, resultTwo] = await Promise.all([
        eventOne,
        eventOneDuplicate,
        eventTwo,
      ]);

      expect(resultOne).toBe(snapshotOne);
      expect(duplicateResult).toBe(snapshotOne);
      expect(resultTwo).toBe(snapshotTwo);
    });
  });

  describe('c) Clean error propagation and in-flight cache cleanup when database query rejects', () => {
    it('propagates rejection to all concurrent callers and clears in-flight cache on error', async () => {
      const dbError = new Error('Database connection timeout');
      let rejectQuery: (err: any) => void;
      const delayedReject = new Promise((_, reject) => {
        rejectQuery = reject;
      });

      prisma.booking.findUnique.mockReturnValue(delayedReject);

      const p1 = service.hydrate('book_err_01');
      const p2 = service.hydrate('book_err_01');

      rejectQuery!(dbError);

      await expect(p1).rejects.toThrow('Database connection timeout');
      await expect(p2).rejects.toThrow('Database connection timeout');
      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(1);

      // Verify cache is cleaned up: subsequent call triggers fresh fetch
      const recoverSnapshot = createSampleSnapshot('book_err_01');
      prisma.booking.findUnique.mockResolvedValueOnce(recoverSnapshot);

      const p3 = await service.hydrate('book_err_01');
      expect(p3).toBe(recoverSnapshot);
      expect(prisma.booking.findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('d) Coherent snapshot return structure', () => {
    it('returns booking row, latest active itinerary revision, ordered segments, and passengerSnapshot', async () => {
      const snapshot = createSampleSnapshot('book_coherent_01');
      prisma.booking.findUnique.mockResolvedValue(snapshot);

      const result = await service.hydrate('book_coherent_01');

      expect(result).toBeDefined();
      expect(result!.id).toBe('book_coherent_01');
      expect(result!.status).toBe('CONFIRMED');
      expect(result!.version).toBe(3);
      expect(result!.passengerSnapshot).toBeDefined();
      expect(result!.itineraryRevisions).toHaveLength(1);

      const revision = result!.itineraryRevisions[0];
      expect(revision.version).toBe(2);
      expect(revision.segments).toHaveLength(2);
      expect(revision.segments[0].globalOrder).toBe(0);
      expect(revision.segments[1].globalOrder).toBe(1);

      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: { id: 'book_coherent_01' },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              segments: {
                orderBy: { globalOrder: 'asc' },
              },
            },
          },
        },
      });
    });

    it('returns null when booking does not exist in database', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      const result = await service.hydrate('non_existent_id');

      expect(result).toBeNull();
      expect(prisma.booking.findUnique).toHaveBeenCalledWith({
        where: { id: 'non_existent_id' },
        include: {
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: {
              segments: {
                orderBy: { globalOrder: 'asc' },
              },
            },
          },
        },
      });
    });
  });

  describe('e) Module integration and DI resolution', () => {
    it('is registered, provided, and exported cleanly by BookingProjectionModule', async () => {
      const module: TestingModule = await Test.createTestingModule({
        imports: [BookingProjectionModule],
      })
        .overrideProvider(PrismaService)
        .useValue(prisma)
        .compile();

      const hydrator = module.get<BookingEventHydratorService>(BookingEventHydratorService);
      expect(hydrator).toBeDefined();
      expect(hydrator).toBeInstanceOf(BookingEventHydratorService);
    });
  });
});
