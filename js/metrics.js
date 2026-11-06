// Aggregations over store data. Logged, submitted, approved, invoiced and paid are
// always computed separately; money is always bucketed per currency.

import { S, get } from './store.js';
import * as C from './calc.js';

const inR = (d, from, to) => C.inRange(d, from, to);

export const entriesIn = (cids, from, to) => S.entries.filter(e => cids.has(e.contract_id) && inR(e.work_date, from, to));
export const billable = entries => entries.filter(e => e.is_billable !== false);
export const loggedMinutes = entries => C.sumMinutes(billable(entries));

export const approvalsIn = (cids, from, to) => S.approvals.filter(a => cids.has(a.contract_id) && inR(a.period_start, from, to));
export const submissionsIn = (cids, from, to) => S.submissions.filter(s => cids.has(s.contract_id) && s.status !== 'Draft' && inR(s.period_start, from, to));

export const sumCenti = (rows, field) => rows.reduce((a, r) => a + C.toCenti(r[field]), 0);

export function earnings(approvals) {
  const byCur = {}, rows = [];
  let centi = 0, rateMissing = false, rateChange = false;
  for (const a of approvals) {
    const e = C.approvalEarning(a, get('contracts', a.contract_id), S.rates);
    rows.push({ approval: a, ...e });
    centi += e.centi;
    rateMissing ||= e.rateMissing; rateChange ||= e.rateChange;
    C.addTo(byCur, e.currency, e.minor);
  }
  return { byCur, centi, rows, rateMissing, rateChange };
}

export const invoicesById = () => new Map(S.invoices.map(i => [i.id, i]));

// Remaining (unallocated) centihours per approval record.
export function remainingByApproval() {
  const alloc = C.allocatedByApproval(S.allocations, invoicesById());
  const m = new Map();
  for (const a of S.approvals) m.set(a.id, C.toCenti(a.approved_hours) - (alloc.get(a.id) || 0));
  return m;
}

export function finance(cids, from, to) {
  const rem = remainingByApproval();
  const notInvoiced = {}; let notInvoicedCenti = 0;
  for (const r of earnings(approvalsIn(cids, from, to)).rows) {
    const left = rem.get(r.approval.id) || 0;
    if (left <= 0) continue;
    notInvoicedCenti += left;
    C.addTo(notInvoiced, r.currency, Math.round(left * r.rateMinor / 100));
  }
  const invoiced = {}, paid = {}, outstanding = {};
  for (const inv of S.invoices) {
    if (!cids.has(inv.contract_id) || !inR(inv.invoice_date, from, to) || !C.invoiceCountsAsBilled(inv) || inv.status === 'Draft') continue;
    C.addTo(invoiced, inv.currency, C.invoiceTotal(inv));
    const p = C.invoicePaid(inv, S.payments);
    C.addTo(paid, inv.currency, p);
    const o = C.invoiceTotal(inv) - p;
    if (o) C.addTo(outstanding, inv.currency, o);
  }
  return { notInvoiced, notInvoicedCenti, invoiced, paid, outstanding };
}

// Approval status for a contract over a period, from manual records only.
export function periodStatus(cid, from, to) {
  const subs = S.submissions.filter(s => s.contract_id === cid && s.status !== 'Draft' && C.rangesOverlap(s.period_start, s.period_end, from, to));
  const apps = S.approvals.filter(a => a.contract_id === cid && C.rangesOverlap(a.period_start, a.period_end, from, to));
  const submitted = sumCenti(subs, 'submitted_hours'), approved = sumCenti(apps, 'approved_hours');
  let status = 'Not submitted';
  if (subs.some(s => s.status === 'Rejected') && !apps.length) status = 'Rejected';
  else if (subs.some(s => s.status === 'Clarification requested') && !apps.length) status = 'Needs clarification';
  else if (apps.length && approved >= submitted) status = 'Approved';
  else if (apps.length) status = 'Partially approved';
  else if (subs.length) status = 'Submitted — awaiting approval';
  return { status, submitted, approved, subs, apps, ...C.pendingDifference(submitted, approved) };
}

// Per-day per-contract evidence completeness (an organisational aid, not a proof score).
export function completeness(cid, date) {
  const entries = S.entries.filter(e => e.contract_id === cid && e.work_date === date);
  const ev = S.evidence.filter(f => f.contract_id === cid && f.related_work_date === date);
  const has = t => ev.some(f => t.includes(f.evidence_type));
  const items = [
    ['Notes', entries.length > 0 && entries.every(e => (e.activity_notes || '').trim().length >= 3)],
    ['Task refs', entries.length > 0 && entries.some(e => e.task_id)],
    ['Work samples', has(['wip_screenshot', 'completed_screenshot', 'final_deliverable'])],
    ['Submission', has(['submitted_invoice', 'approved_timesheet']) || S.submissions.some(s => s.contract_id === cid && C.inRange(date, s.period_start, s.period_end) && s.status !== 'Draft')],
    ['Approval evidence', ev.some(f => f.contains_approval)],
  ];
  return { items, score: items.filter(i => i[1]).length, total: items.length };
}
