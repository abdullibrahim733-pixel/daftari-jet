/**
 * Proposal and typed record schemas (architecture.md section 6.4).
 *
 * Model output is untrusted: it is parsed against a strict versioned schema,
 * and anything that does not fit becomes a missing field or a clarification
 * rather than a guessed ledger entry.
 */

import { z } from 'zod';
import {
  MOVEMENT_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  RECORD_TYPES,
} from '@/server/domain/types';
import { SUPPORTED_CURRENCIES } from '@/lib/formatting/money';

export const PROPOSAL_SCHEMA_VERSION = 'proposal-v1';
export const CALCULATION_VERSION = 'cash-summary-v1';
export const DEBT_BALANCE_FORMULA_VERSION = 'debt-balance-v1';

const isoCurrency = z.enum(SUPPORTED_CURRENCIES);

/** Provenance wrapper returned by the extraction adapter for every field. */
export const fieldProvenanceSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  currency: isoCurrency.optional(),
  sourceSpan: z.string().max(240),
  confidence: z.number().min(0).max(1),
});

export const extractionProposalSchema = z.object({
  schemaVersion: z.literal(PROPOSAL_SCHEMA_VERSION),
  intent: z.enum(RECORD_TYPES),
  fields: z.record(z.string().min(1).max(40), fieldProvenanceSchema),
  missingFields: z.array(z.string().min(1).max(40)).max(20),
  ambiguities: z
    .array(
      z.object({
        field: z.string().min(1).max(40),
        question: z.string().min(1).max(240),
        options: z.array(z.string().min(1).max(60)).max(6).optional(),
      }),
    )
    .max(10),
  /** True when the message contains several events that cannot be split safely. */
  clarificationRequired: z.boolean().optional(),
  modelVersion: z.string().min(1).max(80),
});

export type ExtractionProposal = z.infer<typeof extractionProposalSchema>;
export type FieldProvenance = z.infer<typeof fieldProvenanceSchema>;
export type ProvenanceMap = Record<string, FieldProvenance>;

export type CustomerCandidate = {
  customerId: string;
  displayName: string;
  /** Similarity signal for the reviewer, never an automatic merge. */
  score: number;
};

export type DuplicateCandidate = {
  ledgerRecordId: string;
  recordType: string;
  occurredAt: string;
  amountMinor: number | null;
  currency: string;
  description: string | null;
};

/** Normalized proposal values, editable by the reviewer before confirmation. */
export type ProposalFields = {
  amountMinor: number | null;
  currency: (typeof SUPPORTED_CURRENCIES)[number];
  occurredAt: string | null;
  occurredAtBasis: 'explicit' | 'today' | 'yesterday' | 'assumed';
  customerId: string | null;
  customerName: string | null;
  customerCandidates: CustomerCandidate[];
  itemsText: string | null;
  paymentStatus: (typeof PAYMENT_STATUSES)[number] | null;
  paymentMethod: (typeof PAYMENT_METHODS)[number] | null;
  /** Required by a reviewer when paymentStatus is "partial": already received. */
  amountPaidMinor: number | null;
  description: string | null;
  category: string | null;
  payee: string | null;
  dueDate: string | null;
  relatedRecordId: string | null;
  itemId: string | null;
  itemName: string | null;
  quantityMilli: number | null;
  unit: string | null;
  movementType: (typeof MOVEMENT_TYPES)[number] | null;
  unitCostMinor: number | null;
  note: string | null;
};

export function emptyProposalFields(currency: ProposalFields['currency']): ProposalFields {
  return {
    amountMinor: null,
    currency,
    occurredAt: null,
    occurredAtBasis: 'assumed',
    customerId: null,
    customerName: null,
    customerCandidates: [],
    itemsText: null,
    paymentStatus: null,
    paymentMethod: null,
    amountPaidMinor: null,
    description: null,
    category: null,
    payee: null,
    dueDate: null,
    relatedRecordId: null,
    itemId: null,
    itemName: null,
    quantityMilli: null,
    unit: null,
    movementType: null,
    unitCostMinor: null,
    note: null,
  };
}

export type ValidationIssue = {
  field: string;
  code: string;
  message: string;
  severity: 'error' | 'warning';
};

const amountMinorSchema = z.number().int().positive().max(1_000_000_000_00);
/**
 * Free text that may be absent, empty or null.
 *
 * `.optional()` matters: without it a payload that simply omits the key fails
 * with "expected string, received undefined" instead of being accepted, which
 * silently made whole record types impossible to confirm.
 */
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/** Offset-bearing ISO timestamp, e.g. 2026-10-04T15:10:00+03:00 or ...Z. */
const isoTimestampSchema = z
  .string()
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value), {
    message: 'Expected an ISO-8601 timestamp with a UTC offset',
  })
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Invalid timestamp' });

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a calendar date as YYYY-MM-DD');

const customerRefSchema = z.object({
  customerId: z.string().min(1).nullable().optional(),
  customerName: optionalText(120),
});

export const saleRecordSchema = z.object({
  type: z.literal('sale'),
  amountMinor: amountMinorSchema,
  currency: isoCurrency,
  occurredAt: isoTimestampSchema,
  customer: customerRefSchema.optional(),
  itemsText: optionalText(240),
  paymentStatus: z.enum(PAYMENT_STATUSES),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  amountPaidMinor: amountMinorSchema.nullable().optional(),
  description: optionalText(240),
  category: optionalText(60),
});

/**
 * A partial payment is only meaningful with the amount already received, so the
 * reviewer has to supply it instead of the system inferring it.
 */
export const partialSaleSchema = saleRecordSchema.superRefine((value, ctx) => {
  if (value.paymentStatus !== 'partial') return;
  if (value.amountPaidMinor === null || value.amountPaidMinor === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['amountPaidMinor'],
      message: 'Enter how much was already received',
    });
    return;
  }
  if (value.amountPaidMinor >= value.amountMinor) {
    ctx.addIssue({
      code: 'custom',
      path: ['amountPaidMinor'],
      message: 'A partial payment must be less than the total',
    });
  }
});

export const expenseRecordSchema = z.object({
  type: z.literal('expense'),
  amountMinor: amountMinorSchema,
  currency: isoCurrency,
  occurredAt: isoTimestampSchema,
  payee: optionalText(120),
  category: z.string().trim().min(1).max(60),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  description: optionalText(240),
});

export const debtCreatedRecordSchema = z.object({
  type: z.literal('debt_created'),
  amountMinor: amountMinorSchema,
  currency: isoCurrency,
  occurredAt: isoTimestampSchema,
  customer: customerRefSchema.refine(
    (value) => Boolean(value.customerId) || Boolean(value.customerName),
    'A customer is required',
  ),
  dueDate: isoDateSchema.nullable().optional(),
  relatedRecordId: z.string().min(1).nullable().optional(),
  description: optionalText(240),
});

export const debtPaymentRecordSchema = z.object({
  type: z.literal('debt_payment'),
  amountMinor: amountMinorSchema,
  currency: isoCurrency,
  occurredAt: isoTimestampSchema,
  customer: customerRefSchema.refine(
    (value) => Boolean(value.customerId) || Boolean(value.customerName),
    'A customer is required',
  ),
  paymentMethod: z.enum(PAYMENT_METHODS).optional(),
  reference: optionalText(120),
  relatedRecordId: z.string().min(1).nullable().optional(),
  description: optionalText(240),
});

export const stockMovementRecordSchema = z.object({
  type: z.literal('stock_movement'),
  quantityMilli: z.number().int().positive().max(1_000_000_000),
  unit: z.string().trim().min(1).max(24),
  movementType: z.enum(MOVEMENT_TYPES),
  itemId: z.string().min(1).nullable().optional(),
  itemName: z.string().trim().min(1).max(120).nullable().optional(),
  unitCostMinor: z.number().int().nonnegative().max(1_000_000_000_00).nullable().optional(),
  occurredAt: isoTimestampSchema,
  note: optionalText(240),
});

export const noteRecordSchema = z.object({
  type: z.literal('note'),
  note: z.string().trim().min(1).max(2_000),
  occurredAt: isoTimestampSchema,
});

export const typedRecordSchema = z.discriminatedUnion('type', [
  saleRecordSchema,
  expenseRecordSchema,
  debtCreatedRecordSchema,
  debtPaymentRecordSchema,
  stockMovementRecordSchema,
  noteRecordSchema,
]);

export type SaleRecordInput = z.infer<typeof saleRecordSchema>;
export type ExpenseRecordInput = z.infer<typeof expenseRecordSchema>;
export type DebtCreatedRecordInput = z.infer<typeof debtCreatedRecordSchema>;
export type DebtPaymentRecordInput = z.infer<typeof debtPaymentRecordSchema>;
export type StockMovementRecordInput = z.infer<typeof stockMovementRecordSchema>;
export type NoteRecordInput = z.infer<typeof noteRecordSchema>;
export type TypedRecordInput = z.infer<typeof typedRecordSchema>;

/** Required fields per record type, used to route proposals to "missing details". */
export const REQUIRED_FIELDS_BY_TYPE: Record<string, string[]> = {
  sale: ['amountMinor', 'occurredAt', 'paymentStatus'],
  expense: ['amountMinor', 'occurredAt', 'category'],
  debt_created: ['amountMinor', 'occurredAt', 'customer'],
  debt_payment: ['amountMinor', 'occurredAt', 'customer'],
  stock_movement: ['item', 'quantity', 'unit', 'movementType'],
  note: ['note'],
};

export function missingRequiredFields(recordType: string, fields: ProposalFields): string[] {
  const required = REQUIRED_FIELDS_BY_TYPE[recordType] ?? [];
  const present: Record<string, boolean> = {
    amountMinor: fields.amountMinor !== null && fields.amountMinor > 0,
    occurredAt: fields.occurredAt !== null,
    paymentStatus: fields.paymentStatus !== null,
    category: Boolean(fields.category && fields.category.trim().length > 0),
    customer: Boolean(fields.customerId || (fields.customerName && fields.customerName.trim().length > 0)),
    item: Boolean(fields.itemId || (fields.itemName && fields.itemName.trim().length > 0)),
    quantity: fields.quantityMilli !== null && fields.quantityMilli > 0,
    unit: Boolean(fields.unit && fields.unit.trim().length > 0),
    movementType: fields.movementType !== null,
    note: Boolean(fields.note && fields.note.trim().length > 0),
  };
  if (recordType === 'sale' && fields.paymentStatus === 'partial') {
    present.amountPaidMinor =
      fields.amountPaidMinor !== null &&
      fields.amountPaidMinor > 0 &&
      fields.amountMinor !== null &&
      fields.amountPaidMinor < fields.amountMinor;
  }
  const missing = required.filter((field) => !present[field]);
  // `amountPaidMinor` is only required for a part payment, so it cannot live
  // in the static required list without flagging every fully paid sale.
  if (recordType === 'sale' && fields.paymentStatus === 'partial' && !present.amountPaidMinor) {
    missing.push('amountPaidMinor');
  }
  return missing;
};