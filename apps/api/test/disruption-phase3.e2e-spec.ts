process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { SupplierSyncService } from '@/disruption/sync/supplier-sync.service';
import { DisruptionStatus, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

describe('Disruption Phase 3 (Sync & Concurrency E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let supplierSyncService: SupplierSyncService;
  let mockDuffelRecoveryService: { retrieveCompleteOrder: jest.Mock };

  let userId: string;
  let bookingIntentId: string;
  let bookingId: string;
  let suffix: string;

  beforeAll(async () => {
    mockDuffelRecoveryService = {
      retrieveCompleteOrder: jest.fn(),
    };

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DuffelRecoveryService)
      .useValue(mockDuffelRecoveryService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    supplierSyncService = moduleFixture.get<SupplierSyncService>(SupplierSyncService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    suffix = crypto.randomUUID();
    jest.clearAllMocks();

    const user = await prisma.user.create({
      data: {
        email: `test-sync-e2e-user-${suffix}@example.com`,
        password: 'Password123!',
        role: 'USER',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    const intent = await prisma.bookingIntent.create({
      data: {
        userId,
        supplierOfferId: `off_fake_${suffix}`,
        originalPrice: new Prisma.Decimal('100.00'),
        confirmedPrice: new Prisma.Decimal('100.00'),
        currency: 'USD',
        pricedAt: new Date(),
        origin: 'HAN',
        destination: 'NRT',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    bookingIntentId = intent.id;

    const booking = await prisma.booking.create({
      data: {
        userId,
        bookingIntentId,
        totalAmount: new Prisma.Decimal('100.00'),
        currency: 'USD',
        status: 'CONFIRMED',
        supplierOrderId: `ord_fake_${suffix}`,
        flightSnapshot: {
          stops: 0,
          cabinClass: 'economy',
          totalDuration: 'PT2H',
          segments: [
            {
              airline: { name: 'Japan Airlines', iataCode: 'JL' },
              flightNumber: '752',
              departureAirport: { name: 'Noi Bai', iataCode: 'HAN', city: 'Hanoi', terminal: 'T2' },
              arrivalAirport: { name: 'Narita', iataCode: 'NRT', city: 'Tokyo', terminal: 'T2' },
              departureAt: '2026-08-01T12:00:00Z',
              arrivalAt: '2026-08-01T19:00:00Z',
              duration: 'PT7H',
              aircraftType: 'Boeing 787',
              duffelSegmentId: `seg_orig_${suffix}`,
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
            },
          ],
        },
      },
    });
    bookingId = booking.id;
  });

  afterEach(async () => {
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

  it('should run a complete material sync and create outbox/audit/revision rows end-to-end', async () => {
    // 3 hours later move (material)
    mockDuffelRecoveryService.retrieveCompleteOrder.mockResolvedValue({
      id: `ord_fake_${suffix}`,
      slices: [
        {
          id: 'sli_1',
          segments: [
            {
              id: `seg_orig_${suffix}`,
              departing_at: '2026-08-01T15:00:00Z',
              arriving_at: '2026-08-01T22:00:00Z',
              origin: { iata_code: 'HAN', name: 'Noi Bai' },
              destination: { iata_code: 'NRT', name: 'Narita' },
              operating_carrier: { iata_code: 'JL', name: 'Japan Airlines' },
              marketing_carrier_flight_number: '752',
            },
          ],
        },
      ],
      passengers: [],
    });

    const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
    expect(result.status).toBe('REVISION_CREATED');

    // Retrieve database state to confirm end-to-end updates
    const dbBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        itineraryRevisions: {
          include: { segments: true },
        },
        notificationOutbox: true,
        disruptionAuditEvents: true,
      },
    });

    expect(dbBooking?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
    expect(dbBooking?.activeDisruptionRevisionId).toBe(dbBooking?.itineraryRevisions[0].id);

    // Timing fields should be updated to matches new segments
    expect(dbBooking?.currentDepartureAt?.toISOString()).toBe('2026-08-01T15:00:00.000Z');
    expect(dbBooking?.currentFinalArrivalAt?.toISOString()).toBe('2026-08-01T22:00:00.000Z');

    // Revision checks
    expect(dbBooking?.itineraryRevisions.length).toBe(1);
    const rev = dbBooking?.itineraryRevisions[0];
    expect(rev?.isMaterial).toBe(true);
    expect(rev?.version).toBe(1);
    expect(rev?.segments.length).toBe(1);
    expect(rev?.segments[0].flightNumber).toBe('752');
    expect(rev?.segments[0].departureAirportIata).toBe('HAN');

    // Outbox checks
    expect(dbBooking?.notificationOutbox.length).toBe(1);
    expect(dbBooking?.notificationOutbox[0].revisionId).toBe(rev?.id);
    expect(dbBooking?.notificationOutbox[0].status).toBe('PENDING');

    // Audit events checks
    const auditEvents = dbBooking?.disruptionAuditEvents || [];
    expect(auditEvents.length).toBeGreaterThanOrEqual(1);
    expect(auditEvents.some((e) => e.action === 'DETECTED')).toBe(true);
  });
});
