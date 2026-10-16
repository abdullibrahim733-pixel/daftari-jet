/**
 * Structured logging with central redaction (architecture.md sections 9 and 13).
 *
 * Raw transcripts, audio references, provider tokens, webhook bodies, customer
 * contact details and full financial records never reach the log sink.
 */

import { randomUUID } from 'node:crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  requestId?: string;
  jobId?: string;
  /** Opaque tenant identifier only. */
  businessId?: string;
  entityId?: string;
  operation?: string;
  durationMs?: number;
  result?: string;
  /** Safe, enumerated failure classification. */
  errorCode?: string;
  [key: string]: unknown;
};

const SENSITIVE_KEY_PATTERN =
  /(transcript|text|audio|media_?url|object_?key|token|secret|password|authorization|signature|phone|sender|customer_?name|note|description|payload|raw)/i;

/** Keys whose values must never be logged verbatim. */
function redactValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[redacted]';
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === 'object') return '[object]';
  return '[unserialisable]';
}

function truncate(value: string, max = 240): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

export function redactContext(context: LogContext): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    output[key] = redactValue(key, value);
  }
  return output;
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

function emit(level: LogLevel, message: string, context: LogContext = {}): void {
  const line = {
    timestamp: new Date().toISOString(),
    level,
    service: 'daftari-dashboard',
    environment: process.env.NODE_ENV ?? 'development',
    message,
    ...redactContext(context),
  };
  const serialized = JSON.stringify(line);
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.info(serialized);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit('debug', message, context),
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
};

/**
 * Analytics events follow an approved schema (PRD section 11). Values are
 * counts and opaque identifiers only: no transcript, amount, customer name or
 * phone number. Opt-in is respected in local development.
 */
export type AnalyticsEvent =
  | 'business_created'
  | 'whatsapp_connected'
  | 'source_received'
  | 'proposal_ready'
  | 'proposal_opened'
  | 'proposal_corrected'
  | 'proposal_confirmed'
  | 'proposal_rejected'
  | 'record_corrected'
  | 'export_requested';

export function trackEvent(event: AnalyticsEvent, properties: Record<string, string | number | boolean> = {}): void {
  if (process.env.DAFTARI_ANALYTICS_ENABLED !== '1') return;
  logger.info(`analytics:${event}`, properties);
}