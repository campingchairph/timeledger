// IANA time-zone helpers built on Intl — no hardcoded offsets, DST handled by the platform.
// Formatters are cached because Intl.DateTimeFormat construction is the expensive part.

const cache = new Map();
function dtf(tz, opts, locale = 'en-GB') {
  const key = locale + tz + JSON.stringify(opts);
  let f = cache.get(key);
  if (!f) cache.set(key, f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }));
  return f;
}

const PARTS = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' };

export function partsIn(ms, tz) {
  const o = {};
  for (const p of dtf(tz, PARTS).formatToParts(ms)) if (p.type !== 'literal') o[p.type] = +p.value;
  return o;
}

// Minutes the zone is ahead of UTC at instant ms.
export function offsetMinutes(ms, tz) {
  const p = partsIn(ms, tz);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

// Wall-clock date + time in a zone → UTC epoch ms. Non-existent DST-gap times roll forward.
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = offsetMinutes(guess, tz);
  let t = guess - off1 * 60000;
  const off2 = offsetMinutes(t, tz);
  if (off2 !== off1) t = guess - off2 * 60000;
  return t;
}

const pad = n => String(n).padStart(2, '0');
export function dateIn(ms, tz) { const p = partsIn(ms, tz); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; }
export function timeIn(ms, tz) { const p = partsIn(ms, tz); return `${pad(p.hour)}:${pad(p.minute)}`; }

export function offsetLabel(ms, tz) {
  const o = offsetMinutes(ms, tz), a = Math.abs(o);
  return `UTC${o < 0 ? '−' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// Abbreviation such as BST/GMT where the platform knows one, otherwise the UTC offset.
export function tzAbbr(ms, tz) {
  const name = dtf(tz, { timeZoneName: 'short' }).formatToParts(ms).find(p => p.type === 'timeZoneName')?.value || '';
  return /^(GMT|UTC)[+−-]/.test(name) ? offsetLabel(ms, tz) : name;
}

export function clockText(ms, tz) {
  return {
    date: dtf(tz, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(ms),
    time: dtf(tz, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms),
    abbr: tzAbbr(ms, tz),
    ymd: dateIn(ms, tz),
  };
}

export function fmtDateTime(iso, tz) {
  if (!iso) return '';
  return dtf(tz, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Date.parse(iso));
}

export const cityName = tz => tz.split('/').pop().replace(/_/g, ' ');

let zones;
export function allZones() {
  if (!zones) {
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
    if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  }
  return zones;
}
let currencies;
export function allCurrencies() {
  if (!currencies) { try { currencies = Intl.supportedValuesOf('currency'); } catch { currencies = []; } }
  return currencies;
}
