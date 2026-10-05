import { NormalizedSegment } from './itinerary-normalizer';
import { matchSegments } from './segment-matcher';

export interface SegmentDiff {
  globalOrder: number;
  supplierSegmentId: string | null;
  departureAirportChanged: boolean;
  arrivalAirportChanged: boolean;
  departureLocalDateChanged: boolean;
  arrivalLocalDateChanged: boolean;
  departureTimeShiftMinutes: number;
  arrivalTimeShiftMinutes: number;
  departureTerminalChanged: boolean;
  arrivalTerminalChanged: boolean;
  aircraftTypeChanged: boolean;
}

export interface ConnectionDiff {
  sliceOrder: number;
  prevConnectionMinutes: number | null;
  currConnectionMinutes: number;
  isBelowMct: boolean;
  isOverlapping: boolean;
  isOvernightIntroduced: boolean;
}

export interface SliceDiff {
  sliceOrder: number;
  finalArrivalShiftMinutes: number | null;
  segmentCountDelta: number;
  isRoutingChanged: boolean;
  departureAirportChanged: boolean;
  arrivalAirportChanged: boolean;
}

export interface ItineraryDiffResult {
  segmentDiffs: SegmentDiff[];
  connectionDiffs: ConnectionDiff[];
  sliceDiffs: SliceDiff[];
  isRoutingChanged: boolean;
  addedSegments: NormalizedSegment[];
  removedSegments: NormalizedSegment[];
  presentationSummary: {
    isRoutingChanged: boolean;
    hasStopsChanged: boolean;
    addedSegmentsCount: number;
    removedSegmentsCount: number;
    sliceSummaries: {
      sliceOrder: number;
      originIata: string;
      destinationIata: string;
      finalArrivalShiftMinutes: number | null;
    }[];
  };
}

export function computeItineraryDiff(
  prevSegments: NormalizedSegment[],
  currSegments: NormalizedSegment[],
): ItineraryDiffResult {
  const { matches, added, removed } = matchSegments(prevSegments, currSegments);

  // 1. Segment Diffs
  const segmentDiffs: SegmentDiff[] = matches.map((m) => {
    const prev = m.prevSegment;
    const curr = m.currSegment;
    return {
      globalOrder: curr.globalOrder,
      supplierSegmentId: curr.supplierSegmentId || prev.supplierSegmentId || null,
      departureAirportChanged: prev.departureAirportIata !== curr.departureAirportIata,
      arrivalAirportChanged: prev.arrivalAirportIata !== curr.arrivalAirportIata,
      departureLocalDateChanged: prev.departureLocalDate !== curr.departureLocalDate,
      arrivalLocalDateChanged: prev.arrivalLocalDate !== curr.arrivalLocalDate,
      departureTimeShiftMinutes: Math.round(
        (Date.parse(curr.departureAt) - Date.parse(prev.departureAt)) / (1000 * 60),
      ),
      arrivalTimeShiftMinutes: Math.round(
        (Date.parse(curr.arrivalAt) - Date.parse(prev.arrivalAt)) / (1000 * 60),
      ),
      departureTerminalChanged:
        (prev.departureTerminal || null) !== (curr.departureTerminal || null),
      arrivalTerminalChanged: (prev.arrivalTerminal || null) !== (curr.arrivalTerminal || null),
      aircraftTypeChanged: (prev.aircraftType || null) !== (curr.aircraftType || null),
    };
  });

  // 2. Slice Diffs
  const allSlices = Array.from(
    new Set([...prevSegments.map((s) => s.sliceOrder), ...currSegments.map((s) => s.sliceOrder)]),
  ).sort((a, b) => a - b);

  const sliceDiffs: SliceDiff[] = [];
  let isItineraryRoutingChanged = false;

  for (const sliceOrder of allSlices) {
    const prevInSlice = prevSegments
      .filter((s) => s.sliceOrder === sliceOrder)
      .sort((a, b) => a.segmentOrder - b.segmentOrder);
    const currInSlice = currSegments
      .filter((s) => s.sliceOrder === sliceOrder)
      .sort((a, b) => a.segmentOrder - b.segmentOrder);

    const prevFirst = prevInSlice[0];
    const prevLast = prevInSlice[prevInSlice.length - 1];
    const currFirst = currInSlice[0];
    const currLast = currInSlice[currInSlice.length - 1];

    let isSliceRoutingChanged = false;
    let departureAirportChanged = false;
    let arrivalAirportChanged = false;
    if (prevFirst && currFirst && prevLast && currLast) {
      departureAirportChanged = prevFirst.departureAirportIata !== currFirst.departureAirportIata;
      arrivalAirportChanged = prevLast.arrivalAirportIata !== currLast.arrivalAirportIata;
      isSliceRoutingChanged = departureAirportChanged || arrivalAirportChanged;
    } else if (prevFirst || currFirst) {
      isSliceRoutingChanged = true;
      departureAirportChanged = true;
      arrivalAirportChanged = true;
    }

    if (isSliceRoutingChanged) {
      isItineraryRoutingChanged = true;
    }

    let finalArrivalShiftMinutes: number | null = null;
    if (prevLast && currLast) {
      finalArrivalShiftMinutes = Math.round(
        (Date.parse(currLast.arrivalAt) - Date.parse(prevLast.arrivalAt)) / (1000 * 60),
      );
    }

    sliceDiffs.push({
      sliceOrder,
      finalArrivalShiftMinutes,
      segmentCountDelta: currInSlice.length - prevInSlice.length,
      isRoutingChanged: isSliceRoutingChanged,
      departureAirportChanged,
      arrivalAirportChanged,
    });
  }

  // 3. Connection Diffs
  const connectionDiffs: ConnectionDiff[] = [];
  // Find matched pairs map for lookup
  const prevToCurrMap = new Map<NormalizedSegment, NormalizedSegment>();
  const currToPrevMap = new Map<NormalizedSegment, NormalizedSegment>();
  for (const m of matches) {
    prevToCurrMap.set(m.prevSegment, m.currSegment);
    currToPrevMap.set(m.currSegment, m.prevSegment);
  }

  for (const sliceOrder of allSlices) {
    const currInSlice = currSegments
      .filter((s) => s.sliceOrder === sliceOrder)
      .sort((a, b) => a.segmentOrder - b.segmentOrder);
    for (let i = 0; i < currInSlice.length - 1; i++) {
      const currSeg1 = currInSlice[i];
      const currSeg2 = currInSlice[i + 1];

      const currConnectionMinutes = Math.round(
        (Date.parse(currSeg2.departureAt) - Date.parse(currSeg1.arrivalAt)) / (1000 * 60),
      );
      const isBelowMct = currConnectionMinutes < 60 && currConnectionMinutes >= 0;
      const isOverlapping = currConnectionMinutes < 0;
      const isCurrOvernight = currSeg1.arrivalLocalDate !== currSeg2.departureLocalDate;

      // Try to find if this connection existed in baseline
      const prevSeg1 = currToPrevMap.get(currSeg1);
      const prevSeg2 = currToPrevMap.get(currSeg2);

      let prevConnectionMinutes: number | null = null;
      let isOvernightIntroduced = isCurrOvernight;

      if (
        prevSeg1 &&
        prevSeg2 &&
        prevSeg1.sliceOrder === prevSeg2.sliceOrder &&
        prevSeg1.segmentOrder + 1 === prevSeg2.segmentOrder
      ) {
        prevConnectionMinutes = Math.round(
          (Date.parse(prevSeg2.departureAt) - Date.parse(prevSeg1.arrivalAt)) / (1000 * 60),
        );
        const isPrevOvernight = prevSeg1.arrivalLocalDate !== prevSeg2.departureLocalDate;
        isOvernightIntroduced = isCurrOvernight && !isPrevOvernight;
      }

      connectionDiffs.push({
        sliceOrder,
        prevConnectionMinutes,
        currConnectionMinutes,
        isBelowMct,
        isOverlapping,
        isOvernightIntroduced,
      });
    }
  }

  // 4. Presentation Summary (PII-free)
  const sliceSummaries = allSlices.map((sliceOrder) => {
    const prevInSlice = prevSegments
      .filter((s) => s.sliceOrder === sliceOrder)
      .sort((a, b) => a.segmentOrder - b.segmentOrder);
    const currInSlice = currSegments
      .filter((s) => s.sliceOrder === sliceOrder)
      .sort((a, b) => a.segmentOrder - b.segmentOrder);

    const first = currInSlice[0] || prevInSlice[0];
    const last = currInSlice[currInSlice.length - 1] || prevInSlice[prevInSlice.length - 1];

    const sliceDiff = sliceDiffs.find((d) => d.sliceOrder === sliceOrder);

    return {
      sliceOrder,
      originIata: first ? first.departureAirportIata : '',
      destinationIata: last ? last.arrivalAirportIata : '',
      finalArrivalShiftMinutes: sliceDiff ? sliceDiff.finalArrivalShiftMinutes : null,
    };
  });

  const hasStopsChanged = sliceDiffs.some((d) => d.segmentCountDelta !== 0);

  return {
    segmentDiffs,
    connectionDiffs,
    sliceDiffs,
    isRoutingChanged: isItineraryRoutingChanged,
    addedSegments: added,
    removedSegments: removed,
    presentationSummary: {
      isRoutingChanged: isItineraryRoutingChanged,
      hasStopsChanged,
      addedSegmentsCount: added.length,
      removedSegmentsCount: removed.length,
      sliceSummaries,
    },
  };
}
