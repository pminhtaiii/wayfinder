import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import type { NormalizedSegment } from '@/disruption/domain/itinerary-normalizer';

type OrderRecord = Record<string, unknown>;

function isRecord(value: unknown): value is OrderRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): OrderRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function toString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function fieldString(record: OrderRecord | undefined, field: string): string | undefined {
  return toString(record?.[field]);
}

function parseIsoDurationToMinutes(duration: string | undefined): number {
  if (!duration) return 0;
  const matches = duration.match(/P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/);
  if (!matches) return 0;
  const days = Number.parseInt(matches[1] || '0', 10);
  const hours = Number.parseInt(matches[2] || '0', 10);
  const minutes = Number.parseInt(matches[3] || '0', 10);
  return days * 24 * 60 + hours * 60 + minutes;
}

function formatMinutesToIsoDuration(totalMinutes: number): string {
  if (totalMinutes <= 0) return 'PT0H';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `PT${hours > 0 ? `${hours}H` : ''}${minutes > 0 ? `${minutes}M` : ''}`;
}

function extractLocalDate(dateTime: string): string {
  return dateTime ? dateTime.split('T')[0] : '';
}

export function mapDuffelOrderToSnapshots(order: unknown): {
  flightSnapshot: FlightSnapshot;
  passengerSnapshot: PassengerSnapshot;
} {
  const orderRecord = toRecord(order);
  const slices = orderRecord?.slices;
  const segments: FlightSnapshot['segments'] = [];
  let totalMinutes = 0;
  let stops = 0;
  let cabinClass = 'economy';
  let globalOrder = 0;

  if (Array.isArray(slices)) {
    for (let sliceOrder = 0; sliceOrder < slices.length; sliceOrder++) {
      const slice = toRecord(slices[sliceOrder]);
      if (!slice) continue;

      const sliceDuration = fieldString(slice, 'duration');
      if (sliceDuration) totalMinutes += parseIsoDurationToMinutes(sliceDuration);

      const sliceSegments = slice.segments;
      if (!Array.isArray(sliceSegments)) continue;
      stops += Math.max(0, sliceSegments.length - 1);

      for (let segmentOrder = 0; segmentOrder < sliceSegments.length; segmentOrder++) {
        const segment = toRecord(sliceSegments[segmentOrder]);
        if (!segment) continue;

        const operatingCarrier = toRecord(segment.operating_carrier);
        const marketingCarrier = toRecord(segment.marketing_carrier);
        const origin = toRecord(segment.origin);
        const destination = toRecord(segment.destination);
        const aircraft = toRecord(segment.aircraft);
        const passengers = segment.passengers;
        const firstSegmentPassenger = Array.isArray(passengers) ? toRecord(passengers[0]) : undefined;
        cabinClass = fieldString(firstSegmentPassenger, 'cabin_class') || cabinClass;

        segments.push({
          airline: {
            name:
              fieldString(operatingCarrier, 'name') ||
              fieldString(marketingCarrier, 'name') ||
              'Unknown',
            iataCode:
              fieldString(operatingCarrier, 'iata_code') ||
              fieldString(marketingCarrier, 'iata_code') ||
              'XX',
          },
          flightNumber: fieldString(segment, 'marketing_carrier_flight_number') || '0000',
          departureAirport: {
            iataCode: fieldString(origin, 'iata_code') || '',
            name: fieldString(origin, 'name') || '',
            city:
              fieldString(origin, 'city_name') ||
              fieldString(toRecord(origin?.city), 'name') ||
              fieldString(origin, 'name') ||
              '',
            terminal: fieldString(segment, 'origin_terminal') ?? undefined,
          },
          arrivalAirport: {
            iataCode: fieldString(destination, 'iata_code') || '',
            name: fieldString(destination, 'name') || '',
            city:
              fieldString(destination, 'city_name') ||
              fieldString(toRecord(destination?.city), 'name') ||
              fieldString(destination, 'name') ||
              '',
            terminal: fieldString(segment, 'destination_terminal') ?? undefined,
          },
          departureAt: fieldString(segment, 'departing_at') || '',
          arrivalAt: fieldString(segment, 'arriving_at') || '',
          duration: fieldString(segment, 'duration') || '',
          aircraftType: fieldString(aircraft, 'name'),
          supplierSegmentId: fieldString(segment, 'id'),
          sliceOrder,
          segmentOrder,
          globalOrder: globalOrder++,
        });
      }
    }
  }

  const passengerData = orderRecord?.passengers;
  const passengers: PassengerSnapshot['passengers'] = [];
  if (Array.isArray(passengerData)) {
    for (const passengerValue of passengerData) {
      const passenger = toRecord(passengerValue);
      if (!passenger) continue;
      const type = fieldString(passenger, 'type');
      passengers.push({
        type:
          type === 'infant_without_seat' || type === 'infant'
            ? 'INFANT'
            : type === 'child'
              ? 'CHILD'
              : 'ADULT',
        title: fieldString(passenger, 'title') || undefined,
        firstName: fieldString(passenger, 'given_name') || 'Unknown',
        lastName: fieldString(passenger, 'family_name') || 'Unknown',
        dateOfBirth: fieldString(passenger, 'born_on') || '1990-01-01',
      });
    }
  }

  const firstPassenger = Array.isArray(passengerData) ? toRecord(passengerData[0]) : undefined;
  return {
    flightSnapshot: {
      segments,
      totalDuration: formatMinutesToIsoDuration(totalMinutes),
      stops,
      cabinClass,
    },
    passengerSnapshot: {
      passengers,
      contactEmail: fieldString(firstPassenger, 'email') || null,
      contactPhone: fieldString(firstPassenger, 'phone_number') || null,
    },
  };
}

export function normalizeDuffelOrder(order: unknown): NormalizedSegment[] {
  const orderRecord = toRecord(order);
  const slices = orderRecord?.slices;
  if (!Array.isArray(slices)) return [];

  const result: NormalizedSegment[] = [];
  let globalOrder = 0;
  for (let sliceOrder = 0; sliceOrder < slices.length; sliceOrder++) {
    const slice = toRecord(slices[sliceOrder]);
    const sliceSegments = slice?.segments;
    if (!Array.isArray(sliceSegments)) continue;

    for (let segmentOrder = 0; segmentOrder < sliceSegments.length; segmentOrder++) {
      const segment = toRecord(sliceSegments[segmentOrder]);
      if (!segment) continue;

      const operatingCarrier = toRecord(segment.operating_carrier);
      const marketingCarrier = toRecord(segment.marketing_carrier);
      const origin = toRecord(segment.origin);
      const destination = toRecord(segment.destination);
      const departureAt = fieldString(segment, 'departing_at') || '';
      const arrivalAt = fieldString(segment, 'arriving_at') || '';

      result.push({
        sliceOrder,
        segmentOrder,
        globalOrder: globalOrder++,
        supplierSegmentId: fieldString(segment, 'id') || null,
        marketingCarrierIata: fieldString(marketingCarrier, 'iata_code') || 'XX',
        operatingCarrierIata:
          fieldString(operatingCarrier, 'iata_code') ||
          fieldString(marketingCarrier, 'iata_code') ||
          'XX',
        airlineName:
          fieldString(operatingCarrier, 'name') ||
          fieldString(marketingCarrier, 'name') ||
          'Unknown',
        flightNumber: fieldString(segment, 'marketing_carrier_flight_number') || '0000',
        departureAirportIata: fieldString(origin, 'iata_code') || '',
        departureAirportName: fieldString(origin, 'name') || '',
        departureCity:
          fieldString(origin, 'city_name') ||
          fieldString(toRecord(origin?.city), 'name') ||
          fieldString(origin, 'name') ||
          '',
        departureTerminal: fieldString(segment, 'origin_terminal') || null,
        departureAt,
        departureLocalDate: extractLocalDate(departureAt),
        arrivalAirportIata: fieldString(destination, 'iata_code') || '',
        arrivalAirportName: fieldString(destination, 'name') || '',
        arrivalCity:
          fieldString(destination, 'city_name') ||
          fieldString(toRecord(destination?.city), 'name') ||
          fieldString(destination, 'name') ||
          '',
        arrivalTerminal: fieldString(segment, 'destination_terminal') || null,
        arrivalAt,
        arrivalLocalDate: extractLocalDate(arrivalAt),
        durationMinutes: parseIsoDurationToMinutes(fieldString(segment, 'duration')),
        aircraftType: fieldString(toRecord(segment.aircraft), 'name') || null,
      });
    }
  }
  return result;
}

@Injectable()
export class OrderSnapshotNormalizer {
  preparePassengers(passengers: unknown, offer: unknown): Array<Record<string, unknown>> {
    const offerRecord = toRecord(offer);
    const offerPassengerValues = offerRecord?.passengers;
    if (!offerPassengerValues) {
      throw new HttpException('Duffel offer or passenger list not found.', HttpStatus.NOT_FOUND);
    }
    if (!Array.isArray(offerPassengerValues)) {
      throw new HttpException('Duffel offer or passenger list not found.', HttpStatus.NOT_FOUND);
    }
    if (!Array.isArray(passengers)) {
      throw new HttpException('Passengers must be an array.', HttpStatus.BAD_REQUEST);
    }

    const offerPassengersByType = new Map<string, Array<{ id: string; type: string }>>();
    for (const value of offerPassengerValues) {
      const passenger = toRecord(value);
      const id = fieldString(passenger, 'id');
      const type = fieldString(passenger, 'type');
      if (!id || !type) continue;
      const matchingPassengers = offerPassengersByType.get(type) ?? [];
      matchingPassengers.push({ id, type });
      offerPassengersByType.set(type, matchingPassengers);
    }

    const typeCounters = new Map<string, number>();
    return passengers.map((value) => {
      const passenger = toRecord(value);
      if (!passenger) {
        throw new HttpException('Invalid passenger.', HttpStatus.BAD_REQUEST);
      }
      const type = fieldString(passenger, 'type');
      if (!type) {
        throw new HttpException('Passenger type is required for passenger.', HttpStatus.BAD_REQUEST);
      }
      const normalizedType = type.toLowerCase();
      const duffelType = normalizedType === 'infant' ? 'infant_without_seat' : normalizedType;
      const passengerIndex = typeCounters.get(duffelType) ?? 0;
      const matchedOfferPassenger = offerPassengersByType.get(duffelType)?.[passengerIndex];
      if (!matchedOfferPassenger) {
        throw new HttpException(
          `Could not match passenger of type ${type} at index ${passengerIndex} with offer passengers`,
          HttpStatus.BAD_REQUEST,
        );
      }
      typeCounters.set(duffelType, passengerIndex + 1);

      const givenName = this.preferredString(passenger, 'givenName', 'given_name');
      const familyName = this.preferredString(passenger, 'familyName', 'family_name');
      if (!givenName) {
        throw new HttpException('Given name is required for passenger.', HttpStatus.BAD_REQUEST);
      }
      if (!familyName) {
        throw new HttpException('Family name is required for passenger.', HttpStatus.BAD_REQUEST);
      }

      const genderInput = fieldString(passenger, 'gender');
      const firstGenderCharacter = genderInput?.trim().toLowerCase()[0];
      const gender = firstGenderCharacter === 'm' ? 'm' : firstGenderCharacter === 'f' ? 'f' : 'u';
      const suppliedTitle = fieldString(passenger, 'title');
      const title = suppliedTitle
        ? suppliedTitle.toLowerCase().trim()
        : gender === 'f'
          ? 'ms'
          : 'mr';

      const rawDate = passenger.born_on || passenger.bornOn || passenger.dateOfBirth;
      const bornOn =
        rawDate instanceof Date
          ? rawDate.toISOString().split('T')[0]
          : typeof rawDate === 'string'
            ? rawDate.split('T')[0]
            : '';
      const phoneNumber = this.preferredString(passenger, 'phoneNumber', 'phone_number');
      const email = fieldString(passenger, 'email');
      if (!bornOn) {
        throw new HttpException(
          `Date of birth is required for passenger ${givenName} ${familyName}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!phoneNumber) {
        throw new HttpException(
          `Phone number is required for passenger ${givenName} ${familyName}`,
          HttpStatus.BAD_REQUEST,
        );
      }
      if (!email) {
        throw new HttpException(
          `Email address is required for passenger ${givenName} ${familyName}`,
          HttpStatus.BAD_REQUEST,
        );
      }

      const prepared: Record<string, unknown> = {
        id: matchedOfferPassenger.id,
        given_name: givenName,
        family_name: familyName,
        born_on: bornOn,
        gender,
        title,
        phone_number: phoneNumber,
        email,
      };
      const identityDocuments = passenger.identity_documents;
      if (Array.isArray(identityDocuments) && identityDocuments.length > 0) {
        prepared.identity_documents = identityDocuments;
      }
      return prepared;
    });
  }

  mapDuffelOrderToSnapshots(order: unknown): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  } {
    return mapDuffelOrderToSnapshots(order);
  }

  normalizeDuffelOrder(order: unknown): NormalizedSegment[] {
    return normalizeDuffelOrder(order);
  }

  private preferredString(record: OrderRecord, first: string, second: string): string | undefined {
    return fieldString(record, first) || fieldString(record, second);
  }
}
