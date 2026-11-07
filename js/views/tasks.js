import { S, get, today, scopeContractIds, contractLabel, save, homeTz } from '../store.js';
import { h, mount, empty, badge, openDialog, table, icon } from '../ui.js';
import * as C from '../calc.js';
import * as A from '../actions.js';
import { fmtDateTime } from '../tz.js';

let filter = 'open', q = '';
const OPEN = s => !['Completed', 'On hold'].includes(s);
const STATUS_KIND = { Completed: 'ok', 'Amendments requested': 'warn', 'Waiting for information': 'warn', Submitted: 'accent', 'Ready for review': 'accent' };

export function render(el) {
  const cids = scopeContractIds();
  const t = today();
  let tasks = S.tasks.filter(x => cids.has(x.contract_id));
  const counts = { open: tasks.filter(x => OPEN(x.status)).length, all: tasks.length };
  for (const s of A.TASK_STATUSES) counts[s] = tasks.filter(x => x.status === s).length;
  if (filter === 'open') tasks = tasks.filter(x => OPEN(x.status));
  else if (filter !== 'all') tasks = tasks.filter(x => x.status === filter);
  if (q) { const s = q.toLowerCase(); tasks = tasks.filter(x => `${x.title} ${x.project_name} ${x.description} ${x.assigned_by}`.toLowerCase().includes(s)); }
  tasks.sort((a, b) => OPEN(b.status) - OPEN(a.status) || (a.due_at || '9').localeCompare(b.due_at || '9') || b.created_at.localeCompare(a.created_at));

  mount(el, h`<section class="panel">
    <div class="panel-head"><h2>Tasks</h2><input type="search" placeholder="Search tasks" value="${q}" data-q style="max-width:220px"><button class="btn primary" data-new>New task</button></div>
    <div class="chips">
      ${[['open', 'Open'], ['all', 'All'], ...A.TASK_STATUSES.map(s => [s, s])].filter(([k]) => k === 'open' || k === 'all' || counts[k]).map(([k, l]) => h`<button class="chip ${filter === k ? 'active' : ''}" data-f="${k}">${l} (${counts[k]})</button>`)}
    </div>
    ${tasks.length ? h`<div class="list">${tasks.map(x => {
      const mins = C.sumMinutes(S.entries.filter(e => e.task_id === x.id));
      return h`<div class="item">
        <div class="item-main"><div class="item-title"><a href="#" data-open="${x.id}">${x.title}</a></div>
          <div class="item-meta"><span>${contractLabel(get('contracts', x.contract_id))}</span>${x.project_name ? h`<span>${x.project_name}</span>` : ''}
            ${x.assigned_by ? h`<span>By ${x.assigned_by}</span>` : ''}${x.priority && x.priority !== 'Normal' ? badge(x.priority, x.priority === 'Urgent' ? 'bad' : 'warn') : ''}
            ${x.due_at ? h`<span class="${x.due_at < t && OPEN(x.status) ? 'badge bad' : ''}">Due ${C.fmtDate(x.due_at)}</span>` : ''}<span>${C.fmtMinutesDec(mins)} logged</span></div></div>
        <div class="item-side">
          <select data-status="${x.id}" aria-label="Status" style="width:auto;font-size:12px;padding:4px 6px">${A.TASK_STATUSES.map(s => h`<option ${s === x.status ? h`selected` : ''}>${s}</option>`)}</select>
          <div class="item-actions mt"><button class="icon-btn" data-timer="${x.id}" title="Start timer" aria-label="Start timer">${icon('play')}</button><button class="icon-btn" data-edit="${x.id}" title="Edit" aria-label="Edit">${icon('edit')}</button></div>
        </div></div>`;
    })}</div>` : empty(filter === 'open' ? 'No open tasks. Create one when work is assigned.' : 'No tasks match.', h`<button class="btn primary" data-new>New task</button>`)}
  </section>`);

  el.onclick = async e => {
    const b = e.target.closest('[data-f],[data-new],[data-edit],[data-timer],[data-open]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.f) { filter = b.dataset.f; render(el); }
    else if ('new' in b.dataset) A.taskForm();
    else if (b.dataset.edit) A.taskForm(get('tasks', b.dataset.edit));
    else if (b.dataset.timer) { const x = get('tasks', b.dataset.timer); if (await A.startTimer(x.id, x.contract_id)) location.hash = '#/timer'; }
    else if (b.dataset.open) detail(get('tasks', b.dataset.open));
  };
  el.onchange = async e => {
    const id = e.target.dataset.status;
    if (!id) return;
    const s = e.target.value;
    await save('tasks', { id, status: s, ...(s === 'Completed' ? { completed_at: today() } : {}), ...(s === 'Submitted' ? { submitted_at: today() } : {}) });
  };
  el.oninput = e => { if ('q' in e.target.dataset) { q = e.target.value; const pos = e.target.selectionStart; render(el); const i = el.querySelector('[data-q]'); i.focus(); i.setSelectionRange(pos, pos); } };
}

function detail(x) {
  const tz = homeTz();
  const entries = S.entries.filter(e => e.task_id === x.id).sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc));
  const timers = S.timers.filter(s => s.task_id === x.id);
  const ev = S.evidence.filter(f => f.task_id === x.id);
  const hist = S.audit.filter(a => a.entity_type === 'tasks' && a.entity_id === x.id).reverse();
  const { el } = openDialog({
    title: x.title, wide: true,
    body: h`<dl class="kv">
        <dt>Contract</dt><dd>${contractLabel(get('contracts', x.contract_id))}</dd>
        <dt>Status</dt><dd>${badge(x.status, STATUS_KIND[x.status])}</dd>
        ${x.project_name ? h`<dt>Project</dt><dd>${x.project_name}</dd>` : ''}
        ${x.assigned_by ? h`<dt>Assigned by</dt><dd>${x.assigned_by}${x.assigned_at ? ' on ' + C.fmtDate(x.assigned_at) : ''}</dd>` : ''}
        ${x.due_at ? h`<dt>Due</dt><dd>${C.fmtDate(x.due_at)}</dd>` : ''}
        ${x.completed_at ? h`<dt>Completed</dt><dd>${C.fmtDate(x.completed_at)}</dd>` : ''}
        ${x.source_reference ? h`<dt>Reference</dt><dd>${/^https?:\/\//.test(x.source_reference) ? h`<a href="${x.source_reference}" target="_blank" rel="noopener">${x.source_reference}</a>` : x.source_reference}</dd>` : ''}
      </dl>
      ${x.description ? h`<p class="pre">${x.description}</p>` : ''}
      ${x.notes ? h`<p class="note pre">${x.notes}</p>` : ''}
      <h3 class="mt">Time entries (${C.fmtMinutesDec(C.sumMinutes(entries))})</h3>
      ${table([
        { label: 'Date', render: e => C.fmtDate(e.work_date) },
        { label: 'Activity', render: e => e.activity_notes },
        { label: 'Hours', cls: 'num', render: e => C.fmtMinutesDec(e.duration_minutes) },
      ], entries, { empty: 'No time logged against this task.' })}
      <p class="small muted">${timers.length} timer session${timers.length === 1 ? '' : 's'} · ${ev.length} evidence file${ev.length === 1 ? '' : 's'}</p>
      <h3 class="mt">History</h3>
      ${hist.length ? h`<div class="list">${hist.map(a => h`<div class="small">${a.action} · ${fmtDateTime(a.occurred_at_utc, tz)}${a.old_value_json && a.new_value_json && a.old_value_json.status !== a.new_value_json.status ? ` · ${a.old_value_json.status} → ${a.new_value_json.status}` : ''}</div>`)}</div>` : empty('No history.')}`,
    actions: h`<button class="btn" data-ev>Attach file</button><span class="grow"></span><button class="btn" data-edit>Edit</button><button class="btn primary" data-log>Log time</button>`,
  });
  el.querySelector('[data-edit]').onclick = () => { el.close(); A.taskForm(x); };
  el.querySelector('[data-log]').onclick = () => { el.close(); A.entryForm(null, { contract_id: x.contract_id, task_id: x.id }); };
  el.querySelector('[data-ev]').onclick = () => { el.close(); A.uploadEvidence({ contract_id: x.contract_id, task_id: x.id, evidence_type: 'brief' }); };
}
