'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createTranslator } from '@/lib/localization';
import { formatMinor, type Currency } from '@/lib/formatting/money';
import { RECORD_TYPES, SOURCE_KINDS, type ProposalState, type RecordType, type SourceKind } from '@/server/domain/types';

type QueueTab = 'needs_review' | 'needs_details' | 'failed' | 'decided';

type ProposalSummary = {
  id: string;
  state: ProposalState;
  recordType: RecordType;
  sourceKind: SourceKind;
  amountMinor: number | null;
  currency: Currency | null;
  occurredAtHint: string | null;
  customerNameHint: string | null;
  ambiguityNote: string | null;
  missingFields: string[];
  createdAt: string;
};

type QueueResponse = {
  data: {
    proposals: ProposalSummary[];
    counts: Partial<Record<ProposalState, number>>;
    page: {
      hasMore: boolean;
      nextCursor: { createdAt: string; id: string } | null;
    };
  };
  error?: { message?: string };
};

const t = createTranslator('en');
const tabStates: Record<QueueTab, ProposalState[]> = {
  needs_review: ['needs_review', 'duplicate'],
  needs_details: ['needs_details'],
  failed: ['failed'],
  decided: ['confirmed', 'rejected'],
};
const tabs: QueueTab[] = ['needs_review', 'needs_details', 'failed', 'decided'];

function translated(key: string) {
  return t(key as Parameters<typeof t>[0]);
}

function money(minor: number | null, currency: Currency | null): string {
  if (minor === null || currency === null) return t('review.row.amountMissing');
  return formatMinor(minor, { locale: 'en-TZ', currency, showCurrency: true });
}

function receivedDate(value: string): string {
  return new Intl.DateTimeFormat('en-TZ', {
    timeZone: 'Africa/Dar_es_Salaam',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function ReviewQueuePage() {
  const [tab, setTab] = useState<QueueTab>('needs_review');
  const [recordType, setRecordType] = useState('');
  const [sourceKind, setSourceKind] = useState('');
  const [proposals, setProposals] = useState<ProposalSummary[]>([]);
  const [counts, setCounts] = useState<Partial<Record<ProposalState, number>>>({});
  const [nextCursor, setNextCursor] = useState<QueueResponse['data']['page']['nextCursor']>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ limit: '25', states: tabStates[tab].join(',') });
    if (recordType) query.set('recordType', recordType);
    if (sourceKind) query.set('sourceKind', sourceKind);

    void fetch(`/api/v1/review/proposals?${query}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as QueueResponse;
        if (!response.ok || !body.data) throw new Error(body.error?.message ?? t('app.error'));
        setProposals(body.data.proposals);
        setCounts(body.data.counts);
        setHasMore(body.data.page.hasMore);
        setNextCursor(body.data.page.nextCursor);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : t('app.error'));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [recordType, retry, sourceKind, tab]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    const query = new URLSearchParams({
      limit: '25',
      states: tabStates[tab].join(','),
      cursorCreatedAt: nextCursor.createdAt,
      cursorId: nextCursor.id,
    });
    if (recordType) query.set('recordType', recordType);
    if (sourceKind) query.set('sourceKind', sourceKind);
    try {
      const response = await fetch(`/api/v1/review/proposals?${query}`, { cache: 'no-store' });
      const body = (await response.json()) as QueueResponse;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? t('app.error'));
      setProposals((current) => [...current, ...body.data.proposals]);
      setHasMore(body.data.page.hasMore);
      setNextCursor(body.data.page.nextCursor);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('app.error'));
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, nextCursor, recordType, sourceKind, tab]);

  function changeTab(value: QueueTab) {
    setLoading(true);
    setProposals([]);
    setTab(value);
  }

  function changeFilter(kind: 'recordType' | 'sourceKind', value: string) {
    setLoading(true);
    setProposals([]);
    if (kind === 'recordType') setRecordType(value);
    else setSourceKind(value);
  }

  function countForTab(key: QueueTab): number {
    return tabStates[key].reduce((total, state) => total + (counts[state] ?? 0), 0);
  }

  const recordTypeLabel = (type: string) => translated(`common.recordType.${type}`);
  const stateLabel = (state: string) => translated(`common.state.${state}`);
  const sourceLabel = (source: string) => translated(`common.source.${source}`);

  return (
    <div className="review-queue-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('dashboard.workspace')}</p>
          <h1>{t('review.title')}</h1>
          <p className="page-subtitle">{t('review.subtitle')}</p>
        </div>
        <button
          className="button button-secondary"
          type="button"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRetry((current) => current + 1);
          }}
        >
          {t('app.refresh')}
        </button>
      </header>

      <nav className="queue-tabs" aria-label={t('review.title')}>
        {tabs.map((key) => (
          <button
            key={key}
            type="button"
            className={`queue-tab${tab === key ? ' queue-tab-active' : ''}`}
            aria-pressed={tab === key}
            onClick={() => changeTab(key)}
          >
            <span>{t(`review.tab.${key}` as Parameters<typeof t>[0])}</span>
            <span className="queue-tab-count">{countForTab(key)}</span>
          </button>
        ))}
      </nav>

      <div className="queue-filters">
        <label>
          <span>{t('review.filter.type')}</span>
          <select value={recordType} onChange={(event) => changeFilter('recordType', event.target.value)}>
            <option value="">{t('review.filter.all')}</option>
            {RECORD_TYPES.map((type) => <option key={type} value={type}>{recordTypeLabel(type)}</option>)}
          </select>
        </label>
        <label>
          <span>{t('review.filter.source')}</span>
          <select value={sourceKind} onChange={(event) => changeFilter('sourceKind', event.target.value)}>
            <option value="">{t('review.filter.all')}</option>
            {SOURCE_KINDS.map((source) => <option key={source} value={source}>{sourceLabel(source)}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div className="notice notice-error" role="alert">
          <span>{error}</span>
          <button
            className="button button-secondary button-small"
            type="button"
            onClick={() => {
              setLoading(true);
              setRetry((current) => current + 1);
            }}
          >
            {t('app.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="queue-card-list" aria-label={t('app.loading')} aria-busy="true">
          {[1, 2, 3].map((item) => <div className="queue-card queue-card-skeleton" key={item} />)}
        </div>
      ) : !error && proposals.length === 0 ? (
        <section className="panel queue-empty">
          <span className="empty-illustration" aria-hidden="true">✓</span>
          <div>
            <h2>{tab === 'needs_review' && !recordType && !sourceKind ? t('review.empty.title') : t('review.noMatch.title')}</h2>
            <p>{tab === 'needs_review' && !recordType && !sourceKind ? t('review.empty.body') : t('review.noMatch.body')}</p>
          </div>
          {tab === 'needs_review' && !recordType && !sourceKind && (
            <Link className="button button-secondary" href="/record">{t('review.empty.connectCta')}</Link>
          )}
        </section>
      ) : (
        <div className="queue-card-list" aria-live="polite">
          {proposals.map((proposal) => (
            <article className="panel queue-card" key={proposal.id}>
              <div className="queue-card-topline">
                <span className={`state-pill state-${proposal.state}`}>{stateLabel(proposal.state)}</span>
                <time dateTime={proposal.createdAt}>{receivedDate(proposal.createdAt)}</time>
              </div>
              <div className="queue-card-main">
                <div className="queue-card-description">
                  <h2>{recordTypeLabel(proposal.recordType)}</h2>
                  <p>{proposal.ambiguityNote || proposal.customerNameHint || sourceLabel(proposal.sourceKind)}</p>
                </div>
                <strong className="queue-card-amount">{money(proposal.amountMinor, proposal.currency)}</strong>
              </div>
              <div className="queue-card-bottom">
                <div className="queue-card-tags">
                  <span>{sourceLabel(proposal.sourceKind)}</span>
                  {proposal.missingFields.length > 0 && (
                    <span className="queue-warning">
                      {t('review.row.missingFields', { count: proposal.missingFields.length })}
                    </span>
                  )}
                </div>
                <Link className="button button-secondary button-small" href={`/review/${proposal.id}`}>
                  {t('review.row.open')} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </article>
          ))}
          {hasMore && (
            <button className="button button-secondary queue-load-more" type="button" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? t('app.loading') : t('app.showMore')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
