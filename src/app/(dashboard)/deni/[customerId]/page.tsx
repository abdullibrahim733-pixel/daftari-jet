'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

type CustomerDetail = {
  customer: { id: string; displayName: string; contactReference: string | null };
  outstandingMinor: number;
  overdueMinor: number;
  obligations: Array<{
    id: string;
    ledgerRecordId: string;
    originalAmountMinor: number;
    paidMinor: number;
    state: string;
    dueDate: string | null;
  }>;
  payments: Array<{
    id: string;
    amountMinor: number;
    method: string;
    receivedAt: string;
  }>;
};

type Response = { data: CustomerDetail };

function formatMoney(minor: number, currency = 'TZS'): string {
  const major = (minor / 100).toFixed(2);
  return `${currency} ${major}`;
}

export default function CustomerDeniPage() {
  const params = useParams<{ customerId: string }>();
  const customerId = params.customerId;
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!customerId) return;
      try {
        const res = await fetch(`/api/v1/deni/customers/${customerId}`);
        if (!res.ok) throw new Error('Failed to load customer');
        const json: Response = await res.json();
        setData(json.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Error');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [customerId]);

  if (loading) return <p>Loading...</p>;
  if (error) return <p className="text-red-600">{error}</p>;
  if (!data) return null;

  return (
    <div>
      <h2 className="text-xl font-semibold">{data.customer.displayName}</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="font-medium">Summary</h3>
          <dl className="mt-2 space-y-2 text-sm">
            <div>
              <dt className="text-muted">Outstanding</dt>
              <dd>{formatMoney(data.outstandingMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted">Overdue</dt>
              <dd>{formatMoney(data.overdueMinor)}</dd>
            </div>
            <div>
              <dt className="text-muted">Contact</dt>
              <dd>{data.customer.contactReference ?? '-'}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3 className="font-medium">Obligations</h3>
          <div className="mt-2 space-y-2">
            {data.obligations.length === 0 && (
              <p className="text-sm text-muted">No obligations</p>
            )}
            {data.obligations.map((o) => (
              <div key={o.id} className="rounded border border-border p-2 text-sm">
                <p>
                  {formatMoney(o.originalAmountMinor - o.paidMinor)} / {formatMoney(o.originalAmountMinor)} ({o.state})
                </p>
                {o.dueDate && <p className="text-muted">Due: {o.dueDate}</p>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-6">
        <h3 className="font-medium">Payments</h3>
        <div className="mt-2 space-y-2">
          {data.payments.length === 0 && (
            <p className="text-sm text-muted">No payments</p>
          )}
          {data.payments.map((p) => (
            <div key={p.id} className="rounded border border-border p-2 text-sm">
              <p>
                {formatMoney(p.amountMinor)} via {p.method} on {new Date(p.receivedAt).toLocaleDateString()}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
