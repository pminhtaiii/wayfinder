import Link from 'next/link';
import styles from '@/app/dashboard/dashboard.module.css';

type DashboardShellProps = {
  user: {
    name?: string | null;
    email?: string | null;
  };
  showProfileNavigation?: boolean;
  children: React.ReactNode;
};

type NavigationItem = {
  href: string;
  label: string;
  shortLabel: string;
};

const navigationItems: NavigationItem[] = [
  { href: '/dashboard', label: 'Overview', shortLabel: 'Home' },
  { href: '/search', label: 'Search flights', shortLabel: 'Search' },
  { href: '/bookings', label: 'My bookings', shortLabel: 'Bookings' },
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
    ? [...navigationItems, { href: '/profile', label: 'Traveler profile', shortLabel: 'Profile' }]
    : navigationItems;

  return (
    <div className={classes.dashboardRoot}>
      <aside className={classes.sidebar} aria-label="Dashboard navigation">
        <Link className={classes.sidebarBrand} href="/dashboard">
          <span className={classes.brandMark} aria-hidden="true">
            W
          </span>
          <span>Wayfinder</span>
        </Link>
        <nav className={classes.sidebarNav}>
          {visibleNavigationItems.map((item) => (
            <Link
              key={item.href}
              className={`${classes.sidebarLink} ${item.href === '/dashboard' ? classes.sidebarLinkCurrent : ''}`}
              href={item.href}
              aria-current={item.href === '/dashboard' ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
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
              {avatarLabel}
            </span>
            <span className={classes.userDetails}>
              <span className={classes.userName}>{displayName}</span>
              {user.name?.trim() && user.email?.trim() ? (
                <span className={classes.userEmail}>{user.email}</span>
              ) : null}
            </span>
          </div>
        </header>

        <main id="main-content" className={classes.main}>
          {children}
        </main>
      </div>

      <nav className={classes.mobileNav} aria-label="Mobile dashboard navigation">
        {visibleNavigationItems.map((item) => (
          <Link
            key={item.href}
            className={`${classes.mobileNavLink} ${item.href === '/dashboard' ? classes.mobileNavLinkCurrent : ''}`}
            href={item.href}
            aria-current={item.href === '/dashboard' ? 'page' : undefined}
          >
            {item.shortLabel}
          </Link>
        ))}
      </nav>
    </div>
  );
}
