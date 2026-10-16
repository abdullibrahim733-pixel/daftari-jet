/**
 * One customer's deni ledger: what they owe and every movement behind it.
 */

import { requireTenant } from '@/server/business-context/resolve';
import { tenantScope } from '@/server/business-context/context';
import { assertCan } from '@/server/permissions/policy';
import {
  findCustomerById,
  listObligationsForCustomer,
  listPaymentsForCustomer,
} from '@/server/repositories/debt.repository';
import { notFound } from '@/lib/errors';
import { todayInZone } from '@/lib/formatting/datetime';
import { ok, route } from '@/server/http/route';

export const GET = route<{ customerId: string }>(async (_request, { params }) => {
  const { customerId } = await params;
  const { db, context } = await requireTenant();
  assertCan(context.role, 'deni.read');

  const scope = tenantScope(context);
  const customer = await findCustomerById(db, scope, customerId);
  if (!customer) throw notFound('Customer not found');

  const today = todayInZone(context.timezone);
  const obligations = await listObligationsForCustomer(db, scope, customer.id);
  const payments = await listPaymentsForCustomer(db, scope, customer.id);
  const outstanding = obligations
    .filter((obligation) => obligation.state === 'open')
    .reduce((sum, obligation) => sum + (obligation.original_amount_minor - obligation.paid_minor), 0);

  return ok({
    customer: {
      id: customer.id,
      displayName: customer.display_name,
      contactReference: customer.contact_reference,
      status: customer.status,
    },
    asOf: today,
    outstandingMinor: outstanding,
    overdueMinor: obligations
      .filter(
        (obligation) =>
          obligation.state === 'open' && obligation.due_date !== null && obligation.due_date < today,
      )
      .reduce((sum, obligation) => sum + (obligation.original_amount_minor - obligation.paid_minor), 0),
    obligations: obligations.map((obligation) => ({
      id: obligation.id,
      ledgerRecordId: obligation.ledger_record_id,
      originalAmountMinor: obligation.original_amount_minor,
      paidMinor: obligation.paid_minor,
      state: obligation.state,
      dueDate: obligation.due_date,
      createdAt: obligation.created_at,
    })),
    payments: payments.map((payment) => ({
      id: payment.id,
      ledgerRecordId: payment.ledger_record_id,
      obligationId: payment.obligation_id,
      amountMinor: payment.amount_minor,
      method: payment.method,
      receivedAt: payment.received_at,
    })),
  });
});
