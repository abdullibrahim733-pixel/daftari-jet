/**
 * Drains the durable job queue once, for local development.
 *
 * In a deployment the same work runs from the scheduled endpoint
 * (`/api/cron/jobs`). Here it runs in the foreground so a developer can send a
 * WhatsApp message and watch the pipeline finish.
 *
 * Usage: npm run jobs:run
 */

import { closeDatabase, getDatabase } from '@/server/db/client';
import { runDueJobs, type JobRunSummary } from '@/server/services/jobs';

const MAX_ROUNDS = 10;

function tally(summaries: JobRunSummary[]): string {
  const counts = summaries.reduce<Record<string, number>>((accumulator, summary) => {
    accumulator[summary.status] = (accumulator[summary.status] ?? 0) + 1;
    return accumulator;
  }, {});
  return Object.entries(counts)
    .map(([status, count]) => `${status}=${count}`)
    .join(' ');
}

async function main(): Promise<void> {
  const db = getDatabase();
  const all: JobRunSummary[] = [];

  // A job can enqueue the next stage (media acquisition -> transcription), so
  // keep draining until the queue is quiet or the round budget is spent.
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const summaries = await runDueJobs(db, { limit: 20 });
    if (summaries.length === 0) break;
    all.push(...summaries);
    process.stdout.write(`round ${round + 1}: ${tally(summaries)}\n`);
  }

  if (all.length === 0) {
    process.stdout.write('No due jobs.\n');
  } else {
    process.stdout.write(`Processed ${all.length} job(s): ${tally(all)}\n`);
  }

  for (const summary of all) {
    if (summary.status !== 'succeeded') {
      process.stdout.write(`  ${summary.status} ${summary.jobType} (${summary.errorCode ?? 'no code'})\n`);
    }
  }

  const deadLettered = all.filter((summary) => summary.status === 'dead_letter').length;
  if (deadLettered > 0) process.exitCode = 1;
  closeDatabase();
}

await main();
