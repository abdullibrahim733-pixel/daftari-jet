/**
 * Boot screen.
 *
 * Shown while a route segment resolves. It is a real status surface rather than
 * a spinner: it names the product, states what is happening, and announces
 * progress politely so a screen-reader user is told the page is working instead
 * of hearing silence.
 *
 * The motion is an indeterminate sweep, not a fake percentage. A progress bar
 * that invents a number is worse than no bar, because it promises a completion
 * time the client has no way to know.
 *
 * Under `prefers-reduced-motion` the sweep stops and the rail simply sits at a
 * steady fill, so the screen still communicates "working" without animating.
 */

import { createTranslator } from '@/lib/localization';
import SahlBrandMark from './SahlBrandMark';

const t = createTranslator('en');

export default function BootScreen({
  title,
  status,
}: {
  title?: string;
  status?: string;
}) {
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot__inner">
        <div className="boot__mark" aria-hidden="true">
          <SahlBrandMark className="brand-logo-mark" />
        </div>

        <p className="boot__title">{title ?? t('app.bootTitle')}</p>
        <p className="boot__status">{status ?? t('app.bootStatus')}</p>

        <div className="boot__rail" aria-hidden="true">
          <span className="boot__rail-fill" />
        </div>

        {/* The rail is decorative; this carries the same information in text. */}
        <span className="sr-only">{t('state.loading')}</span>
      </div>
    </div>
  );
}