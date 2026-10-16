'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { formatMinor, parseAmountToMinor, type Currency } from '@/lib/formatting/money';
import {
  isZonedWallClockValid,
  utcToZonedParts,
  zonedWallClockToInstantMs,
  type WallClockParts,
} from '@/lib/formatting/datetime';
import { createTranslator, languageLabel } from '@/lib/localization';
import { MOVEMENT_TYPES, PAYMENT_METHODS, PAYMENT_STATUSES, RECORD_TYPES } from '@/server/domain/types';
import type { ProposalFields } from '@/lib/validation/proposal';

/** Provider name of an in-app recording draft that a reviewer must classify. */
const MANUAL_DRAFT_PROVIDER = 'manual-draft';

type ProposalDetail = {
  id: string;
  state: string;
  recordType: string;
  version: number;
  provider: string;
  fields: ProposalFields;
  missingFields: string[];
  ambiguityNote: string | null;
  createdAt: string;
};

type ReviewOptions = {
  customers: Array<{ id: string; displayName: string }>;
  items: Array<{ id: string; name: string; unit: string }>;
  features: { inventory: boolean };
  timezone: string;
  currency: Currency;
};

type DetailData = {
  proposal: ProposalDetail;
  sourceEvent: {
    id: string;
    kind: string;
    senderRef: string;
    receivedAt: string;
    status: string;
  } | null;
  transcript: {
    id: string;
    status: string;
    language: string;
    text: string | null;
    failureCode: string | null;
  } | null;
  options: ReviewOptions;
};

type DetailResponse = { data: DetailData };
type FormValues = {
  amount: string;
  amountPaid: string;
  cost: string;
  occurredAt: string;
  customerName: string;
  description: string;
  itemsText: string;
  paymentStatus: string;
  paymentMethod: string;
  payee: string;
  category: string;
  dueDate: string;
  itemId: string;
  itemName: string;
  quantity: string;
  unit: string;
  movementType: string;
  note: string;
};

const t = createTranslator('en');

function inputAmount(minor: number | null, currency: Currency): string {
  return minor === null
    ? ''
    : formatMinor(minor, { locale: 'en-TZ', currency, useGrouping: false });
}

function quantityMilli(input: string): number {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(input.trim());
  if (!match) throw new Error(t('reviewDetail.validation.quantityInvalid'));
  const whole = Number(match[1]);
  const fractional = Number((match[2] ?? '').padEnd(3, '0'));
  const result = whole * 1000 + fractional;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(t('reviewDetail.validation.quantityInvalid'));
  }
  return result;
}

function datetimeInput(value: string | null, timeZone: string): string {
  if (!value) return '';
  const parts = utcToZonedParts(Date.parse(value), timeZone);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}

function instantFromDatetimeInput(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(t('reviewDetail.validation.invalidDate'));
  const parts: WallClockParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  if (!isZonedWallClockValid(parts, timeZone)) {
    throw new Error(t('reviewDetail.validation.invalidDate'));
  }
  return new Date(zonedWallClockToInstantMs(parts, timeZone)).toISOString();
}

function initialForm(data: DetailData): FormValues {
  const fields = data.proposal.fields;
  return {
    amount: inputAmount(fields.amountMinor, data.options.currency),
    amountPaid: inputAmount(fields.amountPaidMinor, data.options.currency),
    cost: inputAmount(fields.unitCostMinor, data.options.currency),
    occurredAt: datetimeInput(fields.occurredAt, data.options.timezone),
    customerName: fields.customerName ?? '',
    description: fields.description ?? '',
    itemsText: fields.itemsText ?? '',
    paymentStatus: fields.paymentStatus ?? '',
    paymentMethod: fields.paymentMethod ?? '',
    payee: fields.payee ?? '',
    category: fields.category ?? '',
    dueDate: fields.dueDate ?? '',
    itemId: fields.itemId ?? '',
    itemName: fields.itemName ?? '',
    quantity: fields.quantityMilli === null ? '' : String(fields.quantityMilli / 1000),
    unit: fields.unit ?? '',
    movementType: fields.movementType ?? '',
    note: fields.note ?? '',
  };
}

function ApiError({ message }: { message: string }) {
  return <p className="notice notice-error" role="alert">{message}</p>;
}

function Field({
  label,
  children,
  missing = false,
}: {
  label: string;
  children: ReactNode;
  missing?: boolean;
}) {
  return (
    <label className={`review-field${missing ? ' review-field-missing' : ''}`}>
      <span className="review-field-label">{label}{missing && <span className="review-missing-label"> · {t('reviewDetail.missingField')}</span>}</span>
      {children}
    </label>
  );
}

function moneyLabel(minor: number, currency: Currency): string {
  return formatMinor(minor, { locale: 'en-TZ', currency, showCurrency: true });
}

function maskedSender(reference: string): string {
  const digits = reference.replace(/\D/g, '');
  return digits.length > 4 ? `****${digits.slice(-4)}` : '****';
}

async function fetchProposalData(proposalId: string): Promise<DetailData> {
  const response = await fetch(`/api/v1/review/proposals/${proposalId}`, { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as
    | (DetailResponse & { error?: { message?: string } })
    | null;
  if (!response.ok || !body || !('data' in body)) {
    throw new Error(body?.error?.message ?? t('app.error'));
  }
  return body.data;
}

export default function ProposalDetailPage() {
  const params = useParams<{ proposalId: string }>();
  const router = useRouter();
  const proposalId = params.proposalId;
  const [data, setData] = useState<DetailData | null>(null);
  const [form, setForm] = useState<FormValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectReason, setRejectReason] = useState('source_unclear');
  const [rejectNote, setRejectNote] = useState('');
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchProposalData(proposalId)
      .then((result) => {
        if (!active) return;
        setData(result);
        setForm(initialForm(result));
        setConflict(false);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : t('app.error'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [proposalId]);

  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    setConflict(false);
    void fetchProposalData(proposalId)
      .then((result) => {
        setData(result);
        setForm(initialForm(result));
      })
      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : t('app.error')))
      .finally(() => setLoading(false));
  }, [proposalId]);

  function change<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setForm((current) => current ? { ...current, [key]: value } : current);
  }

  async function responseError(response: Response): Promise<Error> {
    const body = (await response.json().catch(() => null)) as
      | { error?: { message?: string; code?: string } }
      | null;
    if (body?.error?.code === 'PROPOSAL_VERSION_CONFLICT') setConflict(true);
    return new Error(body?.error?.message ?? t('app.error'));
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!data || !form) return;
    setActionLoading(true);
    setError(null);
    try {
      const amount = form.amount.trim()
        ? parseAmountToMinor(form.amount, data.options.currency)
        : null;
      const amountPaid = form.amountPaid.trim()
        ? parseAmountToMinor(form.amountPaid, data.options.currency)
        : null;
      const cost = form.cost.trim() ? parseAmountToMinor(form.cost, data.options.currency) : null;
      const quantity = form.quantity.trim() ? quantityMilli(form.quantity) : null;
      if (form.occurredAt === '') throw new Error(t('reviewDetail.validation.whenRequired'));

      const fields: Partial<ProposalFields> = {
        amountMinor: amount,
        occurredAt: instantFromDatetimeInput(form.occurredAt, data.options.timezone),
        description: form.description.trim() || null,
        customerId: null,
        customerName: form.customerName.trim() || null,
        itemsText: form.itemsText.trim() || null,
        paymentStatus: PAYMENT_STATUSES.find((status) => status === form.paymentStatus) ?? null,
        paymentMethod: PAYMENT_METHODS.find((method) => method === form.paymentMethod) ?? null,
        amountPaidMinor: amountPaid,
        payee: form.payee.trim() || null,
        category: form.category.trim() || null,
        dueDate: form.dueDate || null,
        itemId: form.itemId || null,
        itemName: form.itemName.trim() || null,
        quantityMilli: quantity,
        unit: form.unit.trim() || null,
        movementType: MOVEMENT_TYPES.find((movement) => movement === form.movementType) ?? null,
        unitCostMinor: cost,
        note: form.note.trim() || null,
      };
      const response = await fetch(`/api/v1/review/proposals/${proposalId}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({ expectedVersion: data.proposal.version, fields }),
      });
      if (!response.ok) throw await responseError(response);
      router.push('/review');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('reviewDetail.saveFailed'));
    } finally {
      setActionLoading(false);
    }
  }

  async function reclassify(recordType: string) {
    if (!data) return;
    setActionLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/review/proposals/${proposalId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedVersion: data.proposal.version, recordType }),
      });
      if (!response.ok) throw await responseError(response);
      reload();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('reviewDetail.saveFailed'));
    } finally {
      setActionLoading(false);
    }
  }

  async function reject() {
    if (!data) return;
    setActionLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/review/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: data.proposal.version,
          reasonCode: rejectReason,
          note: rejectNote.trim() || null,
        }),
      });
      if (!response.ok) throw await responseError(response);
      router.push('/review');
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : t('reviewDetail.saveFailed'));
    } finally {
      setActionLoading(false);
    }
  }

  if (loading) return <p role="status">{t('app.loading')}</p>;
  if (error && !data) return <ApiError message={error} />;
  if (!data || !form) return null;

  const { proposal, transcript, sourceEvent, options } = data;
  const isDecided = !['needs_review', 'needs_details', 'duplicate'].includes(proposal.state);
  const isDraft = proposal.provider === MANUAL_DRAFT_PROVIDER;
  const hasField = (field: string) => proposal.missingFields.includes(field);
  const missingFieldLabel = (field: string) => {
    const aliases: Record<string, string> = {
      amountMinor: 'amount',
      amountPaidMinor: 'amountPaid',
      quantityMilli: 'quantity',
      unitCostMinor: 'cost',
      occurredAt: 'occurredAt',
      customerName: 'customer',
      paymentStatus: 'paymentStatus',
      itemId: 'item',
      recordType: 'recordType',
    };
    return t(`reviewDetail.field.${aliases[field] ?? field}` as Parameters<typeof t>[0]);
  };
  const typeKey = `common.recordType.${proposal.recordType}` as Parameters<typeof t>[0];
  const paymentMethodKey = (method: string) => `common.paymentMethod.${method}` as Parameters<typeof t>[0];
  const stateKey = (state: string) => `common.state.${state}` as Parameters<typeof t>[0];
  const amountMinor = form.amount.trim()
    ? (() => {
        try { return parseAmountToMinor(form.amount, options.currency); } catch { return null; }
      })()
    : null;
  const confirmEffectKey = `reviewDetail.confirmEffect.${proposal.recordType}` as Parameters<typeof t>[0];
  const confirmEffect = proposal.recordType === 'note'
    ? t('reviewDetail.confirmEffect.note')
    : proposal.recordType === 'stock_movement'
      ? t(confirmEffectKey, {
          amount: '',
          customer: '',
          quantity: form.quantity || '0',
          unit: form.unit || '',
          item: form.itemName || t('reviewDetail.itemPlaceholder'),
        })
      : amountMinor === null
        ? t('review.checkDetailsCue')
        : t(confirmEffectKey, {
        amount: moneyLabel(amountMinor, options.currency),
        customer: form.customerName || t('reviewDetail.customerPlaceholder'),
        quantity: form.quantity || '0',
        unit: form.unit || '',
        item: form.itemName || t('reviewDetail.itemPlaceholder'),
      });

  return (
    <div className="proposal-review-page">
      <header className="page-heading review-page-heading">
        <div>
          <Link className="review-back-link" href="/review">← {t('review.title')}</Link>
          <p className="eyebrow">{t('reviewDetail.title')}</p>
          <h1>{recordTypeLabel(proposal.recordType, typeKey)}</h1>
          <p className="page-subtitle">
            {t('review.checkDetailsCue')} <span className={`state-pill state-${proposal.state}`}>{t(stateKey(proposal.state))}</span>
          </p>
        </div>
        <span className="review-version">{t('reviewDetail.version', { version: proposal.version })}</span>
      </header>

      {error && <ApiError message={error} />}
      {conflict && (
        <div className="notice notice-error review-conflict" role="alert">
          <span><strong>{t('reviewDetail.conflictTitle')}</strong><br />{t('reviewDetail.conflictBody', { actor: t('audit.you') })}</span>
          <button className="button button-secondary button-small" type="button" onClick={reload}>{t('reviewDetail.conflictReload')}</button>
        </div>
      )}

      <div className="review-detail-grid">
        <section className="panel evidence-panel">
          <div className="panel-heading">
            <div><h2>{t('reviewDetail.sourceHeading')}</h2><p>{t('reviewDetail.transcriptHeading')}</p></div>
            {transcript && <span className="source-language">{languageLabel(transcript.language, 'en')}</span>}
          </div>
          <div className="transcript-card" aria-live="polite">
            {transcript?.text || t(transcript?.status === 'failed' ? 'review.transcriptFailed' : 'review.transcriptPending')}
          </div>
          {proposal.ambiguityNote && (
            <div className="ambiguity-card">
              <strong>{t('review.checkDetailsCue')}</strong>
              <p>{proposal.ambiguityNote}</p>
            </div>
          )}
          {proposal.missingFields.length > 0 && (
            <div className="missing-fields">
              <h3>{t('reviewDetail.missingHeading')}</h3>
              <ul>{proposal.missingFields.map((field) => <li key={field}>{missingFieldLabel(field)}</li>)}</ul>
            </div>
          )}
          <dl className="source-details">
            <div><dt>{t('reviewDetail.sender')}</dt><dd>{sourceEvent ? t('reviewDetail.senderMasked', { reference: maskedSender(sourceEvent.senderRef) }) : t('reviewDetail.senderUnavailable')}</dd></div>
            {sourceEvent && <div><dt>{t('reviewDetail.sourceType')}</dt><dd>{t(`common.source.${sourceEvent.kind}` as Parameters<typeof t>[0])}</dd></div>}
            <div><dt>{t('reviewDetail.receivedAt')}</dt><dd>{sourceEvent ? new Intl.DateTimeFormat('en-TZ', { timeZone: options.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sourceEvent.receivedAt)) : new Date(proposal.createdAt).toLocaleString()}</dd></div>
            <div><dt>{t('reviewDetail.sourceId')}</dt><dd className="tabular">{sourceEvent?.id ?? proposal.id}</dd></div>
            <div><dt>{t('reviewDetail.processingHeading')}</dt><dd>{t(stateKey(sourceEvent?.status ?? transcript?.status ?? proposal.state))}</dd></div>
          </dl>
          <p className="source-privacy-note">{t('reviewDetail.sourcePrivacy')}</p>
        </section>

        <form className="panel proposal-form" onSubmit={(event) => void confirm(event)}>
          <div className="panel-heading">
            <div><h2>{t('reviewDetail.proposalHeading')}</h2><p>{t('reviewDetail.editHint')}</p></div>
            <span className="review-type-badge">{t(typeKey)}</span>
          </div>
          <fieldset disabled={actionLoading || isDecided} className="proposal-fields">
            {isDraft && (
              <Field label={t('reviewDetail.field.recordType')} missing={hasField('recordType')}>
                <select
                  value={proposal.recordType}
                  onChange={(event) => void reclassify(event.target.value)}
                  aria-label={t('reviewDetail.field.recordType')}
                >
                  {RECORD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {t(`common.recordType.${type}` as Parameters<typeof t>[0])}
                    </option>
                  ))}
                </select>
                <small>{t('reviewDetail.reclassifyHint')}</small>
              </Field>
            )}
            {proposal.recordType !== 'note' && proposal.recordType !== 'stock_movement' && (
              <Field label={t('reviewDetail.field.amount')} missing={hasField('amountMinor')}>
                <div className="money-input"><span>{options.currency}</span><input inputMode="decimal" autoComplete="off" value={form.amount} onChange={(event) => change('amount', event.target.value)} aria-label={t('reviewDetail.field.amount')} /></div>
              </Field>
            )}
            <Field label={t('reviewDetail.field.occurredAt')} missing={hasField('occurredAt')}>
              <input type="datetime-local" value={form.occurredAt} onChange={(event) => change('occurredAt', event.target.value)} aria-label={`${t('reviewDetail.field.occurredAt')} (${options.timezone})`} />
              <small>{options.timezone}</small>
            </Field>

            {proposal.recordType === 'sale' && (
              <>
                <Field label={t('reviewDetail.field.customer')} missing={hasField('customerName')}>
                  <input list="review-customers" value={form.customerName} onChange={(event) => change('customerName', event.target.value)} placeholder={t('reviewDetail.customerPlaceholder')} />
                  <datalist id="review-customers">{options.customers.map((customer) => <option key={customer.id} value={customer.displayName} />)}</datalist>
                </Field>
                <Field label={t('reviewDetail.field.items')}><input value={form.itemsText} onChange={(event) => change('itemsText', event.target.value)} /></Field>
                <div className="review-field-grid">
                  <Field label={t('reviewDetail.field.paymentStatus')} missing={hasField('paymentStatus')}>
                    <select value={form.paymentStatus} onChange={(event) => change('paymentStatus', event.target.value)}>
                      <option value="">{t('reviewDetail.paymentStatusPlaceholder')}</option>
                      {PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{t(stateKey(status))}</option>)}
                    </select>
                  </Field>
                  <Field label={t('reviewDetail.field.paymentMethod')}>
                    <select value={form.paymentMethod} onChange={(event) => change('paymentMethod', event.target.value)}>
                      <option value="">{t('common.state.unknown')}</option>
                      {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{t(paymentMethodKey(method))}</option>)}
                    </select>
                  </Field>
                </div>
                {form.paymentStatus === 'partial' && (
                  <Field label={t('reviewDetail.field.amountPaid')} missing={hasField('amountPaidMinor')}>
                    <div className="money-input"><span>{options.currency}</span><input inputMode="decimal" value={form.amountPaid} onChange={(event) => change('amountPaid', event.target.value)} /></div>
                  </Field>
                )}
              </>
            )}

            {proposal.recordType === 'expense' && (
              <div className="review-field-grid">
                <Field label={t('reviewDetail.field.payee')}><input value={form.payee} onChange={(event) => change('payee', event.target.value)} /></Field>
                <Field label={t('reviewDetail.field.category')} missing={hasField('category')}><input value={form.category} onChange={(event) => change('category', event.target.value)} /></Field>
              </div>
            )}

            {(proposal.recordType === 'debt_created' || proposal.recordType === 'debt_payment') && (
              <div className="review-field-grid">
                <Field label={t('reviewDetail.field.customer')} missing={hasField('customerName')}>
                  <input list="review-customers" value={form.customerName} onChange={(event) => change('customerName', event.target.value)} placeholder={t('reviewDetail.customerPlaceholder')} />
                  <datalist id="review-customers">{options.customers.map((customer) => <option key={customer.id} value={customer.displayName} />)}</datalist>
                </Field>
                {proposal.recordType === 'debt_created' && <Field label={t('reviewDetail.field.dueDate')}><input type="date" value={form.dueDate} onChange={(event) => change('dueDate', event.target.value)} /></Field>}
              </div>
            )}

            {proposal.recordType === 'debt_payment' && (
              <Field label={t('reviewDetail.field.paymentMethod')}>
                <select value={form.paymentMethod} onChange={(event) => change('paymentMethod', event.target.value)}>
                  <option value="">{t('common.state.unknown')}</option>
                  {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{t(paymentMethodKey(method))}</option>)}
                </select>
              </Field>
            )}

            {proposal.recordType === 'stock_movement' && options.features.inventory && (
              <>
                <Field label={t('reviewDetail.field.cost')}>
                  <div className="money-input"><span>{options.currency}</span><input inputMode="decimal" value={form.cost} onChange={(event) => change('cost', event.target.value)} /></div>
                </Field>
                <Field label={t('reviewDetail.field.item')} missing={hasField('itemId')}>
                  <select value={form.itemId} onChange={(event) => {
                    const item = options.items.find((candidate) => candidate.id === event.target.value);
                    change('itemId', event.target.value);
                    if (item) { change('itemName', item.name); change('unit', item.unit); }
                    else { change('itemName', ''); change('unit', ''); }
                  }}>
                    <option value="">{t('reviewDetail.itemPlaceholder')}</option>
                    {options.items.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.unit})</option>)}
                  </select>
                </Field>
                <div className="review-field-grid">
                  <Field label={t('reviewDetail.field.quantity')} missing={hasField('quantityMilli')}><input inputMode="decimal" value={form.quantity} onChange={(event) => change('quantity', event.target.value)} /></Field>
                  <Field label={t('reviewDetail.field.unit')}><input value={form.unit} onChange={(event) => change('unit', event.target.value)} /></Field>
                </div>
                <Field label={t('reviewDetail.field.movementType')}>
                  <select value={form.movementType} onChange={(event) => change('movementType', event.target.value)}>
                    <option value="">{t('common.state.unknown')}</option>
                    {MOVEMENT_TYPES.map((movement) => <option key={movement} value={movement}>{t(`common.movement.${movement}` as Parameters<typeof t>[0])}</option>)}
                  </select>
                </Field>
              </>
            )}

            {proposal.recordType === 'note' && (
              <Field label={t('reviewDetail.field.note')} missing={hasField('note')}>
                <textarea rows={4} value={form.note} onChange={(event) => change('note', event.target.value)} />
              </Field>
            )}

            {(proposal.recordType === 'sale' || proposal.recordType === 'expense' || proposal.recordType === 'stock_movement') && (
              <Field label={t('reviewDetail.field.description')}>
                <input value={form.description} onChange={(event) => change('description', event.target.value)} />
              </Field>
            )}
            {(proposal.recordType === 'debt_created' || proposal.recordType === 'debt_payment') && (
              <Field label={t('reviewDetail.field.description')}>
                <input value={form.description} onChange={(event) => change('description', event.target.value)} />
              </Field>
            )}
            {proposal.recordType === 'expense' && (
              <Field label={t('reviewDetail.field.paymentMethod')}>
                <select value={form.paymentMethod} onChange={(event) => change('paymentMethod', event.target.value)}>
                  <option value="">{t('common.state.unknown')}</option>
                  {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{t(paymentMethodKey(method))}</option>)}
                </select>
              </Field>
            )}
            {(proposal.recordType === 'sale' || proposal.recordType === 'expense') && (
              <Field label={t('reviewDetail.field.note')}><textarea rows={2} value={form.note} onChange={(event) => change('note', event.target.value)} /></Field>
            )}
          </fieldset>

          {isDecided ? (
            <div className="decision-bar decision-bar-disabled">
              <p>{t('reviewDetail.alreadyDecided', { state: t(stateKey(proposal.state)), actor: t('audit.you') })}</p>
              <Link className="button button-secondary" href="/review">{t('app.back')}</Link>
            </div>
          ) : (
            <div className="decision-bar">
              <div className="decision-effect">
                <span>{t('reviewDetail.confirmEffectLabel')}</span>
                <strong>{confirmEffect}</strong>
              </div>
              <div className="reject-controls">
                <label>
                  <span className="sr-only">{t('reviewDetail.rejectReasonHeading')}</span>
                  <select value={rejectReason} onChange={(event) => setRejectReason(event.target.value)}>
                    {['not_a_business_record', 'wrong_amount', 'wrong_record_type', 'duplicate', 'already_recorded', 'source_unclear', 'other'].map((reason) => (
                      <option key={reason} value={reason}>{t(`reviewDetail.rejectReason.${reason}` as Parameters<typeof t>[0])}</option>
                    ))}
                  </select>
                </label>
                <label className="reject-note-label">
                  <span className="sr-only">{t('reviewDetail.rejectNote')}</span>
                  <input value={rejectNote} onChange={(event) => setRejectNote(event.target.value)} maxLength={500} placeholder={t('reviewDetail.rejectNoteHint')} />
                </label>
                <button type="button" className="button button-danger" onClick={() => void reject()} disabled={actionLoading}>{t('reviewDetail.rejectButton')}</button>
              </div>
              <button type="submit" className="button button-primary" disabled={actionLoading}>
                {actionLoading ? t('reviewDetail.confirming') : proposal.recordType === 'note' ? t('reviewDetail.saveAsNote') : t('reviewDetail.confirmButton')}
              </button>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

function recordTypeLabel(recordType: string, key: Parameters<typeof t>[0]): string {
  return t(key || (`common.recordType.${recordType}` as Parameters<typeof t>[0]));
}
