import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { DashboardRecentBookings } from '@/components/dashboard/DashboardRecentBookings';
import { DashboardQuickActions } from '@/components/dashboard/DashboardQuickActions';
import { DashboardQuickSearch } from '@/components/dashboard/DashboardQuickSearch';
import { DashboardShell } from '@/components/dashboard/DashboardShell';
import { DashboardStats } from '@/components/dashboard/DashboardStats';
import { buildDashboardActions } from '@/components/dashboard/dashboard-actions';
import { cookies } from 'next/headers';
import { authOptions } from '@/lib/auth';
import { isBookingReadinessEnabled } from '@/lib/featureFlags';
import { getDashboardSummary } from '@/lib/server/dashboard';
import styles from './dashboard.module.css';

export const dynamic = 'force-dynamic';

export default async function DashboardPage(): Promise<JSX.Element> {
  const outcome = await getDashboardSummary();

  if (!outcome.ok) {
    if (outcome.reason === 'UNAUTHENTICATED') {
      redirect('/login?callbackUrl=/dashboard');
    }

    throw new Error('Unable to load dashboard.');
  }

  const session = await getServerSession(authOptions);
  const user = {
    name: session?.user?.name,
    email: session?.user?.email,
  };

  let showProfileNavigation = isBookingReadinessEnabled();
  if (process.env.NODE_ENV === 'test' || process.env.CI === 'true') {
    try {
      const mockScenario = cookies().get('mock-scenario')?.value;
      if (mockScenario === 'dashboard-readiness-disabled') {
        showProfileNavigation = false;
      } else if (mockScenario === 'dashboard-readiness-enabled') {
        showProfileNavigation = true;
      }
    } catch {
      // Fallback in unit test environments without requestAsyncStorage
    }
  }

  const dashboardActions = buildDashboardActions({
    isBookingReadinessEnabled: showProfileNavigation,
  });

  const classes = styles ?? {};

  return (
    <DashboardShell user={user} showProfileNavigation={showProfileNavigation}>
      <section className={classes.quickSearchSection} aria-labelledby="quick-search-heading">
        <h2 id="quick-search-heading" className={classes.visuallyHidden}>
          Quick Search
        </h2>
        <DashboardQuickSearch />
      </section>

      <div className={classes.dashboardColumns}>
        <DashboardStats stats={outcome.data.stats} />
        <DashboardQuickActions actions={dashboardActions} />
      </div>

      <DashboardRecentBookings recentBookings={outcome.data.recentBookings} />
    </DashboardShell>
  );
}
