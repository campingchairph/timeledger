import { S, get, save, remove, today, employerName, contractStatus, contractRates, linkedCounts, profile, settings, updateSettings } from '../store.js';
import { h, mount, badge, empty, formModal, confirmDialog, toast, imageToDataUrl, askReason } from '../ui.js';
import * as C from '../calc.js';
import { allZones, allCurrencies } from '../tz.js';

let showArchived = false;
const zoneOpts = () => allZones().map(z => [z, z]);
const curOpts = () => allCurrencies().map(c => [c, c]);

export function render(el) {
  const t = today();
  const emps = S.employers.filter(e => showArchived || e.status !== 'archived')
    .sort((a, b) => (a.status === 'archived') - (b.status === 'archived') || employerName(a).localeCompare(employerName(b)));
  const archivedN = S.employers.filter(e => e.status === 'archived').length;

  mount(el, h`<section class="panel">
    <div class="panel-head"><h2>Employers & contracts</h2>${archivedN ? h`<label class="check"><input type="checkbox" data-arch ${showArchived ? h`checked` : ''}> Show archived (${archivedN})</label>` : ''}<button class="btn primary" data-new-emp>Add employer</button></div>
    <p class="note">Every record belongs to a contract, and every contract to an employer. Archive instead of deleting — archived items leave quick-entry pickers but keep all their records and reports.</p>
    ${emps.length ? emps.map(e => {
      const cons = S.contracts.filter(c => c.employer_id === e.id).sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
      return h`<div class="panel" style="background:var(--surface-2)">
        <div class="panel-head">
          ${e.logo ? h`<img class="logo-prev" src="${e.logo}" alt="">` : ''}
          <h2>${e.legal_name}${e.display_name && e.display_name !== e.legal_name ? h` <span class="muted small">(${e.display_name})</span>` : ''} ${e.status === 'archived' ? badge('Archived') : ''}</h2>
          <button class="btn sm" data-edit-emp="${e.id}">Edit details</button>
          <button class="btn sm" data-new-con="${e.id}">Add contract</button>
          <button class="btn sm ghost" data-arch-emp="${e.id}">${e.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
          <button class="btn sm danger ghost" data-del-emp="${e.id}">Delete</button>
        </div>
        <div class="small muted">${[e.primary_contact_name && `Contact: ${e.primary_contact_name}${e.primary_contact_role ? ' (' + e.primary_contact_role + ')' : ''}`, e.default_currency, e.default_timezone, e.registration_number && `Reg. ${e.registration_number}`].filter(Boolean).join(' · ')}</div>
        <div class="list mt">${cons.length ? cons.map(c => {
          const st = contractStatus(c, t);
          const rates = contractRates(c.id);
          const cur = C.rateOn(S.rates, c.id, t) || rates.at(-1);
          return h`<div class="item"><div class="item-main">
              <div class="item-title">${c.title} ${badge(st, st === 'active' ? 'ok' : st === 'upcoming' ? 'accent' : '')}</div>
              <div class="item-meta"><span>${C.fmtDate(c.start_date)} – ${c.end_date ? C.fmtDate(c.end_date) : 'open-ended'}</span><span>${c.currency}</span>
                <span>${cur ? `${cur.hourly_rate} ${cur.currency}/h` : h`<span class="badge bad">No rate</span>`}${rates.length > 1 ? ` (${rates.length} rates)` : ''}</span>
                <span>Approver: ${c.approval_contact_name || '—'}</span><span>${c.primary_timezone}${c.secondary_timezone ? ' / ' + c.secondary_timezone : ''}</span></div>
              ${c.payment_terms_text ? h`<div class="small mt">Payment terms: ${c.payment_terms_text}</div>` : ''}
            </div><div class="item-side btn-row" style="justify-content:flex-end">
              <button class="btn sm" data-edit-con="${c.id}">Edit</button><button class="btn sm" data-rates="${c.id}">Rates</button>
              <button class="btn sm ghost" data-arch-con="${c.id}">${c.status === 'archived' ? 'Unarchive' : 'Archive'}</button>
              <button class="btn sm danger ghost" data-del-con="${c.id}">Delete</button></div></div>`;
        }) : empty('No contracts yet.')}</div>
      </div>`;
    }) : empty('No employers yet.', h`<button class="btn primary" data-new-emp>Add employer</button>`)}
  </section>`);

  el.onchange = e => { if ('arch' in e.target.dataset) { showArchived = e.target.checked; render(el); } };
  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if ('newEmp' in d) employerForm();
    else if (d.editEmp) employerForm(get('employers', d.editEmp));
    else if (d.newCon) contractForm(null, d.newCon);
    else if (d.editCon) contractForm(get('contracts', d.editCon));
    else if (d.rates) ratesDialog(get('contracts', d.rates));
    else if (d.archEmp) { const x = get('employers', d.archEmp); await save('employers', { id: x.id, status: x.status === 'archived' ? 'active' : 'archived' }, { action: x.status === 'archived' ? 'unarchive' : 'archive' }); clearSelection(); }
    else if (d.archCon) { const x = get('contracts', d.archCon); await save('contracts', { id: x.id, status: x.status === 'archived' ? 'active' : 'archived' }, { action: x.status === 'archived' ? 'unarchive' : 'archive' }); clearSelection(); }
    else if (d.delEmp) hardDelete('employer', get('employers', d.delEmp));
    else if (d.delCon) hardDelete('contract', get('contracts', d.delCon));
  };
}

function clearSelection() {
  const s = settings().selection || {};
  if ((s.contractId && !get('contracts', s.contractId)) || (s.employerId && !get('employers', s.employerId))) updateSettings({ selection: { employerId: null, contractId: null } });
}

async function hardDelete(kind, rec) {
  const cons = kind === 'employer' ? S.contracts.filter(c => c.employer_id === rec.id) : [rec];
  const counts = linkedCounts(cons.map(c => c.id));
  const n = Object.values(counts).reduce((a, b) => a + b, 0);
  const name = kind === 'employer' ? rec.legal_name : rec.title;
  const msg = n
    ? `“${name}” has ${n} linked record(s): ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}.\n\nDeleting is permanent and removes ${kind === 'employer' ? 'the employer, its contracts' : 'the contract'} and ALL linked records. Consider archiving instead.`
    : `Permanently delete “${name}”?`;
  if (!await confirmDialog(msg, { title: `Delete ${kind}`, danger: true, ok: 'Delete permanently', typeToConfirm: n ? 'DELETE' : undefined })) return;
  const reason = n ? await askReason('Reason for deleting') : 'No linked records';
  if (!reason) return;
  const ids = new Set(cons.map(c => c.id));
  const invIds = new Set(S.invoices.filter(i => ids.has(i.contract_id)).map(i => i.id));
  for (const t of ['entries', 'tasks', 'timers', 'evidence', 'submissions', 'approvals', 'plans', 'invoices']) for (const r of S[t].filter(x => ids.has(x.contract_id))) await remove(t, r.id, { reason, audit: false });
  for (const r of S.payments.filter(p => invIds.has(p.invoice_id))) await remove('payments', r.id, { reason, audit: false });
  for (const r of S.allocations.filter(a => invIds.has(a.invoice_id))) await remove('allocations', r.id, { reason, audit: false });
  for (const r of S.rates.filter(x => ids.has(x.contract_id))) await remove('rates', r.id, { reason, audit: false });
  for (const c of cons) await remove('contracts', c.id, { reason });
  if (kind === 'employer') await remove('employers', rec.id, { reason });
  clearSelection();
  toast(`${kind === 'employer' ? 'Employer' : 'Contract'} deleted`);
}

async function employerForm(existing) {
  const fields = [
    { name: 'legal_name', label: 'Legal / company name', required: true },
    { name: 'display_name', label: 'Display / trading name' },
    { name: 'address', label: 'Registered address', type: 'textarea', rows: 3, full: true },
    { name: 'registration_number', label: 'Company / registration no.' },
    { name: 'tax_number', label: 'VAT / tax number' },
    { name: 'primary_contact_name', label: 'Primary contact name' },
    { name: 'primary_contact_role', label: 'Primary contact role' },
    { name: 'primary_contact_email', label: 'Primary contact email', type: 'email' },
    { name: 'billing_contact_name', label: 'Accounts / billing contact' },
    { name: 'billing_contact_email', label: 'Billing email', type: 'email' },
    { name: 'default_currency', label: 'Default currency', type: 'select', options: curOpts(), required: true },
    { name: 'default_timezone', label: 'Default timezone', type: 'select', options: zoneOpts(), required: true },
    { name: 'invoice_prefix', label: 'Invoice number prefix' },
    { name: 'invoice_next_seq', label: 'Next invoice sequence', type: 'number', attrs: { min: 1 } },
    { name: 'accent', label: 'Report accent colour', type: 'color' },
    { name: 'logo_file', label: 'Logo (optional)', type: 'file', accept: 'image/*' },
    { name: 'notes', label: 'Notes', type: 'textarea', rows: 2, full: true },
  ];
  return formModal({
    title: existing ? 'Edit employer' : 'Add employer', wide: true, fields,
    values: existing || { default_currency: 'USD', default_timezone: 'UTC', invoice_prefix: 'INV-', invoice_next_seq: 1, accent: '#1f3a5f' },
    intro: existing ? h`<p class="note">Changes apply to future reports and invoices. Previously exported reports keep the header they were generated with.</p>` : '',
    onSubmit: async v => {
      const { logo_file, ...rest } = v;
      rest.invoice_next_seq = Math.max(1, parseInt(rest.invoice_next_seq, 10) || 1);
      if (logo_file?.length) rest.logo = await imageToDataUrl(logo_file[0], 300, 'image/png');
      const emp = await save('employers', { ...rest, id: existing?.id, status: existing?.status || 'active' });
      toast(existing ? 'Employer updated' : 'Employer added');
      if (!existing && await confirmDialog('Add the first contract for this employer now?', { ok: 'Add contract' })) contractForm(null, emp.id);
      return emp;
    },
  });
}

async function contractForm(existing, employerId) {
  const emp = get('employers', existing?.employer_id || employerId);
  const p = profile();
  const fields = [
    { name: 'title', label: 'Contract title', required: true },
    { name: 'status', label: 'Status', type: 'select', options: [['draft', 'Draft'], ['active', 'Active'], ['ended', 'Ended'], ['archived', 'Archived']] },
    { name: 'start_date', label: 'Start date', type: 'date', required: true },
    { name: 'end_date', label: 'End date (optional)', type: 'date' },
    { name: 'currency', label: 'Contract currency', type: 'select', options: curOpts(), required: true },
    ...(existing ? [] : [{ name: 'hourly_rate', label: 'Hourly rate', type: 'money', required: true }]),
    { name: 'primary_timezone', label: 'Primary timezone', type: 'select', options: zoneOpts() },
    { name: 'secondary_timezone', label: 'Secondary (client) timezone', type: 'select', options: [['', '— none —'], ...zoneOpts()] },
    { name: 'approval_contact_name', label: 'Approval contact name' },
    { name: 'approval_contact_email', label: 'Approval contact email', type: 'email' },
    { name: 'work_arrangement', label: 'Work arrangement', type: 'textarea', rows: 2, full: true },
    { name: 'invoice_requirements', label: 'Invoice requirements' },
    { name: 'payment_terms_text', label: 'Payment terms (text)' },
    { name: 'payment_terms_working_days', label: 'Payment terms in working days (for due-date estimates)', type: 'number', attrs: { min: 0 } },
    { name: 'daily_cap_hours', label: 'Optional per-contract daily cap (hours)', type: 'hours', hint: 'Personal limit only — never a contractual guarantee.' },
    { name: 'reporting_anchor_date', label: '14-day reporting anchor (optional)', type: 'date' },
    { name: 'end_behavior_text', label: 'End behaviour', type: 'textarea', rows: 2, full: true },
  ];
  const values = existing ? { ...existing, daily_cap_hours: existing.daily_availability_limit_minutes ? C.hundredthsToString(C.minutesToCenti(existing.daily_availability_limit_minutes)) : '' }
    : { status: 'active', start_date: today(), currency: emp?.default_currency, primary_timezone: p?.home_timezone, secondary_timezone: emp?.default_timezone !== p?.home_timezone ? emp?.default_timezone : '', approval_contact_name: emp?.primary_contact_name };
  return formModal({
    title: existing ? 'Edit contract' : `New contract · ${employerName(emp)}`, wide: true, fields, values,
    intro: existing ? h`<p class="note">Rates are managed separately and are effective-dated, so changing a rate never rewrites past earnings.</p>` : '',
    onSubmit: async v => {
      if (v.end_date && v.end_date < v.start_date) throw new Error('End date is before start date.');
      const { hourly_rate, daily_cap_hours, ...rest } = v;
      rest.payment_terms_working_days = v.payment_terms_working_days === '' ? null : +v.payment_terms_working_days;
      rest.daily_availability_limit_minutes = daily_cap_hours ? C.centiToMinutes(C.toCenti(daily_cap_hours)) : null;
      rest.end_date ||= null; rest.reporting_anchor_date ||= null;
      if (!existing && !(C.toMinor(hourly_rate) > 0)) throw new Error('Enter an hourly rate.');
      const con = await save('contracts', { ...rest, id: existing?.id, employer_id: emp.id });
      if (!existing) await save('rates', { contract_id: con.id, hourly_rate: C.hundredthsToString(C.toMinor(hourly_rate)), currency: con.currency, effective_from: con.start_date, effective_to: null, notes: 'Initial rate' });
      if (existing && existing.currency !== con.currency) toast('Currency changed — add a new effective-dated rate in that currency.', 'warn', 6000);
      else toast(existing ? 'Contract updated' : 'Contract added');
      return con;
    },
  });
}

async function ratesDialog(c) {
  const rates = contractRates(c.id);
  return formModal({
    title: `Rates · ${c.title}`, wide: true, submitLabel: 'Add new rate',
    intro: h`<p class="note">Each rate applies from its effective date. Adding a new rate closes the previous one the day before — historic approved hours keep the rate that applied.</p>
      <div class="table-wrap"><table><thead><tr><th>From</th><th>To</th><th class="num">Rate</th><th>Notes</th></tr></thead><tbody>
      ${rates.map(r => h`<tr><td>${C.fmtDate(r.effective_from)}</td><td>${r.effective_to ? C.fmtDate(r.effective_to) : 'current'}</td><td class="num">${r.hourly_rate} ${r.currency}</td><td>${r.notes || ''}</td></tr>`)}
      </tbody></table></div><h3 class="mt">Add a rate</h3>`,
    fields: [
      { name: 'hourly_rate', label: `Hourly rate (${c.currency})`, type: 'money', required: true },
      { name: 'effective_from', label: 'Effective from', type: 'date', required: true },
      { name: 'notes', label: 'Notes (e.g. renewal)' },
    ],
    values: { effective_from: today() },
    onSubmit: async v => {
      if (!(C.toMinor(v.hourly_rate) > 0)) throw new Error('Enter a rate greater than zero.');
      if (rates.some(r => r.effective_from === v.effective_from)) throw new Error('A rate already starts on that date.');
      const prev = rates.filter(r => r.effective_from < v.effective_from).at(-1);
      const next = rates.find(r => r.effective_from > v.effective_from);
      if (prev && (!prev.effective_to || prev.effective_to >= v.effective_from)) await save('rates', { id: prev.id, effective_to: C.addDays(v.effective_from, -1) }, { reason: 'Closed by new rate' });
      await save('rates', { contract_id: c.id, hourly_rate: C.hundredthsToString(C.toMinor(v.hourly_rate)), currency: c.currency, effective_from: v.effective_from, effective_to: next ? C.addDays(next.effective_from, -1) : null, notes: v.notes });
      toast('Rate added');
    },
  });
}
