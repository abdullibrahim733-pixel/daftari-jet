/**
 * Report range parsing shared by the report routes.
 *
 * The API speaks inclusive calendar dates in the business timezone; the domain
 * works in exclusive bounds. Converting in one place keeps a chart, a table and
 * an export describing the same interval.
 */

import { addDaysToDateStr, monthDateRange, type DateRange } from '@/lib/formatting/datetime';
import { validationFailed } from '@/lib/errors';
import { queryEnum, queryParam } from '@/server/http/route';

export type Granularity = 'day' | 'week' | 'month';

const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month'];

export function rangeFromQuery(request: Request, timeZone: string): DateRange {
  const month = monthDateRange(timeZone);
  const from = queryParam(request, 'from') ?? month.from;
  const toInclusive =
    queryParam(request, 'to') ?? month.toInclusive ?? addDaysToDateStr(month.toExclusive, -1);
  const toExclusive = addDaysToDateStr(toInclusive, 1);
  if (toExclusive <= from) {
    throw validationFailed('The end date must be on or after the start date', { from, to: toInclusive });
  }
  return { from, toExclusive, toInclusive };
}

export function granularityFromQuery(request: Request): Granularity {
  return queryEnum(request, 'granularity', GRANULARITIES) ?? 'day';
}
