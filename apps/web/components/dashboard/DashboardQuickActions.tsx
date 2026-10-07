import Link from 'next/link';
import { Calendar, History, Plane, User, type LucideIcon } from 'lucide-react';
import type { DashboardAction } from './dashboard-actions';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardQuickActionsProps = {
  actions: DashboardAction[];
};

const icons: Record<DashboardAction['iconName'], LucideIcon> = {
  plane: Plane,
  calendar: Calendar,
  history: History,
  user: User,
};

export function DashboardQuickActions({ actions }: DashboardQuickActionsProps): JSX.Element {
  const classes = styles ?? {};

  return (
    <section aria-label="Quick Actions" className={classes.quickActionsGrid}>
      {actions.map((action) => {
        const Icon = icons[action.iconName];

        return (
          <Link
            key={action.id}
            href={action.href}
            className={`${classes.actionCard} ${classes[`actionCard_${action.id}`] ?? ''}`}
          >
            <span
              className={`${classes.actionIconPill} ${classes[`actionPill_${action.id}`] ?? ''}`}
              aria-hidden="true"
            >
              <Icon className={classes.actionCardIcon} />
            </span>
            <span className={classes.actionCardContent}>
              <span className={classes.actionCardHeading}>{action.label}</span>
              <span className={classes.actionCardDescription}>{action.description}</span>
            </span>
          </Link>
        );
      })}
    </section>
  );
}
