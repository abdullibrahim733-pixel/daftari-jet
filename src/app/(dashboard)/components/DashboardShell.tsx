'use client';

/**
 * Dashboard shell: navigation rail, workspace switcher, account menu.
 *
 * Sidebar behaviour
 * -----------------
 * On desktop the rail collapses to icons only and remembers that choice, so the
 * content column gets the full viewport once and stays that way. On a phone the
 * rail is replaced by the bottom tab bar; the collapse control is hidden there
 * because a collapsed rail has no meaning at that width.
 *
 * A11y notes that are easy to regress:
 *  - `aria-expanded` on every disclosure control is kept in sync by a single
 *    helper, so screen readers never report a stale state.
 *  - Menus close on Escape and return focus to the control that opened them.
 *  - The workspace switcher is a real `<select>`, so it is keyboard operable
 *    and announced correctly; the chevron beside it is decoration only.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createTranslator } from '@/lib/localization';

type Business = {
  businessId: string;
  name: string;
  role: string;
};

type SessionPayload = {
  data: {
    user: { displayName: string };
    businesses: Business[];
    activeBusinessId: string | null;
    devLoginEnabled: boolean;
  };
};

const t = createTranslator('en');

const NAV_ITEMS = [
  { href: '/record', key: 'record', icon: '●', mobile: true },
  { href: '/reports', key: 'reports', icon: '▥', mobile: true },
  { href: '/review', key: 'review', icon: '◷', mobile: true },
  { href: '/records', key: 'records', icon: '▤', mobile: true },
  { href: '/deni', key: 'deni', icon: '◎', mobile: false },
  { href: '/inventory', key: 'inventory', icon: '▙', mobile: false },
  { href: '/overview', key: 'overview', icon: '◫', mobile: false },
  { href: '/settings', key: 'settings', icon: '⚙', mobile: false },
] as const;
const NAV_LINKS = NAV_ITEMS;

const NAV_LABELS = {
  overview: 'nav.overview',
  record: 'nav.record',
  review: 'nav.review',
  records: 'nav.records',
  deni: 'nav.deni',
  inventory: 'nav.inventory',
  reports: 'nav.reports',
  settings: 'nav.settings',
} as const;

const COLLAPSE_STORAGE_KEY = 'daftari.nav.collapsed';

/** Same-tab notification for the rail state; `storage` covers other tabs. */
const COLLAPSE_EVENT = 'daftari:nav-collapse';

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    // Private browsing can throw on storage access. The expanded default is a
    // fine outcome, so the failure is swallowed deliberately.
    return false;
  }
}

function subscribeToCollapsed(onStoreChange: () => void): () => void {
  window.addEventListener(COLLAPSE_EVENT, onStoreChange);
  window.addEventListener('storage', onStoreChange);
  return () => {
    window.removeEventListener(COLLAPSE_EVENT, onStoreChange);
    window.removeEventListener('storage', onStoreChange);
  };
}

function routeIsActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

export default function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const [session, setSession] = useState<SessionPayload['data'] | null>(null);
  const [sessionIssue, setSessionIssue] = useState<'unauthenticated' | 'network' | null>(null);
  const [switching, setSwitching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [reviewCount, setReviewCount] = useState(0);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // The rail width is external state (localStorage), so it is read through
  // useSyncExternalStore rather than mirrored into an effect. The server
  // snapshot is the expanded rail; React swaps to the stored value right after
  // hydration, so there is no markup mismatch.
  const collapsed = useSyncExternalStore(subscribeToCollapsed, readCollapsed, () => false);

  const profileButtonRef = useRef<HTMLButtonElement | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  const toggleCollapsed = useCallback(() => {
    const next = readCollapsed() ? '0' : '1';
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next);
    } catch {
      // Persistence is a convenience, never a requirement.
    }
    window.dispatchEvent(new Event(COLLAPSE_EVENT));
  }, []);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const response = await fetch('/api/v1/session', { cache: 'no-store' });
        if (!response.ok) {
          if (active) {
            setSessionIssue(response.status === 401 ? 'unauthenticated' : 'network');
          }
          return;
        }
        const payload = (await response.json()) as SessionPayload;
        if (active) {
          setSession(payload.data);
          setSessionIssue(null);
        }
      } catch {
        if (active) setSessionIssue('network');
      }
    }

    async function loadReviewCount() {
      try {
        const response = await fetch('/api/v1/review/proposals?limit=1', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          data: { counts: Record<string, number> };
        };
        const counts = payload.data.counts;
        if (active) {
          setReviewCount((counts.needs_review ?? 0) + (counts.needs_details ?? 0) + (counts.duplicate ?? 0));
        }
      } catch {
        if (active) setReviewCount(0);
      }
    }

    void loadSession();
    void loadReviewCount();
    return () => { active = false; };
  }, [pathname]);

  // Escape closes whichever menu is open and hands focus back to its trigger,
  // so keyboard users are never dropped at the top of the document.
  useEffect(() => {
    if (!menuOpen && !moreOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (moreOpen) {
        setMoreOpen(false);
        moreButtonRef.current?.focus();
      } else {
        setMenuOpen(false);
        profileButtonRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [menuOpen, moreOpen]);

  const activeBusiness = session?.businesses.find((business) => business.businessId === session.activeBusinessId)
    ?? session?.businesses[0];

  const activeNavItem = NAV_ITEMS.find((item) => routeIsActive(pathname, item.href));
  const booting = session === null && sessionIssue === null;

  async function changeBusiness(businessId: string) {
    setSwitching(true);
    setSwitchError(null);
    try {
      const response = await fetch('/api/v1/session/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ businessId }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? t('app.error'));
      }
      // A full navigation is required: every server render and every client
      // cache in the app is scoped to the active business. `router.refresh()`
      // alone would leave stale data behind, and calling both (as this once did)
      // just did the work twice.
      window.location.assign('/');
    } catch (error) {
      setSwitching(false);
      setSwitchError(error instanceof Error ? error.message : t('app.error'));
    }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await fetch('/api/v1/session', { method: 'DELETE', cache: 'no-store' });
    } catch {
      // The cookie is cleared server-side on success; a network failure here
      // still redirects so the user is never stranded on a signed-in shell.
    }
    window.location.assign('/login');
  }

  const shellClass = [
    'dashboard-frame',
    collapsed ? 'dashboard-frame-collapsed' : '',
    booting ? 'dashboard-frame-booting' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={shellClass}>
      <a className="skip-link" href="#main-content">{t('app.skipToContent')}</a>

      <aside
        className="sidebar"
        aria-label={t('nav.primary')}
        data-collapsed={collapsed ? 'true' : 'false'}
      >
        <div className="sidebar__top">
          <Link className="brand-lockup" href="/" aria-label={t('app.name')}>
            <span className="brand-mark" aria-hidden="true">d</span>
            <span className="brand-name">daftari<span>.</span></span>
          </Link>

          <button
            className="sidebar-toggle"
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="primary-navigation"
            aria-label={collapsed ? t('app.expandNav') : t('app.collapseNav')}
            title={collapsed ? t('app.expandNav') : t('app.collapseNav')}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                d={collapsed ? 'M6 3.5 10.5 8 6 12.5' : 'M10 3.5 5.5 8 10 12.5'}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>

        <div className="workspace-label">{t('dashboard.workspace')}</div>
        <div className="workspace-switcher">
          <span className="workspace-avatar" aria-hidden="true">{initials(activeBusiness?.name ?? 'D')}</span>
          <label className="workspace-select-wrap">
            <span className="sr-only">{t('nav.switchBusiness')}</span>
            {session?.businesses.length ? (
              <select
                value={activeBusiness?.businessId ?? ''}
                aria-label={t('nav.switchBusiness')}
                disabled={switching}
                onChange={(event) => void changeBusiness(event.target.value)}
              >
                {session.businesses.map((business) => (
                  <option key={business.businessId} value={business.businessId}>{business.name}</option>
                ))}
              </select>
            ) : (
              <span className="workspace-placeholder">
                {sessionIssue === 'unauthenticated' ? t('dashboard.signInRequired') : t('dashboard.loadingBusiness')}
              </span>
            )}
            {session?.businesses.length ? <span className="workspace-role">{activeBusiness?.role ?? ''}</span> : null}
          </label>
          <span className="workspace-chevron" aria-hidden="true">⌄</span>
        </div>

        <nav className="primary-nav" id="primary-navigation" aria-label={t('nav.menu')}>
          <p className="nav-section-title" aria-hidden="true">{t('nav.menu')}</p>
          {NAV_ITEMS.map((item) => {
            const active = routeIsActive(pathname, item.href);
            const label = t(NAV_LABELS[item.key]);
            return (
              <Link
                className={`nav-link${active ? ' nav-link-active' : ''}`}
                href={item.href}
                key={item.key}
                aria-current={active ? 'page' : undefined}
                // Collapsed rail: the accessible name has to survive, because the
                // visible label is hidden with the rest of the row.
                aria-label={collapsed ? label : undefined}
                data-mobile={item.mobile}
                title={collapsed ? label : undefined}
              >
                <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                <span className="nav-text">{label}</span>
                {item.key === 'review' && reviewCount > 0 ? (
                  <span className="nav-count" aria-label={t('nav.reviewBadge', { count: reviewCount })}>{reviewCount}</span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-help">
            <span className="help-orbit" aria-hidden="true">?</span>
            <div className="sidebar-help__text">
              <strong>{t('dashboard.needHelp')}</strong>
              <span>{t('dashboard.helpPrompt')}</span>
            </div>
            <Link href="/settings" aria-label={t('app.help')}>↗</Link>
          </div>
          <div className="profile-row">
            <span className="profile-avatar" aria-hidden="true">{initials(session?.user.displayName ?? 'D')}</span>
            <span className="profile-info">
              <strong>{session?.user.displayName ?? t('dashboard.account')}</strong>
              <small>{activeBusiness?.role ?? t('dashboard.workspace')}</small>
            </span>
            <Link className="profile-settings" href="/settings" aria-label={t('nav.settings')}>···</Link>
          </div>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="topbar">
          <div className="topbar-mobile-brand">
            <Link className="brand-lockup" href="/" aria-label={t('app.name')}>
              <span className="brand-mark" aria-hidden="true">d</span>
              <span className="brand-name">daftari<span>.</span></span>
            </Link>
          </div>
          <div className="topbar-context">
            <span className="context-dot" aria-hidden="true" />
            <span>{activeBusiness?.name ?? t('dashboard.workspace')}</span>
            <span className="context-divider" aria-hidden="true">/</span>
            <span className="context-page">
              {activeNavItem ? t(NAV_LABELS[activeNavItem.key]) : t('nav.menu')}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="connection-status"><i aria-hidden="true" />{t('dashboard.captureStatus')}</span>
            <Link className="topbar-icon-button" href="/settings" aria-label={t('app.help')}>?</Link>
            <button
              ref={profileButtonRef}
              className="topbar-profile"
              type="button"
              aria-label={t('app.account')}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              onClick={() => { setMenuOpen((open) => !open); setMoreOpen(false); }}
            >
              <span aria-hidden="true">{initials(session?.user.displayName ?? 'D')}</span>
              <span aria-hidden="true">⌄</span>
            </button>
            {menuOpen && (
              <div className="account-menu" role="menu" aria-label={t('app.account')}>
                <strong className="account-menu__name">{session?.user.displayName ?? t('dashboard.account')}</strong>
                <Link role="menuitem" href="/settings" onClick={() => setMenuOpen(false)}>{t('nav.settings')}</Link>
                <button
                  role="menuitem"
                  type="button"
                  className="account-menu__signout"
                  onClick={() => void signOut()}
                  disabled={signingOut}
                >
                  {t('app.signOut')}
                </button>
              </div>
            )}
          </div>
        </header>

        {sessionIssue && (
          <div className={`session-banner${sessionIssue === 'network' ? ' session-banner-error' : ''}`} role={sessionIssue === 'network' ? 'alert' : 'status'}>
            <span>{t(sessionIssue === 'unauthenticated' ? 'dashboard.signInRequiredBody' : 'dashboard.sessionUnavailable')}</span>
            <Link href="/login">{t('app.signIn')} <span aria-hidden="true">→</span></Link>
          </div>
        )}
        {switchError && <p className="switch-error" role="alert">{switchError}</p>}

        <main id="main-content" className="page-content" aria-busy={booting ? true : undefined}>
          {children}
        </main>
      </div>

      <nav className="mobile-nav" aria-label={t('nav.mobile')}>
        {NAV_ITEMS.filter((item) => item.mobile).map((item) => {
          const active = routeIsActive(pathname, item.href);
          return (
            <Link
              className={`mobile-nav-link${active ? ' mobile-nav-link-active' : ''}`}
              href={item.href}
              key={item.key}
              aria-current={active ? 'page' : undefined}
            >
              <span aria-hidden="true">{item.icon}</span>
              <small>{t(NAV_LABELS[item.key])}</small>
            </Link>
          );
        })}
        <button
          ref={moreButtonRef}
          className={`mobile-nav-link${moreOpen ? ' mobile-nav-link-active' : ''}`}
          type="button"
          onClick={() => { setMoreOpen((open) => !open); setMenuOpen(false); }}
          aria-expanded={moreOpen}
          aria-haspopup="true"
        >
          <span aria-hidden="true">···</span><small>{t('app.more')}</small>
        </button>
      </nav>

      {moreOpen && (
        <div className="mobile-more-menu" role="menu" aria-label={t('app.more')}>
          {NAV_LINKS.filter((item) => !item.mobile).map((item) => (
            <Link role="menuitem" href={item.href} key={item.key} onClick={() => setMoreOpen(false)}>
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>{t(NAV_LABELS[item.key])}
            </Link>
          ))}
        </div>
      )}

      {(menuOpen || moreOpen) && (
        <button
          className="menu-dismiss"
          type="button"
          aria-label={t('app.close')}
          onClick={() => { setMenuOpen(false); setMoreOpen(false); }}
        />
      )}
    </div>
  );
}