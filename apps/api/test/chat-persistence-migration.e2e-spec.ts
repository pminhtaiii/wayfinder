import { Test, TestingModule } from '@nestjs/testing';
import {
  PrismaClient,
  User,
  ChatSession,
  ChatMessage,
  Booking,
  BookingIntentStatus,
} from '@prisma/client';
import * as crypto from 'crypto';
import { backfillChatMessages } from '../prisma/scripts/backfill-encrypted-chat-messages';
import { backfillBookingAgentProjections } from '../prisma/scripts/backfill-booking-agent-projections';

const prisma = new PrismaClient();

process.env.CHAT_ENCRYPTION_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

describe('Chat Persistence Migration (e2e)', () => {
  let testUser: User;
  let testSession: ChatSession;
  let testMessage: ChatMessage;
  let testBooking: Booking;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        email: `test-migration-${Date.now()}@example.com`,
        password: 'password',
      },
    });

    const KEY_BUFFER = Buffer.from(process.env.CHAT_ENCRYPTION_KEY!, 'hex');

    const sessionNonce = crypto.randomBytes(12);
    const sessionCipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, sessionNonce);
    sessionCipher.setAAD(Buffer.from(`ChatSession:ses_test_migration:v1`));
    let sessionCiphertext = sessionCipher.update('Legacy Title', 'utf8', 'hex');
    sessionCiphertext += sessionCipher.final('hex');
    const sessionAuthTag = sessionCipher.getAuthTag().toString('hex');

    testSession = await prisma.chatSession.create({
      data: {
        id: 'ses_test_migration',
        userId: testUser.id,
        titleCiphertext: sessionCiphertext,
        titleNonce: sessionNonce.toString('hex'),
        titleAuthTag: sessionAuthTag,
        titleKeyVersion: 1,
      },
    });

    const msgNonce = crypto.randomBytes(12);
    const msgCipher = crypto.createCipheriv('aes-256-gcm', KEY_BUFFER, msgNonce);
    msgCipher.setAAD(
      Buffer.from(`ChatMessage:msg_test_migration:ses_test_migration:USER:STANDARD:v1`),
    );
    let msgCiphertext = msgCipher.update('Legacy Content', 'utf8', 'hex');
    msgCiphertext += msgCipher.final('hex');
    const msgAuthTag = msgCipher.getAuthTag().toString('hex');

    testMessage = await prisma.chatMessage.create({
      data: {
        id: 'msg_test_migration',
        sessionId: testSession.id,
        sender: 'USER',
        type: 'STANDARD',
        contentCiphertext: msgCiphertext,
        contentNonce: msgNonce.toString('hex'),
        contentAuthTag: msgAuthTag,
        contentKeyVersion: 1,
      },
    });

    // Create BookingIntent separately to avoid Prisma XOR type conflict
    const testIntent = await prisma.bookingIntent.create({
      data: {
        userId: testUser.id,
        supplierOfferId: 'test_offer_id',
        status: BookingIntentStatus.COMPLETED,
        originalPrice: 100,
        confirmedPrice: 100,
        pricedAt: new Date(),
        intentExpiresAt: new Date(Date.now() + 3600000),
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        rawOfferSnapshot: {},
      },
    });

    testBooking = await prisma.booking.create({
      data: {
        userId: testUser.id,
        bookingIntentId: testIntent.id,
        status: 'CONFIRMED',
        totalAmount: 100,
        currency: 'USD',
        itineraryRevisions: {
          create: {
            version: 1,
            source: 'BOOTSTRAP',
            fingerprint: 'test',
            isMaterial: false,
            incrementalDiff: {},
            cumulativeDiff: {},
            segments: {
              create: {
                sliceOrder: 0,
                segmentOrder: 0,
                globalOrder: 0,
                marketingCarrierIata: 'BA',
                airlineName: 'British Airways',
                flightNumber: '123',
                departureAirportIata: 'LHR',
                departureAirportName: 'Heathrow',
                departureCity: 'London',
                departureAt: new Date(),
                departureLocalDate: new Date(),
                arrivalAirportIata: 'JFK',
                arrivalAirportName: 'JFK',
                arrivalCity: 'New York',
                arrivalAt: new Date(),
                arrivalLocalDate: new Date(),
                durationMinutes: 400,
              },
            },
          },
        },
      },
    });
  });

  afterAll(async () => {
    await prisma.bookingAgentProjection.deleteMany({ where: { bookingId: testBooking.id } });
    await prisma.itineraryRevisionSegment.deleteMany({
      where: { revision: { bookingId: testBooking.id } },
    });
    await prisma.itineraryRevision.deleteMany({ where: { bookingId: testBooking.id } });
    await prisma.booking.deleteMany({ where: { id: testBooking.id } });
    await prisma.bookingIntent.deleteMany({ where: { userId: testUser.id } });
    await prisma.chatMessage.deleteMany({ where: { sessionId: testSession.id } });
    await prisma.chatSession.delete({ where: { id: testSession.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  });

  it('should backfill chat messages and verify dual-write encryption completeness', async () => {
    await backfillChatMessages();

    const session = await prisma.chatSession.findUnique({ where: { id: testSession.id } });
    expect(session!.titleCiphertext).not.toBeNull();
    expect(session!.titleNonce).not.toBeNull();
    expect(session!.titleAuthTag).not.toBeNull();
    expect(session!.titleKeyVersion).toBe(1);

    const message = await prisma.chatMessage.findUnique({ where: { id: testMessage.id } });
    expect(message!.contentCiphertext).not.toBeNull();
    expect(message!.contentNonce).not.toBeNull();
    expect(message!.contentAuthTag).not.toBeNull();
    expect(message!.contentKeyVersion).toBe(1);

    const ENCRYPTION_KEY =
      process.env.CHAT_ENCRYPTION_KEY ||
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const KEY_BUFFER = Buffer.from(ENCRYPTION_KEY, 'hex');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      KEY_BUFFER,
      Buffer.from(message!.contentNonce!, 'hex'),
    );
    decipher.setAAD(
      Buffer.from(
        `ChatMessage:${message!.id}:${message!.sessionId}:${message!.sender}:${message!.type}:v1`,
      ),
    );
    decipher.setAuthTag(Buffer.from(message!.contentAuthTag!, 'hex'));
    let decrypted = decipher.update(message!.contentCiphertext!, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    expect(decrypted).toEqual('Legacy Content');
  });

  it('should support chat session soft deletion', async () => {
    await prisma.chatSession.update({
      where: { id: testSession.id },
      data: { deletedAt: new Date() },
    });

    const session = await prisma.chatSession.findUnique({ where: { id: testSession.id } });
    expect(session!.deletedAt).not.toBeNull();
  });

  it('should backfill booking agent projections', async () => {
    await backfillBookingAgentProjections();

    const projection = await prisma.bookingAgentProjection.findUnique({
      where: { bookingId: testBooking.id },
    });

    expect(projection).not.toBeNull();
    expect(projection!.agentReference).toMatch(/^bkref_/);
    expect(projection!.airline).toBe('British Airways');
    expect(projection!.origin).toBe('LHR');
    expect(projection!.destination).toBe('JFK');
  });
});
