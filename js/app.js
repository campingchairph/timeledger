// App shell: router, header (employer switcher + live clocks), navigation,
// quick-add, onboarding and background jobs (FX refresh, 1-second tick).

import * as store from './store.js';
import { S, get, settings, homeTz, employerName, contractStatus } from './store.js';
import { h, raw, mount, $, $$, openDialog, toast } from './ui.js';
import { clockText, cityName } from './tz.js';
import { fmtSeconds } from './calc.js';
import * as A from './actions.js';
import { refreshAll } from './fx.js';

const I = p => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${p}"/></svg>`;
export const ROUTES = [
  ['dashboard', 'Dashboard', 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z'],
  ['journal', 'Daily Journal', 'M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4zM8 9h8M8 13h6'],
  ['tasks', 'Tasks', 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'],
  ['timer', 'Timer', 'M12 8v5l3 2M12 22a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 2h6'],
  ['evidence', 'Evidence Vault', 'M4 7h16v13H4zM9 7V4h6v3M8 12h8'],
  ['approvals', 'Approved Hours', 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4'],
  ['salary', 'Salary & Payments', 'M3 7h18v10H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM7 10v4M17 10v4'],
  ['reports', 'Reports', 'M6 2h9l5 5v15H6zM14 2v6h6M9 13h6M9 17h6'],
  ['invoices', 'Invoices', 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2zM9 8h6M9 12h6'],
  ['calculator', 'Calculator', 'M6 2h12v20H6zM9 6h6M9 11h.01M12 11h.01M15 11h.01M9 15h.01M12 15h.01M15 15h.01M9 18h6'],
  ['employers', 'Employers & Contracts', 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1M14 9h1M9 13h1M14 13h1M9 17h6'],
  ['settings', 'Settings & Backups', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'],
];
const MOBILE_TABS = ['dashboard', 'journal', 'timer', 'approvals'];

let current = { name: null, mod: null };
const view = () => $('#view');

// ---------- routing ----------

function routeName() {
  const n = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.some(r => r[0] === n) ? n : 'dashboard';
}
export const params = () => new URLSearchParams(location.hash.split('?')[1] || '');

async function route() {
  const name = routeName();
  const mod = await import(`./views/${name}.js`);
  if (current.name !== name) {
    for (const d of document.querySelectorAll('dialog[open]')) d.close();
    current.mod?.destroy?.();
    const v = view();
    v.onclick = v.onchange = v.oninput = v.onkeydown = null;
  }
  current = { name, mod };
  document.body.dataset.route = name;
  $$('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  $('#more-btn')?.classList.toggle('active', !MOBILE_TABS.includes(name));
  const label = ROUTES.find(r => r[0] === name)[1];
  document.title = `${label} · TimeLedger`;
  $('#page-title').textContent = label;
  render();
  view().scrollTop = 0; window.scrollTo(0, 0);
}

let pending = false, skipView = true;
export function render() {
  if (!current.mod) return;
  current.mod.render(view(), params());
  tick();
}
// Batch store notifications into one frame; views can opt out of re-rendering for their own writes.
function scheduleRender(table) {
  const skip = table === 'audit' || !!current.mod?.skipRerender?.(table);
  skipView = pending ? skipView && skip : skip;
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; if (!skipView) render(); renderHeader(); });
}

// ---------- header ----------

function switcherOptions() {
  const sel = settings().selection || {};
  const cur = sel.contractId ? 'c:' + sel.contractId : sel.employerId ? 'e:' + sel.employerId : 'all';
  const opt = (v, l) => h`<option value="${v}" ${v === cur ? h`selected` : ''}>${l}</option>`;
  const groups = S.employers.slice().sort((a, b) => (a.status === 'archived') - (b.status === 'archived') || employerName(a).localeCompare(employerName(b)))
    .map(e => h`<optgroup label="${employerName(e)}${e.status === 'archived' ? ' (archived)' : ''}">
      ${opt('e:' + e.id, `${employerName(e)} — all contracts`)}
      ${S.contracts.filter(c => c.employer_id === e.id).map(c => opt('c:' + c.id, `${c.title} · ${c.currency}${contractStatus(c) !== 'active' ? ` (${contractStatus(c)})` : ''}`))}
    </optgroup>`);
  return h`${opt('all', 'All employers')}${groups}`;
}

function clockZones() {
  const home = homeTz();
  const ids = store.scopeContractIds();
  const zones = [...new Set(S.contracts.filter(c => ids.has(c.id) && ['active', 'upcoming'].includes(contractStatus(c)))
    .flatMap(c => [c.primary_timezone, c.secondary_timezone]).filter(z => z && z !== home))];
  return [home, ...zones];
}

function renderHeader() {
  mount($('#switcher'), switcherOptions());
  mount($('#clocks'), h`${clockZones().map((z, i) => h`<div class="clock ${i ? '' : 'home'}" data-tz="${z}"><span class="clock-city">${cityName(z)}</span><span class="clock-time">--:--:--</span><span class="clock-meta"></span></div>`)}`);
  tick();
}

// ---------- 1-second tick: clocks + timers (text-only updates, no re-render) ----------

function tick() {
  const now = Date.now();
  const home = homeTz();
  const homeDate = clockText(now, home).ymd;
  for (const el of $$('.clock')) {
    const c = clockText(now, el.dataset.tz);
    el.querySelector('.clock-time').textContent = c.time;
    el.querySelector('.clock-meta').textContent = `${c.date} · ${c.abbr}`;
    el.classList.toggle('date-differs', c.ymd !== homeDate);
  }
  const t = A.activeTimer();
  const chip = $('#timer-chip');
  if (t) {
    const task = get('tasks', t.task_id), c = get('contracts', t.contract_id);
    chip.hidden = false;
    chip.className = 'timer-chip ' + t.status;
    chip.querySelector('.tc-time').textContent = fmtSeconds(A.timerElapsed(t, now));
    chip.querySelector('.tc-label').textContent = (task?.title || 'No task') + ' · ' + employerName(get('employers', c?.employer_id));
  } else chip.hidden = true;
  for (const el of $$('[data-timer-elapsed]')) el.textContent = fmtSeconds(A.timerElapsed(get('timers', el.dataset.timerElapsed), now));
}

// ---------- quick add ----------

function quickAdd() {
  const { el, close } = openDialog({
    title: 'Quick add',
    body: h`<div class="quick-grid">
      <button class="quick" data-q="entry"><b>Log time</b><span>Manual time entry</span></button>
      <button class="quick" data-q="timer"><b>Start timer</b><span>Per-task stopwatch</span></button>
      <button class="quick" data-q="task"><b>New task</b><span>Assigned work</span></button>
      <button class="quick" data-q="evidence"><b>Add evidence</b><span>Screenshot or file</span></button>
      <button class="quick" data-q="submission"><b>Timesheet submitted</b><span>Record a submission</span></button>
      <button class="quick" data-q="approval"><b>Approved hours</b><span>From client approval</span></button>
    </div>`,
  });
  el.addEventListener('click', async e => {
    const q = e.target.closest('[data-q]')?.dataset.q;
    if (!q) return;
    close();
    if (!store.pickableContracts().length) { toast('Add an employer and contract first', 'warn'); location.hash = '#/employers'; return; }
    if (q === 'entry') A.entryForm();
    if (q === 'timer') location.hash = '#/timer';
    if (q === 'task') A.taskForm();
    if (q === 'evidence') A.uploadEvidence();
    if (q === 'submission') A.submissionForm();
    if (q === 'approval') A.approvalForm();
  });
}

function moreMenu() {
  const { el, close } = openDialog({
    title: 'Menu',
    body: h`<nav class="more-grid">${ROUTES.map(([r, l, p]) => h`<a href="#/${r}" class="${current.name === r ? 'active' : ''}">${raw(I(p))}<span>${l}</span></a>`)}</nav>`,
  });
  el.addEventListener('click', e => { if (e.target.closest('a')) close(); });
}

// ---------- onboarding ----------

function onboarding() {
  if (settings().onboarded) return;
  const e = S.employers[0], c = S.contracts[0], p = store.profile();
  const rate = c && store.contractRates(c.id)[0];
  const { el, close } = openDialog({
    title: 'Welcome to TimeLedger',
    body: h`<p>Your tracker is set up with these starting records. They're ordinary editable records — confirm them, edit them, or add more employers any time.</p>
      <dl class="kv">
        <dt>Freelancer</dt><dd>${p?.full_name} · ${p?.home_timezone} · ${p?.home_currency}</dd>
        ${e ? h`<dt>Employer</dt><dd>${e.legal_name}</dd>` : ''}
        ${c ? h`<dt>Contract</dt><dd>${c.start_date} → ${c.end_date || 'open'} · ${c.currency}${rate ? ` ${rate.hourly_rate}/h` : ''}</dd><dt>Approval contact</dt><dd>${c.approval_contact_name}</dd>` : ''}
        <dt>Daily availability</dt><dd>${(p?.daily_availability_limit_minutes || 360) / 60} h personal limit (across all employers)</dd>
      </dl>
      <p class="note">Everything is stored privately on this device. Use Settings → Backups to export a full copy regularly.</p>`,
    actions: h`<button class="btn ghost" data-edit>Edit details</button><button class="btn primary" data-ok>Looks good</button>`,
  });
  const finish = () => store.updateSettings({ onboarded: true });
  el.querySelector('[data-ok]').onclick = () => { finish(); close(); };
  el.querySelector('[data-edit]').onclick = () => { finish(); close(); location.hash = '#/employers'; };
}

// ---------- boot ----------

async function boot() {
  try { await store.init(); }
  catch (e) { mount(view(), h`<div class="empty">Could not open local storage: ${e.message}</div>`); return; }

  mount($('#nav'), h`${ROUTES.map(([r, l, p]) => h`<a href="#/${r}" data-route="${r}">${raw(I(p))}<span>${l}</span></a>`)}`);
  mount($('#tabbar'), h`${MOBILE_TABS.map(r => { const [, l, p] = ROUTES.find(x => x[0] === r); return h`<a href="#/${r}" data-route="${r}">${raw(I(p))}<span>${l.split(' ')[0]}</span></a>`; })}
    <button id="more-btn" type="button">${raw(I('M4 6h16M4 12h16M4 18h16'))}<span>More</span></button>`);

  $('#switcher').addEventListener('change', e => {
    const [k, id] = e.target.value.split(':');
    store.updateSettings({ selection: { employerId: k === 'e' ? id : k === 'c' ? get('contracts', id)?.employer_id : null, contractId: k === 'c' ? id : null } });
  });
  $('#fab').addEventListener('click', quickAdd);
  $('#more-btn').addEventListener('click', moreMenu);
  $('#timer-chip').addEventListener('click', () => { location.hash = '#/timer'; });

  store.on(scheduleRender);
  window.addEventListener('hashchange', route);
  renderHeader();
  await route();
  document.body.classList.remove('booting');
  onboarding();

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); refreshAll().catch(() => {}); } });
  const fxLoop = () => refreshAll().catch(() => {}).finally(() => setTimeout(fxLoop, 5 * 60000));
  setTimeout(fxLoop, 1500);

  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.storage?.persisted?.().then(p => { if (!p) navigator.storage.persist?.(); });
}

boot();
