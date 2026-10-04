import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '@/prisma/prisma.module';
import { DomainEventsModule } from '@/domain-events/domain-events.module';
import { BookingProjectionModule } from '@/booking-projection/booking-projection.module';
import { BookingProjectionService } from '@/booking-projection/booking-projection.service';
import { BookingProjectionReconciliationService } from '@/booking-projection/booking-projection-reconciliation.service';
import { BookingProjectionRepository } from '@/booking-projection/booking-projection.repository';
import { BookingProjectionMetrics } from '@/booking-projection/booking-projection.metrics';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { PrismaService } from '@/prisma/prisma.service';
import { Prisma, BookingIntentStatus, BookingStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe('Booking Projection Reconciliation (E2E - T038)', () => {
  jest.setTimeout(90000);

  let testingModule: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliationService: BookingProjectionReconciliationService;
  let repository: BookingProjectionRepository;
  let projectionService: BookingProjectionService;
  let metrics: BookingProjectionMetrics;
  let hydrator: BookingEventHydratorService;

  const trackedUserIds = new Set<string>();
  const trackedBookingIds = new Set<string>();
  const trackedIntentIds = new Set<string>();

  async function cleanTrackedData(): Promise<void> {
    const bookingIds = Array.from(trackedBookingIds);
    if (bookingIds.length > 0) {
      await prisma.bookingAgentProjection.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.itineraryRevisionSegment.deleteMany({
        where: { revision: { bookingId: { in: bookingIds } } },
      });
      await prisma.itineraryRevision.deleteMany({
        where: { bookingId: { in: bookingIds } },
      });
      await prisma.booking.deleteMany({
        where: { id: { in: bookingIds } },
      });
      trackedBookingIds.clear();
    }

    const intentIds = Array.from(trackedIntentIds);
    if (intentIds.length > 0) {
      await prisma.bookingIntent.deleteMany({
        where: { id: { in: intentIds } },
      });
      trackedIntentIds.clear();
    }

    const userIds = Array.from(trackedUserIds);
    if (userIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: userIds } },
      });
      trackedUserIds.clear();
    }
  }

  async function createTestUser(prefix = 'recon-e2e'): Promise<string> {
    const user = await prisma.user.create({
      data: {
        email: `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}@example.com`,
        password: 'password_hash_test',
      },
    });
    trackedUserIds.add(user.id);
    return user.id;
  }

  async function createTestIntent(userId: string): Promise<string> {
    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        supplierOfferId: `off_recon_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('199.99'),
        confirmedPrice: new Prisma.Decimal('199.99'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });
    trackedIntentIds.add(intent.id);
    return intent.id;
  }

  beforeAll(async () => {
    testingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        PrismaModule,
        DomainEventsModule,
        BookingProjectionModule,
      ],
    }).compile();

    app = testingModule.createNestApplication();
    await app.init();

    const schedulerRegistry = app.get(SchedulerRegistry);
    schedulerRegistry.getCronJobs().forEach((job) => job.stop());

    prisma = testingModule.get<PrismaService>(PrismaService);
    reconciliationService = testingModule.get<BookingProjectionReconciliationService>(
      BookingProjectionReconciliationService,
    );
    repository = testingModule.get<BookingProjectionRepository>(BookingProjectionRepository);
    projectionService = testingModule.get<BookingProjectionService>(BookingProjectionService);
    metrics = testingModule.get<BookingProjectionMetrics>(BookingProjectionMetrics);
    hydrator = testingModule.get<BookingEventHydratorService>(BookingEventHydratorService);

    await cleanTrackedData();
  });

  afterAll(async () => {
    try {
      await cleanTrackedData();
    } finally {
      if (app) {
        await app.close();
      } else {
        await testingModule.close();
      }
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    metrics.reset();
  });

  describe('a) Suppressed Events / Lost Messages', () => {
    it('repairs missing projections and stale sourceVersions to authoritative booking state', async () => {
      const userId = await createTestUser('suppressed');

      // 1. Booking with missing projection (simulates lost creation event)
      const intentId1 = await createTestIntent(userId);
      const booking1 = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId: intentId1,
          totalAmount: new Prisma.Decimal('200.00'),
          currency: 'GBP',
          status: BookingStatus.CONFIRMED,
          version: 2,
          flightSnapshot: {
            stops: 0,
            segments: [
              {
                departureAirport: { iataCode: 'LHR' },
                arrivalAirport: { iataCode: 'JFK' },
                departureAt: '2026-12-01T10:00:00.000Z',
                arrivalAt: '2026-12-01T18:00:00.000Z',
                airline: { name: 'British Airways', iataCode: 'BA' },
                flightNumber: '178',
              },
            ],
          },
        },
      });
      trackedBookingIds.add(booking1.id);

      // 2. Booking with stale projection (sourceVersion < booking.version, e.g. status transition event lost)
      const intentId2 = await createTestIntent(userId);
      const booking2 = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId: intentId2,
          totalAmount: new Prisma.Decimal('350.00'),
          currency: 'USD',
          status: BookingStatus.COMPLETED,
          version: 3,
          itineraryRevisions: {
            create: {
              version: 3,
              source: 'WEBHOOK',
              fingerprint: `fp-${randomUUID()}`,
              incrementalDiff: {},
              cumulativeDiff: {},
              isMaterial: true,
              segments: {
                create: [
                  {
                    supplierSegmentId: `seg_${randomUUID()}`,
                    sliceOrder: 0,
                    segmentOrder: 0,
                    globalOrder: 0,
                    airlineName: 'Delta Air Lines',
                    marketingCarrierIata: 'DL',
                    operatingCarrierIata: 'DL',
                    flightNumber: '401',
                    departureAirportIata: 'JFK',
                    departureAirportName: 'John F Kennedy International',
                    departureCity: 'New York',
                    departureLocalDate: new Date('2026-12-05'),
                    arrivalAirportIata: 'LAX',
                    arrivalAirportName: 'Los Angeles International Airport',
                    arrivalCity: 'Los Angeles',
                    arrivalLocalDate: new Date('2026-12-05'),
                    departureAt: new Date('2026-12-05T14:00:00.000Z'),
                    arrivalAt: new Date('2026-12-05T20:00:00.000Z'),
                    durationMinutes: 360,
                  },
                ],
              },
            },
          },
        },
      });
      trackedBookingIds.add(booking2.id);

      // Seed stale projection for booking2
      const initialAgentRef2 = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: booking2.id,
          agentReference: initialAgentRef2,
          status: 'PROCESSING',
          airline: 'Delta',
          origin: 'JFK',
          destination: 'LAX',
          departureAt: new Date('2026-12-05T14:00:00.000Z'),
          arrivalAt: new Date('2026-12-05T20:00:00.000Z'),
          durationMinutes: 360,
          stopCount: 0,
          sourceVersion: 1, // Stale: booking.version is 3
        },
      });

      // Run reconciliation pass
      const summary = await reconciliationService.reconcileBatch();
      expect(summary).not.toBeNull();
      expect(summary!.repaired).toBeGreaterThanOrEqual(2);

      // Assert booking1 projection created with sourceVersion === 2 and matching details
      const proj1 = await repository.findByBookingId(booking1.id);
      expect(proj1).not.toBeNull();
      expect(proj1!.sourceVersion).toBe(2);
      expect(proj1!.status).toBe(BookingStatus.CONFIRMED);
      expect(proj1!.airline).toBe('British Airways');
      expect(proj1!.origin).toBe('LHR');
      expect(proj1!.destination).toBe('JFK');
      expect(proj1!.flightNumber).toBe('BA 178');

      // Assert booking2 projection repaired to sourceVersion === 3 with stable agentReference
      const proj2 = await repository.findByBookingId(booking2.id);
      expect(proj2).not.toBeNull();
      expect(proj2!.sourceVersion).toBe(3);
      expect(proj2!.status).toBe(BookingStatus.COMPLETED);
      expect(proj2!.agentReference).toBe(initialAgentRef2);
      expect(proj2!.airline).toBe('Delta Air Lines');
      expect(proj2!.origin).toBe('JFK');
      expect(proj2!.destination).toBe('LAX');
      expect(proj2!.flightNumber).toBe('DL 401');
    });
  });

  describe('b) Large Backlog Keyset Pagination', () => {
    it('paginates across >100 candidates with 100 batch limit, advances cursor and resets on reachedEnd', async () => {
      const userId = await createTestUser('pagination');
      const count = 105;

      const intentData = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(),
        userId,
        supplierOfferId: `off_page_${i}_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('100.00'),
        confirmedPrice: new Prisma.Decimal('100.00'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      }));
      await prisma.bookingIntent.createMany({ data: intentData });
      for (const intent of intentData) trackedIntentIds.add(intent.id);

      const flightSnapshot = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T10:00:00.000Z',
            arrivalAt: '2026-11-01T18:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '100',
          },
        ],
      };

      const bookingData = intentData.map((intent) => ({
        id: randomUUID(),
        userId,
        bookingIntentId: intent.id,
        status: BookingStatus.CONFIRMED,
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'GBP',
        version: 1,
        flightSnapshot,
      }));
      await prisma.booking.createMany({ data: bookingData });
      for (const b of bookingData) trackedBookingIds.add(b.id);

      const seededIds = bookingData.map((b) => b.id);
      const scopedRepo = Object.create(repository);
      scopedRepo.findStaleOrMissingBookingIds = async (limit: number, afterBookingId?: string) => {
        const cursor = afterBookingId?.trim() ? afterBookingId.trim() : null;
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT b."id"
          FROM "bookings" b
          LEFT JOIN "booking_agent_projections" p ON p."bookingId" = b."id"
          WHERE b."id" IN (${Prisma.join(seededIds)})
            AND (p."bookingId" IS NULL OR p."source_version" < b."version")
            AND (${cursor}::text IS NULL OR b."id" > ${cursor}::text)
          ORDER BY b."id" ASC
          LIMIT ${limit};
        `;
        const bookingIds = rows.map((r) => r.id);
        const reachedEnd = bookingIds.length < limit;
        const nextCursor = bookingIds.length > 0 ? bookingIds[bookingIds.length - 1] : null;
        return { bookingIds, nextCursor, reachedEnd };
      };
      const scopedReconciler = new BookingProjectionReconciliationService(
        scopedRepo,
        projectionService,
        hydrator,
        metrics,
      );

      // Pass 1: reconcileBatch(100) -> processes 100, returns nextCursor non-null, reachedEnd === false
      const pass1 = await scopedReconciler.reconcileBatch(100);
      expect(pass1).not.toBeNull();
      expect(pass1!.processed).toBe(100);
      expect(pass1!.repaired).toBe(100);
      expect(pass1!.reachedEnd).toBe(false);
      expect(pass1!.nextCursor).not.toBeNull();
      expect(scopedReconciler.getCursor()).toBe(pass1!.nextCursor);

      // Pass 2: reconcileBatch(100) -> processes remaining 5, reachedEnd === true
      const pass2 = await scopedReconciler.reconcileBatch(100);
      expect(pass2).not.toBeNull();
      expect(pass2!.processed).toBe(5);
      expect(pass2!.repaired).toBe(5);
      expect(pass2!.reachedEnd).toBe(true);
      // Cursor resets to undefined for subsequent passes
      expect(scopedReconciler.getCursor()).toBeUndefined();

      // Verify all 105 projections are repaired
      const projectionsCount = await prisma.bookingAgentProjection.count({
        where: { bookingId: { in: bookingData.map((b) => b.id) } },
      });
      expect(projectionsCount).toBe(105);

      // Subsequent pass returns 0 processed, reachedEnd === true, nextCursor === null, cursor remains undefined
      const pass3 = await scopedReconciler.reconcileBatch(100);
      expect(pass3).not.toBeNull();
      expect(pass3!.processed).toBe(0);
      expect(pass3!.reachedEnd).toBe(true);
      expect(pass3!.nextCursor).toBeNull();
      expect(scopedReconciler.getCursor()).toBeUndefined();
    });
  });

  describe('c) Malformed Source Data / Poison Pill Isolation', () => {
    it('isolates poisoned rows (failed/skipped), advances cursor, and repairs valid rows without crashing', async () => {
      const userId = await createTestUser('poison');

      // Generate 4 UUIDs and sort ascending to strictly match KeysetScan ordering
      const [idValid1, idMalformed, idMissingData, idValid2] = [
        randomUUID(),
        randomUUID(),
        randomUUID(),
        randomUUID(),
      ].sort();

      const intent1 = await createTestIntent(userId);
      const intent2 = await createTestIntent(userId);
      const intent3 = await createTestIntent(userId);
      const intent4 = await createTestIntent(userId);

      const flightSnapshot = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T10:00:00.000Z',
            arrivalAt: '2026-11-01T18:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '101',
          },
        ],
      };

      // 1. Valid booking row before poison pill
      await prisma.booking.create({
        data: {
          id: idValid1,
          userId,
          bookingIntentId: intent1,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'GBP',
          status: BookingStatus.CONFIRMED,
          version: 1,
          flightSnapshot,
        },
      });
      trackedBookingIds.add(idValid1);

      // 2. Corrupted booking row (itinerary revision with 0 segments -> MalformedRevisionError -> 'failed')
      await prisma.booking.create({
        data: {
          id: idMalformed,
          userId,
          bookingIntentId: intent2,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'GBP',
          status: BookingStatus.CONFIRMED,
          version: 1,
          itineraryRevisions: {
            create: {
              version: 1,
              source: 'WEBHOOK',
              fingerprint: `fp-${randomUUID()}`,
              incrementalDiff: {},
              cumulativeDiff: {},
              isMaterial: false,
            },
          },
        },
      });
      trackedBookingIds.add(idMalformed);

      // 3. Corrupted booking row (missing flight data entirely -> extractProjectionData returns null -> 'skipped')
      await prisma.booking.create({
        data: {
          id: idMissingData,
          userId,
          bookingIntentId: intent3,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'GBP',
          status: BookingStatus.CONFIRMED,
          version: 1,
          flightSnapshot: Prisma.JsonNull,
        },
      });
      trackedBookingIds.add(idMissingData);

      // 4. Valid booking row after poison pills
      await prisma.booking.create({
        data: {
          id: idValid2,
          userId,
          bookingIntentId: intent4,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'GBP',
          status: BookingStatus.CONFIRMED,
          version: 1,
          flightSnapshot,
        },
      });
      trackedBookingIds.add(idValid2);

      // Run reconciliation pass
      const summary = await reconciliationService.reconcileBatch();
      expect(summary).not.toBeNull();
      expect(summary!.failed).toBeGreaterThanOrEqual(1);
      expect(summary!.skipped).toBeGreaterThanOrEqual(1);
      expect(summary!.repaired).toBeGreaterThanOrEqual(2);

      // Verify both valid rows are repaired
      const pValid1 = await repository.findByBookingId(idValid1);
      expect(pValid1).not.toBeNull();
      expect(pValid1!.sourceVersion).toBe(1);

      const pValid2 = await repository.findByBookingId(idValid2);
      expect(pValid2).not.toBeNull();
      expect(pValid2!.sourceVersion).toBe(1);

      // Verify corrupted rows did not create valid projections
      const pMalformed = await repository.findByBookingId(idMalformed);
      expect(pMalformed).toBeNull();
      const pMissing = await repository.findByBookingId(idMissingData);
      expect(pMissing).toBeNull();

      // Verify metrics recorded failure telemetry
      expect(metrics.getFailureTotal('EXTRACTION_FAILED')).toBeGreaterThanOrEqual(1);
      expect(metrics.getReconciliationSkippedTotal()).toBeGreaterThanOrEqual(1);
    });
  });

  describe('d) 5-Worker Concurrency Bound', () => {
    it('strictly bounds worker execution parallelism to at most 5 concurrent tasks', async () => {
      const userId = await createTestUser('concurrency');
      const count = 15;

      const intentData = Array.from({ length: count }, (_, i) => ({
        id: randomUUID(),
        userId,
        supplierOfferId: `off_conc_${i}_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('100.00'),
        confirmedPrice: new Prisma.Decimal('100.00'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      }));
      await prisma.bookingIntent.createMany({ data: intentData });
      for (const intent of intentData) trackedIntentIds.add(intent.id);

      const flightSnapshot = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T10:00:00.000Z',
            arrivalAt: '2026-11-01T18:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '102',
          },
        ],
      };

      const bookingData = intentData.map((intent) => ({
        id: randomUUID(),
        userId,
        bookingIntentId: intent.id,
        status: BookingStatus.CONFIRMED,
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'GBP',
        version: 1,
        flightSnapshot,
      }));
      await prisma.booking.createMany({ data: bookingData });
      for (const b of bookingData) trackedBookingIds.add(b.id);

      let activeWorkers = 0;
      let maxActiveWorkers = 0;

      const originalUpsert = repository.upsertGuarded.bind(repository);
      jest.spyOn(repository, 'upsertGuarded').mockImplementation(async (params, client) => {
        activeWorkers++;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        // Artificially simulate asynchronous worker execution time
        await new Promise((resolve) => setTimeout(resolve, 30));
        try {
          return await originalUpsert(params, client);
        } finally {
          activeWorkers--;
        }
      });

      const summary = await reconciliationService.reconcileBatch(100);
      expect(summary).not.toBeNull();
      expect(summary!.repaired).toBeGreaterThanOrEqual(15);

      // Strict Concurrency Bound Assertion: maxActiveWorkers MUST NOT exceed 5
      expect(maxActiveWorkers).toBeLessThanOrEqual(5);
      expect(maxActiveWorkers).toBeGreaterThan(1); // Confirms parallel execution occurred
    });
  });

  describe('e) Live Concurrent Mutations & Multi-Replica Safety', () => {
    it('monotonic version fencing prevents older hydrated snapshot from overwriting newer live write', async () => {
      const userId = await createTestUser('live-write');
      const intentId = await createTestIntent(userId);

      const flightSnapshotV1 = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T10:00:00.000Z',
            arrivalAt: '2026-11-01T18:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '100',
          },
        ],
      };

      const flightSnapshotV2 = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T12:00:00.000Z',
            arrivalAt: '2026-11-01T20:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '200',
          },
        ],
      };

      // Seed booking at version 1
      const booking = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId: intentId,
          status: BookingStatus.PROCESSING,
          totalAmount: new Prisma.Decimal('100.00'),
          currency: 'GBP',
          version: 1,
          flightSnapshot: flightSnapshotV1,
        },
      });
      trackedBookingIds.add(booking.id);

      // Seed projection at sourceVersion 0 (stale)
      await repository.upsertGuarded({
        bookingId: booking.id,
        status: 'PROCESSING',
        sourceVersion: 0,
        airline: 'BA',
        flightNumber: '100',
        origin: 'LHR',
        destination: 'JFK',
        departureAt: new Date('2026-11-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-11-01T18:00:00.000Z'),
      });

      const originalHydrate = hydrator.hydrate.bind(hydrator);
      let liveWriteCommitted = false;

      // Hook hydration: when reconciliation reads version 1 snapshot, simulate concurrent live transaction committing version 2
      jest.spyOn(hydrator, 'hydrate').mockImplementation(async (bId, minVersion) => {
        const snapshot = await originalHydrate(bId, minVersion);

        if (bId === booking.id && !liveWriteCommitted) {
          // Live transaction commits version 2
          await prisma.booking.update({
            where: { id: booking.id },
            data: {
              version: 2,
              status: BookingStatus.CONFIRMED,
              flightSnapshot: flightSnapshotV2,
            },
          });

          // Live transaction updates projection to sourceVersion 2
          await repository.upsertGuarded({
            bookingId: booking.id,
            status: BookingStatus.CONFIRMED,
            sourceVersion: 2,
            airline: 'British Airways',
            flightNumber: 'BA 200',
            origin: 'LHR',
            destination: 'JFK',
            departureAt: new Date('2026-11-01T12:00:00.000Z'),
            arrivalAt: new Date('2026-11-01T20:00:00.000Z'),
          });

          liveWriteCommitted = true;
        }

        return snapshot; // Returns snapshot from version 1
      });

      // Run reconciliation pass
      await reconciliationService.reconcileBatch();

      // Verify monotonic version fencing preserved live write (version 2, BA 200) and was not overwritten by version 1
      const projection = await repository.findByBookingId(booking.id);
      expect(projection).not.toBeNull();
      expect(projection!.sourceVersion).toBe(2);
      expect(projection!.flightNumber).toBe('BA 200');
      expect(projection!.status).toBe(BookingStatus.CONFIRMED);
    });

    it('verifies multi-replica reconciliation safety when two reconciler instances process the same candidate, confirming second reconciler returns STALE_IGNORED and counts outcome as current', async () => {
      const userId = await createTestUser('multi-replica');
      const intentId = await createTestIntent(userId);

      const flightSnapshot = {
        stops: 0,
        segments: [
          {
            departureAirport: { iataCode: 'LHR' },
            arrivalAirport: { iataCode: 'JFK' },
            departureAt: '2026-11-01T10:00:00.000Z',
            arrivalAt: '2026-11-01T18:00:00.000Z',
            airline: { name: 'British Airways', iataCode: 'BA' },
            flightNumber: '175',
          },
        ],
      };

      const booking = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId: intentId,
          status: BookingStatus.CONFIRMED,
          totalAmount: new Prisma.Decimal('200.00'),
          currency: 'GBP',
          version: 2,
          flightSnapshot,
        },
      });
      trackedBookingIds.add(booking.id);

      // Seed stale projection at sourceVersion 0 with known agentReference
      const initialAgentRef = `bkref_${randomUUID()}`;
      await repository.upsertGuarded({
        bookingId: booking.id,
        status: 'CONFIRMED',
        sourceVersion: 0,
        airline: 'British Airways',
        flightNumber: '175',
        origin: 'LHR',
        destination: 'JFK',
        departureAt: new Date('2026-11-01T10:00:00.000Z'),
        arrivalAt: new Date('2026-11-01T18:00:00.000Z'),
        agentReference: initialAgentRef,
      });

      // Two reconciler instances representing Replica A and Replica B
      const replicaA = new BookingProjectionReconciliationService(
        repository,
        projectionService,
        hydrator,
        new BookingProjectionMetrics(),
      );
      const replicaB = new BookingProjectionReconciliationService(
        repository,
        projectionService,
        hydrator,
        new BookingProjectionMetrics(),
      );

      // Scoped repository for this candidate ID
      const scopedRepo = Object.create(repository);
      scopedRepo.findStaleOrMissingBookingIds = async () => ({
        bookingIds: [booking.id],
        nextCursor: null,
        reachedEnd: true,
      });

      const reconcilerA = new BookingProjectionReconciliationService(
        scopedRepo,
        projectionService,
        hydrator,
        new BookingProjectionMetrics(),
      );
      const reconcilerB = new BookingProjectionReconciliationService(
        scopedRepo,
        projectionService,
        hydrator,
        new BookingProjectionMetrics(),
      );

      // Replica A reconciles the candidate -> repairs it to sourceVersion 2
      const resA = await reconcilerA.reconcileBatch(10);
      expect(resA).not.toBeNull();
      expect(resA!.repaired).toBe(1);
      expect(resA!.current).toBe(0);

      // Replica B concurrently/sequentially reconciles the same candidate -> projection already at sourceVersion 2
      // Upsert returns STALE_IGNORED, classified as 'current'
      const resB = await reconcilerB.reconcileBatch(10);
      expect(resB).not.toBeNull();
      expect(resB!.repaired).toBe(0);
      expect(resB!.current).toBe(1);
      expect(resB!.failed).toBe(0);
      expect(resB!.skipped).toBe(0);

      // Verify projection remains intact with stable agentReference
      const projection = await repository.findByBookingId(booking.id);
      expect(projection).not.toBeNull();
      expect(projection!.sourceVersion).toBe(2);
      expect(projection!.agentReference).toBe(initialAgentRef);
    });
  });

  describe('f) Zero Provider Calls Invariant', () => {
    it('makes zero external HTTP/HTTPS calls to Stripe, Duffel, or external providers during reconciliation', async () => {
      const userId = await createTestUser('zero-provider');
      const intentId = await createTestIntent(userId);

      const booking = await prisma.booking.create({
        data: {
          userId,
          bookingIntentId: intentId,
          status: BookingStatus.CONFIRMED,
          totalAmount: new Prisma.Decimal('150.00'),
          currency: 'GBP',
          version: 1,
          flightSnapshot: {
            stops: 0,
            segments: [
              {
                departureAirport: { iataCode: 'LHR' },
                arrivalAirport: { iataCode: 'JFK' },
                departureAt: '2026-11-01T10:00:00.000Z',
                arrivalAt: '2026-11-01T18:00:00.000Z',
                airline: { name: 'British Airways', iataCode: 'BA' },
                flightNumber: '100',
              },
            ],
          },
        },
      });
      trackedBookingIds.add(booking.id);

      // Spy on fetch to ensure no outbound provider calls are made
      const fetchSpy = jest.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      try {
        const summary = await reconciliationService.reconcileBatch();
        expect(summary).not.toBeNull();
        expect(summary!.repaired).toBeGreaterThanOrEqual(1);

        // Zero provider calls invariant
        expect(fetchSpy).not.toHaveBeenCalled();

        const proj = await repository.findByBookingId(booking.id);
        expect(proj).not.toBeNull();
        expect(proj!.sourceVersion).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('g) SchedulerRegistry Cron Registration', () => {
    it('registers the named cron job in SchedulerRegistry allowing runtime pause', () => {
      const schedulerRegistry = app.get(SchedulerRegistry);
      expect(schedulerRegistry.doesExist('cron', 'BookingProjectionReconciliationService')).toBe(true);
      const cronJob = schedulerRegistry.getCronJob('BookingProjectionReconciliationService');
      expect(cronJob).toBeDefined();
    });
  });
});
