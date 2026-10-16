'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

type RecordDetail = {
  record: {
    id: string;
    recordType: string;
    occurredAt: string;
    currency: string | null;
    amountMinor: number | null;
    status: string;
    version: number;
    description: string | null;
  };
  detail: Record<string, unknown> | null;
  customer: { displayName: string } | null;
  source: { transcript: string | null };
  deni: { outstandingMinor: number; state: string } | null;
  history: unknown[];
};

type Response = { data: RecordDetail };

function formatMoney(minor: number | null, currency: string | null): string {
  if (minor === null || minor === undefined || currency === null || currency === undefined) return '-';
  const major = (minor / 100).toFixed(2);
  return `${currency} ${major}`;
}

export default function RecordDetailPage() {
  const params = useParams<{ recordId: string }>();
  const router = useRouter();
  const recordId = params.recordId;
  const [data, setData] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!recordId) return;
      try {
        const res = await fetch(`/api/v1/records/${recordId}`);
        if (!res.ok) throw new Error('Failed to load record');
        const json: Response = await res.json();
        setData(json.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [recordId]);

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return null;

  const { record, detail, customer, source, deni } = data;

  return (
    <div>
      <h2 className="text-xl font-semibold">Record {record.id}</h2>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <h3 className="font-medium">Details</h3>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="text-muted">Type</dt>
              <dd>{record.recordType}</dd>
            </div>
            <div>
              <dt className="text-muted">Status</dt>
              <dd>{record.status}</dd>
            </div>
            <div>
              <dt className="text-muted">Occurred</dt>
              <dd>{new Date(record.occurredAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted">Amount</dt>
              <dd>{formatMoney(record.amountMinor, record.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted">Customer</dt>
              <dd>{customer?.displayName ?? '-'}</dd>
            </div>
            <div>
              <dt className="text-muted">Description</dt>
              <dd>{record.description ?? '-'}</dd>
            </div>
          </dl>
          {detail && (
            <div className="mt-4">
              <h3 className="font-medium">Detail</h3>
              <pre className="mt-2 max-h-60 overflow-auto rounded bg-surface p-3 text-xs">
                {JSON.stringify(detail, null, 2)}
              </pre>
            </div>
          )}
        </div>
        <div>
          <h3 className="font-medium">Evidence</h3>
          <div className="mt-2 rounded bg-surface p-3 text-sm">
            {source.transcript || 'No transcript'}
          </div>
          {deni && (
            <div className="mt-4">
              <h3 className="font-medium">Deni</h3>
              <p className="text-sm">
                Outstanding: {formatMoney(deni.outstandingMinor, record.currency)} ({deni.state})
              </p>
            </div>
          )}
          <div className="mt-4">
            <button
              onClick={() => router.push(`/records/${recordId}/edit`)}
              className="rounded border border-border px-4 py-2 text-sm hover:bg-surface"
            >
              Correct/Reverse
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
