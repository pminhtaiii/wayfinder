'use client';

import { type FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Calendar, Plane, Search } from 'lucide-react';
import { buildSearchUrl, validateQuickSearch } from './dashboard-search';
import styles from '@/app/dashboard/dashboard.module.css';

export function DashboardQuickSearch(): JSX.Element {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [departureDate, setDepartureDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();

    const result = validateQuickSearch({ origin, destination, departureDate });
    if (!result.valid) {
      setError(result.error);
      return;
    }

    setError(null);
    router.push(buildSearchUrl(result.value));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const form = event.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    }
  };

  const classes = styles ?? {};

  return (
    <form onSubmit={handleSubmit} className={classes.quickSearchForm} noValidate>
      <div className={classes.quickSearchRow}>
        <div className={classes.quickSearchField}>
          <label htmlFor="dashboard-origin" className={classes.quickSearchLabel}>
            <Plane className={classes.quickSearchFieldIcon} aria-hidden="true" />
            <span>Departure airport code</span>
          </label>
          <input
            id="dashboard-origin"
            value={origin}
            onChange={(event) => setOrigin(event.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={3}
            autoComplete="off"
            placeholder="Origin (e.g. SGN)"
            className={classes.quickSearchInput}
          />
        </div>

        <div className={classes.quickSearchField}>
          <label htmlFor="dashboard-destination" className={classes.quickSearchLabel}>
            <Plane className={classes.quickSearchFieldIcon} aria-hidden="true" />
            <span>Arrival airport code</span>
          </label>
          <input
            id="dashboard-destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            onKeyDown={handleKeyDown}
            maxLength={3}
            autoComplete="off"
            placeholder="Destination (e.g. HAN)"
            className={classes.quickSearchInput}
          />
        </div>

        <div className={classes.quickSearchField}>
          <label htmlFor="dashboard-departure-date" className={classes.quickSearchLabel}>
            <Calendar className={classes.quickSearchFieldIcon} aria-hidden="true" />
            <span>Departure date</span>
          </label>
          <input
            id="dashboard-departure-date"
            type="date"
            value={departureDate}
            onChange={(event) => setDepartureDate(event.target.value)}
            onKeyDown={handleKeyDown}
            className={classes.quickSearchInput}
          />
        </div>

        <div className={classes.quickSearchAction}>
          <button type="submit" className={classes.quickSearchButton}>
            <Search className={classes.searchButtonIcon} aria-hidden="true" />
            <span>Search flights</span>
          </button>
        </div>
      </div>
      {error ? <p role="alert" className={classes.quickSearchAlert}>{error}</p> : null}
    </form>
  );
}
