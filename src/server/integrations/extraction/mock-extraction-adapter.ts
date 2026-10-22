/**
 * Deterministic extraction adapter for local development.
 *
 * It implements a small, explicit rule set over Swahili and English business
 * phrases so the whole source -> transcript -> proposal -> confirm flow works
 * offline. It deliberately refuses to guess:
 *
 *  - several amounts or several intents in one message produce a clarification
 *    proposal instead of several guessed entries;
 *  - a missing amount, customer or date becomes a missing field;
 *  - "paid" is only set when the merchant actually said it, because a spoken
 *    claim is an assertion and never a verified settlement.
 *
 * Replace with a managed model by implementing `ExtractionAdapter`.
 */

import {
  PROPOSAL_SCHEMA_VERSION,
  type ExtractionProposal,
  type FieldProvenance,
} from '@/lib/validation/proposal';
import type { PaymentMethod, PaymentStatus, RecordType } from '@/server/domain/types';
import type { ExtractionAdapter, ExtractionRequest } from './port';

const SALE_PATTERNS = [
  /\bnimeua\b/i,
  /\bnimeuza\b/i,
  /\b tul(i|iwa)wa\b/i,
  /\bsold\b/i,
  /\bsale\b/i,
  /\bmapato\b/i,
  /\bnalipua\b/i,
];

const EXPENSE_PATTERNS = [
  /\bnime(na)?tumia\b/i,
  /\bnilitua\b/i,
  /\bnilipta\b/i,
  /\bkununua\b/i,
  /\bspent\b/i,
  /\bexpense\b/i,
  /\bpaid for\b/i,
  /\bnkulipa\b/i,
];

const DEBT_CREATE_PATTERNS = [
  /\bakaiba\b/i,
  /\bdeni\b/i,
  /\batanifunika\b/i,
  /\bwill pay (me )?later\b/i,
  /\bowe me\b/i,
  /\bcredit (sale|for)\b/i,
];

const DEBT_PAYMENT_PATTERNS = [
  /\bdeni (imelipwa|amelipwa|imalipwa)\b/i,
  /\balilipa deni\b/i,
  /\bamenipa deni\b/i,
  /\bpaid (the |my )?debt\b/i,
  /\bdeni ya \d/i,
];

const STOCK_PATTERNS = [
  /\bnimeongeza\b/i,
  /\bimeisha\b/i,
  /\bzimeisha\b/i,
  /\bstock\b/i,
  /\binventory\b/i,
  /\bnimeuzisha\b/i,
];

const NOTE_ONLY_PATTERNS = [/\bnote\b/i, /\bkumbuka\b/i, /\bremember\b/i];

const METHOD_PATTERNS: { pattern: RegExp; method: PaymentMethod }[] = [
  { pattern: /m-?pesa|mix by sax|tigo pesa|airtel money|halopesa|telkom pesa/i, method: 'mobile_money' },
  { pattern: /\bpesa tasafu\b|\bcash\b|\b pesa\b(?!.*m-?pesa)/i, method: 'cash' },
  { pattern: /\bbenki\b|\bbank\b/i, method: 'bank' },
  { pattern: /\bkadi\b|\bcard\b|\bvisa\b/i, method: 'card' },
  { pattern: /\bcredit\b|\bdeni\b|\bpay later\b/i, method: 'credit' },
];

const EXPENSE_CATEGORY_PATTERNS: { pattern: RegExp; category: string }[] = [
  { pattern: /\brent\b|\bchumba\b/i, category: 'rent' },
  { pattern: /\belectric\b|\bumeme\b/i, category: 'utilities' },
  { pattern: /\bwater\b|\bmaji\b/i, category: 'utilities' },
  { pattern: /\btransport\b|\bmatatu\b|\btaxi\b|\bfuel\b|\bpetrol\b/i, category: 'transport' },
  { pattern: /\bstock\b|\bbidhaa\b|\bgini\b|\bwholesale\b/i, category: 'stock_purchase' },
  { pattern: /\bfood\b|\bchakula\b|\bchai\b|\bmah\b|\bkahawa\b/i, category: 'food' },
  { pattern: /\bsalary\b|\bmishahara\b|\bwages\b/i, category: 'salary' },
  { pattern: /\bairtime\b|\bdata\b/i, category: 'airtime_data' },
  { pattern: /\bpackaging\b|\bufungeji\b/i, category: 'packaging' },
];

const SALE_CATEGORY_PATTERNS: { pattern: RegExp; category: string }[] = [
  { pattern: /\bmchele\b|\brice\b/i, category: 'groceries' },
  { pattern: /\bmafumbini\b|\bposho\b/i, category: 'groceries' },
  { pattern: /\bmazi\b|\bwood\b/i, category: 'building_materials' },
  { pattern: /\bchai\b|\btea\b/i, category: 'drinks' },
  { pattern: /\bsoda\b|\bbeverage/i, category: 'drinks' },
];

const STOP_WORDS = new Set([
  'Nimeua',
  'Nimeuza',
  'Nilitua',
  'Nimeongeza',
  'Naona',
  'Asubuhi',
  'Mchana',
  'Jioni',
  'Leo',
  'Jana',
  'Kileleo',
  'Habari',
  'Nini',
  'Ndio',
  'Sawa',
  'Asante',
  'Bwana',
  'Bibi',
  'Mama',
  'Today',
  'Yesterday',
  'Morning',
  'Evening',
  'I',
  'We',
  'Sold',
  'Bought',
  'Paid',
]);

const MONTHS: Record<string, number> = {
  januari: 1,
  februari: 2,
  machi: 3,
  aprili: 4,
  mei: 5,
  juni: 6,
  julai: 7,
  agosti: 8,
  septemba: 9,
  oktoba: 10,
  november: 11,
  kipaumbele: 12,
  desemba: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  december: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  moja: 1,
  mbili: 2,
  tatu: 3,
  nne: 4,
  tano: 5,
  sita: 6,
  saba: 7,
  nane: 8,
  kumi: 10,
  'kumi na moja': 11,
  'kumi na mbili': 12,
  'kumi na tatu': 13,
  'kumi na nne': 14,
  'kumi na tano': 15,
  'kumi na sita': 16,
  'kumi na saba': 17,
  'kumi na nane': 18,
  'kumi na kumi': 20,
  ishirini: 20,
  thelathini: 30,
  arobaini: 40,
  hamsini: 50,
  sitini: 60,
  sabini: 70,
  themini: 80,
  tisaini: 90,
  mia: 100,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twenty: 20,
  thirty: 30,
  hundred: 100,
};

export type DetectedAmount = {
  value: number;
  span: string;
  derived: boolean;
  index: number;
};

function detectAmounts(text: string): DetectedAmount[] {
  const results: DetectedAmount[] = [];
  const pattern =
    /(?<![A-Za-z0-9])(?:tshs\.?|tzs\.?|shillingi\s*)?\s*(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?(?![A-Za-z0-9])/gi;
  let match = pattern.exec(text);
  while (match !== null) {
    const digits = (match[1] ?? '').replace(/[,\s]/g, '');
    const fraction = match[2] ?? '0';
    const tail = text
      .slice(match.index + match[0].length, match.index + match[0].length + 24)
      .toLowerCase();
    let value = Number(`${digits}.${fraction.padEnd(2, '0')}`);
    let derived = false;
    if (/^\s*(elfu|thousand)\b/.test(tail)) {
      value *= 1000;
      derived = true;
    } else if (/^\s*(laki|hundred)\b/.test(tail)) {
      value *= 100;
      derived = true;
    } else if (/^\s*(mili|million)\b/.test(tail)) {
      value *= 1_000_000;
      derived = true;
    } else if (/^\s*(kisiwa|thousand)/.test(tail)) {
      value *= 1000;
      derived = true;
    }
    results.push({ value, span: match[0].trim(), derived, index: match.index });
    match = pattern.exec(text);
  }

  // Only interpret "elfu tano" style phrases when no digits were captured, to
  // avoid double counting.
  if (results.length === 0) {
    const wordPattern = /\b(\w[\w\s-]{0,18}?)\s+(elfu|mili|laki|thousand|million|hundred)\b/gi;
    let wordMatch = wordPattern.exec(text);
    while (wordMatch !== null) {
      const before = (wordMatch[1] ?? '').trim().toLowerCase();
      const scaleWord = (wordMatch[2] ?? '').toLowerCase();
      const scale = scaleWord === 'elfu' || scaleWord === 'thousand' ? 1000 : scaleWord === 'mili' || scaleWord === 'million' ? 1_000_000 : 100;
      const head = NUMBER_WORDS[before];
      const fallback = NUMBER_WORDS[before.split(/\s+/).pop() ?? ''];
      const base = head ?? fallback;
      if (base !== undefined) {
        results.push({
          value: base * scale,
          span: wordMatch[0].trim(),
          derived: true,
          index: wordMatch.index,
        });
      }
      wordMatch = wordPattern.exec(text);
    }
  }
  return results;
}

function detectDate(
  text: string,
  nowUtc: string,
): { value: string; span: string; basis: 'explicit' | 'today' | 'yesterday' | 'assumed'; confidence: number } | null {
  if (/\b(leo|today)\b/i.test(text)) {
    return { value: nowUtc, span: 'leo', basis: 'today', confidence: 0.72 };
  }
  if (/\b(jana|yesterday)\b/i.test(text)) {
    const yesterday = new Date(Date.parse(nowUtc) - 86_400_000);
    return { value: yesterday.toISOString(), span: 'jana', basis: 'yesterday', confidence: 0.72 };
  }
  const numeric = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/.exec(text);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = Number(numeric[3]);
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const parsed = new Date(Date.UTC(year, month - 1, day, 9, 0, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return { value: parsed.toISOString(), span: numeric[0], basis: 'explicit', confidence: 0.88 };
      }
    }
  }
  const named = new RegExp(
    `\\b(\\d{1,2})\\s+(${Object.keys(MONTHS).join('|')})\\b`,
    'i',
  ).exec(text);
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS[(named[2] ?? '').toLowerCase()];
    if (month !== undefined) {
      const year = new Date(nowUtc).getUTCFullYear();
      const parsed = new Date(Date.UTC(year, month - 1, day, 9, 0, 0));
      if (!Number.isNaN(parsed.getTime())) {
        return { value: parsed.toISOString(), span: named[0], basis: 'explicit', confidence: 0.85 };
      }
    }
  }
  return null;
}

function detectCustomer(text: string): { name: string; span: string } | null {
  const pattern = /\b(?:kwa|for|from|kwa mteja|kwa mwananchi)\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+[A-ZÀ-Ý][\p{L}'-]+){0,2})/u;
  const match = pattern.exec(text);
  if (!match) return null;
  const name = (match[1] ?? '').trim();
  const firstWord = name.split(/\s+/)[0] ?? '';
  if (STOP_WORDS.has(firstWord) || STOP_WORDS.has(name)) return null;
  if (name.length < 2) return null;
  return { name, span: match[0] };
}

function detectPayment(text: string): { status: PaymentStatus; span: string } | null {
  if (/\b(sehemu|partial|part payment)\b/i.test(text)) {
    return { status: 'partial', span: 'sehemu' };
  }
  if (/\b(deni|akaiba|bado|not paid|hawajalipwa|haidulishwi|will pay later)\b/i.test(text)) {
    return { status: 'unpaid', span: 'deni' };
  }
  if (/\b(amelipa|alilipa|imalipwa|imeendeshwa|ameiliwa|amelipwa|paid|liked|received)\b/i.test(text)) {
    return { status: 'paid', span: 'amelipa' };
  }
  return null;
}

function detectMethod(text: string): { method: PaymentMethod; span: string } | null {
  for (const entry of METHOD_PATTERNS) {
    const match = entry.pattern.exec(text);
    if (match) return { method: entry.method, span: match[0] };
  }
  return null;
}

function detectCategory(text: string, recordType: RecordType): { category: string; span: string } | null {
  const patterns = recordType === 'expense' ? EXPENSE_CATEGORY_PATTERNS : SALE_CATEGORY_PATTERNS;
  for (const entry of patterns) {
    const match = entry.pattern.exec(text);
    if (match) return { category: entry.category, span: match[0] };
  }
  return null;
}

function detectItems(text: string): { value: string; span: string } | null {
  const match = /\b(?:nimeuza|nimeua|sold|sell)\s+([\p{L}\d\s'()-]{2,60})/u.exec(text);
  if (!match) return null;
  const value = (match[1] ?? '').trim();
  if (value.length === 0) return null;
  return { value, span: match[0] };
}

function field(value: FieldProvenance['value'], sourceSpan: string, confidence: number): FieldProvenance {
  return { value, sourceSpan, confidence };
}

export const mockExtractionAdapter: ExtractionAdapter = {
  name: 'mock-extraction-rules',
  modelVersion: 'mock-rules-v1',

  async extract(request: ExtractionRequest): Promise<ExtractionProposal> {
    const text = request.transcript.text.trim();
    const fields: Record<string, FieldProvenance> = {};
    const missingFields: string[] = [];
    const ambiguities: ExtractionProposal['ambiguities'] = [];

    const amounts = detectAmounts(text).filter((amount) => Number.isFinite(amount.value) && amount.value > 0);
    const dates = detectDate(text, request.business.nowIso);
    const payment = detectPayment(text);
    const method = detectMethod(text);
    const customer = detectCustomer(text);
    const category = detectCategory(text, 'expense');

    const saleHit = SALE_PATTERNS.some((pattern) => pattern.test(text));
    const expenseHit = EXPENSE_PATTERNS.some((pattern) => pattern.test(text));
    const debtCreateHit = DEBT_CREATE_PATTERNS.some((pattern) => pattern.test(text));
    const debtPaymentHit = DEBT_PAYMENT_PATTERNS.some((pattern) => pattern.test(text));
    const stockHit = request.inventoryEnabled && STOCK_PATTERNS.some((pattern) => pattern.test(text));
    const noteHit = NOTE_ONLY_PATTERNS.some((pattern) => pattern.test(text));

    const intentHits = [saleHit, expenseHit, debtCreateHit, debtPaymentHit, stockHit].filter(Boolean).length;

    // Several events in one message: ask a focused question instead of guessing.
    if (intentHits > 1 || amounts.length > 1) {
      return {
        schemaVersion: PROPOSAL_SCHEMA_VERSION,
        intent: saleHit ? 'sale' : 'expense',
        fields,
        missingFields: ['clarification'],
        ambiguities: [
          {
            field: 'clarification',
            question:
              'This message seems to describe more than one record. Which one should SAHL prepare?',
          },
        ],
        clarificationRequired: true,
        modelVersion: this.modelVersion,
      };
    }

    let intent: RecordType = 'note';
    if (stockHit) intent = 'stock_movement';
    else if (debtPaymentHit) intent = 'debt_payment';
    else if (debtCreateHit) intent = 'debt_created';
    else if (expenseHit) intent = 'expense';
    else if (saleHit) intent = 'sale';
    else if (noteHit) intent = 'note';

    const amount = amounts[0];
    if (amount) {
      fields.amountMinor = field(Math.round(amount.value * 100), amount.span, amount.derived ? 0.78 : 0.93);
    } else {
      missingFields.push('amountMinor');
    }

    if (dates) {
      fields.occurredAt = field(dates.value, dates.span, dates.confidence);
    } else if (intent === 'note') {
      fields.occurredAt = field(request.business.nowIso, 'now', 0.4);
    } else {
      missingFields.push('occurredAt');
    }

    if (intent === 'sale' || intent === 'debt_created' || intent === 'debt_payment') {
      if (customer) {
        fields.customerName = field(customer.name, customer.span, 0.74);
        const match = request.customers.find(
          (candidate) => candidate.name.toLowerCase() === customer.name.toLowerCase(),
        );
        if (match) {
          fields.customerId = field(match.id, customer.span, 0.95);
        }
      } else if (intent !== 'sale' || payment?.status !== 'paid') {
        // A cash sale paid in full is a walk-in: nobody is owed anything, so
        // there is nobody to name. Debt records, and sales leaving a balance,
        // do need somebody to owe or be owed.
        missingFields.push('customer');
      }
    }

    if (intent === 'sale') {
      if (payment) {
        fields.paymentStatus = field(payment.status, payment.span, 0.86);
      } else {
        // Never fabricate a payment status from the fact that an amount exists.
        missingFields.push('paymentStatus');
      }
      if (method) fields.paymentMethod = field(method.method, method.span, 0.85);
      const items = detectItems(text);
      if (items) fields.itemsText = field(items.value, items.span, 0.7);
      const saleCategory = detectCategory(text, 'sale');
      if (saleCategory) fields.category = field(saleCategory.category, saleCategory.span, 0.72);
    }

    if (intent === 'expense') {
      const expenseCategory = category;
      if (expenseCategory) fields.category = field(expenseCategory.category, expenseCategory.span, 0.72);
      else missingFields.push('category');
      if (customer) fields.payee = field(customer.name, customer.span, 0.7);
      if (payment) fields.paymentStatus = field(payment.status, payment.span, 0.8);
      if (method) fields.paymentMethod = field(method.method, method.span, 0.82);
    }

    if (intent === 'debt_payment' && method) {
      fields.paymentMethod = field(method.method, method.span, 0.85);
    }

    if (intent === 'stock_movement') {
      const quantityMatch = /\b(\d+(?:[.,]\d+)?)\s*(kilo|kg|pcs|piece|vipimo|pieces|bag| carton|sacks?)\b/i.exec(text);
      if (quantityMatch) {
        const quantity = Number((quantityMatch[1] ?? '').replace(',', '.'));
        if (Number.isFinite(quantity) && quantity > 0) {
          fields.quantity = field(Math.round(quantity * 1000), quantityMatch[0], 0.8);
          fields.unit = field((quantityMatch[2] ?? 'unit').toLowerCase(), quantityMatch[2] ?? '', 0.85);
        }
      }
      if (fields.quantity === undefined) missingFields.push('quantity');
      const itemMatch = request.items.find((candidate) =>
        text.toLowerCase().includes(candidate.name.toLowerCase()),
      );
      if (itemMatch) {
        fields.itemId = field(itemMatch.id, itemMatch.name, 0.9);
        fields.itemName = field(itemMatch.name, itemMatch.name, 0.9);
      } else {
        missingFields.push('item');
      }
      fields.movementType = field('out', 'nimeuza', 0.6);
    }

    if (intent === 'note') {
      fields.note = field(text, text.slice(0, 60), 0.5);
      missingFields.length = 0;
    }

    if (intent === 'note' && !noteHit) {
      ambiguities.push({
        field: 'recordType',
        question: 'SAHL could not tell whether this is a sale, an expense or a note.',
      });
    }

    return {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      intent,
      fields,
      missingFields,
      ambiguities,
      modelVersion: this.modelVersion,
    };
  },
};

/** Exposed for unit tests of the deterministic rules. */
export const __testing = {
  detectAmounts,
  detectDate,
  detectCustomer,
  detectPayment,
  detectMethod,
  detectCategory,
  MONTHS,
  NUMBER_WORDS,
};