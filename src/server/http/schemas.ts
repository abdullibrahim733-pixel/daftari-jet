/**
 * Common input schemas for API routes.
 *
 * Route handlers validate at the edge, so services receive typed values and
 * never a raw unknown body.
 */

import { z } from 'zod';
import {
  MOVEMENT_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  RECORD_TYPES,
} from '@/server/domain/types';

export const isoDateSchema = z.iso.date();
export const isoTimestampSchema = z.iso.datetime();
export const idSchema = z.string().trim().min(1).max(80);

export const recordTypeSchema = z.enum(RECORD_TYPES);
export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export const movementTypeSchema = z.enum(MOVEMENT_TYPES);

export const languageSchema = z.enum(['en', 'sw']);
export const sourceKindSchema = z.enum(['whatsapp', 'manual', 'import']);
export const confidenceBandSchema = z.enum(['low', 'medium', 'high']);
export const sortOrderSchema = z.enum(['oldest_first', 'newest_first']);

export const confirmBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  note: z.string().trim().max(500).nullish(),
  /** Reviewer corrections, applied inside the confirmation transaction. */
  fields: z
    .object({
      amountMinor: z.number().int().positive().nullish(),
      amountPaidMinor: z.number().int().nonnegative().nullish(),
      occurredAt: isoTimestampSchema.nullish(),
      description: z.string().trim().max(240).nullish(),
      customerId: idSchema.nullish(),
      customerName: z.string().trim().max(160).nullish(),
      paymentStatus: paymentStatusSchema.nullish(),
      paymentMethod: paymentMethodSchema.nullish(),
      category: z.string().trim().max(60).nullish(),
      payee: z.string().trim().max(160).nullish(),
      dueDate: isoDateSchema.nullish(),
      itemsText: z.string().trim().max(240).nullish(),
      itemId: idSchema.nullish(),
      itemName: z.string().trim().max(160).nullish(),
      quantityMilli: z.number().int().positive().nullish(),
      unit: z.string().trim().max(40).nullish(),
      movementType: movementTypeSchema.nullish(),
      note: z.string().trim().max(500).nullish(),
    })
    .partial(),
});

export const retypeBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  recordType: recordTypeSchema,
});

export const rejectBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  reasonCode: z.string().trim().min(1).max(60),
  note: z.string().trim().max(500).nullish(),
});

export const manualRecordBodySchema = z.object({
  recordType: recordTypeSchema,
  amountMinor: z.number().int().positive().nullish(),
  occurredAt: isoTimestampSchema,
  description: z.string().trim().max(240).nullish(),
  customerId: idSchema.nullish(),
  customerName: z.string().trim().max(160).nullish(),
  paymentStatus: paymentStatusSchema.nullish(),
  paymentMethod: paymentMethodSchema.nullish(),
  amountPaidMinor: z.number().int().nonnegative().nullish(),
  category: z.string().trim().max(60).nullish(),
  payee: z.string().trim().max(160).nullish(),
  dueDate: isoDateSchema.nullish(),
  itemsText: z.string().trim().max(240).nullish(),
  itemId: idSchema.nullish(),
  itemName: z.string().trim().max(160).nullish(),
  quantityMilli: z.number().int().positive().nullish(),
  unit: z.string().trim().max(40).nullish(),
  movementType: movementTypeSchema.nullish(),
  note: z.string().trim().max(500).nullish(),
});

export const switchBusinessBodySchema = z.object({
  businessId: idSchema,
});

export const debtPaymentBodySchema = z.object({
  customerId: idSchema,
  amountMinor: z.number().int().positive(),
  method: paymentMethodSchema.default('cash'),
  receivedAt: isoTimestampSchema,
  reference: z.string().trim().max(120).nullish(),
});

export const exportBodySchema = z.object({
  fromDate: isoDateSchema,
  toDate: isoDateSchema,
  recordTypes: z.array(recordTypeSchema).min(1),
  format: z.enum(['csv', 'xlsx']),
});

export const inventoryItemBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  unit: z.string().trim().min(1).max(40),
  sku: z.string().trim().max(80).nullish(),
  lowStockThresholdMilli: z.number().int().nonnegative().nullish(),
});

export const inventoryItemUpdateBodySchema = z
  .object({
    lowStockThresholdMilli: z.number().int().nonnegative().nullish(),
    active: z.boolean().nullish(),
  })
  .partial();

export const reportRangeQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  granularity: z.enum(['day', 'week', 'month']).optional(),
});

export const devSimulateBodySchema = z.object({
  transcript: z.string().trim().min(1).max(500),
  language: languageSchema.default('sw'),
  senderRef: z.string().trim().min(3).max(40).default('+255711111111'),
  senderName: z.string().trim().max(80).optional(),
  kind: z.enum(['voice', 'text']).default('voice'),
  scriptedFailure: z
    .enum(['unsupported_media', 'no_speech', 'provider_outage', 'too_long'])
    .optional(),
});
