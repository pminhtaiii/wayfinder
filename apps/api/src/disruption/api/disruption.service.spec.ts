import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { DisruptionService } from './disruption.service';
import { BookingEventPublisherService } from '@/domain-events/booking-event-publisher.service';
import {
  BookingDisruptionAcknowledgedEvent,
  BookingDisruptionAcceptedEvent,
} from '@/domain-events/booking.events';

describe('DisruptionService', () => {
  let service: DisruptionService;
  let mockPrisma: any;
  let mockPublisher: jest.Mocked<BookingEventPublisherService>;

  const bookingId = 'booking-123';
  const revisionId = 'rev-456';
  const userId = 'user-789';

  beforeEach(() => {
    mockPublisher = {
      createContext: jest.fn((tx) => ({ tx, events: [] })),
      publish: jest.fn().mockResolvedValue(undefined),
      resolveEventName: jest.fn(),
    } as unknown as jest.Mocked<BookingEventPublisherService>;

    mockPrisma = {
      booking: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      itineraryRevision: {
        count: jest.fn(),
        findMany: jest.fn(),
      },
      disruptionAuditEvent: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
    };

    service = new DisruptionService(mockPrisma, mockPublisher);
  });

  describe('getDisruptionHistory', () => {
    it('throws NotFoundException if booking does not exist', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.getDisruptionHistory(bookingId, userId, 1, 10),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException if user does not own booking', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        userId: 'different-user',
      });

      await expect(
        service.getDisruptionHistory(bookingId, userId, 1, 10),
      ).rejects.toThrow(ForbiddenException);
    });

    it('returns formatted history with pagination', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        id: bookingId,
        userId,
      });
      mockPrisma.itineraryRevision.count.mockResolvedValue(1);
      mockPrisma.itineraryRevision.findMany.mockResolvedValue([
        {
          id: revisionId,
          version: 2,
          createdAt: new Date('2026-09-18T00:00:00.000Z'),
          isMaterial: true,
          materialReasons: ['DEPARTURE_MOVED_LATER'],
          materialBaselines: ['INCREMENTAL'],
          incrementalDiff: { presentationSummary: { diff: '30m' } },
          cumulativeDiff: { presentationSummary: { diff: '30m' } },
          segments: [
            {
              airlineName: 'Test Air',
              marketingCarrierIata: 'TA',
              flightNumber: '100',
              departureAirportIata: 'SFO',
              departureAirportName: 'San Francisco',
              departureCity: 'San Francisco',
              departureTerminal: '1',
              arrivalAirportIata: 'JFK',
              arrivalAirportName: 'John F Kennedy',
              arrivalCity: 'New York',
              arrivalTerminal: '4',
              departureAt: new Date('2026-09-18T10:00:00.000Z'),
              arrivalAt: new Date('2026-09-18T18:00:00.000Z'),
              durationMinutes: 300,
              aircraftType: 'B737',
              supplierSegmentId: 'seg-1',
              sliceOrder: 0,
              segmentOrder: 0,
              globalOrder: 0,
            },
          ],
        },
      ]);

      const result = await service.getDisruptionHistory(bookingId, userId, 1, 10);
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].revisionId).toBe(revisionId);
      expect(result.items[0].segments[0].flightNumber).toBe('100');
    });

    it('returns empty summaries when persisted diff metadata is not an object', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({ id: bookingId, userId });
      mockPrisma.itineraryRevision.count.mockResolvedValue(1);
      mockPrisma.itineraryRevision.findMany.mockResolvedValue([
        {
          id: revisionId,
          version: 2,
          createdAt: new Date('2026-09-18T00:00:00.000Z'),
          isMaterial: false,
          materialReasons: [],
          materialBaselines: [],
          incrementalDiff: { presentationSummary: ['unexpected-array'] },
          cumulativeDiff: { presentationSummary: 'unexpected-string' },
          segments: [],
        },
      ]);

      const result = await service.getDisruptionHistory(bookingId, userId, 1, 10);

      expect(result.items[0].incrementalSummary).toEqual({});
      expect(result.items[0].cumulativeSummary).toEqual({});
    });
  });

  describe('acknowledgeDisruption', () => {
    const detectedBooking = {
      id: bookingId,
      userId,
      version: 2,
      activeDisruptionRevisionId: revisionId,
      disruptionStatus: 'DETECTED',
      disruptionResolvedReason: null,
      updatedAt: new Date('2026-09-18T01:00:00.000Z'),
    };

    it('successfully transitions from DETECTED to ACKNOWLEDGED, increments version, and publishes event post-commit', async () => {
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(detectedBooking) // first read in tx
        .mockResolvedValueOnce({
          ...detectedBooking,
          version: 3,
          disruptionStatus: 'ACKNOWLEDGED',
          updatedAt: new Date('2026-09-18T01:05:00.000Z'),
        }); // updated read in tx
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      let publishCalledDuringTransaction = false;
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const res = await cb(mockPrisma);
        publishCalledDuringTransaction = mockPublisher.publish.mock.calls.length > 0;
        return res;
      });

      const result = await service.acknowledgeDisruption(bookingId, revisionId, userId);

      // Verify transaction behavior
      expect(publishCalledDuringTransaction).toBe(false);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: bookingId,
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: 'DETECTED',
        },
        data: {
          disruptionStatus: 'ACKNOWLEDGED',
          version: { increment: 1 },
        },
      });

      // Verify audit event
      expect(mockPrisma.disruptionAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId,
            revisionId,
            action: 'ACKNOWLEDGED',
            fromStatus: 'DETECTED',
            toStatus: 'ACKNOWLEDGED',
            actorType: 'TRAVELLER',
            actorId: userId,
          }),
        }),
      );

      // Verify post-commit event publishing
      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedEvents = mockPublisher.publish.mock.calls[0][0]!;
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toBeInstanceOf(BookingDisruptionAcknowledgedEvent);
      expect(publishedEvents[0]).toMatchObject({
        bookingId,
        sourceVersion: 3,
        disruptionId: revisionId,
        status: 'ACKNOWLEDGED',
      });

      expect(result).toMatchObject({
        bookingId,
        activeRevisionId: revisionId,
        disruptionStatus: 'ACKNOWLEDGED',
      });
    });

    it('idempotency guard: returns current state without version increment or event emission if already ACKNOWLEDGED', async () => {
      const acknowledgedBooking = {
        ...detectedBooking,
        disruptionStatus: 'ACKNOWLEDGED',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(acknowledgedBooking);

      const result = await service.acknowledgeDisruption(bookingId, revisionId, userId);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.disruptionAuditEvent.create).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(result.disruptionStatus).toBe('ACKNOWLEDGED');
    });

    it('idempotency guard: returns current state without version increment or event emission if already RESOLVED', async () => {
      const resolvedBooking = {
        ...detectedBooking,
        disruptionStatus: 'RESOLVED',
        disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
      };
      mockPrisma.booking.findUnique.mockResolvedValue(resolvedBooking);

      const result = await service.acknowledgeDisruption(bookingId, revisionId, userId);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.disruptionAuditEvent.create).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(result.disruptionStatus).toBe('RESOLVED');
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.acknowledgeDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if user does not own booking', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        userId: 'other-user',
      });

      await expect(
        service.acknowledgeDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ConflictException if revision is stale', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        activeDisruptionRevisionId: 'other-rev',
      });

      await expect(
        service.acknowledgeDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ConflictException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ConflictException if disruption status is not DETECTED', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        disruptionStatus: 'NONE',
      });

      await expect(
        service.acknowledgeDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ConflictException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('rollback: discards events and does not publish if transaction fails', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(detectedBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.disruptionAuditEvent.create.mockRejectedValue(new Error('Audit DB write error'));

      await expect(
        service.acknowledgeDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow('Audit DB write error');

      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });

  describe('acceptDisruption', () => {
    const detectedBooking = {
      id: bookingId,
      userId,
      version: 4,
      activeDisruptionRevisionId: revisionId,
      disruptionStatus: 'DETECTED',
      disruptionResolvedReason: null,
      disruptionResolvedAt: null,
      updatedAt: new Date('2026-09-18T01:00:00.000Z'),
    };

    it('successfully transitions from DETECTED to RESOLVED, increments version, and publishes event post-commit', async () => {
      const now = new Date('2026-09-18T02:00:00.000Z');
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(detectedBooking) // first read in tx
        .mockResolvedValueOnce({
          ...detectedBooking,
          version: 5,
          disruptionStatus: 'RESOLVED',
          disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
          disruptionResolvedAt: now,
          updatedAt: now,
        }); // updated read in tx
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      let publishCalledDuringTransaction = false;
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const res = await cb(mockPrisma);
        publishCalledDuringTransaction = mockPublisher.publish.mock.calls.length > 0;
        return res;
      });

      const result = await service.acceptDisruption(bookingId, revisionId, userId);

      expect(publishCalledDuringTransaction).toBe(false);
      expect(mockPrisma.booking.updateMany).toHaveBeenCalledWith({
        where: {
          id: bookingId,
          activeDisruptionRevisionId: revisionId,
          disruptionStatus: { in: ['DETECTED', 'ACKNOWLEDGED'] },
        },
        data: {
          disruptionStatus: 'RESOLVED',
          disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
          disruptionResolvedAt: expect.any(Date),
          disruptionResolvedByType: 'TRAVELLER',
          disruptionResolvedById: userId,
          version: { increment: 1 },
        },
      });

      expect(mockPrisma.disruptionAuditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            bookingId,
            revisionId,
            action: 'TRAVELLER_ACCEPTED',
            fromStatus: 'DETECTED',
            toStatus: 'RESOLVED',
            actorType: 'TRAVELLER',
            actorId: userId,
          }),
        }),
      );

      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedEvents = mockPublisher.publish.mock.calls[0][0]!;
      expect(publishedEvents).toHaveLength(1);
      expect(publishedEvents[0]).toBeInstanceOf(BookingDisruptionAcceptedEvent);
      expect(publishedEvents[0]).toMatchObject({
        bookingId,
        sourceVersion: 5,
        disruptionId: revisionId,
        status: 'RESOLVED',
      });

      expect(result).toMatchObject({
        bookingId,
        activeRevisionId: revisionId,
        disruptionStatus: 'RESOLVED',
        resolvedReason: 'TRAVELLER_ACCEPTED',
      });
    });

    it('successfully transitions from ACKNOWLEDGED to RESOLVED, increments version, and publishes event post-commit', async () => {
      const acknowledgedBooking = {
        ...detectedBooking,
        version: 3,
        disruptionStatus: 'ACKNOWLEDGED',
      };
      const now = new Date('2026-09-18T02:00:00.000Z');
      mockPrisma.booking.findUnique
        .mockResolvedValueOnce(acknowledgedBooking)
        .mockResolvedValueOnce({
          ...acknowledgedBooking,
          version: 4,
          disruptionStatus: 'RESOLVED',
          disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
          disruptionResolvedAt: now,
          updatedAt: now,
        });
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.acceptDisruption(bookingId, revisionId, userId);

      expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
      const publishedEvents = mockPublisher.publish.mock.calls[0][0]!;
      expect(publishedEvents[0]).toMatchObject({
        bookingId,
        sourceVersion: 4,
        disruptionId: revisionId,
        status: 'RESOLVED',
      });
      expect(result.disruptionStatus).toBe('RESOLVED');
    });

    it('idempotency guard: returns current state without version increment or event emission if already RESOLVED', async () => {
      const resolvedBooking = {
        ...detectedBooking,
        disruptionStatus: 'RESOLVED',
        disruptionResolvedReason: 'TRAVELLER_ACCEPTED',
        disruptionResolvedAt: new Date('2026-09-18T01:30:00.000Z'),
      };
      mockPrisma.booking.findUnique.mockResolvedValue(resolvedBooking);

      const result = await service.acceptDisruption(bookingId, revisionId, userId);

      expect(mockPrisma.booking.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.disruptionAuditEvent.create).not.toHaveBeenCalled();
      expect(mockPublisher.publish).not.toHaveBeenCalled();
      expect(result.disruptionStatus).toBe('RESOLVED');
    });

    it('throws NotFoundException if booking not found', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(null);

      await expect(
        service.acceptDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(NotFoundException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException if user does not own booking', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        userId: 'other-user',
      });

      await expect(
        service.acceptDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ForbiddenException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ConflictException if revision is stale', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        activeDisruptionRevisionId: 'other-rev',
      });

      await expect(
        service.acceptDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ConflictException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('throws ConflictException if disruption status is neither DETECTED nor ACKNOWLEDGED', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue({
        ...detectedBooking,
        disruptionStatus: 'NONE',
      });

      await expect(
        service.acceptDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow(ConflictException);
      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });

    it('rollback: discards events and does not publish if transaction fails', async () => {
      mockPrisma.booking.findUnique.mockResolvedValue(detectedBooking);
      mockPrisma.booking.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.disruptionAuditEvent.create.mockRejectedValue(new Error('Audit DB write error'));

      await expect(
        service.acceptDisruption(bookingId, revisionId, userId),
      ).rejects.toThrow('Audit DB write error');

      expect(mockPublisher.publish).not.toHaveBeenCalled();
    });
  });
});
