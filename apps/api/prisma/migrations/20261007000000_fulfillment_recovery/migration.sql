ALTER TYPE "PaymentStatus" ADD VALUE 'RESERVED';

CREATE TYPE "FulfillmentWorkflowState" AS ENUM (
  'AUTHORIZING',
  'READY_FOR_SUPPLIER',
  'SUPPLIER_UNCERTAIN',
  'SUPPLIER_CONFIRMED',
  'CAPTURE_UNCERTAIN',
  'COMPENSATING',
  'COMPLETED',
  'DEFINITIVE_FAILURE'
);

CREATE TYPE "WorkflowActorType" AS ENUM ('SAGA', 'RECOVERY', 'OPERATOR');
CREATE TYPE "ProviderKind" AS ENUM ('STRIPE', 'DUFFEL');
CREATE TYPE "ProviderEvidenceKind" AS ENUM ('HTTP_RESPONSE', 'AUTHORITATIVE_READ', 'WEBHOOK', 'CANDIDATE_DISCOVERY');
CREATE TYPE "ProviderOutcomeClass" AS ENUM ('CONFIRMED', 'DEFINITIVE_FAILURE', 'NONFINAL', 'UNRESOLVED');
CREATE TYPE "ProviderOperationPurpose" AS ENUM (
  'PAYMENT_INTENT_CREATE',
  'AUTHORIZATION',
  'ORDER_CREATE',
  'CAPTURE',
  'ORDER_CANCEL',
  'AUTHORIZATION_RELEASE',
  'REFUND',
  'RECONCILE'
);
CREATE TYPE "ProviderOperationStatus" AS ENUM (
  'NOT_STARTED',
  'PREPARED',
  'UNRESOLVED',
  'CONFIRMED',
  'DEFINITIVE_FAILURE',
  'COMPENSATED'
);
CREATE TYPE "ProviderAttemptKind" AS ENUM ('DISPATCH', 'RECONCILIATION');
CREATE TYPE "ProviderAttemptStatus" AS ENUM (
  'PREPARED',
  'RESPONSE_RECEIVED',
  'CONFIRMED',
  'DEFINITIVE_FAILURE',
  'UNRESOLVED',
  'ABANDONED_BEFORE_DISPATCH'
);

ALTER TABLE "payments" ALTER COLUMN "stripePaymentIntentId" DROP NOT NULL;

CREATE TABLE "fulfillment_workflows" (
  "id" TEXT NOT NULL,
  "bookingIntentId" TEXT NOT NULL,
  "bookingId" TEXT,
  "currentPaymentId" TEXT,
  "state" "FulfillmentWorkflowState" NOT NULL DEFAULT 'AUTHORIZING',
  "currentCheckpoint" TEXT,
  "version" INTEGER NOT NULL DEFAULT 0,
  "firstUncertainAt" TIMESTAMP(3),
  "escalatedAt" TIMESTAMP(3),
  "nextReconcileAt" TIMESTAMP(3),
  "lastReconciledAt" TIMESTAMP(3),
  "ownerToken" TEXT,
  "fence" BIGINT NOT NULL DEFAULT 0,
  "leaseExpiresAt" TIMESTAMP(3),
  "renewedAt" TIMESTAMP(3),
  "actorType" "WorkflowActorType",
  "actorId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "fulfillment_workflows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fulfillment_workflows_bookingIntentId_key"
  ON "fulfillment_workflows"("bookingIntentId");
CREATE UNIQUE INDEX "fulfillment_workflows_bookingId_key"
  ON "fulfillment_workflows"("bookingId");
CREATE INDEX "fulfillment_workflows_state_nextReconcileAt_idx"
  ON "fulfillment_workflows"("state", "nextReconcileAt");
CREATE INDEX "fulfillment_workflows_firstUncertainAt_idx"
  ON "fulfillment_workflows"("firstUncertainAt");

ALTER TABLE "fulfillment_workflows"
  ADD CONSTRAINT "fulfillment_workflows_bookingIntentId_fkey"
  FOREIGN KEY ("bookingIntentId") REFERENCES "booking_intents"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "fulfillment_workflows"
  ADD CONSTRAINT "fulfillment_workflows_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "bookings"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "fulfillment_workflows"
  ADD CONSTRAINT "fulfillment_workflows_currentPaymentId_fkey"
  FOREIGN KEY ("currentPaymentId") REFERENCES "payments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payments" ADD COLUMN "fulfillmentWorkflowId" TEXT;
CREATE INDEX "payments_fulfillmentWorkflowId_idx"
  ON "payments"("fulfillmentWorkflowId");
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_fulfillmentWorkflowId_fkey"
  FOREIGN KEY ("fulfillmentWorkflowId") REFERENCES "fulfillment_workflows"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "provider_operations" (
  "id" TEXT NOT NULL,
  "workflowId" TEXT NOT NULL,
  "paymentId" TEXT,
  "provider" "ProviderKind" NOT NULL,
  "purpose" "ProviderOperationPurpose" NOT NULL,
  "logicalSequence" INTEGER NOT NULL DEFAULT 1,
  "status" "ProviderOperationStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "providerObjectId" TEXT,
  "linkedOrderId" TEXT,
  "firstUncertainAt" TIMESTAMP(3),
  "lastOutcome" "ProviderOutcomeClass",
  "lastObservedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "provider_operations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "provider_operations_workflowId_provider_purpose_logicalSequence_key"
  ON "provider_operations"("workflowId", "provider", "purpose", "logicalSequence");
CREATE INDEX "provider_operations_workflowId_status_idx"
  ON "provider_operations"("workflowId", "status");
CREATE INDEX "provider_operations_paymentId_idx"
  ON "provider_operations"("paymentId");
ALTER TABLE "provider_operations"
  ADD CONSTRAINT "provider_operations_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "fulfillment_workflows"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "provider_operations"
  ADD CONSTRAINT "provider_operations_paymentId_fkey"
  FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "provider_attempts" (
  "id" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "kind" "ProviderAttemptKind" NOT NULL,
  "status" "ProviderAttemptStatus" NOT NULL DEFAULT 'PREPARED',
  "claimFence" BIGINT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "providerRequestId" TEXT,
  "providerObjectId" TEXT,
  "requestFingerprint" TEXT,
  "normalizedFailureCode" TEXT,
  "normalizedOutcome" "ProviderOutcomeClass",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "provider_attempts_operationId_startedAt_idx"
  ON "provider_attempts"("operationId", "startedAt");
CREATE INDEX "provider_attempts_claimFence_idx"
  ON "provider_attempts"("claimFence");
ALTER TABLE "provider_attempts"
  ADD CONSTRAINT "provider_attempts_operationId_fkey"
  FOREIGN KEY ("operationId") REFERENCES "provider_operations"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_events"
  ADD COLUMN "providerOperationId" TEXT,
  ADD COLUMN "providerAttemptId" TEXT,
  ADD COLUMN "provider" "ProviderKind",
  ADD COLUMN "evidenceKind" "ProviderEvidenceKind",
  ADD COLUMN "outcomeClass" "ProviderOutcomeClass",
  ADD COLUMN "bookingIntentMatched" BOOLEAN,
  ADD COLUMN "offerMatched" BOOLEAN,
  ADD COLUMN "passengerSetMatched" BOOLEAN,
  ADD COLUMN "itineraryMatched" BOOLEAN;
CREATE INDEX "payment_events_providerOperationId_idx"
  ON "payment_events"("providerOperationId");
CREATE INDEX "payment_events_providerAttemptId_idx"
  ON "payment_events"("providerAttemptId");
ALTER TABLE "payment_events"
  ADD CONSTRAINT "payment_events_providerOperationId_fkey"
  FOREIGN KEY ("providerOperationId") REFERENCES "provider_operations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_events"
  ADD CONSTRAINT "payment_events_providerAttemptId_fkey"
  FOREIGN KEY ("providerAttemptId") REFERENCES "provider_attempts"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;