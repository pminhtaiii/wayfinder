import 'reflect-metadata';
import { existsSync } from 'fs';
import { join } from 'path';
import { HttpException, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PassengerType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { ValidationError, validate } from 'class-validator';
import { BookingIntentController } from './booking-intent.controller';
import { FlightOfferNormalizer } from '@/supplier/search/flight-offer.normalizer';
import { FLIGHT_SEARCH_PORT, type FlightSearchPort } from '@/supplier/search/flight-search.port';
import type { NormalizedOffer } from './booking-readiness.service';

type ReadinessPassengerSource =
  | {
      type: 'traveler_profile';
      travelerProfileId: string;
      expectedProfileRevision?: number;
    }
  | {
      type: 'inline';
      givenName?: string | null;
      middleName?: string | null;
      familyName?: string | null;
      dateOfBirth?: string | null;
      gender?: string | null;
      title?: string | null;
      email?: string | null;
      phoneCountryCode?: string | null;
      phoneNumber?: string | null;
      documentType?: string | null;
      passportNumber?: string | null;
      passportExpiry?: string | null;
      issuingCountry?: string | null;
      nationality?: string | null;
    };

type ReadinessPassengerRequest = {
  offerPassengerId: string;
  passengerType: PassengerType;
  source: ReadinessPassengerSource;
};

type ReadinessRequest = {
  flightOfferId: string;
  passengers: ReadinessPassengerRequest[];
};

type ProfileResponseFixture = {
  profileId: string | null;
  revision: number;
  identity: {
    givenName: string | null;
    middleName: string | null;
    familyName: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    title: string | null;
  } | null;
  contact: {
    email: string | null;
    phoneCountryCode: string | null;
    phoneNumber: string | null;
  } | null;
  travelDocument: {
    documentType: string | null;
    passportNumber: string | null;
    passportExpiry: string | null;
    issuingCountry: string | null;
    nationality: string | null;
  } | null;
};

type LooseMock = Record<string, any>;

type ServiceHarness = {
  service: {
    getAdvisoryReadiness: (
      userId: string,
      dto: ReadinessRequest,
      context?: { traceId?: string; correlationId?: string },
    ) => Promise<unknown>;
    normalizeStoredOffer?: (rawOffer: unknown) => NormalizedOffer;
  };
  mocks: {
    prisma: LooseMock;
    profileService: LooseMock;
    airportsService: LooseMock;
    evaluator: LooseMock;
    observability: LooseMock;
    configService: LooseMock;
    auditService: LooseMock;
    flightSearchPort: FlightSearchPort;
  };
};

function projectRoot(): string {
  return join(__dirname, '..', '..', '..', '..');
}

function advisoryImplementationPaths() {
  return [
    join(__dirname, 'booking-readiness.service.ts'),
    join(__dirname, 'dto', 'booking-readiness.dto.ts'),
    join(__dirname, 'booking-readiness.observability.ts'),
  ];
}

function missingImplementationError(): Error {
  const missingPaths = advisoryImplementationPaths().filter((filePath) => !existsSync(filePath));
  return new Error(
    `Phase 6 advisory readiness endpoint is not implemented yet. Missing artifacts: ${missingPaths.join(', ')}`,
  );
}

function createLooseMock(): LooseMock {
  return new Proxy({} as Record<string, any>, {
    get(target: Record<string, any>, property: string) {
      if (!(property in target)) {
        target[property] = jest.fn();
      }
      return target[property];
    },
  }) as LooseMock;
}

function instantiateWithNamedMocks<T>(
  ClassRef: new (...args: unknown[]) => T,
  namedMocks: Record<string | symbol, unknown>,
): T {
  const constructorParamTypes =
    (Reflect.getMetadata('design:paramtypes', ClassRef) as Array<{ name?: string }>) ?? [];

  if (constructorParamTypes.length === 0) {
    throw new Error(`${ClassRef.name} constructor metadata is unavailable for test instantiation`);
  }

  const selfParamTypes =
    (Reflect.getMetadata('self:paramtypes', ClassRef) as Array<{ index: number; param: unknown }> | undefined) ?? [];

  const constructorArgs = constructorParamTypes.map((paramType, index) => {
    const injectToken = selfParamTypes.find((item) => item?.index === index)?.param;
    if (injectToken && (injectToken as string | symbol) in namedMocks) {
      return namedMocks[injectToken as string | symbol];
    }
    const tokenName = paramType?.name;
    if (tokenName && tokenName in namedMocks) {
      return namedMocks[tokenName];
    }
    if (tokenName === 'Object' && (FLIGHT_SEARCH_PORT as symbol) in namedMocks) {
      return namedMocks[FLIGHT_SEARCH_PORT as symbol];
    }
    return createLooseMock();
  });

  return new ClassRef(...constructorArgs);
}

function requireAdvisoryServiceClass(): new (...args: unknown[]) => ServiceHarness['service'] {
  if (!advisoryImplementationPaths().every((filePath) => existsSync(filePath))) {
    throw missingImplementationError();
  }

  const serviceModulePath = join(
    projectRoot(),
    'apps',
    'api',
    'src',
    'booking-intent',
    'booking-readiness.service',
  );
  const serviceModule = require(serviceModulePath) as {
    BookingReadinessService?: new (...args: unknown[]) => ServiceHarness['service'];
  };
  if (!serviceModule.BookingReadinessService) {
    throw new Error('BookingReadinessService export is missing from booking-readiness.service.ts');
  }
  return serviceModule.BookingReadinessService;
}

function requireReadinessRequestDtoClass(): new () => object {
  if (!advisoryImplementationPaths().every((filePath) => existsSync(filePath))) {
    throw missingImplementationError();
  }

  const dtoModulePath = join(
    projectRoot(),
    'apps',
    'api',
    'src',
    'booking-intent',
    'dto',
    'booking-readiness.dto',
  );
  const dtoModule = require(dtoModulePath) as { BookingReadinessRequestDto?: new () => object };
  if (!dtoModule.BookingReadinessRequestDto) {
    throw new Error('BookingReadinessRequestDto export is missing from booking-readiness.dto.ts');
  }
  return dtoModule.BookingReadinessRequestDto;
}

function buildOwnedProfile(
  overrides: Partial<ProfileResponseFixture> = {},
): ProfileResponseFixture {
  return {
    profileId: 'profile-owned',
    revision: 3,
    identity: {
      givenName: 'Ada',
      middleName: null,
      familyName: 'Lovelace',
      dateOfBirth: '1990-01-01',
      gender: 'female',
      title: 'Ms',
    },
    contact: {
      email: 'ada@example.com',
      phoneCountryCode: '+84',
      phoneNumber: '987654321',
    },
    travelDocument: {
      documentType: 'passport',
      passportNumber: 'P1234567',
      passportExpiry: '2032-02-15',
      issuingCountry: 'VN',
      nationality: 'VN',
    },
    ...overrides,
  };
}

function buildStoredOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'offer-11111111-1111-4111-8111-111111111111',
    rawOffer: {
      id: 'off_001',
      total_amount: '450.00',
      total_currency: 'USD',
      expires_at: '2030-08-10T15:45:00Z',
      passengers: [
        { id: 'pas_001', type: 'adult' },
        { id: 'pas_002', type: 'child' },
      ],
      slices: [
        {
          duration: 'PT8H30M',
          segments: [
            {
              id: 'seg_001',
              origin: { iata_code: 'sgn' },
              destination: { iata_code: 'hnl' },
              departing_at: '2030-08-15T08:00:00Z',
              arriving_at: '2030-08-15T13:00:00Z',
            },
            {
              id: 'seg_002',
              origin: { iata_code: 'HNL' },
              destination: { iata_code: 'LAX' },
              departing_at: '2030-08-15T16:00:00Z',
              arriving_at: '2030-08-15T22:30:00Z',
            },
          ],
        },
        {
          duration: 'PT15H',
          segments: [
            {
              id: 'seg_003',
              origin: { iata_code: 'LAX' },
              destination: { iata_code: 'SGN' },
              departing_at: '2030-08-20T01:00:00Z',
              arriving_at: '2030-08-20T05:45:00Z',
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

function buildReadinessRequest(overrides: Partial<ReadinessRequest> = {}): ReadinessRequest {
  return {
    flightOfferId: '11111111-1111-4111-8111-111111111111',
    passengers: [
      {
        offerPassengerId: 'pas_001',
        passengerType: PassengerType.ADULT,
        source: {
          type: 'traveler_profile',
          travelerProfileId: 'profile-owned',
        },
      },
      {
        offerPassengerId: 'pas_002',
        passengerType: PassengerType.CHILD,
        source: {
          type: 'inline',
          givenName: 'Companion',
          familyName: 'Traveler',
        },
      },
    ],
    ...overrides,
  };
}

function createSuccessReadinessResult(profileRevision: number | null) {
  return {
    scope: 'INTERNATIONAL',
    ready: true,
    passengers: [
      {
        passengerType: PassengerType.ADULT,
        passengerOrdinal: 1,
        ready: true,
        profileRevision,
        sections: [
          {
            name: 'identity',
            fields: [{ name: 'givenName', status: 'filled', reason: null, blocking: false }],
          },
        ],
      },
    ],
  };
}

function createServiceHarness(): ServiceHarness {
  const ServiceClass = requireAdvisoryServiceClass();
  const prisma = createLooseMock();
  const profileService = createLooseMock();
  const airportsService = createLooseMock();
  const evaluator = createLooseMock();
  const observability = createLooseMock();
  const configService = createLooseMock();
  const auditService = createLooseMock();
  const flightSearchPort = {
    search: jest.fn(),
    getOfferById: jest.fn(),
    normalizeStoredOffer: jest.fn((rawOffer: unknown) =>
      FlightOfferNormalizer.normalizeStoredOffer(rawOffer),
    ),
  };

  configService.get.mockImplementation((key: string) => {
    if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
      return 'true';
    }
    return undefined;
  });

  const service = instantiateWithNamedMocks(ServiceClass, {
    PrismaService: prisma,
    ProfileService: profileService,
    AirportsService: airportsService,
    BookingReadinessEvaluator: evaluator,
    BookingReadinessObservability: observability,
    ConfigService: configService,
    AuditService: auditService,
    FlightSearchPort: flightSearchPort,
    [FLIGHT_SEARCH_PORT as symbol]: flightSearchPort,
  });

  if (typeof service.getAdvisoryReadiness !== 'function') {
    throw new Error('BookingReadinessService.getAdvisoryReadiness is not implemented yet');
  }

  return {
    service,
    mocks: {
      prisma,
      profileService,
      airportsService,
      evaluator,
      observability,
      configService,
      auditService,
      flightSearchPort: flightSearchPort as unknown as FlightSearchPort,
    },
  };
}

function getHttpStatus(error: unknown): number | null {
  if (!(error instanceof HttpException)) {
    return null;
  }
  return error.getStatus();
}

function getHttpCode(error: unknown): string | null {
  if (!(error instanceof HttpException)) {
    return null;
  }
  const response = error.getResponse();
  if (typeof response === 'string') {
    return response;
  }
  return typeof response === 'object' && response !== null && 'code' in response
    ? String((response as { code: unknown }).code)
    : null;
}

function collectMockCallPayloads(mockObject: LooseMock): string {
  return JSON.stringify(Object.values(mockObject).flatMap((mockFn) => mockFn.mock.calls));
}

function flattenValidationErrors(
  errors: ValidationError[],
  parentPath = '',
): Array<{ path: string; constraints: string[] }> {
  return errors.flatMap((error) => {
    const currentPath = parentPath ? `${parentPath}.${error.property}` : error.property;
    const ownConstraints = Object.keys(error.constraints ?? {}).map((constraint) => ({
      path: currentPath,
      constraint,
    }));
    const childConstraints = flattenValidationErrors(error.children ?? [], currentPath).map(
      (entry) => ({
        path: entry.path,
        constraint: entry.constraints[0],
      }),
    );

    return [...ownConstraints, ...childConstraints].map((entry) => ({
      path: entry.path,
      constraints: [entry.constraint],
    }));
  });
}

function requireCanonicalReadinessControllerClass(): new (...args: unknown[]) => object {
  if (
    !existsSync(join(__dirname, 'booking-readiness.controller.ts')) &&
    !existsSync(join(__dirname, 'booking-intent.controller.ts'))
  ) {
    throw missingImplementationError();
  }

  const controllerModulePath = join(
    projectRoot(),
    'apps',
    'api',
    'src',
    'booking-intent',
    'booking-intent.controller',
  );
  const controllerModule = require(controllerModulePath) as {
    BookingIntentsReadinessController?: new (...args: unknown[]) => object;
    BookingReadinessController?: new (...args: unknown[]) => object;
  };

  const canonicalController =
    controllerModule.BookingIntentsReadinessController ??
    controllerModule.BookingReadinessController;

  if (!canonicalController) {
    throw new Error(
      'Canonical plural readiness controller export is missing. Expected BookingIntentsReadinessController or BookingReadinessController.',
    );
  }

  return canonicalController;
}

describe('BookingReadinessService RED slice', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('validates the passenger source discriminated union and invalid passenger matrix', async () => {
    const BookingReadinessRequestDto = requireReadinessRequestDtoClass();

    const invalidPayloads = [
      {
        expectedPath: 'passengers.0.source',
        expectedConstraint: 'bookingReadinessPassengerSource',
        payload: {
          flightOfferId: '11111111-1111-4111-8111-111111111111',
          passengers: [
            { offerPassengerId: 'pas_001', passengerType: PassengerType.ADULT, source: {} },
          ],
        },
      },
      {
        expectedPath: 'passengers.0.source',
        expectedConstraint: 'bookingReadinessPassengerSource',
        payload: {
          flightOfferId: '11111111-1111-4111-8111-111111111111',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerType: PassengerType.ADULT,
              source: {
                type: 'traveler_profile',
                travelerProfileId: 'profile-owned',
                givenName: 'Ada',
              },
            },
          ],
        },
      },
      {
        expectedPath: 'passengers',
        expectedConstraint: 'hasValidPassengerMatrix',
        payload: {
          flightOfferId: '11111111-1111-4111-8111-111111111111',
          passengers: [
            {
              offerPassengerId: 'pas_001',
              passengerType: PassengerType.INFANT,
              source: { type: 'inline', givenName: 'Baby' },
            },
          ],
        },
      },
    ];

    for (const invalidPayload of invalidPayloads) {
      const dto = plainToInstance(BookingReadinessRequestDto, invalidPayload.payload);
      const errors = await validate(dto);
      const flattenedErrors = flattenValidationErrors(errors);

      expect(flattenedErrors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: invalidPayload.expectedPath,
            constraints: expect.arrayContaining([invalidPayload.expectedConstraint]),
          }),
        ]),
      );
    }
  });

  it('resolves an owned traveler profile source and projects the evaluated profile revision', async () => {
    const { service, mocks } = createServiceHarness();
    const request = buildReadinessRequest();
    const storedOffer = buildStoredOffer();

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(storedOffer),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(3));

    const result = await service.getAdvisoryReadiness('user-1', request, {
      traceId: 'trace-123',
      correlationId: 'corr-123',
    });

    expect(mocks.profileService.getProfile).toHaveBeenCalledWith('user-1');
    expect(mocks.evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        passengers: [
          expect.objectContaining({
            passengerType: PassengerType.ADULT,
            passengerOrdinal: 1,
            profileRevision: 3,
            givenName: 'Ada',
            email: 'ada@example.com',
          }),
          expect.objectContaining({
            passengerType: PassengerType.CHILD,
            passengerOrdinal: 2,
            profileRevision: null,
            givenName: 'Companion',
          }),
        ],
      }),
    );
    expect(result).toEqual(createSuccessReadinessResult(3));
  });

  it('rejects foreign traveler profile ids with a safe passenger-mapping error that does not leak profile ids', async () => {
    const { service, mocks } = createServiceHarness();
    const request = buildReadinessRequest({
      passengers: [
        {
          offerPassengerId: 'pas_001',
          passengerType: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: 'profile-foreign',
          },
        },
      ],
    });

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(
      buildOwnedProfile({ profileId: 'profile-owned' }),
    );

    await expect(service.getAdvisoryReadiness('user-1', request)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PASSENGER_MAPPING_INVALID',
      }),
      status: 422,
      message: expect.not.stringContaining('profile-foreign'),
    });
  });

  it('rejects a subset of stored passengers with 422 PASSENGER_MAPPING_INVALID before evaluation', async () => {
    const { service, mocks } = createServiceHarness();
    const request = buildReadinessRequest({
      passengers: [
        {
          offerPassengerId: 'pas_001',
          passengerType: PassengerType.ADULT,
          source: {
            type: 'traveler_profile',
            travelerProfileId: 'profile-owned',
          },
        },
      ],
    });

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());

    await expect(service.getAdvisoryReadiness('user-1', request)).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'PASSENGER_MAPPING_INVALID',
      }),
      status: 422,
    });
    expect(mocks.profileService.getProfile).not.toHaveBeenCalled();
    expect(mocks.airportsService.findCountriesByIataCodes).not.toHaveBeenCalled();
    expect(mocks.evaluator.evaluate).not.toHaveBeenCalled();
  });

  it('evaluates inline passengers without reading a profile and returns null profile revisions', async () => {
    const { service, mocks } = createServiceHarness();
    const request = buildReadinessRequest({
      passengers: [
        {
          offerPassengerId: 'pas_001',
          passengerType: PassengerType.ADULT,
          source: {
            type: 'inline',
            givenName: 'Inline',
            middleName: null,
            familyName: 'Traveler',
            dateOfBirth: '1992-03-04',
            gender: 'male',
            title: 'Mr',
            email: 'inline@example.com',
            phoneCountryCode: '+1',
            phoneNumber: '5551112222',
            documentType: 'passport',
            passportNumber: 'X1234567',
            passportExpiry: '2031-01-01',
            issuingCountry: 'US',
            nationality: 'US',
          },
        },
        {
          offerPassengerId: 'pas_002',
          passengerType: PassengerType.CHILD,
          source: {
            type: 'inline',
            givenName: 'Child',
            familyName: 'Traveler',
          },
        },
      ],
    });

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(null));

    const result = await service.getAdvisoryReadiness('user-1', request);

    expect(mocks.profileService.getProfile).not.toHaveBeenCalled();
    expect(mocks.evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        passengers: [
          expect.objectContaining({
            profileRevision: null,
            givenName: 'Inline',
          }),
          expect.objectContaining({
            passengerType: PassengerType.CHILD,
            passengerOrdinal: 2,
            profileRevision: null,
            givenName: 'Child',
          }),
        ],
      }),
    );
    expect(result).toEqual(createSuccessReadinessResult(null));
  });

  it('returns a safe incomplete readiness result for an owned profile with missing fields', async () => {
    const { service, mocks } = createServiceHarness();

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(
      buildOwnedProfile({
        identity: {
          givenName: null,
          middleName: null,
          familyName: null,
          dateOfBirth: null,
          gender: null,
          title: null,
        },
        contact: null,
        travelDocument: null,
      }),
    );
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue({
      scope: 'INTERNATIONAL',
      ready: false,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          ready: false,
          profileRevision: 3,
          sections: [
            {
              name: 'identity',
              fields: [
                { name: 'givenName', status: 'missing', reason: 'REQUIRED', blocking: true },
              ],
            },
          ],
        },
      ],
    });

    const result = await service.getAdvisoryReadiness('user-1', buildReadinessRequest());

    expect(result).toEqual(
      expect.objectContaining({
        ready: false,
        passengers: [expect.objectContaining({ profileRevision: 3, ready: false })],
      }),
    );
  });

  it('rejects duplicate, missing, mismatched, and invalid passenger mappings with 422 PASSENGER_MAPPING_INVALID', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());

    const invalidRequests: ReadinessRequest[] = [
      buildReadinessRequest({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            passengerType: PassengerType.ADULT,
            source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
          },
          {
            offerPassengerId: 'pas_001',
            passengerType: PassengerType.ADULT,
            source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
          },
        ],
      }),
      buildReadinessRequest({
        passengers: [
          {
            offerPassengerId: 'pas_missing',
            passengerType: PassengerType.ADULT,
            source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
          },
        ],
      }),
      buildReadinessRequest({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            passengerType: PassengerType.CHILD,
            source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
          },
        ],
      }),
      buildReadinessRequest({
        passengers: [
          {
            offerPassengerId: 'pas_001',
            passengerType: PassengerType.INFANT,
            source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
          },
        ],
      }),
    ];

    for (const invalidRequest of invalidRequests) {
      await service.getAdvisoryReadiness('user-1', invalidRequest).catch((error: unknown) => {
        expect(getHttpStatus(error)).toBe(422);
        expect(getHttpCode(error)).toBe('PASSENGER_MAPPING_INVALID');
      });
    }
  });

  it('normalizes every slice segment, derives trip completion from the latest arrival date, and batches airport-country lookup once', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(3));

    await service.getAdvisoryReadiness('user-1', buildReadinessRequest());

    expect(mocks.airportsService.findCountriesByIataCodes).toHaveBeenCalledTimes(1);
    expect(mocks.airportsService.findCountriesByIataCodes).toHaveBeenCalledWith([
      'SGN',
      'HNL',
      'LAX',
    ]);
    expect(mocks.evaluator.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        tripCompletionDate: '2030-08-20',
        segments: [
          expect.objectContaining({
            originCountryCode: 'VN',
            destinationCountryCode: 'US',
            arrivalDate: '2030-08-15',
          }),
          expect.objectContaining({
            originCountryCode: 'US',
            destinationCountryCode: 'US',
            arrivalDate: '2030-08-15',
          }),
          expect.objectContaining({
            originCountryCode: 'US',
            destinationCountryCode: 'VN',
            arrivalDate: '2030-08-20',
          }),
        ],
      }),
    );
  });

  it('maps missing airport-country data to a normal UNKNOWN readiness result instead of a dependency failure', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', null],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue({
      scope: 'UNKNOWN',
      ready: false,
      passengers: [
        {
          passengerType: PassengerType.ADULT,
          passengerOrdinal: 1,
          ready: false,
          profileRevision: 3,
          sections: [
            {
              name: 'itinerary',
              fields: [
                {
                  name: 'scope',
                  status: 'unknown',
                  reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
                  blocking: true,
                },
              ],
            },
          ],
        },
      ],
    });

    const result = await service.getAdvisoryReadiness('user-1', buildReadinessRequest());
    expect(result).toEqual(
      expect.objectContaining({
        scope: 'UNKNOWN',
        ready: false,
        passengers: [
          expect.objectContaining({
            sections: [
              expect.objectContaining({
                name: 'itinerary',
                fields: [
                  expect.objectContaining({
                    reason: 'AIRPORT_COUNTRY_UNAVAILABLE',
                    blocking: true,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('maps stored offer expiry from local raw offer metadata to 409 OFFER_EXPIRED without writes or supplier calls', async () => {
    const { service, mocks } = createServiceHarness();
    const baseStored = buildStoredOffer();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(
        buildStoredOffer({
          rawOffer: {
            ...(baseStored.rawOffer as Record<string, unknown>),
            expires_at: '2026-08-02T12:00:00Z',
          },
        }),
      ),
    } as unknown as jest.Mock;

    await service
      .getAdvisoryReadiness('user-1', buildReadinessRequest())
      .catch((error: unknown) => {
        expect(getHttpStatus(error)).toBe(409);
        expect(getHttpCode(error)).toBe('OFFER_EXPIRED');
      });

    expect(mocks.flightSearchPort.getOfferById).not.toHaveBeenCalled();
    expect(collectMockCallPayloads(mocks.auditService)).toBe('[]');
  });

  it('does not write profiles, intents, or passenger snapshots during advisory readiness', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.prisma.bookingIntent = { create: jest.fn() } as unknown as jest.Mock;
    mocks.prisma.bookingIntentPassenger = { create: jest.fn() } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(3));

    await service.getAdvisoryReadiness('user-1', buildReadinessRequest());

    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
    expect(mocks.prisma.bookingIntent.create).not.toHaveBeenCalled();
    expect(mocks.prisma.bookingIntentPassenger.create).not.toHaveBeenCalled();
    expect(mocks.profileService.updateProfile).not.toHaveBeenCalled();
    expect(mocks.flightSearchPort.getOfferById).not.toHaveBeenCalled();
  });

  it('fails feature-disabled requests before reading offers, profiles, or airports', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.configService.get.mockImplementation((key: string) => {
      if (key === 'FEATURE_FLAG_BOOKING_READINESS') {
        return 'false';
      }
      return undefined;
    });

    await service
      .getAdvisoryReadiness('user-1', buildReadinessRequest())
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(NotFoundException);
        expect(getHttpStatus(error)).toBe(404);
      });

    expect(collectMockCallPayloads(mocks.prisma)).toBe('[]');
    expect(collectMockCallPayloads(mocks.profileService)).toBe('[]');
    expect(collectMockCallPayloads(mocks.airportsService)).toBe('[]');
  });

  it('propagates trace and correlation ids to observability with pii-free metadata', async () => {
    const { service, mocks } = createServiceHarness();
    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue(buildStoredOffer()),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(3));

    await service.getAdvisoryReadiness('user-1', buildReadinessRequest(), {
      traceId: 'trace-phase6',
      correlationId: 'corr-phase6',
    });

    const observabilityPayload = collectMockCallPayloads(mocks.observability);
    expect(observabilityPayload).toContain('trace-phase6');
    expect(observabilityPayload).toContain('corr-phase6');
    expect(observabilityPayload).not.toContain('profile-owned');
    expect(observabilityPayload).not.toContain('Ada');
    expect(observabilityPayload).not.toContain('Lovelace');
    expect(observabilityPayload).not.toContain('1990-01-01');
    expect(observabilityPayload).not.toContain('ada@example.com');
    expect(observabilityPayload).not.toContain('+84');
    expect(observabilityPayload).not.toContain('987654321');
    expect(observabilityPayload).not.toContain('P1234567');
    expect(observabilityPayload).not.toContain('2032-02-15');
    expect(observabilityPayload).not.toContain('VN');
    expect(observabilityPayload).not.toContain('pas_001');
  });
});

describe('BookingIntentController advisory readiness RED slice', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('preserves existing singular intent handlers while requiring a canonical plural readiness controller boundary', async () => {
    const bookingIntentService = {
      createIntent: jest.fn(),
      getPrefill: jest.fn(),
      getIntent: jest.fn(),
      getAdvisoryReadiness: jest
        .fn()
        .mockResolvedValue({ scope: 'DOMESTIC', ready: true, passengers: [] }),
    };

    const singularController = new BookingIntentController(bookingIntentService as never);
    expect(typeof singularController.createIntent).toBe('function');
    expect(typeof singularController.getPrefill).toBe('function');
    expect(typeof singularController.getIntent).toBe('function');

    const CanonicalReadinessController = requireCanonicalReadinessControllerClass();
    const canonicalControllerPath = Reflect.getMetadata(
      PATH_METADATA,
      CanonicalReadinessController,
    );
    expect(canonicalControllerPath).toBe('bookings/intents');

    const controller = instantiateWithNamedMocks(CanonicalReadinessController, {
      BookingIntentService: bookingIntentService,
    }) as {
      createReadiness?: (
        req: { user: { id: string } },
        headers: Record<string, string>,
        dto: ReadinessRequest,
        res: { setHeader: jest.Mock; removeHeader: jest.Mock },
      ) => Promise<unknown>;
    };
    expect(typeof controller.createReadiness).toBe('function');

    expect(Reflect.getMetadata(PATH_METADATA, controller.createReadiness as Function)).toBe(
      'readiness',
    );
    expect(Reflect.getMetadata(METHOD_METADATA, controller.createReadiness as Function)).toBe(1);

    const response = {
      setHeader: jest.fn(),
      removeHeader: jest.fn(),
    };

    await controller.createReadiness?.(
      { user: { id: 'user-1' } },
      {
        'x-trace-id': 'trace-controller',
        'x-correlation-id': 'corr-controller',
      },
      buildReadinessRequest(),
      response,
    );

    expect(bookingIntentService.getAdvisoryReadiness).toHaveBeenCalledWith(
      'user-1',
      buildReadinessRequest(),
      {
        traceId: 'trace-controller',
        correlationId: 'corr-controller',
      },
    );
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store, private');
    expect(response.removeHeader).toHaveBeenCalledWith('ETag');
  });
});

describe('Raw-Reader Replacement Parity (T015)', () => {
  const canonicalStoredOffer: Record<string, unknown> = {
    id: 'off_canonical_001',
    total_amount: '450.00',
    total_currency: 'USD',
    expires_at: '2030-08-10T15:45:00Z',
    passengers: [
      { id: 'pas_001', type: 'adult' },
      { id: 'pas_002', type: 'child' },
      { id: 'pas_003', type: 'infant' },
    ],
    slices: [
      {
        duration: 'PT8H30M',
        segments: [
          {
            id: 'seg_001',
            origin: { iata_code: 'SGN' },
            destination: { iata_code: 'HNL' },
            departing_at: '2030-08-15T08:00:00Z',
            arriving_at: '2030-08-15T13:00:00Z',
            duration: 'PT5H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '123',
          },
          {
            id: 'seg_002',
            origin: { iata_code: 'HNL' },
            destination: { iata_code: 'LAX' },
            departing_at: '2030-08-15T16:00:00Z',
            arriving_at: '2030-08-15T22:30:00Z',
            duration: 'PT3H30M',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '456',
          },
        ],
      },
      {
        duration: 'PT15H',
        segments: [
          {
            id: 'seg_003',
            origin: { iata_code: 'LAX' },
            destination: { iata_code: 'SGN' },
            departing_at: '2030-08-20T01:00:00Z',
            arriving_at: '2030-08-20T16:00:00Z',
            duration: 'PT15H',
            marketing_carrier: { iata_code: 'VN', name: 'Vietnam Airlines' },
            marketing_carrier_flight_number: '789',
          },
        ],
      },
    ],
  };

  it('characterizes passenger extraction: port normalization matches existing reader 100%', () => {
    const { service } = createServiceHarness();
    expect(service.normalizeStoredOffer).toBeDefined();

    const existingNormalized = service.normalizeStoredOffer!(canonicalStoredOffer);
    const normalizedPortOffer = FlightOfferNormalizer.normalizeStoredOffer(canonicalStoredOffer);

    expect(normalizedPortOffer).not.toBeNull();
    const portPassengers = normalizedPortOffer!.passengers.map((p) => ({
      id: p.supplierPassengerId,
      type: p.type as PassengerType,
    }));

    expect(portPassengers).toEqual(existingNormalized.passengers);
    expect(portPassengers).toEqual([
      { id: 'pas_001', type: PassengerType.ADULT },
      { id: 'pas_002', type: PassengerType.CHILD },
      { id: 'pas_003', type: PassengerType.INFANT },
    ]);
  });

  it('characterizes segment extraction and trip completion: port normalization matches existing reader 100%', () => {
    const { service } = createServiceHarness();

    const existingNormalized = service.normalizeStoredOffer!(canonicalStoredOffer);
    const normalizedPortOffer = FlightOfferNormalizer.normalizeStoredOffer(canonicalStoredOffer);

    expect(normalizedPortOffer).not.toBeNull();
    const allPortSegments = [
      ...normalizedPortOffer!.segments,
      ...(normalizedPortOffer!.returnSegments ?? []),
    ];

    const portSegments = allPortSegments.map((s) => ({
      originCountryCode: s.departureAirport,
      destinationCountryCode: s.arrivalAirport,
      arrivalDate: s.arrivalTime.slice(0, 10),
    }));

    const portTripCompletionDate = portSegments.reduce<string | null>(
      (latest, segment) =>
        latest === null || segment.arrivalDate > latest ? segment.arrivalDate : latest,
      null,
    );

    const portAirportCodes = [
      ...new Set(allPortSegments.flatMap((s) => [s.departureAirport, s.arrivalAirport])),
    ];

    expect(portSegments).toEqual(existingNormalized.segments);
    expect(portTripCompletionDate).toBe(existingNormalized.tripCompletionDate);
    expect(portTripCompletionDate).toBe('2030-08-20');
    expect(portAirportCodes.sort()).toEqual(existingNormalized.airportCodes.sort());
  });

  it('characterizes evaluation input parity when consuming normalized offer fields', async () => {
    const { service, mocks } = createServiceHarness();
    const normalizedPortOffer = FlightOfferNormalizer.normalizeStoredOffer(canonicalStoredOffer);
    expect(normalizedPortOffer).not.toBeNull();

    mocks.prisma.flightOffer = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'offer-1',
        rawOffer: canonicalStoredOffer,
      }),
    } as unknown as jest.Mock;
    mocks.profileService.getProfile.mockResolvedValue(buildOwnedProfile());
    mocks.airportsService.findCountriesByIataCodes.mockResolvedValue(
      new Map([
        ['SGN', 'VN'],
        ['HNL', 'US'],
        ['LAX', 'US'],
      ]),
    );
    mocks.evaluator.evaluate.mockReturnValue(createSuccessReadinessResult(3));

    const request: ReadinessRequest = {
      flightOfferId: 'offer-1',
      passengers: [
        {
          offerPassengerId: 'pas_001',
          passengerType: PassengerType.ADULT,
          source: { type: 'traveler_profile', travelerProfileId: 'profile-owned' },
        },
        {
          offerPassengerId: 'pas_002',
          passengerType: PassengerType.CHILD,
          source: { type: 'inline', givenName: 'Child', familyName: 'Traveler' },
        },
        {
          offerPassengerId: 'pas_003',
          passengerType: PassengerType.INFANT,
          source: { type: 'inline', givenName: 'Infant', familyName: 'Traveler' },
        },
      ],
    };

    await service.getAdvisoryReadiness('user-1', request);

    expect(mocks.evaluator.evaluate).toHaveBeenCalledTimes(1);
    const evaluationInput = mocks.evaluator.evaluate.mock.calls[0][0] as {
      tripCompletionDate: string;
      segments: Array<{
        originCountryCode: string | null;
        destinationCountryCode: string | null;
        arrivalDate: string;
      }>;
      passengers: Array<{ passengerType: PassengerType; passengerOrdinal: number }>;
    };

    const allPortSegments = [
      ...normalizedPortOffer!.segments,
      ...(normalizedPortOffer!.returnSegments ?? []),
    ];
    const portTripCompletionDate = allPortSegments.reduce<string | null>((latest, segment) => {
      const arrivalDate = segment.arrivalTime.slice(0, 10);
      return latest === null || arrivalDate > latest ? arrivalDate : latest;
    }, null);

    expect(evaluationInput.tripCompletionDate).toBe(portTripCompletionDate);
    expect(evaluationInput.passengers.length).toBe(3);
    expect(evaluationInput.passengers[0].passengerOrdinal).toBe(1);
    expect(evaluationInput.passengers[1].passengerOrdinal).toBe(2);
    expect(evaluationInput.passengers[2].passengerOrdinal).toBe(3);
  });

  it('characterizes malformed stored offer rejection: normalizeStoredOffer returns null matching the error path', async () => {
    const { service, mocks } = createServiceHarness();

    const legacyMalformedPayloads: readonly unknown[] = [
      null,
      undefined,
      {},
      { slices: [], passengers: [] },
      {
        slices: [{ segments: [] }],
        passengers: [{ id: 'p1', type: 'adult' }],
      },
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HNL' },
                arriving_at: 'not-a-valid-date',
              },
            ],
          },
        ],
        passengers: [{ id: 'p1', type: 'adult' }],
      },
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HNL' },
                arriving_at: '2030-08-15T13:00:00Z',
              },
            ],
          },
        ],
        passengers: [{ id: 'p1', type: 'unknown_type' }],
      },
      {
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HNL' },
                arriving_at: '2030-08-15T13:00:00Z',
              },
            ],
          },
        ],
        passengers: [],
      },
    ];

    for (const corrupted of legacyMalformedPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(corrupted)).toBeNull();

      expect(() => service.normalizeStoredOffer!(corrupted)).toThrow();

      mocks.prisma.flightOffer = {
        findUnique: jest.fn().mockResolvedValue({ id: 'bad-offer', rawOffer: corrupted }),
      } as unknown as jest.Mock;

      const dummyRequest: ReadinessRequest = {
        flightOfferId: 'bad-offer',
        passengers: [
          {
            offerPassengerId: 'p1',
            passengerType: PassengerType.ADULT,
            source: { type: 'inline', givenName: 'Test' },
          },
        ],
      };

      await expect(service.getAdvisoryReadiness('user-1', dummyRequest)).rejects.toThrow();
    }

    const supplierCorruptedPayloads: readonly unknown[] = [
      { id: '' },
      { id: 'off_bad_1', total_amount: '0', total_currency: 'USD', slices: [] },
      { id: 'off_bad_2', total_amount: '-50', total_currency: 'USD', slices: [] },
      { id: 'off_bad_3', total_amount: '100', total_currency: '', slices: [] },
      {
        id: 'off_bad_4',
        total_amount: '100',
        total_currency: 'USD',
        slices: [
          {
            segments: [
              {
                origin: { iata_code: 'SGN' },
                destination: { iata_code: 'HNL' },
                departing_at: 'not-an-iso-date',
                arriving_at: '2030-08-15T13:00:00Z',
              },
            ],
          },
        ],
        passengers: [{ id: 'p1', type: 'adult' }],
      },
    ];

    for (const corrupted of supplierCorruptedPayloads) {
      expect(FlightOfferNormalizer.normalizeStoredOffer(corrupted)).toBeNull();
    }
  });
});
