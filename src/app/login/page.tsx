/**
 * Sign-in.
 *
 * The first screen a merchant sees, so it has to do three things at once: say
 * what SAHL is in one line, get out of the way, and never look like a
 * generic SaaS login form. The layout is a two-panel split on desktop — the
 * story on the left in Deep Navy, the form on the right in Warm Ivory — and
 * collapses to a single column on a phone, where only the form survives.
 *
 * Reading the session here makes the page dynamic, which is also what keeps
 * authenticated HTML out of the prerender cache.
 */

import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { optionalSession, devLoginEnabled } from '@/server/auth/session';
import { createTranslator } from '@/lib/localization';
import { BRAND } from '@/lib/brand';
import SahlBrandLockup from '@/components/SahlBrandLockup';
import LoginForm from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${BRAND.name} to review your business records.`,
};

const t = createTranslator('en');

export default async function LoginPage() {
  // An authenticated visitor has no business on this screen.
  const session = await optionalSession();
  if (session) {
    redirect('/');
  }

  return (
    <div className="auth-layout">
      {/* Story panel. Decorative on a phone: the benefits move under the form. */}
      <section className="auth-story" aria-hidden="false">
        <SahlBrandLockup className="auth-brand" href="/login" />

        <div className="auth-story__body">
          <h1 className="auth-headline">{t('signin.title')}</h1>
          <p className="auth-subtitle">{t('signin.subtitle')}</p>

          <ol className="auth-benefits">
            {[t('signin.benefit1'), t('signin.benefit2'), t('signin.benefit3')].map((benefit) => (
              <li className="auth-benefit" key={benefit}>
                <span className="auth-benefit__mark" aria-hidden="true" />
                <span>{benefit}</span>
              </li>
            ))}
          </ol>
        </div>

        <p className="auth-story__foot">{t('app.tagline')}</p>
      </section>

      <section className="auth-panel">
        <div className="auth-panel__inner">
          <SahlBrandLockup className="auth-panel__mobile-brand" href="/login" />

          <LoginForm devLoginAvailable={devLoginEnabled()} />

          <footer className="auth-foot">
            <Link href="/login">{t('signin.privacyLink')}</Link>
            <span className="auth-foot__dot" aria-hidden="true">·</span>
            <Link href="/login">{t('signin.helpLink')}</Link>
          </footer>
        </div>
      </section>
    </div>
  );
}