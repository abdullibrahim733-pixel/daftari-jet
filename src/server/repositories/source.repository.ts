/**
 * Source lineage persistence: inbound provider events, private media objects,
 * transcripts and proposals.
 *
 * Source identity is preserved from webhook to transcript, proposal, decision
 * and ledger record. `business_id` is part of every unique key and index.
 */

import { all, get, run, scalar, type Db } from '@/server/db/client';
import { newId, nowIso, toJson, fromJson, toSqlBool, fromSqlBool } from '@/server/db/ids';
import type { TenantScope } from '@/server/business-context/context';
import {
  type DuplicateCandidate,
  type ProposalFields,
  type ProvenanceMap,
  type ValidationIssue,
} from '@/lib/validation/proposal';
import {
  SOURCE_EVENT_KINDS,
  type ProposalState,
  type RecordType,
  type SourceEventStatus,
  type SourceKind,
} from '@/server/domain/types';

export type SourceEventRow = {
  id: string;
  business_id: string;
  integration_id: string | null;
  provider_event_id: string;
  event_type: string;
  sender_ref: string | null;
  received_at: string;
  provider_sent_at: string | null;
  dedupe_key: string;
  payload_redacted: string | null;
  status: SourceEventStatus;
  failure_code: string | null;
  processing_attempts: number;
  created_at: string;
  updated_at: string;
};

export type MediaAssetRow = {
  id: string;
  business_id: string;
  source_event_id: string | null;
  object_key: string;
  media_type: string;
  byte_size: number;
  duration_seconds: number | null;
  checksum: string;
  encryption_metadata: string;
  retention_deadline: string;
  deleted_at: string | null;
  access_classification: string;
  created_at: string;
};

export type TranscriptRow = {
  id: string;
  business_id: string;
  source_event_id: string;
  media_asset_id: string | null;
  machine_text: string;
  corrected_text: string | null;
  corrected_by_user_id: string | null;
  corrected_at: string | null;
  marked_unusable: number;
  detected_language: string;
  provider: string;
  model_version: string;
  quality_json: string;
  status: 'pending' | 'ready' | 'failed' | 'unusable';
  failure_code: string | null;
  created_at: string;
  updated_at: string;
};

export type ProposalRow = {
  id: string;
  business_id: string;
  source_event_id: string;
  source_event_type?: string | null;
  transcript_id: string | null;
  record_type: RecordType;
  state: ProposalState;
  schema_version: string;
  provider: string;
  model_version: string;
  fields_json: string;
  provenance_json: string;
  missing_fields_json: string;
  validation_issues_json: string;
  duplicate_candidates_json: string;
  ambiguity_note: string | null;
  version: number;
  assigned_to_user_id: string | null;
  decided_by_user_id: string | null;
  decided_at: string | null;
  rejection_reason_code: string | null;
  rejection_note: string | null;
  confirmed_ledger_record_id: string | null;
  created_at: string;
  updated_at: string;
};

/* ---------------------------------------------------------- source events */

export async function findSourceEventByDedupe(
  db: Db,
  integrationId: string | null,
  providerEventId: string,
): Promise<SourceEventRow | undefined> {
  if (!integrationId) {
    return await get<SourceEventRow>(db, 'SELECT * FROM source_events WHERE dedupe_key = ?', [
      `provider_event:${providerEventId}`,
    ]);
  }
  return await get<SourceEventRow>(
    db,
    'SELECT * FROM source_events WHERE integration_id = ? AND provider_event_id = ?',
    [integrationId, providerEventId],
  );
}

export async function insertSourceEvent(
  db: Db,
  input: {
    businessId: string;
    integrationId: string | null;
    providerEventId: string;
    eventType: string;
    senderRef: string | null;
    receivedAt: string;
    providerSentAt: string | null;
    dedupeKey: string;
    redactedPayload: Record<string, unknown> | null;
  },
): Promise<SourceEventRow> {
  const id = newId('src');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO source_events (
       id, business_id, integration_id, provider_event_id, event_type, sender_ref,
       received_at, provider_sent_at, dedupe_key, payload_redacted, status,
       processing_attempts, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)`,
    [
      id,
      input.businessId,
      input.integrationId,
      input.providerEventId,
      input.eventType,
      input.senderRef,
      input.receivedAt,
      input.providerSentAt,
      input.dedupeKey,
      input.redactedPayload === null ? null : toJson(input.redactedPayload),
      timestamp,
      timestamp,
    ],
  );
  return await get<SourceEventRow>(db, 'SELECT * FROM source_events WHERE id = ?', [id]) as SourceEventRow;
}

/** Tenant-scoped dedupe lookup, used by in-app capture where there is no integration. */
export async function findSourceEventByDedupeKey(
  db: Db,
  scope: TenantScope,
  dedupeKey: string,
): Promise<SourceEventRow | undefined> {
  return await get<SourceEventRow>(
    db,
    'SELECT * FROM source_events WHERE business_id = ? AND dedupe_key = ?',
    [scope.businessId, dedupeKey],
  );
}

export async function findSourceEventById(db: Db, scope: TenantScope, id: string): Promise<SourceEventRow | undefined> {
  return await get<SourceEventRow>(db, 'SELECT * FROM source_events WHERE id = ? AND business_id = ?', [
    id,
    scope.businessId,
  ]);
}

export async function updateSourceEventStatus(
  db: Db,
  sourceEventId: string,
  status: SourceEventStatus,
  failureCode?: string | null,
): Promise<void> {
  const timestamp = nowIso();
  if (status === 'processing') {
    await run(
      db,
      `UPDATE source_events
       SET status = ?, processing_attempts = processing_attempts + 1, failure_code = NULL, updated_at = ?
       WHERE id = ?`,
      [status, timestamp, sourceEventId],
    );
    return;
  }
  await run(
    db,
    'UPDATE source_events SET status = ?, failure_code = ?, updated_at = ? WHERE id = ?',
    [status, failureCode ?? null, timestamp, sourceEventId],
  );
}

export async function latestSourceEventAt(db: Db, scope: TenantScope): Promise<string | null> {
  const value = await scalar<string>(db, 'SELECT MAX(received_at) FROM source_events WHERE business_id = ?', [
    scope.businessId,
  ]);
  return value ?? null;
}

export async function countRecentSourceEvents(db: Db, scope: TenantScope, sinceIso: string): Promise<number> {
  return (
    await scalar<number>(
      db,
      `SELECT COUNT(*) FROM source_events WHERE business_id = ? AND received_at >= ? AND status IN ('received','processing')`,
      [scope.businessId, sinceIso],
    ) ?? 0
  );
}

/* ----------------------------------------------------------- media assets */

export async function insertMediaAsset(
  db: Db,
  input: {
    businessId: string;
    sourceEventId: string;
    objectKey: string;
    mediaType: string;
    byteSize: number;
    durationSeconds: number | null;
    checksum: string;
    retentionDeadline: string;
    encryptionMetadata?: Record<string, unknown>;
  },
): Promise<MediaAssetRow> {
  const id = newId('med');
  await run(
    db,
    `INSERT INTO media_assets (
       id, business_id, source_event_id, object_key, media_type, byte_size,
       duration_seconds, checksum, encryption_metadata, retention_deadline,
       deleted_at, access_classification, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'highly_sensitive', ?)`,
    [
      id,
      input.businessId,
      input.sourceEventId,
      input.objectKey,
      input.mediaType,
      input.byteSize,
      input.durationSeconds,
      input.checksum,
      toJson(input.encryptionMetadata ?? {}),
      input.retentionDeadline,
      nowIso(),
    ],
  );
  return await get<MediaAssetRow>(db, 'SELECT * FROM media_assets WHERE id = ?', [id]) as MediaAssetRow;
}

export async function findMediaAssetById(db: Db, scope: TenantScope, id: string): Promise<MediaAssetRow | undefined> {
  return await get<MediaAssetRow>(db, 'SELECT * FROM media_assets WHERE id = ? AND business_id = ?', [
    id,
    scope.businessId,
  ]);
}

export async function findMediaAssetBySourceEvent(
  db: Db,
  scope: TenantScope,
  sourceEventId: string,
): Promise<MediaAssetRow | undefined> {
  return await get<MediaAssetRow>(
    db,
    'SELECT * FROM media_assets WHERE business_id = ? AND source_event_id = ? LIMIT 1',
    [scope.businessId, sourceEventId],
  );
}

/** Expired media for one tenant only: a job never touches another business's files. */
export async function listExpiredMedia(
  db: Db,
  scope: TenantScope,
  nowIsoValue = nowIso(),
  limit = 50,
): Promise<MediaAssetRow[]> {
  return await all<MediaAssetRow>(
    db,
    `SELECT * FROM media_assets
     WHERE business_id = ? AND deleted_at IS NULL AND retention_deadline <= ?
     ORDER BY retention_deadline LIMIT ?`,
    [scope.businessId, nowIsoValue, limit],
  );
}

export async function markMediaDeleted(db: Db, mediaAssetId: string): Promise<void> {
  await run(db, 'UPDATE media_assets SET deleted_at = ? WHERE id = ?', [nowIso(), mediaAssetId]);
}

/* ------------------------------------------------------------ transcripts */

export async function findTranscriptBySourceEvent(
  db: Db,
  scope: TenantScope,
  sourceEventId: string,
): Promise<TranscriptRow | undefined> {
  return await get<TranscriptRow>(
    db,
    `SELECT * FROM transcripts WHERE business_id = ? AND source_event_id = ?
     ORDER BY (status = 'ready') DESC, created_at DESC LIMIT 1`,
    [scope.businessId, sourceEventId],
  );
}

export async function insertTranscript(
  db: Db,
  input: {
    businessId: string;
    sourceEventId: string;
    mediaAssetId: string | null;
    machineText: string;
    detectedLanguage: string;
    provider: string;
    modelVersion: string;
    quality: Record<string, unknown>;
  },
): Promise<TranscriptRow> {
  const id = newId('trs');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO transcripts (
       id, business_id, source_event_id, media_asset_id, machine_text, corrected_text,
       corrected_by_user_id, corrected_at, marked_unusable, detected_language,
       provider, model_version, quality_json, status, failure_code, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, ?, ?, 'ready', NULL, ?, ?)`,
    [
      id,
      input.businessId,
      input.sourceEventId,
      input.mediaAssetId,
      input.machineText,
      input.detectedLanguage,
      input.provider,
      input.modelVersion,
      toJson(input.quality),
      timestamp,
      timestamp,
    ],
  );
  return await get<TranscriptRow>(db, 'SELECT * FROM transcripts WHERE id = ?', [id]) as TranscriptRow;
}

export async function insertFailedTranscript(
  db: Db,
  input: { businessId: string; sourceEventId: string; failureCode: string },
): Promise<TranscriptRow> {
  const id = newId('trs');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO transcripts (
       id, business_id, source_event_id, media_asset_id, machine_text, detected_language,
       provider, model_version, quality_json, status, failure_code, created_at, updated_at
     ) VALUES (?, ?, ?, NULL, '', 'unknown', 'none', 'none', '{}', 'failed', ?, ?, ?)`,
    [id, input.businessId, input.sourceEventId, input.failureCode, timestamp, timestamp],
  );
  return await get<TranscriptRow>(db, 'SELECT * FROM transcripts WHERE id = ?', [id]) as TranscriptRow;
}

/**
 * Records a transcription failure once per source event. A job retry updates
 * the same row instead of appending a new failure, so the transcript history
 * stays one row per source event.
 */
export async function recordFailedTranscript(
  db: Db,
  input: { businessId: string; sourceEventId: string; failureCode: string },
): Promise<TranscriptRow> {
  const timestamp = nowIso();
  const existing = await get<TranscriptRow>(
    db,
    `SELECT * FROM transcripts
     WHERE business_id = ? AND source_event_id = ? AND status = 'failed'
     ORDER BY created_at DESC LIMIT 1`,
    [input.businessId, input.sourceEventId],
  );
  if (existing) {
    await run(db, 'UPDATE transcripts SET failure_code = ?, updated_at = ? WHERE id = ?', [
      input.failureCode,
      timestamp,
      existing.id,
    ]);
    return await get<TranscriptRow>(db, 'SELECT * FROM transcripts WHERE id = ?', [
      existing.id,
    ]) as TranscriptRow;
  }
  return await insertFailedTranscript(db, input);
}

export async function correctTranscript(
  db: Db,
  transcriptId: string,
  correctedText: string,
  correctedByUserId: string,
  markUnusable: boolean,
): Promise<void> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE transcripts
     SET corrected_text = ?, corrected_by_user_id = ?, corrected_at = ?,
         marked_unusable = ?, status = 'ready', failure_code = NULL, updated_at = ?
     WHERE id = ?`,
    [correctedText, correctedByUserId, timestamp, toSqlBool(markUnusable), timestamp, transcriptId],
  );
}

export function transcriptText(row: TranscriptRow): string {
  return row.corrected_text ?? row.machine_text;
}

export function transcriptQuality(row: TranscriptRow): Record<string, number | string | boolean> {
  return fromJson<Record<string, number | string | boolean>>(row.quality_json, {});
}

export function transcriptIsCorrected(row: TranscriptRow): boolean {
  return row.corrected_text !== null;
}

export function transcriptIsUnusable(row: TranscriptRow): boolean {
  return fromSqlBool(row.marked_unusable);
}

/* -------------------------------------------------------------- proposals */

export async function insertProposal(
  db: Db,
  input: {
    businessId: string;
    /** Null only for a manual entry typed by a human. */
    sourceEventId: string | null;
    transcriptId: string | null;
    recordType: RecordType;
    state: ProposalState;
    schemaVersion: string;
    provider: string;
    modelVersion: string;
    fields: ProposalFields;
    provenance: ProvenanceMap;
    missingFields: string[];
    validationIssues: ValidationIssue[];
    duplicateCandidates: DuplicateCandidate[];
    ambiguityNote?: string | null;
  },
): Promise<ProposalRow> {
  const id = newId('prp');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO proposals (
       id, business_id, source_event_id, transcript_id, record_type, state, schema_version,
       provider, model_version, fields_json, provenance_json, missing_fields_json,
       validation_issues_json, duplicate_candidates_json, ambiguity_note, min_confidence,
       version, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      input.businessId,
      input.sourceEventId,
      input.transcriptId,
      input.recordType,
      input.state,
      input.schemaVersion,
      input.provider,
      input.modelVersion,
      toJson(input.fields),
      toJson(input.provenance),
      toJson(input.missingFields),
      toJson(input.validationIssues),
      toJson(input.duplicateCandidates),
      input.ambiguityNote ?? null,
      lowestFieldConfidence(input.provenance),
      timestamp,
      timestamp,
    ],
  );
  return await findProposalById(db, { businessId: input.businessId }, id) as ProposalRow;
}

export async function findProposalById(
  db: Db,
  scope: TenantScope,
  proposalId: string,
): Promise<ProposalRow | undefined> {
  return await get<ProposalRow>(db, 'SELECT * FROM proposals WHERE id = ? AND business_id = ?', [
    proposalId,
    scope.businessId,
  ]);
}

export async function findProposalBySourceEvent(
  db: Db,
  scope: TenantScope,
  sourceEventId: string,
): Promise<ProposalRow | undefined> {
  return await get<ProposalRow>(
    db,
    'SELECT * FROM proposals WHERE business_id = ? AND source_event_id = ? LIMIT 1',
    [scope.businessId, sourceEventId],
  );
}

export type ProposalListFilters = {
  states: ProposalState[];
  recordType?: RecordType;
  sourceKind?: SourceKind;
  receivedFrom?: string;
  receivedTo?: string;
  confidenceBand?: 'low' | 'medium' | 'high';
  limit: number;
  cursor?: { createdAt: string; id: string } | null;
  order: 'oldest_first' | 'newest_first';
};

export async function listProposals(db: Db, scope: TenantScope, filters: ProposalListFilters): Promise<ProposalRow[]> {
  const where: string[] = ['p.business_id = ?'];
  const params: unknown[] = [scope.businessId];

  if (filters.states.length > 0) {
    where.push(`p.state IN (${filters.states.map(() => '?').join(', ')})`);
    params.push(...filters.states);
  }
  if (filters.recordType) {
    where.push('p.record_type = ?');
    params.push(filters.recordType);
  }
  if (filters.sourceKind) {
    // Event-backed kinds filter on the source event's type. A proposal with no
    // source event was typed by a human, so its origin comes from the adapter
    // that produced it instead of the source event table.
    if (SOURCE_EVENT_KINDS.includes(filters.sourceKind)) {
      where.push('s.event_type = ?');
      params.push(filters.sourceKind);
    } else {
      where.push('p.source_event_id IS NULL AND p.provider = ?');
      params.push(filters.sourceKind);
    }
  }
  if (filters.receivedFrom) {
    where.push('s.received_at >= ?');
    params.push(filters.receivedFrom);
  }
  if (filters.receivedTo) {
    where.push('s.received_at <= ?');
    params.push(`${filters.receivedTo}T23:59:59.999Z`);
  }
  if (filters.confidenceBand) {
    // The band is computed from the weakest extracted field so reviewers see the
    // least certain proposals first. Confidence is internal triage information;
    // the UI shows a "check details" cue instead of a false-precision score.
    const [lower, upper] =
      filters.confidenceBand === 'low'
        ? [0, 0.6]
        : filters.confidenceBand === 'medium'
          ? [0.6, 0.85]
          : [0.85, 1.01];
    where.push('p.min_confidence IS NOT NULL AND p.min_confidence >= ? AND p.min_confidence < ?');
    params.push(lower, upper);
  }
  if (filters.cursor) {
    const comparison = filters.order === 'oldest_first' ? '>' : '<';
    where.push(`(p.created_at ${comparison} ? OR (p.created_at = ? AND p.id ${comparison} ?))`);
    params.push(filters.cursor.createdAt, filters.cursor.createdAt, filters.cursor.id);
  }

  const direction = filters.order === 'oldest_first' ? 'ASC' : 'DESC';
  const sql = `
    SELECT p.*, s.event_type AS source_event_type FROM proposals p
    LEFT JOIN source_events s ON s.id = p.source_event_id
    WHERE ${where.join(' AND ')}
    ORDER BY p.created_at ${direction}, p.id ${direction}
    LIMIT ?`;
  params.push(filters.limit);
  return await all<ProposalRow>(db, sql, params);
}

export async function countProposalsByState(db: Db, scope: TenantScope): Promise<Record<string, number>> {
  const rows = await all<{ state: string; count: number }>(
    db,
    'SELECT state, COUNT(*) AS count FROM proposals WHERE business_id = ? GROUP BY state',
    [scope.businessId],
  );
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.state] = row.count;
  return counts;
}

export async function countOpenProposals(db: Db, scope: TenantScope, _nowIsoValue = nowIso()): Promise<number> {
  return (
    await scalar<number>(
      db,
      `SELECT COUNT(*) FROM proposals
       WHERE business_id = ? AND state IN ('needs_review', 'needs_details', 'duplicate')`,
      [scope.businessId],
    ) ?? 0
  );
}

export async function oldestOpenProposalAt(db: Db, scope: TenantScope): Promise<string | null> {
  const value = await scalar<string>(
    db,
    `SELECT MIN(created_at) FROM proposals
     WHERE business_id = ? AND state IN ('needs_review', 'needs_details', 'duplicate')`,
    [scope.businessId],
  );
  return value ?? null;
}

export async function updateProposalFields(
  db: Db,
  proposalId: string,
  fields: ProposalFields,
  provenance: ProvenanceMap,
  missingFields: string[],
  validationIssues: ValidationIssue[],
): Promise<number> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE proposals
     SET fields_json = ?, provenance_json = ?, missing_fields_json = ?, validation_issues_json = ?,
         min_confidence = ?, version = version + 1, updated_at = ?
     WHERE id = ?`,
    [
      toJson(fields),
      toJson(provenance),
      toJson(missingFields),
      toJson(validationIssues),
      lowestFieldConfidence(provenance),
      timestamp,
      proposalId,
    ],
  );
  const row = await get<{ version: number }>(db, 'SELECT version FROM proposals WHERE id = ?', [proposalId]);
  return row?.version ?? 1;
}

/**
 * Reclassifies a draft: sets the record type, recomputes its missing fields and
 * state, and bumps the version so a stale reviewer cannot overwrite it.
 */
export async function updateProposalDraft(
  db: Db,
  proposalId: string,
  input: { recordType: RecordType; state: ProposalState; missingFields: string[] },
): Promise<number> {
  const timestamp = nowIso();
  await run(
    db,
    `UPDATE proposals
     SET record_type = ?, state = ?, missing_fields_json = ?, validation_issues_json = '[]',
         version = version + 1, updated_at = ?
     WHERE id = ?`,
    [input.recordType, input.state, toJson(input.missingFields), timestamp, proposalId],
  );
  const row = await get<{ version: number }>(db, 'SELECT version FROM proposals WHERE id = ?', [proposalId]);
  return row?.version ?? 1;
}

/** Weakest extracted field confidence, used only for internal triage ordering. */
function lowestFieldConfidence(provenance: ProvenanceMap): number | null {
  const values = Object.values(provenance).map((field) => field.confidence);
  if (values.length === 0) return null;
  return Math.min(...values);
}

export async function setProposalState(
  db: Db,
  proposalId: string,
  state: ProposalState,
  extra: {
    decidedByUserId?: string | null;
    decidedAt?: string | null;
    rejectionReasonCode?: string | null;
    rejectionNote?: string | null;
    confirmedLedgerRecordId?: string | null;
    stateFilter?: { states: ProposalState[] };
  } = {},
): Promise<void> {
  await run(
    db,
    `UPDATE proposals
     SET state = ?, decided_by_user_id = COALESCE(?, decided_by_user_id),
         decided_at = COALESCE(?, decided_at),
         rejection_reason_code = ?, rejection_note = ?,
         confirmed_ledger_record_id = COALESCE(?, confirmed_ledger_record_id),
         updated_at = ?
     WHERE id = ?${extra.stateFilter ? ` AND state IN (${extra.stateFilter.states.map(() => '?').join(', ')})` : ''}`,
    [
      state,
      extra.decidedByUserId ?? null,
      extra.decidedAt ?? null,
      extra.rejectionReasonCode ?? null,
      extra.rejectionNote ?? null,
      extra.confirmedLedgerRecordId ?? null,
      nowIso(),
      proposalId,
      ...(extra.stateFilter?.states ?? []),
    ],
  );
}

export async function markProposalConfirmed(
  db: Db,
  proposalId: string,
  ledgerRecordId: string,
  decidedByUserId: string,
  expectedVersion: number,
): Promise<boolean> {
  const changes = await run(
    db,
    `UPDATE proposals
     SET state = 'confirmed', confirmed_ledger_record_id = ?, decided_by_user_id = ?,
         decided_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND version = ? AND state IN ('needs_review', 'needs_details', 'duplicate')`,
    [ledgerRecordId, decidedByUserId, nowIso(), nowIso(), proposalId, expectedVersion],
  );
  return changes === 1;
}

export function proposalFields(row: ProposalRow): ProposalFields {
  return fromJson<ProposalFields>(row.fields_json, {} as ProposalFields);
}

export function proposalProvenance(row: ProposalRow): ProvenanceMap {
  return fromJson<ProvenanceMap>(row.provenance_json, {});
}

export function proposalMissingFields(row: ProposalRow): string[] {
  return fromJson<string[]>(row.missing_fields_json, []);
}

export function proposalValidationIssues(row: ProposalRow): ValidationIssue[] {
  return fromJson<ValidationIssue[]>(row.validation_issues_json, []);
}

export function proposalDuplicateCandidates(row: ProposalRow): DuplicateCandidate[] {
  return fromJson<DuplicateCandidate[]>(row.duplicate_candidates_json, []);
}

export async function setProposalDuplicateCandidates(
  db: Db,
  proposalId: string,
  candidates: DuplicateCandidate[],
): Promise<void> {
  await run(db, 'UPDATE proposals SET duplicate_candidates_json = ?, updated_at = ? WHERE id = ?', [
    toJson(candidates),
    nowIso(),
    proposalId,
  ]);
}