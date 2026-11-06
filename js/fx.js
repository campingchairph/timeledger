// Swappable FX provider service. Rates are for ESTIMATES only and never alter
// contract-currency earnings. No rate is ever invented: if every provider fails
// we fall back to the last cached rate (flagged stale) or show nothing.

import { S, save, settings, homeCurrency, pickableContracts, nowIso, remove } from './store.js';

export const PROVIDERS = {
  frankfurter: {
    name: 'Frankfurter (European Central Bank reference rates)',
    url: (b, q) => `https://api.frankfurter.dev/v1/latest?base=${b}&symbols=${q}`,
    parse: (j, q) => j?.rates?.[q],
  },
  erapi: {
    name: 'ExchangeRate-API open access',
    url: b => `https://open.er-api.com/v6/latest/${b}`,
    parse: (j, q) => (j?.result === 'success' ? j.rates?.[q] : undefined),
  },
};

async function fetchFrom(key, base, quote) {
  const p = PROVIDERS[key];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(p.url(base, quote), { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status}`);
    const rate = Number(p.parse(await res.json(), quote));
    if (!(rate > 0)) throw new Error('No rate in response');
    return { rate, provider: p.name };
  } finally { clearTimeout(timer); }
}

const failures = new Map(); // pair → last error message

export async function refreshPair(base, quote) {
  const pref = settings().fx?.provider || 'auto';
  const order = pref === 'auto' ? Object.keys(PROVIDERS) : [pref, ...Object.keys(PROVIDERS).filter(k => k !== pref)];
  let lastErr;
  for (const key of order) {
    try {
      const { rate, provider } = await fetchFrom(key, base, quote);
      failures.delete(base + quote);
      await save('fx', { base_currency: base, quote_currency: quote, rate, provider, fetched_at_utc: nowIso(), is_manual_override: false }, { audit: false });
      await prune(base, quote);
      return true;
    } catch (e) { lastErr = e; }
  }
  failures.set(base + quote, lastErr?.message || 'unavailable');
  return false;
}

async function prune(base, quote) { // keep the 30 most recent fetched rates per pair
  const rows = S.fx.filter(r => r.base_currency === base && r.quote_currency === quote && !r.is_manual_override)
    .sort((a, b) => b.fetched_at_utc.localeCompare(a.fetched_at_utc));
  for (const r of rows.slice(30)) await remove('fx', r.id, { audit: false });
}

export function neededPairs() {
  const home = homeCurrency();
  return [...new Set(pickableContracts().map(c => c.currency).filter(c => c && c !== home))].map(c => [c, home]);
}

export async function refreshAll(force = false) {
  const maxAge = (settings().fx?.refreshMinutes || 30) * 60000;
  await Promise.all(neededPairs().map(([b, q]) => {
    const r = latestFetched(b, q);
    if (!force && r && Date.now() - Date.parse(r.fetched_at_utc) < maxAge) return null;
    return refreshPair(b, q);
  }));
}

function latestFetched(base, quote) {
  let best = null;
  for (const r of S.fx) if (r.base_currency === base && r.quote_currency === quote && !r.is_manual_override &&
    (!best || r.fetched_at_utc > best.fetched_at_utc)) best = r;
  return best;
}

// The rate to use for estimates: manual override > latest fetched. Includes staleness info.
export function rateFor(base, quote = homeCurrency()) {
  if (!base || base === quote) return { rate: 1, same: true };
  const ov = settings().fx?.overrides?.[`${base}${quote}`];
  if (ov?.rate > 0) return { rate: ov.rate, provider: 'Manual override', fetched_at_utc: ov.set_at, manual: true, stale: false };
  const r = latestFetched(base, quote);
  if (!r) return { rate: null, error: failures.get(base + quote) };
  const maxAge = (settings().fx?.refreshMinutes || 30) * 60000 * 2;
  return { ...r, stale: failures.has(base + quote) || Date.now() - Date.parse(r.fetched_at_utc) > maxAge, error: failures.get(base + quote) };
}
