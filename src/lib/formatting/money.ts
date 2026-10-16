/**
 * Money is stored and computed as integer minor units. Floating point is never
 * used for a financial value (architecture.md sections 4 and 10).
 */

export const SUPPORTED_CURRENCIES = ['TZS'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

/** ISO 4217 minor-unit digits. TZS uses two, but whole amounts drop the decimals. */
const MINOR_UNIT_DIGITS: Record<Currency, number> = {
  TZS: 2,
};

export const DEFAULT_CURRENCY: Currency = 'TZS';

export type SignedMinor = number;

export function minorUnitDigits(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}

export function isMinorUnit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

export function assertMinorUnit(value: unknown, label = 'amount'): number {
  if (!isMinorUnit(value)) {
    throw new RangeError(`${label} must be an integer number of minor units`);
  }
  return value;
}

export function addMinor(a: number, b: number): number {
  const sum = assertMinorUnit(a, 'amount') + assertMinorUnit(b, 'amount');
  return assertMinorUnit(sum, 'sum');
}

export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += assertMinorUnit(value, 'amount');
  return assertMinorUnit(total, 'total');
}

export function negateMinor(value: number): number {
  return -assertMinorUnit(value, 'amount');
}

export function minorDifference(a: number, b: number): number {
  return assertMinorUnit(a, 'amount') - assertMinorUnit(b, 'amount');
}

export function maxMinor(a: number, b: number): number {
  return a > b ? a : b;
}

export function minMinor(a: number, b: number): number {
  return a < b ? a : b;
}

/**
 * Parses merchant or reviewer input into minor units.
 *
 * Accepts grouped digits ("15,000", "15 000"), an optional currency symbol or
 * code, and at most the currency's minor-unit digits of decimals. Anything else
 * is rejected instead of being silently rounded.
 */
export function parseAmountToMinor(input: string, currency: Currency): number {
  const digits = minorUnitDigits(currency);
  const cleaned = input
    .trim()
    .replace(/[−–—]/g, '-')
    .replace(/,/g, '')
    .replace(/\s/g, '')
    .replace(/^TZS\s*/i, '')
    .replace(/\s*TZS$/i, '');
  if (cleaned === '') {
    throw new MoneyParseError('Enter an amount');
  }
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) {
    throw new MoneyParseError('Enter a valid amount, for example 15000');
  }
  const sign = match[1] === '-' ? -1 : 1;
  const whole = match[2] ?? '0';
  const fraction = match[3] ?? '';
  if (fraction.length > digits) {
    throw new MoneyParseError(
      digits === 0 ? 'Amounts are whole numbers' : `Use at most ${digits} decimal places`,
    );
  }
  const padded = fraction.padEnd(digits, '0');
  const magnitude = Number(`${whole}${padded || ''}`);
  if (!Number.isSafeInteger(magnitude)) {
    throw new MoneyParseError('That amount is too large');
  }
  return sign * magnitude;
}

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyParseError';
  }
}

/**
 * Formats minor units for display without touching floating point: the integer
 * and fraction halves are formatted independently.
 */
export function formatMinor(
  minor: number,
  options: {
    locale: string;
    currency?: Currency;
    showCurrency?: boolean;
    showSign?: boolean;
    useGrouping?: boolean;
  },
): string {
  const { locale, currency, showCurrency = false, showSign = false, useGrouping = true } = options;
  const value = assertMinorUnit(minor, 'amount');
  const digits = currency ? minorUnitDigits(currency) : 2;
  const isNegative = value < 0;
  const absolute = isNegative ? -value : value;
  const divisor = 10 ** digits;
  const whole = Math.floor(absolute / divisor);
  const fraction = absolute % divisor;

  const integerFormatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
    useGrouping,
  });
  const fractionFormatter = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
    useGrouping: false,
  });

  const wholeText = integerFormatter.format(whole);
  // Avoid "15,000.00": whole TZS amounts read better without trailing zeros.
  const fractionText = fraction === 0 ? '' : fractionFormatter.format(fraction);
  const grouped = fractionText === '' ? wholeText : `${wholeText}.${fractionText}`;

  const prefix = isNegative ? '-' : showSign ? '+' : '';
  const suffix = showCurrency && currency ? ` ${currency}` : '';
  return `${prefix}${grouped}${suffix}`;
}

/** Machine-readable amount for exports and audit snapshots. */
export function minorToMajorString(minor: number, currency: Currency): string {
  const digits = minorUnitDigits(currency);
  const value = assertMinorUnit(minor, 'amount');
  const sign = value < 0 ? '-' : '';
  const absolute = value < 0 ? -value : value;
  const divisor = 10 ** digits;
  const whole = Math.floor(absolute / divisor);
  const fraction = absolute % divisor;
  const fractionText = fraction === 0 ? '' : `.${String(fraction).padStart(digits, '0')}`;
  return `${sign}${whole}${fractionText}`;
}