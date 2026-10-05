process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';

import { Test, TestingModule } from '@nestjs/testing';
import {
  INestApplication,
  ValidationPipe,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingRecoveryService } from '@/booking-lifecycle/booking-recovery.service';
import { BookingManagementService } from '@/booking-management/booking-management.service';
import { BookingManagementModule } from '@/booking-management/booking-management.module';
import { BookingManagementController } from '@/booking-management/booking-management.controller';
import { CancellationModule } from '@/cancellation/cancellation.module';
import { CancellationController } from '@/cancellation/cancellation.controller';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { BookingStatus, BookingFailureReason, PaymentStatus, Prisma } from '@prisma/client';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import * as crypto from 'crypto';

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

describe('Booking Characterization (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let bookingLifecycleService: BookingLifecycleService;
  let bookingRecoveryService: BookingRecoveryService;
  let bookingManagementService: BookingManagementService;

  let userA: { id: string; email: string };
  let tokenA: string;
  let userB: { id: string; email: string };
  let tokenB: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
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
    stripeService = moduleFixture.get<StripeService>(StripeService);
    bookingLifecycleService = moduleFixture.get<BookingLifecycleService>(BookingLifecycleService);
    bookingRecoveryService = moduleFixture.get<BookingRecoveryService>(BookingRecoveryService);
    bookingManagementService =
      moduleFixture.get<BookingManagementService>(BookingManagementService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.bookingAgentProjection.deleteMany({});
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

    const createdA = await prisma.user.create({
      data: {
        email: `user-a-char-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    userA = { id: createdA.id, email: createdA.email };
    tokenA = jwtService.sign(
      { id: userA.id, email: userA.email, role: 'USER' },
      { expiresIn: '24h' },
    );

    const createdB = await prisma.user.create({
      data: {
        email: `user-b-char-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });
    userB = { id: createdB.id, email: createdB.email };
    tokenB = jwtService.sign(
      { id: userB.id, email: userB.email, role: 'USER' },
      { expiresIn: '24h' },
    );
  });

  async function createBookingIntent(userId: string, price = '150.00', currency = 'USD') {
    return prisma.bookingIntent.create({
      data: {
        userId,
        supplierOfferId: `off_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal(price),
        confirmedPrice: new Prisma.Decimal(price),
        currency,
        priceChanged: false,
        pricedAt: new Date(),
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2027-10-01'),
        cabinClass: 'economy',
        adults: 1,
        children: 0,
        infants: 0,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
        paymentAttemptCount: 1,
      },
    });
  }

  async function createPayment(userId: string, bookingIntentId: string) {
    const key = await prisma.idempotencyKey.create({
      data: {
        key: `bk-char-pay-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        requestHash: crypto.randomBytes(16).toString('hex'),
        customerId: userId,
        requestPath: '/api/bookings/payment/create',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    return prisma.payment.create({
      data: {
        bookingIntentId,
        attemptNumber: 1,
        idempotencyKeyId: key.id,
        stripePaymentIntentId: `pi_char_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        amount: 15000,
        currency: 'usd',
        status: PaymentStatus.SUCCEEDED,
      },
    });
  }

  const sampleFlightSnapshot: FlightSnapshot = {
    segments: [
      {
        departureAirport: { iataCode: 'SGN', name: 'Tan Son Nhat', city: 'Ho Chi Minh' },
        arrivalAirport: { iataCode: 'HAN', name: 'Noi Bai', city: 'Hanoi' },
        departureAt: '2027-10-01T08:00:00Z',
        arrivalAt: '2027-10-01T10:10:00Z',
        airline: { name: 'Vietnam Airlines', iataCode: 'VN' },
        flightNumber: 'VN123',
        duration: 'PT2H10M',
      },
    ],
    totalDuration: 'PT2H10M',
    stops: 0,
    cabinClass: 'economy',
    baggageAllowance: '1 checked bag (23kg)',
  };

  const samplePassengerSnapshot: PassengerSnapshot = {
    passengers: [
      {
        type: 'ADULT',
        firstName: 'Minh',
        lastName: 'Pham',
      },
    ],
    contactEmail: 'minh@example.com',
  };

  describe('1. createBooking Characterization', () => {
    it('creates booking with PROCESSING status, totalAmount matching intent, currency, and ownership', async () => {
      const intent = await createBookingIntent(userA.id, '175.50', 'USD');
      const bookingId = crypto.randomUUID();

      const booking = await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);

      expect(booking).toBeDefined();
      expect(booking.id).toBe(bookingId);
      expect(booking.userId).toBe(userA.id);
      expect(booking.bookingIntentId).toBe(intent.id);
      expect(booking.status).toBe(BookingStatus.PROCESSING);
      expect(booking.totalAmount.toString()).toBe('175.5');
      expect(booking.currency).toBe('USD');
      expect(booking.failureReason).toBeNull();
      expect(booking.pnrReference).toBeNull();
      expect(booking.supplierOrderId).toBeNull();
    });

    it('idempotently returns existing booking when called again with same bookingIntentId or bookingId', async () => {
      const intent = await createBookingIntent(userA.id, '150.00');
      const bookingId = crypto.randomUUID();

      // First call
      const first = await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);
      expect(first.id).toBe(bookingId);

      // Replay with same intentId and same bookingId
      const replay = await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);
      expect(replay.id).toBe(bookingId);

      // Replay with same intentId but different requested bookingId -> returns existing booking by intent
      const diffBookingId = crypto.randomUUID();
      const byIntent = await bookingLifecycleService.createBooking(
        userA.id,
        diffBookingId,
        intent.id,
      );
      expect(byIntent.id).toBe(bookingId);

      const totalCount = await prisma.booking.count({ where: { bookingIntentId: intent.id } });
      expect(totalCount).toBe(1);
    });

    it('rejects booking creation if intent belongs to another user (403 Forbidden)', async () => {
      const intent = await createBookingIntent(userA.id);
      const bookingId = crypto.randomUUID();

      await expect(
        bookingLifecycleService.createBooking(userB.id, bookingId, intent.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('rejects booking creation if intent does not exist (404 NotFound)', async () => {
      const nonExistentIntentId = crypto.randomUUID();
      const bookingId = crypto.randomUUID();

      await expect(
        bookingLifecycleService.createBooking(userA.id, bookingId, nonExistentIntentId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('2. updateToConfirmed Characterization', () => {
    it('transitions booking to CONFIRMED, populates pnr, duffelOrderId, snapshots, departureAt, and creates agent projection', async () => {
      const intent = await createBookingIntent(userA.id);
      const bookingId = crypto.randomUUID();
      await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);

      const pnr = 'VNABC1';
      const duffelOrderId = 'ord_duffel_123';

      const confirmedBooking = await bookingLifecycleService.updateToConfirmed(
        bookingId,
        pnr,
        duffelOrderId,
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      expect(confirmedBooking.status).toBe(BookingStatus.CONFIRMED);
      expect(confirmedBooking.pnrReference).toBe(pnr);
      expect(confirmedBooking.supplierOrderId).toBe(duffelOrderId);
      expect(confirmedBooking.departureAt).toEqual(new Date('2027-10-01T08:00:00Z'));
      expect(confirmedBooking.failureReason).toBeNull();
      expect(confirmedBooking.flightSnapshot).toBeDefined();
      expect(confirmedBooking.passengerSnapshot).toBeDefined();

      // Verify Agent Projection created (using bounded polling for eventual consistency)
      const projection = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({
          where: { bookingId },
        });
      }, 5000);
      expect(projection).toBeDefined();
      expect(projection!.status).toBe(BookingStatus.CONFIRMED);
      expect(projection!.agentReference).toMatch(/^bkref_/);
      expect(projection!.origin).toBe('SGN');
      expect(projection!.destination).toBe('HAN');
      expect(projection!.airline).toBe('Vietnam Airlines');
      expect(projection!.flightNumber).toBe('VN123');
      expect(projection!.stopCount).toBe(0);
      expect(projection!.baggageSummary).toBe('1 checked bag (23kg)');
    });

    it('throws BadRequestException if flightSnapshot has empty segments', async () => {
      const intent = await createBookingIntent(userA.id);
      const bookingId = crypto.randomUUID();
      await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);

      const invalidSnapshot: FlightSnapshot = {
        segments: [],
        totalDuration: 'PT0M',
        stops: 0,
        cabinClass: 'economy',
      };

      await expect(
        bookingLifecycleService.updateToConfirmed(
          bookingId,
          'PNR123',
          'ord_123',
          invalidSnapshot,
          samplePassengerSnapshot,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('3. updateToFailed Characterization', () => {
    it('transitions booking to FAILED with failureReason and updates projection status', async () => {
      const intent = await createBookingIntent(userA.id);
      const bookingId = crypto.randomUUID();
      await bookingLifecycleService.createBooking(userA.id, bookingId, intent.id);

      const failedBooking = await bookingLifecycleService.updateToFailed(
        bookingId,
        BookingFailureReason.CAPTURE_FAILED,
        sampleFlightSnapshot,
        samplePassengerSnapshot,
        new Date('2027-10-01T08:00:00Z'),
      );

      expect(failedBooking.status).toBe(BookingStatus.FAILED);
      expect(failedBooking.failureReason).toBe(BookingFailureReason.CAPTURE_FAILED);

      const updated = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(updated.status).toBe(BookingStatus.FAILED);
      expect(updated.failureReason).toBe(BookingFailureReason.CAPTURE_FAILED);
    });
  });

  describe('4. reconcileBookingIfStale Characterization', () => {
    it('does not modify non-stale booking (< 15 mins)', async () => {
      const intent = await createBookingIntent(userA.id);
      const payment = await createPayment(userA.id, intent.id);
      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          paymentId: payment.id,
          totalAmount: new Prisma.Decimal(150.0),
          currency: 'USD',
          status: BookingStatus.PROCESSING,
          createdAt: new Date(Date.now() - 5 * 60 * 1000), // 5 mins old
        },
        include: {
          payment: {
            include: {
              ancillarySelection: {
                include: { seatSelections: true, baggageSelections: true },
              },
            },
          },
          bookingIntent: { include: { passengers: true } },
          activeDisruptionRevision: {
            include: { segments: { orderBy: { globalOrder: 'asc' } }, notificationOutbox: true },
          },
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: { orderBy: { globalOrder: 'asc' } } },
          },
        },
      });

      const reconciled = await bookingRecoveryService.reconcileBookingIfStale(booking as any);
      expect(reconciled.status).toBe(BookingStatus.PROCESSING);
    });

    it('stale booking without Stripe payment intent transitions to FAILED (BOOKING_TIMEOUT)', async () => {
      const intent = await createBookingIntent(userA.id);
      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          totalAmount: new Prisma.Decimal(150.0),
          currency: 'USD',
          status: BookingStatus.PROCESSING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000), // 20 mins old
        },
        include: {
          payment: {
            include: {
              ancillarySelection: {
                include: { seatSelections: true, baggageSelections: true },
              },
            },
          },
          bookingIntent: { include: { passengers: true } },
          activeDisruptionRevision: {
            include: { segments: { orderBy: { globalOrder: 'asc' } }, notificationOutbox: true },
          },
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: { orderBy: { globalOrder: 'asc' } } },
          },
        },
      });

      const reconciled = await bookingRecoveryService.reconcileBookingIfStale(booking as any);
      expect(reconciled.status).toBe(BookingStatus.FAILED);
      expect(reconciled.failureReason).toBe(BookingFailureReason.BOOKING_TIMEOUT);
    });

    it('stale booking where Stripe payment failed transitions booking to FAILED (CAPTURE_FAILED) and cancels payment', async () => {
      const intent = await createBookingIntent(userA.id);
      const payment = await createPayment(userA.id, intent.id);
      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          paymentId: payment.id,
          totalAmount: new Prisma.Decimal(150.0),
          currency: 'USD',
          status: BookingStatus.PROCESSING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
        },
        include: {
          payment: {
            include: {
              ancillarySelection: {
                include: { seatSelections: true, baggageSelections: true },
              },
            },
          },
          bookingIntent: { include: { passengers: true } },
          activeDisruptionRevision: {
            include: { segments: { orderBy: { globalOrder: 'asc' } }, notificationOutbox: true },
          },
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: { orderBy: { globalOrder: 'asc' } } },
          },
        },
      });

      const retrieveSpy = jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValue({
          id: payment.stripePaymentIntentId,
          status: 'requires_payment_method',
        } as any);
      const cancelSpy = jest
        .spyOn(stripeService, 'cancelPaymentIntent')
        .mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'canceled' } as any);

      const reconciled = await bookingRecoveryService.reconcileBookingIfStale(booking as any);

      retrieveSpy.mockRestore();
      cancelSpy.mockRestore();

      expect(reconciled.status).toBe(BookingStatus.FAILED);
      expect(reconciled.failureReason).toBe(BookingFailureReason.CAPTURE_FAILED);

      const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(updatedPayment.status).toBe(PaymentStatus.CANCELLED);
    });

    it('stale booking where Stripe succeeded and duffel order exists is recovered to CONFIRMED', async () => {
      const intent = await createBookingIntent(userA.id);
      const payment = await createPayment(userA.id, intent.id);
      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          paymentId: payment.id,
          totalAmount: new Prisma.Decimal(150.0),
          currency: 'USD',
          status: BookingStatus.PROCESSING,
          createdAt: new Date(Date.now() - 20 * 60 * 1000),
        },
        include: {
          payment: {
            include: {
              ancillarySelection: {
                include: { seatSelections: true, baggageSelections: true },
              },
            },
          },
          bookingIntent: { include: { passengers: true } },
          activeDisruptionRevision: {
            include: { segments: { orderBy: { globalOrder: 'asc' } }, notificationOutbox: true },
          },
          itineraryRevisions: {
            orderBy: { version: 'desc' },
            take: 1,
            include: { segments: { orderBy: { globalOrder: 'asc' } } },
          },
        },
      });

      // Record duffel order created event
      await prisma.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: 'duffel_order_created',
          previousStatus: PaymentStatus.AUTHORIZED,
          newStatus: PaymentStatus.SUCCEEDED,
          source: 'SYSTEM',
          createdBy: 'test',
          metadata: {
            id: 'ord_stale_rec_123',
            booking_reference: 'REC123',
            slices: [
              {
                id: 'sli_1',
                duration: 'PT2H',
                segments: [
                  {
                    id: 'seg_1',
                    departing_at: '2027-10-01T08:00:00Z',
                    arriving_at: '2027-10-01T10:00:00Z',
                    origin: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                    destination: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                    operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier_flight_number: '123',
                    passengers: [],
                  },
                ],
              },
            ],
            passengers: [],
          },
        },
      });

      const retrieveSpy = jest
        .spyOn(stripeService, 'retrievePaymentIntent')
        .mockResolvedValue({ id: payment.stripePaymentIntentId, status: 'succeeded' } as any);

      const reconciled = await bookingRecoveryService.reconcileBookingIfStale(booking as any);
      retrieveSpy.mockRestore();

      expect(reconciled.status).toBe(BookingStatus.CONFIRMED);
      expect(reconciled.pnrReference).toBe('REC123');
      expect(reconciled.supplierOrderId).toBe('ord_stale_rec_123');
      expect(reconciled.departureAt).toBeDefined();

      const updatedPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(updatedPayment.status).toBe(PaymentStatus.SUCCEEDED);
    });
  });

  describe('5. Query Response Shapes (listBookings & getBookingDetail)', () => {
    it('listBookings partitions upcoming and past bookings with correct pagination', async () => {
      const intentActive = await createBookingIntent(userA.id);
      const bookingActive = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intentActive.id,
          totalAmount: new Prisma.Decimal(100.0),
          currency: 'USD',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date(Date.now() + 86400000 * 10), // in future
          pnrReference: 'UPCOM1',
          flightSnapshot: sampleFlightSnapshot as unknown as Prisma.InputJsonValue,
        },
      });

      const intentPast = await createBookingIntent(userA.id);
      const bookingPast = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intentPast.id,
          totalAmount: new Prisma.Decimal(120.0),
          currency: 'USD',
          status: BookingStatus.COMPLETED,
          departureAt: new Date(Date.now() - 86400000 * 10), // in past
          pnrReference: 'PAST01',
          flightSnapshot: sampleFlightSnapshot as unknown as Prisma.InputJsonValue,
        },
      });

      // Query upcoming
      const upcomingRes = await bookingManagementService.listBookings(userA.id, 'upcoming', 1, 10);
      expect(upcomingRes.bookings).toHaveLength(1);
      expect(upcomingRes.bookings[0].id).toBe(bookingActive.id);
      expect(upcomingRes.pagination.total).toBe(1);
      expect(upcomingRes.pagination.page).toBe(1);
      expect(upcomingRes.pagination.limit).toBe(10);

      // Query past
      const pastRes = await bookingManagementService.listBookings(userA.id, 'past', 1, 10);
      expect(pastRes.bookings).toHaveLength(1);
      expect(pastRes.bookings[0].id).toBe(bookingPast.id);
    });

    it('getBookingDetail returns complete detail shape and enforces user ownership isolation', async () => {
      const intent = await createBookingIntent(userA.id);
      const payment = await createPayment(userA.id, intent.id);
      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          paymentId: payment.id,
          totalAmount: new Prisma.Decimal(150.0),
          currency: 'USD',
          status: BookingStatus.CONFIRMED,
          pnrReference: 'DET001',
          supplierOrderId: 'ord_detail_1',
          flightSnapshot: sampleFlightSnapshot as unknown as Prisma.InputJsonValue,
          passengerSnapshot: samplePassengerSnapshot as unknown as Prisma.InputJsonValue,
          departureAt: new Date('2027-10-01T08:00:00Z'),
        },
      });

      // User A (owner) retrieves detail
      const detail = await bookingManagementService.getBookingDetail(booking.id, userA.id);
      expect(detail).toBeDefined();
      expect(detail.id).toBe(booking.id);
      expect(detail.status).toBe(BookingStatus.CONFIRMED);
      expect(detail.pnrReference).toBe('DET001');
      expect(detail.flightSnapshot).toBeDefined();
      expect(detail.passengerSnapshot).toBeDefined();
      expect(detail.payment).toBeDefined();

      // User B (non-owner) is rejected with ForbiddenException
      await expect(bookingManagementService.getBookingDetail(booking.id, userB.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('6. Module Graph Metric Check (Elimination of Circular Dependencies)', () => {
    it('verifies zero forwardRef or circular reference patterns between Booking and Payment services', () => {
      const rootDir = path.resolve(__dirname, '../../src');

      const paymentServicePath = path.join(rootDir, 'payment/payment.service.ts');
      const bookingManagementModulePath = path.join(
        rootDir,
        'booking-management/booking-management.module.ts',
      );
      const cancellationModulePath = path.join(rootDir, 'cancellation/cancellation.module.ts');
      const paymentModulePath = path.join(rootDir, 'payment/payment.module.ts');

      const paymentServiceContent = fs.readFileSync(paymentServicePath, 'utf8');
      const bookingManagementModuleContent = fs.readFileSync(bookingManagementModulePath, 'utf8');
      const cancellationModuleContent = fs.readFileSync(cancellationModulePath, 'utf8');
      const paymentModuleContent = fs.readFileSync(paymentModulePath, 'utf8');

      // Assert NO forwardRef injection in PaymentService
      const hasBookingServiceForwardRef = paymentServiceContent.includes('forwardRef');
      expect(hasBookingServiceForwardRef).toBe(false);

      // Assert NO forwardRef in BookingManagementModule and CancellationModule
      expect(bookingManagementModuleContent.includes('forwardRef')).toBe(false);
      expect(cancellationModuleContent.includes('forwardRef')).toBe(false);

      // Assert NO forwardRef in PaymentModule
      expect(paymentModuleContent.includes('forwardRef')).toBe(false);
    });

    it('verifies controllers are registered in domain modules and umbrella BookingModule is removed from AppModule', () => {
      const bookingManagementControllers =
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, BookingManagementModule) ?? [];
      expect(bookingManagementControllers).toContain(BookingManagementController);

      const cancellationControllers =
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, CancellationModule) ?? [];
      expect(cancellationControllers).toContain(CancellationController);

      const appImports = (Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) ?? []) as any[];
      const appControllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? []) as any[];

      const importedNames = appImports.map((m) => (typeof m === 'function' ? m.name : m?.module?.name));
      const controllerNames = appControllers.map((c) => (typeof c === 'function' ? c.name : c));

      expect(importedNames).not.toContain('BookingModule');
      expect(controllerNames).not.toContain('BookingController');
    });
  });
});
