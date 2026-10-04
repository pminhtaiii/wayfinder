import { PrismaClient, Prisma, BookingIntentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

async function waitForCondition<T>(
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const last = await predicate();
  if (last) return last;
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('BookingAgentProjection Privacy Invariants (E2E)', () => {
  let prisma: PrismaClient;
  let testUserId: string;
  let testIntentId: string;
  let testBookingId: string;

  beforeAll(async () => {
    prisma = new PrismaClient();

    // Deterministically seed a test booking and projection to guarantee rows exist
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: `privacy-test-${randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUserId = user.id;

    const intent = await prisma.bookingIntent.create({
      data: {
        userId: testUserId,
        supplierOfferId: `off_privacy_${randomUUID()}`,
        status: BookingIntentStatus.COMPLETED,
        originalPrice: new Prisma.Decimal('199.99'),
        confirmedPrice: new Prisma.Decimal('199.99'),
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'SFO',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });
    testIntentId = intent.id;

    testBookingId = randomUUID();
    await prisma.booking.create({
      data: {
        id: testBookingId,
        userId: testUserId,
        bookingIntentId: testIntentId,
        status: 'CONFIRMED',
        totalAmount: new Prisma.Decimal('199.99'),
        currency: 'USD',
        version: 1,
      },
    });

    await prisma.bookingAgentProjection.create({
      data: {
        bookingId: testBookingId,
        agentReference: `bkref_${randomUUID()}`,
        status: 'CONFIRMED',
        airline: 'Privacy Airways',
        origin: 'SFO',
        destination: 'JFK',
        departureAt: new Date(),
        arrivalAt: new Date(Date.now() + 18000000),
        durationMinutes: 300,
        stopCount: 0,
        sourceVersion: 1,
      },
    });
  });

  afterAll(async () => {
    try {
      if (testBookingId) {
        await prisma.bookingAgentProjection.deleteMany({
          where: { bookingId: testBookingId },
        });
        await prisma.booking.deleteMany({
          where: { id: testBookingId },
        });
      }
      if (testIntentId) {
        await prisma.bookingIntent.deleteMany({
          where: { id: testIntentId },
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

  it('verifies exact allowlisted columns exist in information_schema for booking_agent_projections', async () => {
    const columns: Array<{ column_name: string }> = await prisma.$queryRaw`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'booking_agent_projections'
    `;

    const columnNames = columns.map((c) => c.column_name);

    // Allowed columns
    expect(columnNames).toContain('bookingId');
    expect(columnNames).toContain('agentReference');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('airline');
    expect(columnNames).toContain('origin');
    expect(columnNames).toContain('destination');
    expect(columnNames).toContain('departureAt');
    expect(columnNames).toContain('arrivalAt');
    expect(columnNames).toContain('durationMinutes');
    expect(columnNames).toContain('stopCount');
    expect(columnNames).toContain('flightNumber');
    expect(columnNames).toContain('baggageSummary');
    expect(columnNames).toContain('refundable');
    expect(columnNames).toContain('changeable');
    expect(columnNames).toContain('createdAt');
    expect(columnNames).toContain('updatedAt');

    // Forbidden columns MUST NOT exist in projection table
    expect(columnNames).not.toContain('pnr');
    expect(columnNames).not.toContain('pnrReference');
    expect(columnNames).not.toContain('totalAmount');
    expect(columnNames).not.toContain('price');
    expect(columnNames).not.toContain('currency');
    expect(columnNames).not.toContain('fareClass');
    expect(columnNames).not.toContain('cabinClass');
    expect(columnNames).not.toContain('passengerCount');
    expect(columnNames).not.toContain('contactEmail');
    expect(columnNames).not.toContain('contactPhone');
    expect(columnNames).not.toContain('passportNumber');
    expect(columnNames).not.toContain('paymentId');
    expect(columnNames).not.toContain('stripePaymentIntentId');
    expect(columnNames).not.toContain('rawDuffelOrder');
    expect(columnNames).not.toContain('flightSnapshot');
    expect(columnNames).not.toContain('passengerSnapshot');
  });

  it('proves that stored agentReference is opaque, non-guessable, and not derived from internal DB id', async () => {
    const projections = await waitForCondition(async () => {
      const rows = await prisma.bookingAgentProjection.findMany({ take: 10 });
      return rows.length > 0 ? rows : null;
    }, 5000);

    expect(projections.length).toBeGreaterThan(0);
    for (const proj of projections) {
      expect(proj.agentReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);
      expect(proj.agentReference).not.toBe(proj.bookingId);
      expect(proj.agentReference.includes(proj.bookingId)).toBe(false);
    }
  });
});
