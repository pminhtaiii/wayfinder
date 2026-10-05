import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '@/app.module';
import { PrismaService } from '@/prisma/prisma.service';

describe('Traveler Profile & Booking Readiness Migration E2E', () => {
  jest.setTimeout(90000);
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64);
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get<PrismaService>(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clear Database tables before each test in proper dependency order
    await prisma.chatHandoff.deleteMany({});
    await prisma.chatSession.deleteMany({});
    await prisma.paymentEvent.deleteMany({});
    await prisma.ledgerEntry.deleteMany({});
    await prisma.refund.deleteMany({});
    await prisma.cancellationRefundObligation.deleteMany({});
    await prisma.payment.deleteMany({});
    await prisma.idempotencyKey.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
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
  });

  it('checks that new TravelerProfile columns are accessible and nullable/defaulted', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'migratetest@example.com',
        password: 'Password123!',
      },
    });

    // Create a traveler profile without specifying the new optional fields
    const profile = (await prisma.travelerProfile.create({
      data: {
        userId: user.id,
        nationality: 'US',
        passportNumber: '123456789',
        passportExpiry: new Date(),
      },
    })) as any;

    // Verify defaults and nulls for new fields
    expect(profile.revision).toBe(1);
    expect(profile.givenName).toBeNull();
    expect(profile.middleName).toBeNull();
    expect(profile.familyName).toBeNull();
    expect(profile.dateOfBirth).toBeNull();
    expect(profile.gender).toBeNull();
    expect(profile.title).toBeNull();
    expect(profile.email).toBeNull();
    expect(profile.phoneCountryCode).toBeNull();
    expect(profile.phoneNumber).toBeNull();
    expect(profile.documentType).toBeNull();
    expect(profile.issuingCountry).toBeNull();
    expect(profile.passportExpiryCiphertext).toBeNull();

    // Verify we can update them
    const updatedProfile = (await prisma.travelerProfile.update({
      where: { id: profile.id },
      data: {
        givenName: 'John',
        revision: { increment: 1 },
      } as any,
    })) as any;

    expect(updatedProfile.givenName).toBe('John');
    expect(updatedProfile.revision).toBe(2);
  });

  it('checks that new BookingIntentPassenger columns are accessible and nullable/defaulted', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'migratetest2@example.com',
        password: 'Password123!',
      },
    });

    const profile = await prisma.travelerProfile.create({
      data: {
        userId: user.id,
      },
    });

    const intent = await prisma.bookingIntent.create({
      data: {
        userId: user.id,
        supplierOfferId: 'offer_123',
        status: 'PENDING',
        originalPrice: 100.0,
        confirmedPrice: 100.0,
        pricedAt: new Date(),
        origin: 'JFK',
        destination: 'LHR',
        departureDate: new Date(),
        cabinClass: 'economy',
        adults: 1,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });

    const passenger = (await prisma.bookingIntentPassenger.create({
      data: {
        intentId: intent.id,
        position: 1,
        type: 'ADULT',
        givenName: 'Jane',
        familyName: 'Doe',
        gender: 'female',
        dateOfBirth: new Date(),
        travelerProfileId: profile.id,
      },
    })) as any;

    // Verify defaults and nulls for new fields
    expect(passenger.snapshotVersion).toBe(1);
    expect(passenger.middleName).toBeNull();
    expect(passenger.title).toBeNull();
    expect(passenger.email).toBeNull();
    expect(passenger.phoneCountryCode).toBeNull();
    expect(passenger.phoneNumber).toBeNull();
    expect(passenger.documentType).toBeNull();
    expect(passenger.issuingCountry).toBeNull();

    // Verify we can update them
    const updatedPassenger = (await prisma.bookingIntentPassenger.update({
      where: { id: passenger.id },
      data: {
        middleName: 'Marie',
        snapshotVersion: 2,
      } as any,
    })) as any;

    expect(updatedPassenger.middleName).toBe('Marie');
    expect(updatedPassenger.snapshotVersion).toBe(2);
  });

  it('verifies that deleting a TravelerProfile sets travelerProfileId to null on BookingIntentPassenger without deleting the passenger', async () => {
    const user = await prisma.user.create({
      data: {
        email: 'migratetest3@example.com',
        password: 'Password123!',
      },
    });

    const profile = await prisma.travelerProfile.create({
      data: {
        userId: user.id,
      },
    });

    const intent = await prisma.bookingIntent.create({
      data: {
        userId: user.id,
        supplierOfferId: 'offer_1234',
        status: 'PENDING',
        originalPrice: 150.0,
        confirmedPrice: 150.0,
        pricedAt: new Date(),
        origin: 'JFK',
        destination: 'CDG',
        departureDate: new Date(),
        cabinClass: 'economy',
        adults: 1,
        rawOfferSnapshot: {},
        intentExpiresAt: new Date(Date.now() + 3600000),
      },
    });

    const passenger = await prisma.bookingIntentPassenger.create({
      data: {
        intentId: intent.id,
        position: 1,
        type: 'ADULT',
        givenName: 'Bob',
        familyName: 'Smith',
        gender: 'male',
        dateOfBirth: new Date(),
        travelerProfileId: profile.id,
      },
    });

    expect(passenger.travelerProfileId).toBe(profile.id);

    // Delete traveler profile
    await prisma.travelerProfile.delete({
      where: { id: profile.id },
    });

    // Check passenger still exists but travelerProfileId is null
    const foundPassenger = await prisma.bookingIntentPassenger.findUnique({
      where: { id: passenger.id },
    });

    expect(foundPassenger).toBeDefined();
    expect(foundPassenger!.id).toBe(passenger.id);
    expect(foundPassenger!.travelerProfileId).toBeNull();
  });
});
