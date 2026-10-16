/**
 * Structured extraction port.
 *
 * The adapter returns a versioned proposal with field-level provenance. It must
 * never post to a ledger: values without evidence are returned as missing or
 * ambiguous so the review queue asks a focused question instead.
 */

import type { ExtractionProposal } from '@/lib/validation/proposal';

export type ExtractionCandidate = {
  id: string;
  name: string;
};

export type ExtractionRequest = {
  businessId: string;
  transcript: {
    text: string;
    detectedLanguage: string;
  };
  business: {
    currency: string;
    timezone: string;
    /** Instant used to resolve relative words such as "leo" or "yesterday". */
    nowIso: string;
  };
  customers: ExtractionCandidate[];
  items: ExtractionCandidate[];
  /** Set when inventory is not configured for the business. */
  inventoryEnabled: boolean;
};

export interface ExtractionAdapter {
  readonly name: string;
  readonly modelVersion: string;
  extract(request: ExtractionRequest): Promise<ExtractionProposal>;
}