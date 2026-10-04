import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { CacheService } from '@/cache/cache.service';
import { JwtService } from '@nestjs/jwt';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { Prisma } from '@prisma/client';

describe('Flights Detail & Re-price (E2E)', () => {
  jest.setTimeout(30000);
  let app: INestApplication;
  let prisma: PrismaService;
  let cacheService: CacheService;
  let jwtService: JwtService;
  let jwtToken: string;
  let userId: string;

  beforeAll(async () => {
    jest
      .useFakeTimers({
        doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'setTimeout'],
      })
      .setSystemTime(new Date('2026-07-08T12:00:00.000Z'));

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
    cacheService = moduleFixture.get<CacheService>(CacheService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    jest.useRealTimers();
    await app.close();
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
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    const keys = await cacheService.keys('*');
    for (const key of keys) {
      await cacheService.del(key);
    }

    await prisma.airport.createMany({
      data: [
        {
          iataCode: 'HAN',
          icaoCode: 'VVNB',
          name: 'Noi Bai International Airport',
          city: 'Hanoi',
          country: 'VN',
          region: 'VN-HN',
          latitude: 21.2212,
          longitude: 105.807,
          elevation: 39,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
        {
          iataCode: 'SGN',
          icaoCode: 'VVTS',
          name: 'Tan Son Nhat International Airport',
          city: 'Ho Chi Minh City',
          country: 'VN',
          region: 'VN-SG',
          latitude: 10.8184,
          longitude: 106.6633,
          elevation: 33,
          type: 'LARGE_AIRPORT',
          timezone: 'Asia/Ho_Chi_Minh',
        },
      ],
    });

    const user = await prisma.user.create({
      data: {
        email: 'detailuser@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    userId = user.id;

    jwtToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
  });

  describe('GET /api/flights/:id', () => {
    const validOfferUuid = '11111111-2222-3333-4444-555555555555';
    const mockSearchHash = 'mock_search_hash_123';

    it('should return 401 Unauthorized when requesting without Bearer token', async () => {
      await request(app.getHttpServer()).get(`/api/flights/${validOfferUuid}`).expect(401);
    });

    it('should return 400 Bad Request when id is not a valid UUID', async () => {
      await request(app.getHttpServer())
        .get('/api/flights/invalid-uuid-format')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(400);
    });

    it('should return 404 Not Found when UUID has never existed in DB', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/flights/99999999-9999-4999-a999-999999999999')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(404);

      expect(response.body.message).toContain('never existed');
    });

    describe('Retrieving Existing Offer', () => {
      let duffel: Duffel;
      let sdkSpy: jest.SpyInstance;

      const mockDuffelOffer = {
        id: 'off_mock_123',
        total_amount: '127.00',
        total_currency: 'USD',
        expires_at: '2026-07-15T06:00:00Z',
        slices: [
          {
            id: 'sli_mock_1',
            duration: 'PT2H10M',
            origin: {
              id: 'HAN',
              name: 'Noi Bai International Airport',
              iata_code: 'HAN',
              type: 'airport',
            },
            destination: {
              id: 'SGN',
              name: 'Tan Son Nhat International Airport',
              iata_code: 'SGN',
              type: 'airport',
            },
            segments: [
              {
                id: 'seg_mock_1',
                duration: 'PT2H10M',
                departing_at: '2026-07-15T08:00:00',
                arriving_at: '2026-07-15T10:10:00',
                origin: {
                  id: 'HAN',
                  name: 'Noi Bai International Airport',
                  iata_code: 'HAN',
                  type: 'airport',
                },
                destination: {
                  id: 'SGN',
                  name: 'Tan Son Nhat International Airport',
                  iata_code: 'SGN',
                  type: 'airport',
                },
                operating_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier: { id: 'VN', name: 'Vietnam Airlines', iata_code: 'VN' },
                marketing_carrier_flight_number: '123',
                aircraft: { id: 'arc_mock_1', name: 'Airbus A321', iata_code: '321' },
                passengers: [
                  {
                    passenger_id: 'pas_mock_1',
                    cabin_class: 'economy',
                    baggages: [{ type: 'checked', quantity: 1 }],
                  },
                ],
              },
            ],
          },
        ],
        passengers: [{ id: 'pas_mock_1', type: 'adult' }],
        passenger_identity_documents_required: false,
        conditions: {
          refund_before_departure: {
            allowed: false,
            penalty_amount: null,
            penalty_currency: null,
          },
          change_before_departure: {
            allowed: true,
            penalty_amount: '50.00',
            penalty_currency: 'USD',
          },
        },
      };

      beforeEach(async () => {
        duffel = app.get<Duffel>(DUFFEL_SDK);
        sdkSpy = jest.spyOn(duffel.offers, 'get').mockResolvedValue({
          data: mockDuffelOffer,
          status: 200,
        } as any);

        // Seed flight offer and recovery
        await prisma.flightOffer.create({
          data: {
            id: validOfferUuid,
            searchHash: mockSearchHash,
            supplierOfferId: 'off_mock_123',
            rawOffer: mockDuffelOffer as unknown as Prisma.InputJsonValue,
            origin: 'HAN',
            destination: 'SGN',
            departureDate: new Date('2026-07-15'),
            adults: 1,
            children: 0,
            infants: 0,
            cabinClass: 'economy',
            price: new Prisma.Decimal(125.5), // original price
            currency: 'USD',
          },
        });

        await prisma.offerRecovery.create({
          data: {
            id: validOfferUuid,
            searchHash: mockSearchHash,
          },
        });

        // Seed search history
        await prisma.searchHistory.create({
          data: {
            userId,
            origin: 'HAN',
            destination: 'SGN',
            departureDate: new Date('2026-07-15'),
            adults: 1,
            children: 0,
            infants: 0,
            cabinClass: 'economy',
            resultCount: 1,
            minPrice: new Prisma.Decimal(125.5),
            maxPrice: new Prisma.Decimal(125.5),
            currency: 'USD',
            searchHash: mockSearchHash,
          },
        });
      });

      afterEach(() => {
        sdkSpy.mockRestore();
      });

      it('should retrieve flight details successfully, repricing via Duffel, showing price change, and writing audit logs', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/flights/${validOfferUuid}`)
          .set('Authorization', `Bearer ${jwtToken}`)
          .expect(200);

        expect(sdkSpy).toHaveBeenCalledWith('off_mock_123');
        expect(res.body.id).toBe(validOfferUuid);
        expect(res.body.originalPrice).toBe(125.5);
        expect(res.body.confirmedPrice).toBe(127.0); // live price
        expect(res.body.priceChanged).toBe(true);
        expect(res.body.currency).toBe('USD');
        expect(res.body.expiresAt).toBe('2026-07-15T06:00:00Z');
        expect(res.body.conditions.refundable).toBe(false);
        expect(res.body.conditions.changeable).toBe(true);
        expect(res.body.conditions.changeBeforeDeparture.penaltyAmount).toBe('50.00');

        // Audit log check
        const auditLog = await prisma.auditLog.findFirst({
          where: { userId, action: 'flight_detail_view' },
        });
        expect(auditLog).toBeDefined();
        expect(auditLog!.resourceType).toBe('Flight');
        expect((auditLog!.metadata as any).flightId).toBe(validOfferUuid);
      });

      it('should return 410 Gone when offer expired on Duffel (Duffel API throws 404/410), deleting offer row and returning recovery data', async () => {
        sdkSpy.mockRejectedValueOnce({
          status: 404,
          message: 'Offer no longer exists',
        });

        const res = await request(app.getHttpServer())
          .get(`/api/flights/${validOfferUuid}`)
          .set('Authorization', `Bearer ${jwtToken}`)
          .expect(410);

        expect(res.body.code).toBe('OFFER_EXPIRED');
        expect(res.body.recovery).toEqual({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          returnDate: null,
          adults: 1,
          children: 0,
          infants: 0,
          cabinClass: 'economy',
        });

        // Row should be deleted
        const offer = await prisma.flightOffer.findUnique({ where: { id: validOfferUuid } });
        expect(offer).toBeNull();
      });
    });

    describe('Retrieving Expired Offer (Directly Gone in DB)', () => {
      beforeEach(async () => {
        // Offer is NOT in FlightOffer, but IS in OfferRecovery
        await prisma.offerRecovery.create({
          data: {
            id: validOfferUuid,
            searchHash: mockSearchHash,
          },
        });

        await prisma.searchHistory.create({
          data: {
            userId,
            origin: 'HAN',
            destination: 'SGN',
            departureDate: new Date('2026-07-15'),
            returnDate: new Date('2026-07-20'),
            adults: 2,
            children: 0,
            infants: 0,
            cabinClass: 'economy',
            resultCount: 5,
            minPrice: new Prisma.Decimal(125.5),
            maxPrice: new Prisma.Decimal(250.0),
            currency: 'USD',
            searchHash: mockSearchHash,
          },
        });
      });

      it('should return 410 Gone when offer is purged from database but search history/recovery exists', async () => {
        const res = await request(app.getHttpServer())
          .get(`/api/flights/${validOfferUuid}`)
          .set('Authorization', `Bearer ${jwtToken}`)
          .expect(410);

        expect(res.body.code).toBe('OFFER_EXPIRED');
        expect(res.body.recovery).toEqual({
          origin: 'HAN',
          destination: 'SGN',
          departureDate: '2026-07-15',
          returnDate: '2026-07-20',
          adults: 2,
          children: 0,
          infants: 0,
          cabinClass: 'economy',
        });
      });
    });
  });
});
