import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as crypto from 'crypto';
import { AppModule, envSchema } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { AirportType, ChatSession, FlightOffer, Prisma, User } from '@prisma/client';

jest.setTimeout(120_000);

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

describe('Feature Flag Governance & Rollout Matrix (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attestationService: SelectionAttestationService;
  let tokenService: ChatHandoffTokenService;
  let jwtService: JwtService;

  let validUser: User;
  let validUserToken: string;
  let validSession: ChatSession;
  let validFlightOffer: FlightOffer;

  const apiKey = 'test-agent-api-key';
  const configOverrides: Record<string, string> = {
    FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'false',
    FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
  };

  beforeAll(async () => {
    process.env.AGENT_SERVICE_API_KEY = apiKey;
    process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
    process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
    process.env.ATTESTATION_SECRET = 'test-attestation-secret';
    process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';
    process.env.CHAT_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_mock';
    process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_mock';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown) => {
          if (key in configOverrides) return configOverrides[key];
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'false';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'false';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          if (key === 'AGENT_SERVICE_API_KEY') return apiKey;
          if (key === 'CLAIM_TOKEN_SECRET') return 'test-claim-token-secret';
          if (key === 'CLAIM_TOKEN_TTL_SECONDS') return '300';
          if (key === 'ATTESTATION_SECRET') return 'test-attestation-secret';
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    attestationService = moduleFixture.get<SelectionAttestationService>(
      SelectionAttestationService,
    );
    tokenService = moduleFixture.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Reset config overrides
    for (const key of Object.keys(configOverrides)) {
      delete configOverrides[key];
    }

    // Clean up relevant DB tables
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
    await prisma.booking.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.user.deleteMany({});

    validUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `matrix-user-${crypto.randomUUID()}@example.com`,
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });

    validUserToken = jwtService.sign(
      { sub: validUser.id, id: validUser.id, jti: crypto.randomUUID(), email: validUser.email },
      { issuer: 'booking-systems-api', audience: 'booking-systems-clients' },
    );

    validSession = await prisma.chatSession.create({
      data: {
        userId: validUser.id,
      },
    });

    validFlightOffer = await prisma.flightOffer.create({
      data: {
        searchHash: `search-${crypto.randomUUID()}`,
        supplierOfferId: `off_${crypto.randomUUID()}`,
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date(Date.now() + 86_400_000),
        adults: 1,
        children: 0,
        infants: 0,
        cabinClass: 'economy',
        price: new Prisma.Decimal(150.0),
        currency: 'USD',
        rawOffer: {
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: 'pas_matrix_1', type: 'adult' }],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  departing_at: new Date(Date.now() + 86_400_000).toISOString(),
                  arriving_at: new Date(Date.now() + 90_000_000).toISOString(),
                  operating_carrier: { name: 'Vietnam Airlines' },
                },
              ],
            },
          ],
        },
      },
    });

    for (const airport of [
      {
        iataCode: 'SGN',
        name: 'Tan Son Nhat',
        city: 'Ho Chi Minh City',
        latitude: 10.8231,
        longitude: 106.6297,
      },
      { iataCode: 'HAN', name: 'Noi Bai', city: 'Hanoi', latitude: 21.2212, longitude: 105.8072 },
    ]) {
      await prisma.airport.upsert({
        where: { iataCode: airport.iataCode },
        update: {},
        create: { ...airport, country: 'VN', type: AirportType.LARGE_AIRPORT },
      });
    }
  });

  // Helper to generate a valid signed attestation
  async function generateAttestation(): Promise<string> {
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const offers = [
      {
        flightOfferId: validFlightOffer.id,
        duffelOfferId: validFlightOffer.supplierOfferId,
      },
    ];
    return await attestationService.signSelectionAttestation(
      validUser.id,
      validSession.id,
      1,
      expiresAt,
      offers,
    );
  }

  // =========================================================================
  // Combination 1: ISSUE=false, ACCEPT=false
  // =========================================================================
  describe('Combination 1: ISSUE=false, ACCEPT=false', () => {
    beforeEach(() => {
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ISSUE'] = 'false';
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ACCEPT'] = 'false';
    });

    it('Token create returns 503 Service Unavailable ("Chat handoff issuance is disabled") with zero internal leakage', async () => {
      const attestation = await generateAttestation();
      const claimToken = mintClaimToken(validUser.id, Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(503);

      expect(res.body.message).toBe('Chat handoff issuance is disabled');
      expect(res.body.error).toBe('Service Unavailable');
      expect(res.body.statusCode).toBe(503);

      // Verify zero stack trace or internal error leakage
      expect(res.body.stack).toBeUndefined();
      expect(res.body.trace).toBeUndefined();
      expect(res.body.sql).toBeUndefined();
      expect(res.body.driverError).toBeUndefined();
      expect(res.body.internal).toBeUndefined();
    });

    it('Token resolve returns 503 Service Unavailable ("Chat handoff acceptance is disabled") with zero internal leakage', async () => {
      const rawToken = await tokenService.generateToken(
        crypto.randomUUID(),
        'test-idempotency-hash',
        1,
      );

      const res = await request(app.getHttpServer())
        .get('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .query({ token: rawToken.token })
        .expect(503);

      expect(res.body.message).toBe('Chat handoff acceptance is disabled');
      expect(res.body.error).toBe('Service Unavailable');
      expect(res.body.statusCode).toBe(503);

      // Verify zero stack trace or internal error leakage
      expect(res.body.stack).toBeUndefined();
      expect(res.body.trace).toBeUndefined();
      expect(res.body.sql).toBeUndefined();
      expect(res.body.driverError).toBeUndefined();
      expect(res.body.internal).toBeUndefined();
    });
  });

  // =========================================================================
  // Combination 2: ISSUE=false, ACCEPT=true
  // =========================================================================
  describe('Combination 2: ISSUE=false, ACCEPT=true', () => {
    beforeEach(() => {
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ISSUE'] = 'false';
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ACCEPT'] = 'true';
    });

    it('Token create returns 503 Service Unavailable ("Chat handoff issuance is disabled")', async () => {
      const attestation = await generateAttestation();
      const claimToken = mintClaimToken(validUser.id, Math.floor(Date.now() / 1000));

      const res = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(503);

      expect(res.body.message).toBe('Chat handoff issuance is disabled');
    });

    it('Resolves an existing unexpired token successfully (status: 200 with safe allowlisted checkout context)', async () => {
      const attestation = await generateAttestation();
      const rowId = crypto.randomUUID();
      const idempotencyHash = tokenService.deriveIdempotencyHash(attestation, 1, 1);
      const rawToken = await tokenService.generateToken(rowId, idempotencyHash, 1);
      const supplierOfferIdHash = crypto
        .createHash('sha256')
        .update(validFlightOffer.supplierOfferId)
        .digest('hex');

      await prisma.chatHandoff.create({
        data: {
          id: rowId,
          tokenHash: rawToken.tokenHash,
          tokenKeyVersion: 1,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'mock-fingerprint',
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
          idempotencyKeyHash: idempotencyHash,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });

      const res = await request(app.getHttpServer())
        .get('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .query({ token: rawToken.token })
        .expect(200);

      expect(res.body.status).toBe('ACTIVE');
      expect(res.body.expiresAt).toBeDefined();
      expect(res.body.offer).toBeDefined();
      expect(res.body.offer.origin).toBe('SGN');
      expect(res.body.offer.destination).toBe('HAN');
      expect(res.body.offer.price).toBe('150');
      expect(res.body.offer.currency).toBe('USD');
      expect(res.body.offer.adults).toBe(1);

      // Verify no sensitive tokens or DB internals in resolve response
      expect(res.body.tokenHash).toBeUndefined();
      expect(res.body.supplierOfferIdHash).toBeUndefined();
      expect(res.body.rawOffer).toBeUndefined();
    });
  });

  // =========================================================================
  // Combination 3: ISSUE=true, ACCEPT=false
  // =========================================================================
  describe('Combination 3: ISSUE=true, ACCEPT=false', () => {
    it('Invalid configuration: Rejected at startup by envSchema with clear error message', () => {
      const invalidConfig = {
        STRIPE_SECRET_KEY: 'sk_test_123',
        STRIPE_WEBHOOK_SECRET: 'whsec_123',
        FEATURE_FLAG_CHAT_HANDOFF_ISSUE: 'true',
        FEATURE_FLAG_CHAT_HANDOFF_ACCEPT: 'false',
      };

      const result = envSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
      if (!result.success) {
        const errorMessages = result.error.errors.map((e) => e.message);
        expect(errorMessages).toContain('Invalid config: ISSUE=true but ACCEPT=false');
      }

      expect(() => envSchema.parse(invalidConfig)).toThrow(
        'Invalid config: ISSUE=true but ACCEPT=false',
      );
    });
  });

  // =========================================================================
  // Combination 4: ISSUE=true, ACCEPT=true
  // =========================================================================
  describe('Combination 4: ISSUE=true, ACCEPT=true', () => {
    beforeEach(() => {
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ISSUE'] = 'true';
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ACCEPT'] = 'true';
    });

    it('Token create succeeds (201) and Token resolve succeeds (200 with safe allowlisted checkout context)', async () => {
      const attestation = await generateAttestation();
      const claimToken = mintClaimToken(validUser.id, Math.floor(Date.now() / 1000));

      // 1. Create token
      const createRes = await request(app.getHttpServer())
        .post('/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(201);

      expect(createRes.body.handoffToken).toBeDefined();
      expect(createRes.body.handoffToken).toMatch(/^chk_handoff_v[12]_/);
      expect(createRes.body.token).toBeDefined();
      expect(createRes.body.expiresAt).toBeDefined();

      const issuedToken = createRes.body.handoffToken;

      // 2. Resolve token
      const resolveRes = await request(app.getHttpServer())
        .get('/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .query({ token: issuedToken })
        .expect(200);

      expect(resolveRes.body.status).toBe('ACTIVE');
      expect(resolveRes.body.expiresAt).toBeDefined();
      expect(resolveRes.body.offer).toBeDefined();
      expect(resolveRes.body.offer.origin).toBe('SGN');
      expect(resolveRes.body.offer.destination).toBe('HAN');
      expect(resolveRes.body.offer.price).toBe('150');
      expect(resolveRes.body.offer.currency).toBe('USD');
      expect(resolveRes.body.offer.adults).toBe(1);

      // Verify no sensitive tokens or internal hashes in resolve response
      expect(resolveRes.body.tokenHash).toBeUndefined();
      expect(resolveRes.body.supplierOfferIdHash).toBeUndefined();
      expect(resolveRes.body.rawOffer).toBeUndefined();
    });
  });
});
