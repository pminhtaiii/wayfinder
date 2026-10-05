import { Test } from '@nestjs/testing';
import { PrismaService } from '@/prisma/prisma.service';
import { SyncClaimService } from '@/disruption/sync/sync-claim.service';

describe('supplier-neutral Prisma persistence', () => {
  it('acquires a disruption claim using the neutral booking order field', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SyncClaimService,
        {
          provide: PrismaService,
          useValue: { booking: { updateMany } },
        },
      ],
    }).compile();

    try {
      const service = moduleRef.get(SyncClaimService);

      await expect(service.acquireClaim('booking-1')).resolves.toEqual(expect.any(String));
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'booking-1',
            status: 'CONFIRMED',
            supplierOrderId: { not: null },
          }),
          data: expect.objectContaining({
            syncLockedAt: expect.any(Date),
            syncLockToken: expect.any(String),
          }),
        }),
      );
    } finally {
      await moduleRef.close();
    }
  });
});
