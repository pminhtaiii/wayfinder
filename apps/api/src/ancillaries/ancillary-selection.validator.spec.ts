// User approved on 2026-10-03: internal fixture names match the domain rename.
// Values and scenarios are unchanged.
import type {
  AncillaryCatalog,
  AncillaryPassenger,
  CommitAncillarySelectionRequest,
} from '@shared/types/ancillary.types';
import {
  AncillarySelectionValidationError,
  validateAncillarySelection,
} from './ancillary-selection.validator';

const catalog: AncillaryCatalog = {
  fetchedAt: '2026-07-27T00:00:00.000Z',
  cache: { status: 'MISS', ttlSeconds: 60 },
  segments: [
    {
      segmentId: 'seg-out',
      origin: 'SGN',
      destination: 'SIN',
      seatMapAvailable: true,
      seatMap: {
        cabins: [
          {
            cabinClass: 'economy',
            rows: [
              {
                rowNumber: 1,
                elements: [
                  {
                    type: 'seat',
                    designator: '1A',
                    availableServices: [
                      {
                        serviceId: 'seat-adult',
                        passengerId: 'pas-adult',
                        amount: '18.00',
                        currency: 'USD',
                      },
                      {
                        serviceId: 'seat-child',
                        passengerId: 'pas-child',
                        amount: '18.00',
                        currency: 'USD',
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    {
      segmentId: 'seg-back',
      origin: 'SIN',
      destination: 'SGN',
      seatMapAvailable: true,
      seatMap: { cabins: [] },
    },
  ],
  baggageServices: [
    {
      serviceId: 'bag-out',
      passengerId: 'pas-adult',
      segmentIds: ['seg-out'],
      type: 'checked',
      weightValue: 23,
      weightUnit: 'kg',
      maxQuantity: 2,
      amount: '30.00',
      currency: 'USD',
    },
    {
      serviceId: 'bag-journey',
      passengerId: 'pas-adult',
      segmentIds: ['seg-out', 'seg-back'],
      type: 'checked',
      weightValue: 23,
      weightUnit: 'kg',
      maxQuantity: 2,
      amount: '50.00',
      currency: 'USD',
    },
  ],
};

const passengers: AncillaryPassenger[] = [
  {
    intentPassengerId: 'local-adult',
    supplierPassengerId: 'pas-adult',
    displayName: 'Adult',
    type: 'ADULT',
    seatEligible: true,
  },
  {
    intentPassengerId: 'local-child',
    supplierPassengerId: 'pas-child',
    displayName: 'Child',
    type: 'CHILD',
    seatEligible: true,
  },
  {
    intentPassengerId: 'local-infant',
    supplierPassengerId: 'pas-infant',
    displayName: 'Infant',
    type: 'INFANT',
    seatEligible: false,
  },
];

const selection = (
  overrides: Partial<CommitAncillarySelectionRequest> = {},
): CommitAncillarySelectionRequest => ({
  expectedVersion: 0,
  catalogFingerprint: 'fingerprint',
  seats: [],
  baggage: [],
  ...overrides,
});

describe('validateAncillarySelection', () => {
  it.each([
    [
      'unknown passenger',
      selection({
        seats: [{ intentPassengerId: 'other', segmentId: 'seg-out', serviceId: 'seat-adult' }],
      }),
    ],
    [
      'seat mapped to another passenger',
      selection({
        seats: [
          { intentPassengerId: 'local-child', segmentId: 'seg-out', serviceId: 'seat-adult' },
        ],
      }),
    ],
    [
      'seat outside segment scope',
      selection({
        seats: [
          { intentPassengerId: 'local-adult', segmentId: 'seg-back', serviceId: 'seat-adult' },
        ],
      }),
    ],
    [
      'infant seat',
      selection({
        seats: [
          { intentPassengerId: 'local-infant', segmentId: 'seg-out', serviceId: 'seat-adult' },
        ],
      }),
    ],
    [
      'infant baggage',
      selection({
        baggage: [{ intentPassengerId: 'local-infant', serviceId: 'bag-out', quantity: 1 }],
      }),
    ],
  ])('rejects invalid scope: %s', (_name: string, request: CommitAncillarySelectionRequest) => {
    expect(() => validateAncillarySelection({ catalog, passengers, ...request })).toThrow(
      AncillarySelectionValidationError,
    );
  });

  it.each([
    [
      'same passenger and segment',
      selection({
        seats: [
          { intentPassengerId: 'local-adult', segmentId: 'seg-out', serviceId: 'seat-adult' },
          { intentPassengerId: 'local-adult', segmentId: 'seg-out', serviceId: 'seat-adult' },
        ],
      }),
    ],
    [
      'same group seat service',
      selection({
        seats: [
          { intentPassengerId: 'local-adult', segmentId: 'seg-out', serviceId: 'seat-adult' },
          { intentPassengerId: 'local-child', segmentId: 'seg-out', serviceId: 'seat-adult' },
        ],
      }),
    ],
    [
      'same physical seat with passenger-scoped services',
      selection({
        seats: [
          { intentPassengerId: 'local-adult', segmentId: 'seg-out', serviceId: 'seat-adult' },
          { intentPassengerId: 'local-child', segmentId: 'seg-out', serviceId: 'seat-child' },
        ],
      }),
    ],
  ])('rejects duplicate seats by %s', (_name: string, request: CommitAncillarySelectionRequest) => {
    expect(() => validateAncillarySelection({ catalog, passengers, ...request })).toThrow(
      AncillarySelectionValidationError,
    );
  });

  it.each([
    [
      'non-positive quantity',
      selection({
        baggage: [{ intentPassengerId: 'local-adult', serviceId: 'bag-out', quantity: 0 }],
      }),
    ],
    [
      'quantity above supplier maximum',
      selection({
        baggage: [{ intentPassengerId: 'local-adult', serviceId: 'bag-out', quantity: 3 }],
      }),
    ],
    [
      'overlapping equivalent tiers',
      selection({
        baggage: [
          { intentPassengerId: 'local-adult', serviceId: 'bag-out', quantity: 1 },
          { intentPassengerId: 'local-adult', serviceId: 'bag-journey', quantity: 1 },
        ],
      }),
    ],
  ])('rejects baggage: %s', (_name: string, request: CommitAncillarySelectionRequest) => {
    expect(() => validateAncillarySelection({ catalog, passengers, ...request })).toThrow(
      AncillarySelectionValidationError,
    );
  });

  it('uses the catalog values for a valid selection', () => {
    const result = validateAncillarySelection({
      catalog,
      passengers,
      ...selection({
        seats: [
          { intentPassengerId: 'local-adult', segmentId: 'seg-out', serviceId: 'seat-adult' },
        ],
        baggage: [{ intentPassengerId: 'local-adult', serviceId: 'bag-journey', quantity: 2 }],
      }),
    });

    expect(result).toEqual({
      currency: 'USD',
      seats: [
        {
          intentPassengerId: 'local-adult',
          segmentId: 'seg-out',
          serviceId: 'seat-adult',
          seatDesignator: '1A',
          amount: '18.00',
          currency: 'USD',
        },
      ],
      baggage: [
        {
          intentPassengerId: 'local-adult',
          serviceId: 'bag-journey',
          type: 'checked',
          weightValue: 23,
          weightUnit: 'kg',
          quantity: 2,
          amount: '50.00',
          currency: 'USD',
          segmentIds: ['seg-out', 'seg-back'],
        },
      ],
    });
  });

  it('rejects a selected currency different from the offer currency', () => {
    expect(() =>
      validateAncillarySelection({
        catalog: {
          ...catalog,
          baggageServices: [{ ...catalog.baggageServices[0], currency: 'EUR' }],
        },
        passengers,
        expectedCurrency: 'USD',
        ...selection({
          baggage: [{ intentPassengerId: 'local-adult', serviceId: 'bag-out', quantity: 1 }],
        }),
      }),
    ).toThrow(expect.objectContaining({ code: 'ANCILLARY_CURRENCY_MISMATCH' }));
  });
});
