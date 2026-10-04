import { PrismaClient, User, ChatSession, FlightOffer } from '@prisma/client';

const prisma = new PrismaClient();

describe('Chat Handoff Migration Constraints (e2e)', () => {
  let testUser: User;
  let testSession: ChatSession;
  let testOffer: FlightOffer;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        email: `handoff-test-${Date.now()}@example.com`,
        password: 'password',
      },
    });

    testSession = await prisma.chatSession.create({
      data: {
        userId: testUser.id,
      },
    });

    testOffer = await prisma.flightOffer.create({
      data: {
        searchHash: 'testhash',
        supplierOfferId: 'duffel1',
        rawOffer: {},
        origin: 'LHR',
        destination: 'JFK',
        departureDate: new Date(),
        adults: 1,
        price: 100,
        currency: 'USD',
      },
    });
  });

  afterAll(async () => {
    await prisma.flightOffer.delete({ where: { id: testOffer.id } });
    await prisma.chatSession.delete({ where: { id: testSession.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  });

  it('should create valid chat handoff', async () => {
    const handoff = await prisma.chatHandoff.create({
      data: {
        userId: testUser.id,
        chatSessionId: testSession.id,
        flightOfferId: testOffer.id,
        supplierOfferIdHash: 'hash',
        snapshotVersion: 1,
        snapshotFingerprint: 'fingerprint',
        selectionAttestationHash: 'attestation',
        selectedOfferIndex: 1,
        tokenHash: `token-${Date.now()}`,
        tokenKeyVersion: 1,
        idempotencyKeyHash: `idem-${Date.now()}`,
        expiresAt: new Date(Date.now() + 100000),
      },
    });

    expect(handoff).toBeDefined();
    await prisma.chatHandoff.delete({ where: { id: handoff.id } });
  });

  it('should fail if selectedOfferIndex is 0 due to constraint', async () => {
    await expect(
      prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testOffer.id,
          supplierOfferIdHash: 'hash',
          snapshotVersion: 1,
          snapshotFingerprint: 'fingerprint',
          selectionAttestationHash: 'attestation',
          selectedOfferIndex: 0,
          tokenHash: `token-0-${Date.now()}`,
          tokenKeyVersion: 1,
          idempotencyKeyHash: `idem-0-${Date.now()}`,
          expiresAt: new Date(Date.now() + 100000),
        },
      }),
    ).rejects.toThrow();
  });

  it('should fail if snapshotVersion is 0 due to constraint', async () => {
    await expect(
      prisma.chatHandoff.create({
        data: {
          userId: testUser.id,
          chatSessionId: testSession.id,
          flightOfferId: testOffer.id,
          supplierOfferIdHash: 'hash',
          snapshotVersion: 0,
          snapshotFingerprint: 'fingerprint',
          selectionAttestationHash: 'attestation',
          selectedOfferIndex: 1,
          tokenHash: `token-snap0-${Date.now()}`,
          tokenKeyVersion: 1,
          idempotencyKeyHash: `idem-snap0-${Date.now()}`,
          expiresAt: new Date(Date.now() + 100000),
        },
      }),
    ).rejects.toThrow();
  });
});
