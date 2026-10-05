import * as crypto from 'crypto';
import { Injectable } from '@nestjs/common';
import {
  DuffelOffer,
  DuffelSegment,
  DuffelSlice,
} from '@/duffel/duffel.types';
import { FlightMatchInput } from '@/flight-match/flight-match.types';
import type { FlightSegmentSnapshot, FlightSnapshot } from '@shared/booking-types';
import { complementStoredOfferPayload } from './stored-offer-payload.helper';
import {
  FlightOffer,
  FlightOfferConditions,
  FlightOfferPassenger,
  FlightStoredOfferFacts,
  FlightSegment,
  NeutralStoredOfferMetadata,
  StoredOfferExpiryPolicy,
  FlightTravelFacts,
} from './flight-search.port';

export type DuffelOfferConditions = {
  refund_before_departure?: {
    allowed: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
  change_before_departure?: {
    allowed: boolean;
    penalty_amount?: string | null;
    penalty_currency?: string | null;
  } | null;
};

export type ExtendedDuffelSlice = DuffelSlice & {
  fare_brand_name?: string | null;
};

export type ExtendedDuffelOffer = DuffelOffer & {
  expires_at?: string | null;
  conditions?: DuffelOfferConditions | null;
  slices: ExtendedDuffelSlice[];
};

export type OfferRejectionReason =
  | 'MALFORMED_OFFER'
  | 'MISSING_SLICES_OR_SEGMENTS'
  | 'INVALID_PRICE'
  | 'INVALID_DURATION'
  | 'INVALID_STOPS'
  | 'INVALID_TIMESTAMP'
  | 'MIXED_CURRENCY';

export type OfferValidationResult =
  | { readonly success: true; readonly offer: FlightMatchInput }
  | { readonly success: false; readonly reason: OfferRejectionReason };

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function getDaysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function isValidIsoDateTime(isoDateTime: string | null | undefined): boolean {
  if (!isoDateTime || typeof isoDateTime !== 'string') return false;
  const match = isoDateTime.match(
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3])(?::?[0-5]\d)?|14(?::?00)?))?$/i,
  );
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);

  const daysInMonth = getDaysInMonth(year, month);
  if (day < 1 || day > daysInMonth) {
    return false;
  }

  return true;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function nonEmptyStringField(
  record: Record<string, unknown> | null,
  key: string,
): string | undefined {
  const value = stringField(record, key);
  return value ? value : undefined;
}

function durationToMinutes(duration: string): number {
  const matches = duration.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 24 * 60 + hours * 60 + minutes;
}

function minutesToDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'PT0H';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  let result = 'PT';
  if (hours > 0) result += `${hours}H`;
  if (minutes > 0) result += `${minutes}M`;
  return result;
}

function storedSnapshotSegment(
  segment: Record<string, unknown>,
  sliceOrder: number,
  segmentOrder: number,
  globalOrder: number,
): FlightSegmentSnapshot {
  const operatingCarrier = isUnknownRecord(segment.operating_carrier)
    ? segment.operating_carrier
    : isUnknownRecord(segment.operatingCarrier)
      ? segment.operatingCarrier
      : null;
  const marketingCarrier = isUnknownRecord(segment.marketing_carrier)
    ? segment.marketing_carrier
    : isUnknownRecord(segment.marketingCarrier)
      ? segment.marketingCarrier
      : null;
  const airline = isUnknownRecord(segment.airline) ? segment.airline : null;
  const origin = isUnknownRecord(segment.origin) ? segment.origin : null;
  const destination = isUnknownRecord(segment.destination)
    ? segment.destination
    : null;
  const originCity = isUnknownRecord(origin?.city) ? origin.city : null;
  const destinationCity = isUnknownRecord(destination?.city)
    ? destination.city
    : null;
  const aircraft = isUnknownRecord(segment.aircraft) ? segment.aircraft : null;

  return {
    airline: {
      name:
        nonEmptyStringField(operatingCarrier, 'name') ??
        nonEmptyStringField(marketingCarrier, 'name') ??
        nonEmptyStringField(airline, 'name') ??
        'Unknown',
      iataCode:
        nonEmptyStringField(operatingCarrier, 'iata_code') ??
        nonEmptyStringField(operatingCarrier, 'iataCode') ??
        nonEmptyStringField(marketingCarrier, 'iata_code') ??
        nonEmptyStringField(marketingCarrier, 'iataCode') ??
        nonEmptyStringField(airline, 'iata_code') ??
        nonEmptyStringField(airline, 'iataCode') ??
        'XX',
    },
    flightNumber:
      nonEmptyStringField(segment, 'marketing_carrier_flight_number') ??
      nonEmptyStringField(segment, 'marketingCarrierFlightNumber') ??
      nonEmptyStringField(segment, 'flight_number') ??
      nonEmptyStringField(segment, 'flightNumber') ??
      '0000',
    departureAirport: {
      iataCode:
        nonEmptyStringField(origin, 'iata_code') ??
        nonEmptyStringField(origin, 'iataCode') ??
        '',
      name: nonEmptyStringField(origin, 'name') ?? '',
      city:
        nonEmptyStringField(origin, 'city_name') ??
        nonEmptyStringField(origin, 'cityName') ??
        nonEmptyStringField(originCity, 'name') ??
        nonEmptyStringField(origin, 'city') ??
        nonEmptyStringField(origin, 'name') ??
        '',
      terminal:
        stringField(segment, 'origin_terminal') ??
        stringField(segment, 'originTerminal'),
    },
    arrivalAirport: {
      iataCode:
        nonEmptyStringField(destination, 'iata_code') ??
        nonEmptyStringField(destination, 'iataCode') ??
        '',
      name: nonEmptyStringField(destination, 'name') ?? '',
      city:
        nonEmptyStringField(destination, 'city_name') ??
        nonEmptyStringField(destination, 'cityName') ??
        nonEmptyStringField(destinationCity, 'name') ??
        nonEmptyStringField(destination, 'city') ??
        nonEmptyStringField(destination, 'name') ??
        '',
      terminal:
        stringField(segment, 'destination_terminal') ??
        stringField(segment, 'destinationTerminal'),
    },
    departureAt:
      stringField(segment, 'departing_at') ??
      stringField(segment, 'departureAt') ??
      '',
    arrivalAt:
      stringField(segment, 'arriving_at') ??
      stringField(segment, 'arrivalAt') ??
      '',
    duration: stringField(segment, 'duration') ?? '',
    aircraftType:
      nonEmptyStringField(aircraft, 'name') ??
      nonEmptyStringField(segment, 'aircraftType'),
    supplierSegmentId:
      nonEmptyStringField(segment, 'id') ??
      nonEmptyStringField(segment, 'supplierSegmentId') ??
      nonEmptyStringField(segment, 'duffelSegmentId'),
    sliceOrder,
    segmentOrder,
    globalOrder,
  };
}

function isValidDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function getTravelFacts(offer: unknown): FlightTravelFacts {
  if (!isUnknownRecord(offer) || !Array.isArray(offer.slices)) {
    return { travelScope: null, tripCompletionDate: null };
  }

  let travelScope: FlightTravelFacts['travelScope'] = 'DOMESTIC';
  let latestArrival: string | null = null;
  const slices: readonly unknown[] = offer.slices;

  for (const slice of slices) {
    if (!isUnknownRecord(slice) || !Array.isArray(slice.segments)) continue;
    const segments: readonly unknown[] = slice.segments;

    for (const segment of segments) {
      if (!isUnknownRecord(segment)) continue;
      const origin = isUnknownRecord(segment.origin) ? segment.origin : null;
      const destination = isUnknownRecord(segment.destination) ? segment.destination : null;
      const originCountry = origin?.iata_country_code ?? origin?.countryCode ?? null;
      const destinationCountry =
        destination?.iata_country_code ?? destination?.countryCode ?? null;

      if (
        typeof originCountry === 'string' &&
        originCountry &&
        typeof destinationCountry === 'string' &&
        destinationCountry &&
        originCountry !== destinationCountry
      ) {
        travelScope = 'INTERNATIONAL';
      }

      const arrivalRaw = segment.arriving_at ?? segment.arrivalDate ?? segment.arrivingAt;
      if (typeof arrivalRaw !== 'string') continue;

      const arrivalDate = arrivalRaw.slice(0, 10);
      if (isValidDateOnly(arrivalDate) && (!latestArrival || arrivalDate > latestArrival)) {
        latestArrival = arrivalDate;
      }
    }
  }

  return {
    travelScope,
    tripCompletionDate: latestArrival,
  };
}

export function extractLocalHour(isoDateTime: string | null | undefined): number | null {
  if (!isValidIsoDateTime(isoDateTime)) return null;
  const match = (isoDateTime as string).match(/T(\d{2}):/i);
  if (!match) return null;
  const hour = parseInt(match[1], 10);
  return !isNaN(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

function capitalize(str: string | null | undefined): string | null {
  if (!str) return null;
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function normalizePassengerType(rawType?: unknown): 'ADULT' | 'CHILD' | 'INFANT' {
  if (!rawType || typeof rawType !== 'string') return 'ADULT';
  const lower = rawType.trim().toLowerCase();
  if (lower.startsWith('child')) return 'CHILD';
  if (lower.startsWith('infant')) return 'INFANT';
  return 'ADULT';
}

function normalizeCabinClass(
  rawCabin?: string | null,
): 'economy' | 'premium_economy' | 'business' | 'first' {
  if (!rawCabin) return 'economy';
  const lower = rawCabin.trim().toLowerCase();
  if (lower === 'premium_economy' || lower === 'business' || lower === 'first') {
    return lower;
  }
  return 'economy';
}

function extractCarrierInfo(
  carrier: { readonly iata_code?: string | null; readonly name?: string | null } | undefined | null,
  carrierCodesSet: Set<string>,
  carrierCodes: string[],
  carrierNamesByCode: Record<string, string>,
): void {
  if (!carrier?.iata_code) return;
  const code = carrier.iata_code.trim().toUpperCase();
  if (!code) return;

  if (!carrierCodesSet.has(code)) {
    carrierCodesSet.add(code);
    carrierCodes.push(code);
  }
  if (carrier.name && !carrierNamesByCode[code]) {
    carrierNamesByCode[code] = carrier.name.trim();
  }
}

export function parseISO8601Duration(durationStr: string | null | undefined): number {
  if (!durationStr) return 0;
  const regex = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
  const matches = durationStr.match(regex);
  if (!matches) return 0;
  const days = parseInt(matches[1] || '0', 10);
  const hours = parseInt(matches[2] || '0', 10);
  const minutes = parseInt(matches[3] || '0', 10);
  return days * 1440 + hours * 60 + minutes;
}

export function generateDeterministicUUID(input: string): string {
  const hash = crypto.createHash('sha256').update(input).digest('hex');
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '4' + hash.substring(13, 16),
    '8' + hash.substring(17, 20),
    hash.substring(20, 32),
  ].join('-');
}

function mapSegment(seg: DuffelSegment, requestedCabinClass?: string): FlightSegment {
  const cabin = seg.passengers?.[0]?.cabin_class || requestedCabinClass || 'economy';
  return {
    supplierSegmentId: seg.id || null,
    carrierCode:
      seg.marketing_carrier?.iata_code ||
      seg.operating_carrier?.iata_code ||
      '',
    flightNumber: seg.marketing_carrier_flight_number || '',
    operatingCarrier:
      seg.operating_carrier?.name ||
      seg.marketing_carrier?.name ||
      '',
    departureAirport: seg.origin?.iata_code || '',
    departureTerminal: seg.origin_terminal || null,
    departureTime: seg.departing_at || '',
    arrivalAirport: seg.destination?.iata_code || '',
    arrivalTerminal: seg.destination_terminal || null,
    arrivalTime: seg.arriving_at || '',
    duration: parseISO8601Duration(seg.duration),
    aircraft: seg.aircraft?.name || null,
    cabinClass: normalizeCabinClass(cabin),
  };
}

export function validateAndNormalizeOffer(
  offer: DuffelOffer,
  originalIndex: number,
): OfferValidationResult {
  if (!offer || typeof offer !== 'object' || !offer.id || typeof offer.id !== 'string' || !offer.id.trim()) {
    return { success: false, reason: 'MALFORMED_OFFER' };
  }

  if (!offer.slices || !Array.isArray(offer.slices) || offer.slices.length === 0) {
    return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
  }

  for (const slice of offer.slices) {
    if (!slice || !slice.segments || !Array.isArray(slice.segments) || slice.segments.length === 0) {
      return { success: false, reason: 'MISSING_SLICES_OR_SEGMENTS' };
    }
  }

  if (
    !offer.total_amount ||
    typeof offer.total_amount !== 'string' ||
    !offer.total_amount.trim() ||
    !offer.total_currency ||
    typeof offer.total_currency !== 'string' ||
    !offer.total_currency.trim()
  ) {
    return { success: false, reason: 'INVALID_PRICE' };
  }

  const price = parseFloat(offer.total_amount);
  if (isNaN(price) || !Number.isFinite(price) || price <= 0) {
    return { success: false, reason: 'INVALID_PRICE' };
  }

  const outboundSlice = offer.slices[0];
  const outboundSegments = outboundSlice.segments;
  const firstOutboundSegment = outboundSegments[0];
  const lastOutboundSegment = outboundSegments[outboundSegments.length - 1];

  const outboundDepartureHour = extractLocalHour(firstOutboundSegment?.departing_at);
  const outboundArrivalHour = extractLocalHour(lastOutboundSegment?.arriving_at);

  if (outboundDepartureHour === null || outboundArrivalHour === null) {
    return { success: false, reason: 'INVALID_TIMESTAMP' };
  }

  let duration = 0;
  let stops = 0;
  let maxSegmentDuration = -1;
  let longestCabinClass = 'economy';

  const carrierCodesSet = new Set<string>();
  const carrierCodes: string[] = [];
  const carrierNamesByCode: Record<string, string> = {};

  let hasOmittedBaggageSlice = false;
  let allSlicesHaveChecked = true;

  for (const slice of offer.slices) {
    const sliceDuration = parseISO8601Duration(slice.duration);
    duration += sliceDuration;

    const segCount = slice.segments?.length ?? 0;
    if (segCount > 1) {
      stops += segCount - 1;
    }

    let longestSliceSeg: DuffelSegment | null = null;
    let maxSliceSegDuration = -1;

    for (const segment of slice.segments ?? []) {
      const segDuration = parseISO8601Duration(segment.duration);

      if (segDuration > maxSegmentDuration) {
        maxSegmentDuration = segDuration;
        const cabin = segment.passengers?.[0]?.cabin_class;
        longestCabinClass = cabin ? cabin.trim().toLowerCase() : 'economy';
      }

      if (segDuration > maxSliceSegDuration) {
        maxSliceSegDuration = segDuration;
        longestSliceSeg = segment;
      }

      extractCarrierInfo(segment.marketing_carrier, carrierCodesSet, carrierCodes, carrierNamesByCode);
      extractCarrierInfo(segment.operating_carrier, carrierCodesSet, carrierCodes, carrierNamesByCode);
    }

    const baggages = longestSliceSeg?.passengers?.[0]?.baggages;
    if (baggages !== undefined && baggages !== null) {
      const hasCheckedInSlice = baggages.some(
        (b) =>
          b.type?.toLowerCase() === 'checked' &&
          (b.quantity === undefined || b.quantity > 0),
      );
      if (!hasCheckedInSlice) {
        allSlicesHaveChecked = false;
      }
    } else {
      hasOmittedBaggageSlice = true;
    }
  }

  if (duration <= 0 || !Number.isFinite(duration)) {
    return { success: false, reason: 'INVALID_DURATION' };
  }

  if (stops < 0 || !Number.isInteger(stops) || !Number.isFinite(stops)) {
    return { success: false, reason: 'INVALID_STOPS' };
  }

  const hasCheckedBaggage: boolean | null = hasOmittedBaggageSlice
    ? null
    : allSlicesHaveChecked;

  return {
    success: true,
    offer: {
      id: generateDeterministicUUID(offer.id),
      price,
      currency: offer.total_currency,
      stops,
      duration,
      outboundDepartureHour,
      outboundArrivalHour,
      carrierCodes,
      carrierNamesByCode: Object.keys(carrierNamesByCode).length > 0 ? carrierNamesByCode : undefined,
      cabinClass: longestCabinClass,
      hasCheckedBaggage,
      originalIndex,
    },
  };
}

@Injectable()
export class FlightOfferNormalizer {
  generateDeterministicUUID(input: string): string {
    return FlightOfferNormalizer.generateDeterministicUUID(input);
  }

  static generateDeterministicUUID(input: string): string {
    return generateDeterministicUUID(input);
  }

  parseISO8601Duration(durationStr: string | null | undefined): number {
    return FlightOfferNormalizer.parseISO8601Duration(durationStr);
  }

  static parseISO8601Duration(durationStr: string | null | undefined): number {
    return parseISO8601Duration(durationStr);
  }

  normalizeOffer(
    offer: DuffelOffer,
    requestedCabinClass?: string,
    originalIndex: number = 0,
  ): FlightOffer {
    return FlightOfferNormalizer.normalizeOffer(offer, requestedCabinClass, originalIndex);
  }

  static normalizeOffer(
    offer: DuffelOffer,
    requestedCabinClass?: string,
    originalIndex: number = 0,
  ): FlightOffer {
    const travelFacts = getTravelFacts(offer);
    const id = FlightOfferNormalizer.generateDeterministicUUID(offer.id);
    const outboundSlice = offer.slices?.[0];
    const outboundSegments = outboundSlice?.segments ?? [];
    const firstSegment = outboundSegments[0];
    const lastSegment = outboundSegments[outboundSegments.length - 1];

    const price = parseFloat(offer.total_amount);
    const currency = offer.total_currency;

    const airline =
      firstSegment?.marketing_carrier?.name ||
      firstSegment?.operating_carrier?.name ||
      'Unknown Airline';

    const flightNumber =
      (firstSegment?.marketing_carrier?.iata_code ?? '') +
      (firstSegment?.marketing_carrier_flight_number ?? '');

    const departureAirport = firstSegment?.origin?.iata_code ?? '';
    const arrivalAirport = lastSegment?.destination?.iata_code ?? '';
    const departureTime = firstSegment?.departing_at ?? '';
    const arrivalTime = lastSegment?.arriving_at ?? '';

    let duration = 0;
    let stops = 0;
    for (const slice of offer.slices ?? []) {
      duration += FlightOfferNormalizer.parseISO8601Duration(slice.duration);
      const segCount = slice.segments?.length ?? 0;
      if (segCount > 1) {
        stops += segCount - 1;
      }
    }

    const extendedSlice = outboundSlice as ExtendedDuffelSlice | undefined;
    const rawCabin = firstSegment?.passengers?.[0]?.cabin_class || requestedCabinClass || null;
    const fareClass = extendedSlice?.fare_brand_name || (rawCabin ? capitalize(rawCabin) : null);

    const segmentBaggage = firstSegment?.passengers?.[0]?.baggages;
    let baggageAllowance: string | null = null;
    if (segmentBaggage && segmentBaggage.length > 0) {
      const bag = segmentBaggage[0];
      baggageAllowance =
        bag.quantity === undefined && bag.weight !== undefined
          ? `${bag.weight}${(bag.weight_unit || 'kg').toLowerCase()} ${bag.type}`
          : `${bag.quantity || 0} ${bag.type} bag(s)`;
    }

    const passengers: readonly FlightOfferPassenger[] = (offer.passengers ?? []).map((p) => ({
      supplierPassengerId: p.id,
      type: normalizePassengerType(p.type),
    }));

    const segments: readonly FlightSegment[] = outboundSegments.map((seg) =>
      mapSegment(seg, requestedCabinClass),
    );

    const returnSegments: readonly FlightSegment[] | null =
      (offer.slices?.length ?? 0) > 1 && (offer.slices[1]?.segments?.length ?? 0) > 0
        ? offer.slices[1].segments.map((seg) => mapSegment(seg, requestedCabinClass))
        : null;

    const extendedOffer = offer as ExtendedDuffelOffer;
    const cond = extendedOffer.conditions;
    const conditions: FlightOfferConditions = {
      refundable: Boolean(cond?.refund_before_departure?.allowed),
      changeable: Boolean(cond?.change_before_departure?.allowed),
      changeBeforeDeparture: cond?.change_before_departure
        ? {
            allowed: Boolean(cond.change_before_departure.allowed),
            penaltyAmount: cond.change_before_departure.penalty_amount ?? null,
            penaltyCurrency: cond.change_before_departure.penalty_currency ?? null,
          }
        : null,
    };

    const validation = validateAndNormalizeOffer(offer, originalIndex);
    const matchInput: FlightMatchInput = validation.success
      ? validation.offer
      : {
          id,
          price,
          currency,
          stops,
          duration,
          outboundDepartureHour: extractLocalHour(firstSegment?.departing_at) ?? 0,
          outboundArrivalHour: extractLocalHour(lastSegment?.arriving_at) ?? 0,
          carrierCodes: [],
          cabinClass: 'economy',
          hasCheckedBaggage: null,
          originalIndex,
        };

    return {
      id,
      supplierOfferId: offer.id,
      totalAmount: offer.total_amount,
      price,
      currency,
      offerExpiresAt: extendedOffer.expires_at ?? null,
      ...travelFacts,
      passengers,
      airline,
      flightNumber,
      departureAirport,
      arrivalAirport,
      departureTime,
      arrivalTime,
      duration,
      stops,
      fareClass,
      baggageAllowance,
      segments,
      returnSegments,
      conditions,
      matchInput,
      rawSupplierPayload: offer,
    };
  }

  normalizeStoredOffer(
    rawOffer: unknown,
    metadata?: NeutralStoredOfferMetadata,
  ): FlightOffer | null {
    return FlightOfferNormalizer.normalizeStoredOffer(rawOffer, metadata);
  }

  normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null {
    return FlightOfferNormalizer.normalizeStoredFlightSnapshot(rawOffer);
  }

  normalizeStoredOfferFacts(
    rawOffer: unknown,
    expiryPolicy?: StoredOfferExpiryPolicy,
  ): FlightStoredOfferFacts {
    return FlightOfferNormalizer.normalizeStoredOfferFacts(rawOffer, expiryPolicy);
  }

  static normalizeStoredFlightSnapshot(rawOffer: unknown): FlightSnapshot | null {
    if (!isUnknownRecord(rawOffer) || !Array.isArray(rawOffer.slices) || rawOffer.slices.length === 0) {
      return null;
    }

    let totalDuration =
      typeof rawOffer.total_duration === 'string'
        ? rawOffer.total_duration
        : typeof rawOffer.totalDuration === 'string'
          ? rawOffer.totalDuration
          : 'PT0H';
    let totalMinutes = 0;
    let stops = 0;
    let cabinClass =
      typeof rawOffer.cabinClass === 'string'
        ? rawOffer.cabinClass
        : typeof rawOffer.cabin_class === 'string'
          ? rawOffer.cabin_class
          : 'economy';
    const segments: FlightSegmentSnapshot[] = [];
    let globalOrder = 0;

    for (let sliceOrder = 0; sliceOrder < rawOffer.slices.length; sliceOrder++) {
      const sliceValue: unknown = rawOffer.slices[sliceOrder];
      if (!isUnknownRecord(sliceValue)) continue;
      const slice = sliceValue;

      if (typeof slice.duration === 'string') {
        totalMinutes += durationToMinutes(slice.duration);
      }
      if (!Array.isArray(slice.segments)) continue;

      stops += Math.max(0, slice.segments.length - 1);
      for (let segmentOrder = 0; segmentOrder < slice.segments.length; segmentOrder++) {
        const segmentValue: unknown = slice.segments[segmentOrder];
        if (!isUnknownRecord(segmentValue)) continue;
        const segment = segmentValue;
        const passengers = Array.isArray(segment.passengers) ? segment.passengers : null;
        const firstPassenger =
          passengers && passengers.length > 0 && isUnknownRecord(passengers[0])
            ? passengers[0]
            : null;

        const passengerCabin =
          nonEmptyStringField(firstPassenger, 'cabin_class') ??
          nonEmptyStringField(firstPassenger, 'cabinClass');
        const segmentCabin =
          nonEmptyStringField(segment, 'cabin_class') ??
          nonEmptyStringField(segment, 'cabinClass');
        if (passengerCabin) {
          cabinClass = passengerCabin;
        } else if (segmentCabin) {
          cabinClass = segmentCabin;
        }

        segments.push(
          storedSnapshotSegment(segment, sliceOrder, segmentOrder, globalOrder++),
        );
      }
    }

    if (totalMinutes > 0 && totalDuration === 'PT0H') {
      totalDuration = minutesToDuration(totalMinutes);
    }

    return {
      segments,
      totalDuration,
      stops,
      cabinClass,
    };
  }

  static normalizeStoredOfferFacts(
    rawOffer: unknown,
    expiryPolicy: StoredOfferExpiryPolicy = 'legacy-aliases',
  ): FlightStoredOfferFacts {
    const candidate = isUnknownRecord(rawOffer) ? rawOffer : null;
    const expiryValue =
      candidate?.expires_at ??
      (expiryPolicy === 'legacy-aliases' ? candidate?.expiresAt : undefined);
    const offerExpiresAt =
      typeof expiryValue === 'string' && isValidIsoDateTime(expiryValue)
        ? expiryValue
        : null;

    return {
      ...getTravelFacts(rawOffer),
      offerExpiresAt,
    };
  }

  static normalizeStoredOffer(
    rawOffer: unknown,
    metadata?: NeutralStoredOfferMetadata,
  ): FlightOffer | null {
    if (!isUnknownRecord(rawOffer)) {
      return null;
    }

    const passengersWereProvided =
      Array.isArray(rawOffer.passengers) && rawOffer.passengers.length > 0;
    const completedOffer = complementStoredOfferPayload(
      rawOffer,
      metadata
        ? {
            supplierOfferId: metadata.supplierOfferId,
            price: metadata.totalAmount ?? metadata.price,
            currency: metadata.currency,
            departureDate: metadata.departureDate,
            adults: metadata.adults,
            children: metadata.children,
            infants: metadata.infants,
          }
        : null,
    );
    if (!isUnknownRecord(completedOffer)) return null;

    const candidate = completedOffer;

    // 1. Check id is non-empty string
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      return null;
    }

    // 2. Check total_amount is string and valid positive number
    if (typeof candidate.total_amount !== 'string' || candidate.total_amount.trim() === '') {
      return null;
    }
    const numAmount = Number(candidate.total_amount);
    if (Number.isNaN(numAmount) || !Number.isFinite(numAmount) || numAmount <= 0) {
      return null;
    }

    // 3. Check total_currency is non-empty string
    if (
      typeof candidate.total_currency !== 'string' ||
      candidate.total_currency.trim() === ''
    ) {
      return null;
    }

    // 4. Check slices is non-empty array
    if (!Array.isArray(candidate.slices) || candidate.slices.length === 0) {
      return null;
    }

    const normalizedSlices: Record<string, unknown>[] = [];

    // 5. Each slice must have non-empty segments array with valid origins/destinations/timestamps
    for (const slice of candidate.slices) {
      if (
        slice === null ||
        slice === undefined ||
        typeof slice !== 'object' ||
        Array.isArray(slice)
      ) {
        return null;
      }
      const sliceObj = slice as Record<string, unknown>;
      if (!Array.isArray(sliceObj.segments) || sliceObj.segments.length === 0) {
        return null;
      }
      const normalizedSegments: Record<string, unknown>[] = [];
      for (const seg of sliceObj.segments) {
        if (
          seg === null ||
          seg === undefined ||
          typeof seg !== 'object' ||
          Array.isArray(seg)
        ) {
          return null;
        }
        const segObj = seg as Record<string, unknown>;

        // Origin check
        if (
          segObj.origin === null ||
          segObj.origin === undefined ||
          typeof segObj.origin !== 'object' ||
          Array.isArray(segObj.origin)
        ) {
          return null;
        }
        const originObj = segObj.origin as Record<string, unknown>;
        if (typeof originObj.iata_code !== 'string') {
          return null;
        }

        const originCode = originObj.iata_code.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(originCode)) {
          return null;
        }

        // Destination check
        if (
          segObj.destination === null ||
          segObj.destination === undefined ||
          typeof segObj.destination !== 'object' ||
          Array.isArray(segObj.destination)
        ) {
          return null;
        }
        const destObj = segObj.destination as Record<string, unknown>;
        if (typeof destObj.iata_code !== 'string') {
          return null;
        }

        const destinationCode = destObj.iata_code.trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(destinationCode)) {
          return null;
        }

        // Departing_at and arriving_at valid ISO timestamps. Legacy arrival aliases stay local
        // to this supplier-boundary normalizer.
        const arrivalRaw = segObj.arriving_at ?? segObj.arrivalDate ?? segObj.arrivingAt;
        if (
          typeof segObj.departing_at !== 'string' ||
          !isValidIsoDateTime(segObj.departing_at)
        ) {
          return null;
        }
        if (
          typeof arrivalRaw !== 'string' ||
          !isValidIsoDateTime(arrivalRaw)
        ) {
          return null;
        }
        normalizedSegments.push({
          ...segObj,
          arriving_at: arrivalRaw,
          origin: { ...originObj, iata_code: originCode },
          destination: { ...destObj, iata_code: destinationCode },
        });
      }
      normalizedSlices.push({ ...sliceObj, segments: normalizedSegments });
    }

    if (!Array.isArray(candidate.passengers) || candidate.passengers.length === 0) {
      return null;
    }
    const passengerIdSet = new Set<string>();
    for (const p of candidate.passengers) {
      if (p === null || p === undefined || typeof p !== 'object' || Array.isArray(p)) {
        return null;
      }
      const pObj = p as Record<string, unknown>;
      if (typeof pObj.id !== 'string' || pObj.id.trim() === '') {
        return null;
      }
      const pId = pObj.id.trim();
      if (passengerIdSet.has(pId)) {
        return null;
      }
      passengerIdSet.add(pId);

      if (typeof pObj.type !== 'string' || pObj.type.trim() === '') {
        return null;
      }
      const typeLower = pObj.type.trim().toLowerCase();
      if (
        typeLower !== 'adult' &&
        typeLower !== 'child' &&
        typeLower !== 'infant'
      ) {
        return null;
      }
    }

    const expiryValue = candidate.expires_at ?? candidate.expiresAt;
    const expiresAt =
      typeof expiryValue === 'string' && isValidIsoDateTime(expiryValue) ? expiryValue : null;
    const normalized = FlightOfferNormalizer.normalizeOffer(
      // Required stored fields are validated above; copy normalized codes without mutating the snapshot.
      { ...candidate, expires_at: expiresAt, slices: normalizedSlices } as unknown as DuffelOffer,
      undefined,
      0,
    );

    return {
      ...normalized,
      rawSupplierPayload: rawOffer,
      passengersWereProvided,
    };
  }
}

export function normalizeOffer(
  offer: DuffelOffer,
  requestedCabinClass?: string,
  originalIndex?: number,
): FlightOffer {
  return FlightOfferNormalizer.normalizeOffer(offer, requestedCabinClass, originalIndex);
}

export function normalizeStoredOffer(
  rawOffer: unknown,
  metadata?: NeutralStoredOfferMetadata,
): FlightOffer | null {
  return FlightOfferNormalizer.normalizeStoredOffer(rawOffer, metadata);
}

export function normalizeStoredOfferFacts(
  rawOffer: unknown,
  expiryPolicy?: StoredOfferExpiryPolicy,
): FlightStoredOfferFacts {
  return FlightOfferNormalizer.normalizeStoredOfferFacts(rawOffer, expiryPolicy);
}
