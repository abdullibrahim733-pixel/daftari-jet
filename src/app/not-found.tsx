import Link from 'next/link';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

export default function NotFound() {
  return (
    <main className="state-panel state-panel-centered">
      <p className="state-panel__eyebrow">404</p>
      <h1 className="state-panel__title">{t('app.notFoundTitle')}</h1>
      <p className="state-panel__body">{t('app.notFoundBody')}</p>
      <div className="state-panel__actions">
        <Link className="btn btn-primary" href="/">{t('app.goHome')}</Link>
      </div>
    </main>
  );
}