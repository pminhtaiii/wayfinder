"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const cache_service_1 = require("@/cache/cache.service");
const jwt_1 = require("@nestjs/jwt");
const duffel_service_1 = require("@/duffel/duffel.service");
const duffel_cleanup_service_1 = require("@/duffel/duffel-cleanup.service");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
describe('Flights Analytics & Search History (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let cacheService;
    let jwtService;
    let cleanupService;
    let jwtToken;
    let userId;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitFor(assertion, timeout = 2000, interval = 50) {
        const start = performance.now();
        for (;;) {
            try {
                await assertion();
                return;
            }
            catch (error) {
                if (performance.now() - start > timeout) {
                    throw error;
                }
                await wait(interval);
            }
        }
    }
    beforeAll(async () => {
        jest.useFakeTimers({
            doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'setTimeout'],
        }).setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
        app.useGlobalPipes(new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        cacheService = moduleFixture.get(cache_service_1.CacheService);
        jwtService = moduleFixture.get(jwt_1.JwtService);
        cleanupService = moduleFixture.get(duffel_cleanup_service_1.DuffelCleanupService);
    });
    afterAll(async () => {
        jest.useRealTimers();
        await app.close();
    });
    beforeEach(async () => {
        await prisma.auditLog.deleteMany({});
        await prisma.offerRecovery.deleteMany({});
        await prisma.flightOffer.deleteMany({});
        await prisma.searchHistory.deleteMany({});
        await prisma.airport.deleteMany({});
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
                email: 'analyticsuser@example.com',
                password: 'Password123!',
                status: 'ACTIVE',
            },
        });
        userId = user.id;
        jwtToken = jwtService.sign({ id: user.id, email: user.email }, { expiresIn: '24h' });
    });
    describe('History Persistence on Cache Hit/Miss and Cleanup Preservation', () => {
        let sdkSpy;
        const mockDuffelResponse = {
            id: 'or_mock_123',
            slices: [
                {
                    id: 'sli_mock_1',
                    duration: 'PT2H10M',
                    origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
                    destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
                    segments: [
                        {
                            id: 'seg_mock_1',
                            duration: 'PT2H10M',
                            departing_at: '2026-07-15T08:00:00',
                            arriving_at: '2026-07-15T10:10:00',
                            origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
                            destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
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
            offers: [
                {
                    id: 'off_mock_123',
                    total_amount: '125.50',
                    total_currency: 'USD',
                    slices: [
                        {
                            id: 'sli_mock_1',
                            duration: 'PT2H10M',
                            origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
                            destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
                            segments: [
                                {
                                    id: 'seg_mock_1',
                                    duration: 'PT2H10M',
                                    departing_at: '2026-07-15T08:00:00',
                                    arriving_at: '2026-07-15T10:10:00',
                                    origin: { id: 'HAN', name: 'Noi Bai International Airport', iata_code: 'HAN', type: 'airport' },
                                    destination: { id: 'SGN', name: 'Tan Son Nhat International Airport', iata_code: 'SGN', type: 'airport' },
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
                },
            ],
        };
        beforeEach(() => {
            const duffelService = app.get(duffel_service_1.DuffelService);
            sdkSpy = jest.spyOn(duffelService['duffel'].offerRequests, 'create')
                .mockResolvedValue({
                data: mockDuffelResponse,
            });
        });
        afterEach(() => {
            sdkSpy.mockRestore();
        });
        it('should write SearchHistory on both cache miss and cache hit, while not duplicating FlightOffers', async () => {
            // 1. Search 1: Cache Miss
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/flights/search')
                .set('Authorization', `Bearer ${jwtToken}`)
                .send({
                origin: 'HAN',
                destination: 'SGN',
                departureDate: '2026-07-15',
                adults: 1,
            })
                .expect(200);
            expect(res1.body.meta.cached).toBe(false);
            // Verify DB write-behind for search 1
            await waitFor(async () => {
                const historyList = await prisma.searchHistory.findMany({ where: { userId } });
                expect(historyList.length).toBe(1);
                expect(historyList[0].searchHash).toBe(res1.body.meta.searchHash);
                const offers = await prisma.flightOffer.findMany({
                    where: { searchHash: historyList[0].searchHash },
                });
                expect(offers.length).toBe(1);
            });
            // Clear sdkSpy to verify it's not called on cache hit
            sdkSpy.mockClear();
            // 2. Search 2: Cache Hit (Same query)
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/flights/search')
                .set('Authorization', `Bearer ${jwtToken}`)
                .send({
                origin: 'HAN',
                destination: 'SGN',
                departureDate: '2026-07-15',
                adults: 1,
            })
                .expect(200);
            expect(res2.body.meta.cached).toBe(true);
            expect(sdkSpy).not.toHaveBeenCalled();
            // Verify DB write-behind for search 2 (adds another history entry, but no new offers)
            await waitFor(async () => {
                const historyList = await prisma.searchHistory.findMany({ where: { userId } });
                expect(historyList.length).toBe(2);
                const offers = await prisma.flightOffer.findMany({});
                expect(offers.length).toBe(1); // Still 1 offer
            });
        });
        it('should keep SearchHistory indefinitely while purging expired FlightOffers and OfferRecoveries', async () => {
            const now = new Date();
            const expiredDate = new Date(now);
            expiredDate.setDate(now.getDate() - 10); // 10 days ago (expired for 7-day retention)
            const expiredRecoveryDate = new Date(now);
            expiredRecoveryDate.setDate(now.getDate() - 31); // 31 days ago (expired for 30-day retention)
            // Seed expired offer, expired recovery, and expired search history
            const offerId = '77777777-7777-7777-7777-777777777777';
            const searchHash = 'some-expired-hash-val';
            await prisma.searchHistory.create({
                data: {
                    id: '88888888-8888-8888-8888-888888888888',
                    userId,
                    origin: 'HAN',
                    destination: 'SGN',
                    departureDate: now,
                    adults: 1,
                    children: 0,
                    infants: 0,
                    cabinClass: 'economy',
                    resultCount: 1,
                    minPrice: 100.0,
                    maxPrice: 100.0,
                    searchHash,
                    createdAt: expiredDate,
                },
            });
            await prisma.flightOffer.create({
                data: {
                    id: offerId,
                    searchHash,
                    supplierOfferId: 'off_expired_test',
                    rawOffer: {},
                    origin: 'HAN',
                    destination: 'SGN',
                    departureDate: now,
                    adults: 1,
                    children: 0,
                    infants: 0,
                    cabinClass: 'economy',
                    price: 100.0,
                    createdAt: expiredDate,
                },
            });
            await prisma.offerRecovery.create({
                data: {
                    id: offerId,
                    searchHash,
                    createdAt: expiredRecoveryDate,
                },
            });
            // Run cleanup
            await cleanupService.handleCleanup();
            // Verify that FlightOffer and OfferRecovery are purged
            const offers = await prisma.flightOffer.findMany({});
            expect(offers.length).toBe(0);
            const recoveries = await prisma.offerRecovery.findMany({});
            expect(recoveries.length).toBe(0);
            // Verify that SearchHistory is STILL kept indefinitely
            const historyList = await prisma.searchHistory.findMany({});
            expect(historyList.length).toBe(1);
            expect(historyList[0].searchHash).toBe(searchHash);
        });
    });
});
