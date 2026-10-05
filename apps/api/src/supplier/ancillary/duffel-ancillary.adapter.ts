import { Inject, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Duffel } from '@duffel/api';
import { DUFFEL_SDK } from '@/supplier/core/duffel-core.module';
import {
  BudgetReservationResult,
  DuffelRateBudgetService,
} from '@/supplier/core/duffel-rate-budget.service';

@Injectable()
export class DuffelAncillaryAdapter {
  constructor(
    @Inject(DUFFEL_SDK) private readonly duffel: Duffel,
    private readonly rateBudgetService: DuffelRateBudgetService,
  ) {}

  async getOfferWithServices(offerId: string): Promise<unknown> {
    if (this.isMockMode()) {
      return this.mockOfferWithServices(offerId);
    }
    await this.reserveAttempt();
    return this.fetchOfferWithServices(offerId);
  }

  async getSeatMaps(offerId: string): Promise<unknown> {
    if (this.isMockMode()) {
      return this.mockSeatMaps();
    }
    await this.reserveAttempt();
    return this.fetchSeatMaps(offerId);
  }

  async getCatalogData(offerId: string): Promise<[unknown, unknown]> {
    if (this.isMockMode()) {
      return [this.mockSeatMaps(), this.mockOfferWithServices(offerId)];
    }
    await this.reserveAttempt();
    await this.reserveAttempt();
    return Promise.all([this.fetchSeatMaps(offerId), this.fetchOfferWithServices(offerId)]);
  }

  private async fetchOfferWithServices(offerId: string): Promise<unknown> {
    return (await this.duffel.offers.get(offerId, { return_available_services: true })).data;
  }

  private async fetchSeatMaps(offerId: string): Promise<unknown> {
    try {
      return (await this.duffel.seatMaps.get({ offer_id: offerId })).data;
    } catch (error: unknown) {
      if (this.statusOf(error) === HttpStatus.NOT_FOUND) {
        return [];
      }
      throw error;
    }
  }

  async getPricedOffer(
    offerId: string,
    services: Array<{ id: string; quantity: number }>,
  ): Promise<unknown> {
    if (this.isMockMode()) {
      return this.mockPricedOffer(offerId, services);
    }
    await this.reserveAttempt();
    const response = await this.duffel.offers.getPriced(offerId, {
      intended_payment_methods: [{ type: 'card', card_id: 'mock_card' }],
      intended_services: services,
    });
    return response.data;
  }

  private async reserveAttempt(): Promise<void> {
    const result: BudgetReservationResult = await this.rateBudgetService.reserveAttempt();
    if (!result.ok) {
      throw new HttpException(
        {
          code: result.error === 'EXHAUSTED' ? 'RATE_LIMIT_EXCEEDED' : 'BUDGET_UNAVAILABLE',
          message:
            result.error === 'EXHAUSTED'
              ? 'Daily Duffel API rate limit exceeded'
              : 'Duffel rate budget store temporarily unavailable',
          retryAfterSeconds: result.retryAfterSeconds,
          ...('resetAt' in result ? { resetAt: result.resetAt } : {}),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private statusOf(error: unknown): number | undefined {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    if (!this.isRecord(error)) {
      return undefined;
    }
    if (typeof error.status === 'number') {
      return error.status;
    }
    if (typeof error.statusCode === 'number') {
      return error.statusCode;
    }
    return this.isRecord(error.meta) && typeof error.meta.status === 'number'
      ? error.meta.status
      : undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isMockMode(): boolean {
    return (
      process.env.JEST_WORKER_ID === undefined &&
      (process.env.NODE_ENV === 'test' || process.env.DUFFEL_ACCESS_TOKEN === 'mock')
    );
  }

  private mockSeatMaps(): Array<Record<string, unknown>> {
    return [
      {
        id: 'sm_mock_1',
        slice_id: 'sli_mock_1',
        segment_id: 'seg_mock_1',
        cabins: [
          {
            deck: 0,
            cabin_class: 'economy',
            wings: null,
            aisles: 1,
            rows: [
              {
                row_number: 1,
                sections: [
                  {
                    elements: [
                      {
                        type: 'seat',
                        designator: '1A',
                        disclosures: [],
                        available_services: [
                          {
                            id: 'ase_mock_seat_1',
                            passenger_id: 'pas_mock_1',
                            total_amount: '15.00',
                            total_currency: 'USD',
                          },
                        ],
                      },
                      { type: 'aisle' },
                      {
                        type: 'seat',
                        designator: '1B',
                        disclosures: [],
                        available_services: [
                          {
                            id: 'ase_mock_seat_2',
                            passenger_id: 'pas_mock_1',
                            total_amount: '15.00',
                            total_currency: 'USD',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  private mockOfferWithServices(offerId: string): Record<string, unknown> {
    return {
      id: offerId,
      slices: [
        {
          id: 'sli_mock_1',
          segments: [
            {
              id: 'seg_mock_1',
              origin: { iata_code: 'SGN' },
              destination: { iata_code: 'SIN' },
            },
          ],
        },
      ],
      available_services: [
        {
          id: 'ase_mock_bag_1',
          type: 'baggage',
          passenger_ids: ['pas_mock_1'],
          segment_ids: ['seg_mock_1'],
          total_amount: '30.00',
          total_currency: 'USD',
          metadata: {
            type: 'checked',
            weight: 23,
            weight_unit: 'kg',
            maximum_quantity: 2,
          },
        },
      ],
    };
  }

  private mockPricedOffer(
    offerId: string,
    services: Array<{ id: string; quantity: number }>,
  ): Record<string, unknown> {
    const invalidServiceIds = services
      .filter((service) => service.id.toLowerCase().includes('invalid'))
      .map((service) => service.id);
    if (invalidServiceIds.length > 0) {
      const errors = invalidServiceIds.map((serviceId) => ({
        title: 'invalid_service',
        detail: `Service ${serviceId} is invalid`,
        message: serviceId,
      }));
      throw Object.assign(new Error('Invalid intended service'), {
        meta: { status: 400, request_id: 'req_mock_priced' },
        errors,
      });
    }

    const serviceLines = services.map((service) => {
      const unitAmount = service.id.toLowerCase().includes('bag') ? 35 : 18;
      return {
        service_id: service.id,
        total_amount: unitAmount.toFixed(2),
        quantity: service.quantity,
      };
    });
    const servicesTotal = services.reduce((total, service) => {
      const unitAmount = service.id.toLowerCase().includes('bag') ? 35 : 18;
      return total + unitAmount * service.quantity;
    }, 0);
    const baseAmount = 420;

    return {
      id: offerId,
      total_amount: (baseAmount + servicesTotal).toFixed(2),
      total_currency: 'USD',
      base_amount: baseAmount.toFixed(2),
      base_currency: 'USD',
      service_lines: serviceLines,
    };
  }
}
