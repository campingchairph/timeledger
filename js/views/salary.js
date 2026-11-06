import { S, get, today, scopeContractIds, homeCurrency, settings, updateSettings, homeTz, contractLabel } from '../store.js';
import { h, mount, card, moneyList, table, badge, formModal, toast } from '../ui.js';
import * as C from '../calc.js';
import * as M from '../metrics.js';
import { rateFor, refreshAll, neededPairs } from '../fx.js';
import { fmtDateTime } from '../tz.js';
import { phpEstimate } from './dashboard.js';

let mode = 'all', from = '', to = '';

function fxPanel() {
  const home = homeCurrency(), tz = homeTz();
  const pairs = neededPairs();
  if (!pairs.length) return h`<p class="muted small">All contracts are in ${home} — no conversion needed.</p>`;
  return h`<div class="list">${pairs.map(([b, q]) => {
    const r = rateFor(b, q);
    return h`<div class="item"><div class="item-main">
        <div class="item-title">1 ${b} = ${r.rate ? r.rate.toFixed(4) : '—'} ${q} ${r.manual ? badge('Manual override', 'warn') : ''}${r.stale ? badge('Stale', 'warn') : ''}</div>
        <div class="item-meta">${r.rate ? h`<span>${r.provider}</span><span>Updated ${fmtDateTime(r.fetched_at_utc, tz)}</span>` : h`<span class="badge bad">No rate available${r.error ? ' — ' + r.error : ''}</span>`}</div>
      </div><div class="item-actions"><button class="btn sm" data-override="${b}${q}">Override</button></div></div>`;
  })}</div>
  <div class="btn-row mt"><button class="btn sm" data-refresh>Refresh rates now</button><span class="small muted">Auto-refresh every ${settings().fx?.refreshMinutes || 30} min. Estimates exclude fees, spreads and taxes.</span></div>`;
}

export function render(el) {
  const t = today();
  const cids = scopeContractIds();
  let f = null, tt = null;
  if (mode === 'month') ({ from: f, to: tt } = C.monthRange(t));
  if (mode === 'custom') { f = from || null; tt = to || null; }

  const apps = M.approvalsIn(cids, f, tt);
  const earn = M.earnings(apps);
  const month = M.earnings(M.approvalsIn(cids, C.monthRange(t).from, C.monthRange(t).to));
  const php = phpEstimate(earn.byCur);
  const fin = M.finance(cids, f, tt);
  const logged = M.loggedMinutes(M.entriesIn(cids, f, tt));
  const submitted = M.sumCenti(M.submissionsIn(cids, f, tt), 'submitted_hours');

  // Monthly breakdown (by approval period start), one row per month × currency.
  const buckets = new Map();
  for (const r of earn.rows) {
    const k = r.approval.period_start.slice(0, 7) + '|' + r.currency;
    const b = buckets.get(k) || { month: r.approval.period_start.slice(0, 7), currency: r.currency, centi: 0, minor: 0 };
    b.centi += r.centi; b.minor += r.minor;
    buckets.set(k, b);
  }
  const months = [...buckets.values()].sort((a, b) => b.month.localeCompare(a.month));

  mount(el, h`
    <div class="toolbar">
      <div class="chips" style="margin:0">${[['all', 'Contract to date'], ['month', 'This month'], ['custom', 'Custom range']].map(([k, l]) => h`<button class="chip ${mode === k ? 'active' : ''}" data-mode="${k}">${l}</button>`)}</div>
      ${mode === 'custom' ? h`<label class="field"><span>From</span><input type="date" data-from value="${from}"></label><label class="field"><span>To</span><input type="date" data-to value="${to}"></label>` : ''}
    </div>
    <p class="note">Earnings come exclusively from manually recorded approved hours × the rate effective on the work date. Logged, submitted, pending and rejected hours earn nothing here. Payments are tracked separately and don't reduce earned.</p>
    ${earn.rateMissing ? h`<div class="badbox">Some approvals fall on dates with no rate set — add a rate under Employers & Contracts.</div>` : ''}
    <div class="stats">
      ${card('Logged (for reference)', C.fmtMinutesDec(logged), 'Not used for pay', 'logged')}
      ${card('Submitted', C.fmtCenti(submitted), 'Not used for pay', 'submitted')}
      ${card('Approved hours', C.fmtCenti(earn.centi), '', 'approved')}
      ${card('Earned', moneyList(earn.byCur, '0.00'), 'Contract currency', 'approved')}
      ${card(`${homeCurrency()} estimate`, moneyList(php.out, 'No rate'), php.notes.join(' · ') || 'Estimate', 'approved')}
      ${card('Earned this month', moneyList(month.byCur, '0.00'), C.fmtCenti(month.centi), 'approved')}
      ${card('Approved, not invoiced', moneyList(fin.notInvoiced, '0.00'), C.fmtCenti(fin.notInvoicedCenti), 'invoiced')}
      ${card('Invoiced', moneyList(fin.invoiced, '0.00'), 'Excludes drafts and credited', 'invoiced')}
      ${card('Invoiced, not paid', moneyList(fin.outstanding, '0.00'), '', 'invoiced')}
      ${card('Paid', moneyList(fin.paid, '0.00'), 'Recorded payments', 'paid')}
    </div>
    <div class="grid side">
      <section class="panel"><div class="panel-head"><h2>Earned by month</h2></div>
        ${table([
          { label: 'Month', render: b => new Date(b.month + '-01T00:00:00Z').toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) },
          { label: 'Currency', render: b => b.currency },
          { label: 'Approved', cls: 'num', render: b => C.fmtCenti(b.centi) },
          { label: 'Earned', cls: 'num', render: b => C.fmtMoney(b.minor, b.currency) },
          { label: `≈ ${homeCurrency()}`, cls: 'num', render: b => { const r = rateFor(b.currency); return r.rate ? C.fmtMoney(C.convertMinor(b.minor, r.rate), homeCurrency()) : '—'; } },
        ], months, { empty: 'No approved hours in this range.' })}
      </section>
      <section class="panel"><div class="panel-head"><h2>Exchange rates</h2></div>${fxPanel()}</section>
    </div>
    <section class="panel"><div class="panel-head"><h2>Payments received</h2><a class="btn sm" href="#/invoices">Invoices</a></div>
      ${table([
        { label: 'Date', render: p => C.fmtDate(p.received_at_utc) },
        { label: 'Invoice', render: p => { const i = get('invoices', p.invoice_id); return i ? `${i.invoice_number} · ${contractLabel(get('contracts', i.contract_id))}` : '—'; } },
        { label: 'Reference', render: p => p.payment_reference || '' },
        { label: 'Account', render: p => p.account_label || '' },
        { label: 'Amount', cls: 'num', render: p => C.fmtMoney(p.amount_minor, p.currency) },
      ], S.payments.filter(p => cids.has(get('invoices', p.invoice_id)?.contract_id) && C.inRange(p.received_at_utc.slice(0, 10), f, tt)).sort((a, b) => b.received_at_utc.localeCompare(a.received_at_utc)), { empty: 'No payments recorded.' })}
    </section>`);

  el.onclick = async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.mode) { mode = b.dataset.mode; render(el); }
    else if ('refresh' in b.dataset) { b.disabled = true; await refreshAll(true); b.disabled = false; render(el); toast('Rates refreshed where available'); }
    else if (b.dataset.override) {
      const key = b.dataset.override, ov = settings().fx?.overrides?.[key];
      await formModal({
        title: `Manual rate ${key.slice(0, 3)} → ${key.slice(3)}`,
        intro: h`<p class="note">A manual override replaces the live rate for estimates until cleared. It is clearly labelled everywhere it's used.</p>`,
        fields: [{ name: 'rate', label: `1 ${key.slice(0, 3)} = ? ${key.slice(3)}`, type: 'number', step: 'any', attrs: { min: 0 }, hint: 'Leave empty to clear the override.' }],
        values: { rate: ov?.rate || '' },
        onSubmit: v => {
          const overrides = { ...(settings().fx?.overrides || {}) };
          if (+v.rate > 0) overrides[key] = { rate: +v.rate, set_at: new Date().toISOString() }; else delete overrides[key];
          return updateSettings({ fx: { ...settings().fx, overrides } });
        },
      });
    }
  };
  el.onchange = e => {
    if ('from' in e.target.dataset) from = e.target.value;
    else if ('to' in e.target.dataset) to = e.target.value;
    else return;
    render(el);
  };
}
