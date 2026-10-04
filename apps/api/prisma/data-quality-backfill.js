"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* eslint-disable no-console */
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
async function run() {
    console.log('--- Starting Data Quality Check & Backfill ---');
    const bookings = await prisma.booking.findMany();
    const missingOrderId = [];
    const duplicateMap = new Map();
    const missingSnapshot = [];
    const lackingTimes = [];
    for (const booking of bookings) {
        if (!booking.supplierOrderId) {
            missingOrderId.push(booking.id);
        }
        else {
            const existing = duplicateMap.get(booking.supplierOrderId) || [];
            existing.push(booking.id);
            duplicateMap.set(booking.supplierOrderId, existing);
        }
        if (!booking.flightSnapshot) {
            missingSnapshot.push(booking.id);
        }
        else {
            const snapshot = booking.flightSnapshot;
            if (!snapshot.segments || !Array.isArray(snapshot.segments) || snapshot.segments.length === 0) {
                lackingTimes.push(booking.id);
            }
        }
    }
    const duplicateOrderIdItems = Array.from(duplicateMap.entries())
        .filter(([, ids]) => ids.length > 1)
        .map(([duffelOrderId, ids]) => ({ duffelOrderId, bookingIds: ids }));
    console.log(`Total Bookings: ${bookings.length}`);
    console.log(`Missing Duffel Order ID: ${missingOrderId.length}`);
    console.log(`Duplicate Duffel Order ID Groups: ${duplicateOrderIdItems.length}`);
    console.log(`Missing Flight Snapshot: ${missingSnapshot.length}`);
    console.log(`Bookings lacking segments in snapshot: ${lackingTimes.length}`);
    // Perform backfill
    let backfilledCount = 0;
    const now = new Date();
    for (const booking of bookings) {
        // Only backfill bookings that have a valid snapshot
        if (!booking.flightSnapshot) {
            continue;
        }
        const snapshot = booking.flightSnapshot;
        if (!snapshot.segments || !Array.isArray(snapshot.segments) || snapshot.segments.length === 0) {
            continue;
        }
        const segments = snapshot.segments;
        const firstSegment = segments[0];
        const lastSegment = segments[segments.length - 1];
        const currentDepartureAt = firstSegment.departureAt ? new Date(firstSegment.departureAt) : null;
        const currentFinalArrivalAt = lastSegment.arrivalAt ? new Date(lastSegment.arrivalAt) : null;
        // Find next unflown departure
        let nextUnflownDepartureAt = null;
        for (const seg of segments) {
            if (seg.departureAt) {
                const depTime = new Date(seg.departureAt);
                if (depTime > now) {
                    nextUnflownDepartureAt = depTime;
                    break;
                }
            }
        }
        // Check if backfill updates are needed
        const currentDepTime = booking.currentDepartureAt?.getTime() ?? null;
        const derivedDepTime = currentDepartureAt?.getTime() ?? null;
        const currentArrTime = booking.currentFinalArrivalAt?.getTime() ?? null;
        const derivedArrTime = currentFinalArrivalAt?.getTime() ?? null;
        const currentNextTime = booking.nextUnflownDepartureAt?.getTime() ?? null;
        const derivedNextTime = nextUnflownDepartureAt?.getTime() ?? null;
        const needsUpdate = currentDepTime !== derivedDepTime ||
            currentArrTime !== derivedArrTime ||
            currentNextTime !== derivedNextTime;
        if (needsUpdate) {
            await prisma.booking.update({
                where: { id: booking.id },
                data: {
                    currentDepartureAt,
                    currentFinalArrivalAt,
                    nextUnflownDepartureAt,
                },
            });
            backfilledCount++;
        }
    }
    console.log(`Successfully backfilled timing fields for ${backfilledCount} bookings.`);
    console.log('--- Data Quality Check & Backfill Completed ---');
}
run()
    .catch((err) => {
    console.error('Error during data quality check and backfill:', err);
    process.exit(1);
})
    .finally(async () => {
    await prisma.$disconnect();
});
