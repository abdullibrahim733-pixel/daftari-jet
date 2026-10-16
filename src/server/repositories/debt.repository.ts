/**
 * Customer, debt obligation and debt payment persistence.
 *
 * Balances are derived from confirmed obligations minus applied payments with
 * an explicit formula version, never stored as a mutable running total.
 */

import { all, get, run, scalar, type Db } from '@/server/db/client';
import { newId, nowIso, toJson } from '@/server/db/ids';
import type { TenantScope } from '@/server/business-context/context';
import type { PaymentMethod } from '@/server/domain/types';

export type CustomerRow = {
  id: string;
  business_id: string;
  display_name: string;
  contact_reference: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
};

export type DebtObligationRow = {
  id: string;
  business_id: string;
  ledger_record_id: string;
  customer_id: string;
  original_amount_minor: number;
  due_date: string | null;
  state: 'open' | 'settled' | 'disputed' | 'voided';
  created_at: string;
  updated_at: string;
};

export type DebtPaymentRow = {
  id: string;
  business_id: string;
  ledger_record_id: string;
  obligation_id: string | null;
  customer_id: string;
  amount_minor: number;
  method: string;
  reference: string | null;
  received_at: string;
  created_at: string;
};

/* -------------------------------------------------------------- customers */

export async function listCustomers(db: Db, scope: TenantScope, search?: string): Promise<CustomerRow[]> {
  if (search) {
    return await all<CustomerRow>(
      db,
      'SELECT * FROM customers WHERE business_id = ? AND display_name LIKE ? ORDER BY display_name LIMIT 50',
      [scope.businessId, `%${search}%`],
    );
  }
  return await all<CustomerRow>(
    db,
    'SELECT * FROM customers WHERE business_id = ? ORDER BY display_name LIMIT 200',
    [scope.businessId],
  );
}

export async function findCustomerById(db: Db, scope: TenantScope, customerId: string): Promise<CustomerRow | undefined> {
  return await get<CustomerRow>(db, 'SELECT * FROM customers WHERE id = ? AND business_id = ?', [
    customerId,
    scope.businessId,
  ]);
}

export async function findCustomerByName(db: Db, scope: TenantScope, displayName: string): Promise<CustomerRow | undefined> {
  return await get<CustomerRow>(
    db,
    'SELECT * FROM customers WHERE business_id = ? AND display_name = ? COLLATE NOCASE',
    [scope.businessId, displayName.trim()],
  );
}

export async function createCustomer(db: Db, scope: TenantScope, displayName: string): Promise<CustomerRow> {
  const id = newId('cus');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO customers (id, business_id, display_name, contact_reference, status, created_at, updated_at)
     VALUES (?, ?, ?, NULL, 'active', ?, ?)`,
    [id, scope.businessId, displayName.trim(), timestamp, timestamp],
  );
  return await get<CustomerRow>(db, 'SELECT * FROM customers WHERE id = ?', [id]) as CustomerRow;
}

/* ------------------------------------------------------------ obligations */

export async function insertObligation(
  db: Db,
  input: {
    businessId: string;
    ledgerRecordId: string;
    customerId: string;
    originalAmountMinor: number;
    dueDate: string | null;
  },
): Promise<DebtObligationRow> {
  const id = newId('obl');
  const timestamp = nowIso();
  await run(
    db,
    `INSERT INTO debt_obligations (
       id, business_id, ledger_record_id, customer_id, original_amount_minor, due_date, state, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [id, input.businessId, input.ledgerRecordId, input.customerId, input.originalAmountMinor, input.dueDate, timestamp, timestamp],
  );
  return await get<DebtObligationRow>(db, 'SELECT * FROM debt_obligations WHERE id = ?', [id]) as DebtObligationRow;
}

export async function listObligationsForCustomer(
  db: Db,
  scope: TenantScope,
  customerId: string,
): Promise<(DebtObligationRow & { paid_minor: number })[]> {
  return await all<DebtObligationRow & { paid_minor: number }>(
    db,
    `SELECT o.*,
       COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                 WHERE p.obligation_id = o.id
                   AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0) AS paid_minor
     FROM debt_obligations o
     JOIN ledger_records r ON r.id = o.ledger_record_id
     WHERE o.business_id = ? AND o.customer_id = ? AND o.state != 'voided' AND r.status = 'posted'
     ORDER BY o.created_at DESC`,
    [scope.businessId, customerId],
  );
}

export async function findObligationById(
  db: Db,
  scope: TenantScope,
  obligationId: string,
): Promise<DebtObligationRow | undefined> {
  return await get<DebtObligationRow>(db, 'SELECT * FROM debt_obligations WHERE id = ? AND business_id = ?', [
    obligationId,
    scope.businessId,
  ]);
}

export async function setObligationState(
  db: Db,
  obligationId: string,
  state: DebtObligationRow['state'],
): Promise<void> {
  await run(db, 'UPDATE debt_obligations SET state = ?, updated_at = ? WHERE id = ?', [state, nowIso(), obligationId]);
}

/**
 * The live obligation a ledger record created, if any.
 *
 * A correction or reversal has to find the obligation this record produced, so
 * the lookup is tenant-scoped and returns the amount already paid against it.
 */
export async function findLiveObligationForRecord(
  db: Db,
  scope: TenantScope,
  ledgerRecordId: string,
): Promise<(DebtObligationRow & { paid_minor: number }) | undefined> {
  return await get<DebtObligationRow & { paid_minor: number }>(
    db,
    `SELECT o.*,
       COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                 WHERE p.obligation_id = o.id
                   AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0) AS paid_minor
     FROM debt_obligations o
     WHERE o.business_id = ? AND o.ledger_record_id = ? AND o.state != 'voided'
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [scope.businessId, ledgerRecordId],
  );
}

/**
 * Every obligation a record produced, voided ones included.
 *
 * Balance queries hide voided obligations because they no longer count, but the
 * record detail screen still has to show that the obligation existed and why it
 * stopped counting.
 */
export async function listObligationsForRecord(
  db: Db,
  scope: TenantScope,
  ledgerRecordId: string,
): Promise<(DebtObligationRow & { paid_minor: number })[]> {
  return await all<DebtObligationRow & { paid_minor: number }>(
    db,
    `SELECT o.*,
       COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                 WHERE p.obligation_id = o.id
                   AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0) AS paid_minor
     FROM debt_obligations o
     WHERE o.business_id = ? AND o.ledger_record_id = ?
     ORDER BY o.created_at DESC`,
    [scope.businessId, ledgerRecordId],
  );
}

/**
 * Restates what a record is owed after its amount is corrected.
 *
 * The owed figure lives on the obligation rather than being derived from the
 * record, so it has to be restated explicitly instead of left to drift.
 */
export async function restateObligation(
  db: Db,
  obligationId: string,
  input: { originalAmountMinor: number; dueDate: string | null; state: DebtObligationRow['state'] },
): Promise<void> {
  await run(
    db,
    `UPDATE debt_obligations
     SET original_amount_minor = ?, due_date = ?, state = ?, updated_at = ?
     WHERE id = ?`,
    [input.originalAmountMinor, input.dueDate, input.state, nowIso(), obligationId],
  );
}

/* --------------------------------------------------------------- payments */

export async function insertDebtPayment(
  db: Db,
  input: {
    businessId: string;
    ledgerRecordId: string;
    obligationId: string | null;
    customerId: string;
    amountMinor: number;
    method: PaymentMethod | string;
    reference: string | null;
    receivedAt: string;
  },
): Promise<DebtPaymentRow> {
  const id = newId('dpy');
  await run(
    db,
    `INSERT INTO debt_payments (
       id, business_id, ledger_record_id, obligation_id, customer_id, amount_minor,
       method, reference, received_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.businessId,
      input.ledgerRecordId,
      input.obligationId,
      input.customerId,
      input.amountMinor,
      input.method,
      input.reference,
      input.receivedAt,
      nowIso(),
    ],
  );
  return await get<DebtPaymentRow>(db, 'SELECT * FROM debt_payments WHERE id = ?', [id]) as DebtPaymentRow;
}

export async function listPaymentsForCustomer(
  db: Db,
  scope: TenantScope,
  customerId: string,
): Promise<DebtPaymentRow[]> {
  return await all<DebtPaymentRow>(
    db,
    `SELECT p.* FROM debt_payments p
     JOIN ledger_records r ON r.id = p.ledger_record_id
     WHERE p.business_id = ? AND p.customer_id = ? AND r.status = 'posted'
     ORDER BY p.received_at DESC`,
    [scope.businessId, customerId],
  );
}

export type CustomerBalance = {
  customerId: string;
  customerName: string;
  balanceMinor: number;
  oldestDebtDate: string | null;
  dueDate: string | null;
  overdue: boolean;
  lastPaymentAt: string | null;
  obligationCount: number;
};

/** Open balance per customer from confirmed obligations and payments. */
export async function customerBalances(db: Db, scope: TenantScope, todayDate: string): Promise<CustomerBalance[]> {
  const rows = await all<{
    customer_id: string;
    display_name: string;
    balance_minor: number;
    oldest_due: string | null;
    due_date: string | null;
    obligation_count: number;
    last_payment: string | null;
  }>(
    db,
    `SELECT o.customer_id,
            c.display_name,
            SUM(o.original_amount_minor
                - COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                            WHERE p.obligation_id = o.id
                              AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0)) AS balance_minor,
            MIN(r.occurred_at) AS oldest_due,
            MIN(o.due_date) AS due_date,
            COUNT(*) AS obligation_count,
            (SELECT MAX(p2.received_at) FROM debt_payments p2
              WHERE p2.customer_id = o.customer_id
                AND p2.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')) AS last_payment
     FROM debt_obligations o
     JOIN customers c ON c.id = o.customer_id
     JOIN ledger_records r ON r.id = o.ledger_record_id
     WHERE o.business_id = ? AND o.state != 'voided' AND r.status = 'posted'
     GROUP BY o.customer_id, c.display_name
     HAVING balance_minor > 0
     ORDER BY balance_minor DESC`,
    [scope.businessId],
  );

  return rows.map((row) => {
    const overdueBy = row.due_date !== null && row.due_date < todayDate ? true : false;
    return {
      customerId: row.customer_id,
      customerName: row.display_name,
      balanceMinor: row.balance_minor,
      oldestDebtDate: row.oldest_due,
      dueDate: row.due_date,
      overdue: overdueBy,
      lastPaymentAt: row.last_payment,
      obligationCount: row.obligation_count,
    };
  });
}

export async function totalOutstandingMinor(db: Db, scope: TenantScope): Promise<number> {
  return (
    await scalar<number>(
      db,
      `SELECT COALESCE(SUM(o.original_amount_minor
          - COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                      WHERE p.obligation_id = o.id
                        AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0)), 0)
       FROM debt_obligations o
       JOIN ledger_records r ON r.id = o.ledger_record_id
       WHERE o.business_id = ? AND o.state != 'voided' AND r.status = 'posted'`,
      [scope.businessId],
    ) ?? 0
  );
}

export async function totalOverdueMinor(db: Db, scope: TenantScope, todayDate: string): Promise<number> {
  return (
    await scalar<number>(
      db,
      `SELECT COALESCE(SUM(balance), 0) FROM (
         SELECT o.original_amount_minor
           - COALESCE((SELECT SUM(p.amount_minor) FROM debt_payments p
                       WHERE p.obligation_id = o.id
                         AND p.ledger_record_id IN (SELECT id FROM ledger_records WHERE status = 'posted')), 0) AS balance
         FROM debt_obligations o
         JOIN ledger_records r ON r.id = o.ledger_record_id
         WHERE o.business_id = ? AND o.state != 'voided' AND r.status = 'posted'
           AND o.due_date IS NOT NULL AND o.due_date < ?
       ) WHERE balance > 0`,
      [scope.businessId, todayDate],
    ) ?? 0
  );
}

export async function customersWithBalanceCount(db: Db, scope: TenantScope): Promise<number> {
  return (
    await scalar<number>(
      db,
      `SELECT COUNT(DISTINCT o.customer_id) FROM debt_obligations o
       JOIN ledger_records r ON r.id = o.ledger_record_id
       WHERE o.business_id = ? AND o.state != 'voided' AND r.status = 'posted'`,
      [scope.businessId],
    ) ?? 0
  );
}

export function toJsonSafe(value: unknown): string {
  return toJson(value);
}