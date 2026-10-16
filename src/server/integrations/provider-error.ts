/**
 * A failure reported by an external provider adapter.
 *
 * `retryable` is what lets the job runner decide between retrying with backoff
 * and giving up, without every caller knowing provider-specific status codes.
 */

export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
  }
}
