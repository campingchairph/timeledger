// Pure, dependency-free calculations. All money is integer minor units (cents),
// all hours are integer centihours (1.50 h = 150), all durations integer minutes.
// Nothing here touches the DOM or storage, so it is fully unit-tested (tests/).

const DAY = 86400000;

// ---------- parsing ----------

// Parse a decimal string/number into integer hundredths without float drift.
// "25" → 2500, "4.5" → 450, "0.125" → 13 (half-up on the third decimal).
export function toHundredths(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    v = v.toFixed(6);
  }
  const s = String(v).trim().replace(/[,\s]/g, '');
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return NaN;
  const frac = (m[3] || '').padEnd(3, '0');
  let n = Number(m[2] || 0) * 100 + Number(frac.slice(0, 2)) + (Number(frac[2]) >= 5 ? 1 : 0);
  return m[1] === '-' ? -n : n;
}
export const toMinor = toHundredths; // money: "25.00" → 2500
export const toCenti = toHundredths; // hours: "4.5" → 450

export const centiToMinutes = c => Math.round(c * 0.6);
export const minutesToCenti = m => Math.round(m / 0.6);

// ---------- formatting ----------

export const hundredthsToString = n => {
  const neg = n < 0; n = Math.abs(Math.round(n));
  return (neg ? '-' : '') + Math.floor(n / 100) + '.' + String(n % 100).padStart(2, '0');
};
export const fmtCenti = c => hundredthsToString(c) + ' h';
export const fmtMinutesDec = m => fmtCenti(minutesToCenti(m));
export function fmtHM(min) {
  const neg = min < 0; min = Math.abs(Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return (neg ? '-' : '') + (h ? `${h}h ${m}m` : `${m}m`);
}
const moneyFmt = new Map();
export function fmtMoney(minor, currency) {
  if (!currency) return hundredthsToString(minor);
  let f = moneyFmt.get(currency);
  if (!f) {
    try { f = new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'symbol' }); }
    catch { f = { format: n => `${currency} ${n.toFixed(2)}` }; }
    moneyFmt.set(currency, f);
  }
  return f.format(minor / 100);
}
export const fmtSeconds = s => {
  s = Math.max(0, Math.floor(s));
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(n => String(n).padStart(2, '0')).join(':');
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(d) { // '2026-11-09' → '09 Nov 2026'
  if (!d) return '';
  const [y, m, dd] = d.slice(0, 10).split('-');
  return `${dd} ${MONTHS[+m - 1]} ${y}`;
}

// ---------- dates (YYYY-MM-DD strings, calendar math in UTC) ----------

export const dateToMs = d => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const msToDate = ms => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d, n) => msToDate(dateToMs(d) + n * DAY);
export const daysBetween = (a, b) => Math.round((dateToMs(b) - dateToMs(a)) / DAY);
export const weekday = d => new Date(dateToMs(d)).getUTCDay(); // 0 Sun..6 Sat
export const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);
export const rangesOverlap = (aFrom, aTo, bFrom, bTo) => aFrom <= bTo && bFrom <= aTo;

export function weekRange(d) { // ISO week, Monday start
  const start = addDays(d, -((weekday(d) + 6) % 7));
  return { from: start, to: addDays(start, 6) };
}
export function monthRange(d) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7);
  return { from: `${d.slice(0, 7)}-01`, to: msToDate(Date.UTC(y, m, 0)) };
}
// "14th-of-month" cycle: 14th of one month through the 13th of the next.
export function fourteenthRange(d) {
  const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  const startMs = day >= 14 ? Date.UTC(y, m - 1, 14) : Date.UTC(y, m - 2, 14);
  const s = new Date(startMs);
  return { from: msToDate(startMs), to: msToDate(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 13)) };
}

// Consecutive 14-calendar-day periods from a user-chosen anchor date.
export function periodFor(anchor, d) {
  const idx = Math.floor(daysBetween(anchor, d) / 14);
  const from = addDays(anchor, idx * 14);
  return { number: idx + 1, from, to: addDays(from, 13) };
}
export function periodsBetween(anchor, from, to) {
  const out = [];
  for (let p = periodFor(anchor, from); p.from <= to; p = periodFor(anchor, addDays(p.to, 1))) out.push(p);
  return out;
}

export function addWorkingDays(d, n) {
  let cur = d, left = n;
  while (left > 0) {
    cur = addDays(cur, 1);
    const w = weekday(cur);
    if (w !== 0 && w !== 6) left--;
  }
  return cur;
}

// ---------- time entries ----------

export const durationMinutes = (startIso, endIso) => Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000);

export function findOverlaps(entries, e) {
  const s = Date.parse(e.start_at_utc), en = Date.parse(e.end_at_utc);
  return entries.filter(o => o.id !== e.id && Date.parse(o.start_at_utc) < en && s < Date.parse(o.end_at_utc));
}

export const sumMinutes = entries => entries.reduce((a, e) => a + (e.duration_minutes || 0), 0);

// Personal availability counts billable logged time across ALL employers.
export function availability(limitMinutes, loggedMinutes) {
  return {
    remaining: Math.max(0, limitMinutes - loggedMinutes),
    over: loggedMinutes > limitMinutes,
    overBy: Math.max(0, loggedMinutes - limitMinutes),
  };
}

// ---------- rates ----------

export function rateOn(rates, contractId, date) {
  let best = null;
  for (const r of rates) {
    if (r.contract_id !== contractId || r.effective_from > date) continue;
    if (r.effective_to && r.effective_to < date) continue;
    if (!best || r.effective_from > best.effective_from) best = r;
  }
  return best;
}

// Earnings for one approval record. Uses the rate effective on the first work
// date of the approved period and flags when a different rate starts inside it.
export function approvalEarning(approval, contract, rates) {
  const centi = toCenti(approval.approved_hours);
  const rate = rateOn(rates, approval.contract_id, approval.period_start);
  const currency = rate?.currency || contract?.currency;
  const rateMinor = rate ? toMinor(rate.hourly_rate) : 0;
  const rateChange = rates.some(r => r.contract_id === approval.contract_id && r.id !== rate?.id &&
    r.effective_from > approval.period_start && r.effective_from <= approval.period_end);
  return { centi, currency, rateMinor, minor: Math.round(centi * rateMinor / 100), rateMissing: !rate, rateChange };
}

// Add to a { CURRENCY: minor } bucket — amounts in different currencies are never combined.
export function addTo(bucket, currency, minor) {
  if (!minor && minor !== 0) return bucket;
  bucket[currency] = (bucket[currency] || 0) + minor;
  return bucket;
}
export function mergeBuckets(...buckets) {
  const out = {};
  for (const b of buckets) for (const [c, v] of Object.entries(b)) addTo(out, c, v);
  return out;
}

// ---------- approvals, invoices, payments ----------

export const pendingDifference = (submittedCenti, approvedCenti) => ({
  diff: submittedCenti - approvedCenti,
  approvedExceedsSubmitted: approvedCenti > submittedCenti,
});

export const invoiceCountsAsBilled = inv => inv.status !== 'Credited';

// Centihours already allocated per approval (credited invoices release their hours).
export function allocatedByApproval(allocations, invoicesById) {
  const m = new Map();
  for (const a of allocations) {
    const inv = invoicesById.get(a.invoice_id);
    if (!inv || !invoiceCountsAsBilled(inv)) continue;
    m.set(a.approval_record_id, (m.get(a.approval_record_id) || 0) + toCenti(a.hours_allocated));
  }
  return m;
}

export const invoiceTotal = inv => (inv.subtotal_minor || 0) + (inv.adjustments_minor || 0);
export const invoicePaid = (inv, payments) =>
  payments.reduce((a, p) => a + (p.invoice_id === inv.id ? p.amount_minor : 0), 0);
export const invoiceOutstanding = (inv, payments) => invoiceTotal(inv) - invoicePaid(inv, payments);

export function invoiceStatus(inv, payments, today) {
  if (['Draft', 'Credited', 'Disputed'].includes(inv.status)) return inv.status;
  const paid = invoicePaid(inv, payments), total = invoiceTotal(inv);
  if (total > 0 && paid >= total) return 'Paid';
  if (inv.due_date && today > inv.due_date) return 'Overdue';
  if (paid > 0) return 'Partially paid';
  return inv.status;
}

// ---------- FX (estimates only) ----------

export const convertMinor = (minor, rate) => (rate ? Math.round(minor * rate) : null);

// ---------- calculator ----------

// Safe arithmetic evaluator (+ − × ÷, parentheses, decimals, unary minus). No eval().
export function evaluate(expr) {
  const src = String(expr).replace(/×/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  let i = 0;
  const peek = () => src[i];
  const num = () => {
    const m = /^\d*\.?\d+|^\d+\./.exec(src.slice(i));
    if (!m) throw new Error('Syntax error');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr_(); if (src[i++] !== ')') throw new Error('Missing )'); return v; }
    return num();
  };
  const term = () => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = src[i++], r = factor();
      if (op === '/' && r === 0) throw new Error('Divide by zero');
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr_ = () => {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; v = op === '+' ? v + term() : v - term(); }
    return v;
  };
  if (!src) return 0;
  const v = expr_();
  if (i < src.length) throw new Error('Syntax error');
  return Math.round(v * 1e10) / 1e10;
}
