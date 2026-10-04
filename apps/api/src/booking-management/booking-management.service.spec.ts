// Approved 2026-10-03: mechanical neutral Prisma fixture key adaptation per test-adaptations-api.md
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { BookingStatus, DisruptionStatus } from '@prisma/client';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { PrismaService } from '@/prisma/prisma.service';
import {
  BookingManagementService,
  parseDuffelCancellationQuoteId,
} from './booking-management.service';

describe('BookingManagementService', () => {
  let service: BookingManagementService;
  let prisma: {
    booking: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
    };
  };
  let bookingLifecycleService: {
    checkAndCompleteBooking: jest.Mock;
  };
  let eventEmitter: {
    emit: jest.Mock;
  };

  const originalEnv = process.env.FEATURE_FLAG_DISRUPTION_SURFACING;

  beforeEach(() => {
    prisma = {
      booking: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    bookingLifecycleService = {
      checkAndCompleteBooking: jest.fn().mockImplementation((booking) => Promise.resolve(booking)),
    };
    eventEmitter = {
      emit: jest.fn(),
    };

    service = new BookingManagementService(
      prisma as never,
      bookingLifecycleService as never,
      eventEmitter as never,
    );
  });

  afterEach(() => {
    process.env.FEATURE_FLAG_DISRUPTION_SURFACING = originalEnv;
    jest.clearAllMocks();
  });

  describe('parseDuffelCancellationQuoteId', () => {
    it('returns nulls for null/undefined/empty string', () => {
      expect(parseDuffelCancellationQuoteId(null)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
      expect(parseDuffelCancellationQuoteId(undefined)).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
      expect(parseDuffelCancellationQuoteId('')).toEqual({
        quoteId: null,
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('handles PENDING_QUOTE', () => {
      expect(parseDuffelCancellationQuoteId('PENDING_QUOTE')).toEqual({
        quoteId: 'PENDING_QUOTE',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses single part quote id', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: null,
        nonRefundableAncillaryAmount: null,
        nonRefundableAncillaryCurrency: null,
      });
    });

    it('parses pipe-separated full quote metadata', () => {
      expect(parseDuffelCancellationQuoteId('can_quo_123|balance|15.00|USD')).toEqual({
        quoteId: 'can_quo_123',
        refundTo: 'balance',
        nonRefundableAncillaryAmount: '15.00',
        nonRefundableAncillaryCurrency: 'USD',
      });
    });
  });

  describe('listBookings', () => {
    const mockBaseBooking = (overrides: Record<string, unknown> = {}) => ({
      id: 'b-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      failureReason: null,
      pnrReference: 'PNR123',
      totalAmount: { toString: () => '350.00' },
      currency: 'USD',
      departureAt: new Date(Date.now() + 86400000),
      createdAt: new Date(),
      flightSnapshot: {
        segments: [
          {
            departureAt: '2026-09-01T10:00:00Z',
            arrivalAt: '2026-09-01T14:00:00Z',
            globalOrder: 1,
          },
        ],
      },
      payment: { id: 'p-1', status: 'SUCCEEDED', stripePaymentIntentId: 'pi-1' },
      bookingIntent: { id: 'bi-1', supplierOfferId: 'off-1' },
      activeDisruptionRevision: null,
      itineraryRevisions: [],
      ...overrides,
    });

    it('queries upcoming bookings with active statuses and departure in the future or null', async () => {
      const b1 = mockBaseBooking({ id: 'b-1', status: BookingStatus.CONFIRMED });
      const b2 = mockBaseBooking({
        id: 'b-2',
        status: BookingStatus.PROCESSING,
        departureAt: null,
      });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      const result = await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          status: {
            in: [
              BookingStatus.PROCESSING,
              BookingStatus.CONFIRMED,
              BookingStatus.CANCELLATION_PENDING,
              BookingStatus.CANCELLED_PENDING_REFUND,
              BookingStatus.FAILED,
            ],
          },
          OR: [{ departureAt: null }, { departureAt: { gt: expect.any(Date) } }],
        },
        include: expect.any(Object),
      });

      expect(result.bookings).toHaveLength(2);
      // PROCESSING has priority 0 over CONFIRMED (priority 2)
      expect(result.bookings[0].id).toBe('b-2');
      expect(result.bookings[1].id).toBe('b-1');
      expect(result.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 2,
        totalPages: 1,
      });
    });

    it('queries past bookings and sorts by departureAt descending', async () => {
      const date1 = new Date('2026-06-01T10:00:00Z');
      const date2 = new Date('2026-07-01T10:00:00Z');
      const b1 = mockBaseBooking({
        id: 'b-older',
        status: BookingStatus.COMPLETED,
        departureAt: date1,
      });
      const b2 = mockBaseBooking({
        id: 'b-newer',
        status: BookingStatus.COMPLETED,
        departureAt: date2,
      });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      const result = await service.listBookings('user-1', 'past', 1, 20);

      expect(prisma.booking.findMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-1',
          OR: [
            {
              status: {
                in: [
                  BookingStatus.COMPLETED,
                  BookingStatus.CANCELLED_AND_REFUNDED,
                  BookingStatus.CANCELLED_NO_REFUND,
                ],
              },
            },
            {
              status: {
                in: [
                  BookingStatus.PROCESSING,
                  BookingStatus.CONFIRMED,
                  BookingStatus.CANCELLATION_PENDING,
                  BookingStatus.CANCELLED_PENDING_REFUND,
                  BookingStatus.FAILED,
                ],
              },
              departureAt: { lte: expect.any(Date) },
            },
          ],
        },
        include: expect.any(Object),
      });

      expect(result.bookings).toHaveLength(2);
      expect(result.bookings[0].id).toBe('b-newer');
      expect(result.bookings[1].id).toBe('b-older');
    });

    it('paginates bookings correctly (page, limit, total, totalPages, slicing)', async () => {
      const bookings = [
        mockBaseBooking({ id: 'b-1', status: BookingStatus.PROCESSING }),
        mockBaseBooking({ id: 'b-2', status: BookingStatus.FAILED }),
        mockBaseBooking({
          id: 'b-3',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date('2026-09-01T10:00:00Z'),
        }),
        mockBaseBooking({
          id: 'b-4',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date('2026-09-02T10:00:00Z'),
        }),
        mockBaseBooking({
          id: 'b-5',
          status: BookingStatus.CONFIRMED,
          departureAt: new Date('2026-09-03T10:00:00Z'),
        }),
      ];

      prisma.booking.findMany.mockResolvedValue(bookings);

      const result = await service.listBookings('user-1', 'upcoming', 2, 2);

      expect(result.pagination).toEqual({
        page: 2,
        limit: 2,
        total: 5,
        totalPages: 3,
      });
      expect(result.bookings).toHaveLength(2);
      expect(result.bookings[0].id).toBe('b-3');
      expect(result.bookings[1].id).toBe('b-4');
    });

    it('emits non-blocking booking.reconciliation.requested for stale PROCESSING bookings only', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000); // 20 mins ago
      const recentDate = new Date(Date.now() - 5 * 60 * 1000); // 5 mins ago

      const staleProcessing = mockBaseBooking({
        id: 'stale-proc',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      const recentProcessing = mockBaseBooking({
        id: 'recent-proc',
        status: BookingStatus.PROCESSING,
        createdAt: recentDate,
      });
      const staleConfirmed = mockBaseBooking({
        id: 'stale-conf',
        status: BookingStatus.CONFIRMED,
        createdAt: staleDate,
      });

      prisma.booking.findMany.mockResolvedValue([
        staleProcessing,
        recentProcessing,
        staleConfirmed,
      ]);

      const result = await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('booking.reconciliation.requested', {
        bookingId: 'stale-proc',
      });
      expect(result.bookings).toHaveLength(3);
    });

    it('delegates completion check to BookingLifecycleService.checkAndCompleteBooking for all bookings', async () => {
      const b1 = mockBaseBooking({ id: 'b-1' });
      const b2 = mockBaseBooking({ id: 'b-2' });

      prisma.booking.findMany.mockResolvedValue([b1, b2]);

      await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledTimes(2);
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(b1);
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(b2);
    });

    it('handles event emission error without throwing or blocking listBookings', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const staleProcessing = mockBaseBooking({
        id: 'stale-proc',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });

      prisma.booking.findMany.mockResolvedValue([staleProcessing]);
      eventEmitter.emit.mockImplementationOnce(() => {
        throw new Error('EventEmitter sync failure');
      });

      const result = await service.listBookings('user-1', 'upcoming', 1, 20);

      expect(eventEmitter.emit).toHaveBeenCalledWith('booking.reconciliation.requested', {
        bookingId: 'stale-proc',
      });
      expect(result.bookings).toHaveLength(1);
      expect(result.bookings[0].id).toBe('stale-proc');
    });
  });

  describe('getBookingDetail', () => {
    const mockDetailBooking = (overrides: Record<string, unknown> = {}) => ({
      id: 'booking-1',
      userId: 'user-1',
      status: BookingStatus.CONFIRMED,
      failureReason: null,
      pnrReference: 'PNRXYZ',
      supplierOrderId: 'ord_123',
      totalAmount: { toString: () => '500.00' },
      currency: 'GBP',
      departureAt: new Date('2026-09-15T08:00:00Z'),
      flightSnapshot: {
        segments: [
          {
            departureAt: '2026-09-15T08:00:00Z',
            arrivalAt: '2026-09-15T11:00:00Z',
            globalOrder: 1,
          },
        ],
      },
      passengerSnapshot: [{ given_name: 'Jane', family_name: 'Doe' }],
      payment: {
        id: 'pay-1',
        status: 'SUCCEEDED',
        stripePaymentIntentId: 'pi_test_123',
        ancillarySelection: null,
      },
      bookingIntent: {
        id: 'intent-1',
        supplierOfferId: 'off_test_123',
        passengers: [{ id: 'pass-1', givenName: 'Jane', familyName: 'Doe' }],
      },
      cancellationDeadline: new Date('2026-09-10T00:00:00Z'),
      cancellationRefundable: true,
      airlineRefundAmount: { toString: () => '400.00' },
      customerRefundAmount: { toString: () => '400.00' },
      supplierCancellationQuoteId: 'can_quo_789|balance|25.00|GBP',
      createdAt: new Date('2026-08-01T10:00:00Z'),
      updatedAt: new Date('2026-08-02T10:00:00Z'),
      disruptionStatus: null,
      activeDisruptionRevision: null,
      itineraryRevisions: [],
      ...overrides,
    });

    it('throws NotFoundException if booking not found', async () => {
      prisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.getBookingDetail('non-existent', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws ForbiddenException if userId does not match', async () => {
      prisma.booking.findUnique.mockResolvedValue(mockDetailBooking({ userId: 'another-user' }));

      await expect(service.getBookingDetail('booking-1', 'user-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('preserves legacy snapshot identity in the original itinerary', async (): Promise<void> => {
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'false';

      const legacySnapshot = {
        segments: [
          {
            airline: { name: 'Northwind Air', iataCode: 'NW' },
            flightNumber: 'NW42',
            departureAirport: {
              iataCode: 'SGN',
              name: 'Tan Son Nhat International Airport',
              city: 'Ho Chi Minh City',
            },
            arrivalAirport: {
              iataCode: 'HAN',
              name: 'Noi Bai International Airport',
              city: 'Hanoi',
            },
            departureAt: '2026-10-10T08:00:00+07:00',
            arrivalAt: '2026-10-10T10:00:00+07:00',
            duration: 'PT2H',
            duffelSegmentId: 'seg_legacy_42',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
      };
      const storedSnapshot = {
        segments: legacySnapshot.segments.map((segment) => ({
          ...segment,
          airline: { ...segment.airline },
          departureAirport: { ...segment.departureAirport },
          arrivalAirport: { ...segment.arrivalAirport },
        })),
      };
      const testModule = await Test.createTestingModule({
        providers: [
          BookingManagementService,
          { provide: PrismaService, useValue: prisma },
          { provide: BookingLifecycleService, useValue: bookingLifecycleService },
          { provide: EventEmitter2, useValue: eventEmitter },
        ],
      }).compile();
      prisma.booking.findUnique.mockResolvedValue(
        mockDetailBooking({ flightSnapshot: storedSnapshot }),
      );

      const injectedService = testModule.get(BookingManagementService);
      const result = await injectedService.getBookingDetail('booking-1', 'user-1');

      expect(result.flightSnapshot).toEqual(storedSnapshot);
      expect(result.currentItinerary.source).toBe('ORIGINAL');
      expect(result.currentItinerary.segments).toEqual(storedSnapshot.segments);
      expect(result.currentItinerary.segments[0].duffelSegmentId).toBe('seg_legacy_42');
      await testModule.close();
    });

    it('correctly maps ancillary summaries (seats, baggage) with passenger names', async () => {
      const bookingWithAncillaries = mockDetailBooking({
        payment: {
          id: 'pay-1',
          status: 'SUCCEEDED',
          stripePaymentIntentId: 'pi_1',
          ancillarySelection: {
            seatSelections: [
              {
                intentPassengerId: 'pass-1',
                segmentId: 'seg-1',
                seatDesignator: '12A',
                amount: { toString: () => '30.00' },
                currency: 'GBP',
              },
            ],
            baggageSelections: [
              {
                intentPassengerId: 'pass-1',
                type: 'CHECKED',
                quantity: 1,
                amount: { toString: () => '45.00' },
                currency: 'GBP',
              },
              {
                intentPassengerId: 'pass-unknown',
                type: 'CARRY_ON',
                quantity: 1,
                amount: { toString: () => '20.00' },
                currency: 'GBP',
              },
            ],
          },
        },
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithAncillaries);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.ancillarySummary).toBeDefined();
      expect(result.ancillarySummary?.seats).toEqual([
        {
          intentPassengerId: 'pass-1',
          passengerName: 'Jane Doe',
          segmentId: 'seg-1',
          seatDesignator: '12A',
          amount: '30.00',
          currency: 'GBP',
        },
      ]);
      expect(result.ancillarySummary?.baggage).toEqual([
        {
          intentPassengerId: 'pass-1',
          passengerName: 'Jane Doe',
          type: 'CHECKED',
          quantity: 1,
          amount: '45.00',
          currency: 'GBP',
        },
        {
          intentPassengerId: 'pass-unknown',
          passengerName: '',
          type: 'CARRY_ON',
          quantity: 1,
          amount: '20.00',
          currency: 'GBP',
        },
      ]);
    });

    it('builds disruption and itinerary with FEATURE_FLAG_DISRUPTION_SURFACING=true', async () => {
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'true';

      const bookingWithDisruption = mockDetailBooking({
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
        disruptionResolvedReason: null,
        disruptionResolvedAt: null,
        activeDisruptionRevision: {
          id: 'rev-1',
          isMaterial: true,
          materialReasons: ['DELAY_EXCEEDS_THRESHOLD'],
          incrementalDiff: { presentationSummary: { delayMinutes: 90 } },
          cumulativeDiff: { presentationSummary: { delayMinutes: 90 } },
          notificationOutbox: { stabilizationWarning: true },
        },
        itineraryRevisions: [
          {
            id: 'rev-1',
            version: 1,
            segments: [
              {
                airlineName: 'British Airways',
                marketingCarrierIata: 'BA',
                flightNumber: 'BA123',
                departureAirportIata: 'LHR',
                departureAirportName: 'Heathrow',
                departureCity: 'London',
                departureTerminal: '5',
                arrivalAirportIata: 'JFK',
                arrivalAirportName: 'John F Kennedy',
                arrivalCity: 'New York',
                arrivalTerminal: '7',
                departureAt: new Date('2026-09-15T09:30:00Z'),
                arrivalAt: new Date('2026-09-15T12:30:00Z'),
                durationMinutes: 480,
                aircraftType: '777',
                supplierSegmentId: 'seg_rev_1',
                sliceOrder: 0,
                segmentOrder: 0,
                globalOrder: 1,
              },
            ],
          },
        ],
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithDisruption);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.currentItinerary.source).toBe('REVISION');
      expect(result.currentItinerary.revisionId).toBe('rev-1');
      expect(result.currentItinerary.version).toBe(1);
      expect(result.currentItinerary.segments[0].flightNumber).toBe('BA123');
      expect(result.disruption).toEqual({
        status: 'DETECTED',
        activeRevisionId: 'rev-1',
        isMaterial: true,
        materialReasons: ['DELAY_EXCEEDS_THRESHOLD'],
        incrementalSummary: { delayMinutes: 90 },
        cumulativeSummary: { delayMinutes: 90 },
        stabilizationWarning: true,
        resolvedReason: null,
        resolvedAt: null,
      });
    });

    it('builds fallback original itinerary and disruption with FEATURE_FLAG_DISRUPTION_SURFACING=false', async () => {
      process.env.FEATURE_FLAG_DISRUPTION_SURFACING = 'false';

      const bookingWithDisruption = mockDetailBooking({
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
        itineraryRevisions: [{ id: 'rev-1', version: 1, segments: [] }],
      });

      prisma.booking.findUnique.mockResolvedValue(bookingWithDisruption);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.currentItinerary.source).toBe('ORIGINAL');
      expect(result.currentItinerary.revisionId).toBeNull();
      expect(result.disruption.status).toBe('NONE');
    });

    it('parses Duffel cancellation quote ID correctly in booking detail', async () => {
      const booking = mockDetailBooking({
        supplierCancellationQuoteId: 'can_quo_999|card|0.00|USD',
      });
      prisma.booking.findUnique.mockResolvedValue(booking);

      const result = await service.getBookingDetail('booking-1', 'user-1');

      expect(result.duffelCancellationQuoteId).toBe('can_quo_999');
    });

    it('emits non-blocking booking.reconciliation.requested for stale PROCESSING booking in getBookingDetail', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const booking = mockDetailBooking({
        id: 'stale-proc-detail',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      prisma.booking.findUnique.mockResolvedValue(booking);

      const result = await service.getBookingDetail('stale-proc-detail', 'user-1');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith('booking.reconciliation.requested', {
        bookingId: 'stale-proc-detail',
      });
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(booking);
      expect(result.id).toBe('stale-proc-detail');
      expect(result.status).toBe(BookingStatus.PROCESSING);
    });

    it('does not emit reconciliation event for recent or non-PROCESSING booking in getBookingDetail', async () => {
      const recentDate = new Date(Date.now() - 5 * 60 * 1000);
      const recentBooking = mockDetailBooking({
        id: 'recent-proc-detail',
        status: BookingStatus.PROCESSING,
        createdAt: recentDate,
      });
      prisma.booking.findUnique.mockResolvedValue(recentBooking);

      await service.getBookingDetail('recent-proc-detail', 'user-1');

      expect(eventEmitter.emit).not.toHaveBeenCalled();

      const confirmedBooking = mockDetailBooking({
        id: 'conf-detail',
        status: BookingStatus.CONFIRMED,
        createdAt: new Date(Date.now() - 30 * 60 * 1000),
      });
      prisma.booking.findUnique.mockResolvedValue(confirmedBooking);

      await service.getBookingDetail('conf-detail', 'user-1');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(confirmedBooking);
    });

    it('handles event emission error without throwing or blocking getBookingDetail', async () => {
      const staleDate = new Date(Date.now() - 20 * 60 * 1000);
      const booking = mockDetailBooking({
        id: 'stale-proc-error',
        status: BookingStatus.PROCESSING,
        createdAt: staleDate,
      });
      prisma.booking.findUnique.mockResolvedValue(booking);
      eventEmitter.emit.mockImplementationOnce(() => {
        throw new Error('EventEmitter sync error in getBookingDetail');
      });

      const result = await service.getBookingDetail('stale-proc-error', 'user-1');

      expect(result.id).toBe('stale-proc-error');
      expect(bookingLifecycleService.checkAndCompleteBooking).toHaveBeenCalledWith(booking);
    });
  });
});
