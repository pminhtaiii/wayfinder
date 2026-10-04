import { Injectable } from '@nestjs/common';
import type { FlightSnapshot, PassengerSnapshot } from '@shared/booking-types';
import type { PassengerEnrichmentInput } from '@/payment-fulfillment/ports';
import { OrderSnapshotNormalizer } from './order-snapshot.normalizer';
import { DuffelOrderAdapter } from './duffel-order.adapter';

export type DuffelRecoveredOrder = Awaited<ReturnType<DuffelOrderAdapter['retrieveOrder']>>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function enrichRedactedDuffelOrder(
  order: unknown,
  passengerEnrichment: readonly PassengerEnrichmentInput[],
  contactEmail: string | undefined,
): unknown {
  if (!order) return order;
  const copy: unknown = JSON.parse(JSON.stringify(order));
  if (!isRecord(copy) || !isUnknownArray(copy.passengers)) {
    return copy;
  }

  copy.passengers.forEach((passenger: unknown, index: number) => {
    if (!isRecord(passenger)) return;

    const matchingEnrichment =
      typeof passenger.id === 'string'
        ? passengerEnrichment.find((candidate) => candidate.id === passenger.id)
        : undefined;
    const enrichment = matchingEnrichment ?? passengerEnrichment[index];
    if (enrichment) {
      if (!passenger.given_name || passenger.given_name === 'REDACTED') {
        if (typeof enrichment.firstName === 'string') {
          passenger.given_name = enrichment.firstName;
        }
      }
      if (!passenger.family_name || passenger.family_name === 'REDACTED') {
        if (typeof enrichment.lastName === 'string') {
          passenger.family_name = enrichment.lastName;
        }
      }
      if (enrichment.dateOfBirth && (!passenger.born_on || passenger.born_on === 'REDACTED')) {
        const dateOfBirth = new Date(enrichment.dateOfBirth);
        if (!Number.isNaN(dateOfBirth.getTime())) {
          passenger.born_on = dateOfBirth.toISOString().slice(0, 10);
        }
      }
    }
    if (
      contactEmail !== undefined &&
      (!passenger.email || passenger.email === 'REDACTED')
    ) {
      passenger.email = contactEmail;
    }
  });
  return copy;
}

@Injectable()
export class DuffelRecoveryService {
  constructor(
    private readonly orderAdapter: DuffelOrderAdapter,
    private readonly normalizer: OrderSnapshotNormalizer,
  ) {}

  retrieveOrder(orderId: string): Promise<DuffelRecoveredOrder> {
    return this.orderAdapter.retrieveOrder(orderId);
  }

  retrieveCompleteOrder(orderId: string): Promise<unknown> {
    return this.orderAdapter.retrieveCompleteOrder(orderId);
  }

  async recoverOrderSnapshots(orderId: string): Promise<{
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  }> {
    const order = await this.retrieveCompleteOrder(orderId);
    return this.mapOrderToSnapshots(order);
  }

  mapOrderToSnapshots(
    order: unknown,
    passengerEnrichment?: readonly PassengerEnrichmentInput[],
    contactEmail?: string,
  ): {
    flightSnapshot: FlightSnapshot;
    passengerSnapshot: PassengerSnapshot;
  } {
    const orderForMapping =
      passengerEnrichment !== undefined || contactEmail !== undefined
        ? enrichRedactedDuffelOrder(order, passengerEnrichment ?? [], contactEmail)
        : order;
    return this.normalizer.mapDuffelOrderToSnapshots(orderForMapping);
  }
}
