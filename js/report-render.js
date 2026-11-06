// Report builder: one data model (summary + sections) rendered to print-ready HTML or CSV.
// Generating a report never modifies source records.

import { S, get, profile, homeCurrency, homeTz, employerName, contractRates } from './store.js';
import { esc } from './ui.js';
import * as C from './calc.js';
import * as M from './metrics.js';
import { rateFor } from './fx.js';
import { fmtDateTime, timeIn } from './tz.js';
import { evidenceTypeLabel } from './actions.js';

export const REPORT_TYPES = [
  ['daily', 'Daily Work Report'], ['timesheet', 'Detailed Timesheet'], ['reconciliation', 'Approval & Hours Reconciliation'],
  ['earnings', 'Earnings Report'], ['invoice_support', 'Invoice Support Pack'], ['evidence', 'Evidence Register'],
  ['contract', 'Contract Summary'], ['multi', 'Multi-employer Summary'],
];

export function scopeContracts(scope) {
  if (scope.kind === 'contract') return S.contracts.filter(c => c.id === scope.id);
  if (scope.kind === 'employer') return S.contracts.filter(c => c.employer_id === scope.id);
  return S.contracts.slice();
}

const fmtMoneyBucket = b => Object.entries(b).map(([c, v]) => C.fmtMoney(v, c)).join(' · ') || '—';
const hrs = c => C.fmtCenti(c);
const cname = id => { const c = get('contracts', id); return c ? `${employerName(get('employers', c.employer_id))} · ${c.title}` : '—'; };

function phpLine(byCur) {
  const home = homeCurrency(), tz = homeTz();
  return Object.entries(byCur).map(([cur, v]) => {
    if (cur === home) return C.fmtMoney(v, home);
    const r = rateFor(cur, home);
    return r.rate ? `≈ ${C.fmtMoney(C.convertMinor(v, r.rate), home)} (1 ${cur} = ${r.rate.toFixed(4)} ${home}, ${r.provider}, ${fmtDateTime(r.fetched_at_utc, tz)}${r.stale ? ', stale' : ''})` : `${cur}: no exchange rate available`;
  }).join(' · ') || '—';
}

export function buildReport({ type, scope, from, to }) {
  const contracts = scopeContracts(scope);
  const cids = new Set(contracts.map(c => c.id));
  const tz = homeTz();
  const entries = M.entriesIn(cids, from, to).sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc));
  const apps = S.approvals.filter(a => cids.has(a.contract_id) && C.rangesOverlap(a.period_start, a.period_end, from || '0000', to || '9999'))
    .sort((a, b) => a.period_start.localeCompare(b.period_start));
  const subs = S.submissions.filter(s => cids.has(s.contract_id) && s.status !== 'Draft' && C.rangesOverlap(s.period_start, s.period_end, from || '0000', to || '9999'));
  const evidence = S.evidence.filter(f => cids.has(f.contract_id) && C.inRange(f.related_work_date || '', from, to)).sort((a, b) => (a.related_work_date || '').localeCompare(b.related_work_date || ''));
  const earn = M.earnings(apps);
  const logged = M.loggedMinutes(entries);
  const submitted = M.sumCenti(subs, 'submitted_hours');
  const invs = S.invoices.filter(i => cids.has(i.contract_id) && i.status !== 'Credited' && i.status !== 'Draft' && C.inRange(i.invoice_date, from, to));
  const invoiced = {}, paid = {};
  for (const i of invs) { C.addTo(invoiced, i.currency, C.invoiceTotal(i)); C.addTo(paid, i.currency, C.invoicePaid(i, S.payments)); }
  const outstanding = {};
  for (const [c, v] of Object.entries(invoiced)) outstanding[c] = v - (paid[c] || 0);
  const rates = contracts.map(c => contractRates(c.id).filter(r => !to || r.effective_from <= to).filter(r => !from || !r.effective_to || r.effective_to >= from)
    .map(r => `${r.hourly_rate} ${r.currency}/h from ${C.fmtDate(r.effective_from)}`).join('; ')).filter(Boolean);

  const diff = C.pendingDifference(submitted, earn.centi);
  const summary = [
    ['Logged hours', `${C.fmtMinutesDec(logged)} (${C.fmtHM(logged)})`],
    ['Submitted hours', hrs(submitted)],
    ['Approved hours', hrs(earn.centi)],
    ['Pending difference (submitted − approved)', hrs(diff.diff) + (diff.approvedExceedsSubmitted ? ' — approved exceeds submitted' : '')],
    ['Logged but not approved', hrs(C.minutesToCenti(logged) - earn.centi)],
    ['Rate(s)', rates.join(' | ') || '—'],
    ['Earned (approved × rate)', fmtMoneyBucket(earn.byCur)],
    [`${homeCurrency()} estimate`, phpLine(earn.byCur)],
    ['Invoiced', fmtMoneyBucket(invoiced)],
    ['Paid', fmtMoneyBucket(paid)],
    ['Outstanding', fmtMoneyBucket(outstanding)],
  ];

  const entryCols = [
    { label: 'Date', key: 'date' }, { label: 'Start', key: 'start' }, { label: 'End', key: 'end' },
    ...(cids.size > 1 ? [{ label: 'Contract', key: 'contract' }] : []),
    { label: 'Task', key: 'task' }, { label: 'Activity', key: 'activity', wide: true }, { label: 'Hours', key: 'hours', num: true },
  ];
  const entryRow = e => ({
    date: C.fmtDate(e.work_date), start: timeIn(Date.parse(e.start_at_utc), e.timezone || tz), end: timeIn(Date.parse(e.end_at_utc), e.timezone || tz),
    contract: cname(e.contract_id), task: get('tasks', e.task_id)?.title || '',
    activity: (e.activity_notes || '') + (e.deliverable_notes ? ` — Deliverable: ${e.deliverable_notes}` : '') + (e.is_billable === false ? ' [non-billable]' : ''),
    hours: C.fmtMinutesDec(e.duration_minutes),
  });
  const approvalSection = {
    title: 'Approval records', columns: [{ label: 'Period', key: 'period' }, ...(cids.size > 1 ? [{ label: 'Contract', key: 'contract' }] : []), { label: 'Approved', key: 'hours', num: true }, { label: 'Approved by', key: 'by' }, { label: 'Approved on', key: 'on' }, { label: 'Source', key: 'source' }, { label: 'Evidence', key: 'ev' }],
    rows: apps.map(a => ({ period: `${C.fmtDate(a.period_start)} – ${C.fmtDate(a.period_end)}`, contract: cname(a.contract_id), hours: hrs(C.toCenti(a.approved_hours)) + (a.is_adjustment ? ' (adj.)' : ''), by: a.approved_by, on: C.fmtDate(a.approved_at), source: a.approval_source, ev: S.evidence.filter(f => f.approval_record_id === a.id).map(f => f.original_filename + (f.contains_approval ? ' [contains approval]' : '')).join(', ') || 'none' })),
    empty: 'No approval records in this period — logged time here is pending/unapproved.',
  };
  const evidenceSection = {
    title: 'Evidence register', columns: [{ label: 'Date', key: 'date' }, { label: 'File', key: 'file' }, { label: 'Type', key: 'type' }, { label: 'Provided by', key: 'by' }, { label: 'Description', key: 'desc', wide: true }, { label: 'SHA-256 (first 16)', key: 'hash' }],
    rows: evidence.map(f => ({ date: C.fmtDate(f.related_work_date), file: f.original_filename + (f.is_annotated_copy ? ' (annotated copy)' : ''), type: evidenceTypeLabel(f.evidence_type) + (f.contains_approval ? ' — contains approval communication' : ''), by: f.provided_by === 'client' ? 'Client' : 'Freelancer', desc: f.description || '', hash: (f.sha256 || '').slice(0, 16) })),
    empty: 'No evidence files in this period.',
  };
  const workedDays = [...new Set(entries.map(e => `${e.work_date}|${e.contract_id}`))];
  const missing = workedDays.filter(k => { const [d, c] = k.split('|'); return !S.evidence.some(f => f.contract_id === c && f.related_work_date === d); });
  const missingNote = missing.length ? `Workdays without any attached evidence: ${missing.map(k => C.fmtDate(k.split('|')[0])).join(', ')}.` : '';

  const sections = [];
  const notes = [];
  if (type === 'daily' || type === 'timesheet') {
    const byDay = new Map();
    for (const e of entries) { if (!byDay.has(e.work_date)) byDay.set(e.work_date, []); byDay.get(e.work_date).push(e); }
    const rows = [];
    for (const [d, list] of byDay) {
      rows.push(...list.map(entryRow));
      const dayApproved = apps.filter(a => a.period_start === d && a.period_end === d).reduce((x, a) => x + C.toCenti(a.approved_hours), 0);
      const covered = apps.some(a => C.inRange(d, a.period_start, a.period_end));
      rows.push({ _total: true, date: C.fmtDate(d), activity: 'Daily total', hours: C.fmtMinutesDec(M.loggedMinutes(list)), approved: covered ? (dayApproved ? hrs(dayApproved) : 'in period approval') : 'PENDING' });
    }
    sections.push({ title: type === 'daily' ? 'Work log' : 'Detailed timesheet', columns: [...entryCols, { label: 'Approved', key: 'approved', num: true }], rows, empty: 'No time entries in this period.' });
    if (type === 'daily') {
      const taskIds = [...new Set(entries.map(e => e.task_id).filter(Boolean))];
      sections.push({ title: 'Tasks worked', columns: [{ label: 'Task', key: 't' }, { label: 'Status', key: 's' }, { label: 'Hours', key: 'h', num: true }], rows: taskIds.map(id => ({ t: get('tasks', id)?.title, s: get('tasks', id)?.status, h: C.fmtMinutesDec(C.sumMinutes(entries.filter(e => e.task_id === id))) })), empty: 'No tasks referenced.' });
    }
    sections.push(approvalSection, evidenceSection);
    if (missingNote) notes.push(missingNote);
  } else if (type === 'reconciliation') {
    const rows = [];
    for (const c of contracts) {
      const start = from || c.start_date, end = to || [c.end_date, new Date().toISOString().slice(0, 10)].filter(Boolean).sort()[0];
      if (!start || !end || end < start) continue;
      const periods = c.reporting_anchor_date ? C.periodsBetween(c.reporting_anchor_date, start, end) : (() => { const o = []; for (let m = C.monthRange(start); m.from <= end; m = C.monthRange(C.addDays(m.to, 1))) o.push(m); return o; })();
      for (const p of periods) {
        const st = M.periodStatus(c.id, p.from, p.to);
        const lg = M.loggedMinutes(M.entriesIn(new Set([c.id]), p.from, p.to));
        if (!lg && !st.submitted && !st.approved) continue;
        rows.push({ contract: cname(c.id), period: `${p.number ? '#' + p.number + ' ' : ''}${C.fmtDate(p.from)} – ${C.fmtDate(p.to)}`, logged: C.fmtMinutesDec(lg), submitted: hrs(st.submitted), approved: hrs(st.approved), diff: hrs(st.diff) + (st.approvedExceedsSubmitted ? ' ⚠' : ''), notApproved: hrs(C.minutesToCenti(lg) - st.approved), status: st.status, dates: st.apps.map(a => C.fmtDate(a.approved_at)).join(', ') });
      }
    }
    sections.push({ title: 'Logged vs submitted vs approved', columns: [...(cids.size > 1 ? [{ label: 'Contract', key: 'contract' }] : []), { label: 'Period', key: 'period' }, { label: 'Logged', key: 'logged', num: true }, { label: 'Submitted', key: 'submitted', num: true }, { label: 'Approved', key: 'approved', num: true }, { label: 'Submitted − approved', key: 'diff', num: true }, { label: 'Logged − approved', key: 'notApproved', num: true }, { label: 'Status', key: 'status' }, { label: 'Approval dates', key: 'dates' }], rows, empty: 'No activity in this period.' });
    sections.push({ title: 'Timesheet submissions', columns: [{ label: 'Period', key: 'p' }, { label: 'Hours', key: 'h', num: true }, { label: 'Submitted', key: 'd' }, { label: 'Method / recipient', key: 'm' }, { label: 'Status', key: 's' }], rows: subs.map(s => ({ p: `${C.fmtDate(s.period_start)} – ${C.fmtDate(s.period_end)}`, h: hrs(C.toCenti(s.submitted_hours)), d: C.fmtDate(s.submitted_at), m: `${s.submission_method || ''} ${s.recipient ? '→ ' + s.recipient : ''}`, s: s.status })), empty: 'No submissions.' });
    sections.push(approvalSection, evidenceSection);
    if (missingNote) notes.push(missingNote);
  } else if (type === 'earnings' || type === 'invoice_support') {
    const rem = M.remainingByApproval();
    sections.push({
      title: type === 'earnings' ? 'Earnings from approved hours' : 'Approved hours included',
      columns: [{ label: 'Approved period', key: 'p' }, ...(cids.size > 1 ? [{ label: 'Contract', key: 'c' }] : []), { label: 'Approved', key: 'h', num: true }, { label: 'Rate', key: 'r', num: true }, { label: 'Earned', key: 'e', num: true }, { label: 'Not yet invoiced', key: 'n', num: true }],
      rows: earn.rows.map(r => ({ p: `${C.fmtDate(r.approval.period_start)} – ${C.fmtDate(r.approval.period_end)}`, c: cname(r.approval.contract_id), h: hrs(r.centi), r: r.rateMissing ? 'NO RATE' : C.fmtMoney(r.rateMinor, r.currency) + (r.rateChange ? ' *' : ''), e: C.fmtMoney(r.minor, r.currency), n: hrs(Math.max(0, rem.get(r.approval.id) || 0)) })),
      totals: Object.entries(earn.byCur).map(([cur, v]) => ({ p: `Total ${cur}`, h: hrs(earn.rows.filter(r => r.currency === cur).reduce((a, r) => a + r.centi, 0)), e: C.fmtMoney(v, cur) })),
      empty: 'No approved hours in this period.',
    });
    if (earn.rateChange) notes.push('* A different rate takes effect within this approved period; the rate effective on the first day of the period was applied.');
    if (type === 'invoice_support') {
      sections.push({ title: 'Calculation', columns: [{ label: 'Currency', key: 'c' }, { label: 'Calculation', key: 'x', wide: true }, { label: 'Total', key: 't', num: true }], rows: Object.entries(earn.byCur).map(([cur, v]) => ({ c: cur, x: earn.rows.filter(r => r.currency === cur).map(r => `${C.hundredthsToString(r.centi)} h × ${C.hundredthsToString(r.rateMinor)}`).join(' + '), t: C.fmtMoney(v, cur) })) });
      const taskIds = [...new Set(entries.map(e => e.task_id).filter(Boolean))];
      sections.push({ title: 'Task summary', columns: [{ label: 'Task', key: 't' }, { label: 'Project', key: 'p' }, { label: 'Status', key: 's' }, { label: 'Logged', key: 'h', num: true }], rows: taskIds.map(id => { const t = get('tasks', id); return { t: t?.title, p: t?.project_name || '', s: t?.status, h: C.fmtMinutesDec(C.sumMinutes(entries.filter(e => e.task_id === id))) }; }), empty: 'No tasks referenced by time entries.' });
      sections.push({ title: 'Supporting time entries', columns: entryCols, rows: entries.map(entryRow), empty: 'No time entries.' });
      sections.push(approvalSection, evidenceSection);
    } else {
      sections.push({ title: 'Invoices & payments', columns: [{ label: 'Invoice', key: 'n' }, { label: 'Date', key: 'd' }, { label: 'Total', key: 't', num: true }, { label: 'Paid', key: 'p', num: true }, { label: 'Outstanding', key: 'o', num: true }], rows: invs.map(i => ({ n: i.invoice_number, d: C.fmtDate(i.invoice_date), t: C.fmtMoney(C.invoiceTotal(i), i.currency), p: C.fmtMoney(C.invoicePaid(i, S.payments), i.currency), o: C.fmtMoney(C.invoiceOutstanding(i, S.payments), i.currency) })), empty: 'No invoices in this period.' });
    }
  } else if (type === 'evidence') {
    sections.push(evidenceSection, approvalSection);
    if (missingNote) notes.push(missingNote);
  } else if (type === 'contract' || type === 'multi') {
    const groups = new Map();
    for (const c of contracts) { if (!groups.has(c.employer_id)) groups.set(c.employer_id, []); groups.get(c.employer_id).push(c); }
    const rows = [];
    for (const [eid, list] of groups) for (const c of list) {
      const one = new Set([c.id]);
      const ce = M.earnings(S.approvals.filter(a => a.contract_id === c.id && C.inRange(a.period_start, from, to)));
      const fin = M.finance(one, from, to);
      rows.push({ employer: employerName(get('employers', eid)), contract: c.title, dates: `${C.fmtDate(c.start_date)} – ${c.end_date ? C.fmtDate(c.end_date) : 'open'}`, currency: c.currency, logged: C.fmtMinutesDec(M.loggedMinutes(M.entriesIn(one, from, to))), approved: hrs(ce.centi), earned: fmtMoneyBucket(ce.byCur), invoiced: fmtMoneyBucket(fin.invoiced), paid: fmtMoneyBucket(fin.paid), outstanding: fmtMoneyBucket(fin.outstanding) });
    }
    sections.push({ title: type === 'multi' ? 'By employer and contract' : 'Contract totals', columns: [{ label: 'Employer', key: 'employer' }, { label: 'Contract', key: 'contract' }, { label: 'Term', key: 'dates' }, { label: 'Cur.', key: 'currency' }, { label: 'Logged', key: 'logged', num: true }, { label: 'Approved', key: 'approved', num: true }, { label: 'Earned', key: 'earned', num: true }, { label: 'Invoiced', key: 'invoiced', num: true }, { label: 'Paid', key: 'paid', num: true }, { label: 'Outstanding', key: 'outstanding', num: true }], rows });
    sections.push({ title: 'Totals per currency', columns: [{ label: 'Currency', key: 'c' }, { label: 'Earned', key: 'e', num: true }, { label: `${homeCurrency()} estimate`, key: 'p' }], rows: Object.entries(earn.byCur).map(([cur, v]) => ({ c: cur, e: C.fmtMoney(v, cur), p: phpLine({ [cur]: v }) })), empty: 'No approved earnings.' });
    if (type === 'contract') for (const c of contracts) {
      sections.push({ title: `Terms — ${cname(c.id)}`, columns: [{ label: 'Field', key: 'k' }, { label: 'Value', key: 'v', wide: true }], rows: [
        ['Arrangement', c.work_arrangement], ['Approval contact', c.approval_contact_name], ['Invoice requirements', c.invoice_requirements], ['Payment terms', c.payment_terms_text], ['End behaviour', c.end_behavior_text],
        ['Rates', contractRates(c.id).map(r => `${r.hourly_rate} ${r.currency}/h from ${C.fmtDate(r.effective_from)}${r.effective_to ? ' to ' + C.fmtDate(r.effective_to) : ''}`).join('; ')],
      ].filter(r => r[1]).map(([k, v]) => ({ k, v })) });
    }
  }
  notes.push(`${homeCurrency()} figures are estimates using the displayed exchange rate and exclude fees, spreads and taxes. Earnings are calculated only from hours manually recorded as approved.`);
  notes.push('This report is organised supporting documentation compiled by the freelancer; it is not legally conclusive evidence. Attachments are listed for reference and are not claimed to prove approval unless their content shows it.');

  return { type, title: REPORT_TYPES.find(t => t[0] === type)[1], from, to, contracts, summary, sections, notes, generated_at_utc: new Date().toISOString() };
}

export function defaultHeader(scope) {
  const p = profile() || {};
  const contracts = scopeContracts(scope);
  const emp = scope.kind === 'all' ? null : get('employers', contracts[0]?.employer_id || scope.id);
  const c = scope.kind === 'contract' ? contracts[0] : null;
  return {
    client_name: emp ? emp.legal_name : 'All employers', client_address: emp?.address || '', client_contact: c?.approval_contact_name || emp?.primary_contact_name || '',
    client_email: c?.approval_contact_email || emp?.primary_contact_email || '', reference: '', client_logo: emp?.logo || '', accent: emp?.accent || '#1f3a5f',
    freelancer_name: p.full_name || '', freelancer_address: p.address || '', freelancer_email: p.email || '', freelancer_phone: p.phone || '', freelancer_tax_id: p.tax_id || '', freelancer_logo: p.logo || '',
  };
}

const REPORT_CSS = `
  .rpt{font:10.5pt/1.4 -apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#1d2433;background:#fff;max-width:190mm;margin:0 auto}
  .rpt h1{font-size:18pt;margin:0;color:#14213d;letter-spacing:-.01em}.rpt h2{font-size:12pt;margin:18px 0 6px;color:#14213d;border-bottom:2px solid var(--acc);padding-bottom:3px}
  .rpt .top{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #d8dde6;padding-bottom:10px;margin-bottom:12px}
  .rpt .sub{color:#4a5468;margin-top:2px}.rpt .parties{display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:9.5pt;margin-bottom:12px}
  .rpt .lbl{font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#6b7486;margin-bottom:2px}.rpt .pre{white-space:pre-wrap}
  .rpt img.logo{max-height:42px;max-width:150px}.rpt table{width:100%;border-collapse:collapse;font-size:9pt;margin-bottom:6px}
  .rpt thead{display:table-header-group}.rpt tr{page-break-inside:avoid;break-inside:avoid}
  .rpt th{text-align:left;background:#f1f3f7;color:#3a4356;font-weight:600;padding:5px 6px;border-bottom:1px solid #c9d0db}
  .rpt td{padding:4px 6px;border-bottom:1px solid #e6e9ef;vertical-align:top}.rpt .num{text-align:right;white-space:nowrap}
  .rpt tr.total td{font-weight:700;background:#fafbfc;border-bottom:1px solid #c9d0db}.rpt tr.pend td.ap{color:#a15c00;font-weight:700}
  .rpt .summary td:first-child{color:#4a5468;width:42%}.rpt .summary td:last-child{font-weight:600}
  .rpt .notes{font-size:8.5pt;color:#4a5468;margin-top:14px;border-top:1px solid #d8dde6;padding-top:8px}
  .rpt .foot{font-size:8pt;color:#6b7486;margin-top:10px;display:flex;justify-content:space-between}
  .rpt .empty{color:#6b7486;font-style:italic;font-size:9pt;margin:4px 0 8px}
  @media print{.rpt h2{break-after:avoid}}`;

export function reportHtml(r, hd) {
  const period = r.from || r.to ? `${r.from ? C.fmtDate(r.from) : 'Start'} – ${r.to ? C.fmtDate(r.to) : 'Present'}` : 'All dates';
  const tableHtml = s => {
    if (!s.rows.length) return `<p class="empty">${esc(s.empty || 'No records.')}</p>`;
    const head = `<thead><tr>${s.columns.map(c => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>`;
    const body = s.rows.map(row => `<tr class="${row._total ? 'total' : ''} ${row.approved === 'PENDING' ? 'pend' : ''}">${s.columns.map(c => `<td class="${c.num ? 'num' : ''} ${c.key === 'approved' ? 'ap' : ''}">${esc(row[c.key] ?? '')}</td>`).join('')}</tr>`).join('');
    const tot = (s.totals || []).map(row => `<tr class="total">${s.columns.map(c => `<td class="${c.num ? 'num' : ''}">${esc(row[c.key] ?? '')}</td>`).join('')}</tr>`).join('');
    return `<table>${head}<tbody>${body}${tot}</tbody></table>`;
  };
  const block = (label, lines, logo) => `<div><div class="lbl">${label}</div>${logo ? `<img class="logo" src="${esc(logo)}" alt=""><br>` : ''}<div class="pre">${esc(lines.filter(Boolean).join('\n'))}</div></div>`;
  return `<style>${REPORT_CSS}</style><div class="rpt" style="--acc:${esc(hd.accent || '#1f3a5f')}">
    <div class="top"><div><h1>${esc(r.title)}</h1><div class="sub">${esc(period)}${r.contracts.length === 1 ? ' · ' + esc(cname(r.contracts[0].id)) : r.contracts.length > 1 ? ` · ${r.contracts.length} contracts` : ''}</div></div>
      <div style="text-align:right">${hd.freelancer_logo ? `<img class="logo" src="${esc(hd.freelancer_logo)}" alt="">` : ''}</div></div>
    <div class="parties">
      ${block('Client', [hd.client_name, hd.client_contact && 'Attn: ' + hd.client_contact, hd.client_address, hd.client_email, hd.reference && 'Ref: ' + hd.reference], hd.client_logo)}
      ${block('Freelancer', [hd.freelancer_name, hd.freelancer_address, hd.freelancer_email, hd.freelancer_phone, hd.freelancer_tax_id && 'Tax ID: ' + hd.freelancer_tax_id])}
    </div>
    <h2>Summary</h2><table class="summary"><tbody>${r.summary.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
    ${r.sections.map(s => `<h2>${esc(s.title)}</h2>${tableHtml(s)}`).join('')}
    <div class="notes">${r.notes.map(n => `<p>${esc(n)}</p>`).join('')}</div>
    <div class="foot"><span>Generated ${esc(fmtDateTime(r.generated_at_utc, homeTz()))} (${esc(homeTz())})</span><span>TimeLedger</span></div>
  </div>`;
}

const csvCell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function reportCsv(r) {
  const lines = [[r.title], ['Period', r.from || '', r.to || ''], ['Generated (UTC)', r.generated_at_utc], [], ['Summary'], ...r.summary, []];
  for (const s of r.sections) {
    lines.push([s.title], s.columns.map(c => c.label));
    for (const row of [...s.rows, ...(s.totals || [])]) lines.push(s.columns.map(c => row[c.key] ?? ''));
    lines.push([]);
  }
  return '﻿' + lines.map(l => l.map(csvCell).join(',')).join('\r\n');
}

export function printHtml(html, title) {
  const root = document.getElementById('print-root');
  root.innerHTML = html;
  const prev = document.title;
  if (title) document.title = title;
  const done = () => { root.innerHTML = ''; document.title = prev; window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  requestAnimationFrame(() => window.print());
}

export function printInvoice(inv) {
  const c = get('contracts', inv.contract_id), e = get('employers', c?.employer_id);
  const p = inv.from_snapshot_json || profile() || {};
  const bt = inv.bill_to_snapshot_json || {};
  const allocs = S.allocations.filter(a => a.invoice_id === inv.id).map(a => ({ a, ap: get('approvals', a.approval_record_id) }));
  const rows = allocs.map(({ a, ap }) => ({ d: ap ? `${C.fmtDate(ap.period_start)} – ${C.fmtDate(ap.period_end)}` : '', desc: 'Approved hours', h: a.hours_allocated + ' h', r: a.hours_allocated > 0 ? C.fmtMoney(Math.round(a.amount_minor / C.toCenti(a.hours_allocated) * 100), inv.currency) : '', amt: C.fmtMoney(a.amount_minor, inv.currency) }));
  if (inv.unapproved_centi) rows.push({ d: '', desc: `Additional hours (not recorded as approved): ${inv.unapproved_reason}`, h: C.fmtCenti(inv.unapproved_centi), r: '', amt: '' });
  const section = { title: 'Line items', columns: [{ label: 'Period', key: 'd' }, { label: 'Description', key: 'desc' }, { label: 'Hours', key: 'h', num: true }, { label: 'Rate', key: 'r', num: true }, { label: `Amount (${inv.currency})`, key: 'amt', num: true }], rows, totals: [
    { desc: 'Subtotal', amt: C.fmtMoney(inv.subtotal_minor, inv.currency) },
    ...(inv.adjustments_minor ? [{ desc: `Adjustment ${inv.adjustment_reason || ''}`, amt: C.fmtMoney(inv.adjustments_minor, inv.currency) }] : []),
    { desc: 'Total due', amt: C.fmtMoney(C.invoiceTotal(inv), inv.currency) },
  ] };
  const report = {
    title: `Invoice ${inv.invoice_number}`, from: inv.period_start, to: inv.period_end, contracts: c ? [c] : [], generated_at_utc: new Date().toISOString(),
    summary: [['Invoice date', C.fmtDate(inv.invoice_date)], ['Payment terms', c?.payment_terms_text || ''], ['Due (estimate)', inv.due_date ? C.fmtDate(inv.due_date) : ''], ['Currency', inv.currency], ['Total due', C.fmtMoney(C.invoiceTotal(inv), inv.currency)]].filter(r => r[1]),
    sections: [section], notes: [c?.invoice_requirements ? `Supporting detailed timesheets available on request (${c.invoice_requirements}).` : '', inv.notes || ''].filter(Boolean),
  };
  const hd = { client_name: bt.name, client_contact: bt.contact, client_address: bt.address, client_email: bt.email, reference: bt.reference, client_logo: e?.logo, accent: e?.accent,
    freelancer_name: p.full_name, freelancer_address: p.address, freelancer_email: p.email, freelancer_phone: p.phone, freelancer_tax_id: p.tax_id, freelancer_logo: p.logo };
  printHtml(reportHtml(report, hd), `Invoice ${inv.invoice_number}`);
}
