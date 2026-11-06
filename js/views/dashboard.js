import { S, get, today, profile, scopeContractIds, contractStatus, contractLabel, employerName, homeCurrency, isAllScope } from '../store.js';
import { h, mount, card, moneyList, empty, badge } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import { rateFor } from '../fx.js';
import { activeTimer } from '../actions.js';
import { fmtDateTime } from '../tz.js';

let period = 'week';

export function phpEstimate(byCur) {
  const home = homeCurrency();
  const out = {}; const notes = [];
  for (const [cur, v] of Object.entries(byCur)) {
    if (cur === home) { C.addTo(out, home, v); continue; }
    const r = rateFor(cur, home);
    if (!r.rate) { notes.push(`${cur}: no rate available`); continue; }
    C.addTo(out, home, C.convertMinor(v, r.rate));
    notes.push(`${cur}→${home} ${r.rate.toFixed(4)} · ${r.provider}${r.stale ? ' (stale)' : ''}`);
  }
  return { out, notes };
}

function rangeFor(p, t) {
  if (p === 'today') return { from: t, to: t };
  if (p === 'week') return C.weekRange(t);
  if (p === 'month') return C.monthRange(t);
  return { from: null, to: null };
}

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  const { from, to } = rangeFor(period, t);

  const allApprovals = S.approvals.filter(a => cids.has(a.contract_id));
  const earn = M.earnings(allApprovals);
  const php = phpEstimate(earn.byCur);
  const logged = M.loggedMinutes(M.entriesIn(cids, from, to));
  const fin = M.finance(cids);
  // Submitted hours still awaiting an approval record for an overlapping period.
  const awaiting = S.submissions.filter(s => cids.has(s.contract_id) && ['Submitted', 'Acknowledged'].includes(s.status) &&
    !S.approvals.some(a => a.contract_id === s.contract_id && C.rangesOverlap(a.period_start, a.period_end, s.period_start, s.period_end)));

  // Today — availability is personal and counts ALL employers regardless of the switcher.
  const limit = profile()?.daily_availability_limit_minutes || 360;
  const todayAll = M.loggedMinutes(S.entries.filter(e => e.work_date === t));
  const av = C.availability(limit, todayAll);
  const byEmployer = new Map();
  for (const e of S.entries.filter(x => x.work_date === t && x.is_billable !== false)) {
    const emp = get('contracts', e.contract_id)?.employer_id;
    byEmployer.set(emp, (byEmployer.get(emp) || 0) + e.duration_minutes);
  }
  const todayEntries = S.entries.filter(e => e.work_date === t && cids.has(e.contract_id)).sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc));
  const approvedToday = S.approvals.filter(a => cids.has(a.contract_id) && a.period_start === t && a.period_end === t);
  const tasks = S.tasks.filter(x => cids.has(x.contract_id) && !['Completed', 'On hold'].includes(x.status))
    .sort((a, b) => (a.due_at || '9').localeCompare(b.due_at || '9')).slice(0, 6);
  const workedContracts = [...new Set(todayEntries.map(e => e.contract_id))];
  const missingEvidence = workedContracts.filter(cid => !S.evidence.some(f => f.contract_id === cid && f.related_work_date === t));
  const timer = activeTimer();
  const plans = S.plans.filter(p => p.date === t && cids.has(p.contract_id));

  const contracts = S.contracts.filter(c => cids.has(c.id) && ['active', 'upcoming'].includes(contractStatus(c, t)));

  mount(el, h`
    <div class="chips" role="tablist" aria-label="Logged-hours period">
      ${[['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']].map(([k, l]) => h`<button class="chip ${period === k ? 'active' : ''}" data-period="${k}">${l}</button>`)}
      ${isAllScope() ? '' : badge('Filtered by employer switcher', 'accent')}
    </div>
    <div class="stats">
      ${card('Logged hours', C.fmtMinutesDec(logged), from ? `${C.fmtDate(from)}${to !== from ? ' – ' + C.fmtDate(to) : ''}` : 'All time', 'logged')}
      ${card('Submitted, awaiting approval', C.fmtCenti(M.sumCenti(awaiting, 'submitted_hours')), `${awaiting.length} submission${awaiting.length === 1 ? '' : 's'}`, 'submitted')}
      ${card('Approved hours to date', C.fmtCenti(earn.centi), 'Manually recorded approvals', 'approved')}
      ${card('Earned (approved × rate)', moneyList(earn.byCur, '0.00'), earn.rateMissing ? 'Some approvals have no rate set' : 'Contract currency', 'approved')}
      ${card(`Estimated ${homeCurrency()}`, moneyList(php.out, 'No rate'), 'Estimate only — not a payout figure', 'approved')}
      ${card('Approved, not invoiced', moneyList(fin.notInvoiced, '0.00'), C.fmtCenti(fin.notInvoicedCenti), 'invoiced')}
      ${card('Invoiced, not paid', moneyList(fin.outstanding, '0.00'), 'Outstanding balances', 'invoiced')}
      ${card('Payments received', moneyList(fin.paid, '0.00'), 'Recorded payments', 'paid')}
    </div>

    <div class="grid side">
      <section class="panel">
        <div class="panel-head"><h2>Today · ${C.fmtDate(t)}</h2><a class="btn sm" href="#/journal">Open journal</a></div>
        <div class="stats">
          ${card('Logged today (all employers)', C.fmtMinutesDec(todayAll), C.fmtHM(todayAll), 'logged')}
          ${card('Remaining availability', C.fmtMinutesDec(av.remaining), av.over ? `Over by ${C.fmtMinutesDec(av.overBy)}` : `of ${C.fmtMinutesDec(limit)} personal limit`, av.over ? 'invoiced' : 'logged')}
          ${card('Approved today', C.fmtCenti(M.sumCenti(approvedToday, 'approved_hours')), approvedToday.length ? 'Recorded' : 'Not entered', 'approved')}
        </div>
        <div class="meter ${av.over ? 'over' : ''}"><i style="width:${Math.min(100, todayAll / limit * 100)}%"></i></div>
        ${byEmployer.size > 1 ? h`<p class="small muted">${[...byEmployer].map(([id, m]) => `${employerName(get('employers', id))}: ${C.fmtMinutesDec(m)}`).join(' · ')}</p>` : ''}
        ${av.over ? h`<div class="warnbox mt">Today's logged time is over your personal availability limit. Records are kept as entered.</div>` : ''}
        ${timer ? h`<div class="item mt"><div class="item-main"><div class="item-title">Timer ${timer.status}: <span data-timer-elapsed="${timer.id}">--</span></div><div class="item-meta">${get('tasks', timer.task_id)?.title || 'No task'} · ${contractLabel(get('contracts', timer.contract_id))}</div></div><a class="btn sm" href="#/timer">Open</a></div>` : ''}
        ${plans.length ? h`<p class="small">Pre-agreed today: ${plans.map(p => `${C.fmtCenti(C.toCenti(p.planned_hours))} (${contractLabel(get('contracts', p.contract_id))})`).join(', ')}</p>` : ''}
        ${missingEvidence.length ? h`<div class="warnbox mt">Evidence missing today for: ${missingEvidence.map(id => contractLabel(get('contracts', id))).join(', ')} · <a href="#/evidence">Add evidence</a></div>` : ''}
        <h3 class="mt">Journal entries</h3>
        ${todayEntries.length ? h`<div class="list mt">${todayEntries.map(e => h`<div class="item"><div class="item-main"><div class="item-title">${e.activity_notes}</div><div class="item-meta"><span>${contractLabel(get('contracts', e.contract_id))}</span>${e.task_id ? h`<span>${get('tasks', e.task_id)?.title}</span>` : ''}${e.is_billable === false ? badge('Non-billable') : ''}</div></div><div class="item-side num">${C.fmtMinutesDec(e.duration_minutes)}</div></div>`)}</div>` : empty('No time logged today yet.')}
      </section>

      <div>
        <section class="panel">
          <div class="panel-head"><h2>Open tasks</h2><a class="btn sm" href="#/tasks">All tasks</a></div>
          ${tasks.length ? h`<div class="list">${tasks.map(x => h`<div class="item"><div class="item-main"><div class="item-title">${x.title}</div><div class="item-meta"><span>${x.status}</span>${x.due_at ? h`<span class="${x.due_at < t ? 'badge bad' : ''}">Due ${C.fmtDate(x.due_at)}</span>` : ''}</div></div></div>`)}</div>` : empty('No open tasks.')}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Contracts</h2></div>
          ${contracts.length ? h`<div class="list">${contracts.map(c => {
            const st = contractStatus(c, t);
            const left = c.end_date ? C.daysBetween(t, c.end_date) : null;
            return h`<div class="item"><div class="item-main"><div class="item-title">${employerName(get('employers', c.employer_id))}</div><div class="item-meta"><span>${c.title}</span><span>${c.currency}</span></div></div>
              <div class="item-side">${badge(st, st === 'active' ? 'ok' : 'accent')}<div class="small muted">${st === 'upcoming' ? `Starts in ${C.daysBetween(t, c.start_date)} d` : left != null ? `${left} days left` : 'Open-ended'}</div></div></div>`;
          })}</div>` : empty('No active contracts.', h`<a class="btn primary" href="#/employers">Add employer</a>`)}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Recent activity</h2></div>
          ${recent()}
        </section>
      </div>
    </div>`);

  el.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { period = b.dataset.period; render(el); });
}

const ENTITY = { entries: 'Time entry', tasks: 'Task', evidence: 'Evidence', submissions: 'Timesheet submission', approvals: 'Approval', invoices: 'Invoice', payments: 'Payment', employers: 'Employer', contracts: 'Contract', rates: 'Rate', profile: 'Profile', plans: 'Schedule', allocations: 'Invoice allocation' };
const VERB = { create: 'added', update: 'updated', delete: 'deleted' };

function recent() {
  const rows = S.audit.slice(-12).reverse();
  if (!rows.length) return empty('Activity will appear here.');
  return h`<div class="list">${rows.map(a => {
    const v = a.new_value_json || a.old_value_json || {};
    const label = v.title || v.original_filename || v.legal_name || v.invoice_number || (v.activity_notes || '').slice(0, 40) || (v.approved_hours ? v.approved_hours + ' h' : '');
    return h`<div class="small"><b>${ENTITY[a.entity_type] || a.entity_type}</b> ${VERB[a.action] || a.action}${label ? h` · ${label}` : ''}<div class="muted">${fmtDateTime(a.occurred_at_utc, Intl.DateTimeFormat().resolvedOptions().timeZone)}${a.reason ? ' · ' + a.reason : ''}</div></div>`;
  })}</div>`;
}
