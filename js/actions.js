// Entity forms and workflows shared by several views and the quick-add menu.

import { S, get, save, remove, updateSettings, settings, profile, homeTz, today, defaultContractId, contractLabel, nowIso, putBlob } from './store.js';
import { formModal, contractOptions, taskOptions, toast, askReason, showField, confirmDialog, imageToDataUrl, h } from './ui.js';
import * as C from './calc.js';
import { zonedToUtc, timeIn, dateIn } from './tz.js';

export const TASK_STATUSES = ['Assigned', 'In progress', 'Waiting for information', 'Ready for review', 'Submitted', 'Amendments requested', 'Completed', 'On hold'];
export const PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'];
export const CATEGORIES = ['Design', 'Revisions', 'Research', 'Meeting / call', 'Admin', 'Communication', 'Production', 'Review'];
export const EVIDENCE_TYPES = [
  ['wip_screenshot', 'Work-in-progress screenshot'], ['completed_screenshot', 'Completed work screenshot'],
  ['approved_timesheet', 'Approved timesheet image'], ['approval_email', 'Approval email screenshot'],
  ['approval_chat', 'Approval chat screenshot'], ['submitted_invoice', 'Submitted invoice'],
  ['payment_confirmation', 'Payment confirmation / remittance'], ['brief', 'Brief / assignment'],
  ['final_deliverable', 'Final deliverable'], ['other', 'Other'],
];
export const evidenceTypeLabel = t => EVIDENCE_TYPES.find(e => e[0] === t)?.[1] || t;
export const SUBMISSION_STATUSES = ['Draft', 'Submitted', 'Acknowledged', 'Approved', 'Partially approved', 'Rejected', 'Clarification requested'];
export const SUBMISSION_METHODS = ['Email', 'Chat', 'Client portal', 'Shared spreadsheet', 'Other'];
export const APPROVAL_SOURCES = ['Email', 'Chat message', 'Signed timesheet', 'Client portal', 'Verbal (noted)', 'Other'];

const MAX_FILE = 25 * 1024 * 1024;
const ACCEPT = 'image/*,application/pdf,text/plain,text/csv,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.eml,.msg,.zip';
const ALLOWED = /^(image\/|application\/pdf|text\/|application\/(msword|vnd\.|zip|x-zip)|message\/)/;

const rememberContract = id => { if (id && settings().lastContractId !== id) updateSettings({ lastContractId: id }); };
const contractField = () => ({ name: 'contract_id', label: 'Contract', type: 'select', required: true, options: contractOptions() });

// ---------- warnings ----------

export function dayWarnings(entry) {
  const out = [];
  const overlaps = C.findOverlaps(S.entries.filter(e => e.is_billable !== false), entry);
  if (overlaps.length && entry.is_billable !== false) out.push(`Overlaps ${overlaps.length} other entr${overlaps.length > 1 ? 'ies' : 'y'} (${overlaps.map(o => contractLabel(get('contracts', o.contract_id))).join(', ')})`);
  const day = S.entries.filter(e => e.work_date === entry.work_date && e.is_billable !== false);
  const limit = profile()?.daily_availability_limit_minutes || 360;
  const total = C.sumMinutes(day);
  if (total > limit) out.push(`Logged ${C.fmtMinutesDec(total)} across all employers — over your personal ${C.fmtMinutesDec(limit)} availability limit`);
  const c = get('contracts', entry.contract_id);
  if (c?.daily_availability_limit_minutes) {
    const ct = C.sumMinutes(day.filter(e => e.contract_id === c.id));
    if (ct > c.daily_availability_limit_minutes) out.push(`Over the ${C.fmtMinutesDec(c.daily_availability_limit_minutes)} personal cap set for this contract`);
  }
  return out;
}
const warnToast = w => w.length ? toast('Saved with warnings: ' + w.join(' · '), 'warn', 7000) : toast('Saved');

// ---------- time entries ----------

export async function entryForm(existing, prefill = {}) {
  const tz = existing?.timezone || homeTz();
  const base = existing ? {
    ...existing,
    start: timeIn(Date.parse(existing.start_at_utc), tz), end: timeIn(Date.parse(existing.end_at_utc), tz),
    crosses: dateIn(Date.parse(existing.end_at_utc), tz) !== existing.work_date,
    is_billable: existing.is_billable !== false,
  } : { contract_id: defaultContractId(), work_date: today(), is_billable: true, ...prefill };
  const fields = [
    contractField(),
    { name: 'work_date', label: 'Date', type: 'date', required: true },
    { name: 'task_id', label: 'Task', type: 'select', options: taskOptions(base.contract_id) },
    { name: 'start', label: `Start (${tz})`, type: 'time', required: true },
    { name: 'end', label: 'End', type: 'time', required: true },
    { name: 'crosses', label: 'Ends after midnight (next day)', type: 'checkbox' },
    { name: 'dur', type: 'html', html: h`<div class="duration-preview muted">Duration: —</div>` },
    { name: 'category', label: 'Work category', list: 'dl-categories' },
    { name: 'is_billable', label: 'Billable work', type: 'checkbox', hint: 'Untick for clearly-marked non-billable notes' },
    { name: 'activity_notes', label: 'Activity notes', type: 'textarea', full: true, required: true, placeholder: 'What did you do?' },
    { name: 'deliverable_notes', label: 'Deliverable', type: 'textarea', full: true, rows: 2, placeholder: 'What was produced / sent?' },
    ...(existing ? [] : [{ name: 'files', label: 'Attach evidence (optional)', type: 'file', multiple: true, accept: ACCEPT, full: true }]),
  ];
  let lastContract = base.contract_id;
  return formModal({
    title: existing ? 'Edit time entry' : 'Log time', fields, values: base, wide: true,
    intro: h`<datalist id="dl-categories">${CATEGORIES.map(c => h`<option value="${c}">`)}</datalist>`,
    onInput: (v, form) => {
      if (v.contract_id !== lastContract) {
        lastContract = v.contract_id;
        const sel = form.elements.task_id;
        sel.innerHTML = taskOptions(v.contract_id).map(([id, l]) => `<option value="${id}">${l.replace(/</g, '&lt;')}</option>`).join('');
      }
      const r = computeTimes(v, tz);
      form.querySelector('.duration-preview').textContent = r.error ? r.error : `Duration: ${C.fmtMinutesDec(r.minutes)} (${C.fmtHM(r.minutes)})`;
    },
    onSubmit: async v => {
      const r = computeTimes(v, tz);
      if (r.error) throw new Error(r.error);
      if (v.task_id && get('tasks', v.task_id)?.contract_id !== v.contract_id) throw new Error('That task belongs to a different contract.');
      const rec = {
        id: existing?.id, contract_id: v.contract_id, task_id: v.task_id || null, work_date: v.work_date,
        start_at_utc: new Date(r.start).toISOString(), end_at_utc: new Date(r.end).toISOString(), timezone: tz,
        duration_minutes: r.minutes, category: v.category, activity_notes: v.activity_notes,
        deliverable_notes: v.deliverable_notes, is_billable: v.is_billable,
        source: existing?.source || prefill.source || 'manual', timer_session_id: existing?.timer_session_id || prefill.timer_session_id || null,
      };
      let reason = '';
      if (existing) {
        reason = await askReason('Why are you editing this entry?', 'Reason (kept in the audit history)');
        if (!reason) return false;
      } else if (prefill.source === 'timer' && (rec.start_at_utc !== prefill.start_at_utc || rec.end_at_utc !== prefill.end_at_utc)) {
        reason = `Adjusted from timer (${prefill.start_at_utc} → ${prefill.end_at_utc})`;
      }
      const saved = await save('entries', rec, { reason });
      rememberContract(v.contract_id);
      if (v.files?.length) await storeEvidenceFiles(v.files, { contract_id: v.contract_id, related_work_date: v.work_date, task_id: rec.task_id, time_entry_id: saved.id, evidence_type: 'wip_screenshot' });
      warnToast(dayWarnings(saved));
      return saved;
    },
  });
}

function computeTimes(v, tz) {
  if (!v.work_date || !v.start || !v.end) return { error: 'Enter date, start and end.' };
  const start = zonedToUtc(v.work_date, v.start, tz);
  const end = zonedToUtc(v.crosses ? C.addDays(v.work_date, 1) : v.work_date, v.end, tz);
  if (end <= start) return { error: 'End is before start. Tick "Ends after midnight" if it crosses into the next day.' };
  const minutes = Math.round((end - start) / 60000);
  if (minutes > 24 * 60) return { error: 'An entry cannot exceed 24 hours.' };
  return { start, end, minutes };
}

export async function deleteEntry(e) {
  const reason = await askReason('Delete this time entry?', 'Reason for deleting (kept in the audit history)');
  if (!reason) return;
  await remove('entries', e.id, { reason });
  toast('Entry deleted');
}

// ---------- tasks ----------

export async function taskForm(existing, prefill = {}) {
  const v = existing ? { ...existing } : { contract_id: defaultContractId(), status: 'Assigned', priority: 'Normal', assigned_at: today(), ...prefill };
  return formModal({
    title: existing ? 'Edit task' : 'New task', wide: true, values: v,
    fields: [
      contractField(),
      { name: 'title', label: 'Title', required: true },
      { name: 'project_name', label: 'Project' },
      { name: 'assigned_by', label: 'Assigned by' },
      { name: 'assigned_at', label: 'Assigned on', type: 'date' },
      { name: 'due_at', label: 'Due', type: 'date' },
      { name: 'priority', label: 'Priority', type: 'select', options: PRIORITIES },
      { name: 'status', label: 'Status', type: 'select', options: TASK_STATUSES },
      { name: 'description', label: 'Description / instructions', type: 'textarea', full: true },
      { name: 'source_reference', label: 'Reference link / source message', full: true },
      { name: 'notes', label: 'Notes & amendments', type: 'textarea', full: true, rows: 2 },
    ],
    onSubmit: async val => {
      const rec = { ...val, id: existing?.id };
      if (val.status === 'Completed' && existing?.status !== 'Completed') rec.completed_at = today();
      if (val.status === 'Submitted' && existing?.status !== 'Submitted') rec.submitted_at = today();
      const t = await save('tasks', rec);
      rememberContract(val.contract_id);
      toast(existing ? 'Task updated' : 'Task created');
      return t;
    },
  });
}

// ---------- evidence ----------

async function sha256(buf) {
  if (!crypto.subtle) return null;
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function storeEvidenceFiles(files, meta) {
  const saved = [];
  for (const file of files) {
    if (file.size > MAX_FILE) { toast(`${file.name} is over 25 MB — skipped`, 'warn'); continue; }
    if (file.type && !ALLOWED.test(file.type)) { toast(`${file.name}: unsupported file type — skipped`, 'warn'); continue; }
    const buf = await file.arrayBuffer();
    const hash = await sha256(buf);
    if (hash && S.evidence.some(e => e.sha256 === hash)) toast(`${file.name} is identical to a file already in the vault (kept both).`, 'warn');
    let thumb = '';
    if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') { try { thumb = await imageToDataUrl(file, 320); } catch { /* not decodable */ } }
    const id = crypto.randomUUID();
    await putBlob(id, new Blob([buf], { type: file.type }));
    saved.push(await save('evidence', {
      id, original_filename: file.name, mime_type: file.type || 'application/octet-stream', file_size: file.size,
      sha256: hash, uploaded_at_utc: nowIso(), thumb, contains_approval: false, provided_by: 'self',
      is_annotated_copy: false, description: '', source_person: '', ...meta,
    }));
  }
  if (saved.length) toast(`${saved.length} file${saved.length > 1 ? 's' : ''} added to the vault`);
  return saved;
}

export function evidenceFields({ withFile = true } = {}) {
  return [
    contractField(),
    { name: 'evidence_type', label: 'Type', type: 'select', options: EVIDENCE_TYPES, required: true },
    ...(withFile ? [{ name: 'files', label: 'Files (originals are preserved)', type: 'file', multiple: true, accept: ACCEPT, required: true, full: true }] : []),
    { name: 'related_work_date', label: 'Related work date', type: 'date' },
    { name: 'task_id', label: 'Task', type: 'select', options: taskOptions(null) },
    { name: 'time_entry_id', label: 'Time entry', type: 'select', options: [['', '— none —'], ...S.entries.slice(-200).reverse().map(e => [e.id, `${C.fmtDate(e.work_date)} · ${C.fmtMinutesDec(e.duration_minutes)} · ${(e.activity_notes || '').slice(0, 40)}`])] },
    { name: 'approval_record_id', label: 'Approval record', type: 'select', options: [['', '— none —'], ...S.approvals.map(a => [a.id, `${C.fmtDate(a.period_start)}–${C.fmtDate(a.period_end)} · ${C.fmtCenti(C.toCenti(a.approved_hours))}`])] },
    { name: 'provided_by', label: 'Created by', type: 'select', options: [['self', 'Me (user-created)'], ['client', 'Client-provided']] },
    { name: 'source_person', label: 'Source person' },
    { name: 'category', label: 'Category' },
    { name: 'description', label: 'Description', type: 'textarea', full: true, rows: 2 },
    { name: 'contains_approval', label: 'This file contains a clear approval communication from the client', type: 'checkbox', full: true, hint: 'Only tick if the content itself shows approval — otherwise it is not labelled as approval evidence.' },
    { name: 'is_annotated_copy', label: 'This is an annotated copy (not the original)', type: 'checkbox', full: true },
  ];
}

export async function uploadEvidence(prefill = {}) {
  const fields = evidenceFields();
  return formModal({
    title: 'Add evidence', wide: true, fields, values: { contract_id: defaultContractId(), related_work_date: today(), evidence_type: 'wip_screenshot', provided_by: 'self', ...prefill },
    submitLabel: 'Upload',
    onSubmit: async v => {
      const { files, ...meta } = v;
      for (const k of ['task_id', 'time_entry_id', 'approval_record_id']) meta[k] ||= null;
      rememberContract(v.contract_id);
      return storeEvidenceFiles(files, { ...meta, original_id: prefill.original_id || null });
    },
  });
}

// ---------- submissions / approvals / plans ----------

export async function submissionForm(existing, prefill = {}) {
  const cid = existing?.contract_id || prefill.contract_id || defaultContractId();
  const c = get('contracts', cid);
  const v = existing ? { ...existing } : { contract_id: cid, status: 'Submitted', submission_method: 'Email', submitted_at: today(), recipient: c?.approval_contact_name || '', period_start: today(), period_end: today(), ...prefill };
  return formModal({
    title: existing ? 'Edit timesheet submission' : 'Record timesheet submission', wide: true, values: v,
    fields: [
      contractField(),
      { name: 'status', label: 'Status', type: 'select', options: SUBMISSION_STATUSES },
      { name: 'period_start', label: 'Period start', type: 'date', required: true },
      { name: 'period_end', label: 'Period end', type: 'date', required: true },
      { name: 'submitted_hours', label: 'Hours submitted', type: 'hours', required: true },
      { name: 'submitted_at', label: 'Submitted on', type: 'date' },
      { name: 'submission_method', label: 'Method', type: 'select', options: SUBMISSION_METHODS },
      { name: 'recipient', label: 'Recipient' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
      ...(existing ? [] : [{ name: 'files', label: 'Attach timesheet / screenshot', type: 'file', multiple: true, accept: ACCEPT, full: true }]),
      { name: 'logged', type: 'html', html: h`<div class="logged-hint muted"></div>` },
    ],
    onInput: (val, form) => {
      if (!val.period_start || !val.period_end) return;
      const mins = C.sumMinutes(S.entries.filter(e => e.contract_id === val.contract_id && e.is_billable !== false && C.inRange(e.work_date, val.period_start, val.period_end)));
      form.querySelector('.logged-hint').textContent = `Logged for this contract in that period: ${C.fmtMinutesDec(mins)}`;
    },
    onSubmit: async val => {
      if (val.period_end < val.period_start) throw new Error('Period end is before start.');
      if (Number.isNaN(C.toCenti(val.submitted_hours))) throw new Error('Enter hours as a number, e.g. 6.5');
      const { files, ...rest } = val;
      const s = await save('submissions', { ...rest, id: existing?.id, submitted_at_utc: rest.submitted_at ? new Date(rest.submitted_at + 'T12:00:00Z').toISOString() : null });
      if (files?.length) {
        const [ev] = await storeEvidenceFiles(files, { contract_id: val.contract_id, related_work_date: val.period_end, evidence_type: 'approved_timesheet', submission_id: s.id, description: 'Submitted timesheet' });
        if (ev) await save('submissions', { id: s.id, evidence_file_id: ev.id });
      }
      toast('Submission recorded');
      return s;
    },
  });
}

export async function approvalForm(existing, prefill = {}) {
  const cid = existing?.contract_id || prefill.contract_id || defaultContractId();
  const c = get('contracts', cid);
  const v = existing ? { ...existing, is_adjustment: !!existing.is_adjustment } : {
    contract_id: cid, approved_by: c?.approval_contact_name || '', approval_source: 'Email', approved_at: today(),
    period_start: today(), period_end: today(), ...prefill,
  };
  return formModal({
    title: existing ? 'Correct approved hours' : 'Record approved hours', wide: true, values: v,
    intro: h`<p class="note">Approved hours are entered manually from the client's approval. They are never inferred from logged time, timers or submissions.</p>`,
    fields: [
      contractField(),
      { name: 'period_start', label: 'Work date / period start', type: 'date', required: true },
      { name: 'period_end', label: 'Period end', type: 'date', required: true },
      { name: 'approved_hours', label: 'Approved hours', type: 'hours', required: true },
      { name: 'approved_at', label: 'Approved on', type: 'date' },
      { name: 'approved_by', label: 'Approved by' },
      { name: 'approval_source', label: 'Source', type: 'select', options: APPROVAL_SOURCES },
      { name: 'is_adjustment', label: 'This is an adjustment to an existing approval for the same period', type: 'checkbox', full: true },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
      ...(existing ? [] : [{ name: 'files', label: 'Attach approval evidence (email/chat screenshot)', type: 'file', multiple: true, accept: ACCEPT, full: true }]),
      { name: 'cmp', type: 'html', html: h`<div class="cmp-hint muted"></div>` },
    ],
    onInput: (val, form) => {
      if (!val.period_start || !val.period_end) return;
      const logged = C.sumMinutes(S.entries.filter(e => e.contract_id === val.contract_id && e.is_billable !== false && C.inRange(e.work_date, val.period_start, val.period_end)));
      const subs = S.submissions.filter(s => s.contract_id === val.contract_id && s.status !== 'Draft' && C.rangesOverlap(s.period_start, s.period_end, val.period_start, val.period_end));
      const sub = subs.reduce((a, s) => a + C.toCenti(s.submitted_hours), 0);
      form.querySelector('.cmp-hint').textContent = `Logged: ${C.fmtMinutesDec(logged)} · Submitted: ${C.fmtCenti(sub)} (for comparison only)`;
    },
    onSubmit: async val => {
      if (val.period_end < val.period_start) throw new Error('Period end is before start.');
      const centi = C.toCenti(val.approved_hours);
      if (Number.isNaN(centi) || centi < 0) throw new Error('Enter approved hours as a number, e.g. 4.5');
      const dup = S.approvals.find(a => a.id !== existing?.id && a.contract_id === val.contract_id && a.period_start === val.period_start && a.period_end === val.period_end);
      if (dup && !val.is_adjustment) throw new Error('An approval already exists for this contract and period. Edit it, or tick "adjustment" to add a separate adjustment.');
      const { files, ...rest } = val;
      rest.approved_hours = C.hundredthsToString(centi);
      let reason = '';
      if (existing) {
        reason = await askReason('Reason for correcting this approval', 'Reason (required, kept with the previous value)');
        if (!reason) return false;
        if (existing.approved_hours !== rest.approved_hours) {
          await save('approvalHistory', { approval_record_id: existing.id, previous_approved_hours: existing.approved_hours, new_approved_hours: rest.approved_hours, change_reason: reason, changed_at_utc: nowIso() }, { audit: false });
        }
      }
      const a = await save('approvals', { ...rest, id: existing?.id, approved_at_utc: rest.approved_at ? new Date(rest.approved_at + 'T12:00:00Z').toISOString() : null }, { reason });
      if (files?.length) await storeEvidenceFiles(files, { contract_id: val.contract_id, related_work_date: val.period_end, evidence_type: 'approval_email', approval_record_id: a.id, provided_by: 'client', description: 'Approval evidence — check content' });
      toast(existing ? 'Approval corrected' : 'Approved hours recorded');
      return a;
    },
  });
}

export async function planForm(existing, prefill = {}) {
  const cid = existing?.contract_id || prefill.contract_id || defaultContractId();
  return formModal({
    title: existing ? 'Edit pre-agreed schedule' : 'Pre-agreed hours (planned in advance)', values: existing || { contract_id: cid, date: today(), approved_by: get('contracts', cid)?.approval_contact_name || '', ...prefill },
    intro: h`<p class="note">For contracts that require hours to be agreed in advance. This is a plan, not approved worked time — it never counts towards earnings.</p>`,
    fields: [
      contractField(),
      { name: 'date', label: 'Date', type: 'date', required: true },
      { name: 'planned_hours', label: 'Hours agreed', type: 'hours', required: true },
      { name: 'approved_by', label: 'Agreed with' },
      { name: 'notes', label: 'Notes', type: 'textarea', full: true, rows: 2 },
    ],
    extraActions: existing ? h`<button class="btn danger ghost" type="button" data-del-plan>Delete</button>` : '',
    onMount: (el, form, close) => el.querySelector('[data-del-plan]')?.addEventListener('click', async () => {
      if (await confirmDialog('Delete this planned schedule?', { danger: true, ok: 'Delete' })) { await remove('plans', existing.id); close(); }
    }),
    onSubmit: async v => { const p = await save('plans', { ...v, id: existing?.id }); toast('Schedule saved'); return p; },
  });
}

// ---------- timer ----------

export const activeTimer = () => S.timers.find(t => t.status === 'running' || t.status === 'paused' || t.status === 'stopped');
export function timerElapsed(t, now = Date.now()) {
  if (!t) return 0;
  return (t.accumulated_seconds || 0) + (t.status === 'running' ? (now - Date.parse(t.last_resumed_at_utc)) / 1000 : 0);
}

export async function startTimer(task_id, contract_id) {
  const cur = activeTimer();
  if (cur) {
    const ok = await confirmDialog('Another timer is active. Stop it and save it as an entry first?', { ok: 'Stop & save it' });
    if (!ok) return null;
    await stopTimer(cur);
    const saved = await saveTimer(get('timers', cur.id));
    if (!saved) return null;
  }
  const t = await save('timers', { contract_id, task_id: task_id || null, status: 'running', started_at_utc: nowIso(), last_resumed_at_utc: nowIso(), accumulated_seconds: 0, notes: '' }, { audit: false });
  if (task_id) { const task = get('tasks', task_id); if (task && task.status === 'Assigned') await save('tasks', { id: task_id, status: 'In progress' }); }
  rememberContract(contract_id);
  return t;
}
export const pauseTimer = t => save('timers', { id: t.id, status: 'paused', paused_at_utc: nowIso(), accumulated_seconds: timerElapsed(t) }, { audit: false });
export const resumeTimer = t => save('timers', { id: t.id, status: 'running', last_resumed_at_utc: nowIso(), paused_at_utc: null }, { audit: false });
export const stopTimer = t => save('timers', { id: t.id, status: 'stopped', ended_at_utc: nowIso(), accumulated_seconds: timerElapsed(t) }, { audit: false });
export async function discardTimer(t) {
  if (!await confirmDialog(`Discard this timer (${C.fmtSeconds(timerElapsed(t))})? Nothing will be logged.`, { danger: true, ok: 'Discard' })) return false;
  await save('timers', { id: t.id, status: 'discarded', ended_at_utc: nowIso(), accumulated_seconds: timerElapsed(t) });
  toast('Timer discarded');
  return true;
}

// Timer → logged-time entry only. Elapsed excludes pauses: end = stop time, start = end − elapsed.
export async function saveTimer(t) {
  if (t.status !== 'stopped') t = await stopTimer(t);
  const tz = homeTz();
  const endMs = Date.parse(t.ended_at_utc);
  const mins = Math.max(1, Math.round(t.accumulated_seconds / 60));
  const startMs = endMs - mins * 60000;
  const start_at_utc = new Date(startMs).toISOString(), end_at_utc = new Date(endMs).toISOString();
  const saved = await entryForm(null, {
    contract_id: t.contract_id, task_id: t.task_id || '', work_date: dateIn(startMs, tz),
    start: timeIn(startMs, tz), end: timeIn(endMs, tz), crosses: dateIn(endMs, tz) !== dateIn(startMs, tz),
    source: 'timer', timer_session_id: t.id, start_at_utc, end_at_utc, activity_notes: t.notes || '',
  });
  if (!saved) return null;
  await save('timers', { id: t.id, status: 'saved', time_entry_id: saved.id }, { audit: false });
  if (saved.task_id) await afterTimerTaskPrompt(saved.task_id);
  return saved;
}

async function afterTimerTaskPrompt(taskId) {
  const task = get('tasks', taskId);
  if (!task) return;
  await formModal({
    title: 'Update task?', submitLabel: 'Update', values: { status: task.status },
    fields: [{ name: 'status', label: `Status of “${task.title}”`, type: 'select', options: TASK_STATUSES }],
    onSubmit: async v => { if (v.status !== task.status) await save('tasks', { id: task.id, status: v.status, ...(v.status === 'Completed' ? { completed_at: today() } : {}) }); },
  });
}

export { showField };
