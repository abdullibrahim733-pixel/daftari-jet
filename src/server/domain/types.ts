/**
 * Domain vocabulary shared by services, repositories and the UI.
 *
 * Persisted values are stable lowercase snake_case (architecture.md section 11).
 * API JSON fields are camelCase.
 */

export const RECORD_TYPES = [
  'sale',
  'expense',
  'debt_created',
  'debt_payment',
  'stock_movement',
  'note',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const LEDGER_RECORD_STATUSES = ['posted', 'voided', 'reversed'] as const;
export type LedgerRecordStatus = (typeof LEDGER_RECORD_STATUSES)[number];

export const PROPOSAL_STATES = [
  'queued',
  'processing',
  'needs_review',
  'needs_details',
  'failed',
  'confirmed',
  'rejected',
  'duplicate',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

/** States a reviewer can still act on. */
export const REVIEWABLE_PROPOSAL_STATES: readonly ProposalState[] = [
  'needs_review',
  'needs_details',
  'duplicate',
];

/** States that still need automated or manual processing work. */
export const OPEN_PROPOSAL_STATES: readonly ProposalState[] = [
  'queued',
  'processing',
  'needs_review',
  'needs_details',
  'duplicate',
];

export const SOURCE_EVENT_STATUSES = [
  'received',
  'processing',
  'processed',
  'failed',
  'unsupported',
] as const;
export type SourceEventStatus = (typeof SOURCE_EVENT_STATUSES)[number];

export const SOURCE_KINDS = ['whatsapp_voice', 'whatsapp_text', 'in_app_voice', 'manual', 'import'] as const;

/** Source kinds backed by a stored source event (as opposed to a provider name). */
export const SOURCE_EVENT_KINDS: readonly SourceKind[] = ['whatsapp_voice', 'whatsapp_text', 'in_app_voice'];
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const ROLES = ['owner', 'manager', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const PAYMENT_STATUSES = ['paid', 'unpaid', 'partial', 'unknown'] as const;
/**
 * A merchant assertion taken from a voice note, never a verified settlement
 * (architecture.md section 10).
 */
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = [
  'cash',
  'mobile_money',
  'bank',
  'card',
  'credit',
  'unknown',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MOVEMENT_TYPES = ['in', 'out', 'adjustment'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const INTEGRATION_STATUSES = ['connected', 'disconnected', 'error', 'pending'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const REJECTION_REASON_CODES = [
  'not_a_business_record',
  'wrong_amount',
  'wrong_record_type',
  'duplicate',
  'already_recorded',
  'source_unclear',
  'other',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export const CORRECTION_REASON_CODES = [
  'wrong_amount',
  'wrong_date',
  'wrong_category',
  'wrong_payment_status',
  'wrong_customer',
  'wrong_record_type',
  'entered_in_error',
  'other',
] as const;
export type CorrectionReasonCode = (typeof CORRECTION_REASON_CODES)[number];

export const JOB_TYPES = [
  'acquire_media',
  'transcribe_source',
  'extract_proposal',
  'validate_proposal',
  'refresh_summary',
  'build_export',
  'delete_expired_media',
  'provider_health_check',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'dead_letter'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Every state change that can be audited.
 *
 * This is the single source of the audit vocabulary: services derive their action
 * type from it, so an action cannot be recorded that the privacy export, the
 * documented contract or a test does not know about.
 */
export const AUDIT_ACTIONS = [
  'business.created',
  'business.updated',
  'business.settings_updated',
  'membership.invited',
  'membership.role_changed',
  'membership.revoked',
  'integration.connected',
  'integration.disconnected',
  'integration.consent_updated',
  'integration.updated',
  'source_event.received',
  'source_event.processing_failed',
  'transcript.completed',
  'transcript.failed',
  'transcript.corrected',
  'transcript.marked_unusable',
  'proposal.created',
  'proposal.edited',
  'proposal.confirmed',
  'proposal.rejected',
  'proposal.needs_details',
  'proposal.retried',
  'proposal.duplicate_resolved',
  'ledger_record.created',
  'ledger_record.corrected',
  'ledger_record.reversed',
  'ledger_record.voided',
  'customer.created',
  'customer.updated',
  'obligation.created',
  'obligation.restated',
  'debt_payment.recorded',
  'inventory_item.created',
  'inventory_item.updated',
  'inventory_movement.recorded',
  'export.requested',
  'export.downloaded',
  'media.accessed',
  'media.playback_link_issued',
  'privacy.export_requested',
  'privacy.deletion_requested',
  'settings.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ENTITY_TYPES = [
  'business',
  'membership',
  'integration',
  'source_event',
  'transcript',
  'proposal',
  'ledger_record',
  'debt_payment',
  'export_job',
  'media_asset',
  'settings',
] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const DATE_FORMATS = {
  /** Calendar date in the business timezone, e.g. 2026-10-04. */
  date: 'date',
  /** Local wall clock in the business timezone, e.g. 2026-10-04T15:10. */
  datetimeLocal: 'datetime-local',
} as const;

export function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}

export function isProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value);
}

/** Record types that affect money totals. Notes never do. */
export const MONEY_RECORD_TYPES: readonly RecordType[] = [
  'sale',
  'expense',
  'debt_created',
  'debt_payment',
];