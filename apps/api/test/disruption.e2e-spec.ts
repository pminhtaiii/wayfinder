process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.DUFFEL_WEBHOOK_SECRET = 'whsec_duffel_test_secret';
process.env.FEATURE_FLAG_DISRUPTION_INGRESS = 'true';
process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { DuffelEventProcessor } from '@/disruption/webhook/duffel-event.processor';
import { DisruptionStatus, Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { JwtService } from '@nestjs/jwt';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import * as crypto from 'crypto';

describe('Disruption & Flight-Change Management (Webhook & Processor E2E)', () => {
  jest.setTimeout(30_000);
  let app: INestApplication;
  let prisma: PrismaService;
  let processor: DuffelEventProcessor;
  let mockDuffelRecoveryService: { retrieveCompleteOrder: jest.Mock };

  let userId: string;
  let bookingIntentId: string;
  let bookingId: string;
  let suffix: string;
  let userToken: string;
  let jwtService: JwtService;
  const webhookSecret = 'whsec_duffel_test_secret';

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

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    // User-requested CI repair: this suite awaits explicit processor batches.
    // A cron claim can return that batch early, leaving sync transactions racing assertions/cleanup.
    const schedulerRegistry = moduleFixture.get<SchedulerRegistry>(SchedulerRegistry);
    schedulerRegistry.getCronJobs().forEach((job) => job.stop());

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    processor = moduleFixture.get<DuffelEventProcessor>(DuffelEventProcessor);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    delete process.env.FEATURE_FLAG_DISRUPTION_INGRESS;
    delete process.env.FEATURE_FLAG_DISRUPTION_PROCESSOR;
    delete process.env.FEATURE_FLAG_DISRUPTION_RECONCILIATION;
    delete process.env.FEATURE_FLAG_DISRUPTION_SURFACING;
    delete process.env.FEATURE_FLAG_DISRUPTION_OUTBOX;
    await app.close();
  });

  beforeEach(async () => {
    suffix = crypto.randomUUID();
    jest.clearAllMocks();

    const user = await prisma.user.create({
      data: {
        email: `test-webhook-e2e-user-${suffix}@example.com`,
        password: 'Password123!',
        role: 'USER',
        status: 'ACTIVE',
      },
    });
    userId = user.id;
    userToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '1h' });

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
    await prisma.bookingAgentProjection.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});
  });

  const generateSignatureHeader = (timestamp: number, rawBody: string, secret: string) => {
    const message = `${timestamp}.${rawBody}`;
    const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return `t=${timestamp},v1=${sig}`;
  };

  describe('POST /api/duffel/webhook (Ingestion)', () => {
    it('should fail if signature header is missing', async () => {
      const body = { id: `wev_fake_${suffix}`, type: 'order.airline_initiated_change_detected' };
      const response = await request(app.getHttpServer()).post('/api/duffel/webhook').send(body);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error).toBe('WEBHOOK_SIGNATURE_MISSING');
    });

    it('should fail if signature timestamp is stale', async () => {
      const body = JSON.stringify({
        id: `wev_fake_${suffix}`,
        type: 'order.airline_initiated_change_detected',
      });
      const staleTime = Math.floor(Date.now() / 1000) - 301;
      const signature = generateSignatureHeader(staleTime, body, webhookSecret);

      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.error).toBe('WEBHOOK_SIGNATURE_INVALID');
    });

    it('should successfully ingest a supported event, persist to inbox, and return 200 quickly', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'order.airline_initiated_change_detected',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      const startTime = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      const duration = Date.now() - startTime;
      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toEqual({ received: true });
      expect(duration).toBeLessThan(500);

      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe('PENDING');
      expect(event?.duffelOrderId).toBe(`ord_fake_${suffix}`);
    });

    it('should return 200 and SKIPPED status for unsupported event type', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'unsupported.event_type',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.OK);

      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe('SKIPPED');
    });

    it('should return 200 and not duplicate events on duplicate webhook delivery', async () => {
      const payload = {
        id: `wev_fake_${suffix}`,
        type: 'order.airline_initiated_change_detected',
        data: { object: { order_id: `ord_fake_${suffix}` } },
      };
      const body = JSON.stringify(payload);
      const now = Math.floor(Date.now() / 1000);
      const signature = generateSignatureHeader(now, body, webhookSecret);

      // First call
      await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      // Duplicate call
      const response = await request(app.getHttpServer())
        .post('/api/duffel/webhook')
        .set('x-duffel-signature', signature)
        .set('Content-Type', 'application/json')
        .send(body);

      expect(response.status).toBe(HttpStatus.OK);

      const events = await prisma.duffelWebhookEvent.findMany({
        where: { supplierEventId: `wev_fake_${suffix}` },
      });
      expect(events.length).toBe(1);
    });
  });

  describe('DuffelEventProcessor (Async Processor)', () => {
    it('should process pending inbox event, invoke sync, and complete successfully', async () => {
      // 1. Create a pending webhook event in DB
      await prisma.duffelWebhookEvent.create({
        data: {
          supplierEventId: `wev_proc_${suffix}`,
          eventType: 'order.airline_initiated_change_detected',
          duffelOrderId: `ord_fake_${suffix}`,
          status: 'PENDING',
          rawPayload: {},
        },
      });

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

      // 2. Trigger processor
      await processor.processInboxBatch();

      // 3. Confirm inbox event is PROCESSED
      const event = await prisma.duffelWebhookEvent.findUnique({
        where: { supplierEventId: `wev_proc_${suffix}` },
      });
      expect(event?.status).toBe('PROCESSED');
      expect(event?.processedAt).toBeDefined();

      // 4. Confirm booking status updated to DETECTED (due to material shift)
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(booking?.disruptionStatus).toBe(DisruptionStatus.DETECTED);
    });

    it('should schedule retries for transient failures and escalate on 5th failure', async () => {
      // 1. Create a pending webhook event
      const dbEvent = await prisma.duffelWebhookEvent.create({
        data: {
          supplierEventId: `wev_fail_${suffix}`,
          eventType: 'order.airline_initiated_change_detected',
          duffelOrderId: `ord_fake_${suffix}`,
          status: 'PENDING',
          rawPayload: {},
          attempts: 0,
        },
      });

      // Cause syncBooking to fail
      mockDuffelRecoveryService.retrieveCompleteOrder.mockRejectedValue(new Error('Duffel API timeout'));

      // Tick 1 (Attempt 1 fails -> RETRY_SCHEDULED)
      await processor.processInboxBatch();
      let event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.status).toBe('RETRY_SCHEDULED');
      expect(event?.attempts).toBe(1);
      expect(event?.nextAttemptAt).toBeDefined();

      // For E2E simulation, reset nextAttemptAt so it can be claimed again
      await prisma.duffelWebhookEvent.update({
        where: { id: dbEvent.id },
        data: { nextAttemptAt: null },
      });

      // Tick 2, 3, 4
      for (let i = 2; i <= 4; i++) {
        await processor.processInboxBatch();
        await prisma.duffelWebhookEvent.update({
          where: { id: dbEvent.id },
          data: { nextAttemptAt: null },
        });
      }

      event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.attempts).toBe(4);

      // Tick 5 (Attempt 5 fails -> Escalate to FAILED_NEEDS_ATTENTION)
      await processor.processInboxBatch();
      event = await prisma.duffelWebhookEvent.findUnique({ where: { id: dbEvent.id } });
      expect(event?.status).toBe('FAILED_NEEDS_ATTENTION');
      expect(event?.attempts).toBe(5);
      expect(event?.nextAttemptAt).toBeNull();
    });
  });

  describe('Disruption APIs (Phase 6)', () => {
    let otherUserToken: string;

    beforeEach(async () => {
      const otherUser = await prisma.user.create({
        data: {
          email: `other-test-user-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          role: 'USER',
          status: 'ACTIVE',
        },
      });
      otherUserToken = jwtService.sign(
        { id: otherUser.id, email: otherUser.email },
        { expiresIn: '1h' },
      );
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

    it('populates extended fields (currentItinerary and disruption) in list and details endpoints', async () => {
      // Create an itinerary revision for the booking
      const rev = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          source: 'WEBHOOK',
          version: 1,
          fingerprint: 'test-fingerprint-1',
          incrementalDiff: { presentationSummary: { details: 'incremental' } } as any,
          cumulativeDiff: { presentationSummary: { details: 'cumulative' } } as any,
          isMaterial: true,
          segments: {
            create: [
              {
                supplierSegmentId: 'seg_new_1',
                airlineName: 'Japan Airlines',
                marketingCarrierIata: 'JL',
                operatingCarrierIata: 'JL',
                flightNumber: '752',
                departureAirportIata: 'HAN',
                departureAirportName: 'Noi Bai',
                departureCity: 'Hanoi',
                arrivalAirportIata: 'NRT',
                arrivalAirportName: 'Narita',
                arrivalCity: 'Tokyo',
                departureAt: new Date('2026-08-01T15:00:00Z'),
                arrivalAt: new Date('2026-08-01T22:00:00Z'),
                departureLocalDate: new Date('2026-08-01T00:00:00Z'),
                arrivalLocalDate: new Date('2026-08-01T00:00:00Z'),
                durationMinutes: 420,
                sliceOrder: 0,
                segmentOrder: 0,
                globalOrder: 0,
              },
            ],
          },
        },
      });
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          disruptionStatus: 'DETECTED',
          activeDisruptionRevisionId: rev.id,
        },
      });

      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'true';
      const detailsRes = await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(detailsRes.body.disruption).toBeDefined();
      expect(detailsRes.body.disruption.status).toBe('DETECTED');
      expect(detailsRes.body.disruption.activeRevisionId).toBe(rev.id);
      expect(detailsRes.body.disruption.isMaterial).toBe(true);
      expect(detailsRes.body.disruption.incrementalSummary).toEqual({ details: 'incremental' });
      expect(detailsRes.body.disruption.cumulativeSummary).toEqual({ details: 'cumulative' });

      expect(detailsRes.body.currentItinerary).toBeDefined();
      expect(detailsRes.body.currentItinerary.source).toBe('REVISION');
      expect(detailsRes.body.currentItinerary.revisionId).toBe(rev.id);
      expect(detailsRes.body.currentItinerary.version).toBe(1);
      expect(detailsRes.body.currentItinerary.segments).toHaveLength(1);
      expect(detailsRes.body.currentItinerary.segments[0].duffelSegmentId).toBe(`seg_new_1`);
      expect(detailsRes.body.currentItinerary.segments[0].airline.iataCode).toBe('JL');
      expect(detailsRes.body.currentItinerary.segments[0].departureAirport.iataCode).toBe('HAN');

      // Check list endpoint
      const listRes = await request(app.getHttpServer())
        .get('/api/bookings')
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      const listedBooking = listRes.body.bookings.find((b: any) => b.id === bookingId);
      expect(listedBooking).toBeDefined();
      expect(listedBooking.disruption).toBeDefined();
      expect(listedBooking.disruption.status).toBe('DETECTED');
      expect(listedBooking.currentItinerary).toBeDefined();
      expect(listedBooking.currentItinerary.source).toBe('REVISION');

      // Check customer-surfacing flag disabled fallback
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'false';
      const detailsResDisabled = await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(detailsResDisabled.body.disruption.status).toBe('NONE');
      expect(detailsResDisabled.body.disruption.activeRevisionId).toBeNull();
      expect(detailsResDisabled.body.currentItinerary.source).toBe('ORIGINAL');
      expect(detailsResDisabled.body.currentItinerary.revisionId).toBeNull();
      expect(detailsResDisabled.body.currentItinerary.version).toBe(0);

      delete process.env.FEATURE_FLAG_DISRUPTION_SURFACING;
    });

    it('returns disruption history with pagination and order', async () => {
      // Create multiple itinerary revisions
      await prisma.itineraryRevision.create({
        data: {
          bookingId,
          source: 'WEBHOOK',
          version: 1,
          fingerprint: 'test-fingerprint-1',
          incrementalDiff: { presentationSummary: { details: 'inc-1' } } as any,
          cumulativeDiff: { presentationSummary: { details: 'cum-1' } } as any,
          isMaterial: true,
          createdAt: new Date('2026-01-01T12:00:00Z'),
        },
      });

      await prisma.itineraryRevision.create({
        data: {
          bookingId,
          source: 'WEBHOOK',
          version: 2,
          fingerprint: 'test-fingerprint-2',
          incrementalDiff: { presentationSummary: { details: 'inc-2' } } as any,
          cumulativeDiff: { presentationSummary: { details: 'cum-2' } } as any,
          isMaterial: true,
          createdAt: new Date('2026-01-02T12:00:00Z'),
        },
      });

      // Page 1, limit 1
      const res = await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?page=1&limit=1`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.items).toHaveLength(1);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(1);
      expect(res.body.total).toBe(2);
      expect(res.body.totalPages).toBe(2);
      // Newest version first
      expect(res.body.items[0].version).toBe(2);
      expect(res.body.items[0].incrementalSummary).toEqual({ details: 'inc-2' });
    });

    it('rejects invalid pagination parameters with 400 BadRequest', async () => {
      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?page=abc`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?limit=xyz`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?page=-1`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?limit=100`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?page=1&page=2`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);

      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions?limit[]=20`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(400);
    });

    it('enforces ownership and missing-booking boundaries for history and actions', async () => {
      const rev = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          source: 'WEBHOOK',
          version: 1,
          fingerprint: 'test-fingerprint-1',
          incrementalDiff: {},
          cumulativeDiff: {},
          isMaterial: true,
        },
      });

      // 403 Other owner
      await request(app.getHttpServer())
        .get(`/api/bookings/${bookingId}/disruptions`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${rev.id}/acknowledge`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${rev.id}/accept`)
        .set('Authorization', `Bearer ${otherUserToken}`)
        .expect(403);

      // 404 Missing booking
      const fakeId = crypto.randomUUID();
      await request(app.getHttpServer())
        .get(`/api/bookings/${fakeId}/disruptions`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/bookings/${fakeId}/disruptions/${rev.id}/acknowledge`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(404);
    });

    it('transitions state atomically and idempotently for lifecycle actions (acknowledge, accept)', async () => {
      const mockRevision = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          version: 1,
          source: 'WEBHOOK',
          fingerprint: 'fp_1',
          isMaterial: true,
          incrementalDiff: {},
          cumulativeDiff: {},
        },
      });
      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'DETECTED', activeDisruptionRevisionId: mockRevision.id },
      });

      // 1. Acknowledge
      const ackRes1 = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/acknowledge`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(ackRes1.body.disruptionStatus).toBe('ACKNOWLEDGED');
      expect(ackRes1.body.activeRevisionId).toBe(mockRevision.id);

      // Idempotency check for acknowledge
      const ackRes2 = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/acknowledge`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(ackRes2.body.disruptionStatus).toBe('ACKNOWLEDGED');

      // 2. Accept
      const acceptRes1 = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/accept`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(acceptRes1.body.disruptionStatus).toBe('RESOLVED');
      expect(acceptRes1.body.resolvedReason).toBe('TRAVELLER_ACCEPTED');
      expect(acceptRes1.body.resolvedAt).toBeDefined();

      // Idempotency check for accept
      const acceptRes2 = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/accept`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(200);
      expect(acceptRes2.body.disruptionStatus).toBe('RESOLVED');

      // 3. Stale revision checks (409)
      const newerRevision = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          version: 2,
          source: 'WEBHOOK',
          fingerprint: 'fp_2',
          isMaterial: true,
          incrementalDiff: {},
          cumulativeDiff: {},
        },
      });
      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'DETECTED', activeDisruptionRevisionId: newerRevision.id },
      });

      // Call acknowledge on stale revision (version 1)
      const staleAck = await request(app.getHttpServer())
        .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/acknowledge`)
        .set('Authorization', `Bearer ${userToken}`)
        .expect(409);
      expect(staleAck.body.code).toBe('STALE_DISRUPTION_REVISION');
      expect(staleAck.body.activeRevisionId).toBe(newerRevision.id);
      expect(staleAck.body.disruptionStatus).toBe('DETECTED');

      // Check transition audit events exist
      const audits = await prisma.disruptionAuditEvent.findMany({
        where: { bookingId },
        orderBy: { createdAt: 'asc' },
      });
      const actions = audits.map((a) => a.action);
      expect(actions).toContain('ACKNOWLEDGED');
      expect(actions).toContain('TRAVELLER_ACCEPTED');

      const travellerAudit = audits.find((a) => a.action === 'TRAVELLER_ACCEPTED');
      expect(travellerAudit?.actorType).toBe('TRAVELLER');
      expect(travellerAudit?.actorId).toBe(userId);
    });

    it('handles concurrent acknowledge and accept transitions without status regression', async () => {
      const mockRevision = await prisma.itineraryRevision.create({
        data: {
          bookingId,
          version: 1,
          source: 'WEBHOOK',
          fingerprint: `fp_${crypto.randomUUID()}`,
          isMaterial: true,
          incrementalDiff: {},
          cumulativeDiff: {},
        },
      });
      await prisma.booking.update({
        where: { id: bookingId },
        data: { disruptionStatus: 'DETECTED', activeDisruptionRevisionId: mockRevision.id },
      });

      // Send both concurrently
      const [resAck, resAccept] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/acknowledge`)
          .set('Authorization', `Bearer ${userToken}`),
        request(app.getHttpServer())
          .post(`/api/bookings/${bookingId}/disruptions/${mockRevision.id}/accept`)
          .set('Authorization', `Bearer ${userToken}`),
      ]);

      // Both should succeed
      expect(resAck.status).toBe(200);
      expect(resAccept.status).toBe(200);

      // The final status in the database must be RESOLVED (no regression to ACKNOWLEDGED)
      const finalBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(finalBooking?.disruptionStatus).toBe('RESOLVED');
    });
  });
});
