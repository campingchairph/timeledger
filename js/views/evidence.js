import { S, get, save, remove, getBlob, scopeContractIds, contractLabel, homeTz } from '../store.js';
import { h, mount, empty, badge, openDialog, formModal, download, confirmDialog, askReason, toast } from '../ui.js';
import * as C from '../calc.js';
import * as A from '../actions.js';
import * as M from '../metrics.js';
import { fmtDateTime } from '../tz.js';

let type = '', from = '', to = '', q = '';
const ext = n => (n.split('.').pop() || 'file').slice(0, 4).toUpperCase();
const size = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

export function render(el) {
  const cids = scopeContractIds();
  let files = S.evidence.filter(f => !f.contract_id || cids.has(f.contract_id));
  if (type) files = files.filter(f => f.evidence_type === type);
  if (from) files = files.filter(f => (f.related_work_date || '') >= from);
  if (to) files = files.filter(f => (f.related_work_date || '') <= to);
  if (q) { const s = q.toLowerCase(); files = files.filter(f => `${f.original_filename} ${f.description} ${f.source_person}`.toLowerCase().includes(s)); }
  files.sort((a, b) => (b.related_work_date || '').localeCompare(a.related_work_date || '') || b.uploaded_at_utc.localeCompare(a.uploaded_at_utc));

  // Completeness for the last 14 days that have logged work.
  const days = [...new Set(S.entries.filter(e => cids.has(e.contract_id)).map(e => `${e.work_date}|${e.contract_id}`))]
    .sort().reverse().slice(0, 14).map(k => k.split('|'));

  mount(el, h`<div class="grid side">
    <section class="panel">
      <div class="panel-head"><h2>Evidence vault</h2><button class="btn primary" data-up>Upload</button></div>
      <div class="toolbar">
        <label class="field"><span>Type</span><select data-type><option value="">All types</option>${A.EVIDENCE_TYPES.map(([k, l]) => h`<option value="${k}" ${k === type ? h`selected` : ''}>${l}</option>`)}</select></label>
        <label class="field"><span>From</span><input type="date" data-from value="${from}"></label>
        <label class="field"><span>To</span><input type="date" data-to value="${to}"></label>
        <label class="field"><span>Search</span><input type="search" data-q value="${q}"></label>
      </div>
      ${files.length ? h`<div class="ev-grid">${files.slice(0, 300).map(f => h`<button class="ev" data-open="${f.id}">
          <div class="ev-thumb" ${f.thumb ? h`style="background-image:url('${f.thumb}')"` : ''}>${f.thumb ? '' : ext(f.original_filename)}</div>
          <div class="ev-body"><div class="ev-name">${f.original_filename}</div>
            <div class="muted">${f.related_work_date ? C.fmtDate(f.related_work_date) : 'No date'} · ${size(f.file_size)}</div>
            <div>${f.contains_approval ? badge('Approval evidence', 'ok') : ''}${f.is_annotated_copy ? badge('Annotated copy', 'warn') : ''}${f.provided_by === 'client' ? badge('Client-provided', 'accent') : ''}</div>
          </div></button>`)}</div>
        ${files.length > 300 ? h`<p class="small muted mt">Showing 300 of ${files.length}. Narrow the filters to see more.</p>` : ''}`
      : empty('No evidence yet. Add screenshots of work, briefs, approvals and remittances as you go.', h`<button class="btn primary" data-up>Upload</button>`)}
    </section>
    <section class="panel">
      <div class="panel-head"><h2>Completeness by workday</h2></div>
      <p class="note">An organisational aid showing what supporting documentation you have — not a legal proof score.</p>
      ${days.length ? h`<div class="list">${days.map(([d, cid]) => {
        const c = M.completeness(cid, d);
        return h`<div class="item"><div class="item-main"><div class="item-title"><a href="#/journal?date=${d}">${C.fmtDate(d)}</a></div>
          <div class="item-meta"><span>${contractLabel(get('contracts', cid))}</span></div>
          <div class="small">${c.items.map(([l, ok]) => h`<span class="nowrap"><span class="dot ${ok ? 'ok' : 'no'}"></span>${l}</span> `)}</div></div>
          <div class="item-side">${badge(`${c.score}/${c.total}`, c.score === c.total ? 'ok' : c.score >= 3 ? 'accent' : 'warn')}</div></div>`;
      })}</div>` : empty('Log some work to see completeness.')}
    </section></div>`);

  el.onclick = e => {
    const b = e.target.closest('[data-up],[data-open]');
    if (!b) return;
    if ('up' in b.dataset) A.uploadEvidence();
    else detail(get('evidence', b.dataset.open));
  };
  el.onchange = e => {
    const d = e.target.dataset;
    if ('type' in d) type = e.target.value; else if ('from' in d) from = e.target.value; else if ('to' in d) to = e.target.value; else return;
    render(el);
  };
  el.oninput = e => { if ('q' in e.target.dataset) { q = e.target.value; clearTimeout(el._qt); el._qt = setTimeout(() => { render(el); const i = el.querySelector('[data-q]'); i.focus(); i.setSelectionRange(q.length, q.length); }, 200); } };
}

export async function detail(f) {
  const blob = await getBlob(f.id);
  const url = blob ? URL.createObjectURL(blob) : null;
  const tz = homeTz();
  const isImg = f.mime_type.startsWith('image/'), isPdf = f.mime_type === 'application/pdf';
  const copies = S.evidence.filter(x => x.original_id === f.id);
  const { el } = openDialog({
    title: f.original_filename, wide: true,
    body: h`${!url ? h`<div class="badbox">The stored file could not be found.</div>` : isImg ? h`<img class="preview-img" src="${url}" alt="">` : isPdf ? h`<iframe class="preview-frame" src="${url}" title="PDF preview"></iframe>` : h`<div class="note">No inline preview for this file type — download to open it.</div>`}
      <dl class="kv mt">
        <dt>Type</dt><dd>${A.evidenceTypeLabel(f.evidence_type)} ${f.contains_approval ? badge('Contains approval communication', 'ok') : ''}</dd>
        <dt>Contract</dt><dd>${f.contract_id ? contractLabel(get('contracts', f.contract_id)) : '—'}</dd>
        <dt>Work date</dt><dd>${C.fmtDate(f.related_work_date) || '—'}</dd>
        ${f.task_id ? h`<dt>Task</dt><dd>${get('tasks', f.task_id)?.title || '—'}</dd>` : ''}
        ${f.time_entry_id ? h`<dt>Time entry</dt><dd>${(() => { const e = get('entries', f.time_entry_id); return e ? `${C.fmtDate(e.work_date)} · ${C.fmtMinutesDec(e.duration_minutes)} · ${e.activity_notes}` : '—'; })()}</dd>` : ''}
        ${f.approval_record_id ? h`<dt>Approval</dt><dd>${(() => { const a = get('approvals', f.approval_record_id); return a ? `${C.fmtDate(a.period_start)}–${C.fmtDate(a.period_end)} · ${a.approved_hours} h` : '—'; })()}</dd>` : ''}
        <dt>Provided by</dt><dd>${f.provided_by === 'client' ? 'Client' : 'Me'}${f.source_person ? ' · ' + f.source_person : ''}</dd>
        ${f.description ? h`<dt>Description</dt><dd class="pre">${f.description}</dd>` : ''}
        <dt>Size</dt><dd>${size(f.file_size)} · ${f.mime_type}</dd>
        <dt>Uploaded</dt><dd>${fmtDateTime(f.uploaded_at_utc, tz)}</dd>
        <dt>SHA-256</dt><dd class="hash">${f.sha256 || 'not available (insecure context)'}</dd>
        ${f.is_annotated_copy ? h`<dt>Copy of</dt><dd>${get('evidence', f.original_id)?.original_filename || 'original'}</dd>` : ''}
        ${copies.length ? h`<dt>Annotated copies</dt><dd>${copies.map(c => c.original_filename).join(', ')}</dd>` : ''}
      </dl>`,
    actions: h`<button class="btn danger ghost" data-del>Delete</button><span class="grow"></span><button class="btn" data-copy>Add annotated copy</button><button class="btn" data-meta>Edit details</button>${url ? h`<button class="btn primary" data-dl>Download original</button>` : ''}`,
  });
  el.addEventListener('close', () => url && URL.revokeObjectURL(url));
  el.querySelector('[data-dl]')?.addEventListener('click', () => download(f.original_filename, blob));
  el.querySelector('[data-meta]').onclick = async () => {
    el.close();
    await formModal({
      title: 'Edit evidence details', wide: true, fields: A.evidenceFields({ withFile: false }), values: f,
      intro: h`<p class="note">Only the description and links change — the stored original file is never modified.</p>`,
      onSubmit: async v => { for (const k of ['task_id', 'time_entry_id', 'approval_record_id']) v[k] ||= null; await save('evidence', { ...v, id: f.id }); toast('Details updated'); },
    });
  };
  el.querySelector('[data-copy]').onclick = () => { el.close(); A.uploadEvidence({ contract_id: f.contract_id, related_work_date: f.related_work_date, evidence_type: f.evidence_type, task_id: f.task_id || '', is_annotated_copy: true, original_id: f.id }); };
  el.querySelector('[data-del]').onclick = async () => {
    if (!await confirmDialog(`Permanently delete “${f.original_filename}”? The original file will be removed from this device.`, { danger: true, ok: 'Delete' })) return;
    const reason = await askReason('Reason for deleting this evidence');
    if (!reason) return;
    el.close();
    await remove('evidence', f.id, { reason });
    toast('Evidence deleted');
  };
}
