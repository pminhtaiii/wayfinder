import { PrismaClient, Prisma, BookingIntentStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { backfillBookingAgentProjections } from '../prisma/scripts/backfill-booking-agent-projections';

describe('BookingAgentProjection Backfill (E2E)', () => {
  let prisma: PrismaClient;
  let testUserId: string;
  const createdBookingIds: string[] = [];
  const createdIntentIds: string[] = [];

  async function createTestIntent(): Promise<string> {
    const intent = await prisma.bookingIntent.create({
      data: {
        userId: testUserId,
        supplierOfferId: `off_backfill_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('250.00'),
        confirmedPrice: new Prisma.Decimal('250.00'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });
    createdIntentIds.push(intent.id);
    return intent.id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();

    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `backfill-test-${randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUserId = user.id;
  });

  afterAll(async () => {
    try {
      if (createdBookingIds.length > 0) {
        await prisma.bookingAgentProjection.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.itineraryRevisionSegment.deleteMany({
          where: { revision: { bookingId: { in: createdBookingIds } } },
        });
        await prisma.itineraryRevision.deleteMany({
          where: { bookingId: { in: createdBookingIds } },
        });
        await prisma.booking.deleteMany({
          where: { id: { in: createdBookingIds } },
        });
      }
      if (createdIntentIds.length > 0) {
        await prisma.bookingIntent.deleteMany({
          where: { id: { in: createdIntentIds } },
        });
      }
      if (testUserId) {
        await prisma.user.deleteMany({
          where: { id: testUserId },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  });

  it('runs backfill script and creates projections for existing bookings', async () => {
    const bookingId = randomUUID();
    createdBookingIds.push(bookingId);

    const departureAt = new Date('2026-10-15T08:00:00Z');
    const arrivalAt = new Date('2026-10-15T16:00:00Z');
    const intentId = await createTestIntent();

    await prisma.booking.create({
      data: {
        id: bookingId,
        userId: testUserId,
        bookingIntentId: intentId,
        status: 'CONFIRMED',
        totalAmount: new Prisma.Decimal('250.00'),
        currency: 'GBP',
        version: 1,
        flightSnapshot: {
          stops: 0,
          segments: [
            {
              departureAirport: { iataCode: 'LHR' },
              arrivalAirport: { iataCode: 'JFK' },
              departureAt: departureAt.toISOString(),
              arrivalAt: arrivalAt.toISOString(),
              airline: { name: 'British Airways', iataCode: 'BA' },
              flightNumber: '117',
            },
          ],
        },
      },
    });

    const result = await backfillBookingAgentProjections(prisma);
    expect(result).toBeDefined();
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const projection = await prisma.bookingAgentProjection.findUnique({
      where: { bookingId },
    });
    expect(projection).not.toBeNull();
    expect(projection!.agentReference).toMatch(/^bkref_/);
    expect(projection!.status).toBe('CONFIRMED');
    expect(projection!.airline).toBe('British Airways');
    expect(projection!.origin).toBe('LHR');
    expect(projection!.destination).toBe('JFK');
    expect(projection!.flightNumber).toBe('BA 117');
    expect(projection!.sourceVersion).toBe(1);
  });

  it('is idempotent when re-run (updates 0 projections, preserves identical agentReference, no duplicates)', async () => {
    const beforeProjections = await prisma.bookingAgentProjection.findMany({
      where: { bookingId: { in: createdBookingIds } },
    });
    expect(beforeProjections.length).toBeGreaterThan(0);

    const referenceMapBefore = new Map(
      beforeProjections.map((p) => [p.bookingId, p.agentReference]),
    );
    const updatedAtMapBefore = new Map(
      beforeProjections.map((p) => [p.bookingId, p.updatedAt.getTime()]),
    );

    // Second backfill run on fresh (already up to date) projections
    const rerunStats = await backfillBookingAgentProjections(prisma);
    expect(rerunStats).toBeDefined();
    // Updates 0 projections because source_version < EXCLUDED.source_version evaluates to false
    expect(rerunStats.success).toBe(0);

    const afterProjections = await prisma.bookingAgentProjection.findMany({
      where: { bookingId: { in: createdBookingIds } },
    });
    expect(afterProjections.length).toBe(beforeProjections.length);

    for (const proj of afterProjections) {
      expect(proj.agentReference).toBe(referenceMapBefore.get(proj.bookingId));
      expect(proj.updatedAt.getTime()).toBe(updatedAtMapBefore.get(proj.bookingId));
    }
  });

  it('version fencing: does not overwrite projection with lower or equal sourceVersion', async () => {
    const bookingId = randomUUID();
    createdBookingIds.push(bookingId);

    const departureAt = new Date('2026-11-01T10:00:00Z');
    const arrivalAt = new Date('2026-11-01T14:00:00Z');
    const intentId = await createTestIntent();

    // Booking is version 1, status CONFIRMED
    await prisma.booking.create({
      data: {
        id: bookingId,
        userId: testUserId,
        bookingIntentId: intentId,
        status: 'CONFIRMED',
        totalAmount: new Prisma.Decimal('300.00'),
        currency: 'USD',
        version: 1,
        itineraryRevisions: {
          create: {
            source: 'WEBHOOK',
            version: 1,
            fingerprint: `fp-${randomUUID()}`,
            incrementalDiff: {},
            cumulativeDiff: {},
            isMaterial: false,
            segments: {
              create: [
                {
                  supplierSegmentId: `seg_${randomUUID()}`,
                  airlineName: 'United Airlines',
                  marketingCarrierIata: 'UA',
                  operatingCarrierIata: 'UA',
                  flightNumber: '500',
                  departureAirportIata: 'ORD',
                  departureAirportName: "O'Hare International Airport",
                  departureCity: 'Chicago',
                  departureLocalDate: new Date('2026-11-01'),
                  arrivalAirportIata: 'LAX',
                  arrivalAirportName: 'Los Angeles International Airport',
                  arrivalCity: 'Los Angeles',
                  arrivalLocalDate: new Date('2026-11-01'),
                  departureAt,
                  arrivalAt,
                  durationMinutes: 240,
                  globalOrder: 0,
                  sliceOrder: 0,
                  segmentOrder: 0,
                },
              ],
            },
          },
        },
      },
    });

    // Seed existing projection with HIGHER source_version: 5, and CANCELLED status
    const existingRef = `bkref_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await prisma.bookingAgentProjection.create({
      data: {
        bookingId,
        agentReference: existingRef,
        status: 'CANCELLED',
        airline: 'Disrupted Airline',
        origin: 'ORD',
        destination: 'SFO',
        departureAt,
        arrivalAt,
        durationMinutes: 240,
        stopCount: 0,
        sourceVersion: 5,
      },
    });

    // Run backfill (should attempt to backfill version 1 from booking)
    const stats = await backfillBookingAgentProjections(prisma);
    expect(stats).toBeDefined();

    // Verify projection was NOT overwritten with version 1
    const projection = await prisma.bookingAgentProjection.findUniqueOrThrow({
      where: { bookingId },
    });
    expect(projection.sourceVersion).toBe(5);
    expect(projection.status).toBe('CANCELLED');
    expect(projection.airline).toBe('Disrupted Airline');
    expect(projection.agentReference).toBe(existingRef);
  });

  it('missing/malformed flight data handling: skipped safely without crashing script', async () => {
    // 1. Booking without segments or flightSnapshot
    const emptyBookingId = randomUUID();
    createdBookingIds.push(emptyBookingId);
    const intentId1 = await createTestIntent();
    await prisma.booking.create({
      data: {
        id: emptyBookingId,
        userId: testUserId,
        bookingIntentId: intentId1,
        status: 'PROCESSING',
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'USD',
        version: 1,
        flightSnapshot: Prisma.DbNull,
      },
    });

    // 2. Booking with malformed itineraryRevision (0 segments)
    const malformedBookingId = randomUUID();
    createdBookingIds.push(malformedBookingId);
    const intentId2 = await createTestIntent();
    await prisma.booking.create({
      data: {
        id: malformedBookingId,
        userId: testUserId,
        bookingIntentId: intentId2,
        status: 'PROCESSING',
        totalAmount: new Prisma.Decimal('150.00'),
        currency: 'USD',
        version: 1,
        itineraryRevisions: {
          create: {
            source: 'BOOTSTRAP',
            version: 1,
            fingerprint: `fp-${randomUUID()}`,
            incrementalDiff: {},
            cumulativeDiff: {},
            isMaterial: false,
          },
        },
      },
    });

    // Run backfill - MUST not crash/throw
    const stats = await backfillBookingAgentProjections(prisma);
    expect(stats).toBeDefined();
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(stats.failed).toBeGreaterThanOrEqual(1);

    // Assert neither got a projection created
    const emptyProj = await prisma.bookingAgentProjection.findUnique({
      where: { bookingId: emptyBookingId },
    });
    expect(emptyProj).toBeNull();

    const malformedProj = await prisma.bookingAgentProjection.findUnique({
      where: { bookingId: malformedBookingId },
    });
    expect(malformedProj).toBeNull();
  });
});
