'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTranslator } from '@/lib/localization';

type Session = {
  data: {
    user: { displayName: string };
    businesses: Array<{ businessId: string; name: string; role: string }>;
    activeBusinessId: string | null;
    permissions: string[];
    devLoginEnabled: boolean;
  };
};

type DevLoginStatus = { data: { enabled: boolean } };

const t = createTranslator('en');

export default function SettingsPage() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [devLoginAvailable, setDevLoginAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devSubject, setDevSubject] = useState('dev-owner');
  const [devName, setDevName] = useState('Daftari Owner');
  const [devBiz, setDevBiz] = useState('Demo Shop');

  async function readSession(): Promise<{ session: Session | null; devLoginAvailable: boolean }> {
    const response = await fetch('/api/v1/session', { cache: 'no-store' });
    if (response.ok) {
      const payload = (await response.json()) as Session;
      return { session: payload, devLoginAvailable: payload.data.devLoginEnabled };
    }
    const statusResponse = await fetch('/api/v1/dev/login', { cache: 'no-store' });
    if (!statusResponse.ok) throw new Error(t('app.error'));
    const status = (await statusResponse.json()) as DevLoginStatus;
    return { session: null, devLoginAvailable: status.data.enabled };
  }

  async function load() {
    try {
      const state = await readSession();
      setSession(state.session);
      setDevLoginAvailable(state.devLoginAvailable);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('app.error'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void readSession()
      .then((state) => {
        if (!active) return;
        setSession(state.session);
        setDevLoginAvailable(state.devLoginAvailable);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : t('app.error'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function devLogin() {
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch('/api/v1/dev/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: devSubject,
          displayName: devName,
          businessName: devBiz,
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? t('app.error'));
      }
      await load();
      router.push('/');
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : t('app.error'));
    } finally {
      setSubmitting(false);
    }
  }

  async function logout() {
    setError(null);
    try {
      const response = await fetch('/api/v1/session', { method: 'DELETE' });
      if (!response.ok) throw new Error(t('app.error'));
      setSession(null);
      await load();
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : t('app.error'));
    }
  }

  if (loading) return <p role="status">{t('app.loading')}</p>;

  return (
    <div className="settings-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('settings.eyebrow')}</p>
          <h1>{t('nav.settings')}</h1>
          <p className="page-subtitle">{t('settings.pageIntro')}</p>
        </div>
      </header>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <div className="settings-sections">
        <section className="panel settings-section">
          <h2>{t('settings.session.title')}</h2>
          {session?.data.user ? (
            <div className="settings-field-list">
              <p>
                <span>{t('settings.session.user')}</span>
                <strong>{session.data.user.displayName}</strong>
              </p>
              <p>
                <span>{t('settings.session.business')}</span>
                <strong>
                  {session.data.businesses.find(
                    (business) => business.businessId === session.data.activeBusinessId,
                  )?.name ?? t('settings.session.none')}
                </strong>
              </p>
              <button onClick={() => void logout()} className="button button-secondary">
                {t('app.signOut')}
              </button>
            </div>
          ) : (
            <p className="settings-note">{t('settings.session.signedOut')}</p>
          )}
        </section>
        {devLoginAvailable && (
          <section className="panel settings-section">
            <h2>{t('settings.devLogin.title')}</h2>
            <p className="settings-note">{t('settings.devLogin.body')}</p>
            <div className="settings-form">
              <label>
                {t('settings.devLogin.name')}
                <input value={devName} onChange={(event) => setDevName(event.target.value)} />
              </label>
              <label>
                {t('settings.devLogin.business')}
                <input value={devBiz} onChange={(event) => setDevBiz(event.target.value)} />
              </label>
              <details>
                <summary>{t('settings.devLogin.advanced')}</summary>
                <label>
                  {t('settings.devLogin.subject')}
                  <input value={devSubject} onChange={(event) => setDevSubject(event.target.value)} />
                </label>
              </details>
              <button
                onClick={() => void devLogin()}
                disabled={submitting || !devName.trim() || !devBiz.trim()}
                className="button button-dark"
              >
                {submitting ? t('settings.devLogin.working') : t('settings.devLogin.submit')}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
