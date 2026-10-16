/**
 * Manual-draft extraction.
 *
 * Used when structured extraction is switched off (`DAFTARI_EXTRACTION_PROVIDER=off`).
 * It never guesses: the transcript is kept as a note, `recordType` is reported as
 * missing, and the proposal is routed to "needs details" so a human classifies
 * the recording and fills the fields before anything reaches the ledger.
 *
 * This keeps the provider seam intact (`ExtractionAdapter`) instead of making the
 * pipeline branch on an environment flag.
 */

import {
  PROPOSAL_SCHEMA_VERSION,
  type ExtractionProposal,
  type FieldProvenance,
} from '@/lib/validation/proposal';
import type { ExtractionAdapter, ExtractionRequest } from './port';

/** Stable provider name so the reviewer can tell a draft from a model proposal. */
export const MANUAL_DRAFT_PROVIDER = 'manual-draft';

export const manualDraftExtractionAdapter: ExtractionAdapter = {
  name: MANUAL_DRAFT_PROVIDER,
  modelVersion: 'capture-v1',

  async extract(request: ExtractionRequest): Promise<ExtractionProposal> {
    const text = request.transcript.text.trim();
    const fields: Record<string, FieldProvenance> = {};
    if (text.length > 0) {
      fields.note = { value: text, sourceSpan: 'transcript', confidence: 0 };
    }

    return {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      intent: 'note',
      fields,
      // Reported as missing so the proposal always lands in "needs details".
      missingFields: ['recordType'],
      ambiguities: [
        {
          field: 'recordType',
          question:
            'Choose what this recording is (a sale, an expense, a debt, a stock movement or a note) and fill in the details.',
        },
      ],
      clarificationRequired: false,
      modelVersion: this.modelVersion,
    };
  },
};
