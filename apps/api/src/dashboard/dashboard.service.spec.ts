import { BookingStatus } from '@prisma/client';
import type { DashboardStats, DashboardSummary } from '@shared/types';
import { PrismaService } from '@/prisma/prisma.service';
import { DashboardService } from './dashboard.service';

describe('DashboardService (T009)', () => {
  let service: DashboardService;
  let prisma: {
    booking: {
      count: jest.Mock;
      findMany: jest.Mock;
    };
  };

  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    prisma = {
      booking: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
    };

    // Default mock implementations returning zero counts and empty recent bookings
    prisma.booking.count.mockResolvedValue(0);
    prisma.booking.findMany.mockResolvedValue([]);

    service = new DashboardService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('Single Clock Instant (now)', () => {
    it('captures now = new Date() once and reuses the exact same Date instance across upcoming/completed filters and generatedAt', async () => {
      const fixedInstant = new Date('2026-08-29T10:00:00.000Z');
      jest.useFakeTimers();
      jest.setSystemTime(fixedInstant);

      prisma.booking.count
        .mockResolvedValueOnce(10) // totalBookings
        .mockResolvedValueOnce(3) // upcomingBookings
        .mockResolvedValueOnce(5) // completedBookings
        .mockResolvedValueOnce(2); // cancelledBookings

      const result: DashboardSummary = await service.getSummary(userId);

      expect(result.generatedAt).toBe(fixedInstant.toISOString());

      // Verify upcoming count query used departureAt: { gte: fixedInstant }
      const upcomingCall = prisma.booking.count.mock.calls.find(
        ([args]) =>
          args?.where?.status === BookingStatus.CONFIRMED && args?.where?.departureAt?.gte,
      );
      expect(upcomingCall).toBeDefined();
      expect(upcomingCall[0].where.departureAt.gte.toISOString()).toBe(fixedInstant.toISOString());

      // Verify completed count query used departureAt: { lt: fixedInstant }
      const completedCall = prisma.booking.count.mock.calls.find(([args]) => {
        const orConditions = args?.where?.OR;
        return (
          Array.isArray(orConditions) &&
          orConditions.some(
            (c: { status?: BookingStatus; departureAt?: { lt?: Date } }) =>
              c.status === BookingStatus.CONFIRMED && c.departureAt?.lt,
          )
        );
      });
      expect(completedCall).toBeDefined();
      const completedConfirmedBranch = completedCall[0].where.OR.find(
        (c: { status?: BookingStatus; departureAt?: { lt?: Date } }) =>
          c.status === BookingStatus.CONFIRMED,
      );
      expect(completedConfirmedBranch.departureAt.lt.toISOString()).toBe(
        fixedInstant.toISOString(),
      );
    });
  });

  describe('Four Computed Metrics', () => {
    it('executes the 4 precise count queries with expected Prisma filters and maps stats', async () => {
      const fixedInstant = new Date('2026-08-29T12:00:00.000Z');
      jest.useFakeTimers();
      jest.setSystemTime(fixedInstant);

      prisma.booking.count
        .mockResolvedValueOnce(20) // total
        .mockResolvedValueOnce(4) // upcoming
        .mockResolvedValueOnce(12) // completed
        .mockResolvedValueOnce(3); // cancelled

      const result = await service.getSummary(userId);

      expect(result.stats).toEqual<DashboardStats>({
        totalBookings: 20,
        upcomingBookings: 4,
        completedBookings: 12,
        cancelledBookings: 3,
      });

      // 1. Total bookings count filter: owner only
      expect(prisma.booking.count).toHaveBeenCalledWith({
        where: { userId },
      });

      // 2. Upcoming bookings count filter: CONFIRMED + departureAt >= now
      expect(prisma.booking.count).toHaveBeenCalledWith({
        where: {
          userId,
          status: BookingStatus.CONFIRMED,
          departureAt: { gte: fixedInstant },
        },
      });

      // 3. Completed bookings count filter: COMPLETED OR (CONFIRMED + departureAt < now)
      expect(prisma.booking.count).toHaveBeenCalledWith({
        where: {
          userId,
          OR: [
            { status: BookingStatus.COMPLETED },
            { status: BookingStatus.CONFIRMED, departureAt: { lt: fixedInstant } },
          ],
        },
      });

      // 4. Cancelled bookings count filter: all 5 cancellation lifecycle statuses
      expect(prisma.booking.count).toHaveBeenCalledWith({
        where: {
          userId,
          status: {
            in: [
              BookingStatus.CANCELLATION_PENDING,
              BookingStatus.CANCELLED_PENDING_REFUND,
              BookingStatus.CANCELLED_AND_REFUNDED,
              BookingStatus.CANCELLED_NO_REFUND,
              BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
            ],
          },
        },
      });
    });
  });

  describe('Null Departure Handling', () => {
    it('ensures confirmed bookings with departureAt: null count toward totalBookings, but neither upcoming nor completed', async () => {
      const fixedInstant = new Date('2026-08-29T12:00:00.000Z');
      jest.useFakeTimers();
      jest.setSystemTime(fixedInstant);

      // In relational/Prisma SQL semantics, `departureAt >= now` and `departureAt < now` both evaluate to false for NULL.
      // Total count has no departureAt constraint so null departureAt is included.
      await service.getSummary(userId);

      const totalCall = prisma.booking.count.mock.calls.find(
        ([args]) => args?.where?.userId === userId && Object.keys(args.where).length === 1,
      );
      expect(totalCall).toBeDefined();

      const upcomingCall = prisma.booking.count.mock.calls.find(
        ([args]) =>
          args?.where?.status === BookingStatus.CONFIRMED && args?.where?.departureAt?.gte,
      );
      expect(upcomingCall[0].where.departureAt.gte).toEqual(fixedInstant);

      const completedCall = prisma.booking.count.mock.calls.find(([args]) =>
        Array.isArray(args?.where?.OR),
      );
      const confBranch = completedCall[0].where.OR.find(
        (b: { status?: BookingStatus }) => b.status === BookingStatus.CONFIRMED,
      );
      expect(confBranch.departureAt.lt).toEqual(fixedInstant);
    });
  });

  describe('Boundary Equality', () => {
    it('classifies departureAt === now as upcomingBookings (gte), not completedBookings (lt)', async () => {
      const fixedInstant = new Date('2026-08-29T12:00:00.000Z');
      jest.useFakeTimers();
      jest.setSystemTime(fixedInstant);

      await service.getSummary(userId);

      // Verify gte is used for upcoming
      const upcomingCall = prisma.booking.count.mock.calls.find(
        ([args]) =>
          args?.where?.status === BookingStatus.CONFIRMED && args?.where?.departureAt?.gte,
      );
      expect(upcomingCall[0].where.departureAt.gte).toEqual(fixedInstant);
      expect(upcomingCall[0].where.departureAt.gt).toBeUndefined();

      // Verify lt is used for completed
      const completedCall = prisma.booking.count.mock.calls.find(([args]) =>
        Array.isArray(args?.where?.OR),
      );
      const confBranch = completedCall[0].where.OR.find(
        (b: { status?: BookingStatus }) => b.status === BookingStatus.CONFIRMED,
      );
      expect(confBranch.departureAt.lt).toEqual(fixedInstant);
      expect(confBranch.departureAt.lte).toBeUndefined();
    });
  });

  describe('Concurrent Query Execution', () => {
    it('executes all 4 count queries and 1 findMany query concurrently via Promise.all', async () => {
      let activeCalls = 0;
      let maxConcurrentCalls = 0;

      const trackConcurrency = async () => {
        activeCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        // Small async pause to allow all concurrent promises to join the event loop
        await new Promise((resolve) => setImmediate(resolve));
        activeCalls--;
        return 0;
      };

      prisma.booking.count.mockImplementation(trackConcurrency);
      prisma.booking.findMany.mockImplementation(async () => {
        activeCalls++;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setImmediate(resolve));
        activeCalls--;
        return [];
      });

      await service.getSummary(userId);

      expect(prisma.booking.count).toHaveBeenCalledTimes(4);
      expect(prisma.booking.findMany).toHaveBeenCalledTimes(1);
      // All 5 queries should have been in flight concurrently
      expect(maxConcurrentCalls).toBe(5);
    });
  });

  describe('Recent Bookings Ordering & Cap', () => {
    it('queries findMany with take: 5, descending order by createdAt, and strictly owner scoped', async () => {
      const mockCreatedAt1 = new Date('2026-08-28T14:00:00.000Z');
      const mockCreatedAt2 = new Date('2026-08-27T10:00:00.000Z');

      const mockDbBookings = [
        {
          id: '22222222-2222-4222-8222-222222222222',
          userId,
          status: BookingStatus.CONFIRMED,
          createdAt: mockCreatedAt1,
          departureAt: new Date('2026-09-01T08:00:00.000Z'),
          flightSnapshot: {
            segments: [
              {
                departureAirport: { iataCode: 'LHR' },
                arrivalAirport: { iataCode: 'JFK' },
                airline: { iataCode: 'BA' },
                flightNumber: 'BA178',
              },
            ],
          },
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          userId,
          status: BookingStatus.COMPLETED,
          createdAt: mockCreatedAt2,
          departureAt: new Date('2026-08-01T08:00:00.000Z'),
          flightSnapshot: {
            originCode: 'CDG',
            destinationCode: 'HND',
            airlineCode: 'AF',
            flightNumber: 'AF274',
          },
        },
      ];

      prisma.booking.findMany.mockResolvedValueOnce(mockDbBookings);

      const result = await service.getSummary(userId);

      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: { userId },
        take: 5,
        orderBy: expect.anything(),
      });

      // Verify orderBy includes createdAt desc
      const findManyCall = prisma.booking.findMany.mock.calls[0][0];
      const orderBy = findManyCall.orderBy;
      if (Array.isArray(orderBy)) {
        expect(orderBy).toEqual(expect.arrayContaining([{ createdAt: 'desc' }]));
      } else {
        expect(orderBy).toEqual(expect.objectContaining({ createdAt: 'desc' }));
      }

      expect(result.recentBookings).toHaveLength(2);
      expect(result.recentBookings[0].id).toBe('22222222-2222-4222-8222-222222222222');
      expect(result.recentBookings[0].createdAt).toBe(mockCreatedAt1.toISOString());
      expect(result.recentBookings[1].id).toBe('33333333-3333-4333-8333-333333333333');
      expect(result.recentBookings[1].createdAt).toBe(mockCreatedAt2.toISOString());
    });

    it('returns at most 5 recent bookings even when database returns 5', async () => {
      const fiveBookings = Array.from({ length: 5 }, (_, i) => ({
        id: `00000000-0000-4000-8000-00000000000${i}`,
        userId,
        status: BookingStatus.CONFIRMED,
        createdAt: new Date(`2026-08-2${i}T00:00:00.000Z`),
        departureAt: new Date(`2026-09-2${i}T00:00:00.000Z`),
        flightSnapshot: null,
      }));

      prisma.booking.findMany.mockResolvedValueOnce(fiveBookings);

      const result = await service.getSummary(userId);
      expect(result.recentBookings.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Defensive Snapshot Display Mapper', () => {
    it('extracts flight display fields from standard segment-based snapshot structure', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: '44444444-4444-4444-8444-444444444444',
          userId,
          status: BookingStatus.CONFIRMED,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          departureAt: new Date('2026-09-10T10:00:00.000Z'),
          flightSnapshot: {
            segments: [
              {
                departureAirport: { iataCode: 'SFO' },
                arrivalAirport: { iataCode: 'ORD' },
                airline: { iataCode: 'UA' },
                flightNumber: 'UA234',
              },
            ],
          },
        },
      ]);

      const result = await service.getSummary(userId);
      const recent = result.recentBookings[0];

      expect(recent.originCode).toBe('SFO');
      expect(recent.destinationCode).toBe('ORD');
      expect(recent.airlineCode).toBe('UA');
      expect(recent.flightNumber).toBe('UA234');
    });

    it('extracts multi-segment itinerary: origin from first segment, destination from last segment', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: '55555555-5555-4555-8555-555555555555',
          userId,
          status: BookingStatus.CONFIRMED,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          departureAt: new Date('2026-09-10T10:00:00.000Z'),
          flightSnapshot: {
            segments: [
              {
                departureAirport: { iataCode: 'LHR' },
                arrivalAirport: { iataCode: 'DXB' },
                airline: { iataCode: 'EK' },
                flightNumber: 'EK002',
              },
              {
                departureAirport: { iataCode: 'DXB' },
                arrivalAirport: { iataCode: 'SIN' },
                airline: { iataCode: 'EK' },
                flightNumber: 'EK354',
              },
            ],
          },
        },
      ]);

      const result = await service.getSummary(userId);
      const recent = result.recentBookings[0];

      expect(recent.originCode).toBe('LHR');
      expect(recent.destinationCode).toBe('SIN');
      expect(recent.airlineCode).toBe('EK');
      expect(recent.flightNumber).toBe('EK002');
    });

    it('extracts flight display fields from slice-based Duffel-like snapshot structure', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: '66666666-6666-4666-8666-666666666666',
          userId,
          status: BookingStatus.CONFIRMED,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          departureAt: new Date('2026-09-10T10:00:00.000Z'),
          flightSnapshot: {
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SYD' },
                    destination: { iata_code: 'LAX' },
                    operating_carrier: { iata_code: 'QF' },
                    marketing_carrier_flight_number: '11',
                  },
                ],
              },
            ],
          },
        },
      ]);

      const result = await service.getSummary(userId);
      const recent = result.recentBookings[0];

      expect(recent.originCode).toBe('SYD');
      expect(recent.destinationCode).toBe('LAX');
      expect(recent.airlineCode).toBe('QF');
      expect(recent.flightNumber).toBe('11');
    });

    it('extracts flight display fields from direct flat snapshot structure', async () => {
      prisma.booking.findMany.mockResolvedValueOnce([
        {
          id: '77777777-7777-4777-8777-777777777777',
          userId,
          status: BookingStatus.CONFIRMED,
          createdAt: new Date('2026-08-20T10:00:00.000Z'),
          departureAt: new Date('2026-09-10T10:00:00.000Z'),
          flightSnapshot: {
            originCode: 'NRT',
            destinationCode: 'ICN',
            airlineCode: 'KE',
            flightNumber: 'KE704',
          },
        },
      ]);

      const result = await service.getSummary(userId);
      const recent = result.recentBookings[0];

      expect(recent.originCode).toBe('NRT');
      expect(recent.destinationCode).toBe('ICN');
      expect(recent.airlineCode).toBe('KE');
      expect(recent.flightNumber).toBe('KE704');
    });

    it('safely handles null, undefined, empty object, string, array, or corrupted snapshot JSON without throwing', async () => {
      const corruptTestCases = [
        null,
        undefined,
        {},
        'corrupted-string-json',
        12345,
        [],
        { segments: 'not-an-array' },
        { segments: [] },
        { slices: [] },
        { segments: [{}] },
        { slices: [{ segments: [] }] },
      ];

      for (let i = 0; i < corruptTestCases.length; i++) {
        prisma.booking.findMany.mockResolvedValueOnce([
          {
            id: `88888888-8888-4888-8888-88888888888${i % 10}`,
            userId,
            status: BookingStatus.CONFIRMED,
            createdAt: new Date('2026-08-20T10:00:00.000Z'),
            departureAt: null,
            flightSnapshot: corruptTestCases[i],
          },
        ]);

        const result = await service.getSummary(userId);
        expect(result.recentBookings).toHaveLength(1);
        const booking = result.recentBookings[0];
        expect(booking.originCode).toBeNull();
        expect(booking.destinationCode).toBeNull();
        expect(booking.airlineCode).toBeNull();
        expect(booking.flightNumber).toBeNull();
        expect(booking.departureAt).toBeNull();
      }
    });

    it('prohibits PII, payment secrets, raw snapshots, and Duffel IDs from leaking into returned objects', async () => {
      const sensitiveDbBooking = {
        id: '99999999-9999-4999-8999-999999999999',
        userId,
        bookingIntentId: 'intent-secret-123',
        paymentId: 'pay_secret_stripe_999',
        status: BookingStatus.CONFIRMED,
        failureReason: null,
        pnrReference: 'PNR_SECRET_ABC',
        supplierOrderId: 'ord_secret_duffel_123',
        flightSnapshot: {
          segments: [
            {
              departureAirport: { iataCode: 'LHR' },
              arrivalAirport: { iataCode: 'JFK' },
              airline: { iataCode: 'BA' },
              flightNumber: 'BA178',
            },
          ],
        },
        passengerSnapshot: {
          passengers: [
            { firstName: 'SecretFirst', lastName: 'SecretLast', passportNumber: 'PASS12345' },
          ],
        },
        totalAmount: '450.00',
        currency: 'GBP',
        departureAt: new Date('2026-09-15T12:00:00.000Z'),
        cancellationDeadline: new Date('2026-09-14T12:00:00.000Z'),
        cancellationRefundable: true,
        airlineRefundAmount: '400.00',
        customerRefundAmount: '400.00',
        supplierCancellationQuoteId: 'cquo_secret_123',
        createdAt: new Date('2026-08-25T10:00:00.000Z'),
        updatedAt: new Date('2026-08-25T10:00:00.000Z'),
      };

      prisma.booking.findMany.mockResolvedValueOnce([sensitiveDbBooking]);

      const result = await service.getSummary(userId);
      const recent = result.recentBookings[0] as unknown as Record<string, unknown>;

      const allowedKeys = new Set([
        'id',
        'status',
        'createdAt',
        'departureAt',
        'originCode',
        'destinationCode',
        'airlineCode',
        'flightNumber',
      ]);

      const returnedKeys = Object.keys(recent);
      expect(returnedKeys.sort()).toEqual(Array.from(allowedKeys).sort());

      // Explicitly verify sensitive fields are undefined on the returned object
      expect(recent.userId).toBeUndefined();
      expect(recent.pnrReference).toBeUndefined();
      expect(recent.duffelOrderId).toBeUndefined();
      expect(recent.paymentId).toBeUndefined();
      expect(recent.passengerSnapshot).toBeUndefined();
      expect(recent.flightSnapshot).toBeUndefined();
      expect(recent.totalAmount).toBeUndefined();
      expect(recent.currency).toBeUndefined();
      expect(recent.duffelCancellationQuoteId).toBeUndefined();
      expect(recent.customerRefundAmount).toBeUndefined();
    });
  });

  describe('Tenant Isolation', () => {
    it('strictly scopes every single Prisma query (all 4 counts + findMany) to the given userId', async () => {
      const userAlpha = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const userBeta = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

      await service.getSummary(userAlpha);

      // Verify all count queries used userAlpha
      for (const call of prisma.booking.count.mock.calls) {
        expect(call[0].where.userId).toBe(userAlpha);
      }
      // Verify findMany query used userAlpha
      expect(prisma.booking.findMany.mock.calls[0][0].where.userId).toBe(userAlpha);

      jest.clearAllMocks();

      await service.getSummary(userBeta);

      // Verify all count queries used userBeta
      for (const call of prisma.booking.count.mock.calls) {
        expect(call[0].where.userId).toBe(userBeta);
      }
      // Verify findMany query used userBeta
      expect(prisma.booking.findMany.mock.calls[0][0].where.userId).toBe(userBeta);
    });
  });
});
