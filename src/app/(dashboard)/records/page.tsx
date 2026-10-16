'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type RecordSummary = {
  id: string;
  recordType: string;
  occurredAt: string;
  currency: string | null;
  amountMinor: number | null;
  status: string;
  customerName: string | null;
};

type Response = {
  data: {
    records: RecordSummary[];
  };
};

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor === null || minor === undefined || currency === null || currency === undefined) return '-';
  const major = (minor / 100).toFixed(2);
  return `${currency} ${major}`;
}

export default function RecordsListPage() {
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/v1/records');
        if (!res.ok) throw new Error('Failed to load records');
        const json: Response = await res.json();
        setRecords(json.data.records);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  return (
    <div>
      <h2 className="text-xl font-semibold">Records</h2>
      {loading && <p className="mt-4 text-sm text-muted">Loading...</p>}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!loading && !error && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border border-border">
            <thead className="bg-surface">
              <tr>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Occurred
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Type
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Amount
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Status
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Customer
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-sm text-muted"
                  >
                    No records found
                  </td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {new Date(r.occurredAt).toLocaleString()}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {r.recordType}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {formatMoney(r.amountMinor, r.currency)}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {r.status}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {r.customerName ?? '-'}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    <Link
                      href={`/records/${r.id}`}
                      className="text-primary hover:underline"
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
