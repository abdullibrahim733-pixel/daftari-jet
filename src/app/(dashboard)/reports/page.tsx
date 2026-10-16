'use client';

import { useEffect, useState } from 'react';

type Summary = {
  data: {
    summary: { cashInMinor: number; cashOutMinor: number; netMinor: number };
    currency: string;
    reviewQueue: { open: number };
  };
};

type Trend = {
  data: {
    buckets: Array<{
      bucketStart: string;
      bucketEnd: string;
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

export default function ReportsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [trend, setTrend] = useState<Trend | null>(null);
  const [cats, setCats] = useState<Categories | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [s, t, c] = await Promise.all([
          fetch('/api/v1/reports/summary').then((r) => r.json()),
          fetch('/api/v1/reports/trend').then((r) => r.json()),
          fetch('/api/v1/reports/categories').then((r) => r.json()),
        ]);
        setSummary(s);
        setTrend(t);
        setCats(c);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) return <p>Loading...</p>;

  return (
    <div>
      <h2 className="text-xl font-semibold">Reports</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Cash In</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.cashInMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Cash Out</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.cashOutMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
        <div className="rounded border border-border p-4">
          <h3 className="text-sm font-medium">Net</h3>
          <p className="mt-1 text-lg">
            {fmt(summary?.data.summary.netMinor ?? 0, summary?.data.currency)}
          </p>
        </div>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-medium">Trend</h3>
          <div className="mt-2 space-y-2">
            {trend?.data.buckets.map((b) => (
              <div key={b.bucketStart} className="flex justify-between text-sm">
                <span>{b.bucketStart}</span>
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
