import { S, get, save, today, scopeContractIds, contractLabel, defaultContractId, profile, nowIso, employerName } from '../store.js';
import { h, mount, table, badge, openDialog, formModal, askReason, toast, contractOptions, confirmDialog } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import * as A from '../actions.js';
import { printInvoice } from '../report-render.js';

const KIND = { Paid: 'ok', 'Partially paid': 'accent', Overdue: 'bad', Disputed: 'bad', Credited: '', Draft: '', 'Awaiting PO': 'warn', 'PO received': 'accent', Sent: 'accent', Acknowledged: 'accent' };
const monthLabel = from => new Date(C.dateToMs(from)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const billToFromEmployer = (e, c) => ({
  name: e?.legal_name || '', address: e?.address || '', contact: c?.approval_contact_name || e?.billing_contact_name || e?.primary_contact_name || '',
  email: c?.invoice_send_to || e?.billing_contact_email || c?.approval_contact_email || e?.primary_contact_email || '', reference: '',
  registration_number: e?.registration_number || '', tax_number: e?.tax_number || '',
});
const nextNumber = e => `${e?.invoice_prefix ?? 'INV-'}${String(e?.invoice_next_seq || 1).padStart(4, '0')}`;
const hasProcess = c => !!(c && (c.preinvoice_contact_email || c.po_required || c.invoice_send_to || c.require_timesheets));
const firstName = n => (n || '').trim().split(/\s+/)[0] || 'there';

// ---------- process rules ----------

// Everything that must be true before an invoice may be marked as sent to the client.
export function sendBlockers(inv) {
  const c = get('contracts', inv.contract_id);
  const out = [];
  if (!c) return out;
  if (c.preinvoice_contact_email && !inv.confirmation_sent_at) out.push(`Confirm the hours and amount with ${c.preinvoice_contact_name || c.preinvoice_contact_email} first`);
  if (c.po_required && !inv.po_number) out.push('Add the PO number');
  else if (c.po_mask && inv.po_number && !C.poMatches(c.po_mask, inv.po_number)) out.push(`PO number doesn't match the format ${c.po_mask}`);
  return out;
}
const timesheetCheck = inv => M.timesheetGaps(inv.contract_id, inv.period_start, inv.period_end);

function mailto(to, subject, body) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
function confirmationEmail(inv) {
  const c = get('contracts', inv.contract_id), p = profile() || {};
  const period = inv.invoice_cycle_month ? monthLabel(inv.period_start) : `${C.fmtDate(inv.period_start)} – ${C.fmtDate(inv.period_end)}`;
  const hours = C.hundredthsToString((inv.approved_centi || 0) + (inv.unapproved_centi || 0));
  return {
    to: c.preinvoice_contact_email,
    subject: `${period} invoice — hours confirmation — ${p.full_name || ''}`.trim(),
    body: `Hi ${firstName(c.preinvoice_contact_name)},\n\nFor ${period} I'd like to invoice ${hours} hours${inv.rate_snapshot ? ` at ${inv.currency} ${inv.rate_snapshot}/h` : ''}, a total of ${C.fmtMoney(C.invoiceTotal(inv), inv.currency)}.\n\n${timesheetCheck(inv).ok ? 'My timesheets for the period are up to date. ' : ''}Could you please check and issue a PO number?\n\nThank you,\n${p.full_name || ''}`,
  };
}
function invoiceEmail(inv) {
  const c = get('contracts', inv.contract_id), p = profile() || {};
  return {
    to: c.invoice_send_to,
    subject: `Invoice ${inv.invoice_number} — ${inv.po_number || ''} — ${p.full_name || ''}`.replace(/ — {2}/g, ' — ').trim(),
    body: `Hello,\n\nPlease find attached invoice ${inv.invoice_number}${inv.po_number ? ` (PO ${inv.po_number})` : ''} for ${C.fmtDate(inv.period_start)} – ${C.fmtDate(inv.period_end)}, total ${C.fmtMoney(C.invoiceTotal(inv), inv.currency)}.\n\nKind regards,\n${p.full_name || ''}`,
  };
}

// ---------- month-end ----------

// Calendar months that need attention for contracts invoiced monthly: the month being closed
// (end of month / first week of the next) and any earlier month whose invoice isn't sent yet.
export function monthEndTasks(cids, t = today()) {
  const tasks = [];
  const rem = M.remainingByApproval();
  const closing = C.monthEndDue(t);
  const prev = C.monthRange(C.addDays(C.monthRange(t).from, -1));
  for (const c of S.contracts.filter(x => cids.has(x.id) && x.invoice_cycle === 'monthly' && x.status !== 'archived')) {
    const months = [closing, prev].filter(Boolean).filter((m, i, a) => a.findIndex(x => x.from === m.from) === i);
    for (const m of months) {
      if (c.start_date && m.to < c.start_date) continue;
      const inv = S.invoices.find(i => i.contract_id === c.id && i.status !== 'Credited' && C.rangesOverlap(i.period_start, i.period_end, m.from, m.to));
      const leftCenti = S.approvals.filter(a => a.contract_id === c.id && C.inRange(a.period_start, m.from, m.to)).reduce((x, a) => x + Math.max(0, rem.get(a.id) || 0), 0);
      const logged = M.loggedMinutes(M.entriesIn(new Set([c.id]), m.from, m.to));
      if (inv && C.invoiceIssued(inv)) continue;
      if (!inv && !leftCenti && !logged) continue;
      tasks.push({ contract: c, month: m, invoice: inv || null, leftCenti, logged, gaps: M.timesheetGaps(c.id, m.from, m.to) });
    }
  }
  return tasks;
}

function nextStep(task) {
  const { contract: c, invoice: inv } = task;
  if (!inv) return task.gaps.ok || !c.require_timesheets ? 'Prepare the invoice' : 'Bring timesheets up to date';
  if (c.preinvoice_contact_email && !inv.confirmation_sent_at) return `Confirm hours with ${firstName(c.preinvoice_contact_name)}`;
  if (c.po_required && !inv.po_number) return `Waiting for PO from ${firstName(c.preinvoice_contact_name)}`;
  return `Send to ${c.invoice_send_to || 'the client'}`;
}

function monthEndPanel(tasks) {
  if (!tasks.length) return '';
  return h`<section class="panel">
    <div class="panel-head"><h2>Month-end</h2></div>
    <div class="list">${tasks.map(task => h`<div class="item">
      <div class="item-main"><div class="item-title">${monthLabel(task.month.from)} · ${employerName(get('employers', task.contract.employer_id))}</div>
        <div class="item-meta"><span>${C.fmtCenti(task.leftCenti)} approved, not invoiced</span><span class="dot-sep"></span><span>${C.fmtMinutesDec(task.logged)} logged</span>
          ${task.contract.require_timesheets ? task.gaps.ok ? badge('Timesheets up to date', 'ok') : badge(`${task.gaps.unsubmitted.length + task.gaps.unresolved.length} timesheet gap${task.gaps.unsubmitted.length + task.gaps.unresolved.length === 1 ? '' : 's'}`, 'warn') : ''}</div>
        <div class="small mt"><b>Next:</b> ${nextStep(task)}</div></div>
      <div class="item-side">${task.invoice ? h`<button class="btn sm primary" data-open="${task.invoice.id}">Open ${task.invoice.invoice_number}</button>`
        : h`<button class="btn sm primary" data-month="${task.contract.id}|${task.month.from}">Prepare invoice</button>`}</div>
    </div>`)}</div>
  </section>`;
}

// ---------- list ----------

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  const invs = S.invoices.filter(i => cids.has(i.contract_id)).sort((a, b) => b.invoice_date.localeCompare(a.invoice_date));
  const fin = M.finance(cids);
  mount(el, h`${monthEndPanel(monthEndTasks(cids, t))}
    <section class="panel">
    <div class="panel-head"><h2>Invoices</h2><button class="btn primary" data-new>New invoice from approved hours</button></div>
    <div class="stats">
      <div class="stat invoiced"><div class="stat-label">Approved, not invoiced</div><div class="stat-value">${Object.entries(fin.notInvoiced).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div><div class="stat-sub">${C.fmtCenti(fin.notInvoicedCenti)}</div></div>
      <div class="stat invoiced"><div class="stat-label">Outstanding invoice balance</div><div class="stat-value">${Object.entries(fin.outstanding).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div></div>
      <div class="stat paid"><div class="stat-label">Paid</div><div class="stat-value">${Object.entries(fin.paid).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—'}</div></div>
    </div>
    <div class="table-wrap stack">${table([
      { label: 'Number', render: i => h`<a href="#" data-open="${i.id}"><b>${i.invoice_number}</b></a>${i.po_number ? h`<div class="small muted">${i.po_number}</div>` : ''}` },
      { label: 'Contract', render: i => contractLabel(get('contracts', i.contract_id)) },
      { label: 'Period', render: i => i.invoice_cycle_month ? monthLabel(i.period_start) : `${C.fmtDate(i.period_start)} – ${C.fmtDate(i.period_end)}` },
      { label: 'Total', cls: 'num', render: i => C.fmtMoney(C.invoiceTotal(i), i.currency) },
      { label: 'Outstanding', cls: 'num', render: i => C.invoiceIssued(i) ? C.fmtMoney(C.invoiceOutstanding(i, S.payments), i.currency) : '—' },
      { label: 'Status', render: i => { const s = C.invoiceStatus(i, S.payments, t); return badge(s, KIND[s]); } },
    ], invs, { empty: 'No invoices yet. Create one from approved hours.' })}</div>
  </section>`);

  el.onclick = e => {
    const b = e.target.closest('[data-new],[data-open],[data-month]');
    if (!b) return;
    e.preventDefault();
    if ('new' in b.dataset) invoiceForm();
    else if (b.dataset.month) { const [cid, from] = b.dataset.month.split('|'); invoiceForm({ contract_id: cid, month: from }); }
    else detail(get('invoices', b.dataset.open));
  };
}

// ---------- create ----------

function approvalsTable(cid, month) {
  const rem = M.remainingByApproval();
  const range = month ? C.monthRange(month) : null;
  const rows = M.earnings(S.approvals.filter(a => a.contract_id === cid && (!range || C.inRange(a.period_start, range.from, range.to)))).rows
    .filter(r => (rem.get(r.approval.id) || 0) > 0)
    .sort((a, b) => a.approval.period_start.localeCompare(b.approval.period_start));
  if (!rows.length) return h`<div class="warnbox">No approved hours left to invoice${range ? ` in ${monthLabel(range.from)}` : ''} for this contract. Record approved hours first.</div>`;
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

function monthOptions(c, t) {
  const out = [['', 'Any approved period']];
  let m = C.monthRange(t);
  for (let i = 0; i < 12; i++) {
    if (c?.start_date && m.to < c.start_date) break;
    out.push([m.from, monthLabel(m.from)]);
    m = C.monthRange(C.addDays(m.from, -1));
  }
  return out;
}

export async function invoiceForm(prefill = {}) {
  let cid = prefill.contract_id || defaultContractId();
  if (!cid) return toast('Add a contract first', 'warn');
  const t = today();
  const contract = () => get('contracts', cid), employer = () => get('employers', contract()?.employer_id);
  // Monthly contracts default to the month being closed, else last month, else this month (if the contract started since).
  const defMonth = c => prefill.month ?? (c?.invoice_cycle !== 'monthly' ? '' :
    [C.monthEndDue(t), C.monthRange(C.addDays(C.monthRange(t).from, -1)), C.monthRange(t)]
      .find(m => m && (!c.start_date || m.to >= c.start_date))?.from || '');
  let month = defMonth(contract());
  const bt = billToFromEmployer(employer(), contract());
  const poHint = c => c?.po_mask ? `Format ${c.po_mask} — e.g. ${C.poExample(c.po_mask)}. Add it later if it hasn't been issued yet.` : 'Optional';
  const fields = [
    { name: 'contract_id', label: 'Contract', type: 'select', options: contractOptions(), required: true },
    { name: 'month', label: 'Billing month', type: 'select', options: monthOptions(contract(), t) },
    { name: 'invoice_number', label: 'Invoice number', required: true },
    { name: 'invoice_date', label: 'Invoice date', type: 'date', required: true },
    { name: 'lines', type: 'html', html: h`<div data-lines>${approvalsTable(cid, month)}</div>` },
    { name: 'extra_hours', label: 'Unapproved hours to include (exceptional)', type: 'hours', hint: 'Only with a reason. Shown as unapproved on the invoice record.' },
    { name: 'extra_reason', label: 'Reason for including unapproved hours' },
    { name: 'adjustments', label: 'Adjustment amount (+/−)', type: 'money' },
    { name: 'adjustment_reason', label: 'Adjustment note' },
    { name: 'po_number', label: 'PO number', hint: poHint(contract()), attrs: { autocapitalize: 'characters', spellcheck: 'false' } },
    { name: 'h1', type: 'html', html: h`<h3>Bill to <span class="small muted">(pre-filled from the employer record; edits apply to this invoice only)</span></h3>` },
    { name: 'bt_name', label: 'Bill-to name', required: true },
    { name: 'bt_contact', label: 'Contact' },
    { name: 'bt_address', label: 'Address', type: 'textarea', rows: 3 },
    { name: 'bt_email', label: 'Email' },
    { name: 'bt_reference', label: 'Other reference' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, full: true },
    { name: 'total', type: 'html', html: h`<div class="note" data-total>Total: —</div>` },
  ];
  const values = { contract_id: cid, month, invoice_number: nextNumber(employer()), invoice_date: t, ...Object.fromEntries(Object.entries(bt).map(([k, v]) => ['bt_' + k, v])) };
  return formModal({
    title: 'New invoice', wide: true, fields, values, submitLabel: 'Create draft',
    intro: hasProcess(contract()) ? h`<p class="note">New invoices start as drafts. Open the invoice afterwards to follow ${employerName(employer())}'s steps: confirm hours, add the PO, then send.</p>` : '',
    onInput: (v, form) => {
      if (v.contract_id !== cid) {
        cid = v.contract_id;
        const b = billToFromEmployer(employer(), contract());
        for (const k of Object.keys(b)) if (form.elements['bt_' + k]) form.elements['bt_' + k].value = b[k];
        form.elements.invoice_number.value = nextNumber(employer());
        form.elements.month.innerHTML = monthOptions(contract(), t).map(([val, l]) => `<option value="${val}">${l}</option>`).join('');
        form.elements.month.value = month = defMonth(contract());
        form.querySelector('[data-field="po_number"] small').textContent = poHint(contract());
        form.querySelector('[data-lines]').innerHTML = approvalsTable(cid, month).s;
      } else if (v.month !== month) {
        month = v.month;
        form.querySelector('[data-lines]').innerHTML = approvalsTable(cid, month).s;
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
      const po = v.po_number.replace(/\s+/g, '').toUpperCase();
      if (po && c.po_mask && !C.poMatches(c.po_mask, po)) throw new Error(`PO number must match ${c.po_mask} exactly (e.g. ${C.poExample(c.po_mask)}).`);
      if (extra && !await confirmDialog(`You are invoicing ${C.fmtCenti(extra)} that is NOT recorded as approved.\nReason: ${v.extra_reason}`, { ok: 'Include anyway' })) return false;
      const rateNow = C.rateOn(S.rates, c.id, v.invoice_date);
      const extraMinor = Math.round(extra * C.toMinor(rateNow?.hourly_rate || 0) / 100);
      const subtotal = lines.reduce((a, l) => a + Math.round(l.centi * l.rateMinor / 100), 0) + extraMinor;
      const starts = lines.map(l => l.start).sort(), ends = lines.map(l => l.end).sort();
      const range = v.month ? C.monthRange(v.month) : null;
      const inv = await save('invoices', {
        contract_id: c.id, invoice_number: v.invoice_number, invoice_date: v.invoice_date, status: 'Draft', currency: c.currency,
        period_start: range?.from || starts[0] || v.invoice_date, period_end: range?.to || ends.at(-1) || v.invoice_date, invoice_cycle_month: !!range,
        approved_centi: lines.reduce((a, l) => a + l.centi, 0), unapproved_centi: extra, unapproved_reason: v.extra_reason || '',
        subtotal_minor: subtotal, adjustments_minor: C.toMinor(v.adjustments || 0) || 0, adjustment_reason: v.adjustment_reason,
        rate_snapshot: [...new Set(lines.map(l => l.rateMinor))].map(r => C.hundredthsToString(r)).join(', ') || rateNow?.hourly_rate || '',
        po_number: po || null, po_received_at: po ? nowIso() : null,
        bill_to_snapshot_json: { name: v.bt_name, contact: v.bt_contact, address: v.bt_address, email: v.bt_email, reference: v.bt_reference, registration_number: e?.registration_number, tax_number: e?.tax_number },
        from_snapshot_json: { ...profile() },
        due_date: c.payment_terms_working_days ? C.addWorkingDays(v.invoice_date, c.payment_terms_working_days) : null,
        sent_at_utc: null, notes: v.notes,
      });
      for (const l of lines) await save('allocations', { invoice_id: inv.id, approval_record_id: l.approval_record_id, hours_allocated: C.hundredthsToString(l.centi), amount_minor: Math.round(l.centi * l.rateMinor / 100) });
      if (v.invoice_number === nextNumber(e)) await save('employers', { id: e.id, invoice_next_seq: (e.invoice_next_seq || 1) + 1 }, { audit: false });
      toast(`Draft ${inv.invoice_number} created`);
      setTimeout(() => detail(get('invoices', inv.id)), 350);
      return inv;
    },
  });
}

// ---------- detail + process ----------

function processPanel(inv) {
  const c = get('contracts', inv.contract_id);
  if (!hasProcess(c) || inv.status === 'Credited') return '';
  const ts = timesheetCheck(inv);
  const issued = C.invoiceIssued(inv);
  const blockers = sendBlockers(inv);
  const step = (done, n, title, body) => h`<li class="step ${done ? 'done' : ''}"><span class="step-n">${done ? '✓' : n}</span><div><b>${title}</b>${body ? h`<div class="small">${body}</div>` : ''}</div></li>`;
  let n = 0;
  return h`<div class="process">
    <h3>${employerName(get('employers', c.employer_id))} invoicing steps</h3>
    <ol class="steps">
      ${c.require_timesheets ? step(ts.ok, ++n, 'Timesheets up to date', ts.ok ? 'Every logged day in the period has a submitted timesheet.' :
        h`${ts.unsubmitted.length ? h`Not yet submitted: ${ts.unsubmitted.map(C.fmtDate).join(', ')}. ` : ''}${ts.unresolved.length ? h`${ts.unresolved.length} submission(s) rejected or awaiting clarification. ` : ''}<a href="#/approvals">Record submissions →</a>`) : ''}
      ${c.preinvoice_contact_email ? step(!!inv.confirmation_sent_at, ++n, `Confirm hours & amount with ${c.preinvoice_contact_name || c.preinvoice_contact_email}`,
        inv.confirmation_sent_at ? `Emailed ${C.fmtDate(inv.confirmation_sent_at)}` : h`<div class="btn-row mt"><a class="btn sm" data-mail="confirm" href="${mailto(...Object.values(confirmationEmail(inv)))}">Write email to ${firstName(c.preinvoice_contact_name)}</a><button class="btn sm primary" data-act="confirmed">I've emailed ${firstName(c.preinvoice_contact_name)}</button></div>`) : ''}
      ${c.po_required || c.po_mask ? step(!!inv.po_number, ++n, 'Add the PO number', inv.po_number ? h`<b class="po">${inv.po_number}</b>${issued ? '' : h` <button class="btn sm ghost" data-act="po">Change</button>`}` :
        h`Exactly ${c.po_mask} — no spaces. <div class="btn-row mt"><button class="btn sm primary" data-act="po">Enter PO number</button></div>`) : ''}
      ${step(issued, ++n, `Send only to ${c.invoice_send_to || 'the client'}`, issued ? `Sent ${C.fmtDate(inv.sent_at_utc)}` : blockers.length ? h`<span class="muted">Locked until: ${blockers.join(' · ')}</span>` :
        h`Print or save the PDF, attach it to the email, then mark it sent.<div class="btn-row mt"><button class="btn sm" data-act="print">Print / PDF</button>${c.invoice_send_to ? h`<a class="btn sm" href="${mailto(...Object.values(invoiceEmail(inv)))}">Write email</a>` : ''}<button class="btn sm primary" data-act="sent">Mark as sent</button></div>`)}
    </ol>
    ${c.invoice_process_notes ? h`<details class="mt"><summary class="small">Client's rules</summary><p class="small pre">${c.invoice_process_notes}</p></details>` : ''}
  </div>`;
}

function detail(inv) {
  if (!inv) return;
  const t = today();
  const c = get('contracts', inv.contract_id);
  const status = C.invoiceStatus(inv, S.payments, t);
  const pays = S.payments.filter(p => p.invoice_id === inv.id);
  const allocs = S.allocations.filter(a => a.invoice_id === inv.id);
  const bt = inv.bill_to_snapshot_json || {};
  const issued = C.invoiceIssued(inv);
  const { el, close } = openDialog({
    title: `Invoice ${inv.invoice_number}`, wide: true,
    body: h`${processPanel(inv)}<dl class="kv">
        <dt>Status</dt><dd>${badge(status, KIND[status])}</dd>
        <dt>Contract</dt><dd>${contractLabel(c)}</dd>
        ${inv.po_number ? h`<dt>PO number</dt><dd><b class="po">${inv.po_number}</b></dd>` : ''}
        <dt>Bill to</dt><dd class="pre">${[bt.name, bt.contact, bt.address, bt.email, bt.reference && 'Ref: ' + bt.reference].filter(Boolean).join('\n')}</dd>
        <dt>Period</dt><dd>${inv.invoice_cycle_month ? monthLabel(inv.period_start) + ' · ' : ''}${C.fmtDate(inv.period_start)} – ${C.fmtDate(inv.period_end)}</dd>
        <dt>Dates</dt><dd>Invoice date ${C.fmtDate(inv.invoice_date)}${inv.due_date && issued ? ` · due (estimate) ${C.fmtDate(inv.due_date)}` : ''}</dd>
        <dt>Approved hours</dt><dd>${C.fmtCenti(inv.approved_centi || 0)} @ ${inv.rate_snapshot} ${inv.currency}</dd>
        ${inv.unapproved_centi ? h`<dt>Unapproved</dt><dd>${badge(C.fmtCenti(inv.unapproved_centi) + ' not approved', 'warn')} ${inv.unapproved_reason}</dd>` : ''}
        <dt>Subtotal</dt><dd>${C.fmtMoney(inv.subtotal_minor, inv.currency)}</dd>
        ${inv.adjustments_minor ? h`<dt>Adjustments</dt><dd>${C.fmtMoney(inv.adjustments_minor, inv.currency)} ${inv.adjustment_reason || ''}</dd>` : ''}
        <dt>Total</dt><dd><b>${C.fmtMoney(C.invoiceTotal(inv), inv.currency)}</b></dd>
        ${issued ? h`<dt>Paid</dt><dd>${C.fmtMoney(C.invoicePaid(inv, S.payments), inv.currency)}</dd><dt>Outstanding</dt><dd><b>${C.fmtMoney(C.invoiceOutstanding(inv, S.payments), inv.currency)}</b></dd>` : ''}
      </dl>
      <h3 class="mt">Allocated approvals</h3>
      ${table([
        { label: 'Approval period', render: a => { const ap = get('approvals', a.approval_record_id); return ap ? `${C.fmtDate(ap.period_start)} – ${C.fmtDate(ap.period_end)}` : '(deleted)'; } },
        { label: 'Hours', cls: 'num', render: a => a.hours_allocated + ' h' },
        { label: 'Amount', cls: 'num', render: a => C.fmtMoney(a.amount_minor, inv.currency) },
      ], allocs)}
      ${issued ? h`<h3 class="mt">Payments</h3>${table([
        { label: 'Date', render: p => C.fmtDate(p.received_at_utc) },
        { label: 'Reference', render: p => p.payment_reference || '' },
        { label: 'Account', render: p => p.account_label || '' },
        { label: 'Amount', cls: 'num', render: p => C.fmtMoney(p.amount_minor, p.currency) },
      ], pays, { empty: 'No payments recorded.' })}` : ''}`,
    actions: h`${inv.status !== 'Credited' ? h`<button class="btn danger ghost" data-act="credit">${issued ? 'Credit' : 'Cancel draft'}</button>` : ''}<span class="grow"></span>
      ${issued ? h`<button class="btn" data-act="status">Change status</button>` : ''}<button class="btn" data-act="file">Attach file</button><button class="btn" data-act="print">Print / PDF</button>
      ${issued ? h`<button class="btn primary" data-act="pay">Record payment</button>` : hasProcess(c) ? '' : h`<button class="btn primary" data-act="sent">Mark as sent</button>`}`,
  });
  const reopen = () => setTimeout(() => detail(get('invoices', inv.id)), 250);

  el.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'print') return printInvoice(get('invoices', inv.id));
    if (act === 'file') { close(); return A.uploadEvidence({ contract_id: inv.contract_id, related_work_date: inv.invoice_date, evidence_type: 'submitted_invoice', description: `Invoice ${inv.invoice_number}` }); }
    if (act === 'pay') { close(); return paymentForm(inv); }
    if (act === 'confirmed') {
      close();
      await save('invoices', { id: inv.id, status: 'Awaiting PO', confirmation_sent_at: nowIso(), confirmation_to: c.preinvoice_contact_email }, { action: 'confirmation sent' });
      toast(`Marked as emailed to ${firstName(c.preinvoice_contact_name)} — add the PO when it arrives`);
      return reopen();
    }
    if (act === 'po') { close(); await poForm(inv); return reopen(); }
    if (act === 'sent') { close(); await markSent(inv); return reopen(); }
    if (act === 'status') {
      close();
      await formModal({
        title: 'Invoice status', values: { status: inv.status },
        fields: [{ name: 'status', label: 'Status', type: 'select', options: ['Sent', 'Acknowledged', 'Disputed'] }],
        onSubmit: v => save('invoices', { id: inv.id, status: v.status }),
      });
      return;
    }
    if (act === 'credit') {
      const reason = await askReason(issued ? `Credit ${inv.invoice_number}` : `Cancel draft ${inv.invoice_number}`, 'Reason — the approved hours on this invoice become available to invoice again');
      if (!reason) return;
      close();
      await save('invoices', { id: inv.id, status: 'Credited', credit_reason: reason }, { reason });
      toast(issued ? 'Invoice credited' : 'Draft cancelled');
    }
  });
}

async function poForm(inv) {
  const c = get('contracts', inv.contract_id);
  return formModal({
    title: `PO number for ${inv.invoice_number}`, values: { po: inv.po_number || '' },
    intro: c.po_mask ? h`<p class="note">Must match <b>${c.po_mask}</b> exactly, e.g. <b>${C.poExample(c.po_mask)}</b>. No spaces or extra characters.</p>` : '',
    fields: [{ name: 'po', label: 'PO number', required: true, attrs: { autocapitalize: 'characters', spellcheck: 'false', autocomplete: 'off' } }],
    onSubmit: async v => {
      const po = v.po.replace(/\s+/g, '').toUpperCase();
      if (c.po_mask && !C.poMatches(c.po_mask, po)) throw new Error(`“${po}” doesn't match ${c.po_mask}. Check the number from the PO email.`);
      const reason = inv.po_number ? await askReason('Why is the PO number changing?') : '';
      if (inv.po_number && !reason) return false;
      await save('invoices', { id: inv.id, po_number: po, po_received_at: nowIso(), status: C.invoiceIssued(inv) ? inv.status : 'PO received' }, { reason, action: 'po number' });
      toast(`PO ${po} saved`);
    },
  });
}

async function markSent(inv) {
  const c = get('contracts', inv.contract_id);
  const blockers = sendBlockers(inv);
  if (blockers.length) return toast(blockers.join(' · '), 'warn', 6000);
  const ts = timesheetCheck(inv);
  let reason = '';
  if (c.require_timesheets && !ts.ok) {
    reason = await askReason('Timesheets are not up to date', `The client requires up-to-date timesheets. Days not yet submitted: ${ts.unsubmitted.map(C.fmtDate).join(', ') || 'none'}. Give a reason to send anyway`);
    if (!reason) return;
  }
  return formModal({
    title: `Mark ${inv.invoice_number} as sent`, values: { sent: today(), to: c.invoice_send_to || '' },
    intro: c.invoice_send_to ? h`<p class="note">Invoices for this contract go <b>only</b> to ${c.invoice_send_to} — not via anyone else.</p>` : '',
    fields: [
      { name: 'sent', label: 'Date sent', type: 'date', required: true },
      { name: 'to', label: 'Sent to', type: 'email', required: true },
    ],
    onSubmit: async v => {
      if (c.invoice_send_to && v.to.trim().toLowerCase() !== c.invoice_send_to.trim().toLowerCase()) throw new Error(`This client only accepts invoices at ${c.invoice_send_to}.`);
      await save('invoices', {
        id: inv.id, status: 'Sent', sent_at_utc: new Date(v.sent + 'T12:00:00Z').toISOString(), sent_to: v.to,
        due_date: c.payment_terms_working_days ? C.addWorkingDays(v.sent, c.payment_terms_working_days) : inv.due_date,
      }, { reason, action: 'sent' });
      toast(`${inv.invoice_number} marked as sent`);
    },
  });
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
