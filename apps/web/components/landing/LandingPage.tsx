'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Compass,
  Plane,
  PlaneTakeoff,
  PlaneLanding,
  ArrowRight,
  Search,
  Calendar,
  ArrowLeftRight,
  TrendingDown,
  TrendingUp,
  Star,
  Globe,
  Cpu,
  Leaf,
  Radar,
  Navigation,
  Armchair,
  ChevronDown,
  Activity,
  CheckCircle2,
} from 'lucide-react';
import styles from './landing-page.module.css';

type TripMode = 'round-trip' | 'one-way' | 'multi-city';

interface TrendingFlight {
  originCode: string;
  originCity: string;
  destCode: string;
  destCity: string;
  duration: string;
  trendText: string;
  trendPositive: boolean;
  aircraft: string;
  cabin: string;
  price: string;
}

const TRENDING_CORRIDORS: readonly TrendingFlight[] = [
  {
    originCode: 'SFO',
    originCity: 'San Francisco',
    destCode: 'HND',
    destCity: 'Tokyo Haneda',
    duration: 'Direct 11h 15m',
    trendText: 'Trend: -14% (Lowest 30d)',
    trendPositive: false,
    aircraft: 'Boeing 787-9',
    cabin: 'Lie-Flat Suite',
    price: '$1,180',
  },
  {
    originCode: 'JFK',
    originCity: 'New York',
    destCode: 'LHR',
    destCity: 'London Heathrow',
    duration: 'Direct 7h 05m',
    trendText: 'Trend: -8% (Dip detected)',
    trendPositive: false,
    aircraft: 'Airbus A350-1000',
    cabin: 'Club Suite Door',
    price: '$890',
  },
  {
    originCode: 'SIN',
    originCity: 'Singapore Changi',
    destCode: 'SYD',
    destCity: 'Sydney Kingsford',
    duration: 'Direct 7h 50m',
    trendText: 'Trend: +2% (Fares rising)',
    trendPositive: true,
    aircraft: 'Boeing 777-300ER',
    cabin: 'First Class Pod',
    price: '$640',
  },
  {
    originCode: 'ZRH',
    originCity: 'Zurich Airport',
    destCode: 'DXB',
    destCity: 'Dubai Intl',
    duration: 'Direct 6h 15m',
    trendText: 'Trend: -11% (Optimal)',
    trendPositive: false,
    aircraft: 'Airbus A380-800',
    cabin: 'Onboard Shower',
    price: '$720',
  },
];

interface Testimonial {
  initials: string;
  name: string;
  role: string;
  quote: string;
}

const TESTIMONIALS: readonly Testimonial[] = [
  {
    initials: 'MV',
    name: 'Marcus Vance',
    role: 'Partner, Sequoia Apex Capital',
    quote:
      'Wayfinder’s price arbitrage algorithm booked our executive team on SFO-HND First Suites at $1,180 when standard portals were charging $2,900. It’s essentially Bloomberg for aviation.',
  },
  {
    initials: 'ER',
    name: 'Dr. Elena Rostova',
    role: 'Aerospace Chief Scientist, Hyperion',
    quote:
      'The seat concierge alone makes this indispensable. Being able to inspect individual suite pitch, Starlink connectivity, and bulkhead legroom before booking saved countless red-eyes.',
  },
  {
    initials: 'JT',
    name: 'Julian Thorne',
    role: 'VP Operations, CloudScale Global',
    quote:
      'The frosted glass interface is ridiculously gorgeous and fast. We managed our 140-person enterprise travel budget with full alliance points optimization without touching legacy clunky travel agents.',
  },
];

function formatSampleDate(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
}

export function LandingPage(): JSX.Element {
  const router = useRouter();
  const [tripMode, setTripMode] = useState<TripMode>('round-trip');
  const [originStation, setOriginStation] = useState({ code: 'SFO', city: 'San Francisco, CA' });
  const [destStation, setDestStation] = useState({ code: 'HND', city: 'Tokyo Haneda, JP' });
  const [signupEmail, setSignupEmail] = useState('');

  const departureDateText = formatSampleDate(14);
  const returnDateText = formatSampleDate(25);

  const handleSwapStations = (): void => {
    setOriginStation(destStation);
    setDestStation(originStation);
  };

  const handleSignupSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const trimmed = signupEmail.trim();
    if (trimmed) {
      router.push(`/register?email=${encodeURIComponent(trimmed)}`);
    } else {
      router.push('/register');
    }
  };

  return (
    <div className={styles.page}>
      {/* ========================================================================= */}
      {/* 1. FLOATING FROSTED GLASS HEADER (TopNavBar)                              */}
      {/* ========================================================================= */}
      <header className={styles.header}>
        <div className={`${styles.glassDeck} ${styles.headerInner}`}>
          {/* Brand Logo */}
          <Link href="/" className={styles.brand} aria-label="Wayfinder home">
            <span className={styles.brandCompass} aria-hidden="true">
              <Compass size={28} strokeWidth={2.2} />
            </span>
            <span>
              Wayfinder<span className={styles.brandDegree}>°</span>
            </span>
          </Link>

          {/* Desktop Navigation Links */}
          <nav className={styles.navLinks} aria-label="Primary site navigation">
            <a href="#search-engine" className={styles.navLinkActive}>
              Flights
            </a>
            <a href="#route-engine" className={styles.navLink}>
              Route Engine
            </a>
            <a href="#fare-intelligence" className={styles.navLink}>
              Fare Intelligence
            </a>
            <a href="#corporate-travel" className={styles.navLink}>
              Corporate Travel
            </a>
            <a href="#routes" className={styles.navLink}>
              Pricing
            </a>
          </nav>

          {/* Trailing Action Cluster */}
          <div className={styles.navActions}>
            <div className={styles.adsbPill} aria-label="ADS-B telemetry status: Live">
              <span className={styles.pulseDot} aria-hidden="true" />
              <span>ADS-B LIVE</span>
            </div>

            <Link href="/login" className={styles.signInLink}>
              Log in
            </Link>

            <Link href="/register" className={`${styles.cyanGlowButton} ${styles.launchButton}`}>
              <span>Launch Wayfinder</span>
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </div>
      </header>

      {/* ========================================================================= */}
      {/* 2. HERO SECTION: Asymmetric Split with Search Console                     */}
      {/* ========================================================================= */}
      <main>
        <section className={styles.heroSection} aria-labelledby="hero-main-title">
          <div className={styles.heroContainer}>
            <div className={styles.heroGrid}>
              {/* Left Column: Narrative & Value Proposition */}
              <div className={styles.heroNarrative}>
                {/* Luminous Status Chip */}
                <div className={`${styles.glassDeckSubtle} ${styles.statusChip}`}>
                  <span className={styles.pulseDot} aria-hidden="true" />
                  <span className={styles.statusChipText}>
                    Wayfinder 3.0 · Real-Time Aviation Intelligence
                  </span>
                </div>

                <div className={styles.heroHeadlineContainer}>
                  {/* Eyebrow & Reassurance required for dashboard.spec.ts */}
                  <p className={styles.heroEyebrow}>
                    Your intelligent travel desk · From “I need to go” to cleared for takeoff.
                  </p>
                  <h1 id="hero-main-title" className={styles.heroHeadline}>
                    Precision Air Travel, <br />
                    <span className={styles.gradientHeadlineText}>Redefined.</span>
                  </h1>
                </div>

                <p className={styles.heroSubtitle}>
                  Search, book, and orchestrate global flights with algorithmic fare tracking,
                  automated re-booking, and crystalline transparent pricing.
                </p>

                {/* Trust Metrics Row */}
                <div className={styles.trustMetricsRow}>
                  <div className={`${styles.glassDeck} ${styles.metricBadge}`}>
                    <CheckCircle2 size={16} color="#00bfff" aria-hidden="true" />
                    <span>
                      <strong>42,000+</strong> flights tracked daily
                    </span>
                  </div>

                  <div className={`${styles.glassDeck} ${styles.metricBadge}`}>
                    <Activity size={16} color="#047857" aria-hidden="true" />
                    <span className={styles.metricBadgeGreen}>
                      $14M saved in fare arbitrage
                    </span>
                  </div>

                  <div className={`${styles.glassDeck} ${styles.metricBadge}`}>
                    <Star size={15} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                    <span>
                      <strong>4.9/5</strong> (18,000+ aviators)
                    </span>
                  </div>
                </div>

                {/* Primary Hero CTAs */}
                <div className={styles.heroActions}>
                  <Link
                    href="/login"
                    className={`${styles.cyanGlowButton} ${styles.heroPrimaryBtn}`}
                  >
                    <PlaneTakeoff size={18} aria-hidden="true" />
                    <span>Book Your Journey</span>
                  </Link>

                  <a
                    href="#route-engine"
                    className={`${styles.glassButton} ${styles.heroSecondaryBtn}`}
                  >
                    <span>Explore Route Engine</span>
                    <ArrowRight size={16} color="#00bfff" aria-hidden="true" />
                  </a>
                </div>

                {/* Telemetry Specs Footnote */}
                <div className={styles.heroFootnote}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                    <span className={styles.pulseDotGreen} aria-hidden="true" />
                    ADS-B Multilateration Latency: 142ms
                  </span>
                  <span aria-hidden="true">•</span>
                  <span>Direct GDS & NDC Protocol v21.3</span>
                </div>
              </div>

              {/* Right Column: Monolithic Flight Search Deck */}
              <div className={styles.searchConsoleWrapper} id="search-engine">
                <div className={styles.ambientGlow} aria-hidden="true" />

                <div className={`${styles.glassDeck} ${styles.searchConsoleDeck}`}>
                  {/* Trip Mode Switcher */}
                  <div className={styles.tripModeHeader}>
                    <div className={styles.tripModeTabs} role="radiogroup" aria-label="Trip type">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={tripMode === 'round-trip'}
                        onClick={(): void => setTripMode('round-trip')}
                        className={
                          tripMode === 'round-trip'
                            ? styles.tripModeTabActive
                            : styles.tripModeTabInactive
                        }
                      >
                        Round Trip
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={tripMode === 'one-way'}
                        onClick={(): void => setTripMode('one-way')}
                        className={
                          tripMode === 'one-way'
                            ? styles.tripModeTabActive
                            : styles.tripModeTabInactive
                        }
                      >
                        One Way
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={tripMode === 'multi-city'}
                        onClick={(): void => setTripMode('multi-city')}
                        className={
                          tripMode === 'multi-city'
                            ? styles.tripModeTabActive
                            : styles.tripModeTabInactive
                        }
                      >
                        Multi-City
                      </button>
                    </div>

                    <div className={styles.arbitrageBadge}>
                      <TrendingDown size={14} aria-hidden="true" />
                      <span>Fares down 14%</span>
                    </div>
                  </div>

                  {/* Origin & Destination with Swap Control */}
                  <div className={styles.originDestGrid}>
                    {/* Origin */}
                    <div className={styles.stationCard}>
                      <div className={styles.stationCardHeader}>
                        <span>ORIGIN RUNWAY</span>
                        <PlaneTakeoff size={14} color="#64748b" aria-hidden="true" />
                      </div>
                      <div className={styles.stationCardCode}>
                        <span className={styles.stationIata}>{originStation.code}</span>
                        <span className={styles.stationName}>{originStation.city}</span>
                      </div>
                      <div className={styles.stationCardDate}>
                        <Calendar size={13} aria-hidden="true" />
                        <span>{departureDateText}</span>
                      </div>
                    </div>

                    {/* Circular Glass Route Swap */}
                    <button
                      type="button"
                      onClick={handleSwapStations}
                      aria-label="Swap origin and destination"
                      className={styles.routeSwapButton}
                    >
                      <ArrowLeftRight size={15} strokeWidth={2.2} />
                    </button>

                    {/* Destination */}
                    <div className={styles.stationCard}>
                      <div className={styles.stationCardHeader}>
                        <span>DESTINATION</span>
                        <PlaneLanding size={14} color="#64748b" aria-hidden="true" />
                      </div>
                      <div className={styles.stationCardCode}>
                        <span className={styles.stationIata}>{destStation.code}</span>
                        <span className={styles.stationName}>{destStation.city}</span>
                      </div>
                      {tripMode !== 'one-way' ? (
                        <div className={styles.stationCardDate}>
                          <Calendar size={13} aria-hidden="true" />
                          <span>{returnDateText}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {/* Passengers & Cabin Preference */}
                  <div className={styles.cabinSelectCard}>
                    <div className={styles.cabinSelectLeft}>
                      <div className={styles.cabinIconWrap} aria-hidden="true">
                        <Armchair size={17} />
                      </div>
                      <div>
                        <div className={styles.cabinLabel}>Passengers & Cabin</div>
                        <div className={styles.cabinValue}>1 Passenger · First Suite (Lie-Flat)</div>
                      </div>
                    </div>
                    <ChevronDown size={16} color="#64748b" aria-hidden="true" />
                  </div>

                  {/* Primary Search CTA */}
                  <Link
                    href="/login"
                    className={`${styles.cyanGlowButton} ${styles.searchSubmitBtn}`}
                  >
                    <Search size={18} aria-hidden="true" />
                    <span>Search Real-Time Fares · $1,180 avg</span>
                  </Link>

                  {/* Contextual Verified Route Strip */}
                  <div className={styles.verifiedRouteSnippet}>
                    <div className={styles.verifiedRouteLeft}>
                      <span className={styles.pulseDotGreen} aria-hidden="true" />
                      <strong>Flight WF-892</strong>
                      <span style={{ color: '#64748b' }}>·</span>
                      <span>Direct 11h 15m (B787-9)</span>
                    </div>
                    <div className={styles.verifiedRouteRight}>
                      <span className={styles.verifiedRoutePrice}>$1,180</span>
                      <span className={styles.verifiedRouteBadge}>Guaranteed AI Low</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 3. AIRLINE ALLIANCE & GLOBAL COVERAGE STRIP                               */}
        {/* ========================================================================= */}
        <section className={styles.alliancesSection} id="alliances" aria-label="Airline Alliances">
          <div className={styles.alliancesContainer}>
            <div className={styles.alliancesInner}>
              <div className={styles.alliancesTitle}>
                <Globe size={22} color="#00bfff" aria-hidden="true" />
                <span>Universal Alliance & Carrier Coverage</span>
              </div>

              <div className={styles.alliancesBadgesRow}>
                <div className={`${styles.glassDeck} ${styles.allianceBadgeCard}`}>
                  <span style={{ color: '#00668a', fontWeight: 800 }}>★</span>
                  <strong>Star Alliance</strong>
                  <span className={styles.allianceCount}>(26 Airlines)</span>
                </div>

                <div className={`${styles.glassDeck} ${styles.allianceBadgeCard}`}>
                  <span style={{ color: '#006591', fontWeight: 800 }}>●</span>
                  <strong>SkyTeam</strong>
                  <span className={styles.allianceCount}>(19 Airlines)</span>
                </div>

                <div className={`${styles.glassDeck} ${styles.allianceBadgeCard}`}>
                  <span style={{ color: '#00bfff', fontWeight: 800 }}>◆</span>
                  <strong>oneworld</strong>
                  <span className={styles.allianceCount}>(13 Airlines)</span>
                </div>

                <div className={styles.allianceStatsDivider}>
                  <span>
                    <strong style={{ color: '#00668a' }}>600+</strong> Airlines Connected
                  </span>
                  <span style={{ color: '#cbd5e1' }}>·</span>
                  <span>
                    <strong style={{ color: '#047857' }}>99.8%</strong> Direct GDS Accuracy
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 4. ASYMMETRIC BENTO GRID FEATURES                                         */}
        {/* ========================================================================= */}
        <section
          className={styles.bentoSection}
          id="route-engine"
          aria-labelledby="bento-heading"
        >
          <div className={styles.heroContainer}>
            <div className={styles.sectionHeader}>
              <div className={`${styles.glassDeck} ${styles.sectionEyebrow}`}>
                <Cpu size={15} color="#00bfff" aria-hidden="true" />
                <span>ALGORITHMIC AERODYNAMICS</span>
              </div>
              <h2 id="bento-heading" className={styles.sectionHeading}>
                Next-Generation Flight Engineering
              </h2>
              <p className={styles.sectionSubtext}>
                Wayfinder synthesizes billions of atmospheric telemetry variables, airline inventory
                dips, and route configurations in microsecond intervals.
              </p>
            </div>

            <div className={styles.bentoGrid}>
              {/* Feature 01: Algorithmic Fare Arbitrage (7 Cols) */}
              <div
                className={`${styles.glassDeck} ${styles.bentoCard7}`}
                id="fare-intelligence"
              >
                <div>
                  <div className={styles.bentoHeaderRow}>
                    <span className={styles.bentoBadge}>FEATURE 01 · ARBITRAGE</span>
                    <span
                      className={styles.bentoTelemetryLabel}
                      style={{ color: 'var(--wf-tertiary)' }}
                    >
                      <Activity size={15} aria-hidden="true" />
                      CONFIDENCE: 94%
                    </span>
                  </div>
                  <h3 className={styles.bentoCardTitle}>Algorithmic Fare Arbitrage</h3>
                  <p className={styles.bentoCardDesc}>
                    Our neural pricing engine models 21-day booking anomalies and automatically
                    triggers purchase locks right before airline fare bucket recalibrations.
                  </p>
                </div>

                {/* 21-Day Fare Curve Visualization */}
                <div className={styles.chartContainer}>
                  <div className={styles.chartHeader}>
                    <strong>Route SFO ➔ HND (21-Day Fare Trajectory)</strong>
                    <span
                      style={{
                        padding: '0.2rem 0.6rem',
                        borderRadius: '9999px',
                        background: 'rgba(16, 185, 129, 0.15)',
                        color: 'var(--wf-tertiary)',
                        fontWeight: 700,
                        fontSize: '0.6875rem',
                      }}
                    >
                      OPTIMAL WINDOW: BUY NOW
                    </span>
                  </div>

                  <div className={styles.chartBarsWrapper}>
                    <div className={styles.chartBarDefault} style={{ height: '80%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '75%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '85%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '65%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '55%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '50%' }} />
                    {/* Optimal Dip Bar */}
                    <div className={styles.chartBarOptimal} style={{ height: '32%' }}>
                      <span className={styles.chartBarCallout}>$1,180</span>
                    </div>
                    <div className={styles.chartBarDefault} style={{ height: '48%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '68%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '78%' }} />
                    <div className={styles.chartBarDefault} style={{ height: '90%' }} />
                  </div>

                  <div className={styles.chartTimeAxis}>
                    <span>Day -21</span>
                    <span>Day -14</span>
                    <strong style={{ color: 'var(--wf-primary)' }}>TODAY (Lock $1,180)</strong>
                    <span>Day +7</span>
                    <span>Day +14</span>
                  </div>
                </div>
              </div>

              {/* Feature 02: Intelligent Multi-Leg Routing (5 Cols) */}
              <div className={`${styles.glassDeck} ${styles.bentoCard5}`}>
                <div>
                  <div className={styles.bentoHeaderRow}>
                    <span className={styles.bentoBadgeSecondary}>FEATURE 02 · ATMOSPHERICS</span>
                    <span
                      className={styles.bentoTelemetryLabel}
                      style={{ color: 'var(--wf-primary)' }}
                    >
                      <Navigation size={15} aria-hidden="true" />
                      JETSTREAM LIVE
                    </span>
                  </div>
                  <h3 className={styles.bentoCardTitle}>Intelligent Multi-Leg Routing</h3>
                  <p className={styles.bentoCardDesc}>
                    Dynamic great-circle navigation that leverages high-altitude tailwinds and avoids
                    airport congestion zones.
                  </p>
                </div>

                <div className={styles.vectorBox}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.75rem',
                    }}
                  >
                    <strong>SFO ➔ HND Great Circle Vector</strong>
                    <span
                      style={{
                        color: 'var(--wf-tertiary)',
                        fontWeight: 700,
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <Leaf size={14} aria-hidden="true" />
                      -28% CO₂ Emission
                    </span>
                  </div>

                  <div className={styles.vectorProgressTrack}>
                    <div className={styles.vectorProgressBar} />
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6875rem',
                      color: 'var(--wf-outline)',
                    }}
                  >
                    <span>37°37&apos;N 122°22&apos;W</span>
                    <strong style={{ color: 'var(--wf-primary)' }}>+42 kts Tailwind Assist</strong>
                    <span>35°33&apos;N 139°46&apos;E</span>
                  </div>

                  <div className={styles.vectorGridStats}>
                    <div className={styles.statItemBox}>
                      <div style={{ color: 'var(--wf-outline)' }}>Cruise Altitude</div>
                      <strong>FL390 (39,000 ft)</strong>
                    </div>
                    <div className={styles.statItemBox}>
                      <div style={{ color: 'var(--wf-outline)' }}>Ground Speed</div>
                      <strong>542 kts (624 mph)</strong>
                    </div>
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.6875rem',
                    color: 'var(--wf-outline)',
                  }}
                >
                  <Navigation size={13} color="#00bfff" aria-hidden="true" />
                  <span>Optimized against North Pacific Route System (NOPAC)</span>
                </div>
              </div>

              {/* Feature 03: Instant Seat Concierge (12 Cols) */}
              <div
                className={`${styles.glassDeck} ${styles.bentoCard12}`}
                id="seat-concierge"
              >
                <div className={styles.seatConciergeGrid}>
                  <div>
                    <span className={styles.bentoBadge}>FEATURE 03 · HARDWARE TELEMETRY</span>
                    <h3 className={styles.bentoCardTitle} style={{ marginTop: '0.75rem' }}>
                      Instant Seat Concierge & Cabin Precision
                    </h3>
                    <p className={styles.bentoCardDesc}>
                      Know your seat pitch, exact lie-flat bed angle, USB-C Power Delivery wattage,
                      and Starlink LEO satellite Wi-Fi availability before tapping book.
                    </p>

                    <div className={styles.seatFeatureChips}>
                      <span className={styles.seatFeatureChip}>180° Full Flat Bed</span>
                      <span className={styles.seatFeatureChip}>Direct Aisle Access</span>
                      <span className={styles.seatFeatureChip}>Ku-Band High Speed Wi-Fi</span>
                      <span className={styles.seatFeatureChip}>B&amp;O Noise Reduction</span>
                    </div>
                  </div>

                  {/* Seat Architecture Schematic Card */}
                  <div className={styles.seatMapCard}>
                    <div className={styles.seatMapHeader}>
                      <div>
                        <strong>AIRCRAFT: Boeing 787-9 Dreamliner</strong>
                        <span style={{ color: 'var(--wf-outline)' }}> · Polaris 1-2-1 Layout</span>
                      </div>
                      <span
                        style={{
                          padding: '0.2rem 0.6rem',
                          borderRadius: '9999px',
                          background: '#0284c7',
                          color: '#ffffff',
                          fontWeight: 700,
                          fontSize: '0.6875rem',
                        }}
                      >
                        SUITE 2A SELECTED
                      </span>
                    </div>

                    <div className={styles.mockSeatGrid}>
                      <div className={styles.seatCellNormal}>Row 1A</div>
                      <div className={styles.seatCellNormal}>Row 1D</div>
                      <div className={styles.seatCellNormal}>Row 1G</div>
                      <div className={styles.seatCellNormal}>Row 1L</div>

                      <div className={styles.seatCellActive}>
                        <span>Suite 2A</span>
                        <span style={{ fontSize: '0.625rem', opacity: 0.9 }}>Lie-Flat 78&quot;</span>
                      </div>
                      <div className={styles.seatCellNormal} style={{ opacity: 0.6 }}>
                        Row 2D (Occ)
                      </div>
                      <div className={styles.seatCellNormal}>Row 2G</div>
                      <div className={styles.seatCellNormal} style={{ opacity: 0.6 }}>
                        Row 2L (Occ)
                      </div>
                    </div>

                    <div
                      style={{
                        marginTop: '1rem',
                        paddingTop: '0.75rem',
                        borderTop: '1px solid rgba(203, 213, 225, 0.3)',
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.6875rem',
                        gap: '0.5rem',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span className={styles.pulseDot} aria-hidden="true" />
                        Suite 2A: Direct window alignment, bulkhead footwell +35% wider volume
                      </span>
                      <strong style={{ color: 'var(--wf-tertiary)' }}>
                        Zero Re-booking Fees Included
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 5. TRENDING GLOBAL CORRIDORS                                              */}
        {/* ========================================================================= */}
        <section className={styles.routesSection} id="routes" aria-labelledby="routes-heading">
          <div className={styles.heroContainer}>
            <div className={styles.routesHeader}>
              <div>
                <div
                  className={`${styles.glassDeck} ${styles.sectionEyebrow}`}
                  style={{ marginBottom: '0.5rem' }}
                >
                  <Radar size={15} color="#00bfff" aria-hidden="true" />
                  <span>LIVE AIR ARBITRAGE RADAR</span>
                </div>
                <h2 id="routes-heading" className={styles.sectionHeading}>
                  Prime Global Corridors
                </h2>
                <p className={styles.sectionSubtext}>
                  Live updates gathered from international carrier GDS feeds every 120 seconds.
                </p>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.75rem',
                  color: 'var(--wf-on-surface-variant)',
                }}
              >
                <span className={styles.pulseDotGreen} aria-hidden="true" />
                <span>Telemetry stream synchronized</span>
              </div>
            </div>

            <div className={styles.routesStack}>
              {TRENDING_CORRIDORS.map((corridor) => (
                <div
                  key={`${corridor.originCode}-${corridor.destCode}`}
                  className={`${styles.glassCardInteractive} ${styles.routeCard}`}
                >
                  <div className={styles.routeCardGrid}>
                    {/* Origin / Destination Pair */}
                    <div className={styles.routeCardAirports}>
                      <div>
                        <div className={styles.stationIata}>{corridor.originCode}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--wf-outline)' }}>
                          {corridor.originCity}
                        </div>
                      </div>

                      <div className={styles.flightLineVisual}>
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '0.6875rem',
                            color: 'var(--wf-primary)',
                            fontWeight: 600,
                            marginBottom: '0.25rem',
                          }}
                        >
                          {corridor.duration}
                        </span>
                        <div className={styles.flightTrackBar}>
                          <div className={styles.trackDot} />
                          <div className={styles.trackLine} />
                          <Plane
                            size={16}
                            color="#00bfff"
                            style={{ margin: '0 -0.25rem' }}
                            aria-hidden="true"
                          />
                          <div className={styles.trackLine} />
                          <div className={styles.trackDot} />
                        </div>
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '0.625rem',
                            color: 'var(--wf-outline)',
                            marginTop: '0.25rem',
                          }}
                        >
                          Non-stop
                        </span>
                      </div>

                      <div>
                        <div className={styles.stationIata}>{corridor.destCode}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--wf-outline)' }}>
                          {corridor.destCity}
                        </div>
                      </div>
                    </div>

                    {/* Route Specifications */}
                    <div className={styles.routeCardSpecs}>
                      <span
                        className={styles.specPill}
                        style={{
                          background: corridor.trendPositive
                            ? 'rgba(240, 243, 255, 0.8)'
                            : 'rgba(16, 185, 129, 0.15)',
                          color: corridor.trendPositive ? 'inherit' : 'var(--wf-tertiary)',
                          fontWeight: 700,
                        }}
                      >
                        {corridor.trendPositive ? (
                          <TrendingUp
                            size={12}
                            style={{ display: 'inline', marginRight: '0.35rem' }}
                            aria-hidden="true"
                          />
                        ) : (
                          <TrendingDown
                            size={12}
                            style={{ display: 'inline', marginRight: '0.35rem' }}
                            aria-hidden="true"
                          />
                        )}
                        {corridor.trendText}
                      </span>
                      <span className={styles.specPill}>{corridor.aircraft}</span>
                      <span className={styles.specPill}>{corridor.cabin}</span>
                    </div>

                    {/* Pricing & CTA */}
                    <div className={styles.routeCardPriceAction}>
                      <div className={styles.priceDisplay}>
                        <div className={styles.priceNumber}>{corridor.price}</div>
                        <div className={styles.priceTaxes}>All taxes included</div>
                      </div>

                      <Link
                        href="/login"
                        className={`${styles.cyanGlowButton} ${styles.selectFlightBtn}`}
                      >
                        Select Flight
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 6. EXECUTIVE TRAVELER TESTIMONIALS                                        */}
        {/* ========================================================================= */}
        <section
          className={styles.testimonialsSection}
          id="corporate-travel"
          aria-labelledby="testimonials-heading"
        >
          <div className={styles.heroContainer}>
            <div className={styles.sectionHeader}>
              <div className={`${styles.glassDeck} ${styles.sectionEyebrow}`}>
                <Star size={15} color="#00bfff" aria-hidden="true" />
                <span>VERIFIED EXECUTIVE INTELLIGENCE</span>
              </div>
              <h2 id="testimonials-heading" className={styles.sectionHeading}>
                Trusted by High-Frequency Aviators
              </h2>
              <p className={styles.sectionSubtext}>
                How enterprise directors and frequent flyers optimize routes and preserve travel
                capital.
              </p>
            </div>

            <div className={styles.testimonialsGrid}>
              {TESTIMONIALS.map((item) => (
                <div
                  key={item.name}
                  className={`${styles.glassDeck} ${styles.testimonialCard}`}
                >
                  <div className={styles.starsRow} role="img" aria-label="Rating: 5 out of 5 stars">
                    <Star size={16} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                    <Star size={16} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                    <Star size={16} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                    <Star size={16} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                    <Star size={16} fill="#f59e0b" color="#f59e0b" aria-hidden="true" />
                  </div>

                  <blockquote className={styles.testimonialQuote}>
                    &ldquo;{item.quote}&rdquo;
                  </blockquote>

                  <div className={styles.authorRow}>
                    <div className={styles.authorAvatar}>{item.initials}</div>
                    <div>
                      <div className={styles.authorName}>{item.name}</div>
                      <div className={styles.authorRole}>{item.role}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ========================================================================= */}
        {/* 7. FINAL CALL TO ACTION: Expansive Aura Card                              */}
        {/* ========================================================================= */}
        <section className={styles.ctaSection} aria-labelledby="cta-heading">
          <div className={styles.heroContainer}>
            <div className={`${styles.glassDeck} ${styles.ctaCard}`}>
              <div className={styles.ctaAuraLeft} aria-hidden="true" />
              <div className={styles.ctaAuraRight} aria-hidden="true" />

              <div className={styles.ctaContent}>
                <div className={`${styles.glassDeckSubtle} ${styles.statusChip}`}>
                  <span className={styles.pulseDot} aria-hidden="true" />
                  <span className={styles.statusChipText}>INSTANT TELEMETRY ACCESS</span>
                </div>

                <h2 id="cta-heading" className={styles.ctaHeading}>
                  Start Flying Smarter with Wayfinder.
                </h2>

                <p className={styles.heroSubtitle}>
                  Connect your corporate travel profile or book your next flight with
                  institutional-grade routing intelligence today.
                </p>

                <form
                  className={styles.ctaForm}
                  onSubmit={handleSignupSubmit}
                >
                  <input
                    type="email"
                    name="email"
                    value={signupEmail}
                    onChange={(e): void => setSignupEmail(e.target.value)}
                    placeholder="Enter your work email..."
                    aria-label="Work email address"
                    className={styles.ctaInput}
                  />
                  <button
                    type="submit"
                    className={styles.cyanGlowButton}
                    style={{ padding: '0.85rem 1.5rem', whiteSpace: 'nowrap' }}
                  >
                    Get Started Free
                  </button>
                </form>

                <div className={styles.ctaCheckmarks}>
                  <span>✓ No credit card required</span>
                  <span>✓ Instant GDS sync</span>
                  <span>✓ Cancel anytime</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ========================================================================= */}
      {/* 8. FROSTED STATUS FOOTER                                                  */}
      {/* ========================================================================= */}
      <footer className={styles.footer}>
        <div className={styles.heroContainer}>
          <div className={styles.footerGrid}>
            {/* Brand column */}
            <div className={styles.footerBrandCol}>
              <Link href="/" className={styles.brand} aria-label="Wayfinder home">
                <span className={styles.brandCompass} aria-hidden="true">
                  <Compass size={24} strokeWidth={2.2} />
                </span>
                <span>
                  Wayfinder<span className={styles.brandDegree}>°</span>
                </span>
              </Link>
              <p className={styles.footerBrandDesc}>
                Next-generation flight orchestration platform combining multi-point ADS-B radar
                feeds, GDS pricing arbitrage, and passenger cabin ergonomics.
              </p>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.75rem',
                  color: 'var(--wf-tertiary)',
                }}
              >
                <span className={styles.pulseDotGreen} aria-hidden="true" />
                <span>Flight telemetry systems operational (ADS-B Live)</span>
              </div>
            </div>

            {/* Product Links */}
            <div className={styles.footerNavCol}>
              <div className={styles.footerColTitle}>Product</div>
              <ul className={styles.footerLinksList}>
                <li>
                  <a href="#route-engine" className={styles.footerLink}>
                    Route Engine
                  </a>
                </li>
                <li>
                  <a href="#fare-intelligence" className={styles.footerLink}>
                    Fare Arbitrage
                  </a>
                </li>
                <li>
                  <a href="#seat-concierge" className={styles.footerLink}>
                    Seat Concierge
                  </a>
                </li>
                <li>
                  <a href="#alliances" className={styles.footerLink}>
                    Alliance Matrix
                  </a>
                </li>
                <li>
                  <a href="#routes" className={styles.footerLink}>
                    Global Trajectories
                  </a>
                </li>
              </ul>
            </div>

            {/* Intelligence Links */}
            <div className={styles.footerNavCol}>
              <div className={styles.footerColTitle}>Intelligence</div>
              <ul className={styles.footerLinksList}>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    ADS-B Telemetry
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Jetstream Models
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    NDC Direct Protocol
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Developer API
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    System Uptime
                  </Link>
                </li>
              </ul>
            </div>

            {/* Enterprise Links */}
            <div className={styles.footerNavCol}>
              <div className={styles.footerColTitle}>Enterprise</div>
              <ul className={styles.footerLinksList}>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Corporate Travel
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Expense Concur Sync
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Duty of Care
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Security Audit
                  </Link>
                </li>
                <li>
                  <Link href="/login" className={styles.footerLink}>
                    Contact Sales
                  </Link>
                </li>
              </ul>
            </div>

            {/* Preferences Column */}
            <div className={styles.footerNavCol}>
              <div className={styles.footerColTitle}>Preferences</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <div className={styles.prefBox}>
                  <span style={{ color: 'var(--wf-outline)' }}>Currency</span>
                  <strong style={{ color: 'var(--wf-primary)' }}>USD ($)</strong>
                </div>
                <div className={styles.prefBox}>
                  <span style={{ color: 'var(--wf-outline)' }}>Units</span>
                  <strong style={{ color: 'var(--wf-primary)' }}>Nautical (nm)</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Legal and Copyright */}
          <div className={styles.footerBottom}>
            <div>© {new Date().getFullYear()} Wayfinder Inc. Precision Aviation Telemetry. All rights reserved.</div>
            <div className={styles.footerBottomLinks}>
              <span>Privacy Policy</span>
              <span>Terms of Service</span>
              <span>Security Whitepaper</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
