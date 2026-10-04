process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ISSUE = 'true';
process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { PassengerType, Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';

describe('Chat Handoff Concurrency (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let duffel: Duffel;

  let userA: { id: string; email: string };
  let tokenA: string;

  beforeAll(async () => {
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
    await app.listen(0, '127.0.0.1');

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean tables in dependent order
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

    // Create test user
    const uA = await prisma.user.create({
      data: {
        email: 'usera-concurrency@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userA = { id: uA.id, email: uA.email };
    tokenA = jwtService.sign({ id: uA.id, email: uA.email }, { expiresIn: '24h' });
  });

  async function createMockFlightOffer(data: Partial<Prisma.FlightOfferCreateInput> = {}) {
    return prisma.flightOffer.create({
      data: {
        searchHash: 'test-search-hash',
        supplierOfferId: 'off_duffel_123',
        rawOffer: {},
        origin: 'SGN',
        destination: 'HAN',
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(100.0),
        currency: 'USD',
        ...data,
      },
    });
  }

  function liveOfferResponse(totalAmount = '100.00') {
    return {
      data: {
        id: 'off_duffel_123',
        total_amount: totalAmount,
        total_currency: 'USD',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        passengers: [{ id: 'duffel-passenger-1', type: 'adult' }],
      },
    } as any;
  }

  it('proves that out of 100 concurrent requests, exactly one succeeds and only one Duffel API call is made', async () => {
    const offer = await createMockFlightOffer({ adults: 1 });
    const crypto = await import('crypto');

    const handoffId = crypto.randomUUID();
    const token = 'chk_handoff_v1_valid-concurrency-token';
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const session = await prisma.chatSession.create({
      data: {
        id: 'test-session-id',
        userId: userA.id,
      },
    });

    await prisma.chatHandoff.create({
      data: {
        id: handoffId,
        userId: userA.id,
        chatSessionId: session.id,
        flightOfferId: offer.id,
        supplierOfferIdHash: 'hash',
        snapshotVersion: 1,
        snapshotFingerprint: 'print',
        selectionAttestationHash: 'attest',
        selectedOfferIndex: 1,
        tokenHash,
        tokenKeyVersion: 1,
        idempotencyKeyHash: 'idempotent',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    let duffelCallCount = 0;
    const duffelSpy = jest
      .spyOn(duffel.offers, 'get')
      .mockImplementation(async () => {
        duffelCallCount++;
        return liveOfferResponse();
      });

    const numRequests = 100;
    const reqBody = {
      handoffToken: token,
      passengers: [
        {
          type: PassengerType.ADULT,
          givenName: 'John',
          familyName: 'Doe',
          dateOfBirth: '1990-01-01',
          gender: 'male',
          nationality: 'US',
        },
      ],
    };

    const requests = Array.from({ length: numRequests }, () =>
      request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send(reqBody),
    );

    const responses = await Promise.all(requests);
    duffelSpy.mockRestore();

    const successResponses = responses.filter((r) => r.status === 201);
    const conflictResponses = responses.filter((r) => r.status === 409); // ConflictException

    // Exact assertions requested in the spec
    expect(successResponses.length).toBe(1);
    expect(conflictResponses.length).toBe(numRequests - 1);
    expect(duffelCallCount).toBe(1);

    const updatedHandoff = await prisma.chatHandoff.findUnique({ where: { id: handoffId } });
    expect(updatedHandoff?.consumedAt).toBeDefined();
    expect(updatedHandoff?.consumedByBookingIntentId).toBe(successResponses[0].body.intentId);
  });
});
