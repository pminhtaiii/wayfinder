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
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const duffel_service_1 = require("@/duffel/duffel.service");
const supplier_sync_service_1 = require("@/disruption/sync/supplier-sync.service");
const client_1 = require("@prisma/client");
const crypto = __importStar(require("crypto"));
describe('Disruption Phase 3 (Sync & Concurrency E2E)', () => {
    let app;
    let prisma;
    let supplierSyncService;
    let mockDuffelService;
    let userId;
    let bookingIntentId;
    let bookingId;
    let suffix;
    beforeAll(async () => {
        mockDuffelService = {
            retrieveCompleteOrder: jest.fn(),
        };
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        })
            .overrideProvider(duffel_service_1.DuffelService)
            .useValue(mockDuffelService)
            .compile();
        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(new common_1.ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        supplierSyncService = moduleFixture.get(supplier_sync_service_1.SupplierSyncService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        suffix = crypto.randomUUID();
        jest.clearAllMocks();
        const user = await prisma.user.create({
            data: {
                email: `test-sync-e2e-user-${suffix}@example.com`,
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
                supplierOrderId: `ord_fake_${suffix}`,
                flightSnapshot: {
                    stops: 0,
                    cabinClass: 'economy',
                    totalDuration: 'PT2H',
                    segments: [
                        {
                            airline: { name: 'Japan Airlines', iataCode: 'JL' },
                            flightNumber: '752',
                            departureAirport: { name: 'Noi Bai', iataCode: 'HAN', city: 'Hanoi', terminal: 'T2' },
                            arrivalAirport: { name: 'Narita', iataCode: 'NRT', city: 'Tokyo', terminal: 'T2' },
                            departureAt: '2026-08-01T12:00:00Z',
                            arrivalAt: '2026-08-01T19:00:00Z',
                            duration: 'PT7H',
                            aircraftType: 'Boeing 787',
                            duffelSegmentId: `seg_orig_${suffix}`,
                            sliceOrder: 0,
                            segmentOrder: 0,
                            globalOrder: 0,
                        },
                    ],
                },
            },
        });
        bookingId = booking.id;
    });
    afterEach(async () => {
        await prisma.notificationOutbox.deleteMany({ where: { bookingId } });
        await prisma.disruptionAuditEvent.deleteMany({ where: { bookingId } });
        await prisma.itineraryRevisionSegment.deleteMany({ where: { revision: { bookingId } } });
        await prisma.itineraryRevision.deleteMany({ where: { bookingId } });
        await prisma.booking.deleteMany({ where: { id: bookingId } });
        await prisma.bookingIntent.deleteMany({ where: { id: bookingIntentId } });
        await prisma.user.deleteMany({ where: { id: userId } });
    });
    it('should run a complete material sync and create outbox/audit/revision rows end-to-end', async () => {
        // 3 hours later move (material)
        mockDuffelService.retrieveCompleteOrder.mockResolvedValue({
            id: `ord_fake_${suffix}`,
            slices: [
                {
                    id: 'sli_1',
                    segments: [
                        {
                            id: `seg_orig_${suffix}`,
                            departing_at: '2026-08-01T15:00:00Z',
                            arriving_at: '2026-08-01T22:00:00Z',
                            origin: { iata_code: 'HAN', name: 'Noi Bai' },
                            destination: { iata_code: 'NRT', name: 'Narita' },
                            operating_carrier: { iata_code: 'JL', name: 'Japan Airlines' },
                            marketing_carrier_flight_number: '752',
                        },
                    ],
                },
            ],
            passengers: [],
        });
        const result = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
        expect(result.status).toBe('REVISION_CREATED');
        // Retrieve database state to confirm end-to-end updates
        const dbBooking = await prisma.booking.findUnique({
            where: { id: bookingId },
            include: {
                itineraryRevisions: {
                    include: { segments: true },
                },
                notificationOutbox: true,
                disruptionAuditEvents: true,
            },
        });
        expect(dbBooking?.disruptionStatus).toBe(client_1.DisruptionStatus.DETECTED);
        expect(dbBooking?.activeDisruptionRevisionId).toBe(dbBooking?.itineraryRevisions[0].id);
        // Timing fields should be updated to matches new segments
        expect(dbBooking?.currentDepartureAt?.toISOString()).toBe('2026-08-01T15:00:00.000Z');
        expect(dbBooking?.currentFinalArrivalAt?.toISOString()).toBe('2026-08-01T22:00:00.000Z');
        // Revision checks
        expect(dbBooking?.itineraryRevisions.length).toBe(1);
        const rev = dbBooking?.itineraryRevisions[0];
        expect(rev?.isMaterial).toBe(true);
        expect(rev?.version).toBe(1);
        expect(rev?.segments.length).toBe(1);
        expect(rev?.segments[0].flightNumber).toBe('752');
        expect(rev?.segments[0].departureAirportIata).toBe('HAN');
        // Outbox checks
        expect(dbBooking?.notificationOutbox.length).toBe(1);
        expect(dbBooking?.notificationOutbox[0].revisionId).toBe(rev?.id);
        expect(dbBooking?.notificationOutbox[0].status).toBe('PENDING');
        // Audit events checks
        const auditEvents = dbBooking?.disruptionAuditEvents || [];
        expect(auditEvents.length).toBeGreaterThanOrEqual(1);
        expect(auditEvents.some((e) => e.action === 'DETECTED')).toBe(true);
    });
});
