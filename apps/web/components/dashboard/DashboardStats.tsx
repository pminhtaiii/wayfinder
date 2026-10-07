import { Calendar, CheckCircle2, Plane, XCircle, type LucideIcon } from 'lucide-react';
import type { DashboardStats as DashboardStatsData } from '@shared/types';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardStatsProps = {
  stats: DashboardStatsData;
};

type Metric = {
  label: string;
  value: number;
  icon: LucideIcon;
  className: string;
};

export function DashboardStats({ stats }: DashboardStatsProps) {
  const classes = styles ?? {};

  const metrics: Metric[] = [
    {
      label: 'Total Bookings',
      value: stats.totalBookings,
      icon: Plane,
      className: classes.totalMetric ?? '',
    },
    {
      label: 'Upcoming Bookings',
      value: stats.upcomingBookings,
      icon: Calendar,
      className: classes.upcomingMetric ?? '',
    },
    {
      label: 'Completed Bookings',
      value: stats.completedBookings,
      icon: CheckCircle2,
      className: classes.completedMetric ?? '',
    },
    {
      label: 'Cancelled Bookings',
      value: stats.cancelledBookings,
      icon: XCircle,
      className: classes.cancelledMetric ?? '',
    },
  ];

  return (
    <section className={classes.statsSection} aria-labelledby="dashboard-stats-heading">
      <h2 id="dashboard-stats-heading" className={classes.visuallyHidden}>
        Booking statistics
      </h2>
      <div className={classes.statsGrid}>
        {metrics.map(({ label, value, icon: Icon, className }) => (
          <article key={label} className={`${classes.metricCard} ${className}`}>
            <div className={classes.metricHeading}>
              <h3 className={classes.metricLabel}>{label}</h3>
              <Icon className={classes.metricIcon} aria-hidden="true" />
            </div>
            <p className={classes.metricValue}>{value}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
