import type {
  AncillaryCatalog,
  AncillaryInvalidSelection,
  AncillaryPassenger,
  AncillarySeatService,
  CommitAncillarySelectionRequest,
  NormalizedBaggageSelection,
  NormalizedSeatSelection,
} from '@shared/types/ancillary.types';

type ValidationInput = Pick<CommitAncillarySelectionRequest, 'seats' | 'baggage'> & {
  catalog: AncillaryCatalog;
  passengers: AncillaryPassenger[];
  expectedCurrency?: string;
};

export type ValidatedAncillarySelection = {
  seats: NormalizedSeatSelection[];
  baggage: NormalizedBaggageSelection[];
  currency: string | null;
};

export class AncillarySelectionValidationError extends Error {
  readonly code: 'ANCILLARY_SCOPE_INVALID' | 'ANCILLARY_CURRENCY_MISMATCH';
  readonly invalidSelections: AncillaryInvalidSelection[];

  constructor(
    code: 'ANCILLARY_SCOPE_INVALID' | 'ANCILLARY_CURRENCY_MISMATCH',
    invalidSelections: AncillaryInvalidSelection[],
  ) {
    super(
      code === 'ANCILLARY_CURRENCY_MISMATCH'
        ? 'Ancillary currencies must match.'
        : 'One or more ancillary selections are invalid.',
    );
    this.name = AncillarySelectionValidationError.name;
    this.code = code;
    this.invalidSelections = invalidSelections;
  }
}

const invalid = (
  kind: 'SEAT' | 'BAGGAGE',
  serviceId: string,
  intentPassengerId: string,
  segmentIds: string[],
  reason: string,
): AncillaryInvalidSelection => ({ kind, serviceId, intentPassengerId, segmentIds, reason });

const normalizedType = (type: string): string => type.toUpperCase();

const baggageTier = (selection: NormalizedBaggageSelection): string =>
  [
    normalizedType(selection.type),
    selection.weightValue ?? '',
    selection.weightUnit?.toUpperCase() ?? '',
  ].join(':');

const overlaps = (left: string[], right: string[]): boolean =>
  left.some((segmentId: string) => right.includes(segmentId));

const findSeatService = (
  catalog: AncillaryCatalog,
  segmentId: string,
  serviceId: string,
): { service: AncillarySeatService; designator: string } | null => {
  const segment = catalog.segments.find((candidate) => candidate.segmentId === segmentId);
  if (!segment?.seatMap) {
    return null;
  }

  for (const cabin of segment.seatMap.cabins) {
    for (const row of cabin.rows) {
      for (const element of row.elements) {
        const service = element.availableServices?.find(
          (candidate) => candidate.serviceId === serviceId,
        );
        if (service && element.designator) {
          return { service, designator: element.designator };
        }
      }
    }
  }
  return null;
};

export const validateAncillarySelection = (input: ValidationInput): ValidatedAncillarySelection => {
  const passengers = new Map(
    input.passengers.map((passenger) => [passenger.intentPassengerId, passenger]),
  );
  const invalidSelections: AncillaryInvalidSelection[] = [];
  const seats: NormalizedSeatSelection[] = [];
  const baggage: NormalizedBaggageSelection[] = [];
  const occupiedPassengerSeats = new Set<string>();
  const occupiedPhysicalSeats = new Set<string>();

  for (const selection of input.seats) {
    const passenger = passengers.get(selection.intentPassengerId);
    const seat = findSeatService(input.catalog, selection.segmentId, selection.serviceId);
    const passengerSeatKey = `${selection.intentPassengerId}:${selection.segmentId}`;
    const physicalSeatKey = `${selection.segmentId}:${seat?.designator}`;

    if (!passenger || passenger.type === 'INFANT' || !passenger.seatEligible) {
      invalidSelections.push(
        invalid(
          'SEAT',
          selection.serviceId,
          selection.intentPassengerId,
          [selection.segmentId],
          'PASSENGER_INELIGIBLE',
        ),
      );
    } else if (!seat || seat.service.passengerId !== passenger.supplierPassengerId) {
      invalidSelections.push(
        invalid(
          'SEAT',
          selection.serviceId,
          selection.intentPassengerId,
          [selection.segmentId],
          'SERVICE_SCOPE_INVALID',
        ),
      );
    } else if (occupiedPassengerSeats.has(passengerSeatKey)) {
      invalidSelections.push(
        invalid(
          'SEAT',
          selection.serviceId,
          selection.intentPassengerId,
          [selection.segmentId],
          'DUPLICATE_PASSENGER_SEAT',
        ),
      );
    } else if (occupiedPhysicalSeats.has(physicalSeatKey)) {
      invalidSelections.push(
        invalid(
          'SEAT',
          selection.serviceId,
          selection.intentPassengerId,
          [selection.segmentId],
          'DUPLICATE_GROUP_SEAT',
        ),
      );
    } else {
      occupiedPassengerSeats.add(passengerSeatKey);
      occupiedPhysicalSeats.add(physicalSeatKey);
      seats.push({
        intentPassengerId: selection.intentPassengerId,
        segmentId: selection.segmentId,
        serviceId: selection.serviceId,
        seatDesignator: seat.designator,
        amount: seat.service.amount,
        currency: seat.service.currency,
      });
    }
  }

  for (const selection of input.baggage) {
    const passenger = passengers.get(selection.intentPassengerId);
    const service = input.catalog.baggageServices.find(
      (candidate) => candidate.serviceId === selection.serviceId,
    );

    if (!passenger || passenger.type === 'INFANT') {
      invalidSelections.push(
        invalid(
          'BAGGAGE',
          selection.serviceId,
          selection.intentPassengerId,
          [],
          'PASSENGER_INELIGIBLE',
        ),
      );
    } else if (!service || service.passengerId !== passenger.supplierPassengerId) {
      invalidSelections.push(
        invalid(
          'BAGGAGE',
          selection.serviceId,
          selection.intentPassengerId,
          [],
          'SERVICE_SCOPE_INVALID',
        ),
      );
    } else if (
      !Number.isInteger(selection.quantity) ||
      selection.quantity < 1 ||
      selection.quantity > service.maxQuantity
    ) {
      invalidSelections.push(
        invalid(
          'BAGGAGE',
          selection.serviceId,
          selection.intentPassengerId,
          service.segmentIds,
          'QUANTITY_INVALID',
        ),
      );
    } else {
      baggage.push({
        intentPassengerId: selection.intentPassengerId,
        serviceId: selection.serviceId,
        type: service.type,
        weightValue: service.weightValue,
        weightUnit: service.weightUnit,
        quantity: selection.quantity,
        amount: service.amount,
        currency: service.currency,
        segmentIds: service.segmentIds,
      });
    }
  }

  for (let index = 0; index < baggage.length; index += 1) {
    const current = baggage[index];
    const conflicting = baggage
      .slice(0, index)
      .find(
        (candidate) =>
          candidate.intentPassengerId === current.intentPassengerId &&
          baggageTier(candidate) === baggageTier(current) &&
          overlaps(candidate.segmentIds, current.segmentIds),
      );
    if (conflicting) {
      invalidSelections.push(
        invalid(
          'BAGGAGE',
          current.serviceId,
          current.intentPassengerId,
          current.segmentIds,
          'OVERLAPPING_BAGGAGE_COVERAGE',
        ),
      );
    }
  }

  if (invalidSelections.length > 0) {
    throw new AncillarySelectionValidationError('ANCILLARY_SCOPE_INVALID', invalidSelections);
  }

  const currencies = new Set(
    [
      input.expectedCurrency,
      ...seats.map((selection) => selection.currency),
      ...baggage.map((selection) => selection.currency),
    ].filter((currency): currency is string => Boolean(currency)),
  );
  if (currencies.size > 1) {
    throw new AncillarySelectionValidationError('ANCILLARY_CURRENCY_MISMATCH', [
      ...seats.map((selection) =>
        invalid(
          'SEAT',
          selection.serviceId,
          selection.intentPassengerId,
          [selection.segmentId],
          'CURRENCY_MISMATCH',
        ),
      ),
      ...baggage.map((selection) =>
        invalid(
          'BAGGAGE',
          selection.serviceId,
          selection.intentPassengerId,
          selection.segmentIds,
          'CURRENCY_MISMATCH',
        ),
      ),
    ]);
  }

  return { seats, baggage, currency: currencies.values().next().value ?? null };
};
