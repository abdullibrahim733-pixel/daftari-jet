/**
 * Application error contract (architecture.md section 5).
 *
 * Errors never carry stack traces, provider payloads, transcript text or
 * sensitive values to the client.
 */

export const ERROR_CODES = {
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  PROPOSAL_VERSION_CONFLICT: 'PROPOSAL_VERSION_CONFLICT',
  PROPOSAL_NOT_REVIEWABLE: 'PROPOSAL_NOT_REVIEWABLE',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED',
  IDEMPOTENT_REQUEST_IN_PROGRESS: 'IDEMPOTENT_REQUEST_IN_PROGRESS',
  RECORD_VERSION_CONFLICT: 'RECORD_VERSION_CONFLICT',
  RECORD_NOT_POSTED: 'RECORD_NOT_POSTED',
  OBLIGATION_HAS_PAYMENTS: 'OBLIGATION_HAS_PAYMENTS',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  WEBHOOK_REPLAYED: 'WEBHOOK_REPLAYED',
  FEATURE_NOT_ENABLED: 'FEATURE_NOT_ENABLED',
  RATE_LIMITED: 'RATE_LIMITED',
  EXPORT_IN_PROGRESS: 'EXPORT_IN_PROGRESS',
  INTEGRATION_NOT_CONNECTED: 'INTEGRATION_NOT_CONNECTED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Detail values are JSON-safe; readonly arrays keep `as const` lists usable. */
export type AppErrorDetails = Record<
  string,
  string | number | boolean | readonly string[] | null
>;

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: AppErrorDetails;

  constructor(status: number, code: ErrorCode, message: string, details?: AppErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function unauthenticated(message = 'Sign in to continue'): AppError {
  return new AppError(401, ERROR_CODES.UNAUTHENTICATED, message);
}

export function forbidden(
  message = 'Your role does not allow this action',
  details?: AppErrorDetails,
): AppError {
  return new AppError(403, ERROR_CODES.FORBIDDEN, message, details);
}

/** Absent and cross-tenant resources return the same status to avoid enumeration. */
export function notFound(message = 'Not found'): AppError {
  return new AppError(404, ERROR_CODES.NOT_FOUND, message);
}

export function validationFailed(
  message: string,
  details?: AppErrorDetails,
): AppError {
  return new AppError(422, ERROR_CODES.VALIDATION_FAILED, message, details);
}

export function signatureInvalid(message = 'Webhook signature is invalid'): AppError {
  return new AppError(401, ERROR_CODES.SIGNATURE_INVALID, message);
}

export function conflict(
  code: ErrorCode,
  message: string,
  details?: AppErrorDetails,
): AppError {
  return new AppError(409, code, message, details);
}

export function featureNotEnabled(feature: string): AppError {
  return new AppError(
    403,
    ERROR_CODES.FEATURE_NOT_ENABLED,
    'This feature is not enabled for your business',
    { feature },
  );
}

export function toErrorResponse(error: unknown, requestId: string): {
  status: number;
  body: {
    error: {
      code: ErrorCode;
      message: string;
      requestId: string;
      details?: AppErrorDetails;
    };
  };
} {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          requestId,
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: ERROR_CODES.INTERNAL,
        message: 'Something went wrong. Please try again.',
        requestId,
      },
    },
  };
}