import { S, get, save, today, settings, employerName, homeTz, contractLabel } from '../store.js';
import { h, mount, fieldHtml, table, download, toast, readForm, openDialog } from '../ui.js';
import * as C from '../calc.js';
import { REPORT_TYPES, buildReport, reportHtml, reportCsv, printHtml, defaultHeader } from '../report-render.js';
import { fmtDateTime } from '../tz.js';

const FILTERS = [['range', 'Custom range'], ['day', 'Single date'], ['week', 'Calendar week'], ['month', 'Calendar month'], ['period14', '14-day period'], ['fourteenth', '14th-of-month cycle'], ['ctd', 'Contract to date'], ['contract', 'Entire contract']];
let st = null;
let header = null, headerKey = '';
export const skipRerender = table => table === 'fx';

function initState(params) {
  const sel = settings().selection || {};
  st ||= { type: 'timesheet', scope: sel.contractId ? 'c:' + sel.contractId : sel.employerId ? 'e:' + sel.employerId : 'all', filter: 'month', date: today(), from: C.monthRange(today()).from, to: today() };
  if (params.get('contract')) { st.scope = 'c:' + params.get('contract'); st.filter = 'range'; st.from = params.get('from'); st.to = params.get('to'); history.replaceState(null, '', '#/reports'); }
}

const scopeObj = s => s === 'all' ? { kind: 'all' } : { kind: s[0] === 'c' ? 'contract' : 'employer', id: s.slice(2) };

function resolveRange(scope) {
  const d = st.date || today();
  const c = scope.kind === 'contract' ? get('contracts', scope.id) : null;
  switch (st.filter) {
    case 'day': return { from: d, to: d };
    case 'week': return C.weekRange(d);
    case 'month': return C.monthRange(d);
    case 'fourteenth': return C.fourteenthRange(d);
    case 'period14': {
      if (!c?.reporting_anchor_date) return { error: 'Pick a single contract with a 14-day anchor (set it on Approved Hours).' };
      const p = C.periodFor(c.reporting_anchor_date, d);
      return { from: p.from, to: p.to, label: `Period #${p.number}` };
    }
    case 'ctd': return c ? { from: c.start_date, to: today() } : { from: null, to: today() };
    case 'contract': return c ? { from: c.start_date, to: c.end_date } : { from: null, to: null };
    default: return { from: st.from || null, to: st.to || null };
  }
}

function scopeOptions() {
  return [['all', 'All employers'], ...S.employers.map(e => ({ group: employerName(e), options: [['e:' + e.id, `${employerName(e)} — all contracts`], ...S.contracts.filter(c => c.employer_id === e.id).map(c => ['c:' + c.id, `${c.title} (${c.currency})`])] }))];
}

const HEADER_FIELDS = [
  { name: 'client_name', label: 'Bill-to / client name' }, { name: 'client_contact', label: 'Client contact' },
  { name: 'client_address', label: 'Client address', type: 'textarea', rows: 3 }, { name: 'client_email', label: 'Client email' },
  { name: 'reference', label: 'Reference / PO number' }, { name: 'accent', label: 'Accent colour', type: 'color' },
  { name: 'freelancer_name', label: 'Freelancer name' }, { name: 'freelancer_email', label: 'Freelancer email' },
  { name: 'freelancer_address', label: 'Freelancer address', type: 'textarea', rows: 3 }, { name: 'freelancer_phone', label: 'Phone' },
  { name: 'freelancer_tax_id', label: 'Tax ID' },
];

export function render(el, params) {
  initState(params);
  const scope = scopeObj(st.scope);
  if (headerKey !== st.scope) { header = defaultHeader(scope); headerKey = st.scope; }
  const range = resolveRange(scope);
  const needsDate = ['day', 'week', 'month', 'period14', 'fourteenth'].includes(st.filter);
  const exports = S.exports.slice().sort((a, b) => b.generated_at_utc.localeCompare(a.generated_at_utc)).slice(0, 25);

  mount(el, h`<div class="grid side">
    <section class="panel">
      <div class="panel-head"><h2>Generate report</h2></div>
      <form class="form-grid" data-cfg onsubmit="return false">
        ${fieldHtml({ name: 'type', label: 'Report', type: 'select', options: REPORT_TYPES }, st.type)}
        ${fieldHtml({ name: 'scope', label: 'Scope', type: 'select', options: scopeOptions() }, st.scope)}
        ${fieldHtml({ name: 'filter', label: 'Period', type: 'select', options: FILTERS }, st.filter)}
        ${needsDate ? fieldHtml({ name: 'date', label: 'Containing date', type: 'date' }, st.date) : ''}
        ${st.filter === 'range' ? h`${fieldHtml({ name: 'from', label: 'From', type: 'date' }, st.from)}${fieldHtml({ name: 'to', label: 'To', type: 'date' }, st.to)}` : ''}
      </form>
      ${range.error ? h`<div class="warnbox mt">${range.error}</div>` : h`<p class="small muted mt">Covers ${range.label ? range.label + ': ' : ''}${range.from ? C.fmtDate(range.from) : 'start'} – ${range.to ? C.fmtDate(range.to) : 'present'}</p>`}
      <details class="mt"><summary><b>Report header</b> <span class="small muted">— pre-filled from employer & profile; edits apply to this export only</span></summary>
        <form class="form-grid mt" data-hdr onsubmit="return false" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr))">${HEADER_FIELDS.map(f => fieldHtml(f, header[f.name]))}</form>
        <button class="btn sm mt" data-reset-hdr>Reset from records</button>
      </details>
      <div class="btn-row mt">
        <button class="btn primary" data-go="pdf" ${range.error ? h`disabled` : ''}>Print / save PDF</button>
        <button class="btn" data-go="preview" ${range.error ? h`disabled` : ''}>Preview</button>
        <button class="btn" data-go="csv" ${range.error ? h`disabled` : ''}>CSV</button>
        <button class="btn" data-go="json" ${range.error ? h`disabled` : ''}>JSON</button>
      </div>
      <p class="small muted mt">In the print dialog choose “Save as PDF”. Pending/unapproved time is marked in every timesheet.</p>
    </section>
    <section class="panel"><div class="panel-head"><h2>Export history</h2></div>
      ${table([
        { label: 'Report', render: x => h`<b>${REPORT_TYPES.find(t => t[0] === x.report_type)?.[1]}</b><div class="small muted">${x.contract_id ? contractLabel(get('contracts', x.contract_id)) : x.employer_id ? employerName(get('employers', x.employer_id)) : 'All employers'} · ${x.filters_json.from ? C.fmtDate(x.filters_json.from) : 'start'} – ${x.filters_json.to ? C.fmtDate(x.filters_json.to) : 'present'}</div><div class="small muted">${fmtDateTime(x.generated_at_utc, homeTz())} · ${x.format}</div>` },
        { label: '', render: x => h`<button class="btn sm" data-regen="${x.id}">Re-run</button>` },
      ], exports, { empty: 'Exports are logged here with their filters and header snapshot.' })}
    </section></div>`);

  const cfg = el.querySelector('[data-cfg]'), hdr = el.querySelector('[data-hdr]');
  el.onchange = e => {
    if (cfg.contains(e.target)) {
      Object.assign(st, Object.fromEntries(new FormData(cfg)));
      render(el, new URLSearchParams());
    } else if (hdr.contains(e.target)) header = { ...header, ...readForm(hdr, HEADER_FIELDS) };
  };
  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if ('resetHdr' in b.dataset) { header = defaultHeader(scope); render(el, new URLSearchParams()); return; }
    if (b.dataset.regen) return regenerate(get('exports', b.dataset.regen));
    const fmt = b.dataset.go;
    if (!fmt) return;
    header = { ...header, ...readForm(hdr, HEADER_FIELDS) };
    await run(fmt, st.type, scope, range, header);
  };
}

async function run(fmt, type, scope, range, hd) {
  const r = buildReport({ type, scope, from: range.from, to: range.to });
  const name = `${r.title.replace(/[^\w]+/g, '-')}_${range.from || 'start'}_${range.to || 'now'}`;
  if (fmt === 'preview') {
    openDialog({ title: r.title, wide: true, body: h`<iframe class="preview-frame" style="height:70dvh" srcdoc="${reportHtml(r, hd)}" title="Report preview"></iframe>` });
    return;
  }
  if (fmt === 'pdf') printHtml(reportHtml(r, hd), name);
  if (fmt === 'csv') download(name + '.csv', reportCsv(r), 'text/csv;charset=utf-8');
  if (fmt === 'json') download(name + '.json', JSON.stringify({ ...r, header: hd }, null, 2), 'application/json');
  await save('exports', {
    report_type: type, format: fmt, employer_id: scope.kind === 'employer' ? scope.id : scope.kind === 'contract' ? get('contracts', scope.id)?.employer_id : null,
    contract_id: scope.kind === 'contract' ? scope.id : null, filters_json: { scope, from: range.from, to: range.to, filter: st.filter },
    header_snapshot_json: hd, generated_at_utc: r.generated_at_utc, file_path: name + (fmt === 'pdf' ? '.pdf' : '.' + fmt),
  }, { audit: false });
  if (fmt !== 'pdf') toast('Exported ' + fmt.toUpperCase());
}

// Re-run with the exact filters and header snapshot that were used originally.
function regenerate(x) {
  const r = buildReport({ type: x.report_type, scope: x.filters_json.scope, from: x.filters_json.from, to: x.filters_json.to });
  openDialog({ title: `${r.title} (re-run with original header)`, wide: true, body: h`<iframe class="preview-frame" style="height:70dvh" srcdoc="${reportHtml(r, x.header_snapshot_json)}" title="Report preview"></iframe>`,
    actions: h`<button class="btn primary" data-p>Print / save PDF</button>`, onMount: d => { d.querySelector('[data-p]').onclick = () => { d.close(); printHtml(reportHtml(r, x.header_snapshot_json), r.title); }; } });
}
