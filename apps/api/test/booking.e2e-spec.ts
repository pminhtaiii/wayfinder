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

describe('Bookings (E2E)', () => {
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
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

  beforeEach(async (): Promise<void> => {
    const suffix = crypto.randomUUID();
    const [createdA, createdB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `booking-a-${suffix}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      }),
      prisma.user.create({
        data: {
          email: `booking-b-${suffix}@example.com`,
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
    const userIds = [userA.id, userB.id];
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.itineraryRevisionSegment.deleteMany({});
    await prisma.itineraryRevision.deleteMany({});
    await prisma.disruptionAuditEvent.deleteMany({});
    await prisma.notificationOutbox.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  async function createBooking(
    userId: string,
    overrides: Partial<{
      status: BookingStatus;
      departureAt: Date | null;
      pnrReference: string | null;
      flightSnapshot: Prisma.InputJsonValue | null;
    }> = {},
  ): Promise<{ id: string }> {
    const now = new Date();
    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        // Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
        supplierOfferId: `off-${crypto.randomUUID()}`,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal('125.50'),
        confirmedPrice: new Prisma.Decimal('125.50'),
        currency: 'USD',
        pricedAt: now,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-12-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      },
    });
    const booking = await prisma.booking.create({
      data: {
        userId,
        bookingIntentId: intent.id,
        totalAmount: new Prisma.Decimal('125.50'),
        currency: 'USD',
        status: overrides.status ?? 'PROCESSING',
        departureAt: overrides.departureAt ?? null,
        pnrReference: overrides.pnrReference ?? null,
        flightSnapshot:
          overrides.flightSnapshot === null ? Prisma.DbNull : overrides.flightSnapshot,
      },
    });
    return { id: booking.id };
  }

  async function createPaymentForBookingIntent(userId: string): Promise<{ id: string }> {
    const booking = await createBooking(userId);
    const key = await prisma.idempotencyKey.create({
      data: {
        key: `seed-payment-${crypto.randomUUID()}`,
        requestHash: 'seed-request-hash',
        customerId: userId,
        requestPath: '/api/bookings/payment/create',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        bookingIntentId: (await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } }))
          .bookingIntentId,
        attemptNumber: 1,
        idempotencyKeyId: key.id,
        stripePaymentIntentId: `pi-${crypto.randomUUID()}`,
        amount: 12550,
        currency: 'usd',
        status: 'CREATED',
      },
    });
    return { id: payment.id };
  }

  it('returns upcoming bookings in processing-first order with null processing fields', async (): Promise<void> => {
    const future = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const confirmed = await createBooking(userA.id, {
      status: 'CONFIRMED',
      departureAt: future,
      pnrReference: 'PNR123',
    });
    const processing = await createBooking(userA.id);
    await createBooking(userA.id, {
      status: 'COMPLETED',
      departureAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    const response = await request(app.getHttpServer())
      .get('/api/bookings')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.bookings.map((booking: { id: string }) => booking.id)).toEqual([
      processing.id,
      confirmed.id,
    ]);
    expect(response.body.bookings[0]).toMatchObject({
      status: 'PROCESSING',
      departureAt: null,
      pnrReference: null,
      flightSnapshot: null,
    });
    expect(response.body.pagination).toMatchObject({ page: 1, limit: 20, total: 2, totalPages: 1 });
  });

  it('returns only completed and departed bookings on the past tab', async (): Promise<void> => {
    const past = await createBooking(userA.id, {
      status: 'COMPLETED',
      departureAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    await createBooking(userA.id, {
      status: 'CONFIRMED',
      departureAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const response = await request(app.getHttpServer())
      .get('/api/bookings?tab=past')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    expect(response.body.bookings).toHaveLength(1);
    expect(response.body.bookings[0].id).toBe(past.id);
  });

  it('enforces UUID and pagination query validation at the HTTP boundary', async (): Promise<void> => {
    await request(app.getHttpServer())
      .get('/api/bookings/not-a-uuid')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/bookings?tab=invalid')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/bookings?page=0')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
    await request(app.getHttpServer())
      .get('/api/bookings?limit=51')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(400);
  });

  it('rejects an invalid client-generated booking UUID before starting confirmation work', async (): Promise<void> => {
    await request(app.getHttpServer())
      .post('/api/bookings/payment/confirm')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', `confirm-invalid-${crypto.randomUUID()}`)
      .send({ bookingId: 'invalid-booking-id', paymentId: crypto.randomUUID() })
      .expect(400);
  });

  it('rejects a cross-user booking UUID collision without running the payment pipeline', async (): Promise<void> => {
    const otherUsersBooking = await createBooking(userB.id);
    const payment = await createPaymentForBookingIntent(userA.id);

    await request(app.getHttpServer())
      .post('/api/bookings/payment/confirm')
      .set('Authorization', `Bearer ${tokenA}`)
      .set('Idempotency-Key', `confirm-collision-${crypto.randomUUID()}`)
      .send({ bookingId: otherUsersBooking.id, paymentId: payment.id })
      .expect(403);

    const persisted = await prisma.booking.findUniqueOrThrow({
      where: { id: otherUsersBooking.id },
    });
    expect(persisted.userId).toBe(userB.id);
    expect(persisted.status).toBe('PROCESSING');
  });

  it('returns detail with a null payment and blocks cross-user access without revealing data', async (): Promise<void> => {
    const booking = await createBooking(userA.id, { status: 'FAILED' });

    const ownResponse = await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(ownResponse.body).toMatchObject({ id: booking.id, status: 'FAILED', payment: null });

    await request(app.getHttpServer())
      .get(`/api/bookings/${booking.id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/api/bookings/${crypto.randomUUID()}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(404);
  });

  it('allows only one concurrent conditional terminal transition', async (): Promise<void> => {
    const booking = await createBooking(userA.id);
    const update = (): Promise<{ count: number }> =>
      prisma.booking.updateMany({
        where: { id: booking.id, status: 'PROCESSING' },
        data: { status: 'FAILED', failureReason: 'BOOKING_TIMEOUT' },
      });

    const results = await Promise.all([update(), update()]);
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });

    expect(results.map((result: { count: number }) => result.count).sort()).toEqual([0, 1]);
    expect(stored.status).toBe('FAILED');
    expect(stored.failureReason).toBe('BOOKING_TIMEOUT');
  });
});
