import { S, get, save, today, scopeContractIds, contractLabel, defaultContractId, profile, nowIso } from '../store.js';
import { h, mount, table, badge, openDialog, formModal, askReason, toast, contractOptions, confirmDialog } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import * as A from '../actions.js';
import { printInvoice } from '../report-render.js';

const STATUSES = ['Draft', 'Sent', 'Acknowledged', 'Disputed'];
const KIND = { Paid: 'ok', 'Partially paid': 'accent', Overdue: 'bad', Disputed: 'bad', Credited: '', Draft: '', Sent: 'accent', Acknowledged: 'accent' };

export const billToFromEmployer = (e, c) => ({
  name: e?.legal_name || '', address: e?.address || '', contact: c?.approval_contact_name || e?.billing_contact_name || e?.primary_contact_name || '',
  email: e?.billing_contact_email || c?.approval_contact_email || e?.primary_contact_email || '', reference: '',
  registration_number: e?.registration_number || '', tax_number: e?.tax_number || '',
});
const nextNumber = e => `${e?.invoice_prefix ?? 'INV-'}${String(e?.invoice_next_seq || 1).padStart(4, '0')}`;

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  const invs = S.invoices.filter(i => cids.has(i.contract_id)).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
  const fin = M.finance(cids);
  mount(el, h`<section class="panel">
    <div class="panel-head"><h2>Invoices</h2><button class="btn primary" data-new>New invoice from approved hours</button></div>
    <div class="stats">
      <div class="stat invoiced"><div class="stat-label">Approved, not invoiced</div><div class="stat-value">${Object.entries(fin.notInvoiced).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div><div class="stat-sub">${C.fmtCenti(fin.notInvoicedCenti)}</div></div>
      <div class="stat invoiced"><div class="stat-label">Outstanding invoice balance</div><div class="stat-value">${Object.entries(fin.outstanding).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div></div>
      <div class="stat paid"><div class="stat-label">Paid</div><div class="stat-value">${Object.entries(fin.paid).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div></div>
    </div>
    <div class="table-wrap stack">${table([
      { label: 'Number', render: i => h`<a href="#" data-open="${i.id}"><b>${i.invoice_number}</b></a>` },
      { label: 'Contract', render: i => contractLabel(get('contracts', i.contract_id)) },
      { label: 'Period', render: i => `${C.fmtDate(i.period_start)} – ${C.fmtDate(i.period_end)}` },
      { label: 'Date', render: i => C.fmtDate(i.invoice_date) },
      { label: 'Total', cls: 'num', render: i => C.fmtMoney(C.invoiceTotal(i), i.currency) },
      { label: 'Outstanding', cls: 'num', render: i => i.status === 'Credited' ? '—' : C.fmtMoney(C.invoiceOutstanding(i, S.payments), i.currency) },
      { label: 'Status', render: i => { const s = C.invoiceStatus(i, S.payments, t); return badge(s, KIND[s]); } },
    ], invs, { empty: 'No invoices yet. Create one from approved hours.' })}</div>
  </section>`);

  el.onclick = e => {
    const b = e.target.closest('[data-new],[data-open]');
    if (!b) return;
    e.preventDefault();
    if ('new' in b.dataset) invoiceForm();
    else detail(get('invoices', b.dataset.open));
  };
}

function approvalsTable(cid) {
  const rem = M.remainingByApproval();
  const rows = M.earnings(S.approvals.filter(a => a.contract_id === cid)).rows.filter(r => (rem.get(r.approval.id) || 0) > 0)
    .sort((a, b) => a.approval.period_start.localeCompare(b.approval.period_start));
  if (!rows.length) return h`<div class="warnbox">No approved hours left to invoice for this contract. Record approved hours first.</div>`;
  return h`<div class="table-wrap"><table><thead><tr><th></th><th>Approved period</th><th class="num">Available</th><th class="num">Hours to invoice</th><th class="num">Rate</th></tr></thead><tbody>
    ${rows.map(r => h`<tr><td><input type="checkbox" data-a="${r.approval.id}" checked></td><td>${C.fmtDate(r.approval.period_start)}${r.approval.period_end !== r.approval.period_start ? ' – ' + C.fmtDate(r.approval.period_end) : ''}</td>
      <td class="num">${C.fmtCenti(rem.get(r.approval.id))}</td><td class="num"><input data-h="${r.approval.id}" data-max="${rem.get(r.approval.id)}" data-rate="${r.rateMinor}" data-start="${r.approval.period_start}" data-end="${r.approval.period_end}" value="${C.hundredthsToString(rem.get(r.approval.id))}" inputmode="decimal" style="width:90px;text-align:right"></td>
      <td class="num">${r.rateMissing ? badge('No rate', 'bad') : C.fmtMoney(r.rateMinor, r.currency)}</td></tr>`)}
  </tbody></table></div>`;
}

function readLines(form) {
  return [...form.querySelectorAll('[data-a]')].filter(cb => cb.checked).map(cb => {
    const inp = form.querySelector(`[data-h="${cb.dataset.a}"]`);
    const centi = C.toCenti(inp.value);
    return { approval_record_id: cb.dataset.a, centi, max: +inp.dataset.max, rateMinor: +inp.dataset.rate, start: inp.dataset.start, end: inp.dataset.end };
  });
}

export async function invoiceForm() {
  let cid = defaultContractId();
  if (!cid) return toast('Add a contract first', 'warn');
  const contract = () => get('contracts', cid), employer = () => get('employers', contract()?.employer_id);
  const bt = billToFromEmployer(employer(), contract());
  const fields = [
    { name: 'contract_id', label: 'Contract', type: 'select', options: contractOptions(), required: true },
    { name: 'invoice_number', label: 'Invoice number', required: true },
    { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
    { name: 'status', label: 'Status', type: 'select', options: STATUSES },
    { name: 'lines', type: 'html', html: h`<div data-lines>${approvalsTable(cid)}</div>` },
    { name: 'extra_hours', label: 'Unapproved hours to include (exceptional)', type: 'hours', hint: 'Only with a reason. Shown as unapproved on the invoice record.' },
    { name: 'extra_reason', label: 'Reason for including unapproved hours' },
    { name: 'adjustments', label: 'Adjustment amount (+/−)', type: 'money' },
    { name: 'adjustment_reason', label: 'Adjustment note' },
    { name: 'h1', type: 'html', html: h`<h3>Bill to <span class="small muted">(pre-filled from the employer record; edits apply to this invoice only)</span></h3>` },
    { name: 'bt_name', label: 'Bill-to name', required: true },
    { name: 'bt_contact', label: 'Contact' },
    { name: 'bt_address', label: 'Address', type: 'textarea', rows: 3 },
    { name: 'bt_email', label: 'Email' },
    { name: 'bt_reference', label: 'Reference / PO number' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, full: true },
    { name: 'total', type: 'html', html: h`<div class="note" data-total>Total: —</div>` },
  ];
  const values = { contract_id: cid, invoice_number: nextNumber(employer()), invoice_date: today(), status: 'Draft', ...Object.fromEntries(Object.entries(bt).map(([k, v]) => ['bt_' + k, v])) };
  return formModal({
    title: 'New invoice', wide: true, fields, values, submitLabel: 'Create invoice',
    onInput: (v, form) => {
      if (v.contract_id !== cid) {
        cid = v.contract_id;
        form.querySelector('[data-lines]').innerHTML = approvalsTable(cid).s;
        const b = billToFromEmployer(employer(), contract());
        for (const k of Object.keys(b)) if (form.elements['bt_' + k]) form.elements['bt_' + k].value = b[k];
        form.elements.invoice_number.value = nextNumber(employer());
      }
      const lines = readLines(form);
      const rate = C.rateOn(S.rates, cid, v.invoice_date)?.hourly_rate;
      const sub = lines.reduce((a, l) => a + Math.round(l.centi * l.rateMinor / 100), 0) + Math.round(C.toCenti(v.extra_hours || 0) * C.toMinor(rate || 0) / 100);
      const total = sub + (C.toMinor(v.adjustments || 0) || 0);
      form.querySelector('[data-total]').textContent = `Subtotal ${C.fmtMoney(sub, contract().currency)} · Total ${C.fmtMoney(total, contract().currency)} · ${C.fmtCenti(lines.reduce((a, l) => a + l.centi, 0))} approved`;
    },
    onSubmit: async (v, form) => {
      const c = contract(), e = employer();
      const lines = readLines(form).filter(l => l.centi > 0);
      for (const l of lines) if (Number.isNaN(l.centi) || l.centi > l.max) throw new Error('Hours to invoice cannot exceed the approved hours still available.');
      const extra = C.toCenti(v.extra_hours || 0);
      if (extra && !v.extra_reason) throw new Error('A reason is required to invoice unapproved hours.');
      if (!lines.length && !extra) throw new Error('Select at least one approved period.');
      if (S.invoices.some(i => i.invoice_number === v.invoice_number && get('contracts', i.contract_id)?.employer_id === c.employer_id)) throw new Error('That invoice number is already used for this employer.');
      if (extra && !await confirmDialog(`You are invoicing ${C.fmtCenti(extra)} that is NOT recorded as approved.\nReason: ${v.extra_reason}`, { ok: 'Include anyway' })) return false;
      const rateNow = C.rateOn(S.rates, c.id, v.invoice_date);
      const extraMinor = Math.round(extra * C.toMinor(rateNow?.hourly_rate || 0) / 100);
      const subtotal = lines.reduce((a, l) => a + Math.round(l.centi * l.rateMinor / 100), 0) + extraMinor;
      const starts = lines.map(l => l.start).sort(), ends = lines.map(l => l.end).sort();
      const inv = await save('invoices', {
        contract_id: c.id, invoice_number: v.invoice_number, invoice_date: v.invoice_date, status: v.status, currency: c.currency,
        period_start: starts[0] || v.invoice_date, period_end: ends.at(-1) || v.invoice_date,
        approved_centi: lines.reduce((a, l) => a + l.centi, 0), unapproved_centi: extra, unapproved_reason: v.extra_reason || '',
        subtotal_minor: subtotal, adjustments_minor: C.toMinor(v.adjustments || 0) || 0, adjustment_reason: v.adjustment_reason,
        rate_snapshot: [...new Set(lines.map(l => l.rateMinor))].map(r => C.hundredthsToString(r)).join(', ') || rateNow?.hourly_rate || '',
        bill_to_snapshot_json: { name: v.bt_name, contact: v.bt_contact, address: v.bt_address, email: v.bt_email, reference: v.bt_reference, registration_number: e?.registration_number, tax_number: e?.tax_number },
        from_snapshot_json: { ...profile() },
        due_date: c.payment_terms_working_days ? C.addWorkingDays(v.invoice_date, c.payment_terms_working_days) : null,
        sent_at_utc: v.status === 'Sent' ? nowIso() : null, notes: v.notes,
      });
      for (const l of lines) await save('allocations', { invoice_id: inv.id, approval_record_id: l.approval_record_id, hours_allocated: C.hundredthsToString(l.centi), amount_minor: Math.round(l.centi * l.rateMinor / 100) });
      if (v.invoice_number === nextNumber(e)) await save('employers', { id: e.id, invoice_next_seq: (e.invoice_next_seq || 1) + 1 }, { audit: false });
      toast(`Invoice ${inv.invoice_number} created`);
      return inv;
    },
  });
}

function detail(inv) {
  const t = today();
  const status = C.invoiceStatus(inv, S.payments, t);
  const pays = S.payments.filter(p => p.invoice_id === inv.id);
  const allocs = S.allocations.filter(a => a.invoice_id === inv.id);
  const bt = inv.bill_to_snapshot_json || {};
  const { el, close } = openDialog({
    title: `Invoice ${inv.invoice_number}`, wide: true,
    body: h`<dl class="kv">
        <dt>Status</dt><dd>${badge(status, KIND[status])}</dd>
        <dt>Contract</dt><dd>${contractLabel(get('contracts', inv.contract_id))}</dd>
        <dt>Bill to</dt><dd class="pre">${[bt.name, bt.contact, bt.address, bt.email, bt.reference && 'Ref: ' + bt.reference].filter(Boolean).join('\n')}</dd>
        <dt>Period</dt><dd>${C.fmtDate(inv.period_start)} – ${C.fmtDate(inv.period_end)}</dd>
        <dt>Dates</dt><dd>Invoiced ${C.fmtDate(inv.invoice_date)}${inv.due_date ? ` · due (estimate) ${C.fmtDate(inv.due_date)}` : ''}</dd>
        <dt>Approved hours</dt><dd>${C.fmtCenti(inv.approved_centi || 0)} @ ${inv.rate_snapshot} ${inv.currency}</dd>
        ${inv.unapproved_centi ? h`<dt>Unapproved</dt><dd>${badge(C.fmtCenti(inv.unapproved_centi) + ' not approved', 'warn')} ${inv.unapproved_reason}</dd>` : ''}
        <dt>Subtotal</dt><dd>${C.fmtMoney(inv.subtotal_minor, inv.currency)}</dd>
        ${inv.adjustments_minor ? h`<dt>Adjustments</dt><dd>${C.fmtMoney(inv.adjustments_minor, inv.currency)} ${inv.adjustment_reason || ''}</dd>` : ''}
        <dt>Total</dt><dd><b>${C.fmtMoney(C.invoiceTotal(inv), inv.currency)}</b></dd>
        <dt>Paid</dt><dd>${C.fmtMoney(C.invoicePaid(inv, S.payments), inv.currency)}</dd>
        <dt>Outstanding</dt><dd><b>${C.fmtMoney(C.invoiceOutstanding(inv, S.payments), inv.currency)}</b></dd>
      </dl>
      <h3 class="mt">Allocated approvals</h3>
      ${table([
        { label: 'Approval period', render: a => { const ap = get('approvals', a.approval_record_id); return ap ? `${C.fmtDate(ap.period_start)} – ${C.fmtDate(ap.period_end)}` : '(deleted)'; } },
        { label: 'Hours', cls: 'num', render: a => a.hours_allocated + ' h' },
        { label: 'Amount', cls: 'num', render: a => C.fmtMoney(a.amount_minor, inv.currency) },
      ], allocs)}
      <h3 class="mt">Payments</h3>
      ${table([
        { label: 'Date', render: p => C.fmtDate(p.received_at_utc) },
        { label: 'Reference', render: p => p.payment_reference || '' },
        { label: 'Account', render: p => p.account_label || '' },
        { label: 'Amount', cls: 'num', render: p => C.fmtMoney(p.amount_minor, p.currency) },
      ], pays, { empty: 'No payments recorded.' })}`,
    actions: h`${inv.status !== 'Credited' ? h`<button class="btn danger ghost" data-credit>Credit / void</button>` : ''}<span class="grow"></span>
      <button class="btn" data-status>Change status</button><button class="btn" data-file>Attach file</button><button class="btn" data-print>Print / PDF</button>
      ${inv.status !== 'Credited' ? h`<button class="btn primary" data-pay>Record payment</button>` : ''}`,
  });
  el.querySelector('[data-print]').onclick = () => printInvoice(inv);
  el.querySelector('[data-file]').onclick = () => { close(); A.uploadEvidence({ contract_id: inv.contract_id, related_work_date: inv.invoice_date, evidence_type: 'submitted_invoice', description: `Invoice ${inv.invoice_number}` }); };
  el.querySelector('[data-status]').onclick = async () => {
    close();
    await formModal({
      title: 'Invoice status', values: { status: inv.status, sent: inv.sent_at_utc?.slice(0, 10) || today() },
      fields: [{ name: 'status', label: 'Status', type: 'select', options: STATUSES }, { name: 'sent', label: 'Date sent', type: 'date' }],
      onSubmit: v => save('invoices', { id: inv.id, status: v.status, sent_at_utc: v.status !== 'Draft' && v.sent ? new Date(v.sent + 'T12:00:00Z').toISOString() : inv.sent_at_utc }),
    });
  };
  el.querySelector('[data-credit]')?.addEventListener('click', async () => {
    const reason = await askReason(`Credit / void ${inv.invoice_number}`, 'Reason — the approved hours on this invoice become available to invoice again');
    if (!reason) return;
    close();
    await save('invoices', { id: inv.id, status: 'Credited', credit_reason: reason }, { reason });
    toast('Invoice credited');
  });
  el.querySelector('[data-pay]')?.addEventListener('click', () => { close(); paymentForm(inv); });
}

async function paymentForm(inv) {
  const out = C.invoiceOutstanding(inv, S.payments);
  return formModal({
    title: `Payment for ${inv.invoice_number}`, wide: true,
    values: { received: today(), amount: C.hundredthsToString(Math.max(0, out)) },
    intro: h`<p class="note">Outstanding: <b>${C.fmtMoney(out, inv.currency)}</b>. Record only money actually received. Never enter bank logins or card numbers — an account label is enough.</p>`,
    fields: [
      { name: 'received', label: 'Date received', type: 'date', required: true },
      { name: 'amount', label: `Amount received (${inv.currency})`, type: 'money', required: true },
      { name: 'account_label', label: 'Receiving account label', placeholder: 'e.g. Wise, BPI savings' },
      { name: 'payment_reference', label: 'Reference' },
      { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, full: true },
      { name: 'files', label: 'Remittance / bank evidence', type: 'file', multiple: true, accept: 'image/*,application/pdf', full: true },
    ],
    onSubmit: async v => {
      const amt = C.toMinor(v.amount);
      if (!(amt > 0)) throw new Error('Enter an amount greater than zero.');
      if (amt > out && !await confirmDialog(`This payment is more than the outstanding balance (${C.fmtMoney(out, inv.currency)}). Record it anyway?`)) return false;
      const ev = v.files?.length ? await A.storeEvidenceFiles(v.files, { contract_id: inv.contract_id, related_work_date: v.received, evidence_type: 'payment_confirmation', provided_by: 'client', description: `Payment for ${inv.invoice_number}` }) : [];
      await save('payments', { invoice_id: inv.id, received_at_utc: new Date(v.received + 'T12:00:00Z').toISOString(), amount_minor: amt, currency: inv.currency, account_label: v.account_label, payment_reference: v.payment_reference, evidence_file_id: ev[0]?.id || null, notes: v.notes });
      toast('Payment recorded');
    },
  });
}
