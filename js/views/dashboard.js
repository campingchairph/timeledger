import { S, get, today, profile, homeTz, scopeContractIds, contractStatus, employerName, homeCurrency, pickableContracts } from '../store.js';
import { h, mount, empty, badge, raw } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import { rateFor } from '../fx.js';
import * as A from '../actions.js';
import { fmtDateTime, partsIn } from '../tz.js';

let period = 'month';

export function phpEstimate(byCur) {
  const home = homeCurrency();
  const out = {}; const notes = [];
  for (const [cur, v] of Object.entries(byCur)) {
    if (cur === home) { C.addTo(out, home, v); continue; }
    const r = rateFor(cur, home);
    if (!r.rate) { notes.push(`${cur}: no rate available`); continue; }
    C.addTo(out, home, C.convertMinor(v, r.rate));
    notes.push(`1 ${cur} = ${r.rate.toFixed(2)} ${home} · ${r.provider.split(' (')[0]}${r.stale ? ' (stale)' : ''}`);
  }
  return { out, notes };
}

function rangeFor(p, t) {
  if (p === 'week') return C.weekRange(t);
  if (p === 'month') return C.monthRange(t);
  return { from: null, to: null };
}

const money = (bucket, fallbackCur) => {
  const e = Object.entries(bucket).filter(([, v]) => v);
  return e.length ? e.map(([c, v]) => C.fmtMoney(v, c)).join(' · ') : C.fmtMoney(0, fallbackCur);
};

function greeting() {
  const hr = partsIn(Date.now(), homeTz()).hour;
  return hr < 5 ? 'Up late' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

// Last 14 days: bar height = logged hours, filled part = hours covered by single-day approvals.
function bars(cids, t) {
  const days = Array.from({ length: 14 }, (_, i) => C.addDays(t, i - 13));
  const rows = days.map(d => ({
    d, logged: M.loggedMinutes(S.entries.filter(e => e.work_date === d && cids.has(e.contract_id))) / 60,
    approved: S.approvals.filter(a => cids.has(a.contract_id) && a.period_start === d && a.period_end === d).reduce((x, a) => x + C.toCenti(a.approved_hours) / 100, 0),
  }));
  const max = Math.max(6, ...rows.map(r => Math.max(r.logged, r.approved)));
  return h`<figure class="mini"><div class="mini-bars" role="img" aria-label="Logged and approved hours, last 14 days">${rows.map(r => {
    const tot = Math.max(r.logged, r.approved);
    return h`<span title="${C.fmtDate(r.d)}: ${r.logged.toFixed(2)} h logged, ${r.approved.toFixed(2)} h approved" class="${r.d === t ? 'today' : ''}" style="height:${Math.max(5, tot / max * 100)}%"><i style="height:${tot ? r.approved / tot * 100 : 0}%"></i></span>`;
  })}</div><figcaption>14 days · <b>approved</b></figcaption></figure>`;
}

function ring(mins, limit) {
  const r = 52, c = 2 * Math.PI * r, frac = Math.min(1, mins / limit);
  return raw(`<svg viewBox="0 0 120 120" aria-hidden="true"><circle class="track" cx="60" cy="60" r="${r}" stroke-width="12"/><circle class="bar" cx="60" cy="60" r="${r}" stroke-width="12" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - frac)).toFixed(1)}"/></svg>`);
}

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  const { from, to } = rangeFor(period, t);
  const scoped = S.contracts.filter(c => cids.has(c.id));
  const mainCur = scoped[0]?.currency || homeCurrency();

  // Hero: earned from approved hours (all time, per currency).
  const earnAll = M.earnings(S.approvals.filter(a => cids.has(a.contract_id)));
  const curs = Object.entries(earnAll.byCur).sort((a, b) => b[1] - a[1]);
  const [heroCur, heroMinor] = curs[0] || [mainCur, 0];
  const php = phpEstimate(earnAll.byCur);
  const finAll = M.finance(cids);

  // Today: personal availability counts ALL employers, whatever the switcher says.
  const limit = profile()?.daily_availability_limit_minutes || 360;
  const todayAll = M.loggedMinutes(S.entries.filter(e => e.work_date === t));
  const av = C.availability(limit, todayAll);
  const timer = A.activeTimer();
  const todayEntries = S.entries.filter(e => e.work_date === t && cids.has(e.contract_id)).sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc));
  const missingEvidence = [...new Set(todayEntries.map(e => e.contract_id))].filter(cid => !S.evidence.some(f => f.contract_id === cid && f.related_work_date === t));
  const plans = S.plans.filter(p => p.date === t && cids.has(p.contract_id));

  // Pipeline for the chosen period.
  const logged = M.loggedMinutes(M.entriesIn(cids, from, to));
  const awaiting = S.submissions.filter(s => cids.has(s.contract_id) && ['Submitted', 'Acknowledged'].includes(s.status) &&
    !S.approvals.some(a => a.contract_id === s.contract_id && C.rangesOverlap(a.period_start, a.period_end, s.period_start, s.period_end)));
  const earnP = M.earnings(M.approvalsIn(cids, from, to));
  const finP = M.finance(cids, from, to);

  const tasks = S.tasks.filter(x => cids.has(x.contract_id) && !['Completed', 'On hold'].includes(x.status))
    .sort((a, b) => (a.due_at || '9').localeCompare(b.due_at || '9')).slice(0, 5);
  const contracts = scoped.filter(c => ['active', 'upcoming'].includes(contractStatus(c, t)));
  const first = (profile()?.display_name || profile()?.full_name || '').split(' ')[0];
  const tz = homeTz();

  mount(el, h`
    <div class="greet">
      <div><h2>${greeting()}${first ? h`, <em>${first}</em>` : ''}</h2>
        <p>${new Date(C.dateToMs(t)).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', timeZone: 'UTC' })} · ${contracts.length} active contract${contracts.length === 1 ? '' : 's'}</p></div>
      <div class="btn-row"><button class="btn" data-go="timer">${raw('<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>')} Start timer</button><button class="btn accent" data-go="log">Log time</button></div>
    </div>

    <div class="hero-row">
      <section class="hero-card" aria-label="Earnings">
        <div class="hero-top"><div class="eyebrow"><i></i>Approved earnings</div>${bars(cids, t)}</div>
        <div><div class="hero-big">${C.fmtMoney(heroMinor, heroCur)}</div>
          <div class="hero-sub mt">${earnAll.rateMissing ? h`<span class="hero-warn">Some approved hours have no rate for their date — <a href="#/employers">set a rate</a></span>` : php.out[homeCurrency()] && heroCur !== homeCurrency() ? h`≈ <b>${C.fmtMoney(php.out[homeCurrency()], homeCurrency())}</b> estimate · ${php.notes.join(' · ')}` : php.notes.join(' · ') || 'Only manually approved hours count'}</div></div>
        <div class="hero-foot">
          <span class="hero-pill"><b>${C.fmtCenti(earnAll.centi)}</b> approved</span>
          <span class="hero-pill">Not invoiced <b>${money(finAll.notInvoiced, heroCur)}</b></span>
          <span class="hero-pill">Unpaid <b>${money(finAll.outstanding, heroCur)}</b></span>
          ${curs.slice(1).map(([c, v]) => h`<span class="hero-pill">Also <b>${C.fmtMoney(v, c)}</b></span>`)}
        </div>
      </section>

      <section class="today-card" aria-label="Today">
        <div class="ring ${av.over ? 'over' : ''}">${ring(todayAll, limit)}<div class="ring-label"><b>${C.hundredthsToString(C.minutesToCenti(todayAll))}</b><span>of ${C.hundredthsToString(C.minutesToCenti(limit))} h</span></div></div>
        <div class="today-info">
          <h3>Today</h3>
          <p>${av.over ? h`<span class="badge bad">Over by ${C.fmtMinutesDec(av.overBy)}</span>` : h`<b>${C.fmtMinutesDec(av.remaining)}</b> left in your personal limit`}</p>
          ${timer ? h`<p><a href="#/timer">Timer ${timer.status}</a> · <span data-timer-elapsed="${timer.id}">--</span></p>` : ''}
          ${plans.length ? h`<p class="muted small">Pre-agreed ${plans.map(p => C.fmtCenti(C.toCenti(p.planned_hours))).join(', ')}</p>` : ''}
          ${missingEvidence.length ? h`<p class="small"><a href="#/evidence">Add today's evidence</a></p>` : todayEntries.length ? h`<p class="small muted">Evidence attached for today</p>` : ''}
        </div>
      </section>
    </div>

    <div class="section-title"><h2>Your ledger</h2>
      <div class="chips" style="margin:0">${[['week', 'Week'], ['month', 'Month'], ['all', 'All']].map(([k, l]) => h`<button class="chip ${period === k ? 'active' : ''}" data-period="${k}">${l}</button>`)}</div></div>
    <div class="pipeline">
      <div class="pipe logged"><div class="pipe-label"><i></i>Logged</div><div class="pipe-value">${C.fmtMinutesDec(logged)}</div><div class="pipe-sub">Your recorded time</div></div>
      <div class="pipe submitted"><div class="pipe-label"><i></i>Submitted</div><div class="pipe-value">${C.fmtCenti(M.sumCenti(awaiting, 'submitted_hours'))}</div><div class="pipe-sub">Awaiting approval</div></div>
      <div class="pipe approved"><div class="pipe-label"><i></i>Approved</div><div class="pipe-value">${C.fmtCenti(earnP.centi)}</div><div class="pipe-sub">${money(earnP.byCur, mainCur)} earned</div></div>
      <div class="pipe invoiced"><div class="pipe-label"><i></i>Invoiced</div><div class="pipe-value">${money(finP.invoiced, mainCur)}</div><div class="pipe-sub">${money(finP.outstanding, mainCur)} unpaid</div></div>
      <div class="pipe paid"><div class="pipe-label"><i></i>Paid</div><div class="pipe-value">${money(finP.paid, mainCur)}</div><div class="pipe-sub">Money received</div></div>
    </div>

    <div class="grid side">
      <section class="panel">
        <div class="section-title" style="margin-top:0"><h2>Today's log</h2><a href="#/journal">Open journal →</a></div>
        ${todayEntries.length ? h`<div class="list">${todayEntries.map(e => h`<div class="item"><div class="item-main"><div class="item-title">${e.activity_notes}</div>
          <div class="item-meta"><span>${employerName(get('employers', get('contracts', e.contract_id)?.employer_id))}</span>${e.task_id ? h`<span class="dot-sep"></span><span>${get('tasks', e.task_id)?.title}</span>` : ''}${e.is_billable === false ? badge('Non-billable') : ''}</div></div>
          <div class="item-side num">${C.fmtMinutesDec(e.duration_minutes)}</div></div>`)}</div>`
        : empty('Nothing logged yet today.', h`<button class="btn sm" data-go="log">Log your first block</button>`)}
      </section>
      <section class="panel">
        <div class="section-title" style="margin-top:0"><h2>Up next</h2><a href="#/tasks">All tasks →</a></div>
        ${tasks.length ? h`<div class="list">${tasks.map(x => h`<div class="item"><div class="item-main"><div class="item-title">${x.title}</div><div class="item-meta"><span>${x.status}</span>${x.due_at ? h`<span class="dot-sep"></span>${x.due_at < t ? badge('Overdue · ' + C.fmtDate(x.due_at), 'bad') : h`<span>Due ${C.fmtDate(x.due_at)}</span>`}` : ''}</div></div></div>`)}</div>`
        : empty('No open tasks. Enjoy the calm.')}
      </section>
    </div>

    <div class="grid two">
      <section class="panel">
        <div class="section-title" style="margin-top:0"><h2>Contracts</h2><a href="#/employers">Manage →</a></div>
        ${contracts.length ? h`<div class="list">${contracts.map(c => {
          const st = contractStatus(c, t);
          const left = c.end_date ? C.daysBetween(t, c.end_date) : null;
          return h`<div class="item"><div class="item-main"><div class="item-title">${employerName(get('employers', c.employer_id))}</div><div class="item-meta"><span>${c.title}</span><span class="dot-sep"></span><span>${c.currency}</span></div></div>
            <div class="item-side">${badge(st === 'upcoming' ? `Starts in ${C.daysBetween(t, c.start_date)} d` : left != null ? `${left} days left` : 'Open-ended', st === 'active' ? 'ok' : 'accent')}</div></div>`;
        })}</div>` : empty('No active contracts.', pickableContracts().length ? '' : h`<a class="btn primary" href="#/employers">Add employer</a>`)}
      </section>
      <section class="panel">
        <div class="section-title" style="margin-top:0"><h2>Recent activity</h2></div>
        ${recent(tz)}
      </section>
    </div>`);

  el.onclick = async e => {
    const b = e.target.closest('[data-period],[data-go]');
    if (!b) return;
    if (b.dataset.period) { period = b.dataset.period; render(el); return; }
    if (!pickableContracts().length) { location.hash = '#/employers'; return; }
    if (b.dataset.go === 'log') A.entryForm();
    if (b.dataset.go === 'timer') location.hash = '#/timer';
  };
}

const ENTITY = { entries: 'Time entry', tasks: 'Task', evidence: 'Evidence', submissions: 'Timesheet', approvals: 'Approval', invoices: 'Invoice', payments: 'Payment', employers: 'Employer', contracts: 'Contract', rates: 'Rate', profile: 'Profile', plans: 'Schedule', allocations: 'Invoice line' };
const COLOR = { entries: 'logged', submissions: 'submitted', approvals: 'approved', invoices: 'invoiced', allocations: 'invoiced', payments: 'paid', evidence: 'paid' };
const VERB = { create: 'added', update: 'updated', delete: 'deleted', archive: 'archived', unarchive: 'restored' };

function recent(tz) {
  const rows = S.audit.filter(a => a.entity_type !== 'allocations').slice(-6).reverse();
  if (!rows.length) return empty('Activity will appear here.');
  return h`<div class="activity">${rows.map(a => {
    const v = a.new_value_json || a.old_value_json || {};
    const label = v.title || v.original_filename || v.legal_name || v.invoice_number || (v.activity_notes || '').slice(0, 48) || (v.approved_hours ? v.approved_hours + ' h' : '');
    return h`<div class="act"><i style="background:var(--${COLOR[a.entity_type] || 'ink-4'})"></i><div><b>${ENTITY[a.entity_type] || a.entity_type}</b> ${VERB[a.action] || a.action}${label ? h` · ${label}` : ''}<div class="muted">${fmtDateTime(a.occurred_at_utc, tz)}</div></div></div>`;
  })}</div>`;
}
