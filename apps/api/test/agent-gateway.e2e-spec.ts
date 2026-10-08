import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '@/prisma/prisma.service';
import { DuffelSearchAdapter } from '@/supplier/search/duffel-search.adapter';
import * as crypto from 'crypto';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { User } from '@prisma/client';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);

  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();

  const base64UrlPayload = Buffer.from(payloadStr).toString('base64url');
  const base64UrlSignature = signature.toString('base64url');

  return `${base64UrlPayload}.${base64UrlSignature}`;
}

describe('Agent Gateway (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cryptoService: ChatMessageCryptoService;
  const previousBookingReadinessFlag = process.env.FEATURE_FLAG_BOOKING_READINESS;

  const apiKey = 'test-agent-api-key';

  beforeAll(async () => {
    // Configure env variables for testing
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.ATTESTATION_SECRET = 'test-attestation-secret';
    process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';

    // Human-approved fixture correction (2026-10-08): AppModule snapshots validated env during import.
    const { AppModule } = await import('@/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    cryptoService = moduleFixture.get<ChatMessageCryptoService>(ChatMessageCryptoService);

    jest.spyOn(DuffelSearchAdapter.prototype, 'searchOffers').mockImplementation(async (query) => {
      const offerRequest = {
        id: 'or_123',
        offers: [
          {
            id: 'off_1',
            total_amount: String(452.0 * (Number(query.adults) || 2)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_1',
                duration: 'PT5H30M',
                origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_1',
                    duration: 'PT5H30M',
                    departing_at: '2027-07-15T08:30:00',
                    arriving_at: '2027-07-15T15:00:00',
                    origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                    marketing_carrier_flight_number: '310',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'economy',
                        baggages: [{ type: 'checked', weight: 23, weight_unit: 'KG' }],
                      },
                    ],
                  },
                ],
              },
            ],
            passengers: [{ id: 'pas_1', type: 'adult' }],
            passenger_identity_documents_required: false,
          },
          {
            id: 'off_2',
            total_amount: String(389.0 * (Number(query.adults) || 2)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_2',
                duration: 'PT6H30M',
                origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_2',
                    duration: 'PT6H30M',
                    departing_at: '2027-07-15T10:15:00',
                    arriving_at: '2027-07-15T17:45:00',
                    origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'NH', name: 'Ana', iata_code: 'NH' },
                    marketing_carrier: { id: 'NH', name: 'Ana', iata_code: 'NH' },
                    marketing_carrier_flight_number: '858',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'economy',
                        baggages: [{ type: 'checked', weight: 23, weight_unit: 'KG' }],
                      },
                    ],
                  },
                ],
              },
            ],
            passengers: [{ id: 'pas_1', type: 'adult' }],
            passenger_identity_documents_required: false,
          },
          {
            id: 'off_3',
            total_amount: String(520.0 * (Number(query.adults) || 2)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_3',
                duration: 'PT5H35M',
                origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_3',
                    duration: 'PT5H35M',
                    departing_at: '2027-07-15T23:55:00',
                    arriving_at: '2027-07-15T07:30:00',
                    origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'JL', name: 'Japan Airlines', iata_code: 'JL' },
                    marketing_carrier: { id: 'JL', name: 'Japan Airlines', iata_code: 'JL' },
                    marketing_carrier_flight_number: '752',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'business',
                        baggages: [{ type: 'checked', weight: 32, weight_unit: 'KG' }],
                      },
                    ],
                  },
                ],
              },
            ],
            passengers: [{ id: 'pas_1', type: 'adult' }],
            passenger_identity_documents_required: false,
          },
          {
            id: 'off_4',
            total_amount: String(199.0 * (Number(query.adults) || 2)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_4',
                duration: 'PT5H45M',
                origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_4',
                    duration: 'PT5H45M',
                    departing_at: '2027-07-15T00:15:00',
                    arriving_at: '2027-07-15T08:00:00',
                    origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'VJ', name: 'Vietjet Air', iata_code: 'VJ' },
                    marketing_carrier: { id: 'VJ', name: 'Vietjet Air', iata_code: 'VJ' },
                    marketing_carrier_flight_number: '932',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'economy',
                        baggages: [{ type: 'checked', quantity: 0 }],
                      },
                    ],
                  },
                ],
              },
            ],
            passengers: [{ id: 'pas_1', type: 'adult' }],
            passenger_identity_documents_required: false,
          },
          {
            id: 'off_5',
            total_amount: String(610.0 * (Number(query.adults) || 2)),
            total_currency: 'USD',
            slices: [
              {
                id: 'sli_5',
                duration: 'PT9H30M',
                origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                segments: [
                  {
                    id: 'seg_5',
                    duration: 'PT9H30M',
                    departing_at: '2027-07-15T12:00:00',
                    arriving_at: '2027-07-15T21:30:00',
                    origin: { id: 'HAN', name: 'Hanoi', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'NRT', name: 'Narita', iata_code: 'NRT', type: 'airport' },
                    operating_carrier: { id: 'SQ', name: 'Singapore Airlines', iata_code: 'SQ' },
                    marketing_carrier: { id: 'SQ', name: 'Singapore Airlines', iata_code: 'SQ' },
                    marketing_carrier_flight_number: '176',
                    passengers: [
                      {
                        passenger_id: 'pas_1',
                        cabin_class: 'premium_economy',
                        baggages: [{ type: 'checked', weight: 30, weight_unit: 'KG' }],
                      },
                    ],
                  },
                ],
              },
            ],
            passengers: [{ id: 'pas_1', type: 'adult' }],
            passenger_identity_documents_required: false,
          },
        ],
        slices: [],
        passengers: [],
      };

      return offerRequest;
    });
  });

  afterAll(async () => {
    try {
      if (app) {
        await app.close();
      }
    } finally {
      if (previousBookingReadinessFlag === undefined) {
        delete process.env.FEATURE_FLAG_BOOKING_READINESS;
      } else {
        process.env.FEATURE_FLAG_BOOKING_READINESS = previousBookingReadinessFlag;
      }
    }
  });

  beforeEach(async () => {
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

    // User-requested CI repair: canonical search validates the airport reference table.
    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'HAN',
          name: 'Noi Bai',
          city: 'Hanoi',
          country: 'VN',
          latitude: 21.2212,
          longitude: 105.807,
          type: 'LARGE_AIRPORT',
        },
        {
          iataCode: 'SGN',
          name: 'Tan Son Nhat',
          city: 'Ho Chi Minh City',
          country: 'VN',
          latitude: 10.8184,
          longitude: 106.6633,
          type: 'LARGE_AIRPORT',
        },
        {
          iataCode: 'NRT',
          name: 'Narita',
          city: 'Tokyo',
          country: 'JP',
          latitude: 35.7647,
          longitude: 140.3864,
          type: 'LARGE_AIRPORT',
        },
      ],
    });
  });

  describe('Authentication and Security (Layer 1 & 2)', () => {
    it('should reject requests with missing X-Agent-API-Key', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .expect(401);

      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('should reject requests with incorrect X-Agent-API-Key', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', 'wrong-key')
        .expect(401);

      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('should reject requests with missing X-User-Claim', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with malformed X-User-Claim', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', 'malformedtoken')
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with invalid claim token signature', async () => {
      const userId = crypto.randomUUID();
      const iat = Math.floor(Date.now() / 1000);
      const invalidToken = mintClaimToken(userId, iat, 'wrong-secret');

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', invalidToken)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests with expired claim token', async () => {
      const userId = crypto.randomUUID();
      const expiredIat = Math.floor(Date.now() / 1000) - 360; // 6 mins ago
      const expiredToken = mintClaimToken(userId, expiredIat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', expiredToken)
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should reject requests if user does not exist in PostgreSQL', async () => {
      const nonExistentUserId = crypto.randomUUID();
      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(nonExistentUserId, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(403);

      expect(res.body.code).toBe('USER_INACTIVE');
    });

    it('should reject requests if user is INACTIVE', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'inactive-agent@example.com',
          password: 'Password123!',
          status: 'INACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(403);

      expect(res.body.code).toBe('USER_INACTIVE');
    });
  });

  describe('User Preferences Endpoint (GET /users/preferences)', () => {
    it('should return 404 PROFILE_NOT_FOUND when user profile does not exist', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'noprofile@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(404);

      expect(res.body.code).toBe('PROFILE_NOT_FOUND');
    });

    it('should return preferences and structurally exclude PII fields', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'hasprofile@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      await prisma.travelerProfile.create({
        data: {
          userId: user.id,
          seatPreference: 'window',
          classPreference: 'business',
          preferredAirlines: ['VN', 'SQ'],
          blacklistedAirlines: [],
          dietaryNeeds: 'vegetarian',
          nationality: 'VN',
          passportNumber: 'SENSITIVE_PASSPORT_123', // PII
          passportExpiry: new Date(), // PII
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/preferences')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      // Verify returned fields
      expect(res.body.seatPreference).toBe('window');
      expect(res.body.classPreference).toBe('business');
      expect(res.body.preferredAirlines).toEqual(['VN', 'SQ']);
      expect(res.body.blacklistedAirlines).toEqual([]);
      expect(res.body.dietaryNeeds).toBe('vegetarian');

      // Crucial: PII exclusion checks
      expect(res.body.passportNumber).toBeUndefined();
      expect(res.body.passportExpiry).toBeUndefined();
      expect(res.body.nationality).toBeUndefined(); // nationality is also excluded as per specs
    });
  });

  describe('User Bookings Endpoint (GET /users/bookings)', () => {
    it('should return empty list if user has no bookings', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'nobookings@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/bookings')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.bookings).toEqual([]);
    });

    it('should return bookings and structurally exclude PII fields', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'hasbookings@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const flightOffer = await prisma.flightOffer.create({
        data: {
          searchHash: 'search_hash_123',
          supplierOfferId: 'off_123',
          rawOffer: {},
          origin: 'HAN',
          destination: 'NRT',
          departureDate: new Date('2027-07-15T00:00:00Z'),
          adults: 1,
          cabinClass: 'economy',
          price: 1250.0,
          currency: 'USD',
        },
      });
      const intent = await prisma.bookingIntent.create({
        data: {
          userId: user.id,
          flightOfferId: flightOffer.id,
          supplierOfferId: 'off_123',
          status: 'CONFIRMED',
          originalPrice: 1250.0,
          confirmedPrice: 1250.0,
          pricedAt: new Date(),
          origin: 'HAN',
          destination: 'NRT',
          departureDate: new Date('2027-07-15T00:00:00Z'),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 100000),
        },
      });

      await prisma.booking.create({
        data: {
          userId: user.id,
          bookingIntentId: intent.id,
          pnrReference: 'PNR_SECRET_123', // PII
          status: 'CONFIRMED',
          totalAmount: 1250.0,
          currency: 'USD',
          departureAt: new Date('2027-07-15T08:30:00Z'),
          flightSnapshot: {
            segments: [
              {
                airline: { iataCode: 'VN' },
                flightNumber: 'VN310',
                departureAirport: { iataCode: 'HAN' },
                arrivalAirport: { iataCode: 'NRT' },
                departureAt: '2027-07-15T08:30:00.000Z',
                arrivalAt: '2027-07-15T15:00:00.000Z',
              },
            ],
            totalDuration: 'PT5H30M',
            stops: 0,
            fareClass: 'Business',
            baggageAllowance: '32kg checked',
          },
          passengerSnapshot: {
            passengers: [
              {
                id: 'passenger-1',
                type: 'ADULT',
                position: 1,
                baggage: [{ type: 'CHECKED', quantity: 1, unit: 'KG', weight: 32 }],
              },
            ],
          },
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);

      const res = await request(app.getHttpServer())
        .get('/agent-gateway/users/bookings')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.bookings.length).toBe(1);
      const booking = res.body.bookings[0];

      expect(booking.airline).toBe('VN');
      expect(booking.flightNumber).toBe('VN310');
      expect(booking.origin).toBe('HAN');
      expect(booking.destination).toBe('NRT');
      expect(booking.departureTime).toBe('2027-07-15T08:30:00.000Z');
      expect(booking.arrivalTime).toBe('2027-07-15T15:00:00.000Z');
      expect(booking.duration).toBe(330);
      expect(booking.stops).toBe(0);
      expect(booking.fareClass).toBe('Business');
      expect(booking.price).toBe(1250.0);
      expect(booking.currency).toBe('USD');
      expect(booking.passengers).toBe(1);
      expect(booking.baggageAllowance).toBe('32kg checked');
      expect(booking.status).toBe('CONFIRMED');

      // Crucial: PII exclusion checks
      expect(booking.pnrCode).toBeUndefined();
      expect(booking.eTicketNumber).toBeUndefined();
      expect(booking.paymentReference).toBeUndefined();
    });
  });

  describe('Flight Search Endpoint (GET /flights/search)', () => {
    let token: string;
    let user: User;

    beforeEach(async () => {
      user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'searcher@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      token = mintClaimToken(user.id, iat);
    });

    it('should reject invalid airport origin code format', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HANOI&destination=NRT&date=2027-07-15&adults=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should reject past dates', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2020-01-01&adults=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should reject passenger count out of range (e.g. 10)', async () => {
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2027-07-15&adults=10')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);
    });

    it('should successfully search flights and return mock data', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2027-07-15&adults=2')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.results.length).toBe(5);
      // Phase 022 ranks cold-start offers by stops, then price; supplier order is obsolete.
      expect(
        res.body.results.map((result: { flightNumber: string }) => result.flightNumber),
      ).toEqual(['VJ932', 'NH858', 'VN310', 'JL752', 'SQ176']);
      const firstResult = res.body.results.find(
        (result: { flightNumber: string }) => result.flightNumber === 'VN310',
      );

      expect(firstResult.airline).toBe('Vietnam Airlines');
      expect(firstResult.flightNumber).toBe('VN310');
      expect(firstResult.departureAirport).toBe('HAN');
      expect(firstResult.arrivalAirport).toBe('NRT');
      expect(firstResult.departureTime).toBe('2027-07-15T08:30:00');
      expect(firstResult.arrivalTime).toBe('2027-07-15T15:00:00');
      expect(firstResult.duration).toBe(330);
      expect(firstResult.stops).toBe(0);
      expect(firstResult.price).toBe(452.0 * 2);
      expect(firstResult.currency).toBe('USD');
      expect(firstResult.fareClass).toBe('Economy');
      expect(firstResult.baggageAllowance).toBe('23kg checked');
    });
  });

  describe('Audit Logging Verification', () => {
    it('should log audit record for every tool call gateway request', async () => {
      const user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'audithistory@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      const token = mintClaimToken(user.id, iat);
      const traceId = 'test-trace-id-123';
      const correlationId = 'test-correlation-id-456';

      // Call search
      await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2027-07-15&adults=1')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .set('X-Trace-Id', traceId)
        .set('X-Correlation-Id', correlationId)
        .expect(200);

      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id, action: 'AGENT_TOOL_CALL' },
      });

      expect(logs.length).toBe(1);
      const log = logs[0];
      expect(log.action).toBe('AGENT_TOOL_CALL');
      expect(log.resourceType).toBe('agent-gateway');
      expect(log.resourceId).toBe('flights/search');
      expect(log.traceId).toBe(traceId);
      expect(log.correlationId).toBe(correlationId);

      interface ToolCallMetadata {
        toolName: string;
        outcome: string;
        durationMs: number;
        responseSizeBytes: number;
        occurredAt: string;
      }
      const metadata = log.metadata as unknown as ToolCallMetadata;
      expect(metadata.toolName).toBe('flights/search');
      expect(metadata.outcome).toBe('SUCCESS');
      expect(metadata.durationMs).toBeDefined();
      expect(metadata.responseSizeBytes).toBeGreaterThan(0);
      expect((metadata as any).parameters).toBeUndefined();
      expect((metadata as any).claimTokenUserId).toBeUndefined();
    });
  });

  describe('Keyword Degradation and Passenger Validation', () => {
    let token: string;
    let user: User;

    beforeEach(async () => {
      user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'keyword-tester@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      token = mintClaimToken(user.id, iat);
    });

    it('should throw 400 when user latest chat message contains cabin keywords', async () => {
      // 1. Create a ChatSession
      const session = await prisma.chatSession.create({
        data: {
          userId: user.id,
        },
      });

      // 2. Create an encrypted ChatMessage with cabin keyword 'business'
      const msgId = crypto.randomUUID();
      const encMsg = await cryptoService.encryptMessageContent(
        msgId,
        session.id,
        'USER',
        'STANDARD',
        'Find me a business class flight from SGN to NRT',
      );
      await prisma.chatMessage.create({
        data: {
          id: msgId,
          sessionId: session.id,
          sender: 'USER',
          type: 'STANDARD',
          contentCiphertext: encMsg.ciphertext,
          contentNonce: encMsg.nonce,
          contentAuthTag: encMsg.authTag,
          contentKeyVersion: encMsg.keyVersion,
        },
      });

      // 3. Perform search
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=SGN&destination=NRT&date=2027-07-20&adults=1')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);

      expect(res.body.message).toContain(
        'I can currently only search economy class for adult passengers',
      );

      // Verify audit log has AGENT_KEYWORD_TRIGGER
      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id, action: 'AGENT_KEYWORD_TRIGGER' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].metadata).toMatchObject({
        matchedKeywords: ['business'],
        messageId: expect.any(String),
      });
    });

    it('should throw 400 when user latest chat message contains passenger keywords', async () => {
      // 1. Create a ChatSession
      const session = await prisma.chatSession.create({
        data: {
          userId: user.id,
        },
      });

      // 2. Create an encrypted ChatMessage with passenger keyword 'infant'
      const msgId = crypto.randomUUID();
      const encMsg = await cryptoService.encryptMessageContent(
        msgId,
        session.id,
        'USER',
        'STANDARD',
        'I want to travel with an infant',
      );
      await prisma.chatMessage.create({
        data: {
          id: msgId,
          sessionId: session.id,
          sender: 'USER',
          type: 'STANDARD',
          contentCiphertext: encMsg.ciphertext,
          contentNonce: encMsg.nonce,
          contentAuthTag: encMsg.authTag,
          contentKeyVersion: encMsg.keyVersion,
        },
      });

      // 3. Perform search
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=SGN&destination=NRT&date=2027-07-20&adults=1')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);

      expect(res.body.message).toContain(
        'I can currently only search economy class for adult passengers',
      );

      // Verify audit log has AGENT_KEYWORD_TRIGGER
      const logs = await prisma.auditLog.findMany({
        where: { userId: user.id, action: 'AGENT_KEYWORD_TRIGGER' },
      });
      expect(logs.length).toBe(1);
      expect(logs[0].metadata).toMatchObject({
        matchedKeywords: ['infant'],
        messageId: expect.any(String),
      });
    });
    it('should throw 400 when neither adults nor passengers query param is provided', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2027-07-15')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(400);

      expect(res.body.message).toContain('At least one of adults or passengers must be provided');
    });

    it('should successfully search using passengers query param instead of adults (backward compatibility)', async () => {
      const res = await request(app.getHttpServer())
        .get(
          '/agent-gateway/flights/search?origin=HAN&destination=NRT&date=2027-07-15&passengers=3',
        )
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.results.length).toBe(5);
      const vietnamAirlines = res.body.results.find(
        (result: { flightNumber: string }) => result.flightNumber === 'VN310',
      );
      expect(vietnamAirlines.price).toBe(452.0 * 3);
    });
  });

  describe('Booking Readiness Endpoint (POST /bookings/readiness)', () => {
    let token: string;
    let user: User;

    beforeEach(async () => {
      user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'readinesstester@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      token = mintClaimToken(user.id, iat);
    });

    it('should reject request missing flightOfferId', async () => {
      const res = await request(app.getHttpServer())
        .post('/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          passengers: [{ passengerType: 'ADULT', passengerOrdinal: 1, sourceType: 'inline' }],
        })
        .expect(400);
      expect(res.body.message).toContain('flightOfferId must be a UUID');
    });

    it('should reject request with passenger missing type', async () => {
      await request(app.getHttpServer())
        .post('/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          flightOfferId: crypto.randomUUID(),
          passengers: [{ passengerOrdinal: 1, sourceType: 'inline' }],
        })
        .expect(400);
    });

    it('should reject request containing PII in passenger', async () => {
      const piiValues = {
        givenName: 'Ada',
        familyName: 'Lovelace',
        dateOfBirth: '1815-12-10',
        email: 'ada@example.test',
        phoneNumber: '5551234567',
        passportNumber: 'P12345678',
        travelerProfileId: crypto.randomUUID(),
      };
      const res = await request(app.getHttpServer())
        .post('/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          flightOfferId: crypto.randomUUID(),
          passengers: [
            {
              passengerType: 'ADULT',
              passengerOrdinal: 1,
              sourceType: 'inline',
              ...piiValues,
            },
          ],
        })
        .expect(400);

      expect(res.body.message).toEqual(
        expect.arrayContaining([expect.stringContaining('should not exist')]),
      );
      const serialized = JSON.stringify(res.body);
      for (const value of Object.values(piiValues)) {
        expect(serialized).not.toContain(value);
      }
    });

    it('should handle missing profile gracefully when using traveler_profile', async () => {
      const newUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: 'noprofile@example.com',
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });
      const newToken = mintClaimToken(newUser.id, Math.floor(Date.now() / 1000));
      const offerId = crypto.randomUUID();
      const res = await request(app.getHttpServer())
        .post('/agent-gateway/bookings/readiness')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', newToken)
        .send({
          flightOfferId: offerId,
          passengers: [
            { passengerType: 'ADULT', passengerOrdinal: 1, sourceType: 'traveler_profile' },
          ],
        })
        .expect(404);

      expect(res.body.code).toBe('PROFILE_NOT_FOUND');
    });
  });

  describe('Attested Flight Search Endpoint (POST /v2/flights/search)', () => {
    let token: string;
    let user: User;

    beforeEach(async () => {
      user = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `attested-search-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const iat = Math.floor(Date.now() / 1000);
      token = mintClaimToken(user.id, iat);
    });

    it('should return 404 for non-existent chatSessionId', async () => {
      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: crypto.randomUUID(),
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(404);
    });

    it('should return 404 for chatSessionId owned by another user', async () => {
      const otherUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `other-user-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      const otherSession = await prisma.chatSession.create({
        data: {
          userId: otherUser.id,
        },
      });

      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: otherSession.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(404);
    });

    it('should return 401 for missing X-Agent-API-Key', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(401);

      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('should return 401 for missing X-User-Claim', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(401);

      expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
    });

    it('should return 403 for inactive user', async () => {
      const inactiveUser = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `inactive-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'INACTIVE',
        },
      });

      const inactiveToken = mintClaimToken(inactiveUser.id, Math.floor(Date.now() / 1000));
      const session = await prisma.chatSession.create({
        data: { userId: inactiveUser.id },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', inactiveToken)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(403);

      expect(res.body.code).toBe('USER_INACTIVE');
    });

    it('should reject invalid airport code format', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'HOCHIMINH', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(400);
    });

    it('should reject past dates', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2020-01-01', adults: 1 },
        })
        .expect(400);
    });

    it('should reject passenger count out of range', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 12 },
        })
        .expect(400);
    });

    it('should reject missing snapshotVersion and proposedVersion', async () => {
      const session = await prisma.chatSession.create({
        data: { userId: user.id },
      });

      await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        })
        .expect(400);
    });

    it('should return signed attestation, snapshotVersion, snapshotExpiresAt, and enriched results', async () => {
      const session = await prisma.chatSession.create({
        data: {
          userId: user.id,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedSnapshotVersion: 1,
          search: { origin: 'SGN', destination: 'NRT', date: '2027-07-20', adults: 1 },
        });

      expect([200, 201]).toContain(res.status);

      expect(res.body.selectionAttestation).toBeDefined();
      expect(res.body.selectionAttestation).toMatch(/^sel_v1_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);
      expect(res.body.snapshotVersion).toBe(1);
      expect(res.body.snapshotExpiresAt).toBeDefined();
      expect(new Date(res.body.snapshotExpiresAt).getTime()).toBeGreaterThan(Date.now());

      const results = res.body.results;
      expect(results.length).toBeGreaterThan(0);

      const firstResult = results.find(
        (result: { flightNumber: string }) => result.flightNumber === 'VN310',
      );
      expect(firstResult.flightOfferId).toBeDefined();
      expect(firstResult.duffelOfferId).toBeDefined();
      expect(firstResult.offerExpiresAt).toBeDefined();
      expect(firstResult.airline).toBe('Vietnam Airlines');
      expect(firstResult.flightNumber).toBe('VN310');
      expect(firstResult.departureAirport).toBe('HAN');
      expect(firstResult.arrivalAirport).toBe('NRT');
      expect(firstResult.departureTime).toBe('2027-07-15T08:30:00');
      expect(firstResult.arrivalTime).toBe('2027-07-15T15:00:00');
      expect(firstResult.duration).toBe(330);
      expect(firstResult.stops).toBe(0);
      expect(firstResult.price).toBe(452.0);
      expect(firstResult.currency).toBe('USD');
      expect(firstResult.fareClass).toBe('Economy');
      expect(firstResult.baggageAllowance).toBe('23kg checked');

      // Every signed selection must be immediately usable by handoff, without polling.
      const persistedOffers = await prisma.flightOffer.findMany({
        where: {
          id: { in: results.map((result: { flightOfferId: string }) => result.flightOfferId) },
        },
      });
      expect(persistedOffers).toHaveLength(results.length);
      for (const result of results) {
        expect(persistedOffers.find((offer) => offer.id === result.flightOfferId)).toMatchObject({
          id: result.flightOfferId,
          supplierOfferId: result.duffelOfferId,
          rawOffer: { id: result.duffelOfferId },
        });
      }
    });

    it('should support aliases proposedVersion, departureDate, and passengers', async () => {
      const session = await prisma.chatSession.create({
        data: {
          userId: user.id,
        },
      });

      const res = await request(app.getHttpServer())
        .post('/agent-gateway/v2/flights/search')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .send({
          chatSessionId: session.id,
          proposedVersion: 3,
          search: {
            origin: 'SGN',
            destination: 'NRT',
            departureDate: '2027-07-20',
            passengers: 2,
            cabinClass: 'economy',
          },
        });

      expect([200, 201]).toContain(res.status);
      expect(res.body.snapshotVersion).toBe(3);
      expect(res.body.selectionAttestation).toMatch(/^sel_v1_[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/);
      expect(res.body.results.length).toBeGreaterThan(0);
      expect(res.body.results[0].flightOfferId).toBeDefined();
      expect(res.body.results[0].duffelOfferId).toBeDefined();
      const vietnamAirlines = res.body.results.find(
        (result: { flightNumber: string }) => result.flightNumber === 'VN310',
      );
      expect(vietnamAirlines.price).toBe(452.0 * 2);
    });

    it('legacy GET /flights/search should remain completely unenriched', async () => {
      const res = await request(app.getHttpServer())
        .get('/agent-gateway/flights/search?origin=SGN&destination=NRT&date=2027-07-20&adults=1')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', token)
        .expect(200);

      expect(res.body.selectionAttestation).toBeUndefined();
      expect(res.body.snapshotVersion).toBeUndefined();
      expect(res.body.snapshotExpiresAt).toBeUndefined();

      const results = res.body.results;
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].flightOfferId).toBeUndefined();
      expect(results[0].duffelOfferId).toBeUndefined();
      expect(results[0].offerExpiresAt).toBeUndefined();

      const vietnamAirlines = results.find(
        (result: { flightNumber: string }) => result.flightNumber === 'VN310',
      );
      expect(vietnamAirlines.airline).toBe('Vietnam Airlines');
      expect(vietnamAirlines.flightNumber).toBe('VN310');
      expect(vietnamAirlines.departureAirport).toBe('HAN');
      expect(vietnamAirlines.arrivalAirport).toBe('NRT');
      expect(vietnamAirlines.price).toBe(452.0);
    });
  });

  describe('Booking Projections Endpoints (GET /users/bookings/summaries and GET /users/bookings/:bookingReference)', () => {
    let userA: User;
    let userB: User;
    let tokenA: string;
    let tokenB: string;
    const refA = 'bkref_11111111-1111-4111-8111-111111111111';
    const refB = 'bkref_22222222-2222-4222-8222-222222222222';

    beforeEach(async () => {
      userA = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `usera-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      userB = await prisma.user.create({
        data: {
          id: crypto.randomUUID(),
          email: `userb-${crypto.randomUUID()}@example.com`,
          password: 'Password123!',
          status: 'ACTIVE',
        },
      });

      tokenA = mintClaimToken(userA.id, Math.floor(Date.now() / 1000));
      tokenB = mintClaimToken(userB.id, Math.floor(Date.now() / 1000));

      const offerA = await prisma.flightOffer.create({
        data: {
          searchHash: 'search_hash_a',
          supplierOfferId: 'off_a',
          rawOffer: {},
          origin: 'HAN',
          destination: 'NRT',
          departureDate: new Date('2027-07-15T00:00:00Z'),
          adults: 1,
          cabinClass: 'economy',
          price: 1250.0,
          currency: 'USD',
        },
      });

      const intentA = await prisma.bookingIntent.create({
        data: {
          userId: userA.id,
          flightOfferId: offerA.id,
          supplierOfferId: 'off_a',
          status: 'CONFIRMED',
          originalPrice: 1250.0,
          confirmedPrice: 1250.0,
          pricedAt: new Date(),
          origin: 'HAN',
          destination: 'NRT',
          departureDate: new Date('2027-07-15T00:00:00Z'),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 100000),
        },
      });

      const bookingA = await prisma.booking.create({
        data: {
          userId: userA.id,
          bookingIntentId: intentA.id,
          pnrReference: 'PNR_SECRET_A',
          status: 'CONFIRMED',
          totalAmount: 1250.0,
          currency: 'USD',
          departureAt: new Date('2027-07-15T08:30:00Z'),
          flightSnapshot: {
            segments: [
              {
                airline: { iataCode: 'VN', name: 'Vietnam Airlines' },
                flightNumber: '310',
                departureAirport: { iataCode: 'HAN' },
                arrivalAirport: { iataCode: 'NRT' },
                departureAt: '2027-07-15T08:30:00.000Z',
                arrivalAt: '2027-07-15T15:00:00.000Z',
              },
            ],
            totalDuration: 'PT5H30M',
            stops: 0,
            fareClass: 'Business',
            baggageAllowance: '32kg checked',
          },
          passengerSnapshot: {
            passengers: [
              {
                id: 'passenger-a',
                type: 'ADULT',
                position: 1,
              },
            ],
          },
        },
      });

      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: bookingA.id,
          agentReference: refA,
          status: 'CONFIRMED',
          airline: 'Vietnam Airlines',
          origin: 'HAN',
          destination: 'NRT',
          departureAt: new Date('2027-07-15T08:30:00.000Z'),
          arrivalAt: new Date('2027-07-15T15:00:00.000Z'),
          durationMinutes: 330,
          stopCount: 0,
          flightNumber: 'VN 310',
          baggageSummary: '32kg checked',
          refundable: false,
          changeable: true,
        },
      });

      const offerB = await prisma.flightOffer.create({
        data: {
          searchHash: 'search_hash_b',
          supplierOfferId: 'off_b',
          rawOffer: {},
          origin: 'SGN',
          destination: 'SIN',
          departureDate: new Date('2027-08-01T00:00:00Z'),
          adults: 1,
          cabinClass: 'economy',
          price: 500.0,
          currency: 'USD',
        },
      });

      const intentB = await prisma.bookingIntent.create({
        data: {
          userId: userB.id,
          flightOfferId: offerB.id,
          supplierOfferId: 'off_b',
          status: 'CONFIRMED',
          originalPrice: 500.0,
          confirmedPrice: 500.0,
          pricedAt: new Date(),
          origin: 'SGN',
          destination: 'SIN',
          departureDate: new Date('2027-08-01T00:00:00Z'),
          adults: 1,
          rawOfferSnapshot: {},
          intentExpiresAt: new Date(Date.now() + 100000),
        },
      });

      const bookingB = await prisma.booking.create({
        data: {
          userId: userB.id,
          bookingIntentId: intentB.id,
          pnrReference: 'PNR_SECRET_B',
          status: 'CONFIRMED',
          totalAmount: 500.0,
          currency: 'USD',
          departureAt: new Date('2027-08-01T10:00:00Z'),
          flightSnapshot: {},
          passengerSnapshot: {},
        },
      });

      await prisma.bookingAgentProjection.create({
        data: {
          bookingId: bookingB.id,
          agentReference: refB,
          status: 'CONFIRMED',
          airline: 'Singapore Airlines',
          origin: 'SGN',
          destination: 'SIN',
          departureAt: new Date('2027-08-01T10:00:00.000Z'),
          arrivalAt: new Date('2027-08-01T13:00:00.000Z'),
          durationMinutes: 180,
          stopCount: 0,
          flightNumber: 'SQ 176',
          baggageSummary: '30kg checked',
          refundable: true,
          changeable: true,
        },
      });
    });

    describe('GET /agent-gateway/users/bookings/summaries', () => {
      it('User A receives User A projection summary, does NOT see User B bookings', async () => {
        const res = await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/summaries')
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenA)
          .expect(200);

        expect(res.body.bookings).toHaveLength(1);
        const booking = res.body.bookings[0];
        expect(booking.bookingReference).toBe(refA);
        expect(booking.airline).toBe('Vietnam Airlines');
        expect(booking.origin).toBe('HAN');
        expect(booking.destination).toBe('NRT');
        expect(booking.departureTime).toBe('2027-07-15T08:30:00.000Z');
        expect(booking.arrivalTime).toBe('2027-07-15T15:00:00.000Z');
        expect(booking.status).toBe('CONFIRMED');
        expect(booking.durationMinutes).toBe(330);
        expect(booking.stops).toBe(0);

        // Forbidden fields check
        expect(booking.id).toBeUndefined();
        expect(booking.bookingId).toBeUndefined();
        expect(booking.flightSnapshot).toBeUndefined();
        expect(booking.passengerSnapshot).toBeUndefined();
        expect(booking.pnrReference).toBeUndefined();
        expect(booking.totalAmount).toBeUndefined();
        expect(booking.Payment).toBeUndefined();
        expect(booking.payment).toBeUndefined();
      });

      it('returns empty array for user without bookings', async () => {
        const userC = await prisma.user.create({
          data: {
            id: crypto.randomUUID(),
            email: `userc-${crypto.randomUUID()}@example.com`,
            password: 'Password123!',
            status: 'ACTIVE',
          },
        });
        const tokenC = mintClaimToken(userC.id, Math.floor(Date.now() / 1000));

        const res = await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/summaries')
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenC)
          .expect(200);

        expect(res.body).toEqual({ bookings: [] });
      });

      it('fails with 401 when API key is missing', async () => {
        await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/summaries')
          .set('X-User-Claim', tokenA)
          .expect(401);
      });

      it('fails with 401 when Claim Token is missing', async () => {
        await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/summaries')
          .set('X-Agent-API-Key', apiKey)
          .expect(401);
      });
    });

    describe('GET /agent-gateway/users/bookings/:bookingReference', () => {
      it('User A requesting User A reference -> 200 with exact detail fields', async () => {
        const res = await request(app.getHttpServer())
          .get(`/agent-gateway/users/bookings/${refA}`)
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenA)
          .expect(200);

        expect(res.body).toEqual({
          bookingReference: refA,
          airline: 'Vietnam Airlines',
          origin: 'HAN',
          destination: 'NRT',
          departureTime: '2027-07-15T08:30:00.000Z',
          arrivalTime: '2027-07-15T15:00:00.000Z',
          status: 'CONFIRMED',
          durationMinutes: 330,
          stops: 0,
          flightNumber: 'VN 310',
          baggageAllowance: '32kg checked',
          refundable: false,
          changeable: true,
        });

        // Forbidden fields check
        expect(res.body.id).toBeUndefined();
        expect(res.body.bookingId).toBeUndefined();
        expect(res.body.flightSnapshot).toBeUndefined();
        expect(res.body.passengerSnapshot).toBeUndefined();
        expect(res.body.pnrReference).toBeUndefined();
        expect(res.body.totalAmount).toBeUndefined();
        expect(res.body.Payment).toBeUndefined();
        expect(res.body.payment).toBeUndefined();
      });

      it('User B requesting User A reference -> 404 BOOKING_REFERENCE_NOT_FOUND', async () => {
        const res = await request(app.getHttpServer())
          .get(`/agent-gateway/users/bookings/${refA}`)
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenB)
          .expect(404);

        expect(res.body.code).toBe('BOOKING_REFERENCE_NOT_FOUND');
      });

      it('Non-existent reference -> 404 BOOKING_REFERENCE_NOT_FOUND', async () => {
        const res = await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/bkref_99999999-9999-4999-8999-999999999999')
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenA)
          .expect(404);

        expect(res.body.code).toBe('BOOKING_REFERENCE_NOT_FOUND');
      });

      it('Malformed reference -> 404 BOOKING_REFERENCE_NOT_FOUND', async () => {
        const res = await request(app.getHttpServer())
          .get('/agent-gateway/users/bookings/invalid-ref-123')
          .set('X-Agent-API-Key', apiKey)
          .set('X-User-Claim', tokenA)
          .expect(404);

        expect(res.body.code).toBe('BOOKING_REFERENCE_NOT_FOUND');
      });

      it('Missing/invalid API key -> 401', async () => {
        const res = await request(app.getHttpServer())
          .get(`/agent-gateway/users/bookings/${refA}`)
          .set('X-User-Claim', tokenA)
          .expect(401);

        expect(res.body.code).toBe('INVALID_API_KEY');
      });

      it('Missing/invalid claim token -> 401', async () => {
        const res = await request(app.getHttpServer())
          .get(`/agent-gateway/users/bookings/${refA}`)
          .set('X-Agent-API-Key', apiKey)
          .expect(401);

        expect(res.body.code).toBe('INVALID_CLAIM_TOKEN');
      });
    });
  });
});
