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
};

type Response = { data: RecordDetail };

export default function RecordCorrectionPage() {
  const params = useParams<{ recordId: string }>();
  const router = useRouter();
  const recordId = params.recordId;
  const [data, setData] = useState<RecordDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<'correct' | 'reverse'>('correct');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('correction');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function load() {
      if (!recordId) return;
      try {
        const res = await fetch(`/api/v1/records/${recordId}`);
        if (!res.ok) throw new Error('Failed to load record');
        const json: Response = await res.json();
        setData(json.data);
        setAmount(
          json.data.record.amountMinor !== null
            ? (json.data.record.amountMinor / 100).toFixed(2)
            : '',
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [recordId]);

  async function submit() {
    if (!data) return;
    setSubmitting(true);
    try {
      const body: {
        action: 'correct' | 'reverse';
        expectedVersion: number;
        reasonCode: string;
        reasonNote: string | null;
        fields?: { amountMinor: number };
      } = {
        action,
        expectedVersion: data.record.version,
        reasonCode: reason,
        reasonNote: note || null,
      };
      if (action === 'correct') {
        body.fields = {
          amountMinor: Math.round(parseFloat(amount) * 100),
        };
      }
      const res = await fetch(`/api/v1/records/${recordId}/corrections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to apply correction');
      router.push(`/records/${recordId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return null;

  return (
    <div>
      <h2 className="text-xl font-semibold">Correct/Reverse Record</h2>
      <div className="mt-4 max-w-md space-y-4">
        <div>
          <label className="block text-sm font-medium">Action</label>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as 'correct' | 'reverse')}
            className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
          >
            <option value="correct">Correct</option>
            <option value="reverse">Reverse</option>
          </select>
        </div>
        {action === 'correct' && (
          <div>
            <label className="block text-sm font-medium">Amount (major)</label>
            <input
              type="number"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
            />
          </div>
        )}
        <div>
          <label className="block text-sm font-medium">Reason Code</label>
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-sm font-medium">Note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background p-2 text-sm"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={submit}
            disabled={submitting}
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            Submit
          </button>
          <button
            onClick={() => router.push(`/records/${recordId}`)}
            className="rounded border border-border px-4 py-2 text-sm hover:bg-surface"
          >
            Cancel
          </button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
    </div>
  );
}
