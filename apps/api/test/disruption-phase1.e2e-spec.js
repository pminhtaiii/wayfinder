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
Object.defineProperty(exports, "__esModule", { value: true });
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
const testing_1 = require("@nestjs/testing");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const client_1 = require("@prisma/client");
const crypto = __importStar(require("crypto"));
describe('Disruption Phase 1 (Schema & Config E2E)', () => {
    let app;
    let prisma;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
    });
    afterAll(async () => {
        await app.close();
    });
    describe('Database Schema Constraints', () => {
        let userId;
        let bookingIntentId;
        let bookingId;
        beforeEach(async () => {
            const suffix = crypto.randomUUID();
            const user = await prisma.user.create({
                data: {
                    email: `test-disruption-user-${suffix}@example.com`,
                    password: 'Password123!',
                    role: 'USER',
                    status: 'ACTIVE',
                },
            });
            userId = user.id;
            const intent = await prisma.bookingIntent.create({
                data: {
                    userId,
                    supplierOfferId: `off_fake_${suffix}`,
                    originalPrice: new client_1.Prisma.Decimal('100.00'),
                    confirmedPrice: new client_1.Prisma.Decimal('100.00'),
                    currency: 'USD',
                    pricedAt: new Date(),
                    origin: 'HAN',
                    destination: 'NRT',
                    departureDate: new Date(),
                    adults: 1,
                    rawOfferSnapshot: {},
                    intentExpiresAt: new Date(Date.now() + 3600000),
                },
            });
            bookingIntentId = intent.id;
            const booking = await prisma.booking.create({
                data: {
                    userId,
                    bookingIntentId,
                    totalAmount: new client_1.Prisma.Decimal('100.00'),
                    currency: 'USD',
                    status: 'CONFIRMED',
                },
            });
            bookingId = booking.id;
        });
        afterEach(async () => {
            await prisma.notificationOutbox.deleteMany({ where: { bookingId } });
            await prisma.itineraryRevisionSegment.deleteMany({ where: { revision: { bookingId } } });
            await prisma.itineraryRevision.deleteMany({ where: { bookingId } });
            await prisma.booking.deleteMany({ where: { id: bookingId } });
            await prisma.bookingIntent.deleteMany({ where: { id: bookingIntentId } });
            await prisma.user.deleteMany({ where: { id: userId } });
        });
        it('should verify disruptionStatus default value is NONE and disruptionNeedsAttention default is false', async () => {
            const b = await prisma.booking.findUnique({ where: { id: bookingId } });
            expect(b?.disruptionStatus).toBe(client_1.DisruptionStatus.NONE);
            expect(b?.disruptionNeedsAttention).toBe(false);
        });
        it('should enforce unique (bookingId, version) constraint on ItineraryRevision', async () => {
            // Create first revision
            const rev1 = await prisma.itineraryRevision.create({
                data: {
                    bookingId,
                    version: 1,
                    source: 'WEBHOOK',
                    fingerprint: 'fp1',
                    isMaterial: false,
                    incrementalDiff: {},
                    cumulativeDiff: {},
                },
            });
            expect(rev1.version).toBe(1);
            // Creating a duplicate version for the same booking must fail
            await expect(prisma.itineraryRevision.create({
                data: {
                    bookingId,
                    version: 1,
                    source: 'RECONCILIATION',
                    fingerprint: 'fp2',
                    isMaterial: true,
                    incrementalDiff: {},
                    cumulativeDiff: {},
                },
            })).rejects.toThrow();
        });
        it('should enforce unique revisionId constraint on NotificationOutbox', async () => {
            const rev = await prisma.itineraryRevision.create({
                data: {
                    bookingId,
                    version: 1,
                    source: 'WEBHOOK',
                    fingerprint: 'fp1',
                    isMaterial: true,
                    incrementalDiff: {},
                    cumulativeDiff: {},
                },
            });
            // Create first outbox entry
            await prisma.notificationOutbox.create({
                data: {
                    bookingId,
                    revisionId: rev.id,
                    type: 'MATERIAL_DISRUPTION',
                    payload: {},
                },
            });
            // Creating a second outbox entry for the same revision must fail
            await expect(prisma.notificationOutbox.create({
                data: {
                    bookingId,
                    revisionId: rev.id,
                    type: 'MATERIAL_DISRUPTION',
                    payload: {},
                },
            })).rejects.toThrow();
        });
    });
    describe('Environment Configuration Validation', () => {
        it('should have safe defaults for disruption feature flags disabled', () => {
            const configService = app.get(config_1.ConfigService);
            expect(configService.get('FEATURE_FLAG_DISRUPTION_INGRESS')).toBe('false');
            expect(configService.get('FEATURE_FLAG_DISRUPTION_PROCESSOR')).toBe('false');
            expect(configService.get('FEATURE_FLAG_DISRUPTION_RECONCILIATION')).toBe('false');
            expect(configService.get('FEATURE_FLAG_DISRUPTION_SURFACING')).toBe('false');
            expect(configService.get('FEATURE_FLAG_DISRUPTION_OUTBOX')).toBe('false');
        });
        it('should validate missing required Stripe secrets', () => {
            const incompleteConfig = {
                PORT: '3001',
            };
            const result = app_module_1.envSchema.safeParse(incompleteConfig);
            expect(result.success).toBe(false);
            if (!result.success) {
                const errorMessages = result.error.errors.map((e) => e.message);
                expect(errorMessages).toContain('STRIPE_SECRET_KEY is required');
                expect(errorMessages).toContain('STRIPE_WEBHOOK_SECRET is required');
            }
        });
        it('should validate with optional DUFFEL_WEBHOOK_SECRET', () => {
            const completeConfig = {
                STRIPE_SECRET_KEY: 'sk_test_123',
                STRIPE_WEBHOOK_SECRET: 'whsec_123',
                DUFFEL_WEBHOOK_SECRET: 'whsec_' + 'duffel_123',
            };
            const result = app_module_1.envSchema.safeParse(completeConfig);
            expect(result.success).toBe(true);
            if (result.success) {
                expect(result.data.DUFFEL_WEBHOOK_SECRET).toBe('whsec_' + 'duffel_123');
                expect(result.data.FEATURE_FLAG_DISRUPTION_INGRESS).toBe('false');
            }
        });
    });
});
