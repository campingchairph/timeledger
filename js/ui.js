// Tiny UI toolkit: escaped HTML templates, dialogs, a declarative form builder and toasts.

import { S, get, contractLabel, pickableContracts, employerName } from './store.js';
import { fmtMoney } from './calc.js';

// ---------- templating ----------

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
const part = v => v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v);
export function h(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}
export const mount = (el, tpl) => { el.innerHTML = tpl.s ?? tpl; return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- icons (inline SVG, inherit currentColor) ----------

const ICONS = {
  clip: 'M21 11l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4L15.5 7',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  play: 'M7 4.5v15l12-7.5z',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  check: 'M5 12.5l4.5 4.5L19 7',
};
export const icon = name => raw(`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`);

// ---------- small renderers ----------

export const badge = (text, kind = '') => h`<span class="badge ${kind}">${text}</span>`;
export function moneyList(bucket, empty = '—') {
  const e = Object.entries(bucket).filter(([, v]) => v !== 0);
  if (!e.length) return h`<span class="muted">${empty}</span>`;
  return h`${e.map(([c, v], i) => h`${i ? h`<br>` : ''}<span class="money">${fmtMoney(v, c)}</span>`)}`;
}
export function card(label, value, sub = '', cls = '') {
  return h`<div class="stat ${cls}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? h`<div class="stat-sub">${sub}</div>` : ''}</div>`;
}
export function table(cols, rows, { empty = 'Nothing here yet.', foot } = {}) {
  if (!rows.length) return h`<div class="empty">${empty}</div>`;
  return h`<div class="table-wrap"><table><thead><tr>${cols.map(c => h`<th class="${c.cls || ''}">${c.label}</th>`)}</tr></thead>
    <tbody>${rows.map(r => h`<tr>${cols.map(c => h`<td class="${c.cls || ''}" data-label="${c.label}">${c.render(r)}</td>`)}</tr>`)}</tbody>
    ${foot ? h`<tfoot>${foot}</tfoot>` : ''}</table></div>`;
}
export const empty = (msg, action = '') => h`<div class="empty">${msg}${action ? h`<div class="mt">${action}</div>` : ''}</div>`;

// ---------- option helpers ----------

export function contractOptions({ includeArchived = false } = {}) {
  const list = includeArchived ? S.contracts : pickableContracts();
  const groups = new Map();
  for (const c of list) {
    const e = get('employers', c.employer_id);
    if (!groups.has(e?.id)) groups.set(e?.id, { group: employerName(e), options: [] });
    groups.get(e?.id).options.push([c.id, `${c.title} (${c.currency})`]);
  }
  return [...groups.values()];
}
export function taskOptions(contractId, { blank = '— none —' } = {}) {
  return [['', blank], ...S.tasks.filter(t => !contractId || t.contract_id === contractId)
    .sort((a, b) => (a.status === 'Completed') - (b.status === 'Completed') || a.title.localeCompare(b.title))
    .map(t => [t.id, (t.status === 'Completed' ? '✓ ' : '') + t.title])];
}
export const contractName = id => contractLabel(get('contracts', id));

// ---------- dialogs ----------

export function openDialog({ title, body, wide = false, onMount, actions }) {
  const d = document.createElement('dialog');
  d.className = 'sheet' + (wide ? ' wide' : '');
  mount(d, h`<div class="sheet-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div>
    <div class="sheet-body">${body}</div>${actions ? h`<div class="sheet-foot">${actions}</div>` : ''}`);
  document.body.append(d);
  const close = () => { d.close(); };
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-close]')) close(); });
  d.showModal();
  onMount?.(d, close);
  return { el: d, close };
}

export function confirmDialog(message, { title = 'Please confirm', ok = 'Confirm', danger = false, typeToConfirm } = {}) {
  return new Promise(resolve => {
    let result = false;
    const { el, close } = openDialog({
      title,
      body: h`<p class="pre">${message}</p>${typeToConfirm ? h`<label class="field"><span>Type <b>${typeToConfirm}</b> to confirm</span><input data-typed autocomplete="off"></label>` : ''}`,
      actions: h`<button class="btn ghost" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${ok}</button>`,
    });
    el.querySelector('[data-ok]').onclick = () => {
      if (typeToConfirm && el.querySelector('[data-typed]').value.trim() !== typeToConfirm) { toast('Text does not match', 'warn'); return; }
      result = true; close();
    };
    el.addEventListener('close', () => resolve(result));
  });
}

export async function askReason(title, label = 'Reason for this change') {
  const r = await formModal({ title, submitLabel: 'Continue', fields: [{ name: 'reason', label, type: 'textarea', required: true }] });
  return r?.reason?.trim() || null;
}

// ---------- forms ----------

function optionsHtml(opts, value) {
  return (opts || []).map(o => {
    if (o && o.group) return h`<optgroup label="${o.group}">${optionsHtml(o.options, value)}</optgroup>`;
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return h`<option value="${v}" ${String(v) === String(value ?? '') ? raw('selected') : ''}>${l}</option>`;
  });
}

export function fieldHtml(f, v) {
  const id = 'f_' + f.name;
  const req = f.required ? raw('required') : '';
  const attrs = raw(Object.entries(f.attrs || {}).map(([k, val]) => `${k}="${esc(val)}"`).join(' '));
  let input;
  switch (f.type) {
    case 'textarea': input = h`<textarea id="${id}" name="${f.name}" rows="${f.rows || 3}" ${req} ${attrs} placeholder="${f.placeholder || ''}">${v ?? ''}</textarea>`; break;
    case 'select': input = h`<select id="${id}" name="${f.name}" ${req} ${attrs}>${optionsHtml(f.options, v)}</select>`; break;
    case 'checkbox': return h`<label class="check ${f.full ? 'full' : ''}" data-field="${f.name}"><input type="checkbox" name="${f.name}" ${v ? raw('checked') : ''} ${attrs}><span>${f.label}</span>${f.hint ? h`<small>${f.hint}</small>` : ''}</label>`;
    case 'file': input = h`<input id="${id}" type="file" name="${f.name}" ${f.multiple ? raw('multiple') : ''} accept="${f.accept || ''}" ${req} ${attrs}>`; break;
    case 'html': return h`<div class="full" data-field="${f.name}">${f.html}</div>`;
    case 'money': input = h`<input id="${id}" name="${f.name}" inputmode="decimal" pattern="-?[0-9,]*\\.?[0-9]{0,2}" value="${v ?? ''}" ${req} ${attrs} placeholder="0.00">`; break;
    case 'hours': input = h`<input id="${id}" name="${f.name}" inputmode="decimal" pattern="[0-9]*\\.?[0-9]{0,2}" value="${v ?? ''}" ${req} ${attrs} placeholder="0.00">`; break;
    default: input = h`<input id="${id}" type="${f.type || 'text'}" name="${f.name}" value="${v ?? ''}" ${req} ${attrs} ${f.list ? raw(`list="${esc(f.list)}"`) : ''} placeholder="${f.placeholder || ''}" ${f.step ? raw(`step="${esc(f.step)}"`) : ''}>`;
  }
  return h`<label class="field ${f.full ? 'full' : ''}" data-field="${f.name}" for="${id}"><span>${f.label}${f.required ? h` <i class="req">*</i>` : ''}</span>${input}${f.hint ? h`<small>${f.hint}</small>` : ''}</label>`;
}

export function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    const el = form.elements[f.name];
    if (!el || f.type === 'html') continue;
    if (f.type === 'checkbox') out[f.name] = el.checked;
    else if (f.type === 'file') out[f.name] = [...el.files];
    else out[f.name] = typeof el.value === 'string' ? el.value.trim() : el.value;
  }
  return out;
}

// Opens a form; resolves with onSubmit's return (or the values), or null when cancelled.
// onSubmit may throw an Error to show an inline message and keep the sheet open.
export function formModal({ title, fields, values = {}, submitLabel = 'Save', onSubmit, onInput, onMount, wide, extraActions, intro }) {
  return new Promise(resolve => {
    let settled = false;
    const { el, close } = openDialog({
      title, wide,
      body: h`${intro || ''}<form class="form-grid" novalidate>${fields.map(f => fieldHtml(f, values[f.name]))}<p class="form-error full" hidden></p><button hidden></button></form>`,
      actions: h`${extraActions || ''}<span class="grow"></span><button class="btn ghost" data-close type="button">Cancel</button><button class="btn primary" data-submit type="button">${submitLabel}</button>`,
    });
    const form = el.querySelector('form'), err = el.querySelector('.form-error'), btn = el.querySelector('[data-submit]');
    const submit = async () => {
      if (!form.reportValidity()) return;
      err.hidden = true; btn.disabled = true;
      try {
        const vals = readForm(form, fields);
        const res = onSubmit ? await onSubmit(vals, form) : vals;
        if (res === false) return;
        settled = true; resolve(res ?? vals); close();
      } catch (e) { err.textContent = e.message; err.hidden = false; err.scrollIntoView({ block: 'nearest' }); }
      finally { btn.disabled = false; }
    };
    btn.onclick = submit;
    form.addEventListener('submit', e => { e.preventDefault(); submit(); });
    if (onInput) { const fire = () => onInput(readForm(form, fields), form); form.addEventListener('input', fire); form.addEventListener('change', fire); fire(); }
    onMount?.(el, form, close);
    el.addEventListener('close', () => { if (!settled) resolve(null); });
    form.querySelector('input:not([type=hidden]):not([type=checkbox]),textarea,select')?.focus({ preventScroll: true });
  });
}

export const showField = (form, name, show) => { const n = form.querySelector(`[data-field="${name}"]`); if (n) n.hidden = !show; };

// ---------- toasts ----------

let toastBox;
export function toast(msg, kind = 'ok', ms = 3200) {
  toastBox ||= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts', role: 'status' });
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  toastBox.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- files ----------

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function imageToDataUrl(file, max = 320, type = 'image/jpeg', q = 0.75) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * s), height: Math.round(bmp.height * s) });
  const g = c.getContext('2d');
  if (type === 'image/jpeg') { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL(type, q);
}
