process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_fake';
process.env.FEATURE_FLAG_BOOKING_READINESS = 'true';

import * as crypto from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { StripeService } from '@/common/stripe.service';
import { DuffelOrderAdapter } from '@/supplier/order/duffel-order.adapter';
import { EncryptionService } from '@/common/encryption.service';
import { HttpExceptionFilter } from '@/common/filters/http-exception.filter';
import { PassengerType, Prisma, PaymentStatus, BookingStatus } from '@prisma/client';

const SENSITIVE_PII_CORPUS = [
  'Grace Hopper',
  'Grace',
  'Hopper',
  'Ada Lovelace',
  'Ada',
  'Lovelace',
  'Alan Turing',
  'Turing',
  'SecretTraveller',
  '1906-12-09',
  '1815-12-10',
  '1980-05-15',
  '1990-11-27',
  '1995-03-20',
  'P98765432',
  'P12345678',
  'US-PASS-777',
  'GB-PASS-888',
  'grace.hopper@example.com',
  'ada.lovelace@example.com',
  'alan.turing@example.com',
  'secret.traveller@example.com',
  '+12025550199',
  '+447911123456',
  '2025550199',
  '7911123456',
  '912345678',
];

describe('Booking Passenger Final Validation (E2E) - Task T068', () => {
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaService;
  let jwtService: JwtService;
  let stripeService: StripeService;
  let duffelOrderAdapter: DuffelOrderAdapter;
  let encryptionService: EncryptionService;

  let testUser: { id: string; email: string };
  let testToken: string;
  const capturedErrorResponses: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.setGlobalPrefix('api', { exclude: ['health'] });
    await app.init();

    prisma = moduleFixture.get<PrismaService>(PrismaService);
    jwtService = moduleFixture.get<JwtService>(JwtService);
    stripeService = moduleFixture.get<StripeService>(StripeService);
    duffelOrderAdapter = moduleFixture.get<DuffelOrderAdapter>(DuffelOrderAdapter);
    encryptionService = moduleFixture.get<EncryptionService>(EncryptionService);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Human approval 2026-10-02: supply the existing adult fixture at the new offer boundary.
    jest.spyOn(duffelOrderAdapter, 'getOfferById').mockResolvedValue({
      passengers: [{ id: 'pas_1', type: 'adult' }],
    });

    // Clean tables in FK dependency order
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.seatSelection.deleteMany({});
    await prisma.baggageSelectionSegment.deleteMany({});
    await prisma.baggageSelection.deleteMany({});
    await prisma.ancillarySelection.deleteMany({});
    await prisma.bookingIntentPassenger.deleteMany({});
    await prisma.bookingIntent.deleteMany({});
    await prisma.itineraryRevisionSegment.deleteMany({});
    await prisma.itineraryRevision.deleteMany({});
    await prisma.disruptionAuditEvent.deleteMany({});
    await prisma.notificationOutbox.deleteMany({});
    await prisma.booking.deleteMany({});
    await prisma.travelerProfile.deleteMany({});
    await prisma.offerRecovery.deleteMany({});
    await prisma.flightOffer.deleteMany({});
    await prisma.searchHistory.deleteMany({});
    await prisma.airport.deleteMany({});
    await prisma.auditLog.deleteMany({});
    await prisma.user.deleteMany({});

    // Create test user
    const u = await prisma.user.create({
      data: {
        email: 'passenger-val-user@example.com',
        password: 'Password123!',
        status: 'ACTIVE',
      },
    });
    testUser = { id: u.id, email: u.email };
    testToken = jwtService.sign({ id: u.id, email: u.email }, { expiresIn: '24h' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function createFlightOffer(
    options: {
      origin?: string;
      destination?: string;
      originCountry?: string;
      destCountry?: string;
      departingAt?: string;
      arrivingAt?: string;
    } = {},
  ) {
    const origin = options.origin ?? 'SGN';
    const destination = options.destination ?? 'HAN';
    const originCountry = options.originCountry ?? 'VN';
    const destCountry = options.destCountry ?? 'VN';
    const departingAt = options.departingAt ?? '2026-08-01T10:00:00Z';
    const arrivingAt = options.arrivingAt ?? '2026-08-01T12:00:00Z';
    const duffelOfferId = `off_${crypto.randomUUID()}`;

    return prisma.flightOffer.create({
      data: {
        searchHash: `search-${crypto.randomUUID()}`,
        supplierOfferId: duffelOfferId,
        rawOffer: {
          id: duffelOfferId,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          slices: [
            {
              segments: [
                {
                  origin: {
                    iata_code: origin,
                    iata_country_code: originCountry,
                    countryCode: originCountry,
                  },
                  destination: {
                    iata_code: destination,
                    iata_country_code: destCountry,
                    countryCode: destCountry,
                  },
                  departing_at: departingAt,
                  arriving_at: arrivingAt,
                  operating_carrier: { iata_code: 'VN' },
                  marketing_carrier: { iata_code: 'VN' },
                  operating_carrier_flight_number: '123',
                },
              ],
            },
          ],
        },
        origin,
        destination,
        departureDate: new Date('2026-08-01'),
        adults: 1,
        children: 0,
        infants: 0,
        price: new Prisma.Decimal(150.0),
        currency: 'USD',
      },
    });
  }

  async function createBookingIntentWithPassengers(
    flightOffer: any,
    passengers: Array<{
      position: number;
      type: PassengerType;
      givenName: string;
      familyName: string;
      middleName?: string | null;
      dateOfBirth: Date;
      gender: string;
      title?: string | null;
      email?: string | null;
      phoneCountryCode?: string | null;
      phoneNumber?: string | null;
      documentType?: string | null;
      passportNumber?: string | null;
      passportExpiry?: string | null;
      issuingCountry?: string | null;
      nationality?: string | null;
      snapshotVersion?: number;
    }>,
    overrides: Record<string, any> = {},
  ) {
    const now = new Date();
    const intentId = overrides.id ?? crypto.randomUUID();

    return prisma.bookingIntent.create({
      data: {
        id: intentId,
        userId: testUser.id,
        flightOfferId: flightOffer.id,
        duffelOfferId: flightOffer.duffelOfferId,
        status: 'AWAITING_PAYMENT',
        originalPrice: new Prisma.Decimal(150.0),
        confirmedPrice: new Prisma.Decimal(150.0),
        currency: 'USD',
        priceChanged: false,
        pricedAt: now,
        origin: flightOffer.origin,
        destination: flightOffer.destination,
        departureDate: flightOffer.departureDate,
        cabinClass: 'economy',
        adults: passengers.length,
        children: 0,
        infants: 0,
        rawOfferSnapshot: flightOffer.rawOffer as any,
        intentExpiresAt: new Date(now.getTime() + 3600 * 1000),
        offerExpiresAt: new Date(now.getTime() + 3600 * 1000),
        paymentAttemptCount: 0,
        passengers: {
          create: passengers.map((p) => ({
            ...p,
            snapshotVersion: p.snapshotVersion ?? 1,
          })),
        },
        ...overrides,
      } as any,
      include: {
        passengers: true,
      },
    });
  }

  function mockStripeServices(stripePaymentIntentId: string) {
    jest.spyOn(stripeService, 'createCustomer').mockResolvedValue({
      id: 'cus_val_mock',
      email: testUser.email,
    } as any);

    jest.spyOn(stripeService, 'createPaymentIntent').mockResolvedValue({
      id: stripePaymentIntentId,
      client_secret: `${stripePaymentIntentId}_secret`,
      status: 'requires_payment_method',
    } as any);

    jest.spyOn(stripeService, 'retrievePaymentIntent').mockResolvedValue({
      id: stripePaymentIntentId,
      status: 'requires_capture',
    } as any);

    jest.spyOn(stripeService, 'capturePaymentIntent').mockResolvedValue({
      id: stripePaymentIntentId,
      status: 'succeeded',
    } as any);

    jest.spyOn(stripeService, 'cancelPaymentIntent').mockResolvedValue({
      id: stripePaymentIntentId,
      status: 'canceled',
    } as any);
  }

  // ==========================================================================
  // Scenario 1: Valid Domestic Snapshot
  // ==========================================================================
  describe('Scenario 1: Valid Domestic Snapshot', () => {
    it('confirms payment successfully, invokes Duffel once, marks payment SUCCEEDED and booking CONFIRMED with durable audit log', async () => {
      const flightOffer = await createFlightOffer({
        origin: 'SGN',
        destination: 'HAN',
        originCountry: 'VN',
        destCountry: 'VN',
      });

      const intent = await createBookingIntentWithPassengers(flightOffer, [
        {
          position: 0,
          type: PassengerType.ADULT,
          givenName: 'Grace',
          familyName: 'Hopper',
          middleName: 'Brewster',
          dateOfBirth: new Date('1980-05-15'),
          gender: 'female',
          title: 'ms',
          email: 'grace.hopper@example.com',
          phoneCountryCode: '+84',
          phoneNumber: '912345678',
          nationality: 'VN',
          documentType: null,
          passportNumber: null,
          passportExpiry: null,
          issuingCountry: null,
          snapshotVersion: 1,
        },
      ]);

      const stripePiId = `pi_dom_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const duffelCreateOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder').mockResolvedValue({
        id: `ord_${crypto.randomUUID()}`,
        booking_reference: 'DOM123',
        slices: (flightOffer.rawOffer as any).slices,
        passengers: [{ id: 'pas_duffel_1', given_name: 'Grace', family_name: 'Hopper' }],
      } as any);

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      expect(createRes.body.paymentId).toBeDefined();
      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      expect([200, 202]).toContain(confirmRes.status);
      expect(confirmRes.body.status).toBe('SUCCEEDED');
      expect(confirmRes.body.bookingReference).toBe('DOM123');

      // Assert DuffelOrderAdapter.createOrder was called exactly 1 time
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(1);

      // Assert Payment status is SUCCEEDED in DB
      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment).toBeDefined();
      expect(dbPayment!.status).toBe(PaymentStatus.SUCCEEDED);

      // Assert Booking status is CONFIRMED in DB
      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking).toBeDefined();
      expect(dbBooking!.status).toBe(BookingStatus.CONFIRMED);

      // Assert durable audit log for final passenger validation success
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_succeeded',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const auditLog = auditLogs[0];
      expect(auditLog.userId).toBe(testUser.id);
      expect(auditLog.metadata).toMatchObject({
        paymentId,
        passengerCount: 1,
      });
    });
  });

  // ==========================================================================
  // Scenario 2: Valid International Snapshot with Bound Encrypted Passport
  // ==========================================================================
  describe('Scenario 2: Valid International Snapshot with Bound AES-256-GCM Encrypted Passport', () => {
    it('confirms payment successfully, calls Duffel with decrypted ephemeral passenger DTO and passport fields', async () => {
      const flightOffer = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
        departingAt: '2026-08-01T10:00:00Z',
        arrivingAt: '2026-08-02T18:00:00Z',
      });

      const intentId = crypto.randomUUID();
      const plainPassportNumber = 'P98765432';
      const plainPassportExpiry = '2030-12-31';

      const encryptedPassportNumber = encryptionService.encryptBound(plainPassportNumber, {
        snapshotVersion: 1,
        intentId,
        position: 0,
        fieldName: 'passportNumber',
      });

      const encryptedPassportExpiry = encryptionService.encryptBound(plainPassportExpiry, {
        snapshotVersion: 1,
        intentId,
        position: 0,
        fieldName: 'passportExpiry',
      });

      const intent = await createBookingIntentWithPassengers(
        flightOffer,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Ada',
            familyName: 'Lovelace',
            middleName: null,
            dateOfBirth: new Date('1990-11-27'),
            gender: 'female',
            title: 'ms',
            email: 'ada.lovelace@example.com',
            phoneCountryCode: '+1',
            phoneNumber: '2025550199',
            documentType: 'passport',
            passportNumber: encryptedPassportNumber,
            passportExpiry: encryptedPassportExpiry,
            issuingCountry: 'US',
            nationality: 'US',
            snapshotVersion: 1,
          },
        ],
        { id: intentId },
      );

      const stripePiId = `pi_intl_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const capturedPassengerInput: { passengers: Array<Record<string, unknown>> | null } = {
        passengers: null,
      };
      const duffelCreateOrderSpy = jest
        .spyOn(duffelOrderAdapter, 'createOrder')
        .mockImplementation(async (input) => {
          capturedPassengerInput.passengers = input.passengers;
          return {
            id: `ord_${crypto.randomUUID()}`,
            booking_reference: 'INTL123',
            slices: (flightOffer.rawOffer as any).slices,
            passengers: [{ id: 'pas_duffel_1', given_name: 'Ada', family_name: 'Lovelace' }],
          };
        });

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      expect([200, 202]).toContain(confirmRes.status);
      expect(confirmRes.body.status).toBe('SUCCEEDED');

      // Assert the raw supplier order adapter was called exactly 1 time
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(1);

      // Verify the decrypted ephemeral passenger DTO passed to Duffel
      const passedDuffelPassengers = capturedPassengerInput.passengers;
      expect(passedDuffelPassengers).toBeDefined();
      if (passedDuffelPassengers === null) {
        throw new Error('The supplier order adapter did not receive passenger data.');
      }
      expect(passedDuffelPassengers.length).toBe(1);
      const duffelPassenger = passedDuffelPassengers[0];
      expect(duffelPassenger.given_name).toBe('Ada');
      expect(duffelPassenger.family_name).toBe('Lovelace');
      expect(duffelPassenger.born_on).toBe('1990-11-27');
      expect(duffelPassenger.gender).toBe('f');
      expect(duffelPassenger.title).toBe('ms');
      expect(duffelPassenger.email).toBe('ada.lovelace@example.com');
      expect(duffelPassenger.phone_number).toBe('+12025550199');
      expect(duffelPassenger.identity_documents).toEqual([
        {
          type: 'passport',
          unique_identifier: plainPassportNumber,
          expires_on: plainPassportExpiry,
          issuing_country_code: 'US',
        },
      ]);

      // Assert Payment status is SUCCEEDED and Booking is CONFIRMED
      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment!.status).toBe(PaymentStatus.SUCCEEDED);

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking!.status).toBe(BookingStatus.CONFIRMED);

      // Assert durable audit log
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_succeeded',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ==========================================================================
  // Scenario 3: Corrupted Ciphertext / AAD Mismatch (Swapped Position/Intent)
  // ==========================================================================
  describe('Scenario 3: Corrupted / Tampered Ciphertext & AAD Mismatch Snapshot', () => {
    it('rejects confirm payment when AAD mismatches (position swapped), cancels Stripe hold, marks payment CANCELLED and booking FAILED with SNAPSHOT_INTEGRITY_FAILURE audit', async () => {
      const flightOffer = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
      });

      const intentId = crypto.randomUUID();
      // Encrypt with position = 1, but place passenger at position = 0 (AAD mismatch!)
      const encryptedPassportNumber = encryptionService.encryptBound('P12345678', {
        snapshotVersion: 1,
        intentId,
        position: 1, // Mismatched position!
        fieldName: 'passportNumber',
      });

      const encryptedPassportExpiry = encryptionService.encryptBound('2030-12-31', {
        snapshotVersion: 1,
        intentId,
        position: 1, // Mismatched position!
        fieldName: 'passportExpiry',
      });

      const intent = await createBookingIntentWithPassengers(
        flightOffer,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Alan',
            familyName: 'Turing',
            dateOfBirth: new Date('1990-06-23'),
            gender: 'male',
            title: 'mr',
            email: 'alan.turing@example.com',
            phoneCountryCode: '+44',
            phoneNumber: '7911123456',
            documentType: 'passport',
            passportNumber: encryptedPassportNumber,
            passportExpiry: encryptedPassportExpiry,
            issuingCountry: 'GB',
            nationality: 'GB',
            snapshotVersion: 1,
          },
        ],
        { id: intentId },
      );

      const stripePiId = `pi_aad_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const duffelCreateOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const stripeCancelSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      // Record error response for negative privacy audit
      capturedErrorResponses.push(confirmRes.body);

      // Confirm payment rejected
      expect([422, 502]).toContain(confirmRes.status);
      expect(confirmRes.body.code || confirmRes.body.message).toBeDefined();

      // Assert DuffelOrderAdapter.createOrder was called exactly 0 times
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(0);

      // Assert Stripe authorization hold cancelled
      expect(stripeCancelSpy).toHaveBeenCalledWith(stripePiId, `${stripePiId}-stripe-void`);

      // Assert Payment status is CANCELLED in DB
      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment!.status).toBe(PaymentStatus.CANCELLED);

      // Assert Booking status is FAILED in DB
      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking!.status).toBe(BookingStatus.FAILED);

      // Assert durable audit log for final passenger validation failure with SNAPSHOT_INTEGRITY_FAILURE
      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_failed',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const auditLog = auditLogs[0];
      expect(auditLog.userId).toBe(testUser.id);
      expect(auditLog.metadata).toMatchObject({
        reasonCode: 'SNAPSHOT_INTEGRITY_FAILURE',
        intentId: intent.id,
        paymentId,
      });
    });

    it('rejects confirm payment when ciphertext is corrupted/tampered, cancels Stripe hold, marks payment CANCELLED and booking FAILED', async () => {
      const flightOffer = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
      });

      const intentId = crypto.randomUUID();
      // Corrupted / malformed ciphertext
      const tamperedCiphertext =
        'v1:0123456789abcdef01234567:0123456789abcdef0123456789abcdef:baddeadbeefcafebabe';

      const intent = await createBookingIntentWithPassengers(
        flightOffer,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Alan',
            familyName: 'Turing',
            dateOfBirth: new Date('1990-06-23'),
            gender: 'male',
            title: 'mr',
            email: 'alan.turing@example.com',
            phoneCountryCode: '+44',
            phoneNumber: '7911123456',
            documentType: 'passport',
            passportNumber: tamperedCiphertext,
            passportExpiry: tamperedCiphertext,
            issuingCountry: 'GB',
            nationality: 'GB',
            snapshotVersion: 1,
          },
        ],
        { id: intentId },
      );

      const stripePiId = `pi_corrupt_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const duffelCreateOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const stripeCancelSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      capturedErrorResponses.push(confirmRes.body);

      expect([422, 502]).toContain(confirmRes.status);
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(0);
      expect(stripeCancelSpy).toHaveBeenCalledWith(stripePiId, `${stripePiId}-stripe-void`);

      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment!.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking!.status).toBe(BookingStatus.FAILED);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_failed',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs[0].metadata).toMatchObject({
        reasonCode: 'SNAPSHOT_INTEGRITY_FAILURE',
      });
    });
  });

  // ==========================================================================
  // Scenario 4: Expired Passport Snapshot
  // ==========================================================================
  describe('Scenario 4: Expired Passport Snapshot', () => {
    it('rejects confirm payment when passport expiry date is before trip completion date, cancels Stripe hold, marks payment CANCELLED and booking FAILED with DOCUMENT_EXPIRED audit', async () => {
      // Flight arrives on 2026-09-01
      const flightOffer = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
        departingAt: '2026-08-30T10:00:00Z',
        arrivingAt: '2026-09-01T18:00:00Z',
      });

      const intentId = crypto.randomUUID();
      // Passport expires on 2026-08-15 (before trip completion date 2026-09-01!)
      const expiredPassportExpiry = '2026-08-15';
      const encryptedPassportNumber = encryptionService.encryptBound('P12345678', {
        snapshotVersion: 1,
        intentId,
        position: 0,
        fieldName: 'passportNumber',
      });

      const encryptedPassportExpiry = encryptionService.encryptBound(expiredPassportExpiry, {
        snapshotVersion: 1,
        intentId,
        position: 0,
        fieldName: 'passportExpiry',
      });

      const intent = await createBookingIntentWithPassengers(
        flightOffer,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Grace',
            familyName: 'Hopper',
            dateOfBirth: new Date('1980-05-15'),
            gender: 'female',
            title: 'ms',
            email: 'grace.hopper@example.com',
            phoneCountryCode: '+84',
            phoneNumber: '912345678',
            documentType: 'passport',
            passportNumber: encryptedPassportNumber,
            passportExpiry: encryptedPassportExpiry,
            issuingCountry: 'VN',
            nationality: 'VN',
            snapshotVersion: 1,
          },
        ],
        { id: intentId },
      );

      const stripePiId = `pi_expired_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const duffelCreateOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const stripeCancelSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      capturedErrorResponses.push(confirmRes.body);

      expect([422, 502]).toContain(confirmRes.status);
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(0);
      expect(stripeCancelSpy).toHaveBeenCalledWith(stripePiId, `${stripePiId}-stripe-void`);

      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment!.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking!.status).toBe(BookingStatus.FAILED);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_failed',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs[0].metadata).toMatchObject({
        reasonCode: 'DOCUMENT_EXPIRED',
      });
    });
  });

  // ==========================================================================
  // Scenario 5: Incomplete Snapshot
  // ==========================================================================
  describe('Scenario 5: Incomplete Snapshot', () => {
    it('rejects confirm payment when required passenger identity/contact fields are missing, cancels Stripe hold, marks payment CANCELLED and booking FAILED with SNAPSHOT_INCOMPLETE audit', async () => {
      const flightOffer = await createFlightOffer();

      // Missing required familyName and email
      const intent = await createBookingIntentWithPassengers(flightOffer, [
        {
          position: 0,
          type: PassengerType.ADULT,
          givenName: 'Incomplete',
          familyName: '', // Empty family name!
          dateOfBirth: new Date('1990-01-01'),
          gender: 'male',
          title: 'mr',
          email: '', // Empty email!
          phoneCountryCode: '+84',
          phoneNumber: '912345678',
          nationality: 'VN',
        },
      ]);

      const stripePiId = `pi_incomp_${crypto.randomUUID()}`;
      mockStripeServices(stripePiId);

      const duffelCreateOrderSpy = jest.spyOn(duffelOrderAdapter, 'createOrder');
      const stripeCancelSpy = jest.spyOn(stripeService, 'cancelPaymentIntent');

      // Step 1: Create Payment
      const createRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: intent.id, saveCard: false })
        .expect(201);

      const paymentId = createRes.body.paymentId;

      // Step 2: Confirm Payment
      const bookingId = crypto.randomUUID();
      const confirmRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId, bookingId });

      capturedErrorResponses.push(confirmRes.body);

      expect([422, 502]).toContain(confirmRes.status);
      expect(duffelCreateOrderSpy).toHaveBeenCalledTimes(0);
      expect(stripeCancelSpy).toHaveBeenCalledWith(stripePiId, `${stripePiId}-stripe-void`);

      const dbPayment = await prisma.payment.findUnique({
        where: { id: paymentId },
      });
      expect(dbPayment!.status).toBe(PaymentStatus.CANCELLED);

      const dbBooking = await prisma.booking.findUnique({
        where: { id: bookingId },
      });
      expect(dbBooking!.status).toBe(BookingStatus.FAILED);

      const auditLogs = await prisma.auditLog.findMany({
        where: {
          resourceType: 'BookingIntent',
          resourceId: intent.id,
          action: 'final_passenger_validation_failed',
        },
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      expect(auditLogs[0].metadata).toMatchObject({
        reasonCode: 'SNAPSHOT_INCOMPLETE',
      });
    });
  });

  // ==========================================================================
  // Scenario 6: Negative PII Audit
  // ==========================================================================
  describe('Scenario 6: Negative PII Audit on Audit Logs, Payment Events & Error Responses', () => {
    it('verifies that NO plaintext names, DOB, passport numbers, emails, or phone numbers appear in any audit log metadata, payment event metadata, or error response bodies', async () => {
      // 1. Trigger a successful validation flow with sensitive international passenger data
      const flightOffer1 = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
      });
      const intentId1 = crypto.randomUUID();
      const plainPassport = 'P98765432';
      const plainExpiry = '2030-12-31';

      const encPassport = encryptionService.encryptBound(plainPassport, {
        snapshotVersion: 1,
        intentId: intentId1,
        position: 0,
        fieldName: 'passportNumber',
      });
      const encExpiry = encryptionService.encryptBound(plainExpiry, {
        snapshotVersion: 1,
        intentId: intentId1,
        position: 0,
        fieldName: 'passportExpiry',
      });

      const validIntent = await createBookingIntentWithPassengers(
        flightOffer1,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Grace',
            familyName: 'Hopper',
            dateOfBirth: new Date('1980-05-15'),
            gender: 'female',
            title: 'ms',
            email: 'grace.hopper@example.com',
            phoneCountryCode: '+84',
            phoneNumber: '912345678',
            documentType: 'passport',
            passportNumber: encPassport,
            passportExpiry: encExpiry,
            issuingCountry: 'VN',
            nationality: 'VN',
            snapshotVersion: 1,
          },
        ],
        { id: intentId1 },
      );

      const piId1 = `pi_audit_succ_${crypto.randomUUID()}`;
      mockStripeServices(piId1);
      jest.spyOn(duffelOrderAdapter, 'createOrder').mockResolvedValue({
        id: `ord_${crypto.randomUUID()}`,
        booking_reference: 'PII123',
        slices: (flightOffer1.rawOffer as any).slices,
        passengers: [{ id: 'pas_1', given_name: 'Grace', family_name: 'Hopper' }],
      } as any);

      const createRes1 = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: validIntent.id, saveCard: false })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId: createRes1.body.paymentId, bookingId: crypto.randomUUID() });

      // 2. Trigger a failed validation flow with sensitive passenger data
      const flightOffer2 = await createFlightOffer({
        origin: 'SGN',
        destination: 'JFK',
        originCountry: 'VN',
        destCountry: 'US',
        departingAt: '2026-08-30T10:00:00Z',
        arrivingAt: '2026-09-01T18:00:00Z',
      });
      const intentId2 = crypto.randomUUID();
      const expiredEncPassport = encryptionService.encryptBound('US-PASS-777', {
        snapshotVersion: 1,
        intentId: intentId2,
        position: 0,
        fieldName: 'passportNumber',
      });
      const expiredEncExpiry = encryptionService.encryptBound('2026-08-10', {
        snapshotVersion: 1,
        intentId: intentId2,
        position: 0,
        fieldName: 'passportExpiry',
      });

      const failedIntent = await createBookingIntentWithPassengers(
        flightOffer2,
        [
          {
            position: 0,
            type: PassengerType.ADULT,
            givenName: 'Ada',
            familyName: 'Lovelace',
            dateOfBirth: new Date('1990-11-27'),
            gender: 'female',
            title: 'ms',
            email: 'ada.lovelace@example.com',
            phoneCountryCode: '+1',
            phoneNumber: '2025550199',
            documentType: 'passport',
            passportNumber: expiredEncPassport,
            passportExpiry: expiredEncExpiry,
            issuingCountry: 'US',
            nationality: 'US',
            snapshotVersion: 1,
          },
        ],
        { id: intentId2 },
      );

      const piId2 = `pi_audit_fail_${crypto.randomUUID()}`;
      mockStripeServices(piId2);

      const createRes2 = await request(app.getHttpServer())
        .post('/api/bookings/payment/create')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `create-key-${crypto.randomUUID()}`)
        .send({ bookingIntentId: failedIntent.id, saveCard: false })
        .expect(201);

      const confirmFailRes = await request(app.getHttpServer())
        .post('/api/bookings/payment/confirm')
        .set('Authorization', `Bearer ${testToken}`)
        .set('Idempotency-Key', `confirm-key-${crypto.randomUUID()}`)
        .send({ paymentId: createRes2.body.paymentId, bookingId: crypto.randomUUID() });

      // 3. Scan all AuditLog records
      const allAuditLogs = await prisma.auditLog.findMany();
      expect(allAuditLogs.length).toBeGreaterThan(0);

      const serializedAuditLogs = JSON.stringify(
        allAuditLogs.map((l) => ({ action: l.action, metadata: l.metadata })),
      );

      for (const sensitiveItem of SENSITIVE_PII_CORPUS) {
        expect(serializedAuditLogs).not.toContain(sensitiveItem);
      }

      // 4. Scan all PaymentEvent records
      const allPaymentEvents = await prisma.paymentEvent.findMany();
      expect(allPaymentEvents.length).toBeGreaterThan(0);

      const serializedPaymentEvents = JSON.stringify(
        allPaymentEvents.map((e) => ({
          eventType: e.eventType,
          metadata: e.metadata,
        })),
      );

      for (const sensitiveItem of SENSITIVE_PII_CORPUS) {
        expect(serializedPaymentEvents).not.toContain(sensitiveItem);
      }

      // 5. Scan error response body
      const serializedErrorResponse = JSON.stringify(confirmFailRes.body);
      for (const sensitiveItem of SENSITIVE_PII_CORPUS) {
        expect(serializedErrorResponse).not.toContain(sensitiveItem);
      }
    });
  });
});
