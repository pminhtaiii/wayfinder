import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  BookingFailureReason,
  BookingStatus,
  DisruptionActorType,
  DisruptionStatus,
  Prisma,
} from '@prisma/client';
import {
  BookingCreatedEvent,
  BookingConfirmedEvent,
  BookingFailedEvent,
  BookingCompletedEvent,
  BookingCancellationPendingEvent,
  BookingCancelledEvent,
  BookingRefundUpdatedEvent,
  BookingEventPublisherService,
  TransactionEventContext,
} from '@/domain-events';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingPipelineOutcome } from './booking-lifecycle.types';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

// Approved 2026-10-03: update only lifecycle Prisma fields and the internal supplier outcome field; preserve external keys and values.

describe('BookingLifecycleService', () => {
  let service: BookingLifecycleService;
  let mockPrisma: any;
  let mockPublisher: jest.Mocked<BookingEventPublisherService>;

  beforeEach(() => {
    mockPrisma = {
      bookingIntent: {
        findUnique: jest.fn(),
      },
      booking: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      disruptionAuditEvent: {
        create: jest.fn(),
      },
      $transaction: jest.fn(async (cb) => cb(mockPrisma)),
    };

    // Type assertion is required because BookingEventPublisherService contains private members
    // (logger, emitter) preventing raw object literal structural assignment in test doubles.
    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
      resolveEventName: jest.fn().mockReturnValue(null),
    } as unknown as jest.Mocked<BookingEventPublisherService>;

    service = new BookingLifecycleService(mockPrisma, mockPublisher);
  });

  describe('createBooking', () => {
    it('creates version 1 booking and emits BookingCreatedEvent standalone post-commit', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      mockPrisma.booking.create.mockResolvedValue({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        totalAmount: '450.00',
        currency: 'GBP',
        status: BookingStatus.PROCESSING,
        paymentId: 'pay-1',
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result).toEqual(
        expect.objectContaining({
          id: 'booking-1',
          status: BookingStatus.PROCESSING,
          version: 1,
        }),
      );
      expect(mockPrisma.booking.create).toHaveBeenCalledWith({
        data: {
          id: 'booking-1',
          userId: 'user-1',
          bookingIntentId: 'intent-1',
          totalAmount: '450.00',
          currency: 'GBP',
          status: BookingStatus.PROCESSING,
          paymentId: 'pay-1',
          version: 1,
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emittedEvents = mockPublisher.publish.mock.calls[0][0];
      expect(emittedEvents).toBeDefined();
      if (!emittedEvents) {
        throw new Error('Expected events to be published');
      }
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0]).toBeInstanceOf(BookingCreatedEvent);
      expect(emittedEvents[0]).toEqual(
        expect.objectContaining({
          bookingId: 'booking-1',
          sourceVersion: 1,
          status: BookingStatus.PROCESSING,
        }),
      );
    });

    it('appends BookingCreatedEvent to context.events and does NOT call publisher.publish when context provided', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      mockPrisma.booking.create.mockResolvedValue({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        totalAmount: '450.00',
        currency: 'GBP',
        status: BookingStatus.PROCESSING,
        version: 1,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.createBooking(
        'user-1',
        'booking-1',
        'intent-1',
        undefined,
        context,
      );

      expect(result.id).toBe('booking-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCreatedEvent);
      expect(context.events[0]).toEqual(
        expect.objectContaining({
          bookingId: 'booking-1',
          sourceVersion: 1,
        }),
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('parses Duffel rawOfferSnapshot with slices and segments into flightSnapshot when flightSnapshot not provided', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-duffel',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
        rawOfferSnapshot: {
          total_duration: 'PT8H',
          slices: [
            {
              duration: 'PT8H',
              segments: [
                {
                  id: 'seg_1',
                  departing_at: '2026-09-18T10:00:00Z',
                  arriving_at: '2026-09-18T18:00:00Z',
                  duration: 'PT8H',
                  marketing_carrier_flight_number: 'DL100',
                  operating_carrier: { name: 'Delta Air Lines', iata_code: 'DL' },
                  origin: { iata_code: 'JFK', name: 'John F Kennedy Intl', city_name: 'New York' },
                  destination: { iata_code: 'LHR', name: 'London Heathrow', city_name: 'London' },
                  passengers: [{ cabin_class: 'economy' }],
                },
              ],
            },
          ],
        },
      });
      mockPrisma.booking.create.mockResolvedValue({
        id: 'booking-duffel',
        userId: 'user-1',
        bookingIntentId: 'intent-duffel',
        totalAmount: '450.00',
        currency: 'GBP',
        status: BookingStatus.PROCESSING,
        version: 1,
      });

      await service.createBooking('user-1', 'booking-duffel', 'intent-duffel');

      // Approved 2026-10-03 per test-adaptations-api.md: new internal snapshot writes use the neutral ID; legacy JSON and HTTP keys stay unchanged.
      expect(mockPrisma.booking.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            flightSnapshot: expect.objectContaining({
              totalDuration: 'PT8H',
              stops: 0,
              cabinClass: 'economy',
              segments: [
                expect.objectContaining({
                  airline: { name: 'Delta Air Lines', iataCode: 'DL' },
                  flightNumber: 'DL100',
                  departureAirport: expect.objectContaining({ iataCode: 'JFK', name: 'John F Kennedy Intl', city: 'New York' }),
                  arrivalAirport: expect.objectContaining({ iataCode: 'LHR', name: 'London Heathrow', city: 'London' }),
                  departureAt: '2026-09-18T10:00:00Z',
                  arrivalAt: '2026-09-18T18:00:00Z',
                  duration: 'PT8H',
                  supplierSegmentId: 'seg_1',
                  sliceOrder: 0,
                  segmentOrder: 0,
                  globalOrder: 0,
                }),
              ],
            }),
          }),
        }),
      );
    });

    it('throws NotFoundException if booking intent does not exist', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue(null);

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if booking intent belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-2',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 error, attaches paymentId to existing booking without version increment, and emits ZERO events', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: null,
        version: 1,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-new',
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-new');

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-existing' },
        data: { paymentId: 'pay-new' },
      });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 duplicate replay when paymentId already present, returns existing booking without increment, and emits ZERO events', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-existing',
        version: 1,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.createBooking(
        'user-1',
        'booking-1',
        'intent-1',
        'pay-new',
        context,
      );

      expect(result.id).toBe('booking-existing');
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException on P2002 if existing booking by intent belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-existing',
        userId: 'user-other',
        bookingIntentId: 'intent-1',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('handles P2002 error when booking by ID exists for same user and intent, attaching paymentId without increment and zero events', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: null,
        version: 1,
      });
      mockPrisma.booking.update.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-1',
        paymentId: 'pay-1',
        version: 1,
      });

      const result = await service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1');

      expect(result.id).toBe('booking-1');
      expect(mockPrisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { paymentId: 'pay-1' },
      });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException on P2002 when existing by ID belongs to another user', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-other',
        bookingIntentId: 'intent-1',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws BadRequestException on P2002 when existing by ID has different bookingIntentId', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockResolvedValueOnce(null);
      mockPrisma.booking.findUnique.mockResolvedValueOnce({
        id: 'booking-1',
        userId: 'user-1',
        bookingIntentId: 'intent-other',
      });

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws BadRequestException on P2002 when concurrent inserts leave requested booking ID on different intent even if requested intent row exists', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '5.0.0',
      });
      mockPrisma.booking.create.mockRejectedValue(p2002);
      mockPrisma.booking.findUnique.mockImplementation(
        async ({ where }: { where: { id?: string; bookingIntentId?: string } }) => {
          if (where.id === 'booking-1') {
            return {
              id: 'booking-1',
              userId: 'user-1',
              bookingIntentId: 'intent-other',
            };
          }
          if (where.bookingIntentId === 'intent-1') {
            return {
              id: 'booking-concurrent-other',
              userId: 'user-1',
              bookingIntentId: 'intent-1',
            };
          }
          return null;
        },
      );

      await expect(
        service.createBooking('user-1', 'booking-1', 'intent-1', 'pay-1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('rethrows generic errors and emits zero events', async () => {
      mockPrisma.bookingIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        userId: 'user-1',
        confirmedPrice: '450.00',
        currency: 'GBP',
      });
      mockPrisma.booking.create.mockRejectedValue(new Error('DB connection failed'));

      await expect(service.createBooking('user-1', 'booking-1', 'intent-1')).rejects.toThrow(
        'DB connection failed',
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateToConfirmed & confirmBooking', () => {
    const flightSnapshot: FlightSnapshot = {
      segments: [
        {
          airline: { name: 'Airline', iataCode: 'AL' },
          flightNumber: '101',
          departureAirport: { iataCode: 'JFK', name: 'JFK Airport', city: 'New York' },
          arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
          departureAt: '2026-09-01T10:00:00.000Z',
          arrivalAt: '2026-09-01T22:00:00.000Z',
          duration: 'PT8H',
        },
      ],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'economy',
    };

    const passengerSnapshot: PassengerSnapshot = {
      passengers: [
        {
          type: 'ADULT',
          firstName: 'John',
          lastName: 'Doe',
        },
      ],
      contactEmail: 'john@example.com',
    };

    it('throws BadRequestException if flightSnapshot has no segments', async () => {
      const invalidSnapshot = { ...flightSnapshot, segments: [] };
      await expect(
        service.updateToConfirmed('b-1', 'PNR1', 'ord-1', invalidSnapshot, passengerSnapshot),
      ).rejects.toThrow(BadRequestException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('updates booking to CONFIRMED, increments version by 1, and produces BookingConfirmedEvent standalone', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR1',
        supplierOrderId: 'ord-1',
        version: 2,
      });

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
      );

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(result.version).toBe(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: { in: [BookingStatus.PROCESSING, BookingStatus.FAILED] } },
        data: {
          status: BookingStatus.CONFIRMED,
          failureReason: null,
          pnrReference: 'PNR1',
          supplierOrderId: 'ord-1',
          flightSnapshot: flightSnapshot as any,
          passengerSnapshot: passengerSnapshot as any,
          departureAt: new Date('2026-09-01T10:00:00.000Z'),
          version: { increment: 1 },
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted[0]).toBeInstanceOf(BookingConfirmedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.CONFIRMED,
        }),
      );
    });

    it('confirmBooking alias delegates to updateToConfirmed and behaves identically', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        pnrReference: 'PNR1',
        supplierOrderId: 'ord-1',
        version: 2,
      });

      const result = await service.confirmBooking(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
      );

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends event to context.events and does NOT call publisher.publish when context provided', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingConfirmedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('supports custom transaction client without context and does not call publisher.publish', async () => {
      const customTx: any = {
        booking: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ id: 'b-1', status: BookingStatus.CONFIRMED, version: 2 }),
        },
      };

      await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        customTx,
      );

      expect(customTx.booking.updateMany).toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('does not construct or emit event on rejected/no-op update (0 rows updated)', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToConfirmed(
        'b-1',
        'PNR1',
        'ord-1',
        flightSnapshot,
        passengerSnapshot,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking not found after update', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToConfirmed('b-1', 'PNR1', 'ord-1', flightSnapshot, passengerSnapshot),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateToFailed & failBooking', () => {
    it('updates booking to FAILED with failureReason, increments version, and emits BookingFailedEvent', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const result = await service.updateToFailed('b-1', BookingFailureReason.CAPTURE_FAILED);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(result.version).toBe(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.PROCESSING },
        data: {
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.CAPTURE_FAILED,
          version: { increment: 1 },
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted[0]).toBeInstanceOf(BookingFailedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.FAILED,
          failureReason: BookingFailureReason.CAPTURE_FAILED,
        }),
      );
    });

    it('failBooking alias delegates to updateToFailed and behaves identically', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const result = await service.failBooking('b-1', BookingFailureReason.CAPTURE_FAILED);

      expect(result.status).toBe(BookingStatus.FAILED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends event to context.events and does NOT call publisher.publish when context provided', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.FAILED,
        failureReason: BookingFailureReason.CAPTURE_FAILED,
        version: 2,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateToFailed(
        'b-1',
        BookingFailureReason.CAPTURE_FAILED,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      );

      expect(result.id).toBe('b-1');
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingFailedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('emits ZERO events on rejected/no-op fail on already CONFIRMED or COMPLETED booking', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 2,
      });

      const result = await service.updateToFailed('b-1', BookingFailureReason.SYSTEM_ERROR);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateToFailed('b-1', BookingFailureReason.SYSTEM_ERROR),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('applyPipelineOutcome', () => {
    const flightSnapshot: FlightSnapshot = {
      segments: [
        {
          airline: { name: 'Airline', iataCode: 'AL' },
          flightNumber: '101',
          departureAirport: { iataCode: 'JFK', name: 'JFK Airport', city: 'New York' },
          arrivalAirport: { iataCode: 'LHR', name: 'Heathrow', city: 'London' },
          departureAt: '2026-09-01T10:00:00.000Z',
          arrivalAt: '2026-09-01T22:00:00.000Z',
          duration: 'PT8H',
        },
      ],
      totalDuration: 'PT8H',
      stops: 0,
      cabinClass: 'economy',
    };

    const passengerSnapshot: PassengerSnapshot = {
      passengers: [{ type: 'ADULT', firstName: 'John', lastName: 'Doe' }],
      contactEmail: 'john@example.com',
    };

    it('dispatches CONFIRMED outcome to updateToConfirmed', async () => {
      const outcome: BookingPipelineOutcome = {
        status: 'CONFIRMED',
        bookingId: 'b-1',
        paymentId: 'p-1',
        pnrReference: 'PNR123',
        supplierOrderId: 'ord-123',
        flightSnapshot,
        passengerSnapshot,
        occurredAt: '2026-08-23T10:00:00.000Z',
      };

      jest.spyOn(service, 'updateToConfirmed').mockResolvedValue({ id: 'b-1' } as any);

      await service.applyPipelineOutcome(outcome);

      expect(service.updateToConfirmed).toHaveBeenCalledWith(
        'b-1',
        'PNR123',
        'ord-123',
        flightSnapshot,
        passengerSnapshot,
        undefined,
      );
    });

    it('dispatches FAILED outcome to updateToFailed', async () => {
      const outcome: BookingPipelineOutcome = {
        status: 'FAILED',
        bookingId: 'b-1',
        paymentId: 'p-1',
        category: BookingFailureReason.CAPTURE_FAILED,
        partialState: {
          flightSnapshot,
          passengerSnapshot,
          departureAt: new Date('2026-09-01T10:00:00.000Z'),
        },
        occurredAt: '2026-08-23T10:00:00.000Z',
      };

      jest.spyOn(service, 'updateToFailed').mockResolvedValue({ id: 'b-1' } as any);

      await service.applyPipelineOutcome(outcome);

      expect(service.updateToFailed).toHaveBeenCalledWith(
        'b-1',
        BookingFailureReason.CAPTURE_FAILED,
        flightSnapshot,
        passengerSnapshot,
        expect.any(Date),
        undefined,
      );
    });
  });

  describe('checkAndCompleteBooking & completeBooking', () => {
    it('fetches booking with relations when given a string bookingId, completes it with version increment and BookingCompletedEvent standalone', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData) // Initial lookup by id
        .mockResolvedValueOnce(bookingData); // Transaction lookup
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.checkAndCompleteBooking('b-1');

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.version).toBe(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'b-1',
          status: BookingStatus.CONFIRMED,
          currentFinalArrivalAt: null,
          departureAt: pastDeparture,
        },
        data: {
          status: BookingStatus.COMPLETED,
          version: { increment: 1 },
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted[0]).toBeInstanceOf(BookingCompletedEvent);
      expect(emitted[0]).toEqual(
        expect.objectContaining({
          bookingId: 'b-1',
          sourceVersion: 2,
          status: BookingStatus.COMPLETED,
        }),
      );
    });

    it('completeBooking alias delegates to checkAndCompleteBooking and behaves identically', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData)
        .mockResolvedValueOnce(bookingData);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.completeBooking('b-1');

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
    });

    it('appends BookingCompletedEvent to context.events and does NOT call publisher.publish when context provided', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const bookingData: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        currentFinalArrivalAt: null,
        disruptionStatus: null,
        activeDisruptionRevisionId: null,
        version: 1,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(bookingData)
        .mockResolvedValueOnce(bookingData);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.checkAndCompleteBooking('b-1', context);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCompletedEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when string bookingId is not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(service.checkAndCompleteBooking('non-existent')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('does not complete booking or emit events if status is not CONFIRMED', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.PROCESSING,
        departureAt: new Date(Date.now() - 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.PROCESSING);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('does not complete booking or emit events if departure time is in the future', async () => {
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() + 3600 * 1000),
      };

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.CONFIRMED);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('completes booking and resolves active disruption when present', async () => {
      const pastArrival = new Date(Date.now() - 1000);
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: new Date(Date.now() - 3600 * 1000),
        currentFinalArrivalAt: pastArrival,
        disruptionStatus: DisruptionStatus.DETECTED,
        activeDisruptionRevisionId: 'rev-1',
        version: 1,
      };

      mockPrisma.booking.findUnique.mockResolvedValue(booking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.checkAndCompleteBooking(booking);

      expect(result.status).toBe(BookingStatus.COMPLETED);
      expect(result.disruptionStatus).toBe(DisruptionStatus.RESOLVED);
      expect(result.disruptionResolvedReason).toBe('DEPARTURE_PASSED');
      expect(mockPrisma.disruptionAuditEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          bookingId: 'b-1',
          revisionId: 'rev-1',
          action: 'DEPARTURE_RESOLVED',
          fromStatus: DisruptionStatus.DETECTED,
          toStatus: DisruptionStatus.RESOLVED,
          actorType: DisruptionActorType.SYSTEM,
        }),
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0][0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted[0]).toBeInstanceOf(BookingCompletedEvent);
    });

    it('handles race condition when booking status was changed concurrently in tx and emits zero events', async () => {
      const pastDeparture = new Date(Date.now() - 3600 * 1000);
      const booking: any = {
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        departureAt: pastDeparture,
        version: 1,
      };

      // db returns booking already changed to COMPLETED
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.COMPLETED,
        departureAt: pastDeparture,
        version: 2,
      });

      const result = await service.checkAndCompleteBooking(booking);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(result.status).toBe(BookingStatus.CONFIRMED); // local untouched because tx did not update
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('claimCancellation', () => {
    const staleThreshold = new Date(Date.now() - 2 * 60 * 1000);

    it('transitions CONFIRMED booking to CANCELLATION_PENDING, increments version, and emits BookingCancellationPendingEvent', async () => {
      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 1 }); // transition attempt succeeds
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CANCELLATION_PENDING,
        version: 2,
      });

      const result = await service.claimCancellation('b-1', 'user-1', staleThreshold);

      expect(result).toEqual({ count: 1 });
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'b-1',
          userId: 'user-1',
          status: { in: [BookingStatus.CONFIRMED, BookingStatus.COMPLETED] },
        },
        data: {
          status: BookingStatus.CANCELLATION_PENDING,
          version: { increment: 1 },
        },
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0]?.[0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBeInstanceOf(BookingCancellationPendingEvent);
      expect((emitted[0] as BookingCancellationPendingEvent).bookingId).toBe('b-1');
      expect((emitted[0] as BookingCancellationPendingEvent).sourceVersion).toBe(2);
    });

    it('refreshes stale CANCELLATION_PENDING lease without incrementing version and without emitting event', async () => {
      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 0 }) // transition attempt finds not in CONFIRMED/COMPLETED
        .mockResolvedValueOnce({ count: 1 }); // refresh stale lease succeeds

      const result = await service.claimCancellation('b-1', 'user-1', staleThreshold);

      expect(result).toEqual({ count: 1 });
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'b-1',
          userId: 'user-1',
          status: BookingStatus.CANCELLATION_PENDING,
          updatedAt: { lte: staleThreshold },
        },
        data: {
          status: BookingStatus.CANCELLATION_PENDING,
        },
      });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('returns count: 0 and emits no event when claim cannot be acquired', async () => {
      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      const result = await service.claimCancellation('b-1', 'user-1', staleThreshold);

      expect(result).toEqual({ count: 0 });
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('collects event into provided context without publishing directly', async () => {
      mockPrisma.booking.updateMany.mockResolvedValueOnce({ count: 1 });
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CANCELLATION_PENDING,
        version: 3,
      });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.claimCancellation('b-1', 'user-1', staleThreshold, mockPrisma, context);

      expect(result).toEqual({ count: 1 });
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCancellationPendingEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('cancelBooking', () => {
    it('cancels CANCELLATION_PENDING booking, increments version, and emits BookingCancelledEvent', async () => {
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          id: 'b-1',
          status: BookingStatus.CANCELLATION_PENDING,
          disruptionStatus: null,
          activeDisruptionRevisionId: null,
          version: 2,
        })
        .mockResolvedValueOnce({
          id: 'b-1',
          version: 3,
        });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelBooking(
        'b-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        '150.00',
      );

      expect(result.count).toBe(1);
      expect(result.hasActiveDisruption).toBe(false);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.CANCELLATION_PENDING },
        data: expect.objectContaining({
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          airlineRefundAmount: '150.00',
          customerRefundAmount: '150.00',
          version: { increment: 1 },
        }),
      });
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const emitted = mockPublisher.publish.mock.calls[0]?.[0];
      expect(emitted).toBeDefined();
      if (!emitted) {
        throw new Error('Expected events to be published');
      }
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toBeInstanceOf(BookingCancelledEvent);
      expect((emitted[0] as BookingCancelledEvent).sourceVersion).toBe(3);
      expect((emitted[0] as BookingCancelledEvent).status).toBe(BookingStatus.CANCELLED_PENDING_REFUND);
    });

    it('resolves active disruption on cancellation and populates disruption metadata', async () => {
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          id: 'b-1',
          status: BookingStatus.CANCELLATION_PENDING,
          disruptionStatus: DisruptionStatus.DETECTED,
          activeDisruptionRevisionId: 'rev-42',
          version: 1,
        })
        .mockResolvedValueOnce({
          id: 'b-1',
          version: 2,
        });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.cancelBooking(
        'b-1',
        BookingStatus.CANCELLED_NO_REFUND,
        '0.00',
        {
          resolvedByType: DisruptionActorType.TRAVELLER,
          resolvedById: 'user-1',
        },
      );

      expect(result.count).toBe(1);
      expect(result.hasActiveDisruption).toBe(true);
      expect(result.activeDisruptionRevisionId).toBe('rev-42');
      expect(result.previousDisruptionStatus).toBe(DisruptionStatus.DETECTED);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: { id: 'b-1', status: BookingStatus.CANCELLATION_PENDING },
        data: expect.objectContaining({
          status: BookingStatus.CANCELLED_NO_REFUND,
          disruptionStatus: DisruptionStatus.RESOLVED,
          disruptionResolvedReason: 'BOOKING_CANCELLED',
          disruptionResolvedByType: DisruptionActorType.TRAVELLER,
          disruptionResolvedById: 'user-1',
        }),
      });
    });

    it('returns count: 0 and emits no events if booking not in CANCELLATION_PENDING', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: 'b-1',
        status: BookingStatus.CONFIRMED,
        version: 1,
      });

      const result = await service.cancelBooking(
        'b-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        '100.00',
      );

      expect(result.count).toBe(0);
      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('collects event into provided context without publishing directly', async () => {
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce({
          id: 'b-1',
          status: BookingStatus.CANCELLATION_PENDING,
          disruptionStatus: null,
          version: 5,
        })
        .mockResolvedValueOnce({
          id: 'b-1',
          version: 6,
        });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.cancelBooking(
        'b-1',
        BookingStatus.CANCELLED_PENDING_REFUND,
        '200.00',
        undefined,
        mockPrisma,
        context,
      );

      expect(result.count).toBe(1);
      expect(context.events).toHaveLength(1);
      expect(context.events[0]).toBeInstanceOf(BookingCancelledEvent);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('updateBookingRefundStatus', () => {
    it('enforces no-op invariant: returns count 0 with no version bump and zero events when status already matches', async () => {
      const existingBooking = {
        id: 'booking-noop-1',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        version: 3,
      };
      mockPrisma.booking.findUnique.mockResolvedValue(existingBooking);

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateBookingRefundStatus(
        'booking-noop-1',
        BookingStatus.CANCELLED_AND_REFUNDED,
        'SUCCEEDED',
        undefined,
        mockPrisma,
        context,
      );

      expect(result).toEqual({
        count: 0,
        updatedBooking: existingBooking,
      });
      expect(mockPrisma.booking.update).not.toHaveBeenCalled();
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('updates status and increments version when status differs, pushing BookingRefundUpdatedEvent to context', async () => {
      const currentBooking = {
        id: 'booking-trans-1',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 2,
      };
      const updatedBooking = {
        ...currentBooking,
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        version: 3,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(currentBooking)
        .mockResolvedValueOnce(updatedBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateBookingRefundStatus(
        'booking-trans-1',
        BookingStatus.CANCELLED_AND_REFUNDED,
        'SUCCEEDED',
        undefined,
        mockPrisma,
        context,
      );

      expect(result).toEqual({
        count: 1,
        updatedBooking,
      });
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'booking-trans-1',
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          version: 2,
        },
        data: {
          status: BookingStatus.CANCELLED_AND_REFUNDED,
          version: { increment: 1 },
        },
      });
      expect(context.events).toHaveLength(1);
      const event = context.events[0] as BookingRefundUpdatedEvent;
      expect(event).toBeInstanceOf(BookingRefundUpdatedEvent);
      expect(event.bookingId).toBe('booking-trans-1');
      expect(event.sourceVersion).toBe(3);
      expect(event.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
      expect(event.refundStatus).toBe('SUCCEEDED');
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('publishes BookingRefundUpdatedEvent post-commit when called standalone without context', async () => {
      const currentBooking = {
        id: 'booking-standalone-1',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 1,
      };
      const updatedBooking = {
        ...currentBooking,
        status: BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
        version: 2,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(currentBooking)
        .mockResolvedValueOnce(updatedBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.updateBookingRefundStatus(
        'booking-standalone-1',
        BookingStatus.REFUND_FAILED_NEEDS_ATTENTION,
        'REFUND_FAILED_NEEDS_ATTENTION',
        'STRIPE_REQUIRES_ATTENTION',
      );

      expect(result.count).toBe(1);
      expect(result.updatedBooking).toEqual(updatedBooking);
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedBatch = mockPublisher.publish.mock.calls[0]?.[0];
      expect(Array.isArray(publishedBatch)).toBe(true);
      if (!Array.isArray(publishedBatch)) {
        throw new Error('Expected publishedBatch to be an array');
      }
      expect(publishedBatch).toHaveLength(1);
      const event = publishedBatch[0] as BookingRefundUpdatedEvent;
      expect(event).toBeInstanceOf(BookingRefundUpdatedEvent);
      expect(event.status).toBe(BookingStatus.REFUND_FAILED_NEEDS_ATTENTION);
      expect(event.reason).toBe('STRIPE_REQUIRES_ATTENTION');
      expect(event.sourceVersion).toBe(2);
    });

    it('retries on optimistic concurrency collision and succeeds if subsequent attempt succeeds', async () => {
      const initialBooking = {
        id: 'booking-retry-1',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 1,
      };
      const concurrentlyMutatedBooking = {
        id: 'booking-retry-1',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 2,
      };
      const finalBooking = {
        id: 'booking-retry-1',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        version: 3,
      };

      // 1. Initial read: initialBooking
      // 2. Attempt 1 updateMany fails -> reload: concurrentlyMutatedBooking
      // 3. Attempt 2 updateMany succeeds -> reload updated: finalBooking
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(initialBooking)
        .mockResolvedValueOnce(concurrentlyMutatedBooking)
        .mockResolvedValueOnce(finalBooking);

      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateBookingRefundStatus(
        'booking-retry-1',
        BookingStatus.CANCELLED_AND_REFUNDED,
        'SUCCEEDED',
        undefined,
        mockPrisma,
        context,
      );

      expect(result.count).toBe(1);
      expect(result.updatedBooking).toEqual(finalBooking);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'booking-retry-1',
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          version: 1,
        },
        data: {
          status: BookingStatus.CANCELLED_AND_REFUNDED,
          version: { increment: 1 },
        },
      });
      expect(mockPrisma.booking.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'booking-retry-1',
          status: BookingStatus.CANCELLED_PENDING_REFUND,
          version: 2,
        },
        data: {
          status: BookingStatus.CANCELLED_AND_REFUNDED,
          version: { increment: 1 },
        },
      });
      expect(context.events).toHaveLength(1);
      const event = context.events[0] as BookingRefundUpdatedEvent;
      expect(event).toBeInstanceOf(BookingRefundUpdatedEvent);
      expect(event.sourceVersion).toBe(3);
      expect(event.status).toBe(BookingStatus.CANCELLED_AND_REFUNDED);
    });

    it('throws ConflictException if optimistic concurrency collisions persist across all retry attempts', async () => {
      const b1 = { id: 'booking-collide-1', status: BookingStatus.CANCELLED_PENDING_REFUND, version: 1 };
      const b2 = { id: 'booking-collide-1', status: BookingStatus.CANCELLED_PENDING_REFUND, version: 2 };
      const b3 = { id: 'booking-collide-1', status: BookingStatus.CANCELLED_PENDING_REFUND, version: 3 };
      const b4 = { id: 'booking-collide-1', status: BookingStatus.CANCELLED_PENDING_REFUND, version: 4 };

      // Initial read + 3 reloads after 3 failed updateMany attempts
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(b1)
        .mockResolvedValueOnce(b2)
        .mockResolvedValueOnce(b3)
        .mockResolvedValueOnce(b4);

      mockPrisma.booking.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      await expect(
        service.updateBookingRefundStatus(
          'booking-collide-1',
          BookingStatus.CANCELLED_AND_REFUNDED,
          'SUCCEEDED',
          undefined,
          mockPrisma,
          context,
        ),
      ).rejects.toThrow(
        new ConflictException('Concurrent booking mutation detected during refund status update'),
      );

      expect(mockPrisma.booking.updateMany).toHaveBeenCalledTimes(3);
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('returns count: 0 and emits no event if reloaded booking matches targetStatus after failed update', async () => {
      const currentBooking = {
        id: 'booking-concur-match',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 1,
      };
      const reloadedMatchingBooking = {
        id: 'booking-concur-match',
        status: BookingStatus.CANCELLED_AND_REFUNDED,
        version: 2,
      };

      // Initial read: currentBooking, reload after updateMany failure: reloadedMatchingBooking
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(currentBooking)
        .mockResolvedValueOnce(reloadedMatchingBooking);
      mockPrisma.booking.updateMany.mockResolvedValueOnce({ count: 0 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      const result = await service.updateBookingRefundStatus(
        'booking-concur-match',
        BookingStatus.CANCELLED_AND_REFUNDED,
        'SUCCEEDED',
        undefined,
        mockPrisma,
        context,
      );

      expect(result.count).toBe(0);
      expect(result.updatedBooking).toEqual(reloadedMatchingBooking);
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws NotFoundException if booking does not exist', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.updateBookingRefundStatus(
          'non-existent',
          BookingStatus.CANCELLED_AND_REFUNDED,
          'SUCCEEDED',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException without updating or retrying if initial booking status is disallowed for refund target', async () => {
      const confirmedBooking = {
        id: 'booking-disallowed-init',
        status: BookingStatus.CONFIRMED,
        version: 1,
      };
      mockPrisma.booking.findUnique.mockResolvedValue(confirmedBooking);

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      await expect(
        service.updateBookingRefundStatus(
          'booking-disallowed-init',
          BookingStatus.CANCELLED_AND_REFUNDED,
          'SUCCEEDED',
          undefined,
          mockPrisma,
          context,
        ),
      ).rejects.toThrow(
        new ConflictException(
          'Cannot transition booking booking-disallowed-init from CONFIRMED to CANCELLED_AND_REFUNDED',
        ),
      );

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ConflictException and does not retry if concurrent update moves booking to disallowed status (COMPLETED)', async () => {
      const initialBooking = {
        id: 'booking-disallowed-reload',
        status: BookingStatus.CANCELLED_PENDING_REFUND,
        version: 1,
      };
      const concurrentlyCompletedBooking = {
        id: 'booking-disallowed-reload',
        status: BookingStatus.COMPLETED,
        version: 2,
      };

      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(initialBooking)
        .mockResolvedValueOnce(concurrentlyCompletedBooking);
      mockPrisma.booking.updateMany.mockResolvedValueOnce({ count: 0 });

      const context: TransactionEventContext = {
        tx: mockPrisma,
        events: [],
      };

      await expect(
        service.updateBookingRefundStatus(
          'booking-disallowed-reload',
          BookingStatus.CANCELLED_AND_REFUNDED,
          'SUCCEEDED',
          undefined,
          mockPrisma,
          context,
        ),
      ).rejects.toThrow(
        new ConflictException(
          'Cannot transition booking booking-disallowed-reload from reloaded status COMPLETED to CANCELLED_AND_REFUNDED',
        ),
      );

      expect(mockPrisma.booking.updateMany).toHaveBeenCalledTimes(1);
      expect(context.events).toHaveLength(0);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });
});
