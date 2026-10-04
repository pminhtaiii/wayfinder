import { FlightMatchInput } from '@/flight-match/flight-match.types';
import type { FlightSnapshot } from '@shared/booking-types';

export const FLIGHT_SEARCH_PORT = Symbol('FLIGHT_SEARCH_PORT');

export type FlightSearchCriteria = {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  adults: number;
  children?: number;
  infants?: number;
  cabinClass?: string;
};

export type FlightSegment = {
  supplierSegmentId: string | null;
  carrierCode: string;
  flightNumber: string;
  operatingCarrier: string;
  departureAirport: string;
  departureTerminal: string | null;
  departureTime: string;
  arrivalAirport: string;
  arrivalTerminal: string | null;
  arrivalTime: string;
  duration: number;
  aircraft: string | null;
  cabinClass: 'economy' | 'premium_economy' | 'business' | 'first';
};

export type FlightOfferPassenger = {
  supplierPassengerId: string;
  type: 'ADULT' | 'CHILD' | 'INFANT';
};

export type FlightTravelFacts = {
  travelScope: 'DOMESTIC' | 'INTERNATIONAL' | null;
  tripCompletionDate: string | null;
};

export type FlightStoredOfferFacts = FlightTravelFacts & {
  offerExpiresAt: string | null;
};

export type FlightOfferConditions = {
  refundable: boolean;
  changeable: boolean;
  changeBeforeDeparture: {
    allowed: boolean;
    penaltyAmount: string | null;
    penaltyCurrency: string | null;
  } | null;
};

export type FlightOffer = {
  id: string; // same deterministic application offer ID as current normalizer
  supplierOfferId: string; // opaque upstream identity
  totalAmount: string;
  price: number;
  currency: string;
  offerExpiresAt: string | null;
  travelScope?: FlightTravelFacts['travelScope'];
  tripCompletionDate?: FlightTravelFacts['tripCompletionDate'];
  passengers: readonly FlightOfferPassenger[];
  airline: string;
  flightNumber: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
  duration: number;
  stops: number;
  fareClass: string | null;
  baggageAllowance: string | null;
  segments: readonly FlightSegment[];
  returnSegments: readonly FlightSegment[] | null;
  conditions: FlightOfferConditions;
  matchInput: FlightMatchInput; // price/currency/stops/duration, departure/arrival hours,
                               // carrier codes/names, cabin, checked baggage, originalIndex
  rawSupplierPayload: unknown; // storage only; no consumer may inspect its shape
};

export type FlightSearchResult = {
  offers: readonly FlightOffer[];
  searchHash: string;
  cached: boolean;
};

export interface FlightSearchPort {
  search(criteria: FlightSearchCriteria, caller: 'user' | 'agent'): Promise<FlightSearchResult>;
  getOfferById(supplierOfferId: string, timeoutMs?: number): Promise<FlightOffer>;
  normalizeStoredOffer(rawOffer: unknown): FlightOffer | null;
  normalizeStoredOfferFacts(rawOffer: unknown): FlightStoredOfferFacts;
  normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null;
}
