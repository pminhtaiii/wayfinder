process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';

import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { BookingProjectionRepository } from '@/booking-projection/booking-projection.repository';
import { BookingEventPublisherService } from '@/domain-events/booking-event-publisher.service';
import { BookingEventHydratorService } from '@/domain-events/booking-event-hydrator.service';
import { DisruptionService } from '@/disruption/api/disruption.service';
import { SupplierSyncService } from '@/disruption/sync/supplier-sync.service';
import { DuffelRecoveryService } from '@/supplier/order/duffel-recovery.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BookingStatus,
  BookingFailureReason,
  DisruptionStatus,
  ItineraryRevisionSource,
} from '@prisma/client';
import { RefundSettledEvent } from '@/domain-events/refund.events';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import { randomUUID } from 'node:crypto';

function assertDisposableDatabase(): void {
  const databaseUrl = process.env.DATABASE_URL;
  if (
    !databaseUrl ||
    (!/(test|e2e|flight_booking)/i.test(databaseUrl) && process.env.NODE_ENV !== 'test')
  ) {
    throw new Error(
      'Refusing to run E2E booking events suite against non-test database. Ensure DATABASE_URL targets a test/e2e database or NODE_ENV is set to "test".',
    );
  }
}

async function waitForCondition<T>(
  predicate: () => Promise<T | null | undefined | false>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const last = await predicate();
  if (last) return last;
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe('Booking Events & Projection Updates E2E (US2 - T033)', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let moduleFixture: TestingModule;
  let prisma: PrismaService;
  let lifecycleService: BookingLifecycleService;
  let projectionRepo: BookingProjectionRepository;
  let publisher: BookingEventPublisherService;
  let eventEmitter: EventEmitter2;
  let hydrator: BookingEventHydratorService;
  let disruptionService: DisruptionService;
  let supplierSyncService: SupplierSyncService;
  let duffelRecoveryService: DuffelRecoveryService;

  const createdUserIds: string[] = [];
  const createdIntentIds: string[] = [];
  const createdBookingIds: string[] = [];

  const sampleFlightSnapshot: FlightSnapshot = {
    segments: [
      {
        airline: { name: 'Delta Air Lines', iataCode: 'DL' },
        departureAirport: { iataCode: 'JFK', name: 'John F Kennedy Intl', city: 'New York' },
        arrivalAirport: { iataCode: 'LHR', name: 'London Heathrow', city: 'London' },
        departureAt: new Date(Date.now() + 86400000).toISOString(),
        arrivalAt: new Date(Date.now() + 86400000 + 7 * 3600000).toISOString(),
        duration: 'PT7H',
        flightNumber: 'DL100',
      },
    ],
    totalDuration: 'PT7H',
    stops: 0,
    cabinClass: 'economy',
  };

  const samplePassengerSnapshot: PassengerSnapshot = {
    passengers: [
      {
        type: 'ADULT',
        firstName: 'John',
        lastName: 'Doe',
      },
    ],
    contactEmail: 'john.doe@example.com',
  };

  beforeAll(async () => {
    assertDisposableDatabase();

    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    lifecycleService = moduleFixture.get<BookingLifecycleService>(BookingLifecycleService);
    projectionRepo = moduleFixture.get<BookingProjectionRepository>(BookingProjectionRepository);
    publisher = moduleFixture.get<BookingEventPublisherService>(BookingEventPublisherService);
    eventEmitter = moduleFixture.get<EventEmitter2>(EventEmitter2);
    hydrator = moduleFixture.get<BookingEventHydratorService>(BookingEventHydratorService);
    disruptionService = moduleFixture.get<DisruptionService>(DisruptionService);
    supplierSyncService = moduleFixture.get<SupplierSyncService>(SupplierSyncService);
    duffelRecoveryService = moduleFixture.get<DuffelRecoveryService>(DuffelRecoveryService);
  });

  afterAll(async () => {
    try {
      if (prisma) {
        if (createdBookingIds.length > 0) {
          await prisma.bookingAgentProjection.deleteMany({
            where: { bookingId: { in: createdBookingIds } },
          });
          await prisma.itineraryRevisionSegment.deleteMany({
            where: { revision: { bookingId: { in: createdBookingIds } } },
          });
          await prisma.itineraryRevision.deleteMany({
            where: { bookingId: { in: createdBookingIds } },
          });
          await prisma.disruptionAuditEvent.deleteMany({
            where: { bookingId: { in: createdBookingIds } },
          });
          await prisma.booking.deleteMany({
            where: { id: { in: createdBookingIds } },
          });
        }
        if (createdIntentIds.length > 0) {
          await prisma.bookingIntent.deleteMany({
            where: { id: { in: createdIntentIds } },
          });
        }
        if (createdUserIds.length > 0) {
          await prisma.user.deleteMany({
            where: { id: { in: createdUserIds } },
          });
        }
      }
    } catch (cleanupError) {
      console.warn('Teardown cleanup error:', cleanupError);
    } finally {
      if (app) {
        await app.close();
      }
      if (prisma) {
        await prisma.$disconnect();
      }
    }
  });

  async function createTestUser() {
    const id = `usr_${randomUUID()}`;
    const user = await prisma.user.create({
      data: {
        id,
        email: `${id}@example.com`,
        password: 'dummy_password',
        role: 'USER',
      },
    });
    createdUserIds.push(user.id);
    return user;
  }

  async function createTestBookingIntent(userId: string) {
    const id = `intent_${randomUUID()}`;
    const intent = await prisma.bookingIntent.create({
      data: {
        id,
        userId,
        // Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
        supplierOfferId: `off_${randomUUID()}`,
        originalPrice: 450.0,
        confirmedPrice: 450.0,
        currency: 'GBP',
        pricedAt: new Date(),
        origin: 'JFK',
        destination: 'LHR',
        departureDate: new Date('2026-10-01'),
        adults: 1,
        rawOfferSnapshot: {
          segments: [
            {
              departureAirport: { iataCode: 'JFK', name: 'John F Kennedy Intl', city: 'New York' },
              arrivalAirport: { iataCode: 'LHR', name: 'London Heathrow', city: 'London' },
              departureAt: new Date(Date.now() + 86400000).toISOString(),
              arrivalAt: new Date(Date.now() + 86400000 + 7 * 3600000).toISOString(),
              airline: { name: 'Delta Air Lines' },
              operatingCarrierName: 'Delta Air Lines',
              flightNumber: 'DL100',
            },
          ],
        },
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });
    createdIntentIds.push(intent.id);
    return intent;
  }

  async function createTestItineraryRevision(
    bookingId: string,
    version = 1,
    departureAt = new Date(Date.now() + 86400000),
    arrivalAt = new Date(Date.now() + 86400000 + 7 * 3600000),
    origin = 'JFK',
    destination = 'LHR',
  ) {
    const revId = `rev_${randomUUID()}`;
    return prisma.itineraryRevision.create({
      data: {
        id: revId,
        bookingId,
        version,
        source: ItineraryRevisionSource.BOOTSTRAP,
        fingerprint: `fp_${randomUUID()}`,
        isMaterial: false,
        materialReasons: [],
        materialBaselines: [],
        incrementalDiff: {},
        cumulativeDiff: {},
        rulesetVersion: 'disruption-v1',
        segments: {
          create: [
            {
              id: `seg_${randomUUID()}`,
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
              marketingCarrierIata: 'DL',
              airlineName: 'Delta Air Lines',
              flightNumber: 'DL100',
              departureAirportIata: origin,
              departureAirportName: `${origin} Airport`,
              departureCity: origin,
              departureAt,
              departureLocalDate: departureAt,
              arrivalAirportIata: destination,
              arrivalAirportName: `${destination} Airport`,
              arrivalCity: destination,
              arrivalAt,
              arrivalLocalDate: arrivalAt,
              durationMinutes: 420,
            },
          ],
        },
      },
    });
  }

  describe('a. Creation, Confirmation, Failure, Completion Transitions', () => {
    it('booking.created: projects hydrated state into BookingAgentProjection with status PROCESSING and version 1', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_created_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      const booking = await lifecycleService.createBooking(user.id, bookingId, intent.id);
      expect(booking.id).toBe(bookingId);
      expect(booking.status).toBe(BookingStatus.PROCESSING);
      expect(booking.version).toBe(1);

      const projection = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('PROCESSING');
      expect(projection!.sourceVersion).toBe(1);
      expect(projection!.origin).toBe('JFK');
      expect(projection!.destination).toBe('LHR');
      expect(projection!.airline).toBe('Delta Air Lines');
      expect(projection!.flightNumber).toBe('DL100');
      expect(projection!.agentReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);
    });

    it('booking.confirmed: updates projection status to CONFIRMED and increments sourceVersion', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_conf_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      const confirmed = await lifecycleService.confirmBooking(
        bookingId,
        'PNR_CONF_1',
        'ORD_CONF_1',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );
      expect(confirmed.status).toBe(BookingStatus.CONFIRMED);
      expect(confirmed.version).toBe(2);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('CONFIRMED');
      expect(projection!.sourceVersion).toBe(2);
    });

    it('booking.failed: updates projection status to FAILED and increments sourceVersion', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_fail_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      const failed = await lifecycleService.failBooking(
        bookingId,
        BookingFailureReason.CAPTURE_FAILED,
      );
      expect(failed.status).toBe(BookingStatus.FAILED);
      expect(failed.version).toBe(2);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('FAILED');
      expect(projection!.sourceVersion).toBe(2);
    });

    it('booking.completed: updates projection status to COMPLETED and increments sourceVersion', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_comp_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      // Confirm booking with departure in the past so checkAndCompleteBooking completes it
      const pastDeparture = new Date(Date.now() - 3600000 * 2);
      const pastArrival = new Date(Date.now() - 3600000);
      const pastFlightSnapshot: FlightSnapshot = {
        segments: [
          {
            airline: { name: 'Delta Air Lines', iataCode: 'DL' },
            departureAirport: { iataCode: 'JFK', name: 'John F Kennedy', city: 'New York' },
            arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
            departureAt: pastDeparture.toISOString(),
            arrivalAt: pastArrival.toISOString(),
            duration: 'PT7H',
            flightNumber: 'DL100',
          },
        ],
        totalDuration: 'PT7H',
        stops: 0,
        cabinClass: 'economy',
      };

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_PAST',
        'ORD_PAST',
        pastFlightSnapshot,
        samplePassengerSnapshot,
      );

      await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      // Complete booking
      const completed = await lifecycleService.completeBooking(bookingId);
      expect(completed.status).toBe(BookingStatus.COMPLETED);
      expect(completed.version).toBe(3);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 3 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('COMPLETED');
      expect(projection!.sourceVersion).toBe(3);
    });
  });

  describe('b. Recovery Outcomes', () => {
    it('recordRecoveryOutcome: emits booking.recovery.resolved and updates projection accurately', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_rec_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      const recovered = await lifecycleService.recordRecoveryOutcome(bookingId, 'CONFIRMED', {
        pnrReference: 'PNR_REC_1',
        // Approved 2026-10-03: this internal recovery detail uses the neutral Prisma identity; historical metadata stays unchanged.
        supplierOrderId: 'ORD_REC_1',
        recoveryOutcome: 'CONFIRMED_AFTER_PROCESSING',
        flightSnapshot: sampleFlightSnapshot,
        passengerSnapshot: samplePassengerSnapshot,
      });

      expect(recovered.status).toBe(BookingStatus.CONFIRMED);
      expect(recovered.version).toBe(2);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('CONFIRMED');
      expect(projection!.sourceVersion).toBe(2);
    });
  });

  describe('c. Cancellation Claims & Finalization', () => {
    it('claimCancellation: emits booking.cancellation.pending and updates projection status to CANCELLATION_PENDING', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_canc_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_CANC',
        'ORD_CANC',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      const claimResult = await lifecycleService.claimCancellation(bookingId, user.id);
      expect(claimResult.count).toBe(1);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 3 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('CANCELLATION_PENDING');
      expect(projection!.sourceVersion).toBe(3);
    });

    it('cancelBooking: emits booking.cancelled and updates projection status to CANCELLED_NO_REFUND', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_canc_fin_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_FIN',
        'ORD_FIN',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      await lifecycleService.claimCancellation(bookingId, user.id);
      await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 3 ? p : null;
      });

      const cancelResult = await lifecycleService.cancelBooking(
        bookingId,
        BookingStatus.CANCELLED_NO_REFUND,
        '0.00',
      );
      expect(cancelResult.count).toBe(1);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 4 ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('CANCELLED_NO_REFUND');
      expect(projection!.sourceVersion).toBe(4);
    });
  });

  describe('d. Supplier Revision Sync & Disruption', () => {
    it('SupplierSyncService: emits booking.disruption.synced and updates projection with updated revision details', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_disr_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_DISR',
        'ORD_DISR',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });

      const newDeparture = new Date(Date.now() + 172800000);
      const newArrival = new Date(Date.now() + 172800000 + 8 * 3600000);
      const duffelSpy = jest
        .spyOn(duffelRecoveryService, 'retrieveCompleteOrder')
        .mockResolvedValueOnce({
          id: 'ORD_DISR',
          slices: [
            {
              id: 'sli_disr',
              duration: 'PT8H',
              segments: [
                {
                  id: 'seg_disr',
                  departing_at: newDeparture.toISOString(),
                  arriving_at: newArrival.toISOString(),
                  origin: { iata_code: 'JFK', name: 'John F Kennedy Intl', city_name: 'New York' },
                  destination: { iata_code: 'CDG', name: 'Charles de Gaulle', city_name: 'Paris' },
                  operating_carrier: { iata_code: 'DL', name: 'Delta Air Lines' },
                  marketing_carrier: { iata_code: 'DL', name: 'Delta Air Lines' },
                  marketing_carrier_flight_number: '100',
                  duration: 'PT8H',
                  passengers: [{ cabin_class: 'economy' }],
                },
              ],
            },
          ],
          passengers: [],
        });

      const syncResult = await supplierSyncService.syncBooking(bookingId, 'WEBHOOK');
      expect(syncResult.status).toBe('REVISION_CREATED');
      duffelSpy.mockRestore();

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 3 && p.destination === 'CDG' ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.sourceVersion).toBe(3);
      expect(projection!.destination).toBe('CDG');
      expect(new Date(projection!.departureAt).getTime()).toBe(newDeparture.getTime());
    });

    it('DisruptionService: emits booking.disruption.acknowledged and updates projection', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_disr_ack_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_ACK',
        'ORD_ACK',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      const rev = await createTestItineraryRevision(bookingId, 1);

      // Set booking to DETECTED disruption status with activeDisruptionRevision
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          disruptionStatus: DisruptionStatus.DETECTED,
          activeDisruptionRevisionId: rev.id,
        },
      });

      await disruptionService.acknowledgeDisruption(bookingId, rev.id, user.id);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking!.disruptionStatus).toBe(DisruptionStatus.ACKNOWLEDGED);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion >= 3 ? p : null;
      });

      expect(projection).toBeDefined();
    });

    it('DisruptionService: emits booking.disruption.accepted and updates projection', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_disr_acc_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_ACC',
        'ORD_ACC',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      const rev = await createTestItineraryRevision(bookingId, 1);

      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          disruptionStatus: DisruptionStatus.ACKNOWLEDGED,
          activeDisruptionRevisionId: rev.id,
        },
      });

      await disruptionService.acceptDisruption(bookingId, rev.id, user.id);

      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking!.disruptionStatus).toBe(DisruptionStatus.RESOLVED);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion >= 3 ? p : null;
      });

      expect(projection).toBeDefined();
    });
  });

  describe('e. Refunds & Emission Isolation', () => {
    it('updateBookingRefundStatus: emits booking.refund.updated and updates projection', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_ref_state_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      // Move booking to CANCELLED_PENDING_REFUND
      await prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          version: { increment: 1 },
        },
      });

      const refundResult = await lifecycleService.updateBookingRefundStatus(
        bookingId,
        BookingStatus.CANCELLED_AND_REFUNDED,
        'SUCCEEDED',
      );
      expect(refundResult.count).toBe(1);

      const projection = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.status === 'CANCELLED_AND_REFUNDED' ? p : null;
      });

      expect(projection).toBeDefined();
      expect(projection!.status).toBe('CANCELLED_AND_REFUNDED');
      expect(projection!.sourceVersion).toBe(3);
    });

    it('emitting refund.settled directly on EventEmitter2 does NOT cause a false projection update', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_ref_settled_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      const initialProj = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });
      expect(initialProj).toBeDefined();
      const initialVersion = initialProj!.sourceVersion;
      const initialUpdatedAt = initialProj!.updatedAt.getTime();

      // Emit refund.settled event directly
      eventEmitter.emit(
        'refund.settled',
        new RefundSettledEvent({
          eventId: randomUUID(),
          refundId: `ref_${randomUUID()}`,
          amount: 45000,
          currency: 'GBP',
          bookingId,
        }),
      );

      // Bounded wait to ensure no subscriber falsely updated the projection
      await new Promise((r) => setTimeout(r, 400));

      const projAfter = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      expect(projAfter!.sourceVersion).toBe(initialVersion);
      expect(projAfter!.status).toBe(initialProj!.status);
      expect(projAfter!.updatedAt.getTime()).toBe(initialUpdatedAt);
    });
  });

  describe('f. Rollbacks & No-Ops', () => {
    it('asserts zero projection writes occur on a rolled-back transaction', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_rollback_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      const publishSpy = jest.spyOn(publisher, 'publish');

      await expect(
        prisma.$transaction(async (tx) => {
          const context = publisher.createContext(tx);
          await lifecycleService.createBooking(user.id, bookingId, intent.id, undefined, context);
          throw new Error('Simulated atomic transaction failure');
        }),
      ).rejects.toThrow('Simulated atomic transaction failure');

      // Assert zero events published
      expect(publishSpy).not.toHaveBeenCalled();
      publishSpy.mockRestore();

      // Verify no booking was created
      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingId } });
      expect(dbBooking).toBeNull();

      // Bounded wait to verify zero projection was written
      await new Promise((r) => setTimeout(r, 300));
      const projection = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      expect(projection).toBeNull();
    });

    it('asserts zero version increments and no events on no-op idempotent re-execution', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_noop_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      // First execution
      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      const initialProj = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });
      expect(initialProj).toBeDefined();
      expect(initialProj!.sourceVersion).toBe(1);

      // Replayed execution with same parameters
      const replayed = await lifecycleService.createBooking(user.id, bookingId, intent.id);
      expect(replayed.id).toBe(bookingId);
      expect(replayed.version).toBe(1);

      await new Promise((r) => setTimeout(r, 300));

      const projAfter = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      expect(projAfter!.sourceVersion).toBe(1);
      expect(projAfter!.updatedAt.getTime()).toBe(initialProj!.updatedAt.getTime());
    });
  });

  describe('g. Out-of-Order / Replay Fencing', () => {
    it('verifies projection is NOT overwritten when an event/upsert with older sourceVersion arrives', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_fencing_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      // Advance to confirmed (version 2)
      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_FENCE',
        'ORD_FENCE',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      const v2Proj = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });
      expect(v2Proj!.status).toBe('CONFIRMED');

      // Attempt to upsert older version 1 with FAILED status
      const staleOutcome = await projectionRepo.upsertGuarded({
        bookingId,
        status: BookingStatus.FAILED,
        sourceVersion: 1,
        origin: 'OLD',
        destination: 'OLD',
      });
      expect(staleOutcome.outcome).toBe('STALE_IGNORED');

      // Verify projection remains CONFIRMED at version 2
      const currentProj = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      expect(currentProj!.sourceVersion).toBe(2);
      expect(currentProj!.status).toBe('CONFIRMED');
      expect(currentProj!.origin).toBe('JFK');
    });

    it('reverse hydration: coherent snapshot is fetched accurately even when re-hydrating version states', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_rev_hyd_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });

      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_REV_HYD',
        'ORD_REV_HYD',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );

      const snapshot = await hydrator.hydrate(bookingId, 2);
      expect(snapshot).toBeDefined();
      expect(snapshot!.version).toBe(2);
      expect(snapshot!.status).toBe(BookingStatus.CONFIRMED);
    });
  });

  describe('h. Stable References', () => {
    it('verifies agentReference generated on initial projection creation remains identical across subsequent updates', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_stable_ref_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      // 1. Initial creation
      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      const initialProj = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });
      expect(initialProj).toBeDefined();
      const stableReference = initialProj!.agentReference;
      expect(stableReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);

      // 2. Confirm booking
      await lifecycleService.confirmBooking(
        bookingId,
        'PNR_STABLE',
        'ORD_STABLE',
        sampleFlightSnapshot,
        samplePassengerSnapshot,
      );
      const confirmedProj = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 2 ? p : null;
      });
      expect(confirmedProj!.agentReference).toBe(stableReference);

      // 3. Cancellation claim
      await lifecycleService.claimCancellation(bookingId, user.id);
      const cancelClaimProj = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 3 ? p : null;
      });
      expect(cancelClaimProj!.agentReference).toBe(stableReference);

      // 4. Final cancellation
      await lifecycleService.cancelBooking(
        bookingId,
        BookingStatus.CANCELLED_NO_REFUND,
        '0.00',
      );
      const cancelledProj = await waitForCondition(async () => {
        const p = await prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
        return p && p.sourceVersion === 4 ? p : null;
      });
      expect(cancelledProj!.agentReference).toBe(stableReference);
    });

    it('concurrent insertion preserves winner agentReference and format integrity', async () => {
      const user = await createTestUser();
      const intent = await createTestBookingIntent(user.id);
      const bookingId = `bk_conc_ins_${randomUUID()}`;
      createdBookingIds.push(bookingId);

      await lifecycleService.createBooking(user.id, bookingId, intent.id);
      const initialProj = await waitForCondition(async () => {
        return prisma.bookingAgentProjection.findUnique({ where: { bookingId } });
      });
      expect(initialProj).toBeDefined();

      const candidateA = `bkref_a_${randomUUID()}`;
      const candidateB = `bkref_b_${randomUUID()}`;

      await Promise.all([
        projectionRepo.upsertGuarded({
          bookingId,
          status: 'PROCESSING',
          sourceVersion: 1,
          agentReference: candidateA,
          origin: 'SGN',
          destination: 'HAN',
        }),
        projectionRepo.upsertGuarded({
          bookingId,
          status: 'PROCESSING',
          sourceVersion: 1,
          agentReference: candidateB,
          origin: 'SGN',
          destination: 'HAN',
        }),
      ]);

      const finalProj = await prisma.bookingAgentProjection.findUnique({
        where: { bookingId },
      });
      expect(finalProj).toBeDefined();
      expect(finalProj!.agentReference).toBe(initialProj!.agentReference);
      expect(finalProj!.agentReference).toMatch(/^bkref_[0-9a-fA-F-]+$/);
    });
  });
});
