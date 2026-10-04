process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, Prisma } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { PrismaService } from '@/prisma/prisma.service';

describe('Dashboard (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let userA: { id: string; email: string };
  let userB: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;

  beforeAll(async (): Promise<void> => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async (): Promise<void> => {
    await app.close();
  });

  const cleanupDatabase = async (): Promise<void> => {
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
    await prisma.itineraryRevisionSegment.deleteMany({});
    await prisma.itineraryRevision.deleteMany({});
    await prisma.disruptionAuditEvent.deleteMany({});
    await prisma.notificationOutbox.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.ancillarySelection.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  };

  beforeEach(async (): Promise<void> => {
    await cleanupDatabase();

    const suffix = crypto.randomUUID();
    const [createdA, createdB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `dashboard-a-${suffix}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          email: `dashboard-b-${suffix}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      }),
    ]);

    userA = { id: createdA.id, email: createdA.email };
    userB = { id: createdB.id, email: createdB.email };
    tokenA = jwtService.sign({ id: userA.id, email: userA.email }, { expiresIn: '1h' });
    tokenB = jwtService.sign({ id: userB.id, email: userB.email }, { expiresIn: '1h' });
  });

  afterEach(async (): Promise<void> => {
    await cleanupDatabase();
  });

  async function createBooking(
    userId: string,
    overrides: Partial<{
      status: BookingStatus;
      departureAt: Date | null;
      createdAt: Date;
      totalAmount: Prisma.Decimal;
      pnrReference: string | null;
      duffelOrderId: string | null;
      supplierOrderId: string | null;
      duffelOfferId: string;
      supplierOfferId: string;
      flightSnapshot: Prisma.InputJsonValue | null;
      passengerSnapshot: Prisma.InputJsonValue | null;
      paymentId: string | null;
    }> = {},
  ): Promise<{ id: string; intentId: string }> {
    const now = new Date();
    const offerId =
      overrides.supplierOfferId ?? overrides.duffelOfferId ?? `off-${crypto.randomUUID()}`;

    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        supplierOfferId: offerId,
        status: 'AWAITING_PAYMENT',
        originalPrice: overrides.totalAmount ?? new Prisma.Decimal('125.50'),
        confirmedPrice: overrides.totalAmount ?? new Prisma.Decimal('125.50'),
        currency: 'USD',
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-12-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: { offerId },
        intentExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });

    const defaultDeparture = new Date(now.getTime() + 86400000 * 7);
    const departureAt =
      overrides.departureAt !== undefined ? overrides.departureAt : defaultDeparture;

    const resolvedOrderId =
      overrides.supplierOrderId !== undefined
        ? overrides.supplierOrderId
        : overrides.duffelOrderId !== undefined
          ? overrides.duffelOrderId
          : null;

    const bookingData: Prisma.BookingUncheckedCreateInput = {
      userId,
      bookingIntentId: intent.id,
      totalAmount: overrides.totalAmount ?? new Prisma.Decimal('125.50'),
      currency: 'USD',
      status: overrides.status ?? BookingStatus.CONFIRMED,
      departureAt,
      pnrReference:
        overrides.pnrReference !== undefined
          ? overrides.pnrReference
          : `PNR-${crypto.randomUUID().slice(0, 6).toUpperCase()}`,
      supplierOrderId: resolvedOrderId,
      paymentId: overrides.paymentId !== undefined ? overrides.paymentId : null,
      flightSnapshot:
        overrides.flightSnapshot === null
          ? Prisma.DbNull
          : (overrides.flightSnapshot ?? {
              segments: [
                {
                  airline: {
                    name: 'Vietnam Airlines',
                    iataCode: 'VN',
                  },
                  flightNumber: 'VN123',
                  departureAirport: {
                    iataCode: 'SGN',
                    name: 'Tan Son Nhat',
                    city: 'Ho Chi Minh City',
                  },
                  arrivalAirport: {
                    iataCode: 'HAN',
                    name: 'Noi Bai',
                    city: 'Hanoi',
                  },
                  departureAt: departureAt ? departureAt.toISOString() : now.toISOString(),
                  arrivalAt: departureAt
                    ? new Date(departureAt.getTime() + 7200000).toISOString()
                    : new Date(now.getTime() + 7200000).toISOString(),
                  duration: 'PT2H0M',
                },
              ],
              totalDuration: 'PT2H0M',
              stops: 0,
              cabinClass: 'economy',
            }),
      passengerSnapshot:
        overrides.passengerSnapshot === null
          ? Prisma.DbNull
          : overrides.passengerSnapshot !== undefined
            ? overrides.passengerSnapshot
            : undefined,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    };

    const booking = await prisma.booking.create({
      data: bookingData,
    });

    return { id: booking.id, intentId: intent.id };
  }

  describe('HTTP 401 Unauthorized', () => {
    it('returns 401 when no authorization header is provided', async (): Promise<void> => {
      await request(app.getHttpServer()).get('/api/dashboard/summary').expect(401);
    });

    it('returns 401 when an invalid bearer token is provided', async (): Promise<void> => {
      await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', 'Bearer invalid.token.value')
        .expect(401);
    });
  });

  describe('User A vs User B Strict Tenant Isolation', () => {
    it('strictly isolates dashboard stats and recent bookings between User A and User B', async (): Promise<void> => {
      const now = Date.now();

      // Seed User A bookings:
      // 1 upcoming CONFIRMED
      const bookingA1 = await createBooking(userA.id, {
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(now + 86400000 * 7),
      });
      // 1 past CONFIRMED (counts as completed)
      const bookingA2 = await createBooking(userA.id, {
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(now - 86400000 * 7),
      });
      // 1 COMPLETED
      const bookingA3 = await createBooking(userA.id, {
        status: BookingStatus.COMPLETED,
        departureAt: new Date(now - 86400000 * 14),
      });
      // 1 CANCELLED_AND_REFUNDED (counts as cancelled)
      const bookingA4 = await createBooking(userA.id, {
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        departureAt: new Date(now + 86400000 * 10),
      });

      // Seed User B bookings:
      // 2 upcoming CONFIRMED
      const bookingB1 = await createBooking(userB.id, {
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(now + 86400000 * 3),
      });
      const bookingB2 = await createBooking(userB.id, {
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(now + 86400000 * 5),
      });
      // 1 FAILED
      const bookingB3 = await createBooking(userB.id, {
        status: BookingStatus.FAILED,
        departureAt: new Date(now - 86400000 * 2),
      });

      const userABookingIds = [bookingA1.id, bookingA2.id, bookingA3.id, bookingA4.id];
      const userBBookingIds = [bookingB1.id, bookingB2.id, bookingB3.id];

      // Query User A Dashboard Summary
      const resA = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(resA.body.stats).toEqual({
        totalBookings: 4,
        upcomingBookings: 1,
        completedBookings: 2,
        cancelledBookings: 1,
      });
      expect(resA.body.recentBookings).toHaveLength(4);
      for (const booking of resA.body.recentBookings) {
        expect(userABookingIds).toContain(booking.id);
        expect(userBBookingIds).not.toContain(booking.id);
      }

      // Query User B Dashboard Summary
      const resB = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(200);

      expect(resB.body.stats).toEqual({
        totalBookings: 3,
        upcomingBookings: 2,
        completedBookings: 0,
        cancelledBookings: 0,
      });
      expect(resB.body.recentBookings).toHaveLength(3);
      for (const booking of resB.body.recentBookings) {
        expect(userBBookingIds).toContain(booking.id);
        expect(userABookingIds).not.toContain(booking.id);
      }
    });
  });

  describe('Empty State Parity', () => {
    it('returns zeroed stats and empty recent bookings list for a user with no bookings', async (): Promise<void> => {
      const suffix = crypto.randomUUID();
      const userC = await prisma.user.create({
        data: {
          email: `dashboard-c-${suffix}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });
      const tokenC = jwtService.sign({ id: userC.id, email: userC.email }, { expiresIn: '1h' });

      const res = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenC}`)
        .expect(200);

      expect(res.body).toEqual({
        stats: {
          totalBookings: 0,
          upcomingBookings: 0,
          completedBookings: 0,
          cancelledBookings: 0,
        },
        recentBookings: [],
        generatedAt: expect.any(String),
      });

      expect(new Date(res.body.generatedAt).toISOString()).toBe(res.body.generatedAt);
    });
  });

  describe('Recent 5 Limit and Descending Ordering', () => {
    it('limits recent bookings to at most 5 records and orders them by createdAt descending', async (): Promise<void> => {
      const baseTime = new Date('2026-08-01T12:00:00.000Z').getTime();
      const createdBookings: Array<{ id: string; createdAt: Date }> = [];

      for (let i = 0; i < 8; i++) {
        const createdAt = new Date(baseTime + i * 3600000);
        const b = await createBooking(userA.id, {
          status: BookingStatus.CONFIRMED,
          createdAt,
          departureAt: new Date(baseTime + 86400000 * 10 + i * 3600000),
        });
        createdBookings.push({ id: b.id, createdAt });
      }

      const res = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.recentBookings).toHaveLength(5);

      const returnedIds = res.body.recentBookings.map((b: { id: string }) => b.id);
      const expectedIds = [
        createdBookings[7].id,
        createdBookings[6].id,
        createdBookings[5].id,
        createdBookings[4].id,
        createdBookings[3].id,
      ];
      expect(returnedIds).toEqual(expectedIds);

      for (let i = 0; i < res.body.recentBookings.length - 1; i++) {
        const currentCreatedAt = new Date(res.body.recentBookings[i].createdAt).getTime();
        const nextCreatedAt = new Date(res.body.recentBookings[i + 1].createdAt).getTime();
        expect(currentCreatedAt).toBeGreaterThanOrEqual(nextCreatedAt);
      }
    });
  });

  describe('Negative Privacy Invariants', () => {
    it('guarantees zero leakage of sensitive fields, payment tokens, PII, and raw snapshots in summary payload', async (): Promise<void> => {
      const key = await prisma.idempotencyKey.create({
        data: {
          key: `seed-idemp-${crypto.randomUUID()}`,
          requestHash: 'seed-hash',
          customerId: userA.id,
          requestPath: '/api/bookings/payment/create',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const intentForPayment = await prisma.bookingIntent.create({
        data: {
          userId: userA.id,
          supplierOfferId: `off-${crypto.randomUUID()}`,
          status: 'AWAITING_PAYMENT',
          originalPrice: new Prisma.Decimal('125.50'),
          confirmedPrice: new Prisma.Decimal('125.50'),
          currency: 'USD',
          pricedAt: new Date(),
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2026-12-01'),
          cabinClass: 'economy',
          adults: 1,
          children: 0,
          infants: 0,
          rawOfferSnapshot: { offerId: 'off-test' },
          intentExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });

      const payment = await prisma.payment.create({
        data: {
          bookingIntentId: intentForPayment.id,
          attemptNumber: 1,
          idempotencyKeyId: key.id,
          stripePaymentIntentId: 'pi_sensitive_stripe_99999',
          amount: 12550,
          currency: 'usd',
          status: 'SUCCEEDED',
        },
      });

      await createBooking(userA.id, {
        status: BookingStatus.CONFIRMED,
        pnrReference: 'SECRET-PNR-999',
        supplierOrderId: 'ord_sensitive_duffel_999',
        supplierOfferId: 'off_sensitive_duffel_999',
        paymentId: payment.id,
        flightSnapshot: {
          segments: [
            {
              airline: {
                name: 'Vietnam Airlines',
                iataCode: 'VN',
              },
              flightNumber: 'VN123',
              departureAirport: {
                iataCode: 'SGN',
                name: 'Tan Son Nhat',
                city: 'Ho Chi Minh City',
              },
              arrivalAirport: {
                iataCode: 'HAN',
                name: 'Noi Bai',
                city: 'Hanoi',
              },
              departureAt: '2026-12-01T10:00:00.000Z',
              arrivalAt: '2026-12-01T12:00:00.000Z',
              duration: 'PT2H0M',
              duffelSegmentId: 'seg_sensitive_internal_999',
            },
          ],
          rawPayload: 'secret_raw_flight_info_999',
          totalDuration: 'PT2H0M',
          stops: 0,
          cabinClass: 'economy',
        },
        passengerSnapshot: [
          {
            passportNumber: 'N99887766',
            passportExpiry: '2030-01-01',
            email: 'sensitive_passenger@example.com',
            phoneNumber: '+84901234567',
            creditCardLast4: '4242',
          },
        ],
      });

      const res = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const bodyStr = JSON.stringify(res.body);

      // Sensitive PII and Payment Assertions
      expect(bodyStr).not.toContain('N99887766');
      expect(bodyStr).not.toContain('2030-01-01');
      expect(bodyStr).not.toContain('sensitive_passenger@example.com');
      expect(bodyStr).not.toContain('+84901234567');
      expect(bodyStr).not.toContain('4242');
      expect(bodyStr).not.toContain('SECRET-PNR-999');
      expect(bodyStr).not.toContain('ord_sensitive_duffel_999');
      expect(bodyStr).not.toContain('off_sensitive_duffel_999');
      expect(bodyStr).not.toContain('seg_sensitive_internal_999');
      expect(bodyStr).not.toContain('secret_raw_flight_info_999');
      expect(bodyStr).not.toContain('pi_sensitive_stripe_99999');
      expect(bodyStr).not.toContain(payment.id);
      expect(bodyStr).not.toContain(userA.id);

      // Forbidden key names
      expect(bodyStr).not.toContain('"paymentId"');
      expect(bodyStr).not.toContain('"stripePaymentIntentId"');
      expect(bodyStr).not.toContain('"duffelOrderId"');
      expect(bodyStr).not.toContain('"duffelOfferId"');
      expect(bodyStr).not.toContain('"userId"');
      expect(bodyStr).not.toContain('"passengerSnapshot"');
      expect(bodyStr).not.toContain('"flightSnapshot"');
      expect(bodyStr).not.toContain('"rawOfferSnapshot"');

      // Allowlisted keys verification
      const allowedKeys = [
        'airlineCode',
        'createdAt',
        'departureAt',
        'destinationCode',
        'flightNumber',
        'id',
        'originCode',
        'status',
      ].sort();

      expect(res.body.recentBookings.length).toBeGreaterThanOrEqual(1);
      for (const item of res.body.recentBookings) {
        expect(Object.keys(item).sort()).toEqual(allowedKeys);
      }
    });
  });

  describe('Cache-Control Headers', () => {
    it('returns Cache-Control headers with no-store and private directives', async (): Promise<void> => {
      const res = await request(app.getHttpServer())
        .get('/api/dashboard/summary')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      const cacheControl = (res.headers['cache-control'] as string | undefined) ?? '';
      expect(cacheControl).toContain('no-store');
      expect(cacheControl).toContain('private');
    });
  });
});
