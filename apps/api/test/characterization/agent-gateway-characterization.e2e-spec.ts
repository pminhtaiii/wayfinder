process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
process.env.ATTESTATION_SECRET = 'test-attestation-secret';
process.env.CHAT_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelSearchAdapter } from '@/supplier/search/duffel-search.adapter';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { User, Prisma } from '@prisma/client';
import * as crypto from 'crypto';

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('Agent Gateway Characterization (E2E)', () => {
  jest.setTimeout(60000);
  let app: INestApplication;
  let prisma: PrismaService;
  let searchAdapter: DuffelSearchAdapter;
  let attestationService: SelectionAttestationService;

  const apiKey = 'test-agent-api-key';
  let userA: User;
  let userB: User;
  let claimTokenA: string;
  let claimTokenB: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
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
    searchAdapter = moduleFixture.get<DuffelSearchAdapter>(DuffelSearchAdapter);
    attestationService = moduleFixture.get<SelectionAttestationService>(
      SelectionAttestationService,
    );

    // Mock Duffel flight search
    jest.spyOn(searchAdapter, 'searchOffers').mockImplementation(async (query) => {
      const offerRequest = {
        id: 'or_char_123',
        offers: [
          {
            id: 'off_char_1',
            total_amount: String(250.0 * (Number(query.adults) || 1)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_char_1',
                duration: 'PT2H10M',
                origin: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                destination: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                segments: [
                  {
                    id: 'seg_char_1',
                    duration: 'PT2H10M',
                    departing_at: '2027-07-15T08:30:00',
                    arriving_at: '2027-07-15T10:40:00',
                    origin: { id: 'SGN', name: 'Tan Son Nhat', iata_code: 'SGN', type: 'airport' },
                    destination: { id: 'HAN', name: 'Noi Bai', iata_code: 'HAN', type: 'airport' },
                    operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier_flight_number: '123',
                    passengers: [
                      {
                        passenger_id: 'pas_char_1',
                        cabin_class: 'economy',
                        baggages: [{ type: 'checked', quantity: 1 }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      };
      return offerRequest;
    });
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

    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'SGN',
          name: 'Tan Son Nhat',
          city: 'Ho Chi Minh',
          country: 'VN',
          latitude: 10.82,
          longitude: 106.65,
          type: 'LARGE_AIRPORT',
        },
        {
          iataCode: 'HAN',
          name: 'Noi Bai',
          city: 'Hanoi',
          country: 'VN',
          latitude: 21.22,
          longitude: 105.8,
          type: 'LARGE_AIRPORT',
        },
      ],
    });

    userA = await prisma.user.create({
      data: {
        email: `agent-user-a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });

    userB = await prisma.user.create({
      data: {
        email: `agent-user-b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
        role: 'USER',
      },
    });

    const nowSeconds = Math.floor(Date.now() / 1000);
    claimTokenA = mintClaimToken(userA.id, nowSeconds);
    claimTokenB = mintClaimToken(userB.id, nowSeconds);
  });

  describe('Route 1: GET /api/agent-gateway/flights/search', () => {
    it('returns 200 with flights array and PII-free projection when valid auth and query provided', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .query({
          origin: 'SGN',
          destination: 'HAN',
          departureDate: '2027-07-15',
          adults: 1,
        })
        .expect(200);

      expect(res.body.results).toBeDefined();
      expect(Array.isArray(res.body.results)).toBe(true);
      expect(res.body.results.length).toBeGreaterThan(0);

      const flight = res.body.results[0];
      expect(flight.airline).toBe('Vietnam Airlines');
      expect(flight.departureAirport).toBe('SGN');
      expect(flight.arrivalAirport).toBe('HAN');
      expect(flight.price).toBeDefined();
      expect(flight.currency).toBe('USD');

      // Assert PII-free projection: no user details, no secrets
      expect(flight).not.toHaveProperty('user');
      expect(flight).not.toHaveProperty('password');
      expect(flight).not.toHaveProperty('passportNumber');
      expect(res.body).not.toHaveProperty('user');
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passportNumber');
    });

    it('rejects with 401 when X-Agent-API-Key is missing or invalid', async () => {
      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-User-Claim', claimTokenA)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(401);

      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', 'wrong-api-key')
        .set('X-User-Claim', claimTokenA)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(401);
    });

    it('rejects with 401 when X-User-Claim is missing, expired, or invalid signature', async () => {
      // Missing
      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(401);

      // Expired (> 300s)
      const expiredToken = mintClaimToken(userA.id, Math.floor(Date.now() / 1000) - 400);
      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', expiredToken)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(401);

      // Invalid signature
      const invalidSignatureToken = mintClaimToken(
        userA.id,
        Math.floor(Date.now() / 1000),
        'wrong-secret',
      );
      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', invalidSignatureToken)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(401);
    });

    it('rejects with 403 when user does not exist in DB or is INACTIVE', async () => {
      const nonExistentUserId = crypto.randomUUID();
      const tokenNonExistent = mintClaimToken(nonExistentUserId, Math.floor(Date.now() / 1000));

      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', tokenNonExistent)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(403);

      const inactiveUser = await prisma.user.create({
        data: {
          email: `inactive-${Date.now()}@example.com`,
          password: 'Password123!',
          status: 'INACTIVE',
          role: 'USER',
        },
      });
      const tokenInactive = mintClaimToken(inactiveUser.id, Math.floor(Date.now() / 1000));

      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', tokenInactive)
        .query({ origin: 'SGN', destination: 'HAN', departureDate: '2027-07-15', adults: 1 })
        .expect(403);
    });

    it('rejects with 400 on malformed search query', async () => {
      await request(app.getHttpServer())
        .get('/api/agent-gateway/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .query({ origin: 'INVALID_LONG_CODE', destination: 'HAN' }) // missing departureDate, invalid origin
        .expect(400);
    });
  });

  describe('Route 2: POST /api/agent-gateway/v2/flights/search', () => {
    it('returns 201 with attested flight search result', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: userA.id },
      });

      const res = await request(app.getHttpServer())
        .post('/api/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: {
            origin: 'SGN',
            destination: 'HAN',
            departureDate: '2027-07-15',
            adults: 1,
          },
        })
        .expect(201);

      expect(res.body.results).toBeDefined();
      expect(res.body.selectionAttestation).toBeDefined();
      expect(res.body.snapshotVersion).toBe(1);
    });

    it('rejects with 400 on malformed search body', async () => {
      await request(app.getHttpServer())
        .post('/api/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({ chatSessionId: 'invalid' }) // missing search and proposedSnapshotVersion
        .expect(400);
    });
  });

  describe('Route 3: GET /api/agent-gateway/users/preferences', () => {
    it('returns 200 with UserPreferencesDto and no raw plaintext PII', async () => {
      await prisma.travelerProfile.create({
        data: {
          userId: userA.id,
          seatPreference: 'AISLE',
          dietaryNeeds: 'VEGETARIAN',
          classPreference: 'economy',
          preferredAirlines: ['VN'],
          blacklistedAirlines: [],
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .expect(200);

      expect(res.body.seatPreference).toBe('AISLE');
      expect(res.body.dietaryNeeds).toBe('VEGETARIAN');
      expect(res.body.classPreference).toBe('economy');
      expect(res.body.preferredAirlines).toEqual(['VN']);

      // Security check: ensure no decrypted passport PII or passwords
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('passportNumber');
    });
  });

  describe('Route 4: GET /api/agent-gateway/users/bookings/summaries', () => {
    it('returns 200 with BookingSummariesResponseDto containing safe allowlisted projection fields', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: userA.id,
          supplierOfferId: `off_${Date.now()}`,
          status: 'CONFIRMED',
          originalPrice: new Prisma.Decimal(100.0),
          confirmedPrice: new Prisma.Decimal(100.0),
          currency: 'USD',
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

      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          status: 'CONFIRMED',
          pnrReference: 'AGTSUM1',
          totalAmount: new Prisma.Decimal(100.0),
          currency: 'USD',
          departureAt: new Date('2027-10-01T08:00:00Z'),
        },
      });

      const agentRef = `bkref_${crypto.randomUUID()}`;
      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: booking.id,
          agentReference: agentRef,
          status: 'CONFIRMED',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date('2027-10-01T08:00:00Z'),
          arrivalAt: new Date('2027-10-01T10:10:00Z'),
          durationMinutes: 130,
          stopCount: 0,
          flightNumber: 'VN 123',
          baggageSummary: '1 checked bag',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/agent-gateway/users/bookings/summaries')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .expect(200);

      expect(res.body.bookings).toBeDefined();
      expect(Array.isArray(res.body.bookings)).toBe(true);
      expect(res.body.bookings.length).toBe(1);

      const summary = res.body.bookings[0];
      expect(summary.bookingReference).toBe(agentRef);
      expect(summary.airline).toBe('Vietnam Airlines');
      expect(summary.origin).toBe('SGN');
      expect(summary.destination).toBe('HAN');
      expect(summary.status).toBe('CONFIRMED');

      // Security check: ensure private internal IDs and payment details are omitted
      expect(summary).not.toHaveProperty('paymentId');
      expect(summary).not.toHaveProperty('stripePaymentIntentId');
      expect(summary).not.toHaveProperty('passengerSnapshot');
    });
  });

  describe('Route 5: GET /api/agent-gateway/users/bookings/:bookingReference', () => {
    it('returns 200 with BookingDetailDto when user owns the booking projection', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: userA.id,
          supplierOfferId: `off_${Date.now()}`,
          status: 'CONFIRMED',
          originalPrice: new Prisma.Decimal(100.0),
          confirmedPrice: new Prisma.Decimal(100.0),
          currency: 'USD',
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

      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          status: 'CONFIRMED',
          pnrReference: 'AGTDET1',
          totalAmount: new Prisma.Decimal(100.0),
          currency: 'USD',
          departureAt: new Date('2027-10-01T08:00:00Z'),
        },
      });

      const agentRef = `bkref_${crypto.randomUUID()}`;
      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: booking.id,
          agentReference: agentRef,
          status: 'CONFIRMED',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date('2027-10-01T08:00:00Z'),
          arrivalAt: new Date('2027-10-01T10:10:00Z'),
          durationMinutes: 130,
          stopCount: 0,
          flightNumber: 'VN 123',
          baggageSummary: '1 checked bag',
        },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/agent-gateway/users/bookings/${agentRef}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .expect(200);

      expect(res.body.bookingReference).toBe(agentRef);
      expect(res.body.airline).toBe('Vietnam Airlines');
      expect(res.body.origin).toBe('SGN');
      expect(res.body.destination).toBe('HAN');
      expect(res.body.status).toBe('CONFIRMED');
    });

    it('returns 404 when querying another user booking reference (isolation)', async () => {
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: userA.id,
          supplierOfferId: `off_${Date.now()}`,
          status: 'CONFIRMED',
          originalPrice: new Prisma.Decimal(100.0),
          confirmedPrice: new Prisma.Decimal(100.0),
          currency: 'USD',
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

      const booking = await prisma.booking.create({
        data: {
          id: crypto.randomUUID(),
          userId: userA.id,
          bookingIntentId: intent.id,
          status: 'CONFIRMED',
          totalAmount: new Prisma.Decimal(100.0),
          currency: 'USD',
        },
      });

      const agentRef = `bkref_${crypto.randomUUID()}`;
      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: booking.id,
          agentReference: agentRef,
          status: 'CONFIRMED',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date('2027-10-01T08:00:00Z'),
          arrivalAt: new Date('2027-10-01T10:10:00Z'),
          durationMinutes: 130,
          stopCount: 0,
        },
      });

      // User B tries to query User A's projection -> 404
      await request(app.getHttpServer())
        .get(`/api/agent-gateway/users/bookings/${agentRef}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenB)
        .expect(404);
    });

    it('returns 404 on non-existent booking reference', async () => {
      const nonExistentRef = `bkref_${crypto.randomUUID()}`;
      await request(app.getHttpServer())
        .get(`/api/agent-gateway/users/bookings/${nonExistentRef}`)
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .expect(404);
    });
  });

  describe('Route 6: POST /api/agent-gateway/bookings/readiness and POST /api/chat-handoff', () => {
    it('evaluates booking readiness via POST /api/agent-gateway/bookings/readiness', async () => {
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: `sh-${crypto.randomUUID()}`,
          supplierOfferId: `off_readiness_${Date.now()}`,
          rawOffer: {
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                    departing_at: '2027-10-01T08:00:00Z',
                    arriving_at: '2027-10-01T10:00:00Z',
                  },
                ],
              },
            ],
            passengers: [
              {
                id: 'pas_readiness_1',
                type: 'adult',
              },
            ],
          },
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2027-10-01'),
          adults: 1,
          price: new Prisma.Decimal(100.0),
          currency: 'USD',
        },
      });

      const res = await request(app.getHttpServer())
        .post('/api/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              sourceType: 'inline',
            },
          ],
        })
        .expect(200);

      expect(res.body.scope).toBeDefined();
      expect(res.body.ready).toBeDefined();
      expect(res.body.passengers).toBeDefined();
      expect(res.body.nextAction).toBeDefined();
    });

    it('rejects booking readiness on malformed body (400 Bad Request)', async () => {
      await request(app.getHttpServer())
        .post('/api/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({ flightOfferId: 'not-a-uuid' })
        .expect(400);
    });

    it('creates chat handoff token via POST /api/chat-handoff', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: userA.id },
      });

      const expiresAt = new Date(Date.now() + 3600000).toISOString();
      const offer = await prisma.flightOffer.create({
        data: {
          searchHash: `sh-${crypto.randomUUID()}`,
          supplierOfferId: `off_handoff_${Date.now()}`,
          rawOffer: {
            expires_at: expiresAt,
            slices: [
              {
                segments: [
                  {
                    origin: { iata_code: 'SGN' },
                    destination: { iata_code: 'HAN' },
                  },
                ],
              },
            ],
          },
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date('2027-10-01'),
          adults: 1,
          price: new Prisma.Decimal(100.0),
          currency: 'USD',
        },
      });

      // Sign valid attestation
      const attestation = await attestationService.signSelectionAttestation(
        userA.id,
        session.id,
        1,
        expiresAt,
        [{ flightOfferId: offer.id, duffelOfferId: offer.supplierOfferId }],
      );

      const res = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(201);

      expect(res.body.handoffToken).toBeDefined();
      expect(res.body.expiresAt).toBeDefined();

      const dbHandoff = await prisma.chatHandoff.findFirst({
        where: { userId: userA.id, chatSessionId: session.id },
      });
      expect(dbHandoff).toBeDefined();
    });

    it('rejects chat handoff on invalid attestation (401 Unauthorized)', async () => {
      await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({
          selectionAttestationHash: 'invalid-attestation-token',
          selectedOfferIndex: 1,
        })
        .expect(401);
    });

    it('rejects chat handoff on malformed body (400 Bad Request)', async () => {
      await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimTokenA)
        .send({ selectedOfferIndex: 0 }) // invalid index (< 1), missing attestation
        .expect(400);
    });
  });
});
