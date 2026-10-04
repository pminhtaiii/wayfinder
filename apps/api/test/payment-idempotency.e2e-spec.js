"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const jwt_1 = require("@nestjs/jwt");
const stripe_service_1 = require("@/common/stripe.service");
const duffel_service_1 = require("@/duffel/duffel.service");
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
const client_1 = require("@prisma/client");
const crypto = __importStar(require("crypto"));
describe('Payment Idempotency (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let jwtService;
    let stripeService;
    let duffelService;
    let testUser;
    let testToken;
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
        stripeService = moduleFixture.get(stripe_service_1.StripeService);
        duffelService = moduleFixture.get(duffel_service_1.DuffelService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        await prisma.paymentEvent.deleteMany({});
        await prisma.ledgerEntry.deleteMany({});
        await prisma.refund.deleteMany({});
        await prisma.payment.deleteMany({});
        await prisma.idempotencyKey.deleteMany({});
        await prisma.paymentMethod.deleteMany({});
        await prisma.bookingIntentPassenger.deleteMany({});
        await prisma.bookingIntent.deleteMany({});
        await prisma.travelerProfile.deleteMany({});
        await prisma.flightOffer.deleteMany({});
        await prisma.auditLog.deleteMany({});
        await prisma.user.deleteMany({});
        const u = await prisma.user.create({
            data: {
                email: 'idempotency-test@example.com',
                password: 'Password123!',
                status: 'ACTIVE',
            },
        });
        testUser = { id: u.id, email: u.email };
        testToken = jwtService.sign({ id: u.id, email: u.email }, { expiresIn: '24h' });
    });
    afterEach(() => {
        jest.restoreAllMocks();
    });
    async function createFlightOffer() {
        return prisma.flightOffer.create({
            data: {
                searchHash: 'idem-search-hash',
                supplierOfferId: `off_idem_${Date.now()}`,
                rawOffer: {},
                origin: 'SGN',
                destination: 'HAN',
                departureDate: new Date('2026-08-01'),
                adults: 1,
                children: 0,
                infants: 0,
                price: new client_1.Prisma.Decimal(100.0),
                currency: 'USD',
            },
        });
    }
    async function createBookingIntent(userId, flightOfferId) {
        const now = new Date();
        return prisma.bookingIntent.create({
            data: {
                userId,
                flightOfferId,
                supplierOfferId: `off_idem_${Date.now()}`,
                status: 'AWAITING_PAYMENT',
                originalPrice: new client_1.Prisma.Decimal(100.0),
                confirmedPrice: new client_1.Prisma.Decimal(125.5),
                currency: 'USD',
                priceChanged: false,
                pricedAt: now,
                origin: 'SGN',
                destination: 'HAN',
                departureDate: new Date('2026-08-01'),
                cabinClass: 'economy',
                adults: 1,
                children: 0,
                infants: 0,
                rawOfferSnapshot: {},
                intentExpiresAt: new Date(now.getTime() + 3600 * 1000),
                paymentAttemptCount: 0,
                passengers: {
                    create: [
                        {
                            position: 0,
                            type: 'ADULT',
                            givenName: 'John',
                            familyName: 'Doe',
                            dateOfBirth: new Date('1990-01-01'),
                            gender: 'male',
                        },
                    ],
                },
            },
        });
    }
    function mockStripeCreate() {
        jest.spyOn(stripeService, 'createCustomer').mockResolvedValue({
            id: 'cus_idem_mock',
            email: 'idempotency-test@example.com',
        });
        jest.spyOn(stripeService, 'createPaymentIntent').mockResolvedValue({
            id: 'pi_idem_mock',
            client_secret: 'pi_idem_mock_secret',
            status: 'requires_payment_method',
        });
    }
    function computeHash(body) {
        const sorted = sortKeys(body);
        return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
    }
    function sortKeys(obj) {
        if (Array.isArray(obj))
            return obj.map(sortKeys);
        if (obj !== null && typeof obj === 'object') {
            return Object.keys(obj)
                .sort()
                .reduce((acc, key) => {
                acc[key] = sortKeys(obj[key]);
                return acc;
            }, {});
        }
        return obj;
    }
    describe('POST /api/bookings/payment/create - Idempotency', () => {
        it('replays cached response when same idempotency key is used (only 1 Payment in DB)', async () => {
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(testUser.id, offer.id);
            mockStripeCreate();
            const key = 'idem-replay-test-001';
            const first = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', key)
                .send({ bookingIntentId: intent.id, saveCard: false })
                .expect(201);
            expect(first.body.paymentId).toBeDefined();
            expect(first.body.clientSecret).toBe('pi_idem_mock_secret');
            // Second request with same key should replay
            const second = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', key)
                .send({ bookingIntentId: intent.id, saveCard: false })
                .expect(201);
            expect(second.body.paymentId).toBe(first.body.paymentId);
            expect(second.body.clientSecret).toBe(first.body.clientSecret);
            // Only one Payment in DB
            const payments = await prisma.payment.findMany({
                where: { bookingIntentId: intent.id },
            });
            expect(payments.length).toBe(1);
            // Stripe should only have been called once
            expect(stripeService.createPaymentIntent).toHaveBeenCalledTimes(1);
        });
        it('returns 422 when same key is used with different payload', async () => {
            const offer = await createFlightOffer();
            const intentA = await createBookingIntent(testUser.id, offer.id);
            // Create a second booking intent with a different offer
            const offer2 = await prisma.flightOffer.create({
                data: {
                    searchHash: 'idem-search-hash-2',
                    supplierOfferId: `off_idem_2_${Date.now()}`,
                    rawOffer: {},
                    origin: 'SGN',
                    destination: 'DAD',
                    departureDate: new Date('2026-08-15'),
                    adults: 1,
                    children: 0,
                    infants: 0,
                    price: new client_1.Prisma.Decimal(200.0),
                    currency: 'USD',
                },
            });
            const intentB = await createBookingIntent(testUser.id, offer2.id);
            mockStripeCreate();
            const key = 'idem-hash-mismatch-002';
            // First request succeeds
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', key)
                .send({ bookingIntentId: intentA.id, saveCard: false })
                .expect(201);
            // Second request with same key but different payload → 422
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', key)
                .send({ bookingIntentId: intentB.id, saveCard: false })
                .expect(422);
            expect(res.body.message).toContain('Idempotency key reuse with different payload');
        });
        it('returns 400 when Idempotency-Key header is missing', async () => {
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(testUser.id, offer.id);
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .send({ bookingIntentId: intent.id, saveCard: false })
                .expect(400);
        });
    });
    describe('Recovery point resumption - POST /api/bookings/payment/confirm', () => {
        it('resumes from stripe_authorized recovery point', async () => {
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(testUser.id, offer.id);
            // Create idempotency key with recoveryPoint = stripe_authorized
            const idemKeyRecord = await prisma.idempotencyKey.create({
                data: {
                    key: 'idem-recovery-resume-003',
                    requestHash: computeHash({ paymentId: 'will-be-set' }),
                    customerId: testUser.id,
                    requestPath: '/api/bookings/payment/confirm',
                    recoveryPoint: 'stripe_authorized',
                    lockedAt: null,
                    expiresAt: new Date(Date.now() + 86400000),
                },
            });
            // Create a Payment in AUTHORIZED status
            const payment = await prisma.payment.create({
                data: {
                    bookingIntentId: intent.id,
                    attemptNumber: 1,
                    idempotencyKeyId: idemKeyRecord.id,
                    stripePaymentIntentId: `pi_recovery_${Date.now()}`,
                    amount: 12550,
                    currency: 'usd',
                    status: client_1.PaymentStatus.AUTHORIZED,
                    version: 0,
                },
            });
            // Update idempotency key hash to match the confirm request body
            const confirmBody = { paymentId: payment.id };
            await prisma.idempotencyKey.update({
                where: { id: idemKeyRecord.id },
                data: { requestHash: computeHash(confirmBody) },
            });
            // Mock Stripe capture + Duffel order for the resume flow
            jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
                id: payment.stripePaymentIntentId,
                status: 'succeeded',
            });
            jest.spyOn(duffelService, 'createOrder').mockResolvedValue({
                id: `order_${Date.now()}`,
                booking_reference: 'ABC123',
            });
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/confirm')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', 'idem-recovery-resume-003')
                .send(confirmBody);
            // Should succeed or return 202 (pending background work)
            expect([200, 202]).toContain(res.status);
            // Verify recovery point advanced beyond stripe_authorized
            const updatedKey = await prisma.idempotencyKey.findUnique({
                where: { id: idemKeyRecord.id },
            });
            expect(updatedKey).toBeDefined();
            const advancedPoints = ['duffel_order_created', 'captured', 'completed'];
            expect(advancedPoints).toContain(updatedKey.recoveryPoint);
        });
    });
    describe('Stale lock detection', () => {
        it('acquires lock when existing lock is stale (10+ minutes old)', async () => {
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(testUser.id, offer.id);
            mockStripeCreate();
            const key = 'idem-stale-lock-004';
            // Create an idempotency key with a stale lock (10 minutes ago)
            const staleLockedAt = new Date(Date.now() - 10 * 60 * 1000);
            const body = { bookingIntentId: intent.id, saveCard: false };
            await prisma.idempotencyKey.create({
                data: {
                    key,
                    requestHash: computeHash(body),
                    customerId: testUser.id,
                    requestPath: '/api/bookings/payment/create',
                    lockedAt: staleLockedAt,
                    expiresAt: new Date(Date.now() + 86400000),
                },
            });
            // Request with same key should succeed despite stale lock
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/create')
                .set('Authorization', `Bearer ${testToken}`)
                .set('Idempotency-Key', key)
                .send(body)
                .expect(201);
            expect(res.body.paymentId).toBeDefined();
            expect(res.body.clientSecret).toBeDefined();
            // Verify the lock was acquired and then cleared on completion
            const updatedKey = await prisma.idempotencyKey.findUnique({ where: { key } });
            expect(updatedKey).toBeDefined();
            expect(updatedKey.lockedAt).toBeNull();
            expect(updatedKey.responseBody).toBeDefined();
        });
    });
    describe('Missing idempotency key', () => {
        it('returns 400 when Idempotency-Key header is omitted on confirm', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/bookings/payment/confirm')
                .set('Authorization', `Bearer ${testToken}`)
                .send({ paymentId: 'some-id' })
                .expect(400);
        });
    });
});
