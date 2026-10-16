'use client';

import { useCallback, useEffect, useState } from 'react';
import { createTranslator } from '@/lib/localization';

const t = createTranslator('en');

type InventoryItem = {
  itemId: string;
  name: string;
  unit: string;
  sku: string | null;
  onHandMilli: number;
  lowStock: boolean;
  lowStockThresholdMilli: number | null;
  lastMovementAt: string | null;
};

type Overview = {
  items: InventoryItem[];
  trackedItems: number;
  lowStockCount: number;
};

type Response = {
  data: {
    enabled: boolean;
    overview: Overview | null;
  };
};

function formatQuantity(milli: number): string {
  if (!Number.isFinite(milli)) return '0';
  const quantity = milli / 1000;
  return Number.isInteger(quantity)
    ? String(quantity)
    : quantity.toFixed(3).replace(/\.?0+$/, '');
}

async function fetchInventory(): Promise<Response['data']> {
  const res = await fetch('/api/v1/inventory/items', { cache: 'no-store' });
  if (!res.ok) throw new Error(t('inventory.loadFailed'));
  const json: Response = await res.json();
  return json.data;
}

export default function InventoryPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [unit, setUnit] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await fetchInventory();
    setEnabled(data.enabled);
    setOverview(data.overview);
  }, []);

  useEffect(() => {
    let active = true;
    fetchInventory()
      .then((data) => {
        if (!active) return;
        setEnabled(data.enabled);
        setOverview(data.overview);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (active) {
          setError(loadError instanceof Error ? loadError.message : t('app.error'));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const addItem = useCallback(async () => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch('/api/v1/inventory/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ name, unit }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? t('inventory.addFailed'));
      }
      setName('');
      setUnit('');
      await load();
    } catch (createErr) {
      setCreateError(createErr instanceof Error ? createErr.message : t('app.error'));
    } finally {
      setCreating(false);
    }
  }, [name, unit, load]);

  if (loading) return <p role="status">{t('app.loading')}…</p>;

  if (enabled === false) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h2 className="text-xl font-semibold">{t('inventory.gated.title')}</h2>
        <p className="mt-2 text-sm text-muted">{t('inventory.gated.body')}</p>
      </div>
    );
  }

  const items = overview?.items ?? [];
  const lowStockCount = overview?.lowStockCount ?? 0;

  return (
    <div>
      <h2 className="text-xl font-semibold">{t('inventory.title')}</h2>
      <p className="mt-2 text-sm text-muted">{t('inventory.subtitle')}</p>
      {error && <p className="mt-4 text-sm text-red-600" role="alert">{error}</p>}

      <div className="mt-4 flex flex-wrap items-end gap-3 rounded border border-border p-4">
        <label className="block text-sm">
          {t('inventory.form.name')}
          <input
            className="mt-1 block w-56 rounded border border-border px-2 py-1"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('inventory.form.namePlaceholder')}
          />
        </label>
        <label className="block text-sm">
          {t('inventory.form.unit')}
          <input
            className="mt-1 block w-32 rounded border border-border px-2 py-1"
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder={t('inventory.form.unitPlaceholder')}
          />
        </label>
        <button
          onClick={() => void addItem()}
          disabled={creating || !name.trim() || !unit.trim()}
          className="rounded bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-50"
        >
          {creating ? t('inventory.form.adding') : t('inventory.form.add')}
        </button>
        {createError && <p className="text-sm text-red-600" role="alert">{createError}</p>}
      </div>

      <div className="mt-4 flex gap-6 text-sm text-muted">
        <span>{t('inventory.summary.onHand')}: {overview?.trackedItems ?? 0}</span>
        <span>{t('inventory.summary.lowStock')}: {lowStockCount}</span>
      </div>

      <div className="mt-4 overflow-x-auto">
        <table className="min-w-full border border-border">
          <thead className="bg-surface">
            <tr>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.item')}</th>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.unit')}</th>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.onHand')}</th>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.lowStock')}</th>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.threshold')}</th>
              <th className="border-b border-border px-4 py-2 text-left text-sm font-medium">{t('inventory.column.lastMovement')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">
                  {t('inventory.empty.body')}
                </td>
              </tr>
            )}
            {items.map((item) => (
              <tr key={item.itemId}>
                <td className="border-b border-border px-4 py-2 text-sm">{item.name}</td>
                <td className="border-b border-border px-4 py-2 text-sm">{item.unit}</td>
                <td className="border-b border-border px-4 py-2 text-sm">
                  {formatQuantity(item.onHandMilli)} {item.unit}
                </td>
                <td className="border-b border-border px-4 py-2 text-sm">
                  {item.lowStock ? (
                    <span className="text-red-600">{t('inventory.lowStock.yes')}</span>
                  ) : (
                    <span className="text-muted">{t('inventory.lowStock.no')}</span>
                  )}
                </td>
                <td className="border-b border-border px-4 py-2 text-sm">
                  {item.lowStockThresholdMilli === null
                    ? '-'
                    : formatQuantity(item.lowStockThresholdMilli)}
                </td>
                <td className="border-b border-border px-4 py-2 text-sm">
                  {item.lastMovementAt ? new Date(item.lastMovementAt).toLocaleString() : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
