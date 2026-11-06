import { S, get, today, defaultContractId, homeCurrency, homeTz, contractRates } from '../store.js';
import { h, mount, fieldHtml, contractOptions, toast } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import { rateFor } from '../fx.js';
import { fmtDateTime } from '../tz.js';

let expr = '', last = '', cid = null, mode = 'hours', inputs = {};
const MODES = [['hours', 'Hours → contract currency'], ['toHome', 'Contract currency → home'], ['fromHome', 'Home → contract currency'], ['gap', 'Logged vs approved gap'], ['invoice', 'Invoice estimate'], ['duration', 'Time duration']];
const KEYS = ['C', '(', ')', '÷', '7', '8', '9', '×', '4', '5', '6', '−', '1', '2', '3', '+', '0', '.', '⌫', '='];

export const skipRerender = () => true; // self-contained; never re-render on store writes

function quick() {
  const c = get('contracts', cid);
  if (!c) return h`<p class="muted">Add a contract to use quick modes.</p>`;
  const home = homeCurrency();
  const rate = C.rateOn(S.rates, c.id, today()) || contractRates(c.id).at(-1);
  const rMinor = rate ? C.toMinor(rate.hourly_rate) : 0;
  const fx = rateFor(c.currency, home);
  const fxNote = fx.same ? '' : fx.rate ? `1 ${c.currency} = ${fx.rate.toFixed(4)} ${home} · ${fx.provider} · ${fmtDateTime(fx.fetched_at_utc, homeTz())}${fx.stale ? ' (stale)' : ''}` : 'No exchange rate available';
  const v = k => inputs[k] ?? '';
  let fields = [], result = '';
  switch (mode) {
    case 'hours': {
      fields = [{ name: 'h', label: 'Hours', type: 'hours' }];
      const cent = C.toCenti(v('h') || 0);
      result = `${C.fmtCenti(cent)} × ${C.fmtMoney(rMinor, c.currency)} = ${C.fmtMoney(Math.round(cent * rMinor / 100), c.currency)}`;
      break;
    }
    case 'toHome': {
      fields = [{ name: 'a', label: `Amount (${c.currency})`, type: 'money' }];
      const m = C.toMinor(v('a') || 0);
      result = fx.rate ? `≈ ${C.fmtMoney(C.convertMinor(m, fx.rate), home)}` : 'No rate';
      break;
    }
    case 'fromHome': {
      fields = [{ name: 'a', label: `Amount (${home})`, type: 'money' }];
      const m = C.toMinor(v('a') || 0);
      result = fx.rate ? `≈ ${C.fmtMoney(Math.round(m / fx.rate), c.currency)}` : 'No rate';
      break;
    }
    case 'gap': {
      fields = [{ name: 'from', label: 'From', type: 'date' }, { name: 'to', label: 'To', type: 'date' }];
      const one = new Set([c.id]);
      const lg = M.loggedMinutes(M.entriesIn(one, v('from') || null, v('to') || null));
      const ap = M.earnings(M.approvalsIn(one, v('from') || null, v('to') || null));
      result = `Logged ${C.fmtMinutesDec(lg)} · Approved ${C.fmtCenti(ap.centi)} · Gap ${C.fmtCenti(C.minutesToCenti(lg) - ap.centi)} (≈ ${C.fmtMoney(Math.round((C.minutesToCenti(lg) - ap.centi) * rMinor / 100), c.currency)} not payable unless approved)`;
      break;
    }
    case 'invoice': {
      fields = [{ name: 'h', label: 'Approved hours', type: 'hours' }, { name: 'adj', label: 'Adjustment (+/−)', type: 'money' }];
      const t = Math.round(C.toCenti(v('h') || 0) * rMinor / 100) + (C.toMinor(v('adj') || 0) || 0);
      result = `Invoice total ${C.fmtMoney(t, c.currency)}${fx.rate && !fx.same ? ` · ≈ ${C.fmtMoney(C.convertMinor(t, fx.rate), home)}` : ''}${c.payment_terms_working_days ? ` · due ≈ ${C.fmtDate(C.addWorkingDays(today(), c.payment_terms_working_days))} if sent today` : ''}`;
      break;
    }
    case 'duration': {
      fields = [{ name: 's', label: 'Start', type: 'time' }, { name: 'e', label: 'End', type: 'time' }, { name: 'brk', label: 'Break (minutes)', type: 'number' }];
      if (v('s') && v('e')) {
        let m = (+v('e').slice(0, 2) * 60 + +v('e').slice(3)) - (+v('s').slice(0, 2) * 60 + +v('s').slice(3));
        if (m < 0) m += 1440;
        m -= +v('brk') || 0;
        result = `${C.fmtMinutesDec(m)} (${C.fmtHM(m)})`;
      } else result = 'Enter start and end';
      break;
    }
  }
  return h`<div class="form-grid" data-quick>${fields.map(f => fieldHtml(f, v(f.name)))}</div>
    <div class="calc-display mt"><div class="calc-expr">${rate ? `${c.currency} ${rate.hourly_rate}/h` : 'No rate set'}${fxNote ? ' · ' + fxNote : ''}</div><div class="calc-result" style="font-size:18px" data-qres>${result}</div></div>
    <button class="btn sm" data-copyq>Copy result</button>
    <p class="small muted mt">Results are estimates only. Nothing here is written to your approvals or earnings.</p>`;
}

export function render(el) {
  cid ||= defaultContractId();
  let preview = '';
  try { preview = expr ? String(C.evaluate(expr)) : ''; } catch { preview = ''; }
  mount(el, h`<div class="grid two">
    <section class="panel"><div class="panel-head"><h2>Calculator</h2></div>
      <div class="calc">
        <div class="calc-display"><div class="calc-expr">${expr || ' '}</div><div class="calc-result">${last || preview || '0'}</div></div>
        <div class="keys">${KEYS.map(k => h`<button data-k="${k}" class="${'÷×−+()'.includes(k) ? 'op' : k === '=' ? 'eq' : ''}">${k}</button>`)}</div>
        <div class="btn-row mt"><button class="btn sm" data-copy>Copy</button><span class="small muted">Keyboard supported</span></div>
      </div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Quick modes</h2></div>
      <div class="form-grid">${fieldHtml({ name: 'qc', label: 'Contract', type: 'select', options: contractOptions() }, cid)}${fieldHtml({ name: 'qm', label: 'Mode', type: 'select', options: MODES }, mode)}</div>
      <div class="mt" data-qwrap>${quick()}</div>
    </section></div>`);

  const press = k => {
    last = '';
    if (k === 'C') expr = '';
    else if (k === '⌫') expr = expr.slice(0, -1);
    else if (k === '=') { try { last = String(C.evaluate(expr)); expr = last; } catch (e) { last = e.message; } }
    else expr += k;
    render(el);
  };
  el.onclick = e => {
    const k = e.target.closest('[data-k]')?.dataset.k;
    if (k) return press(k);
    if (e.target.closest('[data-copy]')) navigator.clipboard?.writeText(last || expr).then(() => toast('Copied'));
    if (e.target.closest('[data-copyq]')) navigator.clipboard?.writeText(el.querySelector('[data-qres]').textContent).then(() => toast('Copied'));
  };
  el.onchange = e => {
    if (e.target.name === 'qc') { cid = e.target.value; render(el); }
    else if (e.target.name === 'qm') { mode = e.target.value; inputs = {}; render(el); }
  };
  el.oninput = e => {
    if (!e.target.closest('[data-quick]')) return;
    inputs[e.target.name] = e.target.value;
    const wrap = el.querySelector('[data-qwrap]'), name = e.target.name, pos = e.target.selectionStart;
    mount(wrap, quick());
    const i = wrap.querySelector(`[name="${name}"]`);
    i?.focus();
    try { i?.setSelectionRange(pos, pos); } catch { /* date/time inputs */ }
  };
  el.onkeydown = e => {
    if (e.target.closest('input,select,textarea')) return;
    const map = { '*': '×', '/': '÷', '-': '−', Enter: '=', Backspace: '⌫', Escape: 'C' };
    const k = map[e.key] || e.key;
    if (KEYS.includes(k)) { e.preventDefault(); press(k); }
  };
  if (!el._kb) { el._kb = true; document.addEventListener('keydown', e => { if (location.hash.startsWith('#/calculator') && !document.querySelector('dialog[open]')) el.onkeydown?.(e); }); }
}
