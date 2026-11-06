import { S, get, save, profile, settings, updateSettings, homeTz, contractLabel } from '../store.js';
import * as db from '../db.js';
import { h, mount, fieldHtml, readForm, toast, download, confirmDialog, imageToDataUrl, table, badge, openDialog } from '../ui.js';
import * as C from '../calc.js';
import { allZones, allCurrencies, fmtDateTime } from '../tz.js';
import { PROVIDERS, refreshAll } from '../fx.js';

let auditFilter = '';
export const skipRerender = table => table === 'fx';

const PROFILE_FIELDS = [
  { name: 'full_name', label: 'Full name', required: true }, { name: 'display_name', label: 'Display name' },
  { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone' },
  { name: 'address', label: 'Address', type: 'textarea', rows: 3, full: true }, { name: 'tax_id', label: 'Tax ID (optional)' },
  { name: 'home_currency', label: 'Home currency', type: 'select', options: [] }, { name: 'home_timezone', label: 'Home timezone', type: 'select', options: [] },
  { name: 'limit_hours', label: 'Personal daily availability limit (hours)', type: 'hours', hint: 'Applies across all employers combined. A personal boundary, not guaranteed work.' },
  { name: 'logo_file', label: 'Signature / logo for reports (optional)', type: 'file', accept: 'image/*' },
];

export function render(el) {
  const p = profile() || {};
  const fx = settings().fx || {};
  PROFILE_FIELDS[6].options = allCurrencies(); PROFILE_FIELDS[7].options = allZones();
  const vals = { ...p, limit_hours: C.hundredthsToString(C.minutesToCenti(p.daily_availability_limit_minutes || 360)) };
  const audit = S.audit.filter(a => !auditFilter || a.entity_type === auditFilter).slice(-150).reverse();
  const types = [...new Set(S.audit.map(a => a.entity_type))].sort();
  const counts = Object.fromEntries(db.TABLES.filter(t => !['meta', 'audit', 'fx'].includes(t)).map(t => [t, S[t].length]));

  mount(el, h`<div class="grid two">
    <section class="panel"><div class="panel-head"><h2>Freelancer profile</h2></div>
      <p class="note">Used in report and invoice headers. No bank credentials are ever stored.</p>
      <form class="form-grid" data-profile onsubmit="return false" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">${PROFILE_FIELDS.map(f => fieldHtml(f, vals[f.name]))}</form>
      ${p.logo ? h`<p class="mt"><img class="logo-prev" src="${p.logo}" alt="Logo"> <button class="btn sm ghost" data-rmlogo>Remove</button></p>` : ''}
      <button class="btn primary mt" data-save-profile>Save profile</button>
    </section>
    <div>
      <section class="panel"><div class="panel-head"><h2>Backups</h2></div>
        <p class="note">All data lives in this browser's private storage on this device (IndexedDB). Export a full backup regularly and keep it somewhere safe — clearing site data or losing the device loses unsynced records.</p>
        <div class="btn-row"><button class="btn primary" data-backup>Download full backup (incl. evidence files)</button><button class="btn" data-backup-lite>Backup without files</button></div>
        <div class="btn-row mt"><label class="btn">Restore from backup…<input type="file" accept="application/json,.json" data-restore hidden></label><button class="btn" data-csv>Export time entries CSV</button></div>
        <p class="small muted mt">Last backup: ${settings().lastBackupAt ? fmtDateTime(settings().lastBackupAt, homeTz()) : 'never'} · ${Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ')}</p>
        <p class="small muted" data-storage></p>
      </section>
      <section class="panel"><div class="panel-head"><h2>Exchange rates</h2></div>
        <form class="form-grid" data-fx onsubmit="return false">
          ${fieldHtml({ name: 'provider', label: 'Provider', type: 'select', options: [['auto', 'Automatic (try each)'], ...Object.entries(PROVIDERS).map(([k, v]) => [k, v.name])] }, fx.provider || 'auto')}
          ${fieldHtml({ name: 'refreshMinutes', label: 'Refresh every (minutes)', type: 'select', options: [15, 30, 45, 60] }, fx.refreshMinutes || 30)}
        </form>
        <p class="small muted mt">Rates are used only for ${p.home_currency || 'home-currency'} estimates. Manual overrides are set on the Salary page.</p>
      </section>
    </div></div>
    <section class="panel"><div class="panel-head"><h2>Audit history</h2>
      <select data-audit style="width:auto"><option value="">All entities</option>${types.map(t => h`<option ${t === auditFilter ? h`selected` : ''}>${t}</option>`)}</select></div>
      <div class="table-wrap stack">${table([
        { label: 'When', render: a => fmtDateTime(a.occurred_at_utc, homeTz()) },
        { label: 'Entity', render: a => h`${a.entity_type} ${badge(a.action, a.action === 'delete' ? 'bad' : a.action === 'create' ? 'ok' : '')}` },
        { label: 'Record', render: a => { const v = a.new_value_json || a.old_value_json || {}; return v.title || v.legal_name || v.original_filename || v.invoice_number || (v.activity_notes || '').slice(0, 50) || (v.contract_id ? contractLabel(get('contracts', v.contract_id)) : a.entity_id.slice(0, 8)); } },
        { label: 'Reason', render: a => a.reason || '' },
        { label: '', render: a => h`<button class="btn sm ghost" data-diff="${a.id}">Changes</button>` },
      ], audit, { empty: 'No audit entries.' })}</div>
    </section>`);

  navigator.storage?.estimate?.().then(async est => {
    const persisted = await navigator.storage.persisted?.();
    const n = el.querySelector('[data-storage]');
    if (n) n.textContent = `Storage used ≈ ${(est.usage / 1048576).toFixed(1)} MB · ${persisted ? 'persistent (protected from automatic clearing)' : 'not marked persistent'}`;
  });

  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    if ('saveProfile' in d) {
      const form = el.querySelector('[data-profile]');
      if (!form.reportValidity()) return;
      const v = readForm(form, PROFILE_FIELDS);
      const { logo_file, limit_hours, ...rest } = v;
      const mins = C.centiToMinutes(C.toCenti(limit_hours || 6));
      if (!(mins > 0)) return toast('Enter a daily limit in hours', 'warn');
      rest.daily_availability_limit_minutes = mins;
      if (logo_file?.length) rest.logo = await imageToDataUrl(logo_file[0], 300, 'image/png');
      await save('profile', { ...rest, id: 'me' });
      refreshAll().catch(() => {});
      toast('Profile saved');
    } else if ('rmlogo' in d) await save('profile', { id: 'me', logo: '' });
    else if ('backup' in d) backup(true);
    else if ('backupLite' in d) backup(false);
    else if ('csv' in d) entriesCsv();
    else if (d.diff) {
      const a = S.audit.find(x => x.id === d.diff);
      const changed = diff(a.old_value_json, a.new_value_json);
      openDialog({ title: `${a.entity_type} · ${a.action}`, wide: true, body: h`${a.reason ? h`<p><b>Reason:</b> ${a.reason}</p>` : ''}${table([
        { label: 'Field', render: r => r.k }, { label: 'Before', render: r => h`<div class="audit-diff">${r.a}</div>` }, { label: 'After', render: r => h`<div class="audit-diff">${r.b}</div>` },
      ], changed, { empty: 'No field changes recorded.' })}` });
    }
  };
  el.onchange = async e => {
    if ('restore' in e.target.dataset && e.target.files[0]) return restore(e.target.files[0]);
    if (e.target.closest('[data-fx]')) {
      const f = new FormData(el.querySelector('[data-fx]'));
      await updateSettings({ fx: { ...settings().fx, provider: f.get('provider'), refreshMinutes: +f.get('refreshMinutes') } });
      refreshAll(true).catch(() => {});
      toast('Exchange-rate settings saved');
    }
    if ('audit' in e.target.dataset) { auditFilter = e.target.value; render(el); }
  };
}

function diff(a, b) {
  const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !['updated_at', 'created_at'].includes(k));
  const s = v => v == null ? '' : typeof v === 'object' ? JSON.stringify(v, null, 1) : String(v);
  return keys.filter(k => s(a?.[k]) !== s(b?.[k])).map(k => ({ k, a: s(a?.[k]), b: s(b?.[k]) }));
}

const blobToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

async function backup(withFiles) {
  toast('Preparing backup…');
  const data = await db.loadAll();
  data.blobs = [];
  if (withFiles) for (const row of await db.getAll(db.BLOBS)) data.blobs.push({ id: row.id, data_url: await blobToB64(row.blob) });
  const out = { app: 'TimeLedger', schema: 1, exported_at_utc: new Date().toISOString(), includes_files: withFiles, data };
  download(`timeledger-backup-${new Date().toISOString().slice(0, 10)}${withFiles ? '' : '-nofiles'}.json`, JSON.stringify(out), 'application/json');
  await updateSettings({ lastBackupAt: new Date().toISOString() });
}

async function restore(file) {
  let json;
  try { json = JSON.parse(await file.text()); } catch { return toast('That file is not valid JSON', 'bad'); }
  if (json?.app !== 'TimeLedger' || !json.data) return toast('Not a TimeLedger backup file', 'bad');
  const n = Object.values(json.data).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0);
  if (!await confirmDialog(`Restore backup from ${json.exported_at_utc}?\n\nThis REPLACES everything currently on this device with ${n} records from the backup${json.includes_files ? '' : ' (no evidence files included)'}. Download a backup of the current data first if unsure.`, { danger: true, ok: 'Replace & restore', typeToConfirm: 'RESTORE' })) return;
  const data = { ...json.data };
  data.blobs = await Promise.all((json.data.blobs || []).map(async b => ({ id: b.id, blob: await (await fetch(b.data_url)).blob() })));
  await db.replaceAll(data);
  toast('Restored — reloading');
  setTimeout(() => location.reload(), 600);
}

function entriesCsv() {
  const tz = homeTz();
  const rows = [['Date', 'Employer · Contract', 'Start (UTC)', 'End (UTC)', 'Timezone', 'Minutes', 'Hours', 'Task', 'Category', 'Activity', 'Deliverable', 'Billable', 'Source']];
  for (const e of S.entries.slice().sort((a, b) => a.start_at_utc.localeCompare(b.start_at_utc))) {
    rows.push([e.work_date, contractLabel(get('contracts', e.contract_id)), e.start_at_utc, e.end_at_utc, e.timezone || tz, e.duration_minutes, C.hundredthsToString(C.minutesToCenti(e.duration_minutes)), get('tasks', e.task_id)?.title || '', e.category || '', e.activity_notes || '', e.deliverable_notes || '', e.is_billable === false ? 'no' : 'yes', e.source || '']);
  }
  const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  download(`timeledger-entries-${new Date().toISOString().slice(0, 10)}.csv`, '﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
}
