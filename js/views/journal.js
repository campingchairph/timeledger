import { S, get, today, profile, homeTz, scopeContractIds, contractLabel, settings, updateSettings } from '../store.js';
import { h, mount, empty, badge } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import * as A from '../actions.js';
import { timeIn } from '../tz.js';

let sel = null, month = null;

function calendar(cids, t) {
  const first = month + '-01';
  const start = C.addDays(first, -((C.weekday(first) + 6) % 7));
  const days = [];
  for (let i = 0; i < 42; i++) days.push(C.addDays(start, i));
  const logged = new Map(), approved = new Map(), evidence = new Set(), due = new Set(), pending = new Set(), money = new Set();
  for (const e of S.entries) if (cids.has(e.contract_id) && e.is_billable !== false) logged.set(e.work_date, (logged.get(e.work_date) || 0) + e.duration_minutes);
  for (const a of S.approvals) if (cids.has(a.contract_id) && a.period_start === a.period_end) approved.set(a.period_start, (approved.get(a.period_start) || 0) + C.toCenti(a.approved_hours));
  const approvedRanges = S.approvals.filter(a => cids.has(a.contract_id));
  for (const f of S.evidence) if (cids.has(f.contract_id) && f.related_work_date) evidence.add(f.related_work_date);
  for (const x of S.tasks) if (cids.has(x.contract_id) && x.due_at && x.status !== 'Completed') due.add(x.due_at.slice(0, 10));
  for (const i of S.invoices) if (cids.has(i.contract_id)) { money.add(i.invoice_date); if (i.due_date) money.add(i.due_date); }
  for (const p of S.payments) money.add(p.received_at_utc?.slice(0, 10));
  for (const d of logged.keys()) if (!approvedRanges.some(a => C.inRange(d, a.period_start, a.period_end))) pending.add(d);
  return h`
    <div class="cal-head"><button class="btn sm" data-m="-1" aria-label="Previous month">‹</button><h3>${new Date(C.dateToMs(first)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</h3><button class="btn sm" data-m="1" aria-label="Next month">›</button><button class="btn sm" data-today>Today</button></div>
    <div class="cal">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => h`<div class="dow">${d}</div>`)}
      ${days.map(d => h`<button data-d="${d}" class="${d.slice(0, 7) !== month ? 'out' : ''} ${d === t ? 'today' : ''} ${d === sel ? 'sel' : ''}" aria-label="${C.fmtDate(d)}">
        <span class="d">${+d.slice(8)}</span>
        ${logged.has(d) ? h`<span class="m">⏱ ${C.hundredthsToString(C.minutesToCenti(logged.get(d)))}</span>` : ''}
        ${approved.has(d) ? h`<span class="m ap">✓ ${C.hundredthsToString(approved.get(d))}</span>` : pending.has(d) ? h`<span class="m pd">… pending</span>` : ''}
        ${evidence.has(d) ? h`<span class="m">📎 files</span>` : ''}
        ${due.has(d) ? h`<span class="m dl">⚑ due</span>` : ''}
        ${money.has(d) ? h`<span class="m">◆ inv/pay</span>` : ''}
      </button>`)}
    </div>
    <p class="small muted mt">⏱ logged · ✓ approved (single-day approvals) · … no approval covering the day · 📎 evidence · ⚑ task due · ◆ invoice/payment date</p>`;
}

function closeout(cid, d) {
  const key = `${d}|${cid}`;
  const manual = settings().closeouts?.[key] || {};
  const entries = S.entries.filter(e => e.contract_id === cid && e.work_date === d);
  const comp = M.completeness(cid, d);
  const ps = M.periodStatus(cid, d, d);
  const item = (ok, label, extra = '') => h`<li><span class="dot ${ok ? 'ok' : 'no'}"></span>${label}${extra}</li>`;
  return h`<div class="panel">
    <div class="panel-head"><h2>Close-out · ${contractLabel(get('contracts', cid))}</h2>${badge(`Completeness ${comp.score}/${comp.total}`, comp.score === comp.total ? 'ok' : 'warn')}</div>
    <ul class="closeout">
      <li><label class="check"><input type="checkbox" data-closeout="${key}" ${manual.allLogged ? h`checked` : ''}> All work periods logged</label></li>
      ${item(entries.every(e => (e.activity_notes || '').trim().length >= 10), 'Descriptions are clear', entries.some(e => (e.activity_notes || '').trim().length < 10) ? ' — some notes are very short' : '')}
      ${item(comp.items[2][1] || comp.items[4][1], 'Evidence attached')}
      ${item(ps.subs.length > 0, 'Timesheet submitted', ps.subs.length ? ` (${ps.subs[0].status})` : '')}
      ${item(ps.apps.length > 0, 'Approval received', ps.apps.length ? '' : ps.subs.length ? ' — pending' : '')}
      ${item(ps.apps.length > 0, 'Approved hours entered', ps.apps.length ? ` (${C.fmtCenti(ps.approved)})` : '')}
    </ul>
    <div class="small muted mt">${comp.items.map(([l, ok]) => `${ok ? '✓' : '○'} ${l}`).join(' · ')}</div>
    <div class="btn-row mt">
      <button class="btn sm" data-ev="${cid}">Add evidence</button>
      <button class="btn sm" data-sub="${cid}">Record submission</button>
      <button class="btn sm" data-app="${cid}">Record approval</button>
    </div>
  </div>`;
}

export function render(el, params) {
  const t = today();
  if (params.get('date')) sel = params.get('date');
  sel ||= t; month ||= sel.slice(0, 7);
  const cids = scopeContractIds();
  const tz = homeTz();
  const dayAll = S.entries.filter(e => e.work_date === sel);
  const entries = dayAll.filter(e => cids.has(e.contract_id)).sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc));
  const limit = profile()?.daily_availability_limit_minutes || 360;
  const totalAll = M.loggedMinutes(dayAll);
  const av = C.availability(limit, totalAll);
  const contractsWorked = [...new Set(entries.map(e => e.contract_id))];
  const plans = S.plans.filter(p => p.date === sel && cids.has(p.contract_id));

  mount(el, h`<div class="grid two">
    <section class="panel">${calendar(cids, t)}</section>
    <div>
      <section class="panel">
        <div class="panel-head"><h2>${new Date(C.dateToMs(sel)).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' })}, ${C.fmtDate(sel)}</h2>
          <button class="btn primary sm" data-add>Log time</button><button class="btn sm" data-plan>Pre-agreed hours</button></div>
        <div class="small">Logged (all employers): <b>${C.fmtMinutesDec(totalAll)}</b> (${C.fmtHM(totalAll)}) · Personal limit ${C.fmtMinutesDec(limit)} · ${av.over ? h`<span class="badge bad">Over by ${C.fmtMinutesDec(av.overBy)}</span>` : h`Remaining ${C.fmtMinutesDec(av.remaining)}`}</div>
        ${plans.map(p => h`<div class="note mt">Pre-agreed: <b>${C.fmtCenti(C.toCenti(p.planned_hours))}</b> with ${p.approved_by || '—'} · ${contractLabel(get('contracts', p.contract_id))} <button class="btn sm ghost" data-edit-plan="${p.id}">Edit</button></div>`)}
        <div class="list mt">
          ${entries.length ? entries.map(e => {
            const ov = A.dayWarnings(e).filter(w => w.startsWith('Overlaps'));
            const evN = S.evidence.filter(f => f.time_entry_id === e.id).length;
            return h`<div class="item">
              <div class="item-main">
                <div class="item-title">${timeIn(Date.parse(e.start_at_utc), e.timezone || tz)}–${timeIn(Date.parse(e.end_at_utc), e.timezone || tz)} · ${e.activity_notes}</div>
                <div class="item-meta"><span>${contractLabel(get('contracts', e.contract_id))}</span>
                  ${e.task_id ? h`<span>Task: ${get('tasks', e.task_id)?.title}</span>` : ''}
                  ${e.category ? h`<span>${e.category}</span>` : ''}
                  ${e.source === 'timer' ? badge('Timer') : ''}${e.is_billable === false ? badge('Non-billable') : ''}
                  ${ov.length ? badge('Overlap', 'warn') : ''}${evN ? h`<span>📎 ${evN}</span>` : ''}</div>
                ${e.deliverable_notes ? h`<div class="small mt">Deliverable: ${e.deliverable_notes}</div>` : ''}
              </div>
              <div class="item-side"><div class="num"><b>${C.fmtMinutesDec(e.duration_minutes)}</b></div><div class="small muted">${C.fmtHM(e.duration_minutes)}</div>
                <div class="item-actions"><button class="icon-btn" data-attach="${e.id}" title="Attach file">📎</button><button class="icon-btn" data-edit="${e.id}" title="Edit">✎</button><button class="icon-btn" data-del="${e.id}" title="Delete">🗑</button></div></div>
            </div>`;
          }) : empty('No entries for this day.')}
        </div>
      </section>
      ${contractsWorked.map(cid => closeout(cid, sel))}
    </div>
  </div>`);

  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.d) { sel = b.dataset.d; if (sel.slice(0, 7) !== month) month = sel.slice(0, 7); history.replaceState(null, '', `#/journal?date=${sel}`); render(el, new URLSearchParams()); }
    else if (b.dataset.m) { month = C.addDays(month + '-15', +b.dataset.m * 30).slice(0, 7); render(el, new URLSearchParams()); }
    else if ('today' in b.dataset) { sel = t; month = t.slice(0, 7); render(el, new URLSearchParams()); }
    else if ('add' in b.dataset) A.entryForm(null, { work_date: sel });
    else if ('plan' in b.dataset) A.planForm(null, { date: sel });
    else if (b.dataset.editPlan) A.planForm(get('plans', b.dataset.editPlan));
    else if (b.dataset.edit) A.entryForm(get('entries', b.dataset.edit));
    else if (b.dataset.del) A.deleteEntry(get('entries', b.dataset.del));
    else if (b.dataset.attach) { const x = get('entries', b.dataset.attach); A.uploadEvidence({ contract_id: x.contract_id, related_work_date: x.work_date, task_id: x.task_id || '', time_entry_id: x.id }); }
    else if (b.dataset.ev) A.uploadEvidence({ contract_id: b.dataset.ev, related_work_date: sel });
    else if (b.dataset.sub) A.submissionForm(null, { contract_id: b.dataset.sub, period_start: sel, period_end: sel, submitted_hours: C.hundredthsToString(C.minutesToCenti(M.loggedMinutes(S.entries.filter(x => x.contract_id === b.dataset.sub && x.work_date === sel)))) });
    else if (b.dataset.app) A.approvalForm(null, { contract_id: b.dataset.app, period_start: sel, period_end: sel });
  };
  el.onchange = e => {
    const k = e.target.dataset.closeout;
    if (!k) return;
    const co = { ...(settings().closeouts || {}) };
    co[k] = { ...(co[k] || {}), allLogged: e.target.checked };
    updateSettings({ closeouts: co });
  };
}
