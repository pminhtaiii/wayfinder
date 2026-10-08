import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import {
  PaymentStatus,
  Prisma,
  ProviderKind as PrismaProviderKind,
  ProviderOperationPurpose as PrismaProviderOperationPurpose,
  ProviderAttemptKind,
  ProviderAttemptStatus,
  ProviderOperationStatus,
  PaymentEventSource,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FulfillmentWorkflowRepository, type WorkflowClaim } from './fulfillment-workflow.repository';

export type ProviderName = 'STRIPE' | 'DUFFEL';

export type ProviderOperationPurpose =
  | 'PAYMENT_INTENT_CREATE'
  | 'AUTHORIZATION'
  | 'ORDER_CREATE'
  | 'CAPTURE'
  | 'ORDER_CANCEL'
  | 'AUTHORIZATION_RELEASE'
  | 'REFUND'
  | 'RECONCILE';

export type NormalizedProviderOutcome =
  | 'CONFIRMED'
  | 'DEFINITIVE_FAILURE'
  | 'NONFINAL'
  | 'UNRESOLVED';

export type ProviderOperationRef = {
  id: string;
  workflowId: string;
  paymentId: string | null;
  provider: ProviderName;
  purpose: ProviderOperationPurpose;
  logicalSequence: number;
};

export type ProviderAttemptRef = {
  id: string;
  operationId: string;
  kind: 'DISPATCH' | 'RECONCILIATION';
  claimFence: bigint;
};

export type OutcomeRecordResult =
  | { kind: 'ADVANCED'; paymentEventId: bigint }
  | { kind: 'EVIDENCE_ONLY'; paymentEventId: bigint };

export type SafeProviderEvidence = {
  providerStatus: string | null;
  providerEventId: string | null;
  evidenceSource: 'HTTP_RESPONSE' | 'AUTHORITATIVE_READ' | 'WEBHOOK' | 'CANDIDATE_DISCOVERY';
  linkage: {
    bookingIntentMatched: boolean;
    offerMatched: boolean;
    passengerSetMatched: boolean;
    itineraryMatched: boolean;
  };
};

type OperationRecord = {
  id: string;
  workflowId: string;
  paymentId: string | null;
  provider: PrismaProviderKind;
  purpose: PrismaProviderOperationPurpose;
  logicalSequence: number;
};

function toOperationRef(operation: OperationRecord): ProviderOperationRef {
  return {
    id: operation.id,
    workflowId: operation.workflowId,
    paymentId: operation.paymentId,
    provider: operation.provider,
    purpose: operation.purpose,
    logicalSequence: operation.logicalSequence,
  };
}

function reservationCurrency(currency: string): string {
  if (!/^[A-Za-z]{3}$/.test(currency)) {
    throw new BadRequestException('Payment reservation currency must be an ISO 4217 code');
  }
  return currency.toLowerCase();
}

function validateReservationInput(input: { attemptNumber: number; amount: number; currency: string; stripeCustomerId: string | null }): string {
  if (input.attemptNumber !== 1 && input.attemptNumber !== 2) {
    throw new BadRequestException('Payment reservation attempt number must be 1 or 2');
  }
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new BadRequestException('Payment reservation amount must be a positive integer in minor units');
  }
  if (input.stripeCustomerId !== null && !/^cus_[A-Za-z0-9]+$/.test(input.stripeCustomerId)) {
    throw new BadRequestException('Payment reservation Stripe customer ID is invalid');
  }
  return reservationCurrency(input.currency);
}

function requireApplied<T>(result: { kind: 'APPLIED'; value: T } | { kind: 'FENCED_OUT' }): T {
  if (result.kind === 'FENCED_OUT') {
    throw new ConflictException('Workflow claim is no longer active');
  }
  return result.value;
}

@Injectable()
export class ProviderOperationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflows: FulfillmentWorkflowRepository,
  ) {}

  async reservePaymentAndIntentCreate(
    claim: WorkflowClaim,
    input: {
      idempotencyKeyId: string;
      attemptNumber: number;
      amount: number;
      currency: string;
      stripeCustomerId: string | null;
    },
  ): Promise<{ paymentId: string; operation: ProviderOperationRef }> {
    const currency = validateReservationInput(input);
    const result = await this.workflows.runFencedTransaction(claim, async (tx) => {
      const workflow = await tx.fulfillmentWorkflow.findUnique({
        where: { id: claim.workflowId },
      });
      if (!workflow || workflow.bookingIntentId !== claim.bookingIntentId) {
        throw new ConflictException('Workflow claim does not match its booking intent');
      }

      const bookingIntent = await tx.bookingIntent.findUnique({
        where: { id: claim.bookingIntentId },
        select: { userId: true },
      });
      if (!bookingIntent) {
        throw new ConflictException('Workflow booking intent no longer exists');
      }
      const idempotencyKey = await tx.idempotencyKey.findUnique({
        where: { id: input.idempotencyKeyId },
        select: { customerId: true },
      });
      if (!idempotencyKey || idempotencyKey.customerId !== bookingIntent.userId) {
        throw new ConflictException('Payment idempotency key does not belong to the workflow owner');
      }

      const priorPaymentForKey = await tx.payment.findFirst({
        where: { idempotencyKeyId: input.idempotencyKeyId },
        select: { id: true, bookingIntentId: true, fulfillmentWorkflowId: true },
      });
      if (
        priorPaymentForKey &&
        (priorPaymentForKey.bookingIntentId !== claim.bookingIntentId ||
          priorPaymentForKey.fulfillmentWorkflowId !== claim.workflowId ||
          priorPaymentForKey.id !== workflow.currentPaymentId)
      ) {
        throw new ConflictException('Payment idempotency key is already bound to another reservation');
      }

      if (workflow.currentPaymentId !== null) {
        const existingPayment = await tx.payment.findUnique({
          where: { id: workflow.currentPaymentId },
        });
        if (
          !existingPayment ||
          existingPayment.bookingIntentId !== claim.bookingIntentId ||
          existingPayment.fulfillmentWorkflowId !== claim.workflowId
        ) {
          throw new ConflictException('Current payment is outside the workflow scope');
        }
        if (existingPayment.attemptNumber === input.attemptNumber) {
          if (
            existingPayment.amount !== input.amount ||
            existingPayment.currency.toLowerCase() !== currency ||
            existingPayment.stripeCustomerId !== input.stripeCustomerId
          ) {
            throw new ConflictException('Payment reservation terms are immutable');
          }

          const operation = await this.getOrCreateOperationInTransaction(
            tx,
            claim.workflowId,
            'STRIPE',
            'PAYMENT_INTENT_CREATE',
            input.attemptNumber,
            existingPayment.id,
          );
          return { paymentId: existingPayment.id, operation };
        }

        const previousIntentOperation = await tx.providerOperation.findUnique({
          where: {
            workflowId_provider_purpose_logicalSequence: {
              workflowId: claim.workflowId,
              provider: 'STRIPE',
              purpose: 'PAYMENT_INTENT_CREATE',
              logicalSequence: existingPayment.attemptNumber,
            },
          },
          select: { paymentId: true, status: true },
        });
        if (
          input.attemptNumber !== existingPayment.attemptNumber + 1 ||
          existingPayment.status !== PaymentStatus.FAILED ||
          existingPayment.stripePaymentIntentId !== null ||
          !previousIntentOperation ||
          previousIntentOperation.paymentId !== existingPayment.id ||
          previousIntentOperation.status !== ProviderOperationStatus.DEFINITIVE_FAILURE
        ) {
          throw new ConflictException('Previous payment attempt is not definitively closed');
        }
      }

      const payment = await tx.payment.create({
        data: {
          bookingIntentId: claim.bookingIntentId,
          fulfillmentWorkflowId: claim.workflowId,
          attemptNumber: input.attemptNumber,
          idempotencyKeyId: input.idempotencyKeyId,
          stripePaymentIntentId: null,
          stripeCustomerId: input.stripeCustomerId,
          amount: input.amount,
          currency,
          status: PaymentStatus.RESERVED,
        },
      });
      await tx.fulfillmentWorkflow.update({
        where: { id: claim.workflowId },
        data: { currentPaymentId: payment.id },
      });
      const operation = await this.getOrCreateOperationInTransaction(
        tx,
        claim.workflowId,
        'STRIPE',
        'PAYMENT_INTENT_CREATE',
        input.attemptNumber,
        payment.id,
      );
      return { paymentId: payment.id, operation };
    });
    return requireApplied(result);
  }

  async getOrCreateOperation(
    claim: WorkflowClaim,
    input: {
      provider: ProviderName;
      purpose: ProviderOperationPurpose;
      logicalSequence: number;
      paymentId: string | null;
    },
  ): Promise<ProviderOperationRef> {
    if (!Number.isSafeInteger(input.logicalSequence) || input.logicalSequence < 1) {
      throw new BadRequestException('Provider operation logical sequence must be a positive integer');
    }
    const result = await this.workflows.runFencedTransaction(claim, async (tx) => {
      const workflow = await tx.fulfillmentWorkflow.findUnique({
        where: { id: claim.workflowId },
        select: { id: true, bookingIntentId: true },
      });
      if (!workflow || workflow.bookingIntentId !== claim.bookingIntentId) {
        throw new ConflictException('Workflow claim does not match its booking intent');
      }
      if (input.paymentId !== null) {
        const payment = await tx.payment.findUnique({
          where: { id: input.paymentId },
          select: { bookingIntentId: true, fulfillmentWorkflowId: true },
        });
        if (
          !payment ||
          payment.bookingIntentId !== claim.bookingIntentId ||
          payment.fulfillmentWorkflowId !== claim.workflowId
        ) {
          throw new ConflictException('Provider operation payment is outside the workflow scope');
        }
      }
      return this.getOrCreateOperationInTransaction(
        tx,
        claim.workflowId,
        input.provider,
        input.purpose,
        input.logicalSequence,
        input.paymentId,
      );
    });
    return requireApplied(result);
  }
  async prepareAttempt(
    claim: WorkflowClaim,
    input: {
      operationId: string;
      kind: 'DISPATCH' | 'RECONCILIATION';
      requestFingerprint: string;
    },
  ): Promise<ProviderAttemptRef> {
    if (!/^sha256:[A-Za-z0-9_-]{1,80}$/.test(input.requestFingerprint)) {
      throw new BadRequestException('Provider request fingerprint must be a bounded SHA-256 label');
    }
    const result = await this.workflows.runFencedTransaction(claim, async (tx) => {
      const operation = await tx.providerOperation.findFirst({
        where: { id: input.operationId, workflowId: claim.workflowId },
      });
      if (!operation) {
        throw new ConflictException('Provider operation is outside the workflow scope');
      }
      if (operation.paymentId !== null) {
        const payment = await tx.payment.findUnique({
          where: { id: operation.paymentId },
          select: { bookingIntentId: true, fulfillmentWorkflowId: true },
        });
        if (
          !payment ||
          payment.bookingIntentId !== claim.bookingIntentId ||
          payment.fulfillmentWorkflowId !== claim.workflowId
        ) {
          throw new ConflictException('Provider operation payment is outside the workflow scope');
        }
      }

      const attempts = await tx.providerAttempt.findMany({
        where: { operationId: operation.id },
        select: { id: true },
      });
      if (input.kind === ProviderAttemptKind.DISPATCH) {
        if (operation.status !== ProviderOperationStatus.NOT_STARTED || attempts.length !== 0) {
          throw new ConflictException('An unresolved provider operation cannot be dispatched again');
        }
      } else if (
        operation.status !== ProviderOperationStatus.PREPARED &&
        operation.status !== ProviderOperationStatus.UNRESOLVED
      ) {
        throw new ConflictException('Only an unfinished provider operation can be reconciled');
      }

      const attempt = await tx.providerAttempt.create({
        data: {
          operationId: operation.id,
          kind: input.kind,
          status: ProviderAttemptStatus.PREPARED,
          claimFence: claim.fence,
          requestFingerprint: input.requestFingerprint,
        },
      });
      if (operation.status === ProviderOperationStatus.NOT_STARTED) {
        await tx.providerOperation.update({
          where: { id: operation.id },
          data: { status: ProviderOperationStatus.PREPARED },
        });
      }
      return {
        id: attempt.id,
        operationId: attempt.operationId,
        kind: attempt.kind,
        claimFence: attempt.claimFence,
      };
    });
    return requireApplied(result);
  }
  async recordOutcome(
    claim: WorkflowClaim,
    input: {
      attemptId: string;
      outcome: NormalizedProviderOutcome;
      eventType: string;
      providerObjectId: string | null;
      amount: number | null;
      currency: string | null;
      observedAt: Date;
      safeEvidence: SafeProviderEvidence | null;
    },
  ): Promise<OutcomeRecordResult> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(input.eventType)) {
      throw new BadRequestException('Provider event type must be a bounded code');
    }
    if (input.providerObjectId !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.providerObjectId)) {
      throw new BadRequestException('Provider object ID is invalid');
    }
    if (input.amount !== null && (!Number.isSafeInteger(input.amount) || input.amount < 0)) {
      throw new BadRequestException('Provider amount must be a non-negative integer in minor units');
    }
    if (input.currency !== null && !/^[A-Za-z]{3}$/.test(input.currency)) {
      throw new BadRequestException('Provider currency must be an ISO 4217 code');
    }
    if (!(input.observedAt instanceof Date) || !Number.isFinite(input.observedAt.getTime())) {
      throw new BadRequestException('Provider observation time is invalid');
    }
    if (
      input.safeEvidence !== null &&
      ((input.safeEvidence.providerStatus !== null && !/^[A-Za-z0-9_.:-]{1,120}$/.test(input.safeEvidence.providerStatus)) ||
        (input.safeEvidence.providerEventId !== null &&
          !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.safeEvidence.providerEventId)))
    ) {
      throw new BadRequestException('Safe provider evidence contains an invalid status or event ID');
    }

    const appendEvidence = async (tx: Prisma.TransactionClient, advanceState: boolean): Promise<{ paymentEventId: bigint; stateAdvanced: boolean }> => {
      const workflow = await tx.fulfillmentWorkflow.findUnique({
        where: { id: claim.workflowId },
        select: { bookingIntentId: true, currentPaymentId: true, firstUncertainAt: true },
      });
      if (!workflow || workflow.bookingIntentId !== claim.bookingIntentId) {
        throw new ConflictException('Workflow claim does not match its booking intent');
      }
      const attempt = await tx.providerAttempt.findFirst({
        where: { id: input.attemptId, operation: { workflowId: claim.workflowId } },
        include: { operation: true },
      });
      if (!attempt || attempt.claimFence !== claim.fence) {
        throw new ConflictException('Provider attempt is outside the claim scope');
      }
      const paymentId = attempt.operation.paymentId ?? workflow.currentPaymentId;
      if (paymentId === null) {
        throw new ConflictException('Provider evidence requires a workflow payment');
      }
      const payment = await tx.payment.findUnique({ where: { id: paymentId } });
      if (
        !payment ||
        payment.bookingIntentId !== claim.bookingIntentId ||
        payment.fulfillmentWorkflowId !== claim.workflowId
      ) {
        throw new ConflictException('Provider evidence payment is outside the workflow scope');
      }
      if (
        input.providerObjectId !== null &&
        attempt.operation.providerObjectId !== null &&
        attempt.operation.providerObjectId !== input.providerObjectId
      ) {
        throw new ConflictException('Provider operation is already bound to another provider object');
      }
      if (
        input.providerObjectId !== null &&
        attempt.operation.provider === 'STRIPE' &&
        attempt.operation.purpose === 'PAYMENT_INTENT_CREATE' &&
        payment.stripePaymentIntentId !== null &&
        payment.stripePaymentIntentId !== input.providerObjectId
      ) {
        throw new ConflictException('Payment is already bound to another Stripe intent');
      }

      const evidenceSource = input.safeEvidence?.evidenceSource ?? null;
      const event = await tx.paymentEvent.create({
        data: {
          paymentId: payment.id,
          eventType: input.eventType,
          previousStatus: payment.status,
          newStatus: payment.status,
          amount: null,
          source: evidenceSource === 'WEBHOOK' ? PaymentEventSource.WEBHOOK : PaymentEventSource.API,
          metadata: {
            providerStatus: input.safeEvidence?.providerStatus ?? null,
            providerEventId: input.safeEvidence?.providerEventId ?? null,
            providerObjectId: input.providerObjectId,
            amount: input.amount,
            currency: input.currency?.toLowerCase() ?? null,
            observedAt: input.observedAt.toISOString(),
          },
          providerOperationId: attempt.operation.id,
          providerAttemptId: attempt.id,
          provider: attempt.operation.provider,
          evidenceKind: evidenceSource,
          outcomeClass: input.outcome,
          bookingIntentMatched: input.safeEvidence?.linkage.bookingIntentMatched ?? null,
          offerMatched: input.safeEvidence?.linkage.offerMatched ?? null,
          passengerSetMatched: input.safeEvidence?.linkage.passengerSetMatched ?? null,
          itineraryMatched: input.safeEvidence?.linkage.itineraryMatched ?? null,
          createdBy: 'provider-operation-service',
        },
        select: { id: true },
      });

      if (!advanceState) {
        return { paymentEventId: event.id, stateAdvanced: false };
      }

      const terminalAttempt =
        attempt.status === ProviderAttemptStatus.CONFIRMED ||
        attempt.status === ProviderAttemptStatus.DEFINITIVE_FAILURE ||
        attempt.status === ProviderAttemptStatus.ABANDONED_BEFORE_DISPATCH;
      if (terminalAttempt) {
        return { paymentEventId: event.id, stateAdvanced: false };
      }
      const terminalOperation =
        attempt.operation.status === ProviderOperationStatus.CONFIRMED ||
        attempt.operation.status === ProviderOperationStatus.DEFINITIVE_FAILURE ||
        attempt.operation.status === ProviderOperationStatus.COMPENSATED;
      const uncertain = input.outcome === 'NONFINAL' || input.outcome === 'UNRESOLVED';
      const attemptStatus =
        input.outcome === 'CONFIRMED'
          ? ProviderAttemptStatus.CONFIRMED
          : input.outcome === 'DEFINITIVE_FAILURE'
            ? ProviderAttemptStatus.DEFINITIVE_FAILURE
            : input.outcome === 'NONFINAL'
              ? ProviderAttemptStatus.RESPONSE_RECEIVED
              : ProviderAttemptStatus.UNRESOLVED;
      const operationStatus =
        input.outcome === 'CONFIRMED'
          ? ProviderOperationStatus.CONFIRMED
          : input.outcome === 'DEFINITIVE_FAILURE'
            ? ProviderOperationStatus.DEFINITIVE_FAILURE
            : ProviderOperationStatus.UNRESOLVED;
      await tx.providerAttempt.update({
        where: { id: attempt.id },
        data: {
          status: attemptStatus,
          normalizedOutcome: input.outcome,
          providerObjectId: input.providerObjectId ?? undefined,
          completedAt: input.observedAt,
        },
      });
      if (!terminalOperation) {
        await tx.providerOperation.update({
          where: { id: attempt.operation.id },
          data: {
            status: operationStatus,
            providerObjectId: input.providerObjectId ?? undefined,
            lastOutcome: input.outcome,
            lastObservedAt: input.observedAt,
            firstUncertainAt:
              uncertain && attempt.operation.firstUncertainAt === null
                ? input.observedAt
                : undefined,
          },
        });
      }
      if (
        !terminalOperation &&
        attempt.operation.provider === 'STRIPE' &&
        attempt.operation.purpose === 'PAYMENT_INTENT_CREATE'
      ) {
        if (input.outcome === 'CONFIRMED') {
          if (input.providerObjectId === null) {
            throw new ConflictException('Confirmed Stripe intent creation requires a provider object ID');
          }
          if (payment.stripePaymentIntentId === null) {
            if (payment.status !== PaymentStatus.RESERVED) {
              throw new ConflictException('Stripe intent creation conflicts with the payment status');
            }
            await tx.payment.update({
              where: { id: payment.id },
              data: { stripePaymentIntentId: input.providerObjectId, status: PaymentStatus.CREATED },
            });
          } else if (
            payment.stripePaymentIntentId !== input.providerObjectId ||
            payment.status !== PaymentStatus.CREATED
          ) {
            throw new ConflictException('Stripe intent creation conflicts with the existing payment');
          }
        } else if (input.outcome === 'DEFINITIVE_FAILURE') {
          if (payment.stripePaymentIntentId !== null) {
            throw new ConflictException('Definitive intent creation failure conflicts with an existing Stripe ID');
          }
          if (payment.status === PaymentStatus.RESERVED) {
            await tx.payment.update({
              where: { id: payment.id },
              data: { status: PaymentStatus.FAILED },
            });
          } else if (payment.status !== PaymentStatus.FAILED) {
            throw new ConflictException('Definitive intent creation failure conflicts with the payment status');
          }
        }
      }
      if (!terminalOperation && uncertain && workflow.firstUncertainAt === null) {
        await tx.fulfillmentWorkflow.update({
          where: { id: claim.workflowId },
          data: { firstUncertainAt: input.observedAt },
        });
      }
      return { paymentEventId: event.id, stateAdvanced: true };
    };

    const result = await this.workflows.runFencedTransaction(claim, (tx) => appendEvidence(tx, true));
    if (result.kind === 'APPLIED') {
      return result.value.stateAdvanced
        ? { kind: 'ADVANCED', paymentEventId: result.value.paymentEventId }
        : { kind: 'EVIDENCE_ONLY', paymentEventId: result.value.paymentEventId };
    }
    const recorded = await this.prisma.$transaction((tx) => appendEvidence(tx, false));
    return { kind: 'EVIDENCE_ONLY', paymentEventId: recorded.paymentEventId };
  }
  private async getOrCreateOperationInTransaction(
    tx: Prisma.TransactionClient,
    workflowId: string,
    provider: ProviderName,
    purpose: ProviderOperationPurpose,
    logicalSequence: number,
    paymentId: string | null,
  ): Promise<ProviderOperationRef> {
    const existing = await tx.providerOperation.findUnique({
      where: {
        workflowId_provider_purpose_logicalSequence: {
          workflowId,
          provider,
          purpose,
          logicalSequence,
        },
      },
    });
    if (existing) {
      if (existing.paymentId !== paymentId) {
        throw new ConflictException('Provider operation is already linked to another payment');
      }
      return toOperationRef(existing);
    }

    const operation = await tx.providerOperation.create({
      data: { workflowId, provider, purpose, logicalSequence, paymentId },
    });
    return toOperationRef(operation);
  }
}
