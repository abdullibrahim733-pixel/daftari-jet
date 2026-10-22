'use client';

import { useEffect, useState } from 'react';

type Summary = {
  data: {
    summary: {
      current: { moneyInMinor: number; moneyOutMinor: number; netCashMovementMinor: number };
    };
    currency: string;
    reviewQueue: { open: number };
  };
};

type Trend = {
  data: {
    buckets: Array<{
      bucket: string;
      salesMinor: number;
      expensesMinor: number;
    }>;
    totals: { salesMinor: number; expensesMinor: number; netMinor: number };
  };
};

type Categories = {
  data: {
    sales: { categories: Array<{ category: string; amountMinor: number; share: number }> };
    expenses: { categories: Array<{ category: string; amountMinor: number; share: number }> };
  };
};

function fmt(minor: number, currency = 'TZS'): string {
  return `${currency} ${(minor / 100).toFixed(2)}`;
}

async function fetchData<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' });
  const body: unknown = await response.json().catch(() => null);
  if (
    !response.ok ||
    typeof body !== 'object' ||
    body === null ||
    !('data' in body)
  ) {
    throw new Error('Unable to load reports. Please try again.');
  }
  return body as T;
}

export default function ReportsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [cats, setCats] = useState<Categories | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [s, t, c] = await Promise.all([
          fetchData<Summary>('/api/v1/reports/summary'),
          fetchData<Trend>('/api/v1/reports/trend'),
          fetchData<Categories>('/api/v1/reports/categories'),
        ]);
        if (active) {
          setSummary(s);
          setTrend(t);
          setCats(c);
          setError(null);
        }
      } catch (loadError) {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load reports. Please try again.');
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [reload]);

  if (loading) return <p>Loading...</p>;
  if (error) {
    return (
      <div>
        <h2 className="text-xl font-semibold">Reports</h2>
        <p className="mt-4 text-sm text-red-600" role="alert">{error}</p>
        <button
          type="button"
          className="mt-3 rounded border border-border px-3 py-2 text-sm"
          onClick={() => {
            setLoading(true);
            setReload((current) => current + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-semibold">Reports</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Cash In</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.current.moneyInMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Cash Out</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.current.moneyOutMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Net</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.current.netCashMovementMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-medium">Trend</h3>
          <div className="mt-2 space-y-2">
            {trend?.data.buckets.map((b) => (
              <div key={b.bucket} className="flex justify-between text-sm">
                <span>{b.bucket}</span>
                <span>
                  {fmt(b.salesMinor - b.expensesMinor, summary?.data.currency)}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3 className="font-medium">Sales by Category</h3>
          <div className="mt-2 space-y-2">
            {cats?.data.sales.categories.map((c) => (
              <div key={c.category} className="flex justify-between text-sm">
                <span>{c.category}</span>
                <span>{fmt(c.amountMinor, summary?.data.currency)}</span>
              </div>
            ))}
          </div>
          <h3 className="mt-4 font-medium">Expenses by Category</h3>
          <div className="mt-2 space-y-2">
            {cats?.data.expenses.categories.map((c) => (
              <div key={c.category} className="flex justify-between text-sm">
                <span>{c.category}</span>
                <span>{fmt(c.amountMinor, summary?.data.currency)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
