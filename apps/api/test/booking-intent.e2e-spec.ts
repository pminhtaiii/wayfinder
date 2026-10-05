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
import { DuffelSearchAdapter } from '@/supplier/search/duffel-search.adapter';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { AuditService } from '@/audit/audit.service';
import { EncryptionService } from '@/common/encryption.service';
import { BookingIntentCron } from '@/booking-intent/booking-intent.cron';
import { PassengerType, Prisma } from '@prisma/client';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { AirportsService } from '@/airports/airports.service';

describe('Booking Intent (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let searchAdapter: DuffelSearchAdapter;
  let duffel: Duffel;
  let auditService: AuditService;
  let encryptionService: EncryptionService;
  let cron: BookingIntentCron;
  let airportsService: AirportsService;

  let userA: { id: string; email: string };
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    process.env.FEATURE_FLAG_CHAT_HANDOFF_ACCEPT = 'true';
    process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';
    process.env.CHAT_HANDOFF_SECRET = 'test-handoff-secret';

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
    searchAdapter = moduleFixture.get<DuffelSearchAdapter>(DuffelSearchAdapter);
    duffel = moduleFixture.get<Duffel>(DUFFEL_SDK);
    auditService = moduleFixture.get<AuditService>(AuditService);
    encryptionService = moduleFixture.get<EncryptionService>(EncryptionService);
    cron = moduleFixture.get<BookingIntentCron>(BookingIntentCron);
    airportsService = moduleFixture.get<AirportsService>(AirportsService);
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

    // Create test users
    const uA = await prisma.user.create({
      data: {
        email: 'usera@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userA = { id: uA.id, email: uA.email };
    tokenA = jwtService.sign({ id: uA.id, email: uA.email }, { expiresIn: '24h' });

    const uB = await prisma.user.create({
      data: {
        email: 'userb@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    tokenB = jwtService.sign({ id: uB.id, email: uB.email }, { expiresIn: '24h' });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    delete process.env.BOOKING_INTENT_TTL_MINUTES;
    delete process.env.BOOKING_INTENT_GRACE_HOURS;
  });

  async function createMockFlightOffer(data: Partial<Prisma.FlightOfferCreateInput> = {}) {
    const unique = crypto.randomUUID();
    return prisma.flightOffer.create({
      data: {
        searchHash: data.searchHash ?? `test-search-hash-${unique}`,
        supplierOfferId: data.supplierOfferId ?? `off_duffel_${unique}`,
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

  async function createCanonicalFlightOffer() {
    return createMockFlightOffer({
      rawOffer: {
        passengers: [{ id: 'pas_001', type: 'adult' }],
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HAN' },
                arriving_at: '2026-08-01T12:00:00Z',
              },
            ],
          },
        ],
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
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

  describe('POST /api/bookings/intent', () => {
    it("creates intent with valid passengers (201), encrypts PII, writes audit log, doesn't return passport fields", async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse('125.50'));

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
              passportNumber: 'N123456',
              passportExpiry: '2030-01-01',
            },
          ],
        })
        .expect(201);

      expect(duffelSpy).toHaveBeenCalledWith(offer.supplierOfferId);
      duffelSpy.mockRestore();

      expect(res.body).toHaveProperty('intentId');
      expect(res.body.status).toBe('PENDING');
      expect(res.body.originalPrice).toBe(100);
      expect(res.body.confirmedPrice).toBe(125.5);
      expect(res.body.priceChanged).toBe(true);

      // Compatibility keys remain null; encrypted values never cross the API boundary.
      expect(res.body.passengers[0].passportNumber).toBeNull();
      expect(res.body.passengers[0].passportExpiry).toBeNull();
      expect(res.body.passengers[0].preFilledFromProfile).toBe(false);

      // Verify DB records
      const intent = await prisma.bookingIntent.findUnique({
        where: { id: res.body.intentId },
        include: { passengers: true },
      });

      expect(intent).toBeDefined();
      expect(intent!.passengers.length).toBe(1);
      expect(intent!.passengers[0].position).toBe(0);

      // Verify PII fields are encrypted in the DB
      expect(intent!.passengers[0].passportNumber).not.toBe('N123456');
      expect(intent!.passengers[0].passportNumber).toContain(':');
      expect(encryptionService.decrypt(intent!.passengers[0].passportNumber!)).toBe('N123456');

      expect(intent!.passengers[0].passportExpiry).not.toBe('2030-01-01');
      expect(intent!.passengers[0].passportExpiry).toContain(':');
      expect(encryptionService.decrypt(intent!.passengers[0].passportExpiry!)).toBe('2030-01-01');

      // Verify audit log entry
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'booking_intent_created' },
      });
      expect(audit).toBeDefined();
      expect(audit!.resourceId).toBe(res.body.intentId);
    });

    it('creates intent with pre-fill from TravelerProfile (useProfile: true)', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const encryptedPassport = `v1:${encryptionService.encrypt('MYPASSPORT123')}`;
      await prisma.travelerProfile.create({
        data: {
          userId: userA.id,
          nationality: 'VN',
          passportNumber: encryptedPassport,
          passportExpiry: new Date('2032-12-31T00:00:00.000Z'),
        },
      });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Primary',
              familyName: 'User',
              dateOfBirth: '1995-05-05',
              gender: 'female',
              useProfile: true,
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();

      expect(res.body.passengers[0].preFilledFromProfile).toBe(true);

      const intent = await prisma.bookingIntent.findUnique({
        where: { id: res.body.intentId },
        include: { passengers: true },
      });

      expect(intent!.passengers[0].nationality).toBe('VN');
      expect(encryptionService.decrypt(intent!.passengers[0].passportNumber!)).toBe(
        'MYPASSPORT123',
      );
      expect(encryptionService.decrypt(intent!.passengers[0].passportExpiry!)).toBe('2032-12-31');
    });

    it('rejects creation when infants > adults (400)', async () => {
      const offer = await createMockFlightOffer({ adults: 1, infants: 2 });

      await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
            },
            {
              type: PassengerType.INFANT,
              givenName: 'BabyA',
              familyName: 'Doe',
              dateOfBirth: '2023-01-01',
              gender: 'male',
              nationality: 'US',
            },
            {
              type: PassengerType.INFANT,
              givenName: 'BabyB',
              familyName: 'Doe',
              dateOfBirth: '2026-02-02',
              gender: 'female',
              nationality: 'US',
            },
          ],
        })
        .expect(400);
    });

    it('rejects creation when total passengers > 9 (400)', async () => {
      const offer = await createMockFlightOffer({ adults: 10 });

      const passengers = Array.from({ length: 10 }, (_, i) => ({
        type: PassengerType.ADULT,
        givenName: `User${i}`,
        familyName: 'Doe',
        dateOfBirth: '1990-01-01',
        gender: 'male',
        nationality: 'US',
      }));

      await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers,
        })
        .expect(400);
    });

    it('rejects creation when passenger count mismatches flight offer breakdown (400)', async () => {
      const offer = await createMockFlightOffer({ adults: 2, children: 1 });

      // Only supply 2 adults, missing children
      await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'AdultOne',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
            },
            {
              type: PassengerType.ADULT,
              givenName: 'AdultTwo',
              familyName: 'Doe',
              dateOfBirth: '1992-02-02',
              gender: 'female',
              nationality: 'US',
            },
          ],
        })
        .expect(400);
    });

    it('rolls back intent creation if audit log write fails inside transaction', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      // Force AuditService.createLog to fail
      const auditSpy = jest
        .spyOn(auditService, 'createLog')
        .mockRejectedValue(new Error('Audit DB Down'));

      await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
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
        })
        .expect(500);

      duffelSpy.mockRestore();
      auditSpy.mockRestore();

      // Verify no intent or passengers exist
      const intentsCount = await prisma.bookingIntent.count();
      const passengersCount = await prisma.bookingIntentPassenger.count();
      expect(intentsCount).toBe(0);
      expect(passengersCount).toBe(0);
    });

    it('returns 410 if Duffel offer is expired during re-pricing', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelError = new Error('Offer expired') as any;
      duffelError.status = 410;

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockRejectedValue(duffelError);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
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
        })
        .expect(410);

      duffelSpy.mockRestore();
      expect(res.body.code).toBe('OFFER_EXPIRED');
    });

    it('ignores client-supplied extra fields and rejects with 400 validation error', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      // Because ValidationPipe is configured with forbidNonWhitelisted: true,
      // sending duffelOfferId in the request body should result in a 400 ValidationError.
      await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          duffelOfferId: 'overridden-by-client',
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
        })
        .expect(400);
    });
  });

  describe('Canonical plural routes and deprecated singular aliases', () => {
    it('evaluates readiness, creates atomically, and returns the same safe shape from plural and singular GETs without dateOfBirth', async () => {
      const offer = await createCanonicalFlightOffer();
      const airportCountrySpy = jest
        .spyOn(airportsService, 'findCountriesByIataCodes')
        .mockResolvedValue(
          new Map([
            ['SGN', 'VN'],
            ['HAN', 'VN'],
          ]),
        );
      const source = {
        type: 'inline',
        givenName: 'Ada',
        familyName: 'Lovelace',
        dateOfBirth: '1815-12-10',
        gender: 'female',
        nationality: 'US',
        email: 'ada@example.test',
        phoneCountryCode: '+1',
        phoneNumber: '5550000000',
        title: 'Ms',
      };
      const requestPassenger = {
        offerPassengerId: 'pas_001',
        type: PassengerType.ADULT,
        source,
      };

      const readiness = await request(app.getHttpServer())
        .post('/api/bookings/intents/readiness')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-phase8')
        .set('x-correlation-id', 'correlation-phase8')
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerType: PassengerType.ADULT,
              source,
            },
          ],
        })
        .expect(200);

      expect(readiness.body.ready).toBe(true);
      expect(readiness.body.scope).toBe('DOMESTIC');

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-phase8')
        .set('x-correlation-id', 'correlation-phase8')
        .send({
          flightOfferId: offer.id,
          readinessScope: readiness.body.scope,
          passengers: [requestPassenger],
        })
        .expect(201);
      duffelSpy.mockRestore();

      expect(createRes.headers['cache-control']).toBe('no-store, private');
      expect(createRes.headers['x-trace-id']).toBe('trace-phase8');
      expect(createRes.headers['x-correlation-id']).toBe('correlation-phase8');
      expect(createRes.body.passengers[0]).toEqual(
        expect.objectContaining({
          passengerType: 'ADULT',
          nameSummary: expect.stringMatching(/^A/),
          passportNumber: null,
          passportExpiry: null,
          maskedPassportSummary: null,
          maskedContactSummary: expect.stringMatching(/^a.* \+1/),
        }),
      );
      expect(createRes.body.passengers[0]).not.toHaveProperty('givenName');
      expect(createRes.body.passengers[0]).not.toHaveProperty('dateOfBirth');

      const pluralGet = await request(app.getHttpServer())
        .get(`/api/bookings/intents/${createRes.body.intentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-get-plural')
        .set('x-correlation-id', 'correlation-get-plural')
        .expect(200);
      const singularGet = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createRes.body.intentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-get-singular')
        .set('x-correlation-id', 'correlation-get-singular')
        .expect(200);

      expect(pluralGet.headers['cache-control']).toBe('no-store, private');
      expect(pluralGet.headers['x-trace-id']).toBe('trace-get-plural');
      expect(pluralGet.headers['x-correlation-id']).toBe('correlation-get-plural');

      expect(singularGet.headers['cache-control']).toBe('no-store, private');
      expect(singularGet.headers['x-trace-id']).toBe('trace-get-singular');
      expect(singularGet.headers['x-correlation-id']).toBe('correlation-get-singular');

      expect(pluralGet.body.passengers[0].passportNumber).toBeNull();
      expect(pluralGet.body.passengers[0].passportExpiry).toBeNull();
      expect(pluralGet.body.passengers[0].documentSummary.hasPassport).toBe(false);
      expect(pluralGet.body.passengers[0]).not.toHaveProperty('dateOfBirth');
      expect(singularGet.body.passengers[0]).not.toHaveProperty('dateOfBirth');
      expect(singularGet.body.passengers).toEqual(pluralGet.body.passengers);
      airportCountrySpy.mockRestore();
    });

    it('creates canonical plural intent with mixed traveler_profile and inline passengers returning 201 and safe masked summary', async () => {
      const encryptedPassport = encryptionService.encryptBound('VN98765432', {
        userId: userA.id,
        fieldName: 'passportNumber',
      });
      const profile = await prisma.travelerProfile.create({
        data: {
          userId: userA.id,
          givenName: 'Ada',
          familyName: 'Lovelace',
          dateOfBirth: new Date('1815-12-10T00:00:00.000Z'),
          gender: 'female',
          title: 'Ms',
          email: 'ada@example.test',
          phoneCountryCode: '+84',
          phoneNumber: '901234567',
          nationality: 'VN',
          documentType: 'passport',
          issuingCountry: 'VN',
          passportNumber: encryptedPassport,
          passportExpiry: new Date('2032-12-31T00:00:00.000Z'),
        },
      });

      const offer = await createMockFlightOffer({
        adults: 1,
        children: 1,
        rawOffer: {
          passengers: [
            { id: 'pas_001', type: 'adult' },
            { id: 'pas_002', type: 'child' },
          ],
          slices: [
            {
              segments: [
                {
                  origin: { iata_code: 'SGN' },
                  destination: { iata_code: 'HAN' },
                  arriving_at: '2026-08-01T12:00:00Z',
                },
              ],
            },
          ],
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        },
      });

      const airportCountrySpy = jest
        .spyOn(airportsService, 'findCountriesByIataCodes')
        .mockResolvedValue(
          new Map([
            ['SGN', 'VN'],
            ['HAN', 'VN'],
          ]),
        );

      const duffelSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
        data: {
          id: 'off_duffel_mixed',
          total_amount: '200.00',
          total_currency: 'USD',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          passengers: [
            { id: 'duffel-passenger-1', type: 'adult' },
            { id: 'duffel-passenger-2', type: 'child' },
          ],
        },
      } as any);

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-mixed')
        .set('x-correlation-id', 'correlation-mixed')
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              offerPassengerId: 'pas_001',
              type: PassengerType.ADULT,
              source: {
                type: 'traveler_profile',
                travelerProfileId: profile.id,
                expectedProfileRevision: profile.revision,
              },
            },
            {
              offerPassengerId: 'pas_002',
              type: PassengerType.CHILD,
              source: {
                type: 'inline',
                givenName: 'Charles',
                familyName: 'Babbage',
                dateOfBirth: '2016-12-26',
                gender: 'male',
                nationality: 'GB',
                email: 'charles@example.test',
                phoneCountryCode: '+44',
                phoneNumber: '7000000002',
                title: 'Mr',
              },
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();
      airportCountrySpy.mockRestore();

      expect(res.body.passengers).toHaveLength(2);

      // Primary passenger from traveler profile
      const p1 = res.body.passengers[0];
      expect(p1.passengerType).toBe('ADULT');
      expect(p1.passengerOrdinal).toBe(1);
      expect(p1.preFilledFromProfile).toBe(true);
      expect(p1.passportNumber).toBeNull();
      expect(p1.passportExpiry).toBeNull();
      expect(p1.maskedPassportSummary).toBe('•••• 5432');
      expect(p1.maskedContactSummary).toBe('a•••@example.test +84••••67');
      expect(p1.documentSummary.hasPassport).toBe(true);
      expect(p1.documentSummary.maskedPassportSummary).toBe('•••• 5432');
      expect(p1.contactSummary.maskedContactSummary).toBe('a•••@example.test +84••••67');
      expect(p1).not.toHaveProperty('givenName');
      expect(p1).not.toHaveProperty('dateOfBirth');

      // Secondary child passenger inline
      const p2 = res.body.passengers[1];
      expect(p2.passengerType).toBe('CHILD');
      expect(p2.passengerOrdinal).toBe(2);
      expect(p2.preFilledFromProfile).toBe(false);
      expect(p2.passportNumber).toBeNull();
      expect(p2.passportExpiry).toBeNull();
      expect(p2.maskedPassportSummary).toBeNull();
      expect(p2.maskedContactSummary).toBe('c•••@example.test +44••••02');
      expect(p2.documentSummary.hasPassport).toBe(false);

      // GET by ID verification
      const getRes = await request(app.getHttpServer())
        .get(`/api/bookings/intents/${res.body.intentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(getRes.body.passengers[0].givenName).toBe('Ada');
      expect(getRes.body.passengers[0].familyName).toBe('Lovelace');
      expect(getRes.body.passengers[0].passportNumber).toBeNull();
      expect(getRes.body.passengers[0].passportExpiry).toBeNull();
      expect(getRes.body.passengers[0]).not.toHaveProperty('dateOfBirth');
      expect(getRes.body.passengers[1].givenName).toBe('Charles');
      expect(getRes.body.passengers[1].familyName).toBe('Babbage');
      expect(getRes.body.passengers[1].passportNumber).toBeNull();
      expect(getRes.body.passengers[1].passportExpiry).toBeNull();
      expect(getRes.body.passengers[1]).not.toHaveProperty('dateOfBirth');
    });

    it('rejects legacy profile flags on the canonical plural create route with 400 PASSENGER_SOURCE_CONFLICT', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              useProfile: true,
              givenName: 'Primary',
              familyName: 'User',
              dateOfBirth: '1995-05-05',
              gender: 'female',
              nationality: 'US',
            },
          ],
        })
        .expect(400);

      expect(res.body.code).toBe('PASSENGER_SOURCE_CONFLICT');
      expect(await prisma.bookingIntent.count()).toBe(0);
    });

    it('rejects payload containing both useProfile and source with 400 PASSENGER_SOURCE_CONFLICT', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intents')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              offerPassengerId: 'pas_001',
              useProfile: true,
              source: {
                type: 'inline',
                givenName: 'Grace',
                familyName: 'Hopper',
                dateOfBirth: '1906-12-09',
                gender: 'female',
                nationality: 'US',
                email: 'grace@example.test',
                phoneCountryCode: '+1',
                phoneNumber: '5550000000',
                title: 'MS',
              },
            },
          ],
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('PASSENGER_SOURCE_CONFLICT');
      expect(await prisma.bookingIntent.count()).toBe(0);
    });

    it('translates primary useProfile: true on singular deprecated POST /api/bookings/intent and returns safe headers', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const encryptedPassport = `v1:${encryptionService.encrypt('MYPASSPORT123')}`;
      await prisma.travelerProfile.create({
        data: {
          userId: userA.id,
          nationality: 'VN',
          passportNumber: encryptedPassport,
          passportExpiry: new Date('2032-12-31T00:00:00.000Z'),
        },
      });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .set('x-trace-id', 'trace-legacy-create')
        .set('x-correlation-id', 'correlation-legacy-create')
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Primary',
              familyName: 'User',
              dateOfBirth: '1995-05-05',
              gender: 'female',
              useProfile: true,
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();

      expect(res.headers['cache-control']).toBe('no-store, private');
      expect(res.headers['x-trace-id']).toBe('trace-legacy-create');
      expect(res.headers['x-correlation-id']).toBe('correlation-legacy-create');
      expect(res.body.passengers[0].preFilledFromProfile).toBe(true);
      expect(res.body.passengers[0].passportNumber).toBeNull();
      expect(res.body.passengers[0].passportExpiry).toBeNull();
    });

    it('rejects useProfile on a non-primary legacy passenger with 400 LEGACY_PROFILE_SOURCE_UNSUPPORTED', async () => {
      const offer = await createMockFlightOffer({ adults: 1, children: 1 });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Primary',
              familyName: 'User',
              dateOfBirth: '1995-05-05',
              gender: 'female',
              useProfile: true,
            },
            {
              type: PassengerType.CHILD,
              givenName: 'Child',
              familyName: 'User',
              dateOfBirth: '2015-05-05',
              gender: 'male',
              useProfile: true,
            },
          ],
        })
        .expect(400);

      expect(res.body.code).toBe('LEGACY_PROFILE_SOURCE_UNSUPPORTED');
      expect(await prisma.bookingIntent.count()).toBe(0);
    });
  });

  describe('GET /api/bookings/intent/:id', () => {
    it('retrieves own intent (200) with masked passenger summaries', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'John',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
              passportNumber: 'N123456',
              passportExpiry: '2030-01-01',
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();

      const getRes = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createRes.body.intentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(getRes.body.passengers[0].passportNumber).toBeNull();
      expect(getRes.body.passengers[0].passportExpiry).toBeNull();
      expect(getRes.body.passengers[0].nameSummary).toMatch(/^J/);
      expect(getRes.body.passengers[0].documentSummary.hasPassport).toBe(true);
    });

    it("returns 403 Forbidden when retrieving other user's intent", async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
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
        })
        .expect(201);

      duffelSpy.mockRestore();

      // Retrieve using User B token
      await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createRes.body.intentId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .expect(403);
    });

    it('returns 410 Gone when retrieving an expired intent', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
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
        })
        .expect(201);

      duffelSpy.mockRestore();

      // Artificially change status to EXPIRED in database
      await prisma.bookingIntent.update({
        where: { id: createRes.body.intentId },
        data: { status: 'EXPIRED' },
      });

      const res = await request(app.getHttpServer())
        .get(`/api/bookings/intent/${createRes.body.intentId}`)
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(410);

      expect(res.body.code).toBe('INTENT_EXPIRED');
    });
  });

  describe('GET /api/bookings/intent/prefill', () => {
    it('returns hasProfile: true and list of missing fields when profile exists', async () => {
      const encryptedPassport = `v1:${encryptionService.encrypt('SECRET123')}`;
      await prisma.travelerProfile.create({
        data: {
          userId: userA.id,
          nationality: 'US',
          passportNumber: encryptedPassport,
          passportExpiry: new Date('2035-05-05T00:00:00.000Z'),
          seatPreference: 'window',
        },
      });

      const res = await request(app.getHttpServer())
        .get('/api/bookings/intent/prefill')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.hasProfile).toBe(true);
      expect(res.body.passenger.nationality).toBe('US');
      expect(res.body.passenger.passportNumber).toBe('SECRET123');
      expect(res.body.passenger.passportExpiry).toBe('2035-05-05');
      expect(res.body.passenger.seatPreference).toBe('window');

      // missing fields check
      expect(res.body.missingFields).toContain('givenName');
      expect(res.body.missingFields).toContain('familyName');
      expect(res.body.missingFields).toContain('dateOfBirth');
      expect(res.body.missingFields).toContain('gender');
      expect(res.body.missingFields).not.toContain('nationality');
      expect(res.body.missingFields).not.toContain('passportNumber');
      expect(res.body.missingFields).not.toContain('passportExpiry');
    });

    it('returns hasProfile: false and empty list of missing fields when no profile exists', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/bookings/intent/prefill')
        .set('Authorization', `Bearer ${tokenA}`)
        .expect(200);

      expect(res.body.hasProfile).toBe(false);
      expect(res.body.passenger).toBeNull();
      expect(res.body.missingFields).toEqual([]);
    });
  });

  describe('Cron Lifecycle Operations', () => {
    it('Phase 1 cleanup: updates PENDING intents to EXPIRED when expired (default and custom TTL)', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      // 1. Default TTL path
      const resDefault = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
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
        })
        .expect(201);

      // Artificially age default intent
      await prisma.bookingIntent.update({
        where: { id: resDefault.body.intentId },
        data: { intentExpiresAt: new Date(Date.now() - 1000) },
      });

      // 2. Custom TTL path
      process.env.BOOKING_INTENT_TTL_MINUTES = '10';

      const resCustom = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'Jane',
              familyName: 'Doe',
              dateOfBirth: '1992-02-02',
              gender: 'female',
              nationality: 'US',
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();

      // Verify custom TTL was applied
      const customIntentBefore = await prisma.bookingIntent.findUnique({
        where: { id: resCustom.body.intentId },
      });
      const expectedExpiry = new Date(customIntentBefore!.createdAt.getTime() + 10 * 60 * 1000);
      expect(
        Math.abs(customIntentBefore!.intentExpiresAt.getTime() - expectedExpiry.getTime()),
      ).toBeLessThan(5000);

      // Artificially age custom intent
      await prisma.bookingIntent.update({
        where: { id: resCustom.body.intentId },
        data: { intentExpiresAt: new Date(Date.now() - 1000) },
      });

      // Trigger Phase 1 Cron
      await cron.handleExpiration();

      // Verify both default and custom are EXPIRED
      const defaultStatus = await prisma.bookingIntent.findUnique({
        where: { id: resDefault.body.intentId },
      });
      const customStatus = await prisma.bookingIntent.findUnique({
        where: { id: resCustom.body.intentId },
      });

      expect(defaultStatus!.status).toBe('EXPIRED');
      expect(customStatus!.status).toBe('EXPIRED');

      // Verify audit logs written for both
      const auditExpired = await prisma.auditLog.findFirst({
        where: { action: 'booking_intent_expired' },
      });
      expect(auditExpired).toBeDefined();
      expect((auditExpired!.metadata as any).count).toBe(2);
    });

    it('Phase 2 cleanup: hard-deletes EXPIRED intents after grace period (default and custom grace)', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      // Create two intents
      const res1 = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'AdultOne',
              familyName: 'Doe',
              dateOfBirth: '1990-01-01',
              gender: 'male',
              nationality: 'US',
            },
          ],
        })
        .expect(201);

      const res2 = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
          flightOfferId: offer.id,
          passengers: [
            {
              type: PassengerType.ADULT,
              givenName: 'AdultTwo',
              familyName: 'Doe',
              dateOfBirth: '1992-02-02',
              gender: 'female',
              nationality: 'US',
            },
          ],
        })
        .expect(201);

      duffelSpy.mockRestore();

      // Mark both as EXPIRED
      await prisma.bookingIntent.updateMany({
        where: { id: { in: [res1.body.intentId, res2.body.intentId] } },
        data: { status: 'EXPIRED' },
      });

      // Clear env var for first run
      delete process.env.BOOKING_INTENT_GRACE_HOURS;

      // 1. Age first intent past default grace hours (24h -> age by 25h)
      await prisma.$executeRaw`UPDATE booking_intents SET "updatedAt" = ${new Date(Date.now() - 25 * 60 * 60 * 1000)} WHERE id = ${res1.body.intentId}`;

      // 2. Age second intent by 6h (should NOT be deleted yet under default 24h grace)
      await prisma.$executeRaw`UPDATE booking_intents SET "updatedAt" = ${new Date(Date.now() - 6 * 60 * 60 * 1000)} WHERE id = ${res2.body.intentId}`;

      // Trigger Phase 2 Cron (default grace)
      await cron.handleHardDelete();

      // Verify only the 25h intent is deleted
      const int1 = await prisma.bookingIntent.findUnique({ where: { id: res1.body.intentId } });
      const int2 = await prisma.bookingIntent.findUnique({ where: { id: res2.body.intentId } });

      expect(int1).toBeNull();
      expect(int2).toBeDefined();

      // Verify cascading passenger deletion for the first intent
      const passengerCount1 = await prisma.bookingIntentPassenger.count({
        where: { intentId: res1.body.intentId },
      });
      expect(passengerCount1).toBe(0);

      // Verify audit log for first deletion
      const auditDeleted1 = await prisma.auditLog.findFirst({
        where: { action: 'booking_intent_deleted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(auditDeleted1).toBeDefined();
      expect((auditDeleted1!.metadata as any).count).toBe(1);

      // Set custom grace to 5h
      process.env.BOOKING_INTENT_GRACE_HOURS = '5';

      // Trigger Phase 2 Cron again
      await cron.handleHardDelete();

      // Verify second intent is now deleted
      const int2After = await prisma.bookingIntent.findUnique({
        where: { id: res2.body.intentId },
      });
      expect(int2After).toBeNull();

      // Verify audit log for second deletion
      const auditDeleted2 = await prisma.auditLog.findFirst({
        where: { action: 'booking_intent_deleted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(auditDeleted2).toBeDefined();
      expect((auditDeleted2!.metadata as any).count).toBe(1);
    });
  });

  describe('Chat Handoff Consumption', () => {
    it('acquires and consumes an unexpired claim correctly', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const crypto = await import('crypto');

      const handoffId = crypto.randomUUID();
      const token = 'chk_handoff_v1_valid-token';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const session = await prisma.chatSession.create({
        data: {
          id: 'test-session-id',
          userId: userA.id,
        },
      });

      const handoff = await prisma.chatHandoff.create({
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

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
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
        });

      if (res.status !== 201) {
        console.error('RESPONSE BODY:', res.body);
      }

      expect(res.status).toBe(201);

      duffelSpy.mockRestore();

      const updatedHandoff = await prisma.chatHandoff.findUnique({ where: { id: handoffId } });
      expect(updatedHandoff?.consumedAt).toBeDefined();
      expect(updatedHandoff?.consumedByBookingIntentId).toBe(res.body.intentId);

      const consumeAudit = await prisma.auditLog.findFirst({
        where: { action: 'chat_handoff_consumed', userId: userA.id },
        orderBy: { createdAt: 'desc' },
      });
      expect(consumeAudit).toBeDefined();
      expect(consumeAudit?.metadata).toMatchObject({ operation: 'handoff_consume' });
      const consumeMetadata = JSON.stringify(consumeAudit?.metadata);
      expect(consumeMetadata).not.toContain(handoffId);
      expect(consumeMetadata).not.toContain(offer.id);
      expect(consumeMetadata).not.toContain(userA.id);
      expect(consumeMetadata).not.toContain(token);
    });

    it('fails to consume claim and throws ConflictException if chatSession is soft deleted', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const crypto = await import('crypto');

      const handoffId = crypto.randomUUID();
      const token = 'chk_handoff_v1_valid-token-deleted-session';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const session = await prisma.chatSession.create({
        data: {
          id: 'deleted-session-id',
          userId: userA.id,
          deletedAt: new Date(),
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
          idempotencyKeyHash: 'idempotent-2',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
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
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Chat session was deleted');

      duffelSpy.mockRestore();
    });

    it('fails to consume claim and throws ConflictException if claim expires before transaction completes', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const crypto = await import('crypto');

      const handoffId = crypto.randomUUID();
      const token = 'chk_handoff_v1_valid-token-expired-claim';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const session = await prisma.chatSession.create({
        data: {
          id: 'active-session-id',
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
          idempotencyKeyHash: 'idempotent-3',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      // We mock duffel get to also alter the DB state behind the scenes, making the claim expired!
      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockImplementation(async () => {
          // Expire the claim that was just acquired!
          await prisma.chatHandoff.update({
            where: { id: handoffId },
            data: { claimExpiresAt: new Date(Date.now() - 1000) },
          });
          return liveOfferResponse();
        });

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
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
        });

      expect(res.status).toBe(409);
      expect(res.body.message).toContain('Claim lost or expired before completion');

      duffelSpy.mockRestore();
    });

    it('throws UPSTREAM_TIMEOUT if duffel takes longer than hard deadline (25s) safely below claim TTL', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const crypto = await import('crypto');

      const handoffId = crypto.randomUUID();
      const token = 'chk_handoff_v1_valid-token-timeout';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const session = await prisma.chatSession.create({
        data: {
          id: 'active-session-id-2',
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
          idempotencyKeyHash: 'idempotent-4',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const { DuffelTimeoutError } = await import('@/supplier/search/duffel-search.adapter');
      const duffelSpy = jest
        .spyOn(searchAdapter, 'getOffer')
        .mockRejectedValue(new DuffelTimeoutError());

      const res = await request(app.getHttpServer())
        .post('/api/bookings/intent')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({
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
        });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('UPSTREAM_TIMEOUT');

      duffelSpy.mockRestore();
    });

    it('handles 100 concurrent requests, allowing exactly 1 winner and ensuring 99 losers make 0 Duffel API calls', async () => {
      const offer = await createMockFlightOffer({ adults: 1 });
      const crypto = await import('crypto');

      const handoffId = crypto.randomUUID();
      const token = 'chk_handoff_v1_valid-token-concurrency';
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

      const session = await prisma.chatSession.create({
        data: {
          id: 'active-session-id-3',
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
          idempotencyKeyHash: 'idempotent-5',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
      });

      const duffelSpy = jest
        .spyOn(duffel.offers, 'get')
        .mockResolvedValue(liveOfferResponse());

      const requests = Array.from({ length: 100 }).map(() =>
        request(app.getHttpServer())
          .post('/api/bookings/intent')
          .set('Authorization', `Bearer ${tokenA}`)
          .send({
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
          }),
      );

      const responses = await Promise.all(requests);

      const successCount = responses.filter((r) => r.status === 201).length;
      const conflictCount = responses.filter((r) => r.status === 409).length;

      if (successCount === 0) {
        console.error('All requests failed! Sample error:', responses[0].status, responses[0].body);
      }

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(99);

      // Verify that Duffel API was only called exactly once!
      expect(duffelSpy).toHaveBeenCalledTimes(1);

      duffelSpy.mockRestore();
    });
  });
});
