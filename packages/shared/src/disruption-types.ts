import type { FlightSegmentSnapshotDto } from './booking-types';

export enum DisruptionStatus {
  NONE = 'NONE',
  DETECTED = 'DETECTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  RESOLVED = 'RESOLVED',
}

export enum DisruptionResolvedReason {
  TRAVELLER_ACCEPTED = 'TRAVELLER_ACCEPTED',
  DEPARTURE_PASSED = 'DEPARTURE_PASSED',
  ADMIN_RESOLVED = 'ADMIN_RESOLVED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
}

export enum DisruptionActorType {
  TRAVELLER = 'TRAVELLER',
  SYSTEM = 'SYSTEM',
  ADMIN = 'ADMIN',
}

export enum DisruptionAttentionReason {
  NOTIFICATION_THROTTLED = 'NOTIFICATION_THROTTLED',
  AGED_UNRESOLVED = 'AGED_UNRESOLVED',
  DATA_QUALITY = 'DATA_QUALITY',
}

export enum ItineraryRevisionSource {
  WEBHOOK = 'WEBHOOK',
  RECONCILIATION = 'RECONCILIATION',
  BOOTSTRAP = 'BOOTSTRAP',
}

export enum MaterialBaseline {
  INCREMENTAL = 'INCREMENTAL',
  CUMULATIVE = 'CUMULATIVE',
}

export enum MaterialDisruptionReason {
  SEGMENT_REMOVED = 'SEGMENT_REMOVED',
  SEGMENT_ADDED = 'SEGMENT_ADDED',
  DEPARTURE_AIRPORT_CHANGED = 'DEPARTURE_AIRPORT_CHANGED',
  ARRIVAL_AIRPORT_CHANGED = 'ARRIVAL_AIRPORT_CHANGED',
  DEPARTURE_LOCAL_DATE_CHANGED = 'DEPARTURE_LOCAL_DATE_CHANGED',
  ARRIVAL_LOCAL_DATE_CHANGED = 'ARRIVAL_LOCAL_DATE_CHANGED',
  DEPARTURE_MOVED_EARLIER = 'DEPARTURE_MOVED_EARLIER',
  DEPARTURE_MOVED_LATER = 'DEPARTURE_MOVED_LATER',
  FINAL_ARRIVAL_MOVED_EARLIER = 'FINAL_ARRIVAL_MOVED_EARLIER',
  FINAL_ARRIVAL_MOVED_LATER = 'FINAL_ARRIVAL_MOVED_LATER',
  OVERNIGHT_CONNECTION_INTRODUCED = 'OVERNIGHT_CONNECTION_INTRODUCED',
  CONNECTION_BELOW_MCT = 'CONNECTION_BELOW_MCT',
  INVALID_CONNECTION_OVERLAP = 'INVALID_CONNECTION_OVERLAP',
}

export enum DuffelWebhookEventStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  RETRY_SCHEDULED = 'RETRY_SCHEDULED',
  PROCESSED = 'PROCESSED',
  SKIPPED = 'SKIPPED',
  FAILED_NEEDS_ATTENTION = 'FAILED_NEEDS_ATTENTION',
}

export enum NotificationOutboxType {
  MATERIAL_DISRUPTION = 'MATERIAL_DISRUPTION',
}

export enum NotificationOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
}

export enum DisruptionAuditEventAction {
  DETECTED = 'DETECTED',
  ACKNOWLEDGED = 'ACKNOWLEDGED',
  TRAVELLER_ACCEPTED = 'TRAVELLER_ACCEPTED',
  DEPARTURE_RESOLVED = 'DEPARTURE_RESOLVED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
  ADMIN_RESOLVED = 'ADMIN_RESOLVED',
  EVENT_RETRIED = 'EVENT_RETRIED',
  ATTENTION_RAISED = 'ATTENTION_RAISED',
  ATTENTION_CLEARED = 'ATTENTION_CLEARED',
}

export interface CurrentItineraryDto {
  source: 'ORIGINAL' | 'REVISION';
  revisionId: string | null;
  version: number;
  segments: FlightSegmentSnapshotDto[];
  nextUnflownDepartureAt: string | null;
  finalArrivalAt: string | null;
}

export interface BookingDisruptionDto {
  status: DisruptionStatus;
  activeRevisionId: string | null;
  isMaterial: boolean;
  materialReasons: MaterialDisruptionReason[];
  incrementalSummary: Record<string, unknown>;
  cumulativeSummary: Record<string, unknown>;
  stabilizationWarning: boolean;
  resolvedReason: DisruptionResolvedReason | null;
  resolvedAt: string | null;
}

export interface DisruptionHistoryItemDto {
  revisionId: string;
  version: number;
  observedAt: string;
  isMaterial: boolean;
  materialReasons: MaterialDisruptionReason[];
  materialBaselines: MaterialBaseline[];
  incrementalSummary: Record<string, unknown>;
  cumulativeSummary: Record<string, unknown>;
  segments: FlightSegmentSnapshotDto[];
}

export interface DisruptionHistoryResponseDto {
  items: DisruptionHistoryItemDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AcknowledgeDisruptionResponseDto {
  bookingId: string;
  activeRevisionId: string;
  disruptionStatus: DisruptionStatus;
  resolvedReason: DisruptionResolvedReason | null;
  updatedAt: string;
}

export interface AcceptDisruptionResponseDto {
  bookingId: string;
  activeRevisionId: string;
  disruptionStatus: DisruptionStatus;
  resolvedReason: DisruptionResolvedReason | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface StaleDisruptionRevisionResponseDto {
  code: 'STALE_DISRUPTION_REVISION';
  activeRevisionId: string;
  disruptionStatus: DisruptionStatus;
}

export interface AdminDisruptionDto {
  bookingId: string;
  duffelOrderId: string | null;
  activeRevisionId: string | null;
  version: number;
  materialReasons: MaterialDisruptionReason[];
  status: DisruptionStatus;
  attention: boolean;
  attentionReason: DisruptionAttentionReason | null;
  attentionAt: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
  auditSummary?: string;
}

export interface AdminResolveDisruptionRequestDto {
  revisionId: string;
  note: string;
}

export interface AdminClearAttentionRequestDto {
  note: string;
}

export interface AdminDuffelWebhookEventDto {
  id: string;
  supplierEventId: string;
  duffelOrderId: string | null;
  eventType: string;
  status: DuffelWebhookEventStatus;
  attempts: number;
  nextAttemptAt: string | null;
  processingStartedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminRetryWebhookEventRequestDto {
  note: string;
}

export interface AdminDataQualityReportDto {
  bookingsMissingOrderIdCount: number;
  bookingsDuplicateOrderIdCount: number;
  bookingsMissingSnapshotCount: number;
  bookingsLackingDerivableTimesCount: number;
  missingOrderIdItems: string[];
  duplicateOrderIdItems: { duffelOrderId: string; bookingIds: string[] }[];
  missingSnapshotItems: string[];
  lackingDerivableTimesItems: string[];
}
