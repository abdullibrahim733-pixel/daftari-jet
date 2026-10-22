'use client';

/**
 * Last-resort boundary.
 *
 * Replaces the root layout when a failure escapes every other boundary, so it
 * has to render its own `<html>` and `<body>` and cannot import global CSS —
 * the layout that provides it is the thing that broke. Everything here is
 * inline and self-contained for that reason.
 */

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          background: '#F5F5EC',
          color: '#1A1A1A',
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, -apple-system, sans-serif',
        }}
      >
        <main style={{ maxWidth: 460, padding: 32, textAlign: 'center' }}>
          <h1 style={{ fontSize: 28, letterSpacing: '-0.02em', margin: '0 0 12px' }}>
            SAHL could not start
          </h1>
          <p style={{ fontSize: 15, lineHeight: 1.55, opacity: 0.72, margin: '0 0 24px' }}>
            Refresh the page to try again. If it keeps happening, contact support and quote the reference below.
          </p>
          {error.digest ? (
            <p style={{ fontSize: 12, opacity: 0.5, fontFamily: 'ui-monospace, monospace', margin: '0 0 24px' }}>
              Reference: {error.digest}
            </p>
          ) : null}
          <button
            type="button"
            onClick={reset}
            style={{
              appearance: 'none',
              border: 0,
              cursor: 'pointer',
              background: '#D4A23C',
              color: '#1A1A1A',
              fontSize: 15,
              fontWeight: 600,
              padding: '12px 24px',
              borderRadius: 999,
            }}
          >
            Reload SAHL
          </button>
        </main>
      </body>
    </html>
  );
}