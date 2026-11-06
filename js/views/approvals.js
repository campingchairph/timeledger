import { S, get, save, remove, today, scopeContractIds, contractLabel, defaultContractId, homeTz } from '../store.js';
import { h, mount, table, badge, openDialog, formModal, askReason, toast, contractOptions, fieldHtml } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import * as A from '../actions.js';
import { fmtDateTime } from '../tz.js';

let tab = 'periods', cid = null;
const KIND = { Approved: 'ok', 'Partially approved': 'warn', Rejected: 'bad', 'Needs clarification': 'warn', 'Submitted — awaiting approval': 'accent' };

export function periodRows(c, t) {
  const start = c.start_date || t;
  let end = c.end_date && c.end_date < t ? c.end_date : t;
  if (end < start) end = start;
  if (c.reporting_anchor_date) return C.periodsBetween(c.reporting_anchor_date, start, end).reverse();
  const out = [];
  for (let m = C.monthRange(start); m.from <= end; m = C.monthRange(C.addDays(m.to, 1))) out.push({ number: null, ...m });
  return out.reverse();
}

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  if (!cid || !cids.has(cid)) cid = [...cids][0] && (cids.has(defaultContractId()) ? defaultContractId() : [...cids][0]);
  const c = get('contracts', cid);

  let body;
  if (tab === 'periods') {
    if (!c) body = h`<div class="empty">Add a contract first.</div>`;
    else {
      const rows = periodRows(c, t).map(p => {
        const logged = M.loggedMinutes(M.entriesIn(new Set([c.id]), p.from, p.to));
        const st = M.periodStatus(c.id, p.from, p.to);
        const earn = M.earnings(st.apps);
        return { p, logged, st, earn };
      });
      body = h`
        <div class="toolbar">${fieldHtml({ name: 'cid', label: 'Contract', type: 'select', options: contractOptions({ includeArchived: true }).map(g => ({ ...g, options: g.options.filter(([id]) => cids.has(id)) })).filter(g => g.options.length) }, cid)}
          <span class="grow"></span><button class="btn sm" data-anchor>${c.reporting_anchor_date ? `14-day anchor: ${C.fmtDate(c.reporting_anchor_date)}` : 'Set 14-day anchor'}</button></div>
        ${c.reporting_anchor_date ? h`<p class="note">Consecutive 14-calendar-day periods from your chosen anchor. This is your reporting choice — not a client-mandated cycle.</p>` : h`<p class="note">Showing calendar months. Set an anchor date to use 14-day periods for this contract.</p>`}
        ${table([
          { label: 'Period', render: r => h`${r.p.number ? h`<b>#${r.p.number}</b> ` : ''}${C.fmtDate(r.p.from)} – ${C.fmtDate(r.p.to)}` },
          { label: 'Logged', cls: 'num', render: r => C.fmtMinutesDec(r.logged) },
          { label: 'Submitted', cls: 'num', render: r => C.fmtCenti(r.st.submitted) },
          { label: 'Approved', cls: 'num', render: r => C.fmtCenti(r.st.approved) },
          { label: 'Pending diff', cls: 'num', render: r => r.st.approvedExceedsSubmitted ? badge(`${C.fmtCenti(r.st.diff)} (approved > submitted)`, 'warn') : C.fmtCenti(r.st.diff) },
          { label: 'Earned', cls: 'num', render: r => Object.entries(r.earn.byCur).map(([cur, v]) => C.fmtMoney(v, cur)).join(', ') || '—' },
          { label: 'Status', render: r => badge(r.st.status, KIND[r.st.status]) },
          { label: '', render: r => h`<div class="btn-row"><button class="btn sm" data-sub="${r.p.from}|${r.p.to}|${r.logged}">Submit</button><button class="btn sm" data-app="${r.p.from}|${r.p.to}">Approve</button><a class="btn sm" href="#/reports?contract=${c.id}&from=${r.p.from}&to=${r.p.to}">Report</a></div>` },
        ], rows, { empty: 'No periods yet — the contract has not started.' })}`;
    }
  } else if (tab === 'submissions') {
    const subs = S.submissions.filter(s => cids.has(s.contract_id)).sort((a, b) => b.period_start.localeCompare(a.period_start));
    body = h`<div class="table-wrap stack">${table([
      { label: 'Period', render: s => `${C.fmtDate(s.period_start)} – ${C.fmtDate(s.period_end)}` },
      { label: 'Contract', render: s => contractLabel(get('contracts', s.contract_id)) },
      { label: 'Hours', cls: 'num', render: s => C.fmtCenti(C.toCenti(s.submitted_hours)) },
      { label: 'Submitted', render: s => `${C.fmtDate(s.submitted_at)} · ${s.submission_method || ''}${s.recipient ? ' → ' + s.recipient : ''}` },
      { label: 'Status', render: s => badge(s.status, KIND[s.status] || (s.status === 'Draft' ? '' : 'accent')) },
      { label: '', render: s => h`<button class="btn sm" data-edit-sub="${s.id}">Edit</button>` },
    ], subs, { empty: 'No timesheet submissions recorded.' })}</div>`;
  } else {
    const apps = S.approvals.filter(a => cids.has(a.contract_id)).sort((a, b) => b.period_start.localeCompare(a.period_start));
    const earn = M.earnings(apps);
    body = h`<div class="table-wrap stack">${table([
      { label: 'Period', render: a => `${C.fmtDate(a.period_start)}${a.period_end !== a.period_start ? ' – ' + C.fmtDate(a.period_end) : ''}` },
      { label: 'Contract', render: a => contractLabel(get('contracts', a.contract_id)) },
      { label: 'Approved', cls: 'num', render: a => h`<b>${C.fmtCenti(C.toCenti(a.approved_hours))}</b>${a.is_adjustment ? h` ${badge('Adjustment')}` : ''}` },
      { label: 'By / source', render: a => `${a.approved_by || '—'} · ${a.approval_source || ''} · ${C.fmtDate(a.approved_at)}` },
      { label: 'Earned', cls: 'num', render: a => { const r = earn.rows.find(x => x.approval === a); return r.rateMissing ? badge('No rate', 'bad') : h`${C.fmtMoney(r.minor, r.currency)}${r.rateChange ? h` ${badge('Rate changed in period', 'warn')}` : ''}`; } },
      { label: 'Evidence', render: a => { const n = S.evidence.filter(f => f.approval_record_id === a.id); return n.length ? `${n.length} file${n.length > 1 ? 's' : ''}${n.some(f => f.contains_approval) ? ' ✓' : ''}` : h`<span class="muted">none</span>`; } },
      { label: '', render: a => h`<div class="btn-row"><button class="btn sm" data-edit-app="${a.id}">Correct</button><button class="btn sm ghost" data-hist="${a.id}">History</button></div>` },
    ], apps, { empty: 'No approved hours recorded yet. Enter them when the client approves.' })}</div>`;
  }

  mount(el, h`<section class="panel">
    <div class="panel-head"><h2>Timesheets & approvals</h2><button class="btn" data-new-sub>Record submission</button><button class="btn primary" data-new-app>Record approved hours</button><button class="btn" data-plan>Pre-agreed hours</button></div>
    <p class="note">Logged → submitted → approved are kept separate. Only hours you enter here as approved count towards earnings.</p>
    <div class="chips">${[['periods', 'Periods & reconciliation'], ['submissions', 'Submissions'], ['approvals', 'Approvals']].map(([k, l]) => h`<button class="chip ${tab === k ? 'active' : ''}" data-tab="${k}">${l}</button>`)}</div>
    ${body}
  </section>`);

  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if (d.tab) { tab = d.tab; render(el); }
    else if ('newSub' in d) A.submissionForm(null, { contract_id: cid });
    else if ('newApp' in d) A.approvalForm(null, { contract_id: cid });
    else if ('plan' in d) A.planForm(null, { contract_id: cid });
    else if (d.sub) { const [f, to, mins] = d.sub.split('|'); A.submissionForm(null, { contract_id: cid, period_start: f, period_end: to, submitted_hours: C.hundredthsToString(C.minutesToCenti(+mins)) }); }
    else if (d.app) { const [f, to] = d.app.split('|'); A.approvalForm(null, { contract_id: cid, period_start: f, period_end: to }); }
    else if (d.editSub) A.submissionForm(get('submissions', d.editSub));
    else if (d.editApp) A.approvalForm(get('approvals', d.editApp));
    else if (d.hist) history(get('approvals', d.hist));
    else if ('anchor' in d) {
      const c2 = get('contracts', cid);
      await formModal({
        title: '14-day reporting anchor', values: { reporting_anchor_date: c2.reporting_anchor_date || c2.start_date },
        fields: [{ name: 'reporting_anchor_date', label: 'Anchor date (first day of period #1)', type: 'date', hint: 'Leave empty to use calendar months.' }],
        onSubmit: v => save('contracts', { id: cid, reporting_anchor_date: v.reporting_anchor_date || null }, { reason: 'Reporting anchor changed' }),
      });
    }
  };
  el.onchange = e => { if (e.target.name === 'cid') { cid = e.target.value; render(el); } };
}

function history(a) {
  const tz = homeTz();
  const hist = S.approvalHistory.filter(x => x.approval_record_id === a.id).sort((x, y) => y.changed_at_utc.localeCompare(x.changed_at_utc));
  const { el } = openDialog({
    title: 'Approval history',
    body: h`<dl class="kv"><dt>Current</dt><dd><b>${a.approved_hours} h</b> · ${C.fmtDate(a.period_start)} – ${C.fmtDate(a.period_end)}</dd><dt>Recorded</dt><dd>${fmtDateTime(a.created_at, tz)}</dd></dl>
      ${table([
        { label: 'Changed', render: x => fmtDateTime(x.changed_at_utc, tz) },
        { label: 'From', cls: 'num', render: x => x.previous_approved_hours + ' h' },
        { label: 'To', cls: 'num', render: x => x.new_approved_hours + ' h' },
        { label: 'Reason', render: x => x.change_reason },
      ], hist, { empty: 'No corrections — this is the original value.' })}`,
    actions: h`<button class="btn danger ghost" data-del>Delete approval</button>`,
  });
  el.querySelector('[data-del]').onclick = async () => {
    const used = S.allocations.some(x => x.approval_record_id === a.id);
    if (used) return toast('This approval is allocated to an invoice. Credit that invoice first.', 'warn');
    const reason = await askReason('Reason for deleting this approval', 'Reason (required)');
    if (!reason) return;
    el.close();
    await save('approvalHistory', { approval_record_id: a.id, previous_approved_hours: a.approved_hours, new_approved_hours: '0.00', change_reason: 'Deleted: ' + reason, changed_at_utc: new Date().toISOString() }, { audit: false });
    await remove('approvals', a.id, { reason });
    toast('Approval deleted (kept in audit log)');
  };
}
