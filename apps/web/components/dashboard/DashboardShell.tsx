import Link from 'next/link';
import { Calendar, Compass, LayoutDashboard, Plane, User, type LucideIcon } from 'lucide-react';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardShellProps = {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  showProfileNavigation?: boolean;
  children: React.ReactNode;
};

type NavigationItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: LucideIcon;
};

const navigationItems: NavigationItem[] = [
  { href: '/dashboard', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard },
  { href: '/search', label: 'Search flights', shortLabel: 'Search', icon: Plane },
  { href: '/bookings', label: 'My bookings', shortLabel: 'Bookings', icon: Calendar },
];

export function DashboardShell({
  user,
  showProfileNavigation = false,
  children,
}: DashboardShellProps): JSX.Element {
  const classes = styles ?? {};
  const displayName = user.name?.trim() || user.email?.trim() || 'Traveler';
  const avatarLabel = displayName.charAt(0).toLocaleUpperCase();
  const visibleNavigationItems: NavigationItem[] = showProfileNavigation
    ? [
        ...navigationItems,
        { href: '/profile', label: 'Traveler profile', shortLabel: 'Profile', icon: User },
      ]
    : navigationItems;

  return (
    <div className={classes.dashboardRoot}>
      <aside className={classes.sidebar} aria-label="Dashboard navigation">
        <div className={classes.sidebarHeader}>
          <Link className={classes.sidebarBrand} href="/dashboard">
            <span className={classes.brandMark} aria-hidden="true">
              <Compass className={classes.brandIcon} />
            </span>
            <span className={classes.brandText}>
              <span className={classes.brandTitle}>Wayfinder</span>
              <span className={classes.brandSubtitle}>Intelligent Travel Desk</span>
            </span>
          </Link>
        </div>
        <nav className={classes.sidebarNav}>
          {visibleNavigationItems.map((item) => {
            const isCurrent = item.href === '/dashboard';
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                className={`${classes.sidebarLink} ${isCurrent ? classes.sidebarLinkCurrent : ''}`}
                href={item.href}
                aria-current={isCurrent ? 'page' : undefined}
              >
                <Icon className={classes.sidebarLinkIcon} aria-hidden="true" />
                <span className={classes.sidebarLinkLabel}>{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className={classes.contentFrame}>
        <header className={classes.header}>
          <div className={classes.headerContext}>
            <p className={classes.headerSubtitle}>Travel overview</p>
            <h1 className={classes.headerTitle}>
              Find Your Way. <span className={classes.headerAccent}>Do More.</span>
            </h1>
          </div>
          <div className={classes.userBadge} aria-label={`Signed in as ${displayName}`}>
            <span className={classes.userAvatar} aria-hidden="true">
              {user.image?.trim() ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={user.image}
                  alt={displayName}
                  className={classes.userAvatarImage}
                />
              ) : (
                avatarLabel
              )}
            </span>
          </div>
        </header>

        <main id="main-content" className={classes.main}>
          {children}
        </main>
      </div>

      <nav className={classes.mobileNav} aria-label="Mobile dashboard navigation">
        {visibleNavigationItems.map((item) => {
          const isCurrent = item.href === '/dashboard';
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              className={`${classes.mobileNavLink} ${isCurrent ? classes.mobileNavLinkCurrent : ''}`}
              href={item.href}
              aria-current={isCurrent ? 'page' : undefined}
            >
              <Icon className={classes.mobileNavIcon} aria-hidden="true" />
              <span className={classes.mobileNavLabel}>{item.shortLabel}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
