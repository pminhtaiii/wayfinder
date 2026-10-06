import Link from 'next/link';
import { Plane } from 'lucide-react';
import type { DashboardRecentBooking } from '@shared/types';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardRecentBookingsProps = {
  recentBookings: DashboardRecentBooking[];
};

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeZone: 'UTC',
});

function formatBookingDate(date: string): string {
  return dateFormatter.format(new Date(date));
}

function getStatusClassName(status: DashboardRecentBooking['status']): string {
  const classes = styles ?? {};

  if (status === 'CONFIRMED') {
    return classes.statusConfirmed ?? '';
  }

  if (status === 'COMPLETED') {
    return classes.statusCompleted ?? '';
  }

  if (
    status === 'CANCELLATION_PENDING' ||
    status.startsWith('CANCELLED') ||
    status === 'REFUND_FAILED_NEEDS_ATTENTION'
  ) {
    return classes.statusCancelled ?? '';
  }

  return classes.statusPending ?? '';
}

export function DashboardRecentBookings({ recentBookings }: DashboardRecentBookingsProps) {
  const classes = styles ?? {};
  const visibleBookings = recentBookings.slice(0, 5);

  return (
    <section className={classes.recentBookingsSection} aria-labelledby="recent-bookings-heading">
      <div className={classes.sectionHeader}>
        <h2 id="recent-bookings-heading" className={classes.sectionHeading}>
          Recent bookings
        </h2>
        <Link className={classes.viewAllLink} href="/bookings">
          View all bookings
        </Link>
      </div>

      {visibleBookings.length > 0 ? (
        <ul className={classes.bookingList}>
          {visibleBookings.map((booking) => {
            const displayedDate = booking.departureAt ?? booking.createdAt;

            return (
              <li key={booking.id} className={classes.bookingListItem}>
                <Link className={classes.bookingLink} href={`/bookings/${booking.id}`}>
                  <div className={classes.bookingPrimaryContent}>
                    <p className={classes.flightNumber}>{booking.flightNumber || 'Flight'}</p>
                    {booking.airlineCode ? (
                      <p className={classes.airlineCode}>{booking.airlineCode}</p>
                    ) : null}
                    <p className={classes.bookingRoute}>
                      <span className={classes.routeCode}>{booking.originCode || '—'}</span>
                      <span className={classes.routeSeparator} aria-hidden="true">
                        →
                      </span>
                      <span className={classes.routeCode}>{booking.destinationCode || '—'}</span>
                    </p>
                  </div>
                  <div className={classes.bookingSecondaryContent}>
                    <time className={classes.bookingDate} dateTime={displayedDate}>
                      {formatBookingDate(displayedDate)}
                    </time>
                    <span className={`${classes.statusBadge} ${getStatusClassName(booking.status)}`}>
                      {booking.status}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className={classes.emptyState}>
          <div
            className={classes.emptyStateIllustration}
            role="img"
            aria-label="Empty booking illustration"
          >
            <Plane aria-hidden="true" />
          </div>
          <h3 className={classes.emptyStateHeading}>No bookings yet</h3>
          <p className={classes.emptyStateDescription}>
            Search for a flight to begin planning your next trip.
          </p>
          <Link className={classes.emptyStateAction} href="/search">
            Search Flights
          </Link>
        </div>
      )}
    </section>
  );
}
