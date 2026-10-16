/**
 * OpenAI structured-extraction adapter.
 *
 * The model turns a transcript into a versioned proposal with field-level
 * provenance. It never posts to a ledger: the response is parsed against the
 * shared schema and anything that does not fit becomes a missing field or a
 * clarification rather than a guessed entry.
 *
 * The prompt is deliberately strict about units: money is returned in minor
 * units (TZS shillings x100) and dates as offset-bearing ISO timestamps, so the
 * pipeline's normalization never has to guess.
 */

import {
  PROPOSAL_SCHEMA_VERSION,
  extractionProposalSchema,
  type ExtractionProposal,
  type FieldProvenance,
} from '@/lib/validation/proposal';
import { MOVEMENT_TYPES, PAYMENT_METHODS, PAYMENT_STATUSES, RECORD_TYPES } from '@/server/domain/types';
import { SUPPORTED_CURRENCIES } from '@/lib/formatting/money';
import type { OpenAiConfig } from '@/server/config/env';
import { ProviderError } from '../provider-error';
import type { ExtractionAdapter } from './port';

const TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const FIELDS_BY_INTENT: Record<string, string[]> = {
  sale: ['amountMinor', 'occurredAt', 'customerName', 'customerId', 'itemsText', 'paymentStatus', 'paymentMethod', 'amountPaidMinor', 'category', 'description'],
  expense: ['amountMinor', 'occurredAt', 'payee', 'category', 'paymentStatus', 'paymentMethod', 'description'],
  debt_created: ['amountMinor', 'occurredAt', 'customerName', 'customerId', 'dueDate', 'description'],
  debt_payment: ['amountMinor', 'occurredAt', 'customerName', 'customerId', 'paymentMethod', 'description'],
  stock_movement: ['quantityMilli', 'unit', 'movementType', 'itemId', 'itemName', 'unitCostMinor', 'occurredAt', 'note'],
  note: ['note', 'occurredAt'],
};

interface RawField {
  value?: unknown;
  sourceSpan?: unknown;
  confidence?: unknown;
}

function clamp01(value: unknown): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function sanitizeFields(input: unknown): Record<string, FieldProvenance> {
  if (typeof input !== 'object' || input === null) return {};
  const fields: Record<string, FieldProvenance> = {};
  for (const [key, raw] of Object.entries(input as Record<string, RawField>)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw.value;
    if (!(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)) {
      continue;
    }
    const entry: FieldProvenance = {
      value,
      sourceSpan: typeof raw.sourceSpan === 'string' ? raw.sourceSpan.slice(0, 240) : '',
      confidence: clamp01(raw.confidence),
    };
    fields[key.slice(0, 40)] = entry;
  }
  return fields;
}

function sanitizeList(input: unknown, limit: number, maxLength: number): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.slice(0, maxLength))
    .slice(0, limit);
}

function sanitizeAmbiguities(input: unknown): ExtractionProposal['ambiguities'] {
  if (!Array.isArray(input)) return [];
  const ambiguities: ExtractionProposal['ambiguities'] = [];
  for (const raw of input.slice(0, 10)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const field = typeof record.field === 'string' ? record.field.slice(0, 40) : '';
    const question = typeof record.question === 'string' ? record.question.slice(0, 240) : '';
    if (!field || !question) continue;
    const options = Array.isArray(record.options)
      ? record.options
          .filter((option): option is string => typeof option === 'string' && option.trim().length > 0)
          .map((option) => option.slice(0, 60))
          .slice(0, 6)
      : undefined;
    ambiguities.push({ field, question, ...(options && options.length > 0 ? { options } : {}) });
  }
  return ambiguities;
}

function buildSystemPrompt(): string {
  const fieldGuide = RECORD_TYPES.map(
    (intent) => `  - ${intent}: ${FIELDS_BY_INTENT[intent]?.join(', ') ?? ''}`,
  ).join('\n');
  return [
    "You convert a Tanzanian shopkeeper's spoken message (Swahili or English) into ONE structured bookkeeping proposal.",
    'Return ONLY a JSON object, never prose.',
    '',
    'JSON shape:',
    '{',
    '  "intent": one of ' + JSON.stringify(RECORD_TYPES) + ',',
    '  "fields": { "<fieldName>": { "value": string|number|boolean|null, "sourceSpan": "<literal words>", "confidence": 0..1 } },',
    '  "missingFields": string[],',
    '  "ambiguities": [ { "field": string, "question": string, "options": string[] } ],',
    '  "clarificationRequired": boolean',
    '}',
    '',
    'Fields to use per intent:',
    fieldGuide,
    '',
    'Rules:',
    '- Never invent a value. If a required value is not clearly stated, omit the field and list its name in missingFields.',
    `- Money is an integer in minor units: amountMinor = shillings x100 (currency ${SUPPORTED_CURRENCIES.join('/')}, 2 decimals).`,
    '- occurredAt is an ISO-8601 timestamp with the local UTC offset, resolved from the current time and timezone given.',
    '- dueDate is a calendar date as YYYY-MM-DD.',
    '- sourceSpan is the exact substring that produced the value, in its original language.',
    `- paymentStatus: ${JSON.stringify(PAYMENT_STATUSES)}. Set it only when the merchant states it; a spoken "already paid" claim means paid.`,
    `- paymentMethod: ${JSON.stringify(PAYMENT_METHODS)}.`,
    `- movementType: ${JSON.stringify(MOVEMENT_TYPES)}. Use stock_movement only when inventory is enabled.`,
    '- customerId/itemId: set ONLY when the message clearly matches one of the provided candidates; otherwise set customerName/itemName as text.',
    '- If the message describes more than one record, set clarificationRequired true and add an ambiguity. Do not guess.',
    '- If nothing fits, use intent "note" and put the message in the note field.',
  ].join('\n');
}

export function createOpenAiExtractionAdapter(deps: {
  config: OpenAiConfig;
  fetchImpl?: typeof fetch;
}): ExtractionAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;

  return {
    name: 'openai-extraction',
    modelVersion: deps.config.extractionModel,

    async extract(request): Promise<ExtractionProposal> {
      const context = {
        currency: request.business.currency,
        timezone: request.business.timezone,
        nowIso: request.business.nowIso,
        inventoryEnabled: request.inventoryEnabled,
        customers: request.customers,
        items: request.items,
        languageHint: request.transcript.detectedLanguage,
        transcript: request.transcript.text,
      };

      let response: Response;
      try {
        response = await fetchImpl(`${deps.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deps.config.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model: deps.config.extractionModel,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: buildSystemPrompt() },
              { role: 'user', content: JSON.stringify(context) },
            ],
          }),
        });
      } catch (error) {
        throw new ProviderError('extraction_unavailable', String(error), true);
      }

      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderError('extraction_auth_failed', `OpenAI rejected the credentials: ${detail}`, false);
        }
        throw new ProviderError(
          'extraction_unavailable',
          `OpenAI responded ${response.status}: ${detail}`,
          TRANSIENT_STATUSES.has(response.status),
        );
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        throw new ProviderError('extraction_empty', 'OpenAI returned no content', true);
      }

      let decoded: Record<string, unknown>;
      try {
        decoded = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new ProviderError('extraction_invalid', 'OpenAI returned malformed JSON', false);
      }

      const candidate = {
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        intent: typeof decoded.intent === 'string' ? decoded.intent : 'note',
        fields: sanitizeFields(decoded.fields),
        missingFields: sanitizeList(decoded.missingFields, 20, 40),
        ambiguities: sanitizeAmbiguities(decoded.ambiguities),
        clarificationRequired: decoded.clarificationRequired === true,
        modelVersion: deps.config.extractionModel,
      };

      const parsed = extractionProposalSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new ProviderError(
          'extraction_invalid',
          `OpenAI output failed validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
          false,
        );
      }
      return parsed.data;
    },
  };
}
