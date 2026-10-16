/**
 * Source -> transcript -> proposal pipeline.
 *
 * This is the only place that turns merchant input into a proposal. It never
 * writes a ledger record: the pipeline's job ends at a reviewable proposal, and
 * a human decision (in `confirmation.ts`) is what posts to the ledger.
 *
 * The pipeline is idempotent per source event. Re-running it after a provider
 * failure must not create a second transcript or a second proposal.
 */

import { withTransaction, type Db } from '@/server/db/client';
import { nowIso } from '@/server/db/ids';
import {
  emptyProposalFields,
  missingRequiredFields,
  PROPOSAL_SCHEMA_VERSION,
  typedRecordSchema,
  type DuplicateCandidate,
  type ExtractionProposal,
  type FieldProvenance,
  type ProposalFields,
  type ProvenanceMap,
  type ValidationIssue,
} from '@/lib/validation/proposal';
import type { ProposalState, RecordType } from '@/server/domain/types';
import type { BusinessContext } from '@/server/business-context/context';
import { integrations } from '@/server/integrations';
import { ProviderError } from '@/server/integrations/speech/port';
import {
  findMediaAssetBySourceEvent,
  findProposalBySourceEvent,
  findSourceEventById,
  findTranscriptBySourceEvent,
  recordFailedTranscript,
  insertProposal,
  insertTranscript,
  transcriptText,
  updateSourceEventStatus,
  type MediaAssetRow,
  type ProposalRow,
  type SourceEventRow,
} from '@/server/repositories/source.repository';
import { findProbableDuplicates } from '@/server/repositories/ledger.repository';
import { listCustomers } from '@/server/repositories/debt.repository';
import { listItems } from '@/server/repositories/inventory.repository';
import { enqueueOutboxEvent } from '@/server/repositories/platform.repository';
import { recordAuditSafely } from './audit';
import { logger } from '@/server/observability/logger';
import { addDaysToDateStr } from '@/lib/formatting/datetime';

export type PipelineOutcome =
  | { kind: 'skipped'; reason: 'already_processed'; proposal: ProposalRow }
  | { kind: 'skipped'; reason: 'already_transcribed'; transcriptId: string }
  | { kind: 'proposal'; proposal: ProposalRow }
  | { kind: 'failed'; failureCode: string; retryable: boolean };

const RETENTION_DAYS = 30;

function retentionDeadline(now = nowIso()): string {
  const today = now.slice(0, 10);
  return `${addDaysToDateStr(today, RETENTION_DAYS)}T23:59:59.000Z`;
}

/** Maps the adapter's flat provenance map onto the reviewer's normalized fields. */
export function proposalFieldsFromProposal(
  proposal: ExtractionProposal,
  currency: ProposalFields['currency'],
): { fields: ProposalFields; provenance: ProvenanceMap } {
  const fields = emptyProposalFields(currency);
  const provenance: ProvenanceMap = {};
  const raw = proposal.fields as Record<string, FieldProvenance>;

  for (const [key, entry] of Object.entries(raw)) {
    provenance[key] = entry;
    switch (key) {
      case 'amountMinor': {
        const value = Number(entry.value);
        if (Number.isFinite(value)) fields.amountMinor = Math.round(value);
        break;
      }
      case 'occurredAt': {
        const value = String(entry.value);
        const parsed = Date.parse(value);
        if (!Number.isNaN(parsed)) fields.occurredAt = new Date(parsed).toISOString();
        const span = entry.sourceSpan.toLowerCase();
        fields.occurredAtBasis =
          span === 'leo' || span === 'today'
            ? 'today'
            : span === 'jana' || span === 'yesterday'
              ? 'yesterday'
              : /\d/.test(span)
                ? 'explicit'
                : 'assumed';
        break;
      }
      case 'customerName':
        fields.customerName = String(entry.value);
        break;
      case 'amountPaidMinor': {
        // Only the amount already received is carried over; anything else would
        // silently become deni.
        const value = Number(entry.value);
        if (Number.isFinite(value)) fields.amountPaidMinor = Math.max(0, Math.round(value));
        break;
      }
      case 'customerId':
        fields.customerId = String(entry.value);
        break;
      case 'customer':
        fields.customerName = String(entry.value);
        break;
      case 'paymentStatus':
        fields.paymentStatus = String(entry.value) as ProposalFields['paymentStatus'];
        break;
      case 'paymentMethod':
        fields.paymentMethod = String(entry.value) as ProposalFields['paymentMethod'];
        break;
      case 'itemsText':
        fields.itemsText = String(entry.value);
        break;
      case 'category':
        fields.category = String(entry.value);
        break;
      case 'payee':
        fields.payee = String(entry.value);
        break;
      case 'description':
        fields.description = String(entry.value);
        break;
      case 'note':
        fields.note = String(entry.value);
        break;
      case 'quantity': {
        const value = Number(entry.value);
        if (Number.isFinite(value)) fields.quantityMilli = Math.round(value);
        break;
      }
      case 'quantityMilli': {
        const value = Number(entry.value);
        if (Number.isFinite(value)) fields.quantityMilli = Math.round(value);
        break;
      }
      case 'unit':
        fields.unit = String(entry.value);
        break;
      case 'movementType':
        fields.movementType = String(entry.value) as ProposalFields['movementType'];
        break;
      case 'itemId':
        fields.itemId = String(entry.value);
        break;
      case 'itemName':
        fields.itemName = String(entry.value);
        break;
      case 'dueDate':
        fields.dueDate = String(entry.value);
        break;
      default:
        // Unknown keys stay in provenance for the reviewer instead of being
        // silently dropped.
        break;
    }
  }

  // Text mentions and the transcript itself are the safest description fallback.
  if (!fields.description && proposal.intent !== 'note') {
    fields.description = null;
  }

  return { fields, provenance };
}

/** Builds the typed payload used for schema validation only, never for writes. */
export function typedRecordForValidation(
  recordType: RecordType,
  fields: ProposalFields,
): Record<string, unknown> {
  const base = { currency: fields.currency, occurredAt: fields.occurredAt ?? '' };
  const customer = { customerId: fields.customerId, customerName: fields.customerName };
  switch (recordType) {
    case 'sale':
      return {
        type: 'sale',
        ...base,
        amountMinor: fields.amountMinor ?? 0,
        customer,
        itemsText: fields.itemsText,
        paymentStatus: fields.paymentStatus ?? 'unpaid',
        paymentMethod: fields.paymentMethod ?? undefined,
        // Partial payments cannot be validated without the amount already
        // received, so the payload must carry it through.
        amountPaidMinor: fields.amountPaidMinor,
        description: fields.description,
        category: fields.category,
      };
    case 'expense':
      return {
        type: 'expense',
        ...base,
        amountMinor: fields.amountMinor ?? 0,
        payee: fields.payee,
        category: fields.category ?? '',
        paymentStatus: fields.paymentStatus ?? undefined,
        paymentMethod: fields.paymentMethod ?? undefined,
        description: fields.description,
      };
    case 'debt_created':
      return {
        type: 'debt_created',
        ...base,
        amountMinor: fields.amountMinor ?? 0,
        customer,
        dueDate: fields.dueDate,
        description: fields.description,
      };
    case 'debt_payment':
      return {
        type: 'debt_payment',
        ...base,
        amountMinor: fields.amountMinor ?? 0,
        customer,
        paymentMethod: fields.paymentMethod ?? undefined,
        description: fields.description,
      };
    case 'stock_movement':
      return {
        type: 'stock_movement',
        occurredAt: fields.occurredAt ?? '',
        quantityMilli: fields.quantityMilli ?? 0,
        unit: fields.unit ?? '',
        movementType: fields.movementType ?? 'in',
        itemId: fields.itemId,
        itemName: fields.itemName,
        unitCostMinor: fields.unitCostMinor,
        note: fields.note,
      };
    default:
      return { type: 'note', occurredAt: fields.occurredAt ?? '', note: fields.note ?? '' };
  }
}

export function validationIssuesFor(
  recordType: RecordType,
  fields: ProposalFields,
): ValidationIssue[] {
  const result = typedRecordSchema.safeParse(typedRecordForValidation(recordType, fields));
  if (result.success) return [];
  return result.error.issues.slice(0, 12).map((issue) => ({
    field: issue.path.join('.') || 'record',
    code: issue.code,
    message: issue.message,
    severity: 'error' as const,
  }));
}

async function duplicateCandidatesFor(
  db: Db,
  context: BusinessContext,
  fields: ProposalFields,
): Promise<DuplicateCandidate[]> {
  const matches = await findProbableDuplicates(db, { businessId: context.businessId }, {
    amountMinor: fields.amountMinor,
    occurredAt: fields.occurredAt,
    description: fields.description,
  });
  return matches.map((match) => ({
    ledgerRecordId: match.id,
    recordType: match.record_type,
    occurredAt: match.occurred_at,
    amountMinor: match.amount_minor,
    currency: context.currency,
    description: match.description,
  }));
}

function decideState(input: {
  missing: string[];
  clarificationRequired: boolean;
  duplicateCount: number;
}): ProposalState {
  if (input.clarificationRequired || input.missing.length > 0) return 'needs_details';
  if (input.duplicateCount > 0) return 'duplicate';
  return 'needs_review';
}

async function transcribe(
  db: Db,
  context: BusinessContext,
  sourceEvent: SourceEventRow,
  media: MediaAssetRow | undefined,
): Promise<{ transcriptId: string; text: string; language: string } | { failure: ProviderError }> {
  const deps = integrations();

  // Text messages arrive with their transcript already stored: the
  // message body never lives in the redacted source event payload.
  const existing = await findTranscriptBySourceEvent(db, { businessId: context.businessId }, sourceEvent.id);
  if (existing && transcriptText(existing)) {
    return {
      transcriptId: existing.id,
      text: transcriptText(existing),
      language: existing.detected_language,
    };
  }

  if (!media) {
    const transcript = await insertTranscript(db, {
      businessId: context.businessId,
      sourceEventId: sourceEvent.id,
      mediaAssetId: null,
      machineText: '',
      detectedLanguage: 'unknown',
      provider: 'whatsapp-text',
      modelVersion: 'text-v1',
      quality: { confidence: 1, segmentCount: 1 },
    });
    return { transcriptId: transcript.id, text: '', language: 'unknown' };
  }

  // Reading the object first proves it is still reachable; the adapter
  // then produces the transcript from the same private key.
  await deps.storage.readObject(media.object_key);
  try {
    const result = await deps.speech.transcribe({
      businessId: context.businessId,
      objectKey: media.object_key,
      mediaType: media.media_type,
      byteSize: media.byte_size,
      timezone: context.timezone,
    });
    const transcript = await insertTranscript(db, {
      businessId: context.businessId,
      sourceEventId: sourceEvent.id,
      mediaAssetId: media.id,
      machineText: result.text,
      detectedLanguage: result.detectedLanguage,
      provider: result.provider,
      modelVersion: result.modelVersion,
      quality: result.quality,
    });
    return { transcriptId: transcript.id, text: result.text, language: result.detectedLanguage };
  } catch (error) {
    if (error instanceof ProviderError) return { failure: error };
    throw error;
  }
}

/**
 * Runs the pipeline for one source event.
 *
 * Provider failures are recorded on the source event and, when retryable, thrown
 * as a non-fatal result so the job runner can back off and retry.
 */
export async function processSourceEvent(
  db: Db,
  context: BusinessContext,
  sourceEventId: string,
): Promise<PipelineOutcome> {
  const scope = { businessId: context.businessId };
  const sourceEvent = await findSourceEventById(db, scope, sourceEventId);
  if (!sourceEvent) {
    return { kind: 'failed', failureCode: 'source_event_not_found', retryable: false };
  }

  const existingProposal = await findProposalBySourceEvent(db, scope, sourceEventId);
  if (existingProposal) {
    return { kind: 'skipped', reason: 'already_processed', proposal: existingProposal };
  }
  if (sourceEvent.status === 'processed') {
    return { kind: 'skipped', reason: 'already_transcribed', transcriptId: '' };
  }

  await updateSourceEventStatus(db, sourceEventId, 'processing');
  const media = await findMediaAssetBySourceEvent(db, scope, sourceEventId);

  const transcribed = await transcribe(db, context, sourceEvent, media);
  if ('failure' in transcribed) {
    await recordFailedTranscript(db, {
      businessId: context.businessId,
      sourceEventId,
      failureCode: transcribed.failure.code,
    });
    await updateSourceEventStatus(db, sourceEventId, 'failed', transcribed.failure.code);
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'transcript.failed',
      entityType: 'source_event',
      entityId: sourceEventId,
      actorType: 'system',
      source: 'worker',
      reasonCode: transcribed.failure.code,
    });
    return { kind: 'failed', failureCode: transcribed.failure.code, retryable: transcribed.failure.retryable };
  }

  const deps = integrations();
  const customerCandidates = (await listCustomers(db, scope)).map((customer) => ({
    id: customer.id,
    name: customer.display_name,
  }));
  const itemCandidates = (await listItems(db, scope)).map((item) => ({ id: item.id, name: item.name }));

  const extracted = await deps.extraction.extract({
    businessId: context.businessId,
    transcript: { text: transcribed.text, detectedLanguage: transcribed.language },
    business: {
      currency: context.currency,
      timezone: context.timezone,
      nowIso: nowIso(),
    },
    customers: customerCandidates,
    items: itemCandidates,
    inventoryEnabled: context.features.inventory,
  }).catch(async (error: unknown) => {
    // A managed model can fail after transcription succeeded. Record the failure
    // on the source event so it is not stuck in "processing", and let the job
    // runner decide whether to retry.
    if (error instanceof ProviderError) {
      await recordFailedTranscript(db, {
        businessId: context.businessId,
        sourceEventId,
        failureCode: error.code,
      });
      await updateSourceEventStatus(db, sourceEventId, 'failed', error.code);
      await recordAuditSafely(db, {
        businessId: context.businessId,
        action: 'source_event.processing_failed',
        entityType: 'source_event',
        entityId: sourceEventId,
        actorType: 'system',
        source: 'worker',
        reasonCode: error.code,
      });
    }
    throw error;
  });

  const recordType = extracted.intent as RecordType;
  const { fields, provenance } = proposalFieldsFromProposal(extracted, context.currency);
  if (fields.amountMinor !== null && fields.occurredAtBasis === 'assumed' && fields.occurredAt === null) {
    // Nothing else to infer from; leave it missing rather than inventing a date.
    fields.occurredAt = null;
  }

  const missing = Array.from(
    new Set([...extracted.missingFields, ...missingRequiredFields(recordType, fields)]),
  ).slice(0, 20);
  const issues = validationIssuesFor(recordType, fields);
  const duplicates = await duplicateCandidatesFor(db, context, fields);
  const state = decideState({
    missing,
    clarificationRequired: extracted.clarificationRequired === true,
    duplicateCount: duplicates.length,
  });

  const proposal = await withTransaction(async () => {
    const created = await insertProposal(db, {
      businessId: context.businessId,
      sourceEventId,
      transcriptId: transcribed.transcriptId,
      recordType,
      state,
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      provider: deps.extraction.name,
      modelVersion: extracted.modelVersion,
      fields,
      provenance,
      missingFields: missing,
      validationIssues: issues,
      duplicateCandidates: duplicates,
      ambiguityNote:
        extracted.ambiguities.map((entry) => entry.question).join(' ') ||
        (extracted.clarificationRequired ? 'This message describes more than one record.' : null),
    });
    await updateSourceEventStatus(db, sourceEventId, 'processed');
    await recordAuditSafely(db, {
      businessId: context.businessId,
      action: 'proposal.created',
      entityType: 'proposal',
      entityId: created.id,
      actorType: 'system',
      source: 'worker',
      after: { recordType, state, missingFields: missing, duplicateCount: duplicates.length },
    });
    await enqueueOutboxEvent(db, {
      businessId: context.businessId,
      topic: 'proposal.ready',
      entityType: 'proposal',
      entityId: created.id,
      payload: { recordType, state },
    });
    return created;
  }, db);

  logger.info('pipeline.proposal_created', {
    businessId: context.businessId,
    proposalId: proposal.id,
    recordType,
    state,
  });

  return { kind: 'proposal', proposal };
}

export { retentionDeadline };
