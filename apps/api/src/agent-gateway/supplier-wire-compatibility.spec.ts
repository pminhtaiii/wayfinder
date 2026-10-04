import { createHmac } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { BookingStatus } from '@prisma/client';
import {
  SelectionAttestationService,
  SelectionAttestationOffer,
} from './selection-attestation.service';
import { BookingManagementService } from '@/booking-management/booking-management.service';
import { BookingLifecycleService } from '@/booking-lifecycle/booking-lifecycle.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '@/prisma/prisma.service';
import { FlightOffer, FLIGHT_SEARCH_PORT } from '@/supplier/search/flight-search.port';
import { FlightsService } from '@/flights/flights.service';
import { CacheService } from '@/cache/cache.service';
import { AuditService } from '@/audit/audit.service';
import { FlightSearchOrchestratorService } from '@/flights/flight-search-orchestrator.service';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('Supplier Wire Compatibility Regression', () => {
  describe('SelectionAttestationService wire & HMAC compatibility', () => {
    let service: SelectionAttestationService;
    let configService: ConfigService;
    const testSecret = 'wire-compat-secret-key-32chars!!';

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          SelectionAttestationService,
          {
            provide: ConfigService,
            useValue: {
              get: jest.fn().mockImplementation((key: string) => {
                if (key === 'ATTESTATION_SECRET') return testSecret;
                return null;
              }),
            },
          },
        ],
      }).compile();

      service = module.get<SelectionAttestationService>(SelectionAttestationService);
      configService = module.get<ConfigService>(ConfigService);
    });

    it('maps neutral domain identity to legacy wire envelope preserving exact keys', () => {
      const offer: FlightOffer = {
        id: 'offer-internal-uuid-1',
        supplierOfferId: 'off_neutral_supplier_123',
        totalAmount: '250.00',
        price: 250,
        currency: 'USD',
        offerExpiresAt: '2026-10-10T12:00:00Z',
        passengers: [{ supplierPassengerId: 'pas_1', type: 'ADULT' }],
        airline: 'BA',
        flightNumber: 'BA100',
        departureAirport: 'LHR',
        arrivalAirport: 'JFK',
        departureTime: '2026-10-10T08:00:00Z',
        arrivalTime: '2026-10-10T11:00:00Z',
        duration: 480,
        stops: 0,
        fareClass: 'Y',
        baggageAllowance: '1',
        segments: [],
        returnSegments: null,
        conditions: { refundable: true, changeable: false, changeBeforeDeparture: null },
        matchInput: {
          id: 'offer-internal-uuid-1',
          price: 250,
          currency: 'USD',
          stops: 0,
          duration: 480,
          outboundDepartureHour: 8,
          outboundArrivalHour: 11,
          carrierCodes: ['BA'],
          cabinClass: 'economy',
          hasCheckedBaggage: true,
          originalIndex: 0,
        },
        rawSupplierPayload: {},
      };

      const signedOffer: SelectionAttestationOffer = {
        flightOfferId: offer.id,
        duffelOfferId: offer.supplierOfferId,
      };

      expect(Object.keys(signedOffer)).toEqual(['flightOfferId', 'duffelOfferId']);
      expect(signedOffer.flightOfferId).toBe('offer-internal-uuid-1');
      expect(signedOffer.duffelOfferId).toBe('off_neutral_supplier_123');
    });

    it('preserves exact sel_v1_ JSON key order and HMAC signature bytes with neutral inputs', async () => {
      const issuedAt = '2026-10-04T12:00:00.000Z';
      const expiresAt = '2026-10-04T12:15:00.000Z';
      const offers: SelectionAttestationOffer[] = [
        { flightOfferId: 'fo-compat-1', duffelOfferId: 'supp-off-1' },
      ];

      const token = await service.signSelectionAttestation(
        'user-compat',
        'session-compat',
        1,
        expiresAt,
        offers,
        issuedAt,
      );

      expect(token.startsWith('sel_v1_')).toBe(true);
      const tokenBody = token.slice('sel_v1_'.length);
      const [encodedPayload, signature] = tokenBody.split('.');
      const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');

      const parsedPayload: unknown = JSON.parse(decodedJson);
      expect(isRecord(parsedPayload)).toBe(true);
      if (!isRecord(parsedPayload)) {
        throw new Error('Expected parsedPayload to be record');
      }

      expect(Object.keys(parsedPayload)).toEqual([
        'userId',
        'sessionId',
        'version',
        'issuedAt',
        'expiresAt',
        'offers',
      ]);

      const parsedOffers: unknown = parsedPayload.offers;
      expect(Array.isArray(parsedOffers)).toBe(true);
      if (!Array.isArray(parsedOffers) || parsedOffers.length === 0) {
        throw new Error('Expected offers array');
      }
      expect(Object.keys(parsedOffers[0])).toEqual(['flightOfferId', 'duffelOfferId']);

      const expectedHmacKey: unknown = configService.get<unknown>('ATTESTATION_SECRET');
      if (typeof expectedHmacKey !== 'string') {
        throw new Error('Expected ATTESTATION_SECRET test fixture to be configured');
      }

      const expectedSignature = createHmac('sha256', expectedHmacKey)
        .update(decodedJson, 'utf8')
        .digest('hex');
      expect(signature).toBe(expectedSignature);
    });

    it('strips any unverified extra properties so signed payload keeps strict legacy envelope', async () => {
      const issuedAt = '2026-10-04T12:00:00.000Z';
      const expiresAt = '2026-10-04T12:15:00.000Z';
      // Simulating caller passing offer with extra properties
      const inputOffer = {
        supplierOfferId: 'unverified-alias',
        flightOfferId: 'fo-strip-1',
        duffelOfferId: 'supp-strip-1',
      };

      const token = await service.signSelectionAttestation(
        'user-strip',
        'session-strip',
        1,
        expiresAt,
        [inputOffer],
        issuedAt,
      );

      const tokenBody = token.slice('sel_v1_'.length);
      const [encodedPayload] = tokenBody.split('.');
      const decodedJson = Buffer.from(encodedPayload, 'base64url').toString('utf8');
      const parsedPayload: unknown = JSON.parse(decodedJson);
      if (!isRecord(parsedPayload) || !Array.isArray(parsedPayload.offers)) {
        throw new Error('Invalid payload structure');
      }

      const signedOfferObj: unknown = parsedPayload.offers[0];
      if (!isRecord(signedOfferObj)) {
        throw new Error('Invalid signed offer');
      }

      expect(Object.keys(signedOfferObj)).toEqual(['flightOfferId', 'duffelOfferId']);
      expect(signedOfferObj).not.toHaveProperty('supplierOfferId');
    });

    it('rejects verification when caller provides mismatched duffelOfferId even if unsigned alias matches', async () => {
      const expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
      const signedOffers: SelectionAttestationOffer[] = [
        { flightOfferId: 'fo-sec-1', duffelOfferId: 'off-verified-legacy' },
      ];

      const token = await service.signSelectionAttestation(
        'user-sec',
        'session-sec',
        1,
        expiresAt,
        signedOffers,
      );

      // Caller tries to verify with wrong duffelOfferId
      const untrustedOffers: SelectionAttestationOffer[] = [
        { flightOfferId: 'fo-sec-1', duffelOfferId: 'off-untrusted' },
      ];

      await expect(
        service.verifySelectionAttestation(
          token,
          'user-sec',
          'session-sec',
          1,
          untrustedOffers,
        ),
      ).rejects.toThrow(new UnauthorizedException('Offers mismatch'));
    });
  });

  describe('BookingManagementService neutral snapshot projection to legacy wire DTO', () => {
    let service: BookingManagementService;
    let prisma: {
      booking: {
        findMany: jest.Mock;
        findUnique: jest.Mock;
      };
    };
    let bookingLifecycleService: {
      checkAndCompleteBooking: jest.Mock;
    };
    let eventEmitter: {
      emit: jest.Mock;
    };

    beforeEach(async () => {
      prisma = {
        booking: {
          findMany: jest.fn(),
          findUnique: jest.fn(),
        },
      };
      bookingLifecycleService = {
        checkAndCompleteBooking: jest.fn().mockImplementation((booking) => Promise.resolve(booking)),
      };
      eventEmitter = {
        emit: jest.fn(),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          BookingManagementService,
          {
            provide: PrismaService,
            useValue: prisma,
          },
          {
            provide: BookingLifecycleService,
            useValue: bookingLifecycleService,
          },
          {
            provide: EventEmitter2,
            useValue: eventEmitter,
          },
        ],
      }).compile();

      service = module.get<BookingManagementService>(BookingManagementService);
    });

    it('projects neutral supplierSegmentId to legacy duffelSegmentId without leaking neutral ID in getBookingDetail', async () => {
      const neutralStoredSnapshot = {
        segments: [
          {
            airline: { name: 'Air France', iataCode: 'AF' },
            flightNumber: 'AF456',
            departureAirport: { iataCode: 'CDG', name: 'Charles de Gaulle', city: 'Paris' },
            arrivalAirport: { iataCode: 'JFK', name: 'John F Kennedy', city: 'New York' },
            departureAt: '2026-11-01T10:00:00Z',
            arrivalAt: '2026-11-01T13:00:00Z',
            duration: 'PT8H',
            supplierSegmentId: 'seg_neutral_98765',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT8H',
        stops: 0,
        cabinClass: 'economy',
      };

      prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-wire-1',
        userId: 'user-wire-1',
        status: BookingStatus.CONFIRMED,
        failureReason: null,
        pnrReference: 'PNR777',
        supplierOrderId: 'ord_neutral_111',
        supplierCancellationQuoteId: null,
        totalAmount: { toString: () => '500.00' },
        currency: 'USD',
        departureAt: new Date('2026-11-01T10:00:00Z'),
        createdAt: new Date('2026-10-01T10:00:00Z'),
        updatedAt: new Date('2026-10-01T10:00:00Z'),
        cancellationDeadline: null,
        cancellationRefundable: null,
        airlineRefundAmount: null,
        customerRefundAmount: null,
        flightSnapshot: neutralStoredSnapshot,
        passengerSnapshot: null,
        payment: null,
        bookingIntent: { id: 'intent-1', supplierOfferId: 'off-1', passengers: [] },
        activeDisruptionRevision: null,
        itineraryRevisions: [],
        disruptionStatus: null,
        nextUnflownDepartureAt: null,
        currentFinalArrivalAt: null,
      });

      const detail = await service.getBookingDetail('booking-wire-1', 'user-wire-1');

      // Verify wire flightSnapshot mapping
      expect(isRecord(detail.flightSnapshot)).toBe(true);
      if (!isRecord(detail.flightSnapshot) || !Array.isArray(detail.flightSnapshot.segments)) {
        throw new Error('Expected flightSnapshot object with segments');
      }

      const projectedSegment: unknown = detail.flightSnapshot.segments[0];
      expect(isRecord(projectedSegment)).toBe(true);
      if (!isRecord(projectedSegment)) {
        throw new Error('Expected projectedSegment to be record');
      }

      expect(projectedSegment.duffelSegmentId).toBe('seg_neutral_98765');
      expect(projectedSegment).not.toHaveProperty('supplierSegmentId');

      // Verify currentItinerary mapping
      expect(detail.currentItinerary.source).toBe('ORIGINAL');
      expect(detail.currentItinerary.segments).toHaveLength(1);
      const itinerarySeg = detail.currentItinerary.segments[0];
      expect(itinerarySeg.duffelSegmentId).toBe('seg_neutral_98765');
      expect(itinerarySeg).not.toHaveProperty('supplierSegmentId');
    });

    it('projects neutral supplierSegmentId to legacy duffelSegmentId in listBookings', async () => {
      const neutralStoredSnapshot = {
        segments: [
          {
            airline: { name: 'Delta', iataCode: 'DL' },
            flightNumber: 'DL123',
            departureAirport: { iataCode: 'ATL', name: 'Hartsfield-Jackson', city: 'Atlanta' },
            arrivalAirport: { iataCode: 'LGA', name: 'LaGuardia', city: 'New York' },
            departureAt: '2026-12-01T08:00:00Z',
            arrivalAt: '2026-12-01T10:30:00Z',
            duration: 'PT2H30M',
            supplierSegmentId: 'seg_neutral_list_42',
            sliceOrder: 0,
            segmentOrder: 0,
            globalOrder: 0,
          },
        ],
        totalDuration: 'PT2H30M',
        stops: 0,
        cabinClass: 'economy',
      };

      prisma.booking.findMany.mockResolvedValue([
        {
          id: 'booking-list-1',
          userId: 'user-wire-1',
          status: BookingStatus.CONFIRMED,
          failureReason: null,
          pnrReference: 'PNRLIST',
          supplierOrderId: 'ord_neutral_222',
          supplierCancellationQuoteId: null,
          totalAmount: { toString: () => '300.00' },
          currency: 'USD',
          departureAt: new Date(Date.now() + 86400000),
          createdAt: new Date(),
          flightSnapshot: neutralStoredSnapshot,
          payment: null,
          bookingIntent: { id: 'intent-2', supplierOfferId: 'off-2' },
          activeDisruptionRevision: null,
          itineraryRevisions: [],
          disruptionStatus: null,
          nextUnflownDepartureAt: null,
          currentFinalArrivalAt: null,
        },
      ]);

      const response = await service.listBookings('user-wire-1', 'upcoming', 1, 10);
      expect(response.bookings).toHaveLength(1);
      const item = response.bookings[0];

      expect(isRecord(item.flightSnapshot)).toBe(true);
      if (!isRecord(item.flightSnapshot) || !Array.isArray(item.flightSnapshot.segments)) {
        throw new Error('Expected flightSnapshot with segments');
      }

      const itemSeg: unknown = item.flightSnapshot.segments[0];
      if (!isRecord(itemSeg)) throw new Error('Expected itemSeg record');
      expect(itemSeg.duffelSegmentId).toBe('seg_neutral_list_42');
      expect(itemSeg).not.toHaveProperty('supplierSegmentId');

      expect(item.currentItinerary.segments[0].duffelSegmentId).toBe('seg_neutral_list_42');
      expect(item.currentItinerary.segments[0]).not.toHaveProperty('supplierSegmentId');
    });
  });

  describe('FlightsService persistence decoupling', () => {
    let flightsService: FlightsService;
    let prisma: {
      airport: { findUnique: jest.Mock };
      searchHistory: { create: jest.Mock };
      flightOffer: { createMany: jest.Mock };
      offerRecovery: { createMany: jest.Mock };
      auditLog: { findFirst: jest.Mock };
      $transaction: jest.Mock;
    };
    let flightSearchPort: {
      search: jest.Mock;
    };
    let orchestratorService: {
      orchestrateSearch: jest.Mock;
    };
    let cacheService: {
      get: jest.Mock;
      set: jest.Mock;
    };
    let auditService: {
      createLog: jest.Mock;
    };

    beforeEach(async () => {
      prisma = {
        airport: {
          findUnique: jest.fn().mockImplementation(({ where }: { where: { iataCode: string } }) => {
            return Promise.resolve({ iataCode: where.iataCode, name: `${where.iataCode} Airport` });
          }),
        },
        searchHistory: { create: jest.fn().mockResolvedValue({ id: 'hist-1' }) },
        flightOffer: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        offerRecovery: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
        auditLog: { findFirst: jest.fn() },
        $transaction: jest.fn().mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
          if (typeof callback === 'function') {
            return callback(prisma);
          }
          return callback;
        }),
      };
      cacheService = { get: jest.fn(), set: jest.fn() };
      flightSearchPort = { search: jest.fn() };
      auditService = { createLog: jest.fn().mockResolvedValue({ id: 'audit-1' }) };
      orchestratorService = { orchestrateSearch: jest.fn() };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          FlightsService,
          { provide: PrismaService, useValue: prisma },
          { provide: CacheService, useValue: cacheService },
          { provide: FLIGHT_SEARCH_PORT, useValue: flightSearchPort },
          { provide: AuditService, useValue: auditService },
          { provide: FlightSearchOrchestratorService, useValue: orchestratorService },
        ],
      }).compile();

      flightsService = module.get<FlightsService>(FlightsService);
    });

    it('persists supplierOfferId directly from normalized domain offer, independent of wire DTO', async () => {
      const domainOffer: FlightOffer = {
        id: 'domain-offer-id-1',
        supplierOfferId: 'neutral_supplier_offer_persist_888',
        totalAmount: '199.00',
        price: 199,
        currency: 'USD',
        offerExpiresAt: '2026-11-15T12:00:00Z',
        passengers: [{ supplierPassengerId: 'p-1', type: 'ADULT' }],
        airline: 'AF',
        flightNumber: 'AF99',
        departureAirport: 'CDG',
        arrivalAirport: 'JFK',
        departureTime: '2026-11-15T09:00:00Z',
        arrivalTime: '2026-11-15T12:00:00Z',
        duration: 480,
        stops: 0,
        fareClass: 'Y',
        baggageAllowance: '1',
        segments: [],
        returnSegments: null,
        conditions: { refundable: false, changeable: true, changeBeforeDeparture: null },
        matchInput: {
          id: 'domain-offer-id-1',
          price: 199,
          currency: 'USD',
          stops: 0,
          duration: 480,
          outboundDepartureHour: 9,
          outboundArrivalHour: 12,
          carrierCodes: ['AF'],
          cabinClass: 'economy',
          hasCheckedBaggage: true,
          originalIndex: 0,
        },
        rawSupplierPayload: { upstreamRawKey: 'upstreamValue' },
      };

      flightSearchPort.search.mockResolvedValue({
        offers: [domainOffer],
        searchHash: 'search-hash-123',
        cached: false,
      });

      orchestratorService.orchestrateSearch.mockResolvedValue({
        mode: 'MATCHED',
        results: [
          {
            offer: domainOffer,
            scoredOffer: {
              offer: { id: 'offer-persisted-uuid' },
              matchResult: null,
            },
          },
        ],
        meta: { totalResults: 1, cached: false, searchHash: 'search-hash-123' },
      });

      const response = await flightsService.search(
        'user-p-1',
        {
          origin: 'CDG',
          destination: 'JFK',
          departureDate: '2026-11-15',
          adults: 1,
        },
        undefined,
        undefined,
        { persistence: 'required' },
      );

      // Verify wire response has duffelOfferId
      expect(response.results).toHaveLength(1);
      expect(response.results[0].duffelOfferId).toBe('neutral_supplier_offer_persist_888');
      expect(response.results[0]).not.toHaveProperty('supplierOfferId');

      // Verify database persistence used domainOffer.supplierOfferId directly
      expect(prisma.flightOffer.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: 'offer-persisted-uuid',
            supplierOfferId: 'neutral_supplier_offer_persist_888',
            rawOffer: { upstreamRawKey: 'upstreamValue' },
          }),
        ],
        skipDuplicates: true,
      });
    });
  });
});
