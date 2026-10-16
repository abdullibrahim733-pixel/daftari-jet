'use client';

/**
 * Dashboard error boundary.
 *
 * `reset()` re-renders the segment without a full page load, which is the right
 * response to a failed client fetch. The message never echoes `error.message`:
 * a server error string can carry a query fragment or an identifier, and this
 * surface is shown to a merchant, not an engineer. The detail belongs in the
 * request id, which the logs already carry.
 */

import { useEffect } from 'react';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Structured enough to correlate with server logs, without the payload.
    console.error('dashboard.segment_error', {
      digest: error.digest ?? null,
      message: error.message,
    });
  }, [error]);

  return (
    <div className="state-panel" role="alert">
      <p className="state-panel__eyebrow">{t('state.error.title')}</p>
      <h2 className="state-panel__title">{t('app.errorTitle')}</h2>
      <p className="state-panel__body">{t('app.errorBody')}</p>
      {error.digest ? <p className="state-panel__meta"><span className="cx-mono">{error.digest}</span></p> : null}
      <div className="state-panel__actions">
        <button className="btn btn-primary" type="button" onClick={reset}>
          {t('app.tryAgain')}
        </button>
      </div>
    </div>
  );
}