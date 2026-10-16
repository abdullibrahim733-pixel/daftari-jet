'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type DeniCustomer = {
  customerId: string;
  customerName: string;
  balanceMinor: number;
  overdue: boolean;
  overdueMinor?: number;
  oldestDebtDate: string | null;
  dueDate: string | null;
  obligationCount: number;
};

type Response = {
  data: {
    customers: DeniCustomer[];
    totalOutstandingMinor: number;
  };
};

function formatMoney(minor: number, currency = 'TZS'): string {
  const major = (minor / 100).toFixed(2);
  return `${currency} ${major}`;
}

export default function DeniPage() {
  const [customers, setCustomers] = useState<DeniCustomer[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/v1/deni/customers');
        if (!res.ok) throw new Error('Failed to load deni');
        const json: Response = await res.json();
        setCustomers(json.data.customers);
        setTotal(json.data.totalOutstandingMinor);
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
      <h2 className="text-xl font-semibold">Deni</h2>
      <p className="mt-2 text-sm text-muted">
        Total Outstanding: {formatMoney(total)}
      </p>
      {loading && <p className="mt-4 text-sm text-muted">Loading...</p>}
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
      {!loading && !error && (
        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full border border-border">
            <thead className="bg-surface">
              <tr>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Customer
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Balance
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Overdue
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Obligations
                </th>
                <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {customers.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-8 text-center text-sm text-muted"
                  >
                    No outstanding balances
                  </td>
                </tr>
              )}
              {customers.map((c) => (
                <tr key={c.customerId}>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {c.customerName}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {formatMoney(c.balanceMinor)}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {c.overdue ? 'Yes' : 'No'}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    {c.obligationCount}
                  </td>
                  <td className="border-b border-border px-4 py-2 text-sm">
                    <Link
                      href={`/deni/${c.customerId}`}
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
