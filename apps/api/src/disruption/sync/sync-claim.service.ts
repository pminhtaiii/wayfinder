import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import * as crypto from 'crypto';

@Injectable()
export class SyncClaimService {
  private readonly logger = new Logger(SyncClaimService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Attempts to acquire a sync lock on a booking using CAS.
   * Lock is granted if:
   * - Booking status is CONFIRMED
   * - supplierOrderId is not null
   * - syncLockedAt is null or older than 5 minutes
   */
  async acquireClaim(bookingId: string): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = new Date();
    const staleTime = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes ago

    try {
      const updateResult = await this.prisma.booking.updateMany({
        where: {
          id: bookingId,
          status: 'CONFIRMED',
          supplierOrderId: { not: null },
          OR: [{ syncLockedAt: null }, { syncLockedAt: { lt: staleTime } }],
        },
        data: {
          syncLockedAt: now,
          syncLockToken: token,
        },
      });

      if (updateResult.count > 0) {
        this.logger.log(`Acquired sync claim for booking ${bookingId} with token ${token}`);
        return token;
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error acquiring sync claim for booking ${bookingId}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }

  /**
   * Releases the sync lock only if the token matches.
   */
  async releaseClaim(bookingId: string, token: string): Promise<boolean> {
    try {
      const updateResult = await this.prisma.booking.updateMany({
        where: {
          id: bookingId,
          syncLockToken: token,
        },
        data: {
          syncLockedAt: null,
          syncLockToken: null,
        },
      });

      if (updateResult.count > 0) {
        this.logger.log(`Released sync claim for booking ${bookingId} with token ${token}`);
        return true;
      }
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Error releasing sync claim for booking ${bookingId}: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }
}
