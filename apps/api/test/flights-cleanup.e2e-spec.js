"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const app_module_1 = require("@/app.module");
const prisma_service_1 = require("@/prisma/prisma.service");
const duffel_cleanup_service_1 = require("@/duffel/duffel-cleanup.service");
describe('Duffel Cleanup Service (E2E)', () => {
    jest.setTimeout(30000);
    let app;
    let prisma;
    let cleanupService;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        await app.init();
        prisma = moduleFixture.get(prisma_service_1.PrismaService);
        cleanupService = moduleFixture.get(duffel_cleanup_service_1.DuffelCleanupService);
    });
    afterAll(async () => {
        await app.close();
    });
    beforeEach(async () => {
        await prisma.flightOffer.deleteMany({});
        await prisma.offerRecovery.deleteMany({});
    });
    it('should clean up expired flight offers and recoveries, keeping new ones', async () => {
        const now = new Date();
        const activeOfferDate = new Date(now);
        const expiredOfferDate = new Date(now);
        expiredOfferDate.setDate(now.getDate() - 8);
        await prisma.flightOffer.createMany({
            data: [
                {
                    id: '11111111-1111-1111-1111-111111111111',
                    searchHash: 'hash-active-offer',
                    supplierOfferId: 'off_active',
                    rawOffer: {},
                    origin: 'SGN',
                    destination: 'HAN',
                    departureDate: now,
                    adults: 1,
                    children: 0,
                    infants: 0,
                    cabinClass: 'economy',
                    price: 150.00,
                    createdAt: activeOfferDate,
                },
                {
                    id: '22222222-2222-2222-2222-222222222222',
                    searchHash: 'hash-expired-offer',
                    supplierOfferId: 'off_expired',
                    rawOffer: {},
                    origin: 'SGN',
                    destination: 'HAN',
                    departureDate: now,
                    adults: 1,
                    children: 0,
                    infants: 0,
                    cabinClass: 'economy',
                    price: 120.00,
                    createdAt: expiredOfferDate,
                },
            ],
        });
        const activeRecoveryDate = new Date(now);
        const expiredRecoveryDate = new Date(now);
        expiredRecoveryDate.setDate(now.getDate() - 31);
        await prisma.offerRecovery.createMany({
            data: [
                {
                    id: '33333333-3333-3333-3333-333333333333',
                    searchHash: 'hash-active-rec',
                    createdAt: activeRecoveryDate,
                },
                {
                    id: '44444444-4444-4444-4444-444444444444',
                    searchHash: 'hash-expired-rec',
                    createdAt: expiredRecoveryDate,
                },
            ],
        });
        await cleanupService.handleCleanup();
        const remainingOffers = await prisma.flightOffer.findMany({});
        expect(remainingOffers.length).toBe(1);
        expect(remainingOffers[0].id).toBe('11111111-1111-1111-1111-111111111111');
        const remainingRecoveries = await prisma.offerRecovery.findMany({});
        expect(remainingRecoveries.length).toBe(1);
        expect(remainingRecoveries[0].id).toBe('33333333-3333-3333-3333-333333333333');
    });
    it('should respect custom retention configurations from environment variables', async () => {
        process.env.FLIGHT_OFFERS_RETENTION_DAYS = '2';
        process.env.OFFER_RECOVERY_RETENTION_DAYS = '5';
        try {
            const now = new Date();
            const offerDate = new Date(now);
            offerDate.setDate(now.getDate() - 3);
            await prisma.flightOffer.create({
                data: {
                    id: '55555555-5555-5555-5555-555555555555',
                    searchHash: 'hash-custom-expired-offer',
                    supplierOfferId: 'off_custom_expired',
                    rawOffer: {},
                    origin: 'SGN',
                    destination: 'HAN',
                    departureDate: now,
                    adults: 1,
                    children: 0,
                    infants: 0,
                    cabinClass: 'economy',
                    price: 200.00,
                    createdAt: offerDate,
                },
            });
            const recoveryDate = new Date(now);
            recoveryDate.setDate(now.getDate() - 6);
            await prisma.offerRecovery.create({
                data: {
                    id: '66666666-6666-6666-6666-666666666666',
                    searchHash: 'hash-custom-expired-rec',
                    createdAt: recoveryDate,
                },
            });
            await cleanupService.handleCleanup();
            const remainingOffers = await prisma.flightOffer.findMany({});
            expect(remainingOffers.length).toBe(0);
            const remainingRecoveries = await prisma.offerRecovery.findMany({});
            expect(remainingRecoveries.length).toBe(0);
        }
        finally {
            delete process.env.FLIGHT_OFFERS_RETENTION_DAYS;
            delete process.env.OFFER_RECOVERY_RETENTION_DAYS;
        }
    });
});
