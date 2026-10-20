/**
 * Route handler boundary.
 *
 * Route handlers are public HTTP endpoints, so every one of them goes through
 * this wrapper. It guarantees three things that are easy to forget per route:
 * a domain error becomes its documented status code, an unexpected error never
 * leaks a message or stack to the client, and the request id in the response
 * matches the one in the log line.
 */

import { ZodError, type ZodType } from 'zod';
import { AppError, ERROR_CODES, validationFailed, type AppErrorDetails } from '@/lib/errors';
import { logger } from '@/server/observability/logger';

export type HandlerContext<Params = Record<string, string>> = {
  params: Promise<Params>;
};

export type RouteHandler<Params = Record<string, string>> = (
  request: Request,
  context: HandlerContext<Params>,
) => Promise<Response> | Response;

/** Same shape as `AppErrorDetails`, named for the response contract. */
export type ErrorDetails = AppErrorDetails;

export type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: ErrorDetails;
    requestId?: string;
  };
};

export function requestIdFrom(request: Request): string {
  return (
    request.headers.get('x-request-id')?.trim() ||
    request.headers.get('x-correlation-id')?.trim() ||
    crypto.randomUUID()
  );
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: ErrorDetails,
): Response {
  const body: ErrorBody = { error: { code, message, requestId, ...(details ? { details } : {}) } };
  return Response.json(body, {
    status,
    headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
  });
}

/** Wraps a handler so every failure leaves through the documented contract. */
export function route<Params = Record<string, string>>(handler: RouteHandler<Params>): RouteHandler<Params> {
  return async (request, context) => {
    const requestId = requestIdFrom(request);
    try {
      const response = await handler(request, context);
      response.headers.set('x-request-id', requestId);
      return response;
    } catch (error) {
      if (error instanceof AppError) {
        if (error.status >= 500) {
          logger.error('http.unexpected_error', { requestId, code: error.code, status: error.status });
        }
        return errorResponse(error.status, error.code, error.message, requestId, error.details);
      }
      if (error instanceof ZodError) {
        return errorResponse(
          422,
          ERROR_CODES.VALIDATION_FAILED,
          'Some fields need attention',
          requestId,
          { fields: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`) },
        );
      }
      logger.error('http.unhandled_error', {
        requestId,
        path: new URL(request.url).pathname,
      });
      return errorResponse(
        500,
        ERROR_CODES.INTERNAL,
        'Something went wrong on our side. Try again.',
        requestId,
      );
    }
  };
}

/**
 * Reads a request body with a hard byte limit. Content-Length is an early
 * rejection hint only; streamed chunks are counted as well because callers
 * cannot trust that header.
 */
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The request body is too large');
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the size-limit error even if the transport cannot cancel.
        }
        throw new AppError(413, ERROR_CODES.VALIDATION_FAILED, 'The request body is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Parses a JSON body, reporting a malformed body as a validation failure. */
export async function jsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'The request body is not valid JSON');
  }
}

export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  return schema.parse(await jsonBody(request));
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, { status: 200, ...init });
}

export function created<T>(data: T): Response {
  return Response.json({ data }, { status: 201 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Reads a single query parameter, treating blank values as absent. */
export function queryParam(request: Request, name: string): string | null {
  const value = new URL(request.url).searchParams.get(name);
  return value && value.trim().length > 0 ? value.trim() : null;
}

export function queryInt(request: Request, name: string, fallback: number, max = 200): number {
  const raw = queryParam(request, name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

/** Splits `?types=a,b` into a validated list. */
export function queryList(request: Request, name: string): string[] {
  const raw = queryParam(request, name);
  if (raw === null) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Rejects a query value that is not one of the allowed options. */
export function queryEnum<T extends string>(
  request: Request,
  name: string,
  allowed: readonly T[],
): T | null {
  const value = queryParam(request, name);
  if (value === null) return null;
  if (!allowed.includes(value as T)) {
    throw validationFailed(`Unknown ${name}: ${value}`, { allowed });
  }
  return value as T;
}
