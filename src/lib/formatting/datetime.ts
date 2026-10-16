/**
 * Timezone-aware date helpers.
 *
 * Business dates are calendar dates in the business timezone
 * (`Africa/Dar_es_Salaam` by default), never in the browser's timezone
 * (architecture.md section 17, item 7). Instants are stored in UTC and rendered
 * through `Intl`, which is available in both the browser and Node.
 */

export const DEFAULT_TIMEZONE = 'Africa/Dar_es_Salaam';

export type WallClockParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
};

export type ZonedParts = WallClockParts & {
  /** 0 = Sunday … 6 = Saturday, in the target zone. */
  weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function assertValidTimeZone(timeZone: string): string {
  try {
    getFormatter(timeZone).format(0);
    return timeZone;
  } catch {
    throw new RangeError(`Unknown timezone: ${timeZone}`);
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    assertValidTimeZone(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Wall clock of a UTC instant in the given zone. */
export function utcToZonedParts(instantMs: number, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(new Date(instantMs));
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
    second: Number(lookup.second),
    weekday: WEEKDAY_INDEX[lookup.weekday ?? 'Sun'] ?? 0,
  };
}

/** Minutes east of UTC for the given instant in the given zone. */
export function timeZoneOffsetMinutes(instantMs: number, timeZone: string): number {
  const zoned = utcToZonedParts(instantMs, timeZone);
  const asUtc = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
  );
  return Math.round((asUtc - instantMs) / 60_000);
}

function wallClockToNaiveUtcMs(parts: WallClockParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Converts a wall clock in a zone to a UTC instant.
 *
 * Two passes handle daylight-saving transitions. Ambiguous local times (clocks
 * going back) resolve to the earlier instant; non-existent local times are
 * reported by `isZonedWallClockValid` so callers can ask the merchant again
 * rather than silently shifting the business event.
 */
export function zonedWallClockToInstantMs(parts: WallClockParts, timeZone: string): number {
  const naive = wallClockToNaiveUtcMs(parts);
  const firstGuessOffset = timeZoneOffsetMinutes(naive, timeZone);
  let instant = naive - firstGuessOffset * 60_000;
  const refinedOffset = timeZoneOffsetMinutes(instant, timeZone);
  if (refinedOffset !== firstGuessOffset) {
    instant = naive - refinedOffset * 60_000;
  }
  return instant;
}

export function isZonedWallClockValid(parts: WallClockParts, timeZone: string): boolean {
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > 31 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 59
  ) {
    return false;
  }
  const instant = zonedWallClockToInstantMs(parts, timeZone);
  const back = utcToZonedParts(instant, timeZone);
  return (
    back.year === parts.year &&
    back.month === parts.month &&
    back.day === parts.day &&
    back.hour === parts.hour &&
    back.minute === parts.minute
  );
}

/** `2026-10-04` for a UTC instant in the given zone. */
export function toDateStr(instantMs: number, timeZone: string): string {
  const zoned = utcToZonedParts(instantMs, timeZone);
  return `${pad(zoned.year, 4)}-${pad(zoned.month, 2)}-${pad(zoned.day, 2)}`;
}

/** `2026-10-04T15:10` wall clock for a `datetime-local` input. */
export function toDateTimeLocalStr(instantMs: number, timeZone: string): string {
  const zoned = utcToZonedParts(instantMs, timeZone);
  return `${pad(zoned.year, 4)}-${pad(zoned.month, 2)}-${pad(zoned.day, 2)}T${pad(zoned.hour, 2)}:${pad(
    zoned.minute,
    2,
  )}`;
}

export function toIsoUtc(instantMs: number): string {
  return new Date(instantMs).toISOString();
}

export function fromIsoUtc(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new RangeError(`Invalid ISO timestamp: ${iso}`);
  return ms;
}

/** Start of a business calendar day, as a UTC instant. */
export function startOfDateStrUtcMs(dateStr: string, timeZone: string): number {
  const parsed = parseDateStr(dateStr);
  return zonedWallClockToInstantMs(
    { ...parsed, hour: 0, minute: 0, second: 0 },
    timeZone,
  );
}

export function parseDateStr(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) throw new RangeError(`Invalid calendar date: ${dateStr}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Invalid calendar date: ${dateStr}`);
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    throw new RangeError(`Invalid calendar date: ${dateStr}`);
  }
  return { year, month, day };
}

export function parseDateTimeLocalStr(value: string): WallClockParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Invalid date and time: ${value}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? '0'),
  };
}

/** Converts a `datetime-local` value in the business zone to a UTC instant. */
export function dateTimeLocalToInstantMs(value: string, timeZone: string): number {
  return zonedWallClockToInstantMs(parseDateTimeLocalStr(value), timeZone);
}

export function instantToDateTimeLocalStr(instantMs: number, timeZone: string): string {
  return toDateTimeLocalStr(instantMs, timeZone);
}

export type DateRange = {
  /** Inclusive calendar date in the business timezone. */
  from: string;
  /** Exclusive calendar date in the business timezone. */
  toExclusive: string;
  /** Inclusive end date, for display and for API queries. */
  toInclusive?: string;
};

export function dateRangeToUtcMs(range: DateRange, timeZone: string): {
  fromMs: number;
  toExclusiveMs: number;
} {
  const fromMs = startOfDateStrUtcMs(range.from, timeZone);
  const toExclusiveMs = startOfDateStrUtcMs(range.toExclusive, timeZone);
  if (toExclusiveMs <= fromMs) {
    throw new RangeError('The period end must be after the period start');
  }
  return { fromMs, toExclusiveMs };
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  const { year, month, day } = parseDateStr(dateStr);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1, 2)}-${pad(
    shifted.getUTCDate(),
    2,
  )}`;
}

/**
 * The calendar month containing `nowMs`, in the business timezone.
 *
 * The dashboard and the records list both default to this, so a merchant sees
 * the same interval on every screen instead of a range that depends on which
 * page loaded first.
 */
export function monthDateRange(timeZone: string, nowMs: number = Date.now()): DateRange {
  const today = todayInZone(timeZone, nowMs);
  const { year, month } = parseDateStr(today);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${pad(year, 4)}-${pad(month, 2)}-01`,
    toExclusive: `${pad(year, 4)}-${pad(month, 2)}-${pad(lastDay + 1, 2)}`,
    toInclusive: `${pad(year, 4)}-${pad(month, 2)}-${pad(lastDay, 2)}`,
  };
}

/** Whole days between two calendar dates (b - a). */
export function diffCalendarDays(fromDateStr: string, toDateStr: string): number {  const a = parseDateStr(fromDateStr);
  const b = parseDateStr(toDateStr);
  const from = Date.UTC(a.year, a.month - 1, a.day);
  const to = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((to - from) / 86_400_000);
}

/** Today in the business timezone. */
export function todayInZone(timeZone: string, nowMs: number = Date.now()): string {
  return toDateStr(nowMs, timeZone);
}

export function formatDateInZone(
  instantMs: number,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(new Date(instantMs));
}

export function formatDateTimeInZone(
  instantMs: number,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(new Date(instantMs));
}

export function formatTimeInZone(
  instantMs: number,
  timeZone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' },
): string {
  return new Intl.DateTimeFormat(locale, { timeZone, ...options }).format(new Date(instantMs));
}

const RELATIVE_UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365 * 86_400_000 },
  { unit: 'month', ms: 30 * 86_400_000 },
  { unit: 'week', ms: 7 * 86_400_000 },
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
];

/** "3 hours ago" / "in 2 days", for queue and freshness labels. */
export function formatRelativeTime(
  instantMs: number,
  locale: string,
  nowMs: number = Date.now(),
): string {
  const delta = instantMs - nowMs;
  const absolute = Math.abs(delta);
  if (absolute < 45_000) return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (absolute >= ms) {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
        Math.round(delta / ms),
        unit,
      );
    }
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'second');
}

/** Media duration as m:ss. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/** Groups a UTC instant into a chart bucket key inside the business timezone. */
export function bucketKeyForInstant(
  instantMs: number,
  timeZone: string,
  granularity: 'day' | 'week' | 'month',
): string {
  const dateStr = toDateStr(instantMs, timeZone);
  if (granularity === 'day') return dateStr;
  const { year, month } = parseDateStr(dateStr);
  if (granularity === 'month') return `${pad(year, 4)}-${pad(month, 2)}`;
  const weekday = utcToZonedParts(startOfDateStrUtcMs(dateStr, timeZone), timeZone).weekday;
  // Weeks start on Monday.
  const isoWeekday = weekday === 0 ? 7 : weekday;
  return addDaysToDateStr(dateStr, -(isoWeekday - 1));
}