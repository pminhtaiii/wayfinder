"use strict";
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
const http_exception_filter_1 = require("@/common/filters/http-exception.filter");
const client_1 = require("@prisma/client");
describe('Payment Webhook (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let jwtService;
    let stripeService;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication({ rawBody: true });
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
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        await prisma.ledgerEntry.deleteMany({});
        await prisma.paymentEvent.deleteMany({});
        await prisma.refund.deleteMany({});
        await prisma.payment.deleteMany({});
        await prisma.idempotencyKey.deleteMany({});
        await prisma.bookingIntentPassenger.deleteMany({});
        await prisma.bookingIntent.deleteMany({});
        await prisma.flightOffer.deleteMany({});
        await prisma.auditLog.deleteMany({});
        await prisma.user.deleteMany({});
    });
    async function createTestUser(overrides = {}) {
        const unique = Date.now() + Math.random();
        return prisma.user.create({
            data: {
                email: `webhook-test-${unique}@example.com`,
                password: 'Password123!',
                status: overrides.status || 'ACTIVE',
                role: overrides.role || 'USER',
            },
        });
    }
    async function createFlightOffer() {
        return prisma.flightOffer.create({
            data: {
                searchHash: 'test-search-hash',
                supplierOfferId: `off_${Date.now()}`,
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
        return prisma.bookingIntent.create({
            data: {
                userId,
                flightOfferId,
                supplierOfferId: `off_${Date.now()}`,
                status: 'AWAITING_PAYMENT',
                originalPrice: new client_1.Prisma.Decimal(100.0),
                confirmedPrice: new client_1.Prisma.Decimal(100.0),
                currency: 'USD',
                priceChanged: false,
                pricedAt: new Date(),
                origin: 'SGN',
                destination: 'HAN',
                departureDate: new Date('2026-08-01'),
                cabinClass: 'economy',
                adults: 1,
                children: 0,
                infants: 0,
                rawOfferSnapshot: {},
                intentExpiresAt: new Date(Date.now() + 3600000),
                paymentAttemptCount: 0,
            },
        });
    }
    async function createIdempotencyKey(userId) {
        return prisma.idempotencyKey.create({
            data: {
                key: `webhook-test-${Date.now()}-${Math.random()}`,
                requestHash: 'test-hash',
                customerId: userId,
                requestPath: '/api/bookings/payment/create',
                expiresAt: new Date(Date.now() + 86400000),
            },
        });
    }
    async function createPayment(bookingIntentId, idempotencyKeyId, overrides = {}) {
        return prisma.payment.create({
            data: {
                bookingIntentId,
                attemptNumber: 1,
                idempotencyKeyId,
                stripePaymentIntentId: `pi_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                amount: 10000,
                currency: 'usd',
                status: client_1.PaymentStatus.CREATED,
                version: 0,
                ...overrides,
            },
        });
    }
    describe('POST /api/payments/webhook', () => {
        it('rejects webhook with invalid signature (400)', async () => {
            const spy = jest
                .spyOn(stripeService, 'constructWebhookEvent')
                .mockImplementation(() => {
                throw new Error('Webhook signature verification failed');
            });
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'invalid_sig')
                .send({ type: 'payment_intent.succeeded', data: { object: {} } })
                .expect(400);
            expect(res.body.message).toContain('signature verification failed');
            spy.mockRestore();
        });
        it('deduplicates webhook events — second delivery is silently handled', async () => {
            const user = await createTestUser();
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(user.id, offer.id);
            const idempotencyKey = await createIdempotencyKey(user.id);
            const payment = await createPayment(intent.id, idempotencyKey.id, {
                status: client_1.PaymentStatus.AUTHORIZED,
            });
            const stripeEventId = `evt_dedup_${Date.now()}`;
            const mockEvent = {
                id: stripeEventId,
                type: 'payment_intent.succeeded',
                data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
            };
            const spy = jest
                .spyOn(stripeService, 'constructWebhookEvent')
                .mockReturnValue(mockEvent);
            // First delivery
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'sig_valid')
                .send(mockEvent)
                .expect(200);
            // Second delivery — same event ID
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'sig_valid')
                .send(mockEvent)
                .expect(200);
            spy.mockRestore();
            // Verify only one PaymentEvent record for this stripeEventId
            const events = await prisma.paymentEvent.findMany({
                where: { stripeEventId },
            });
            expect(events).toHaveLength(1);
        });
        it('payment_intent.succeeded — transitions AUTHORIZED to SUCCEEDED', async () => {
            const user = await createTestUser();
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(user.id, offer.id);
            const idempotencyKey = await createIdempotencyKey(user.id);
            const payment = await createPayment(intent.id, idempotencyKey.id, {
                status: client_1.PaymentStatus.AUTHORIZED,
            });
            const stripeEventId = `evt_succeeded_${Date.now()}`;
            const mockEvent = {
                id: stripeEventId,
                type: 'payment_intent.succeeded',
                data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
            };
            const spy = jest
                .spyOn(stripeService, 'constructWebhookEvent')
                .mockReturnValue(mockEvent);
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'sig_valid')
                .send(mockEvent)
                .expect(200);
            spy.mockRestore();
            // Verify Payment status updated
            const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
            expect(updated.status).toBe(client_1.PaymentStatus.SUCCEEDED);
            // Verify PaymentEvent created
            const event = await prisma.paymentEvent.findFirst({
                where: { paymentId: payment.id, eventType: 'payment_intent.succeeded' },
            });
            expect(event).toBeDefined();
            expect(event.previousStatus).toBe(client_1.PaymentStatus.AUTHORIZED);
            expect(event.newStatus).toBe(client_1.PaymentStatus.SUCCEEDED);
            expect(event.stripeEventId).toBe(stripeEventId);
        });
        it('payment_intent.payment_failed — transitions CREATED to FAILED', async () => {
            const user = await createTestUser();
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(user.id, offer.id);
            const idempotencyKey = await createIdempotencyKey(user.id);
            const payment = await createPayment(intent.id, idempotencyKey.id, {
                status: client_1.PaymentStatus.CREATED,
            });
            const stripeEventId = `evt_failed_${Date.now()}`;
            const mockEvent = {
                id: stripeEventId,
                type: 'payment_intent.payment_failed',
                data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
            };
            const spy = jest
                .spyOn(stripeService, 'constructWebhookEvent')
                .mockReturnValue(mockEvent);
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'sig_valid')
                .send(mockEvent)
                .expect(200);
            spy.mockRestore();
            const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
            expect(updated.status).toBe(client_1.PaymentStatus.FAILED);
            const event = await prisma.paymentEvent.findFirst({
                where: { paymentId: payment.id, eventType: 'payment_intent.payment_failed' },
            });
            expect(event).toBeDefined();
            expect(event.previousStatus).toBe(client_1.PaymentStatus.CREATED);
            expect(event.newStatus).toBe(client_1.PaymentStatus.FAILED);
        });
        it('payment_intent.canceled — transitions AUTHORIZED to CANCELLED', async () => {
            const user = await createTestUser();
            const offer = await createFlightOffer();
            const intent = await createBookingIntent(user.id, offer.id);
            const idempotencyKey = await createIdempotencyKey(user.id);
            const payment = await createPayment(intent.id, idempotencyKey.id, {
                status: client_1.PaymentStatus.AUTHORIZED,
            });
            const stripeEventId = `evt_canceled_${Date.now()}`;
            const mockEvent = {
                id: stripeEventId,
                type: 'payment_intent.canceled',
                data: { object: { id: payment.stripePaymentIntentId, amount: payment.amount } },
            };
            const spy = jest
                .spyOn(stripeService, 'constructWebhookEvent')
                .mockReturnValue(mockEvent);
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/payments/webhook')
                .set('stripe-signature', 'sig_valid')
                .send(mockEvent)
                .expect(200);
            spy.mockRestore();
            const updated = await prisma.payment.findUnique({ where: { id: payment.id } });
            expect(updated.status).toBe(client_1.PaymentStatus.CANCELLED);
            const event = await prisma.paymentEvent.findFirst({
                where: { paymentId: payment.id, eventType: 'payment_intent.canceled' },
            });
            expect(event).toBeDefined();
            expect(event.previousStatus).toBe(client_1.PaymentStatus.AUTHORIZED);
            expect(event.newStatus).toBe(client_1.PaymentStatus.CANCELLED);
        });
    });
});
