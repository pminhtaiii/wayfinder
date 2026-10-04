import type { PassengerType } from './booking-intent.types';

export type AncillaryStatus = 'EMPTY' | 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE';
export type AncillarySelectionStatus = 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE' | 'PAYMENT_BOUND';
export type AncillaryCacheStatus = 'HIT' | 'MISS' | 'REFRESHED';
export type BaggageType = 'CHECKED' | 'CARRY_ON';
export type WeightUnit = 'KG' | 'LB';
export type AncillaryErrorCode =
  | 'ANCILLARY_VERSION_CONFLICT'
  | 'ANCILLARY_SELECTION_STALE'
  | 'ANCILLARY_PRICE_CHANGED'
  | 'ANCILLARY_SCOPE_INVALID'
  | 'ANCILLARY_CURRENCY_MISMATCH';

export type MoneyAmount = {
  amount: string;
  currency: string;
};

export type AncillaryPriceBreakdown = {
  seats: string;
  baggage: string;
  ancillaries: string;
  estimatedGrandTotal: string;
  currency?: string;
};

// Catalog types (Phase 2 Duffel integration)
export type AncillaryCabinClass = 'economy' | 'premium_economy' | 'business' | 'first' | string;

export type AncillaryRowElementType =
  | 'seat'
  | 'empty'
  | 'aisle'
  | 'lavatory'
  | 'galley'
  | 'closet'
  | 'stairs'
  | 'elevator'
  | 'bassinet'
  | 'exits'
  | 'exit_row'
  | string;

export type AncillarySeatService = {
  serviceId: string;
  passengerId: string; // Supplier (Duffel) passenger ID
  amount: string;
  currency: string;
};

export type AncillaryRowElement = {
  type: AncillaryRowElementType;
  designator?: string;
  availableServices?: AncillarySeatService[];
  restricted?: boolean;
};

export type AncillaryRow = {
  rowNumber: number;
  elements: AncillaryRowElement[];
};

export type AncillaryCabin = {
  cabinClass: AncillaryCabinClass;
  rows: AncillaryRow[];
};

export type AncillarySeatMap = {
  cabins: AncillaryCabin[];
};

export type AncillarySegment = {
  segmentId: string;
  origin: string;
  destination: string;
  seatMapAvailable: boolean;
  seatMap: AncillarySeatMap | null;
};

export type AncillaryBaggageService = {
  serviceId: string;
  passengerId: string; // Supplier (Duffel) passenger ID
  segmentIds: string[];
  type: 'checked' | 'carry_on' | string;
  weightValue: number | null;
  weightUnit: string | null;
  maxQuantity: number;
  amount: string;
  currency: string;
};

export type AncillaryCatalog = {
  fetchedAt: string;
  cache: {
    status: 'HIT' | 'MISS';
    ttlSeconds: number;
  };
  segments: AncillarySegment[];
  baggageServices: AncillaryBaggageService[];
};

// Selection persistence types (Phase 1 schema)
export type AncillaryPassenger = {
  intentPassengerId: string;
  supplierPassengerId: string;
  displayName: string;
  type: PassengerType;
  seatEligible: boolean;
};

/** Legacy HTTP response shape retained while internal passenger identity is supplier-neutral. */
export type AncillaryPassengerDto = Omit<AncillaryPassenger, 'supplierPassengerId'> & {
  duffelPassengerId: string;
};

export type AncillarySeatSelection = {
  intentPassengerId: string;
  supplierPassengerId: string;
  segmentId: string;
  serviceId: string;
  seatDesignator: string;
  amount: string;
  currency: string;
};

export type AncillaryBaggageSelection = {
  intentPassengerId: string;
  supplierPassengerId: string;
  serviceId: string;
  type: BaggageType;
  quantity: number;
  segmentIds: string[];
  amount: string;
  currency: string;
};

export type AncillarySeatSelectionDto = Omit<AncillarySeatSelection, 'supplierPassengerId'> & {
  duffelPassengerId: string;
};

export type AncillaryBaggageSelectionDto = Omit<AncillaryBaggageSelection, 'supplierPassengerId'> & {
  duffelPassengerId: string;
};

export type AncillarySelection = {
  id: string;
  version: number;
  status: AncillarySelectionStatus;
  seats: AncillarySeatSelection[];
  baggage: AncillaryBaggageSelection[];
  totals: AncillaryPriceBreakdown;
};

export type AncillarySelectionDto = Omit<AncillarySelection, 'seats' | 'baggage'> & {
  seats: AncillarySeatSelectionDto[];
  baggage: AncillaryBaggageSelectionDto[];
};

export type NormalizedSeatSelection = {
  intentPassengerId: string;
  segmentId: string;
  serviceId: string;
  seatDesignator: string;
  amount: string;
  currency: string;
};

export type NormalizedBaggageSelection = {
  intentPassengerId: string;
  serviceId: string;
  type: 'checked' | 'carry_on' | string;
  weightValue: number | null;
  weightUnit: string | null;
  quantity: number;
  amount: string;
  currency: string;
  segmentIds: string[];
};

export type AncillaryTotals = {
  seats: string;
  baggage: string;
  ancillaries: string;
  estimatedGrandTotal: string;
  currency: string;
};

export type AncillarySelectionSnapshot = {
  seats: NormalizedSeatSelection[];
  baggage: NormalizedBaggageSelection[];
  totals: AncillaryTotals;
};

export type AncillaryCatalogResponse = {
  intentId: string;
  selectionId: string | null;
  selectionVersion: number;
  selectionStatus: 'EMPTY' | 'DRAFT_COMMITTED' | 'VALIDATED' | 'STALE' | 'PAYMENT_BOUND';
  currency: string | null;
  baseAmount: string | null;
  catalog: AncillaryCatalog;
  passengers: AncillaryPassengerDto[];
  selection: AncillarySelectionSnapshot;
};

export type CommitAncillarySelectionRequest = {
  expectedVersion: number;
  catalogFingerprint: string;
  seats: Array<Pick<AncillarySeatSelection, 'intentPassengerId' | 'segmentId' | 'serviceId'>>;
  baggage: Array<Pick<AncillaryBaggageSelection, 'intentPassengerId' | 'serviceId' | 'quantity'>>;
};

export type CommitAncillarySelectionResponse = {
  intentId: string;
  selectionId: string;
  selectionVersion: number;
  selectionStatus: 'DRAFT_COMMITTED';
  intentExpiresAt: string;
  selection: Omit<AncillarySelectionDto, 'id' | 'version' | 'status'>;
};

export type AncillaryInvalidSelection = {
  kind: 'SEAT' | 'BAGGAGE';
  serviceId: string;
  intentPassengerId: string;
  segmentIds: string[];
  reason: string;
};

export type AncillaryErrorResponse = {
  statusCode: number;
  code: AncillaryErrorCode;
  message: string;
  intentId: string;
  currentVersion?: number;
  invalidSelections?: AncillaryInvalidSelection[];
  pricing?: {
    previousGrandTotal: string;
    currentGrandTotal: string;
    currency: string;
  };
};

export type AncillaryRepriceInput = {
  offerId: string;
  intendedServices: {
    serviceId: string;
    quantity: number;
  }[];
};

export type AncillaryServiceLine = {
  serviceId: string;
  amount: string;
  quantity: number;
};

export type AncillaryRepriceOutput = {
  totalAmount: string;
  baseAmount: string;
  serviceLines: AncillaryServiceLine[];
  currency: string;
  invalidServiceIdentities: string[];
};
