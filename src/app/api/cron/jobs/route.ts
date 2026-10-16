/**
 * Scheduled job runner.
 *
 * Vercel Cron calls this on a schedule with `Authorization: Bearer <CRON_SECRET>`.
 * The endpoint is a normal public route, so it authenticates with a shared
 * secret and fails closed when no secret is configured. It only ever drains the
 * durable queue; no provider work happens inline.
 */

import { timingSafeEqual } from 'node:crypto';
import { cronSecret } from '@/server/config/env';
import { getDatabase } from '@/server/db/client';
import { unauthenticated } from '@/lib/errors';
import { route, ok, queryInt } from '@/server/http/route';
import { runDueJobs } from '@/server/services/jobs';
import { logger } from '@/server/observability/logger';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function secretMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export const GET = route(async (request) => {
  const secret = cronSecret();
  if (!secret) {
    throw unauthenticated('Scheduled jobs are not configured');
  }

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!provided || !secretMatches(provided, secret)) {
    throw unauthenticated('Invalid scheduled-job credentials');
  }

  const summaries = await runDueJobs(getDatabase(), { limit: queryInt(request, 'limit', 20, 100) });
  const deadLettered = summaries.filter((summary) => summary.status === 'dead_letter').length;
  if (deadLettered > 0) {
    logger.warn('cron.jobs_dead_lettered', { deadLettered, processed: summaries.length });
  }

  return ok({ processed: summaries.length, deadLettered, summaries });
});
