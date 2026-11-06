// In-memory mirror of the database. Everything is loaded once at startup so views
// render synchronously; every write goes through save()/remove() which persist,
// audit and notify listeners.

import * as db from './db.js';
import { seedRecords } from './seed.js';
import { dateIn } from './tz.js';

export const S = {};
const index = new Map(); // table → Map(id → rec), rebuilt lazily after writes
const listeners = new Set();

export const uid = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

const AUDITED = new Set(['profile', 'employers', 'contracts', 'rates', 'plans', 'tasks', 'entries', 'timers',
  'evidence', 'submissions', 'approvals', 'invoices', 'allocations', 'payments']);

export const DEFAULT_SETTINGS = {
  id: 'settings',
  selection: { employerId: null, contractId: null },
  lastContractId: null,
  fx: { provider: 'auto', refreshMinutes: 30, overrides: {} },
  closeouts: {},
  onboarded: false,
};

export async function init() {
  Object.assign(S, await db.loadAll());
  if (!S.meta.some(m => m.id === 'seeded')) {
    const seed = seedRecords(uid, nowIso());
    for (const [table, recs] of Object.entries(seed)) for (const r of recs) { S[table].push(r); await db.put(table, r); }
    const flag = { id: 'seeded', at: nowIso() };
    S.meta.push(flag); await db.put('meta', flag);
  }
  if (!S.meta.some(m => m.id === 'settings')) {
    const s = structuredClone(DEFAULT_SETTINGS);
    S.meta.push(s); await db.put('meta', s);
  }
  index.clear();
}

// ---------- reads ----------

export function get(table, id) {
  if (!id) return undefined;
  let m = index.get(table);
  if (!m) index.set(table, m = new Map(S[table].map(r => [r.id, r])));
  return m.get(id);
}
export const settings = () => get('meta', 'settings');
export const profile = () => S.profile[0];
export const homeTz = () => profile()?.home_timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
export const homeCurrency = () => profile()?.home_currency || 'PHP';
export const today = () => dateIn(Date.now(), homeTz());

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(table) { for (const fn of listeners) fn(table); }

// ---------- writes ----------

export async function save(table, rec, { reason = '', action, audit = AUDITED.has(table) } = {}) {
  const list = S[table];
  const i = rec.id ? list.findIndex(r => r.id === rec.id) : -1;
  const old = i >= 0 ? list[i] : null;
  const now = nowIso();
  const next = { ...old, ...rec, id: rec.id || uid(), created_at: old?.created_at || now, updated_at: now };
  if (i >= 0) list[i] = next; else list.push(next);
  index.delete(table);
  await db.put(table, next);
  if (audit) await logAudit(table, next.id, action || (old ? 'update' : 'create'), old, next, reason);
  emit(table);
  return next;
}

export async function remove(table, id, { reason = '', audit = AUDITED.has(table) } = {}) {
  const i = S[table].findIndex(r => r.id === id);
  if (i < 0) return;
  const [old] = S[table].splice(i, 1);
  index.delete(table);
  await db.del(table, id);
  if (table === 'evidence') await db.del(db.BLOBS, id);
  if (audit) await logAudit(table, id, 'delete', old, null, reason);
  emit(table);
}

const strip = r => {
  if (!r) return null;
  const { thumb, logo, ...rest } = r; // keep the audit log small
  return rest;
};
async function logAudit(entity_type, entity_id, action, oldV, newV, reason) {
  const rec = { id: uid(), entity_type, entity_id, action, old_value_json: strip(oldV), new_value_json: strip(newV), reason, occurred_at_utc: nowIso() };
  S.audit.push(rec);
  await db.put('audit', rec);
}

export const updateSettings = patch => save('meta', { ...settings(), ...patch }, { audit: false });

export const putBlob = (id, blob) => db.put(db.BLOBS, { id, blob });
export const getBlob = async id => (await db.get(db.BLOBS, id))?.blob;

// ---------- employers / contracts / scope ----------

export const employerName = e => e ? (e.display_name || e.legal_name) : '—';
export function contractLabel(c) {
  if (!c) return '—';
  return `${employerName(get('employers', c.employer_id))} · ${c.title}`;
}

export function contractStatus(c, d = today()) {
  if (['archived', 'draft'].includes(c.status)) return c.status;
  if (c.status === 'ended' || (c.end_date && d > c.end_date)) return 'ended';
  if (c.start_date && d < c.start_date) return 'upcoming';
  return 'active';
}

// Contracts offered in quick-entry pickers: not archived, employer not archived.
export const pickableContracts = () => S.contracts.filter(c =>
  c.status !== 'archived' && get('employers', c.employer_id)?.status !== 'archived');

export function scopeContractIds() {
  const { employerId, contractId } = settings().selection || {};
  if (contractId && get('contracts', contractId)) return new Set([contractId]);
  if (employerId) return new Set(S.contracts.filter(c => c.employer_id === employerId).map(c => c.id));
  return new Set(S.contracts.map(c => c.id));
}
export const isAllScope = () => {
  const s = settings().selection || {};
  return !s.contractId && !s.employerId;
};
export function inScope(table) {
  const ids = scopeContractIds();
  return S[table].filter(r => ids.has(r.contract_id));
}
// The single contract a form should default to.
export function defaultContractId() {
  const s = settings();
  const picks = pickableContracts();
  for (const id of [s.selection?.contractId, s.lastContractId]) if (id && picks.some(c => c.id === id)) return id;
  if (s.selection?.employerId) return picks.find(c => c.employer_id === s.selection.employerId)?.id || picks[0]?.id;
  return picks[0]?.id;
}

export const contractRates = cid => S.rates.filter(r => r.contract_id === cid).sort((a, b) => a.effective_from.localeCompare(b.effective_from));

export function linkedCounts(contractIds) {
  const ids = new Set(contractIds);
  const out = {};
  for (const t of ['tasks', 'entries', 'evidence', 'submissions', 'approvals', 'invoices', 'plans']) {
    const n = S[t].filter(r => ids.has(r.contract_id)).length;
    if (n) out[t] = n;
  }
  return out;
}
