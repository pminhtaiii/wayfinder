export type DrainResult = {
  executedJobIds: string[];
  nextDueAt: Date | null;
  exceededBudget: boolean;
};

export interface FulfillmentRecoveryScheduler {
  register(jobId: string, dueAt: Date, run: () => Promise<void>): void;
  cancel(jobId: string): void;
  advance(milliseconds: number, maxJobs: number): Promise<DrainResult>;
  nextDueAt(): Date | null;
}

type ScheduledJob = {
  jobId: string;
  dueAt: number;
  run: () => Promise<void>;
};

export class VirtualFulfillmentRecoveryScheduler implements FulfillmentRecoveryScheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private virtualTime: number;

  constructor(startAt: Date = new Date()) {
    const startTime = startAt.getTime();
    if (!Number.isFinite(startTime)) {
      throw new RangeError('Scheduler start time must be a valid date');
    }
    this.virtualTime = startTime;
  }

  register(jobId: string, dueAt: Date, run: () => Promise<void>): void {
    const dueTime = dueAt.getTime();
    if (!Number.isFinite(dueTime)) {
      throw new RangeError('Scheduled due time must be a valid date');
    }
    this.jobs.set(jobId, { jobId, dueAt: dueTime, run });
  }

  cancel(jobId: string): void {
    this.jobs.delete(jobId);
  }

  async advance(milliseconds: number, maxJobs: number): Promise<DrainResult> {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('Scheduler advance must be a non-negative safe integer');
    }
    if (!Number.isSafeInteger(maxJobs) || maxJobs < 0) {
      throw new RangeError('Scheduler job budget must be a non-negative safe integer');
    }

    this.virtualTime += milliseconds;
    const executedJobIds: string[] = [];
    while (executedJobIds.length < maxJobs) {
      const next = this.nextDueJob();
      if (!next) {
        break;
      }
      this.jobs.delete(next.jobId);
      executedJobIds.push(next.jobId);
      await next.run();
    }

    const nextDueAt = this.nextDueAt();
    return {
      executedJobIds,
      nextDueAt,
      exceededBudget: nextDueAt !== null && nextDueAt.getTime() <= this.virtualTime,
    };
  }

  nextDueAt(): Date | null {
    let earliestDueAt: number | undefined;
    for (const job of this.jobs.values()) {
      if (earliestDueAt === undefined || job.dueAt < earliestDueAt) {
        earliestDueAt = job.dueAt;
      }
    }
    return earliestDueAt === undefined ? null : new Date(earliestDueAt);
  }

  private nextDueJob(): ScheduledJob | undefined {
    let next: ScheduledJob | undefined;
    for (const job of this.jobs.values()) {
      if (job.dueAt > this.virtualTime) {
        continue;
      }
      if (
        next === undefined ||
        job.dueAt < next.dueAt ||
        (job.dueAt === next.dueAt && job.jobId < next.jobId)
      ) {
        next = job;
      }
    }
    return next;
  }
}
