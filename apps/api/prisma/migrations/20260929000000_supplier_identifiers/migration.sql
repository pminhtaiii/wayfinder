ALTER TABLE "bookings" RENAME COLUMN "duffelOrderId" TO "supplierOrderId";
ALTER TABLE "bookings" RENAME COLUMN "duffelCancellationQuoteId" TO "supplierCancellationQuoteId";
ALTER TABLE "bookings" RENAME COLUMN "lastDuffelSyncedAt" TO "lastSupplierSyncedAt";
ALTER TABLE "bookings" RENAME COLUMN "nextDuffelSyncAt" TO "nextSupplierSyncAt";
ALTER TABLE "booking_intents" RENAME COLUMN "duffelOfferId" TO "supplierOfferId";
ALTER TABLE "booking_intent_passengers" RENAME COLUMN "duffelPassengerId" TO "supplierPassengerId";
ALTER TABLE "seat_selections" RENAME COLUMN "duffelPassengerId" TO "supplierPassengerId";
ALTER TABLE "baggage_selections" RENAME COLUMN "duffelPassengerId" TO "supplierPassengerId";
ALTER TABLE "flight_offers" RENAME COLUMN "duffelOfferId" TO "supplierOfferId";
ALTER TABLE "itinerary_revision_segments" RENAME COLUMN "duffelSegmentId" TO "supplierSegmentId";
ALTER TABLE "chat_handoffs" RENAME COLUMN "duffelOfferIdHash" TO "supplierOfferIdHash";

ALTER INDEX "bookings_duffelOrderId_idx" RENAME TO "bookings_supplierOrderId_idx";
ALTER INDEX "bookings_status_nextUnflownDepartureAt_lastDuffelSyncedAt_idx" RENAME TO "bookings_status_nextUnflownDepartureAt_lastSupplierSyncedAt_idx";
ALTER INDEX "booking_intent_passengers_intentId_duffelPassengerId_idx" RENAME TO "booking_intent_passengers_intentId_supplierPassengerId_idx";
ALTER INDEX "flight_offers_searchHash_duffelOfferId_key" RENAME TO "flight_offers_searchHash_supplierOfferId_key";
ALTER INDEX "itinerary_revision_segments_duffelSegmentId_idx" RENAME TO "itinerary_revision_segments_supplierSegmentId_idx";
