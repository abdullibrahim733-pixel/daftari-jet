'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatMinor } from '@/lib/formatting/money';
import { createTranslator } from '@/lib/localization';

type Period = 'today' | '7d' | '30d' | 'month';

type SummaryData = {
  currency: string;
  timezone: string;
  summary: {
    current: {
      salesReceivedMinor: number;
      expensesMinor: number;
      netCashMovementMinor: number;
      confirmedCount: number;
    };
    growthPercent: { moneyIn: number | null; moneyOut: number | null };
  };
  deni: { outstandingMinor: number; customersWithBalance: number } | null;
  reviewQueue: { open: number };
};

type TrendData = {
  buckets: Array<{ bucket: string; salesMinor: number; expensesMinor: number }>;
};

type LedgerRecord = {
  id: string;
  recordType: string;
  occurredAt: string;
  currency: string | null;
  amountMinor: number | null;
  status: string;
  origin: string;
  description: string | null;
  customerName: string | null;
};

type ReviewProposal = {
  createdAt: string;
};

type SessionData = {
  user: { displayName: string };
  businesses: Array<{ businessId: string; timezone: string }>;
  activeBusinessId: string | null;
};

type DashboardData = {
  summary: SummaryData;
  trend: TrendData;
  records: LedgerRecord[];
  proposals: ReviewProposal[];
  oldestWait: string | null;
  loadedAt: string;
};

type ApiEnvelope<T> = { data: T };

const t = createTranslator('en');
const PERIODS: Period[] = ['today', '7d', '30d', 'month'];

function businessDate(timeZone: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateMinusDays(date: string, days: number): string {
  const instant = new Date(`${date}T00:00:00.000Z`);
  instant.setUTCDate(instant.getUTCDate() - days);
  return instant.toISOString().slice(0, 10);
}

function selectedRange(period: Period, timeZone: string): { from: string; to: string } {
  const today = businessDate(timeZone);
  if (period === 'today') return { from: today, to: today };
  if (period === '7d') return { from: dateMinusDays(today, 6), to: today };
  if (period === '30d') return { from: dateMinusDays(today, 29), to: today };
  const monthStart = `${today.slice(0, 7)}-01`;
  return { from: monthStart, to: today };
}

async function getData<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as
    | (ApiEnvelope<T> & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(body?.error?.message ?? t('app.error'));
  }
  if (!body || !('data' in body)) throw new Error(t('app.error'));
  return body.data;
}

async function fetchDashboardData(range: { from: string; to: string }): Promise<DashboardData> {
  const query = new URLSearchParams({ from: range.from, to: range.to });
  const [summary, trend, records, proposals] = await Promise.all([
    getData<SummaryData>(`/api/v1/reports/summary?${query}`),
    getData<TrendData>(`/api/v1/reports/trend?${query}&granularity=day`),
    getData<{ records: LedgerRecord[] }>(`/api/v1/records?${query}&statuses=posted&limit=6`),
    getData<{ proposals: ReviewProposal[] }>('/api/v1/review/proposals?limit=1'),
  ]);
  return {
    summary,
    trend,
    records: records.records,
    proposals: proposals.proposals,
    oldestWait: proposals.proposals[0] ? relativeWait(proposals.proposals[0].createdAt) : null,
    loadedAt: new Date().toISOString(),
  };
}

function money(minor: number | null | undefined, currency = 'TZS'): string {
  if (minor === null || minor === undefined) return '—';
  return formatMinor(minor, {
    locale: 'en-TZ',
    currency: currency === 'TZS' ? 'TZS' : undefined,
    showCurrency: true,
  });
}

function recordTypeLabel(recordType: string): string {
  const key = `common.recordType.${recordType}` as Parameters<typeof t>[0];
  return t(key);
}

function periodDescription(period: Period): string {
  return t(`overview.period.${period}` as Parameters<typeof t>[0]);
}

function formatDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-TZ', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatBucket(bucket: string, timeZone: string): string {
  const date = new Date(`${bucket}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return bucket;
  return new Intl.DateTimeFormat('en-TZ', {
    timeZone,
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function greeting(name: string, timeZone: string): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(new Date()),
  );
  const key =
    hour < 12
      ? 'overview.greetingMorning'
      : hour < 17
        ? 'overview.greetingAfternoon'
        : 'overview.greetingEvening';
  return t(key, { name });
}

function relativeWait(createdAt: string): string {
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(createdAt)) / 86_400_000));
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-days, 'day');
}

function StatCard({
  label,
  value,
  detail,
  tone,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  tone: 'crimson' | 'green' | 'blue' | 'orange';
  icon: string;
}) {
  return (
    <article className="stat-card">
      <div className="stat-card-top">
        <span className={`stat-icon stat-icon-${tone}`} aria-hidden="true">
          {icon}
        </span>
        <span className="stat-label">{label}</span>
        <span className="stat-info" title={detail} aria-label={`${t('overview.kpi.howCalculated')}: ${detail}`}>
          i
        </span>
      </div>
      <p className="stat-value tabular">{value}</p>
      <p className="stat-detail">{detail}</p>
    </article>
  );
}

function CashChart({
  buckets,
  timeZone,
}: {
  buckets: TrendData['buckets'];
  timeZone: string;
}) {
  const [showTable, setShowTable] = useState(false);
  const maxValue = Math.max(
    1,
    ...buckets.flatMap((bucket) => [bucket.salesMinor, bucket.expensesMinor]),
  );

  if (buckets.length === 0) {
    return <p className="chart-empty">{t('overview.noRecordsInPeriod')}</p>;
  }

  return (
    <div>
      <div className="chart-legend" aria-hidden="true">
        <span><i className="legend-dot legend-sales" />{t('overview.chart.sales')}</span>
        <span><i className="legend-dot legend-expenses" />{t('overview.chart.expenses')}</span>
      </div>
      <div className="chart-plot" role="img" aria-label={t('overview.chart.description', { granularity: 'day' })}>
        {buckets.map((bucket) => (
          <div className="chart-column" key={bucket.bucket}>
            <div className="bar-pair">
              <span
                className="chart-bar chart-bar-sales"
                style={{ height: bucket.salesMinor ? `${Math.max(4, (bucket.salesMinor / maxValue) * 100)}%` : '0%' }}
                title={`${t('overview.chart.sales')}: ${money(bucket.salesMinor)}`}
              />
              <span
                className="chart-bar chart-bar-expenses"
                style={{ height: bucket.expensesMinor ? `${Math.max(4, (bucket.expensesMinor / maxValue) * 100)}%` : '0%' }}
                title={`${t('overview.chart.expenses')}: ${money(bucket.expensesMinor)}`}
              />
            </div>
            <span className="chart-label">{formatBucket(bucket.bucket, timeZone)}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="text-action chart-table-toggle"
        aria-expanded={showTable}
        onClick={() => setShowTable((shown) => !shown)}
      >
        {t(showTable ? 'overview.chart.hideTable' : 'overview.chart.showTable')}
      </button>
      {showTable && (
        <div className="chart-table-wrap">
          <table className="data-table chart-data-table">
            <caption className="sr-only">{t('overview.chart.description', { granularity: 'day' })}</caption>
            <thead><tr><th>{t('app.date')}</th><th>{t('overview.chart.sales')}</th><th>{t('overview.chart.expenses')}</th></tr></thead>
            <tbody>
              {buckets.map((bucket) => (
                <tr key={bucket.bucket}>
                  <td>{formatBucket(bucket.bucket, timeZone)}</td>
                  <td className="tabular">{money(bucket.salesMinor)}</td>
                  <td className="tabular">{money(bucket.expensesMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DashboardHome() {
  const [period, setPeriod] = useState<Period>('30d');
  const [data, setData] = useState<DashboardData | null>(null);
  const [timeZone, setTimeZone] = useState('Africa/Dar_es_Salaam');
  const [userName, setUserName] = useState(t('dashboard.ownerFallback'));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => selectedRange(period, timeZone), [period, timeZone]);

  useEffect(() => {
    let active = true;
    void fetchDashboardData(range)
      .then((result) => {
        if (active) {
          setData(result);
          setError(null);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : t('app.error'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [range]);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      try {
        const response = await fetch('/api/v1/session', { cache: 'no-store' });
        if (!response.ok) return;
        const payload = await response.json() as ApiEnvelope<SessionData>;
        const business = payload.data.businesses.find(
          (entry) => entry.businessId === payload.data.activeBusinessId,
        ) ?? payload.data.businesses[0];
        if (active) {
          setUserName(payload.data.user.displayName);
          if (business?.timezone) setTimeZone(business.timezone);
        }
      } catch {
        if (active) setError(t('dashboard.sessionUnavailable'));
      }
    }
    void loadSession();
    return () => { active = false; };
  }, []);

  const summary = data?.summary;
  const current = summary?.summary.current;
  const currency = summary?.currency ?? 'TZS';
  const activeTimeZone = summary?.timezone ?? timeZone;
  const hasRecords = (current?.confirmedCount ?? 0) > 0;
  const retry = useCallback(() => {
    setLoading(true);
    setError(null);
    void fetchDashboardData(range)
      .then(setData)
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : t('app.error')))
      .finally(() => setLoading(false));
  }, [range]);

  return (
    <div className="overview-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">{t('overview.eyebrow')}</p>
          <h1>{greeting(userName, activeTimeZone)}</h1>
          <p className="page-subtitle">
            {summary
              ? t('overview.subtitle', { count: current?.confirmedCount ?? 0 })
              : t('overview.pageIntro')}
          </p>
        </div>
        <label className="period-select">
          <span>{t('overview.period.label')}</span>
          <select
            value={period}
            onChange={(event) => {
              setLoading(true);
              setPeriod(event.target.value as Period);
            }}
            aria-label={t('overview.period.label')}
          >
            {PERIODS.map((value) => <option value={value} key={value}>{periodDescription(value)}</option>)}
          </select>
        </label>
      </header>

      {error && (
        <div className="notice notice-error" role="alert">
          <div><strong>{t('app.error')}</strong><p>{error}</p></div>
          <button className="button button-secondary button-small" type="button" onClick={retry}>
            {t('app.retry')}
          </button>
        </div>
      )}

      {loading && !data ? (
        <div className="loading-grid" aria-label={t('app.loading')} aria-busy="true">
          <div className="skeleton-card" /><div className="skeleton-card" /><div className="skeleton-card" /><div className="skeleton-card" />
          <div className="skeleton-panel" /><div className="skeleton-panel" />
        </div>
      ) : data ? (
        <>
          <section className={`review-banner ${summary?.reviewQueue.open ? 'review-banner-action' : ''}`} aria-live="polite">
            <div className="review-banner-mark" aria-hidden="true">{summary?.reviewQueue.open ? '!' : '✓'}</div>
            <div className="review-banner-copy">
              <h2>
                {summary?.reviewQueue.open
                  ? t(summary.reviewQueue.open === 1 ? 'overview.reviewCardSingle' : 'overview.reviewCardTitle', { count: summary.reviewQueue.open })
                  : t('overview.reviewClearTitle')}
              </h2>
              <p>
                {summary?.reviewQueue.open
                  ? t('overview.reviewCardBody')
                  : t('overview.reviewClearBody')}
                {summary?.reviewQueue.open && data.oldestWait
                  ? ` ${t('overview.reviewCardOldest', { duration: data.oldestWait })}.`
                  : ''}
              </p>
            </div>
            <Link className="button button-dark" href="/review">
              {summary?.reviewQueue.open ? t('overview.reviewCardCta') : t('overview.openReview')}
              <span aria-hidden="true">→</span>
            </Link>
          </section>

          {!hasRecords && (
            <section className="empty-state">
              <div className="empty-illustration" aria-hidden="true">
                <span className="empty-paper">≡</span><span className="empty-wave">⌁</span>
              </div>
              <div>
                <p className="eyebrow">{t('overview.empty.eyebrow')}</p>
                <h2>{t('overview.empty.periodTitle')}</h2>
                <p>{t('overview.empty.body')}</p>
              </div>
              <Link href="/settings" className="text-action">{t('review.empty.connectCta')} <span aria-hidden="true">↗</span></Link>
            </section>
          )}

          <section className="stats-grid" aria-label={t('overview.kpi.heading')}>
            <StatCard
              label={t('overview.kpi.salesReceived')}
              value={money(current?.salesReceivedMinor, currency)}
              detail={t('overview.kpi.salesReceivedCalc', { period: periodDescription(period).toLowerCase() })}
              tone="orange"
              icon="↗"
            />
            <StatCard
              label={t('overview.kpi.expenses')}
              value={money(current?.expensesMinor, currency)}
              detail={t('overview.kpi.expensesCalc', { period: periodDescription(period).toLowerCase() })}
              tone="blue"
              icon="↘"
            />
            <StatCard
              label={t('overview.kpi.netCashMovement')}
              value={money(current?.netCashMovementMinor, currency)}
              detail={t('overview.kpi.netCalc')}
              tone="green"
              icon="≈"
            />
            <StatCard
              label={t('overview.kpi.outstandingDeni')}
              value={summary?.deni ? money(summary.deni.outstandingMinor, currency) : '—'}
              detail={t(summary?.deni ? 'overview.kpi.deniCalc' : 'overview.kpi.deniUnavailable')}
              tone="crimson"
              icon="◎"
            />
          </section>

          {hasRecords ? (
            <div className="overview-columns">
              <section className="panel chart-panel">
                <div className="panel-heading">
                  <div><h2>{t('overview.chart.title')}</h2><p>{t('overview.chart.description', { granularity: 'day' })}</p></div>
                  <span className="range-chip">{periodDescription(period)}</span>
                </div>
                  <CashChart buckets={data.trend.buckets} timeZone={activeTimeZone} />
              </section>

              <section className="panel activity-panel">
                <div className="panel-heading panel-heading-inline">
                  <div><h2>{t('overview.recent.title')}</h2><p>{t('overview.recent.subtitle')}</p></div>
                  <Link href="/records" className="text-action">{t('app.viewAll')} <span aria-hidden="true">→</span></Link>
                </div>
                {data.records.length > 0 ? (
                  <div className="activity-list">
                    {data.records.map((record) => (
                      <Link className="activity-row" href={`/records/${record.id}`} key={record.id}>
                        <span className={`record-mark record-mark-${record.recordType}`} aria-hidden="true">
                          {record.recordType === 'expense' ? '−' : record.recordType === 'debt_payment' ? '↙' : '+'}
                        </span>
                        <span className="activity-description">
                          <strong>{record.description || record.customerName || recordTypeLabel(record.recordType)}</strong>
                          <small>{recordTypeLabel(record.recordType)} · {formatDate(record.occurredAt, activeTimeZone)}</small>
                        </span>
                        <span className="activity-amount tabular">{money(record.amountMinor, record.currency ?? currency)}</span>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="chart-empty">{t('overview.noRecordsInPeriod')}</p>
                )}
              </section>
            </div>
          ) : null}
          <p className="freshness-note">
            <span className="freshness-dot" aria-hidden="true" />
            {t('overview.dataAsOf', { when: formatDate(data.loadedAt, activeTimeZone), timezone: activeTimeZone })}
            <span>·</span>{t('overview.confirmedOnly')}
          </p>
        </>
      ) : null}
    </div>
  );
}
