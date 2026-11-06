import { S, get, save, defaultContractId, contractLabel, scopeContractIds, homeTz, profile, today } from '../store.js';
import { h, mount, empty, contractOptions, taskOptions, fieldHtml, toast, badge } from '../ui.js';
import * as C from '../calc.js';
import * as A from '../actions.js';
import { fmtDateTime } from '../tz.js';
import * as M from '../metrics.js';

let pickContract = null, pickTask = '';

export function render(el) {
  const t = A.activeTimer();
  pickContract ||= defaultContractId();
  const tz = homeTz();
  const limit = profile()?.daily_availability_limit_minutes || 360;
  const loggedToday = M.loggedMinutes(S.entries.filter(e => e.work_date === today()));
  const cids = scopeContractIds();
  const recent = S.timers.filter(x => cids.has(x.contract_id) && ['saved', 'discarded'].includes(x.status))
    .sort((a, b) => b.started_at_utc.localeCompare(a.started_at_utc)).slice(0, 10);

  let face;
  if (t) {
    const task = get('tasks', t.task_id);
    const projected = loggedToday + A.timerElapsed(t) / 60;
    face = h`<div class="timer-face">
        <div class="big" data-timer-elapsed="${t.id}">${C.fmtSeconds(A.timerElapsed(t))}</div>
        <div class="sub"><b>${task?.title || 'No task'}</b> · ${contractLabel(get('contracts', t.contract_id))}</div>
        <div class="small muted">Started ${fmtDateTime(t.started_at_utc, tz)} · ${badge(t.status, t.status === 'running' ? 'ok' : 'warn')}</div>
      </div>
      ${projected > limit ? h`<div class="warnbox">With this timer, today's logged time would be over your personal ${C.fmtMinutesDec(limit)} limit.</div>` : ''}
      <div class="timer-controls">
        ${t.status === 'running' ? h`<button class="btn lg" data-a="pause">Pause</button>` : ''}
        ${t.status === 'paused' ? h`<button class="btn lg primary" data-a="resume">Resume</button>` : ''}
        ${t.status !== 'stopped' ? h`<button class="btn lg" data-a="stop">Stop</button>` : ''}
        <button class="btn lg primary" data-a="save">Save as entry</button>
        <button class="btn lg" data-a="switch">Switch task</button>
        <button class="btn lg danger ghost" data-a="discard">Discard</button>
      </div>
      <label class="field mt"><span>Running note (carried into the entry)</span><textarea data-note rows="2" placeholder="What are you working on?">${t.notes || ''}</textarea></label>
      <p class="small muted">The timer only creates logged time. It never changes approvals or earnings. It keeps running across refreshes — elapsed time is recomputed from stored timestamps.</p>`;
  } else {
    face = h`<div class="timer-face"><div class="big">00:00:00</div><div class="sub">Pick a task and start</div></div>
      <div class="form-grid">
        ${fieldHtml({ name: 'tc', label: 'Contract', type: 'select', options: contractOptions() }, pickContract)}
        ${fieldHtml({ name: 'tt', label: 'Task', type: 'select', options: taskOptions(pickContract, { blank: '— no task —' }) }, pickTask)}
        <div class="btn-row"><input data-newtask placeholder="…or quick-create a task title" style="flex:1"><button class="btn" data-a="quick">Create</button></div>
      </div>
      <div class="timer-controls"><button class="btn lg primary" data-a="start" ${pickContract ? '' : h`disabled`}>Start timer</button></div>
      <p class="small muted center">Today so far: ${C.fmtMinutesDec(loggedToday)} logged across all employers.</p>`;
  }

  mount(el, h`<div class="grid two">
    <section class="panel">${face}</section>
    <section class="panel"><div class="panel-head"><h2>Recent timer sessions</h2></div>
      ${recent.length ? h`<div class="list">${recent.map(x => h`<div class="item"><div class="item-main"><div class="item-title">${get('tasks', x.task_id)?.title || 'No task'}</div>
        <div class="item-meta"><span>${fmtDateTime(x.started_at_utc, tz)}</span><span>${contractLabel(get('contracts', x.contract_id))}</span>${x.status === 'discarded' ? badge('Discarded', 'warn') : badge('Saved', 'ok')}</div></div>
        <div class="item-side num">${C.fmtSeconds(x.accumulated_seconds)}</div></div>`)}</div>` : empty('No timer sessions yet.')}
    </section></div>`);

  el.onclick = async e => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    const cur = A.activeTimer();
    if (a === 'start') await A.startTimer(pickTask, pickContract);
    else if (a === 'pause') await A.pauseTimer(cur);
    else if (a === 'resume') await A.resumeTimer(cur);
    else if (a === 'stop') await A.stopTimer(cur);
    else if (a === 'save') await A.saveTimer(cur);
    else if (a === 'discard') await A.discardTimer(cur);
    else if (a === 'switch') { const saved = await A.saveTimer(cur); if (saved) toast('Saved. Pick the next task and start.'); }
    else if (a === 'quick') {
      const title = el.querySelector('[data-newtask]').value.trim();
      if (!title || !pickContract) return toast('Enter a task title', 'warn');
      const task = await save('tasks', { contract_id: pickContract, title, status: 'In progress', priority: 'Normal', assigned_at: today() });
      pickTask = task.id;
      render(el);
    }
  };
  el.onchange = e => {
    if (e.target.name === 'tc') { pickContract = e.target.value; pickTask = ''; render(el); }
    if (e.target.name === 'tt') pickTask = e.target.value;
  };
  let noteTimer;
  el.oninput = e => {
    if (!('note' in e.target.dataset)) return;
    clearTimeout(noteTimer);
    const v = e.target.value, id = A.activeTimer()?.id;
    noteTimer = setTimeout(() => { if (id) save('timers', { id, notes: v }, { audit: false }); }, 600);
  };
}

// Avoid re-rendering (and losing the note cursor) on our own note saves.
export const skipRerender = table => table === 'timers' && document.activeElement?.dataset?.note !== undefined;
