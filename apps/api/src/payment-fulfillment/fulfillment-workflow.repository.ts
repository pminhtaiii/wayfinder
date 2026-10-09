import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type WorkflowActor = {
  kind: 'SAGA' | 'RECOVERY' | 'OPERATOR';
  actorId: string | null;
};

export type WorkflowClaim = {
  workflowId: string;
  bookingIntentId: string;
  ownerToken: string;
  fence: bigint;
  leaseExpiresAt: Date;
};

export type ClaimResult = WorkflowClaim | null;

export type ClaimWriteResult<T> =
  | { kind: 'APPLIED'; value: T }
  | { kind: 'FENCED_OUT' };

const DEFAULT_LEASE_MS = 180_000;

class ClaimExpiredDuringWriteError extends Error {
  constructor() {
    super('Workflow claim expired during fenced write');
    this.name = 'ClaimExpiredDuringWriteError';
  }
}

type WorkflowRow = {
  workflowId: string;
  bookingIntentId: string;
  ownerToken: string;
  fence: bigint;
  leaseExpiresAt: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkflowRow(value: unknown): value is WorkflowRow {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.workflowId === 'string' &&
    typeof value.bookingIntentId === 'string' &&
    typeof value.ownerToken === 'string' &&
    typeof value.fence === 'bigint' &&
    value.leaseExpiresAt instanceof Date &&
    Number.isFinite(value.leaseExpiresAt.getTime())
  );
}

function claimFromRows(rows: unknown): ClaimResult {
  if (!Array.isArray(rows)) {
    throw new Error('PostgreSQL returned an invalid workflow claim result');
  }
  if (rows.length === 0) {
    return null;
  }
  const row = rows[0];
  if (rows.length !== 1 || !isWorkflowRow(row)) {
    throw new Error('PostgreSQL returned an invalid workflow claim row');
  }
  return {
    workflowId: row.workflowId,
    bookingIntentId: row.bookingIntentId,
    ownerToken: row.ownerToken,
    fence: row.fence,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

function leaseDuration(leaseMs: number | undefined): number {
  const duration = leaseMs ?? DEFAULT_LEASE_MS;
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new RangeError('Workflow claim lease must be a positive safe integer');
  }
  return duration;
}

function isUniqueConstraintError(error: unknown): boolean {
  return isRecord(error) && error.code === 'P2002';
}

function hasLockedWorkflow(rows: unknown, expectedWorkflowId: string): boolean {
  if (!Array.isArray(rows)) {
    throw new Error('PostgreSQL returned an invalid locked workflow result');
  }
  if (rows.length === 0) {
    return false;
  }
  const row = rows[0];
  if (rows.length !== 1 || !isRecord(row) || row.workflowId !== expectedWorkflowId) {
    throw new Error('PostgreSQL returned an invalid locked workflow row');
  }
  return true;
}
@Injectable()
export class FulfillmentWorkflowRepository {
  constructor(private readonly prisma: PrismaService) {}

  async acquireClaim(
    bookingIntentId: string,
    actor: WorkflowActor,
    leaseMs?: number,
  ): Promise<ClaimResult> {
    const duration = leaseDuration(leaseMs);
    const existingWorkflow = await this.prisma.fulfillmentWorkflow.findUnique({
      where: { bookingIntentId },
      select: { id: true },
    });
    if (existingWorkflow === null) {
      try {
        await this.prisma.fulfillmentWorkflow.create({ data: { bookingIntentId } });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return null;
        }
        throw error;
      }
    }

    const rows: unknown = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      UPDATE "fulfillment_workflows"
      SET
        "ownerToken" = ${randomUUID()},
        fence = fence + 1,
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + (${duration}::double precision * INTERVAL '1 millisecond'),
        "renewedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "actorType" = ${actor.kind}::"WorkflowActorType",
        "actorId" = ${actor.actorId},
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "bookingIntentId" = ${bookingIntentId}
        AND (
          "ownerToken" IS NULL
          OR "ownerToken" = ''
          OR "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC')
        )
      RETURNING
        "id" AS "workflowId",
        "bookingIntentId",
        "ownerToken",
        fence,
        "leaseExpiresAt"
    `);
    return claimFromRows(rows);
  }

  async runFencedTransaction<T>(
    claim: WorkflowClaim,
    write: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<ClaimWriteResult<T>> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lockedRows: unknown = await tx.$queryRaw<unknown>(Prisma.sql`
          SELECT "id" AS "workflowId"
          FROM "fulfillment_workflows"
          WHERE "id" = ${claim.workflowId}
            AND "bookingIntentId" = ${claim.bookingIntentId}
            AND "ownerToken" = ${claim.ownerToken}
            AND fence = ${claim.fence}
            AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
          FOR UPDATE
        `);
        if (!hasLockedWorkflow(lockedRows, claim.workflowId)) {
          return { kind: 'FENCED_OUT' };
        }

        const value = await write(tx);
        const currentRows: unknown = await tx.$queryRaw<unknown>(Prisma.sql`
          SELECT "id" AS "workflowId"
          FROM "fulfillment_workflows"
          WHERE "id" = ${claim.workflowId}
            AND "bookingIntentId" = ${claim.bookingIntentId}
            AND "ownerToken" = ${claim.ownerToken}
            AND fence = ${claim.fence}
            AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
        `);
        if (!hasLockedWorkflow(currentRows, claim.workflowId)) {
          throw new ClaimExpiredDuringWriteError();
        }

        return { kind: 'APPLIED', value };
      });
    } catch (error) {
      if (error instanceof ClaimExpiredDuringWriteError) {
        return { kind: 'FENCED_OUT' };
      }
      throw error;
    }
  }
  async renewClaim(claim: WorkflowClaim, leaseMs?: number): Promise<ClaimResult> {
    const duration = leaseDuration(leaseMs);
    const rows: unknown = await this.prisma.$queryRaw<unknown>(Prisma.sql`
      UPDATE "fulfillment_workflows"
      SET
        "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + (${duration}::double precision * INTERVAL '1 millisecond'),
        "renewedAt" = (clock_timestamp() AT TIME ZONE 'UTC'),
        "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "id" = ${claim.workflowId}
        AND "bookingIntentId" = ${claim.bookingIntentId}
        AND "ownerToken" = ${claim.ownerToken}
        AND fence = ${claim.fence}
        AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
      RETURNING
        "id" AS "workflowId",
        "bookingIntentId",
        "ownerToken",
        fence,
        "leaseExpiresAt"
    `);
    return claimFromRows(rows);
  }
}
