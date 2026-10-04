import { BookingFailureReason, BookingStatus, Prisma } from '@prisma/client';
import { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';

export type { TransactionEventContext } from '@/domain-events';

export type BookingPipelineOutcome =
  | {
      status: 'CONFIRMED';
      bookingId: string;
      paymentId: string;
      pnrReference: string;
      supplierOrderId: string;
      flightSnapshot: FlightSnapshot;
      passengerSnapshot: PassengerSnapshot;
      occurredAt: string;
    }
  | {
      status: 'FAILED';
      bookingId: string;
      paymentId: string;
      category: BookingFailureReason;
      partialState?: {
        flightSnapshot?: FlightSnapshot;
        passengerSnapshot?: PassengerSnapshot;
        departureAt?: Date;
      };
      occurredAt: string;
    };

export interface BookingCompletionResult {
  bookingId: string;
  status: BookingStatus;
  completed: boolean;
  disruptionResolved?: boolean;
}

export type BookingWithRelations = Prisma.BookingGetPayload<{
  include: {
    payment: {
      include: {
        ancillarySelection: {
          include: {
            seatSelections: true;
            baggageSelections: true;
          };
        };
      };
    };
    bookingIntent: {
      include: {
        passengers: true;
      };
    };
    activeDisruptionRevision: {
      include: {
        segments: { orderBy: { globalOrder: 'asc' } };
        notificationOutbox: true;
      };
    };
    itineraryRevisions: {
      orderBy: { version: 'desc' };
      take: 1;
      include: { segments: { orderBy: { globalOrder: 'asc' } } };
    };
  };
}>;
