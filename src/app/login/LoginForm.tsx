'use client';

/**
 * Credential form for the sign-in screen.
 *
 * One component drives both modes so the field set, validation and error
 * surface cannot drift between "sign in" and "create account". Every state the
 * PRD requires for a P0 screen is modelled explicitly — idle, submitting,
 * field error, form error, rate limited — and the form stays operable with a
 * keyboard and announces changes through a polite live region.
 */

import { useCallback, useId, useMemo, useState } from 'react';
import { createTranslator } from '@/lib/localization';
import { safeNextPath } from '@/lib/redirect';

const t = createTranslator('en');

type Mode = 'sign-in' | 'create';

type FormErrors = Partial<Record<'email' | 'password' | 'displayName' | 'businessName' | 'form', string>>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function readNextParam(): string {
  if (typeof window === 'undefined') return '/';
  return safeNextPath(new URLSearchParams(window.location.search).get('next'));
}

export default function LoginForm({ devLoginAvailable }: { devLoginAvailable: boolean }) {
  const emailId = useId();
  const passwordId = useId();
  const nameId = useId();
  const businessId = useId();
  const statusId = useId();

  const [mode, setMode] = useState<Mode>('sign-in');
  const [values, setValues] = useState({
    email: '',
    password: '',
    displayName: '',
    businessName: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [devBusy, setDevBusy] = useState(false);

  const isCreate = mode === 'create';

  const describedBy = useMemo(() => {
    const parts: string[] = [];
    if (isCreate) parts.push(`${passwordId}-hint`);
    return parts.join(' ') || undefined;
  }, [isCreate, passwordId]);

  const setField = useCallback((field: keyof typeof values, value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
    // Clear the field's own error as soon as the merchant edits it, so the
    // message never contradicts what is on screen.
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  }, []);

  function validate(): FormErrors {
    const next: FormErrors = {};
    if (!values.email.trim()) {
      next.email = t('signin.error.emailRequired');
    } else if (!EMAIL_PATTERN.test(values.email.trim())) {
      next.email = t('signin.error.emailInvalid');
    }
    if (!values.password) {
      next.password = t('signin.error.passwordRequired');
    } else if (isCreate && values.password.length < 10) {
      next.password = t('signin.error.passwordTooShort');
    }
    if (isCreate) {
      if (!values.displayName.trim()) next.displayName = t('signin.error.nameRequired');
      if (!values.businessName.trim()) next.businessName = t('signin.error.businessRequired');
    }
    return next;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Move focus to the first invalid field so keyboard and screen-reader
      // users are not left guessing which field needs attention.
      const first = document.getElementById(
        found.email ? emailId : found.password ? passwordId : found.displayName ? nameId : businessId,
      );
      first?.focus();
      return;
    }

    setBusy(true);
    setStatus(t(isCreate ? 'signin.creatingAccount' : 'signin.signingIn'));
    setErrors({});

    try {
      const response = await fetch(
        isCreate ? '/api/v1/auth/register' : '/api/v1/auth/sign-in',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            isCreate
              ? {
                  email: values.email.trim(),
                  password: values.password,
                  displayName: values.displayName.trim(),
                  businessName: values.businessName.trim(),
                }
              : { email: values.email.trim(), password: values.password },
          ),
        },
      );

      if (response.ok) {
        setStatus(t(isCreate ? 'signin.accountReady' : 'signin.signedIn'));
        // A full navigation, not a client push: the new session cookie belongs
        // to the document, and the dashboard shell must mount with it.
        window.location.assign(readNextParam());
        return;
      }

      const body = (await response.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;

      if (response.status === 429) {
        setErrors({ form: t('signin.error.rateLimited') });
      } else if (response.status === 409) {
        setErrors({ email: t('signin.error.emailTaken') });
      } else {
        setErrors({ form: body?.error?.message || t('signin.failed') });
      }
      setStatus(null);
    } catch {
      setErrors({ form: t('signin.error.network') });
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleDevLogin() {
    if (devBusy) return;
    setDevBusy(true);
    try {
      const response = await fetch('/api/v1/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'dev-owner', businessName: 'SAHL Demo Shop' }),
      });
      if (response.ok) {
        window.location.assign('/');
        return;
      }
      setErrors({ form: t('signin.failed') });
    } catch {
      setErrors({ form: t('signin.error.network') });
    } finally {
      setDevBusy(false);
    }
  }

  return (
    <>
      {/* Mode switch. A segmented control, because the two modes are peers. */}
      <div className="auth-switch" role="tablist" aria-label={t('signin.switchLabel')}>
        <button
          type="button"
          role="tab"
          id={`${emailId}-tab-signin`}
          aria-selected={!isCreate}
          className={`auth-switch__btn${!isCreate ? ' auth-switch__btn-active' : ''}`}
          onClick={() => { setMode('sign-in'); setErrors({}); setStatus(null); }}
        >
          {t('signin.switch.signIn')}
        </button>
        <button
          type="button"
          role="tab"
          id={`${emailId}-tab-create`}
          aria-selected={isCreate}
          className={`auth-switch__btn${isCreate ? ' auth-switch__btn-active' : ''}`}
          onClick={() => { setMode('create'); setErrors({}); setStatus(null); }}
        >
          {t('signin.switch.create')}
        </button>
      </div>

      <h2 className="auth-form-title">{isCreate ? t('signin.createTitle') : t('signin.welcomeBack')}</h2>
      <p className="auth-form-subtitle">{isCreate ? t('signin.createSubtitle') : t('signin.signInSubtitle')}</p>

      <form className="auth-form" onSubmit={handleSubmit} noValidate>
        <div className="auth-field">
          <label className="auth-label" htmlFor={emailId}>{t('signin.email')}</label>
          <input
            id={emailId}
            className={`auth-input${errors.email ? ' auth-input-invalid' : ''}`}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            placeholder={t('signin.emailPlaceholder')}
            value={values.email}
            onChange={(event) => setField('email', event.target.value)}
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? `${emailId}-error` : undefined}
            disabled={busy}
          />
          {errors.email ? <p className="auth-error" id={`${emailId}-error`}>{errors.email}</p> : null}
        </div>

        {isCreate ? (
          <>
            <div className="auth-field">
              <label className="auth-label" htmlFor={nameId}>{t('signin.yourName')}</label>
              <input
                id={nameId}
                className={`auth-input${errors.displayName ? ' auth-input-invalid' : ''}`}
                type="text"
                name="name"
                autoComplete="name"
                placeholder={t('signin.yourNamePlaceholder')}
                value={values.displayName}
                onChange={(event) => setField('displayName', event.target.value)}
                aria-invalid={errors.displayName ? true : undefined}
                aria-describedby={errors.displayName ? `${nameId}-error` : undefined}
                disabled={busy}
              />
              {errors.displayName ? <p className="auth-error" id={`${nameId}-error`}>{errors.displayName}</p> : null}
            </div>

            <div className="auth-field">
              <label className="auth-label" htmlFor={businessId}>{t('signin.businessName')}</label>
              <input
                id={businessId}
                className={`auth-input${errors.businessName ? ' auth-input-invalid' : ''}`}
                type="text"
                name="organization"
                autoComplete="organization"
                placeholder={t('signin.businessNamePlaceholder')}
                value={values.businessName}
                onChange={(event) => setField('businessName', event.target.value)}
                aria-invalid={errors.businessName ? true : undefined}
                aria-describedby={errors.businessName ? `${businessId}-error` : undefined}
                disabled={busy}
              />
              {errors.businessName ? (
                <p className="auth-error" id={`${businessId}-error`}>{errors.businessName}</p>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="auth-field">
          <div className="auth-label-row">
            <label className="auth-label" htmlFor={passwordId}>{t('signin.password')}</label>
            {!isCreate ? <span className="auth-label-note">{t('signin.passwordNote')}</span> : null}
          </div>
          <input
            id={passwordId}
            className={`auth-input${errors.password ? ' auth-input-invalid' : ''}`}
            type="password"
            name="password"
            autoComplete={isCreate ? 'new-password' : 'current-password'}
            placeholder={t('signin.passwordPlaceholder')}
            value={values.password}
            onChange={(event) => setField('password', event.target.value)}
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={[describedBy, errors.password ? `${passwordId}-error` : null]
              .filter(Boolean)
              .join(' ') || undefined}
            disabled={busy}
          />
          {isCreate ? (
            <p className="auth-hint" id={`${passwordId}-hint`}>{t('signin.passwordHint')}</p>
          ) : null}
          {errors.password ? <p className="auth-error" id={`${passwordId}-error`}>{errors.password}</p> : null}
        </div>

        {errors.form ? <p className="auth-form-error" role="alert">{errors.form}</p> : null}

        <button className="auth-submit" type="submit" disabled={busy}>
          <span>{busy ? t('signin.signingIn') : isCreate ? t('signin.createAction') : t('signin.signInAction')}</span>
          <span className={`auth-submit__arrow${busy ? ' auth-submit__arrow-busy' : ''}`} aria-hidden="true">→</span>
        </button>

        {/* Progress is announced without moving focus. */}
        <p className="sr-only" role="status" aria-live="polite" id={statusId}>{status}</p>
      </form>

      {/* Progressive disclosure: developer sign-in never appears unless the
          environment actually offers it. */}
      {devLoginAvailable ? (
        <div className="auth-dev">
          <p className="auth-dev__notice">{t('signin.devNotice')}</p>
          <button className="auth-dev__button" type="button" onClick={handleDevLogin} disabled={devBusy}>
            {devBusy ? t('signin.signingIn') : t('signin.devAction')}
          </button>
        </div>
      ) : null}
    </>
  );
}