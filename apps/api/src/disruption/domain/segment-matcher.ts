import { NormalizedSegment } from './itinerary-normalizer';

export interface MatchResult {
  prevSegment: NormalizedSegment;
  currSegment: NormalizedSegment;
  method: 'ID_MATCH' | 'FLIGHT_KEY_MATCH' | 'ROUTE_TIME_MATCH' | 'POSITION_MATCH';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface MatcherOutput {
  matches: MatchResult[];
  added: NormalizedSegment[];
  removed: NormalizedSegment[];
}

export function matchSegments(
  prevSegments: NormalizedSegment[],
  currSegments: NormalizedSegment[],
): MatcherOutput {
  const matchedPrev = new Set<NormalizedSegment>();
  const matchedCurr = new Set<NormalizedSegment>();
  const matches: MatchResult[] = [];

  // Pass 1: Tier 1 - Exact stable supplier segment ID
  for (const prev of prevSegments) {
    if (!prev.supplierSegmentId) continue;
    for (const curr of currSegments) {
      if (matchedCurr.has(curr)) continue;
      if (prev.supplierSegmentId === curr.supplierSegmentId) {
        matches.push({
          prevSegment: prev,
          currSegment: curr,
          method: 'ID_MATCH',
          confidence: 'HIGH',
        });
        matchedPrev.add(prev);
        matchedCurr.add(curr);
        break;
      }
    }
  }

  // Pass 2: Tier 2 - Carrier + flight number + local departure date + departure airport
  const getFlightKey = (seg: NormalizedSegment) => {
    return `${seg.marketingCarrierIata}_${seg.flightNumber}_${seg.departureLocalDate}_${seg.departureAirportIata}`;
  };

  const prevRemainingAfterT1 = prevSegments.filter((s) => !matchedPrev.has(s));
  const currRemainingAfterT1 = currSegments.filter((s) => !matchedCurr.has(s));

  const prevByKey = new Map<string, NormalizedSegment[]>();
  for (const prev of prevRemainingAfterT1) {
    const key = getFlightKey(prev);
    if (!prevByKey.has(key)) prevByKey.set(key, []);
    prevByKey.get(key)!.push(prev);
  }

  const currByKey = new Map<string, NormalizedSegment[]>();
  for (const curr of currRemainingAfterT1) {
    const key = getFlightKey(curr);
    if (!currByKey.has(key)) currByKey.set(key, []);
    currByKey.get(key)!.push(curr);
  }

  for (const [key, prevList] of prevByKey.entries()) {
    const currList = currByKey.get(key);
    if (currList && prevList.length === 1 && currList.length === 1) {
      const prev = prevList[0];
      const curr = currList[0];
      matches.push({
        prevSegment: prev,
        currSegment: curr,
        method: 'FLIGHT_KEY_MATCH',
        confidence: 'HIGH',
      });
      matchedPrev.add(prev);
      matchedCurr.add(curr);
    }
  }

  // Pass 3: Tier 3 - Route + local departure date + nearest departure instant within six hours
  const prevRemainingAfterT2 = prevSegments.filter((s) => !matchedPrev.has(s));
  const currRemainingAfterT2 = currSegments.filter((s) => !matchedCurr.has(s));

  const potentialPairs: { prev: NormalizedSegment; curr: NormalizedSegment; diffMs: number }[] = [];

  for (const prev of prevRemainingAfterT2) {
    const prevTime = Date.parse(prev.departureAt);
    const candidates: { curr: NormalizedSegment; diffMs: number }[] = [];

    for (const curr of currRemainingAfterT2) {
      if (
        prev.departureAirportIata === curr.departureAirportIata &&
        prev.arrivalAirportIata === curr.arrivalAirportIata &&
        prev.departureLocalDate === curr.departureLocalDate
      ) {
        const currTime = Date.parse(curr.departureAt);
        const diffMs = Math.abs(prevTime - currTime);
        if (diffMs <= 6 * 60 * 60 * 1000) {
          candidates.push({ curr, diffMs });
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort((a, b) => a.diffMs - b.diffMs);
      const minDiff = candidates[0].diffMs;
      const closestCandidates = candidates.filter((c) => c.diffMs === minDiff);

      if (closestCandidates.length === 1) {
        potentialPairs.push({
          prev,
          curr: closestCandidates[0].curr,
          diffMs: minDiff,
        });
      }
    }
  }

  potentialPairs.sort((a, b) => a.diffMs - b.diffMs);

  for (const pair of potentialPairs) {
    if (matchedPrev.has(pair.prev) || matchedCurr.has(pair.curr)) {
      continue;
    }
    const ties = potentialPairs.filter((p) => p.curr === pair.curr && p.diffMs === pair.diffMs);
    if (ties.length > 1) {
      continue;
    }

    matches.push({
      prevSegment: pair.prev,
      currSegment: pair.curr,
      method: 'ROUTE_TIME_MATCH',
      confidence: 'MEDIUM',
    });
    matchedPrev.add(pair.prev);
    matchedCurr.add(pair.curr);
  }

  // Pass 4: Tier 4 - Position Match (globalOrder)
  const prevRemainingAfterT3 = prevSegments.filter((s) => !matchedPrev.has(s));
  const currRemainingAfterT3 = currSegments.filter((s) => !matchedCurr.has(s));

  for (const prev of prevRemainingAfterT3) {
    for (const curr of currRemainingAfterT3) {
      if (matchedCurr.has(curr)) continue;
      if (prev.globalOrder === curr.globalOrder) {
        const sameSlice = prev.sliceOrder === curr.sliceOrder;
        const shareDeparture =
          prev.departureAirportIata === curr.departureAirportIata ||
          prev.departureCity === curr.departureCity;
        const shareArrival =
          prev.arrivalAirportIata === curr.arrivalAirportIata ||
          prev.arrivalCity === curr.arrivalCity;
        const relatedRoute = shareDeparture || shareArrival;

        if (!sameSlice || !relatedRoute) {
          continue;
        }

        matches.push({
          prevSegment: prev,
          currSegment: curr,
          method: 'POSITION_MATCH',
          confidence: 'LOW',
        });
        matchedPrev.add(prev);
        matchedCurr.add(curr);
        break;
      }
    }
  }

  matches.sort((a, b) => a.prevSegment.globalOrder - b.prevSegment.globalOrder);

  const added = currSegments.filter((s) => !matchedCurr.has(s));
  const removed = prevSegments.filter((s) => !matchedPrev.has(s));

  return {
    matches,
    added,
    removed,
  };
}
