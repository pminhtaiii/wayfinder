"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const jwt_1 = require("@nestjs/jwt");
const duffel_service_1 = require("@/duffel/duffel.service");
const audit_service_1 = require("@/audit/audit.service");
const encryption_service_1 = require("@/common/encryption.service");
const booking_intent_cron_1 = require("@/booking-intent/booking-intent.cron");
const client_1 = require("@prisma/client");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
describe('Booking Intent (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let jwtService;
    let duffelService;
    let auditService;
    let encryptionService;
    let cron;
    let userA;
    let tokenA;
    let tokenB;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
        }));
        app.useGlobalFilters(new http_exception_filter_1.HttpExceptionFilter());
        app.setGlobalPrefix('api', { exclude: ['health'] });
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        jwtService = moduleFixture.get(jwt_1.JwtService);
        duffelService = moduleFixture.get(duffel_service_1.DuffelService);
        auditService = moduleFixture.get(audit_service_1.AuditService);
        encryptionService = moduleFixture.get(encryption_service_1.EncryptionService);
        cron = moduleFixture.get(booking_intent_cron_1.BookingIntentCron);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        // Clean tables in dependent order
        await prisma.bookingIntentPassenger.deleteMany({});
        await prisma.bookingIntent.deleteMany({});
        await prisma.travelerProfile.deleteMany({});
        await prisma.flightOffer.deleteMany({});
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
        delete process.env.BOOKING_INTENT_TTL_MINUTES;
        delete process.env.BOOKING_INTENT_GRACE_HOURS;
    });
    async function createMockFlightOffer(data = {}) {
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
                price: new client_1.Prisma.Decimal(100.00),
                currency: 'USD',
                ...data,
            },
        });
    }
    describe('POST /api/bookings/intent', () => {
        it('creates intent with valid passengers (201), encrypts PII, writes audit log, doesn\'t return passport fields', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '125.50',
                    total_currency: 'USD',
                    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                },
            });
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
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
            expect(duffelSpy).toHaveBeenCalledWith('off_duffel_123');
            duffelSpy.mockRestore();
            expect(res.body).toHaveProperty('intentId');
            expect(res.body.status).toBe('PENDING');
            expect(res.body.originalPrice).toBe(100);
            expect(res.body.confirmedPrice).toBe(125.5);
            expect(res.body.priceChanged).toBe(true);
            // Verify response doesn't return passport number or expiry
            expect(res.body.passengers[0]).not.toHaveProperty('passportNumber');
            expect(res.body.passengers[0]).not.toHaveProperty('passportExpiry');
            expect(res.body.passengers[0].preFilledFromProfile).toBe(false);
            // Verify DB records
            const intent = await prisma.bookingIntent.findUnique({
                where: { id: res.body.intentId },
                include: { passengers: true },
            });
            expect(intent).toBeDefined();
            expect(intent.passengers.length).toBe(1);
            expect(intent.passengers[0].position).toBe(0);
            // Verify PII fields are encrypted in the DB
            expect(intent.passengers[0].passportNumber).not.toBe('N123456');
            expect(intent.passengers[0].passportNumber).toContain(':');
            expect(encryptionService.decrypt(intent.passengers[0].passportNumber)).toBe('N123456');
            expect(intent.passengers[0].passportExpiry).not.toBe('2030-01-01');
            expect(intent.passengers[0].passportExpiry).toContain(':');
            expect(encryptionService.decrypt(intent.passengers[0].passportExpiry)).toBe('2030-01-01');
            // Verify audit log entry
            const audit = await prisma.auditLog.findFirst({
                where: { action: 'booking_intent_created' },
            });
            expect(audit).toBeDefined();
            expect(audit.resourceId).toBe(res.body.intentId);
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
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                },
            });
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
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
            expect(intent.passengers[0].nationality).toBe('VN');
            expect(encryptionService.decrypt(intent.passengers[0].passportNumber)).toBe('MYPASSPORT123');
            expect(encryptionService.decrypt(intent.passengers[0].passportExpiry)).toBe('2032-12-31');
        });
        it('rejects creation when infants > adults (400)', async () => {
            const offer = await createMockFlightOffer({ adults: 1, infants: 2 });
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                    },
                    {
                        type: client_1.PassengerType.INFANT,
                        givenName: 'BabyA',
                        familyName: 'Doe',
                        dateOfBirth: '2026-01-01',
                        gender: 'male',
                    },
                    {
                        type: client_1.PassengerType.INFANT,
                        givenName: 'BabyB',
                        familyName: 'Doe',
                        dateOfBirth: '2026-02-02',
                        gender: 'female',
                    },
                ],
            })
                .expect(400);
        });
        it('rejects creation when total passengers > 9 (400)', async () => {
            const offer = await createMockFlightOffer({ adults: 10 });
            const passengers = Array.from({ length: 10 }, (_, i) => ({
                type: client_1.PassengerType.ADULT,
                givenName: `User${i}`,
                familyName: 'Doe',
                dateOfBirth: '1990-01-01',
                gender: 'male',
            }));
            await (0, supertest_1.default)(app.getHttpServer())
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
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'AdultOne',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                    },
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'AdultTwo',
                        familyName: 'Doe',
                        dateOfBirth: '1992-02-02',
                        gender: 'female',
                    },
                ],
            })
                .expect(400);
        });
        it('rolls back intent creation if audit log write fails inside transaction', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                },
            });
            // Force AuditService.createLog to fail
            const auditSpy = jest.spyOn(auditService, 'createLog').mockRejectedValue(new Error('Audit DB Down'));
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
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
            const duffelError = new Error('Offer expired');
            duffelError.status = 410;
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockRejectedValue(duffelError);
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
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
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                duffelOfferId: 'overridden-by-client',
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                    },
                ],
            })
                .expect(400);
        });
    });
    describe('GET /api/bookings/intent/:id', () => {
        it('retrieves own intent (200) and returns decrypted passport fields', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                },
            });
            const createRes = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                        passportNumber: 'N123456',
                        passportExpiry: '2030-01-01',
                    },
                ],
            })
                .expect(201);
            duffelSpy.mockRestore();
            const getRes = await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/bookings/intent/${createRes.body.intentId}`)
                .set('Authorization', `Bearer ${tokenA}`)
                .expect(200);
            expect(getRes.body.passengers[0].passportNumber).toBe('N123456');
            expect(getRes.body.passengers[0].passportExpiry).toBe('2030-01-01');
        });
        it('returns 403 Forbidden when retrieving other user\'s intent', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                },
            });
            const createRes = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                    },
                ],
            })
                .expect(201);
            duffelSpy.mockRestore();
            // Retrieve using User B token
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/bookings/intent/${createRes.body.intentId}`)
                .set('Authorization', `Bearer ${tokenB}`)
                .expect(403);
        });
        it('returns 410 Gone when retrieving an expired intent', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                },
            });
            const createRes = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
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
            const res = await (0, supertest_1.default)(app.getHttpServer())
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
            const res = await (0, supertest_1.default)(app.getHttpServer())
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
            const res = await (0, supertest_1.default)(app.getHttpServer())
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
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                },
            });
            // 1. Default TTL path
            const resDefault = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'John',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
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
            const resCustom = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'Jane',
                        familyName: 'Doe',
                        dateOfBirth: '1992-02-02',
                        gender: 'female',
                    },
                ],
            })
                .expect(201);
            duffelSpy.mockRestore();
            // Verify custom TTL was applied
            const customIntentBefore = await prisma.bookingIntent.findUnique({
                where: { id: resCustom.body.intentId },
            });
            const expectedExpiry = new Date(customIntentBefore.createdAt.getTime() + 10 * 60 * 1000);
            expect(Math.abs(customIntentBefore.intentExpiresAt.getTime() - expectedExpiry.getTime())).toBeLessThan(5000);
            // Artificially age custom intent
            await prisma.bookingIntent.update({
                where: { id: resCustom.body.intentId },
                data: { intentExpiresAt: new Date(Date.now() - 1000) },
            });
            // Trigger Phase 1 Cron
            await cron.handleExpiration();
            // Verify both default and custom are EXPIRED
            const defaultStatus = await prisma.bookingIntent.findUnique({ where: { id: resDefault.body.intentId } });
            const customStatus = await prisma.bookingIntent.findUnique({ where: { id: resCustom.body.intentId } });
            expect(defaultStatus.status).toBe('EXPIRED');
            expect(customStatus.status).toBe('EXPIRED');
            // Verify audit logs written for both
            const auditExpired = await prisma.auditLog.findFirst({
                where: { action: 'booking_intent_expired' },
            });
            expect(auditExpired).toBeDefined();
            expect(auditExpired.metadata.count).toBe(2);
        });
        it('Phase 2 cleanup: hard-deletes EXPIRED intents after grace period (default and custom grace)', async () => {
            const offer = await createMockFlightOffer({ adults: 1 });
            const duffelSpy = jest.spyOn(duffelService['duffel'].offers, 'get').mockResolvedValue({
                data: {
                    id: 'off_duffel_123',
                    total_amount: '100.00',
                    total_currency: 'USD',
                },
            });
            // Create two intents
            const res1 = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'AdultOne',
                        familyName: 'Doe',
                        dateOfBirth: '1990-01-01',
                        gender: 'male',
                    },
                ],
            })
                .expect(201);
            const res2 = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/intent')
                .set('Authorization', `Bearer ${tokenA}`)
                .send({
                flightOfferId: offer.id,
                passengers: [
                    {
                        type: client_1.PassengerType.ADULT,
                        givenName: 'AdultTwo',
                        familyName: 'Doe',
                        dateOfBirth: '1992-02-02',
                        gender: 'female',
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
            await prisma.$executeRaw `UPDATE booking_intents SET "updatedAt" = ${new Date(Date.now() - 25 * 60 * 60 * 1000)} WHERE id = ${res1.body.intentId}`;
            // 2. Age second intent by 6h (should NOT be deleted yet under default 24h grace)
            await prisma.$executeRaw `UPDATE booking_intents SET "updatedAt" = ${new Date(Date.now() - 6 * 60 * 60 * 1000)} WHERE id = ${res2.body.intentId}`;
            // Trigger Phase 2 Cron (default grace)
            await cron.handleHardDelete();
            // Verify only the 25h intent is deleted
            const int1 = await prisma.bookingIntent.findUnique({ where: { id: res1.body.intentId } });
            const int2 = await prisma.bookingIntent.findUnique({ where: { id: res2.body.intentId } });
            expect(int1).toBeNull();
            expect(int2).toBeDefined();
            // Verify cascading passenger deletion for the first intent
            const passengerCount1 = await prisma.bookingIntentPassenger.count({ where: { intentId: res1.body.intentId } });
            expect(passengerCount1).toBe(0);
            // Verify audit log for first deletion
            const auditDeleted1 = await prisma.auditLog.findFirst({
                where: { action: 'booking_intent_deleted' },
                orderBy: { createdAt: 'desc' },
            });
            expect(auditDeleted1).toBeDefined();
            expect(auditDeleted1.metadata.count).toBe(1);
            // Set custom grace to 5h
            process.env.BOOKING_INTENT_GRACE_HOURS = '5';
            // Trigger Phase 2 Cron again
            await cron.handleHardDelete();
            // Verify second intent is now deleted
            const int2After = await prisma.bookingIntent.findUnique({ where: { id: res2.body.intentId } });
            expect(int2After).toBeNull();
            // Verify audit log for second deletion
            const auditDeleted2 = await prisma.auditLog.findFirst({
                where: { action: 'booking_intent_deleted' },
                orderBy: { createdAt: 'desc' },
            });
            expect(auditDeleted2).toBeDefined();
            expect(auditDeleted2.metadata.count).toBe(1);
        });
    });
});
