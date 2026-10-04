import * as crypto from 'crypto';

const encryptionKey = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');
const chatEncryptionKey = process.env.CHAT_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

process.env.ENCRYPTION_KEY = encryptionKey;
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'false';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_MULTI_AGENT = 'true';
process.env.AGENT_SERVICE_API_KEY = 'test-agent-api-key';
process.env.ATTESTATION_SECRET = 'test-attestation-secret';
process.env.CLAIM_TOKEN_SECRET = 'test-claim-token-secret';
process.env.CLAIM_TOKEN_TTL_SECONDS = '300';
process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';
process.env.CHAT_ENCRYPTION_KEY = chatEncryptionKey;
process.env.STRIPE_SECRET_KEY = 'sk_test_mock';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_mock';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SelectionAttestationService } from '@/agent-gateway/selection-attestation.service';
import { ChatHandoffTokenService } from '@/chat-handoff/chat-handoff-token.service';
import { ChatMessageCryptoService } from '@/common/chat-message-crypto.service';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { JwtService } from '@nestjs/jwt';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import {
  AirportType,
  BookingStatus,
  ChatSession,
  FlightOffer,
  MessageSender,
  MessageType,
  PassengerType,
  Prisma,
  User,
} from '@prisma/client';

jest.setTimeout(120_000);

function mintClaimToken(userId: string, iat: number, secret = 'test-claim-token-secret'): string {
  const payload = { userId, iat };
  const payloadStr = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(payloadStr).digest();
  return `${Buffer.from(payloadStr).toString('base64url')}.${signature.toString('base64url')}`;
}

async function cleanDatabase(prisma: PrismaService): Promise<void> {
  await prisma.chatHandoff.deleteMany({});
  await prisma.chatMessage.deleteMany({});
  await prisma.chatSession.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.ledgerEntry.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.cancellationRefundObligation.deleteMany({});
  await prisma.payment.deleteMany({});
  await prisma.idempotencyKey.deleteMany({});
  await prisma.paymentMethod.deleteMany({});
  await prisma.bookingAgentProjection.deleteMany({});
  await prisma.bookingIntentPassenger.deleteMany({});
  await prisma.booking.deleteMany({});
  await prisma.bookingIntent.deleteMany({});
  await prisma.itineraryRevisionSegment.deleteMany({});
  await prisma.itineraryRevision.deleteMany({});
  await prisma.disruptionAuditEvent.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.travelerProfile.deleteMany({});
  await prisma.offerRecovery.deleteMany({});
  await prisma.flightOffer.deleteMany({});
  await prisma.searchHistory.deleteMany({});
  await prisma.airport.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.user.deleteMany({});
}

describe('Rollback Matrix & Database Row Integrity (E2E)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let attestationService: SelectionAttestationService;
  let tokenService: ChatHandoffTokenService;
  let cryptoService: ChatMessageCryptoService;
  let duffel: Duffel;
  let jwtService: JwtService;

  let validUser: User;
  let validUserToken: string;
  let validSession: ChatSession;
  let validFlightOffer: FlightOffer;

  const apiKey = 'test-agent-api-key';
  const configOverrides: Record<string, string> = {};

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        get: (key: string, defaultValue?: unknown): unknown => {
          if (key in configOverrides) return configOverrides[key];
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ISSUE') return 'false';
          if (key === 'FEATURE_FLAG_CHAT_HANDOFF_ACCEPT') return 'true';
          if (key === 'FEATURE_FLAG_BOOKING_READINESS') return 'true';
          if (key === 'FEATURE_FLAG_CHAT_MULTI_AGENT') return 'true';
          if (key === 'CHAT_HANDOFF_SECRET') return 'test-handoff-secret';
          if (key === 'AGENT_SERVICE_API_KEY') return apiKey;
          if (key === 'CLAIM_TOKEN_SECRET') return 'test-claim-token-secret';
          if (key === 'CLAIM_TOKEN_TTL_SECONDS') return '300';
          if (key === 'ATTESTATION_SECRET') return 'test-attestation-secret';
          if (key === 'CHAT_ENCRYPTION_KEY') return chatEncryptionKey;
          if (key === 'ENCRYPTION_KEY') return encryptionKey;
          return process.env[key] ?? defaultValue;
        },
      })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    attestationService = moduleFixture.get<SelectionAttestationService>(
      SelectionAttestationService,
    );
    tokenService = moduleFixture.get<ChatHandoffTokenService>(ChatHandoffTokenService);
    cryptoService = moduleFixture.get<ChatMessageCryptoService>(ChatMessageCryptoService);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    if (prisma) {
      await cleanDatabase(prisma);
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    for (const key of Object.keys(configOverrides)) {
      delete configOverrides[key];
    }
    await cleanDatabase(prisma);

    const runMarker = `rollback-${crypto.randomUUID()}`;

    validUser = await prisma.user.create({
      data: {
        id: crypto.randomUUID(),
        email: `${runMarker}@example.com`,
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
        searchHash: `search-${runMarker}`,
        supplierOfferId: `off_${runMarker}`,
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
          passengers: [{ id: `pas_${runMarker}`, type: 'adult' }],
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
  // Step 1 Rollback Verification:
  // FEATURE_FLAG_CHAT_HANDOFF_ISSUE=false, FEATURE_FLAG_CHAT_HANDOFF_ACCEPT=true
  // =========================================================================
  describe('Step 1 Rollback: ISSUE=false, ACCEPT=true', () => {
    let preIssuedRawToken: string;
    let preIssuedRowId: string;
    let attestation: string;

    beforeEach(async () => {
      // Step 1 Rollback state: ISSUE=false, ACCEPT=true
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ISSUE'] = 'false';
      configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ACCEPT'] = 'true';

      // Seed a pre-issued unexpired token into DB directly to model pre-existing in-flight tokens
      attestation = await generateAttestation();
      preIssuedRowId = crypto.randomUUID();
      const idempotencyHash = tokenService.deriveIdempotencyHash(attestation, 1, 1);
      const rawTokenObj = await tokenService.generateToken(preIssuedRowId, idempotencyHash, 1);
      preIssuedRawToken = rawTokenObj.token;

      const duffelOfferIdHash = crypto
        .createHash('sha256')
        .update(validFlightOffer.supplierOfferId)
        .digest('hex');

      await prisma.chatHandoff.create({
        data: {
          id: preIssuedRowId,
          tokenHash: rawTokenObj.tokenHash,
          tokenKeyVersion: 1,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'mock-fingerprint-preissued',
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
          idempotencyKeyHash: idempotencyHash,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
    });

    it('POST /api/chat-handoff and /api/chat-handoff/tokens return 503 ("Chat handoff issuance is disabled")', async () => {
      const claimToken = mintClaimToken(validUser.id, Math.floor(Date.now() / 1000));

      const res1 = await request(app.getHttpServer())
        .post('/api/chat-handoff')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(503);

      expect(res1.body.message).toBe('Chat handoff issuance is disabled');

      const res2 = await request(app.getHttpServer())
        .post('/api/chat-handoff/tokens')
        .set('X-Agent-API-Key', apiKey)
        .set('X-User-Claim', claimToken)
        .send({
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
        })
        .expect(503);

      expect(res2.body.message).toBe('Chat handoff issuance is disabled');
    });

    it('Pre-issued unexpired token resolves successfully (200 OK) via GET & POST /api/chat-handoff/resolve with safe allowlisted checkout context', async () => {
      // 1. GET /api/chat-handoff/resolve
      const getRes = await request(app.getHttpServer())
        .get('/api/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .query({ token: preIssuedRawToken })
        .expect(200);

      expect(getRes.headers['cache-control']).toBe('no-store, private');
      expect(getRes.body.status).toBe('ACTIVE');
      expect(getRes.body.expiresAt).toBeDefined();
      expect(getRes.body.offer).toBeDefined();
      expect(getRes.body.offer.origin).toBe('SGN');
      expect(getRes.body.offer.destination).toBe('HAN');
      expect(getRes.body.offer.airline).toBe('Vietnam Airlines');
      expect(getRes.body.offer.price).toBe('150');
      expect(getRes.body.offer.currency).toBe('USD');

      // Assert ABSENCE of internal DB IDs and hashes
      expect(getRes.body.userId).toBeUndefined();
      expect(getRes.body.chatSessionId).toBeUndefined();
      expect(getRes.body.flightOfferId).toBeUndefined();
      expect(getRes.body.tokenHash).toBeUndefined();
      expect(getRes.body.id).toBeUndefined();

      // 2. POST /api/chat-handoff/resolve
      const postRes = await request(app.getHttpServer())
        .post('/api/chat-handoff/resolve')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({ handoffToken: preIssuedRawToken })
        .expect(200);

      expect(postRes.headers['cache-control']).toBe('no-store, private');
      expect(postRes.body.status).toBe('ACTIVE');
      expect(postRes.body.offer.origin).toBe('SGN');
      expect(postRes.body.userId).toBeUndefined();
    });

    it('Pre-issued token can be claimed and consumed via POST /api/bookings/intents, creating canonical BookingIntent and setting consumedAt', async () => {
      const rawOfferRecord = (validFlightOffer.rawOffer as Record<string, unknown>) || {};
      const rawPassengers = Array.isArray(rawOfferRecord.passengers)
        ? (rawOfferRecord.passengers as Array<{ id: string }>)
        : [];
      const passengerId = rawPassengers[0]?.id || 'pas_matrix_1';
      // Mock live Duffel offer re-pricing to succeed
      const duffelGetSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: validFlightOffer.supplierOfferId,
          total_amount: '150.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 900_000).toISOString(),
          passengers: [{ id: passengerId, type: 'adult' }],
        },
      } as never);

      const intentRes = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${validUserToken}`)
        .send({
          handoffToken: preIssuedRawToken,
          passengers: [
            {
              offerPassengerId: passengerId,
              type: PassengerType.ADULT,
              source: {
                type: 'inline',
                givenName: 'Minh Tai',
                familyName: 'Pham',
                dateOfBirth: '1995-05-15',
                gender: 'male',
                nationality: 'VN',
                email: 'taipm@example.test',
                phoneCountryCode: '+84',
                phoneNumber: '912345678',
                title: 'Mr',
              },
            },
          ],
        })
        .expect(201);

      expect(duffelGetSpy).toHaveBeenCalledTimes(1);
      duffelGetSpy.mockRestore();

      const createdIntentId = intentRes.body.intentId || intentRes.body.id;
      expect(createdIntentId).toBeDefined();
      expect(intentRes.body.status).toBe('PENDING');

      // Verify ChatHandoff row updated with consumedAt and consumedByBookingIntentId
      const consumedHandoff = await prisma.chatHandoff.findUnique({
        where: { id: preIssuedRowId },
      });
      expect(consumedHandoff).toBeDefined();
      expect(consumedHandoff!.consumedAt).not.toBeNull();
      expect(consumedHandoff!.consumedByBookingIntentId).toBe(createdIntentId);
    });
  });

  // =========================================================================
  // Database Row Integrity Verification across Flag Toggling:
  // Verify that toggling flags (ISSUE, ACCEPT, MULTI_AGENT) never drops,
  // deletes, or corrupts ChatHandoff, BookingAgentProjection, or encrypted ChatMessage rows.
  // =========================================================================
  describe('Database Row Integrity across Feature Flag Transitions', () => {
    it('Preserves ChatHandoff, BookingAgentProjection, and encrypted ChatMessage rows without data corruption', async () => {
      // 1. Seed Encrypted ChatSession and ChatMessage
      const sessionPlainTitle = 'Trip to Tokyo July 2026';
      const titleEnc = await cryptoService.encryptSessionTitle(validSession.id, sessionPlainTitle);
      await prisma.chatSession.update({
        where: { id: validSession.id },
        data: {
          titleCiphertext: titleEnc.ciphertext,
          titleNonce: titleEnc.nonce,
          titleAuthTag: titleEnc.authTag,
          titleKeyVersion: titleEnc.keyVersion,
        },
      });

      const messageId1 = crypto.randomUUID();
      const messageId2 = crypto.randomUUID();
      const userPlainContent = 'Find me flights from Hanoi to Tokyo';
      const agentPlainContent =
        'I found Vietnam Airlines flight VN310 departing at 08:30 for $452 USD.';

      const userMsgEnc = await cryptoService.encryptMessageContent(
        messageId1,
        validSession.id,
        'USER',
        'STANDARD',
        userPlainContent,
      );
      const agentMsgEnc = await cryptoService.encryptMessageContent(
        messageId2,
        validSession.id,
        'AGENT',
        'STANDARD',
        agentPlainContent,
      );

      await prisma.chatMessage.createMany({
        data: [
          {
            id: messageId1,
            sessionId: validSession.id,
            sender: MessageSender.USER,
            type: MessageType.STANDARD,
            contentCiphertext: userMsgEnc.ciphertext,
            contentNonce: userMsgEnc.nonce,
            contentAuthTag: userMsgEnc.authTag,
            contentKeyVersion: userMsgEnc.keyVersion,
          },
          {
            id: messageId2,
            sessionId: validSession.id,
            sender: MessageSender.AGENT,
            type: MessageType.STANDARD,
            contentCiphertext: agentMsgEnc.ciphertext,
            contentNonce: agentMsgEnc.nonce,
            contentAuthTag: agentMsgEnc.authTag,
            contentKeyVersion: agentMsgEnc.keyVersion,
          },
        ],
      });

      // 2. Seed ChatHandoff row
      const attestation = await generateAttestation();
      const handoffRowId = crypto.randomUUID();
      const idempotencyHash = tokenService.deriveIdempotencyHash(attestation, 1, 1);
      const rawTokenObj = await tokenService.generateToken(handoffRowId, idempotencyHash, 1);
      const duffelOfferIdHash = crypto
        .createHash('sha256')
        .update(validFlightOffer.supplierOfferId)
        .digest('hex');

      await prisma.chatHandoff.create({
        data: {
          id: handoffRowId,
          tokenHash: rawTokenObj.tokenHash,
          tokenKeyVersion: 1,
          userId: validUser.id,
          chatSessionId: validSession.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferIdHash: duffelOfferIdHash,
          snapshotVersion: 1,
          snapshotFingerprint: 'mock-fp-integrity-1',
          selectionAttestationHash: attestation,
          selectedOfferIndex: 1,
          idempotencyKeyHash: idempotencyHash,
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });

      // 3. Seed Booking & BookingAgentProjection
      const bookingIntent = await prisma.bookingIntent.create({
        data: {
          userId: validUser.id,
          flightOfferId: validFlightOffer.id,
          supplierOfferId: validFlightOffer.supplierOfferId,
          originalPrice: new Prisma.Decimal(150),
          confirmedPrice: new Prisma.Decimal(150),
          currency: 'USD',
          pricedAt: new Date(),
          origin: 'SGN',
          destination: 'HAN',
          departureDate: new Date(Date.now() + 86_400_000),
          adults: 1,
          rawOfferSnapshot: validFlightOffer.rawOffer as Prisma.InputJsonValue,
          intentExpiresAt: new Date(Date.now() + 900_000),
        },
      });

      const bookingId = crypto.randomUUID();
      await prisma.booking.create({
        data: {
          id: bookingId,
          userId: validUser.id,
          bookingIntentId: bookingIntent.id,
          status: BookingStatus.CONFIRMED,
          totalAmount: new Prisma.Decimal(150),
          currency: 'USD',
          departureAt: new Date(Date.now() + 86_400_000),
        },
      });

      const agentRef = `bkref_${crypto.randomBytes(8).toString('hex')}`;
      await prisma.bookingAgentProjection.create({
        data: {
          bookingId,
          agentReference: agentRef,
          status: 'CONFIRMED',
          airline: 'Vietnam Airlines',
          origin: 'SGN',
          destination: 'HAN',
          departureAt: new Date(Date.now() + 86_400_000),
          arrivalAt: new Date(Date.now() + 90_000_000),
          durationMinutes: 120,
          stopCount: 0,
          flightNumber: 'VN123',
          baggageSummary: '23kg checked',
          refundable: true,
          changeable: false,
        },
      });

      // 4. Perform Multi-Cycle Flag Transitions
      const flagCycles = [
        { ISSUE: 'false', ACCEPT: 'true', MULTI_AGENT: 'false' },
        { ISSUE: 'false', ACCEPT: 'false', MULTI_AGENT: 'false' },
        { ISSUE: 'true', ACCEPT: 'true', MULTI_AGENT: 'false' },
        { ISSUE: 'false', ACCEPT: 'true', MULTI_AGENT: 'true' },
        { ISSUE: 'true', ACCEPT: 'true', MULTI_AGENT: 'true' },
      ];

      for (const cycle of flagCycles) {
        configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ISSUE'] = cycle.ISSUE;
        configOverrides['FEATURE_FLAG_CHAT_HANDOFF_ACCEPT'] = cycle.ACCEPT;
        configOverrides['FEATURE_FLAG_CHAT_MULTI_AGENT'] = cycle.MULTI_AGENT;

        // Perform representative read operations during each state
        if (cycle.ACCEPT === 'true') {
          await request(app.getHttpServer())
            .get('/api/chat-handoff/resolve')
            .set('Authorization', `Bearer ${validUserToken}`)
            .query({ token: rawTokenObj.token })
            .expect(200);
        } else {
          await request(app.getHttpServer())
            .get('/api/chat-handoff/resolve')
            .set('Authorization', `Bearer ${validUserToken}`)
            .query({ token: rawTokenObj.token })
            .expect(503);
        }
      }

      // 5. Database Row Integrity Assertions after all flag transitions
      // Verify ChatHandoff row
      const handoffAfter = await prisma.chatHandoff.findUnique({
        where: { id: handoffRowId },
      });
      expect(handoffAfter).not.toBeNull();
      expect(handoffAfter!.tokenHash).toBe(rawTokenObj.tokenHash);
      expect(handoffAfter!.selectionAttestationHash).toBe(attestation);
      expect(handoffAfter!.userId).toBe(validUser.id);
      expect(handoffAfter!.flightOfferId).toBe(validFlightOffer.id);
      expect(handoffAfter!.snapshotFingerprint).toBe('mock-fp-integrity-1');

      // Verify BookingAgentProjection row
      const projectionAfter = await prisma.bookingAgentProjection.findUnique({
        where: { bookingId },
      });
      expect(projectionAfter).not.toBeNull();
      expect(projectionAfter!.agentReference).toBe(agentRef);
      expect(projectionAfter!.airline).toBe('Vietnam Airlines');
      expect(projectionAfter!.origin).toBe('SGN');
      expect(projectionAfter!.destination).toBe('HAN');
      expect(projectionAfter!.flightNumber).toBe('VN123');
      expect(projectionAfter!.refundable).toBe(true);

      // Verify ChatSession title decryption integrity
      const sessionAfter = await prisma.chatSession.findUnique({
        where: { id: validSession.id },
      });
      expect(sessionAfter).not.toBeNull();
      const decryptedTitle = await cryptoService.decryptSessionTitle(sessionAfter!);
      expect(decryptedTitle).toBe(sessionPlainTitle);

      // Verify Encrypted ChatMessage rows & decryption integrity
      const messagesAfter = await prisma.chatMessage.findMany({
        where: { sessionId: validSession.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(messagesAfter).toHaveLength(2);

      const decryptedUserMsg = await cryptoService.decryptMessageContent(messagesAfter[0]);
      expect(decryptedUserMsg).toBe(userPlainContent);

      const decryptedAgentMsg = await cryptoService.decryptMessageContent(messagesAfter[1]);
      expect(decryptedAgentMsg).toBe(agentPlainContent);

      // Total count checks confirm zero row drops
      const handoffCount = await prisma.chatHandoff.count({ where: { userId: validUser.id } });
      const projectionCount = await prisma.bookingAgentProjection.count({ where: { bookingId } });
      const messageCount = await prisma.chatMessage.count({
        where: { sessionId: validSession.id },
      });

      expect(handoffCount).toBe(1);
      expect(projectionCount).toBe(1);
      expect(messageCount).toBe(2);
    });
  });
});
