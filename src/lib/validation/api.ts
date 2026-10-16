/**
 * Request schemas for the versioned JSON API (architecture.md section 5).
 * Everything crossing the network boundary is parsed here before it reaches a
 * domain service.
 */

import { z } from 'zod';
import { PROPOSAL_STATES, RECORD_TYPES, REJECTION_REASON_CODES, SOURCE_KINDS } from '@/server/domain/types';
import { typedRecordSchema } from './proposal';

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency key contains unsupported characters');

export const calendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const paginationSchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const proposalListQuerySchema = paginationSchema.extend({
  state: z.enum([...PROPOSAL_STATES, 'open', 'decided']).default('open'),
  recordType: z.enum(RECORD_TYPES).optional(),
  source: z.enum(SOURCE_KINDS).optional(),
  receivedFrom: calendarDateSchema.optional(),
  receivedTo: calendarDateSchema.optional(),
  confidenceBand: z.enum(['low', 'medium', 'high']).optional(),
});

export const confirmProposalBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  record: typedRecordSchema,
  confirm: z.literal(true),
});

export const rejectProposalBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: z.enum(REJECTION_REASON_CODES),
  note: z.string().trim().max(500).optional(),
});

export const retryProposalBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
});

export const correctTranscriptBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  correctedText: z.string().trim().min(1).max(4_000),
  markUnusable: z.boolean().optional(),
});

export const recordListQuerySchema = paginationSchema.extend({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  type: z.enum(RECORD_TYPES).optional(),
  status: z.enum(['posted', 'voided', 'reversed']).optional(),
  source: z.enum(['whatsapp', 'manual', 'import']).optional(),
  paymentStatus: z.string().max(20).optional(),
  customerId: z.string().min(1).max(64).optional(),
  search: z.string().trim().max(120).optional(),
});

export const ledgerCorrectionBodySchema = z.object({
  expectedVersion: z.number().int().positive(),
  reasonCode: z.string().trim().min(1).max(40),
  reasonNote: z.string().trim().max(500).optional(),
  changes: z
    .object({
      amountMinor: z.number().int().positive().max(1_000_000_000_00).optional(),
      occurredAt: z.string().max(40).optional(),
      description: z.string().trim().max(240).nullable().optional(),
      customerId: z.string().min(1).max(64).nullable().optional(),
      category: z.string().trim().max(60).nullable().optional(),
      paymentStatus: z.string().trim().max(20).optional(),
      paymentMethod: z.string().trim().max(24).optional(),
      payee: z.string().trim().max(120).nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'No changes supplied'),
  mode: z.enum(['correct', 'void', 'reverse']).default('correct'),
});

export const manualRecordBodySchema = z.object({
  record: typedRecordSchema,
});

export const debtPaymentBodySchema = z.object({
  customerId: z.string().min(1).max(64).nullable().optional(),
  amountMinor: z.number().int().positive().max(1_000_000_000_00),
  method: z.string().trim().min(1).max(24),
  reference: z.string().trim().max(120).optional(),
  obligationId: z.string().min(1).max(64).nullable().optional(),
  occurredAt: z.string().max(40).optional(),
});

export const summaryQuerySchema = z.object({
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
  granularity: z.enum(['day', 'week', 'month']).default('day'),
});

export const exportRequestBodySchema = z.object({
  from: calendarDateSchema,
  to: calendarDateSchema,
  recordTypes: z.array(z.enum(RECORD_TYPES)).min(1).max(10),
  format: z.literal('csv').default('csv'),
});

export const businessCreateBodySchema = z.object({
  name: z.string().trim().min(2).max(120),
  businessType: z.string().trim().min(1).max(60),
  location: z.string().trim().max(120).optional(),
  timezone: z.string().trim().min(1).max(64).default('Africa/Dar_es_Salaam'),
  currency: z.enum(['TZS']).default('TZS'),
  locale: z.enum(['en', 'sw']).default('en'),
});

export const businessUpdateBodySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  businessType: z.string().trim().min(1).max(60).optional(),
  location: z.string().trim().max(120).nullable().optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  currency: z.enum(['TZS']).optional(),
  locale: z.enum(['en', 'sw']).optional(),
  features: z
    .object({
      inventory: z.boolean().optional(),
      manualEntries: z.boolean().optional(),
      deni: z.boolean().optional(),
      exports: z.boolean().optional(),
    })
    .optional(),
  retentionAudioDays: z.number().int().min(1).max(365).optional(),
  analyticsOptIn: z.boolean().optional(),
});

export const inviteMemberBodySchema = z.object({
  userId: z.string().min(1).max(64),
  role: z.enum(['owner', 'manager', 'staff']),
});

export const updateMemberRoleBodySchema = z.object({
  role: z.enum(['owner', 'manager', 'staff']),
});

export const consentBodySchema = z.object({
  consentGiven: z.boolean(),
});

export const devLoginBodySchema = z.object({
  userId: z.string().min(1).max(64),
});

export const activeBusinessBodySchema = z.object({
  businessId: z.string().min(1).max(64),
});

export const notificationPreferencesBodySchema = z.object({
  newProposals: z.boolean(),
  dailySummary: z.boolean(),
});

export const privacyRequestBodySchema = z.object({
  kind: z.enum(['export', 'deletion']),
});

/** Opaque cursor: base64 of the sort key plus a stable tiebreaker. */
export function encodeCursor(parts: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): Record<string, string | number> | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string | number>;
    }
    return null;
  } catch {
    return null;
  }
}