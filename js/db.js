// Thin IndexedDB layer. Each table is an object store keyed by `id`.
// Schema changes go in MIGRATIONS (index = target version) — never edit an old step.

const DB_NAME = 'timeledger';

export const TABLES = [
  'meta', 'profile', 'employers', 'contracts', 'rates', 'plans', 'tasks', 'entries', 'timers',
  'evidence', 'submissions', 'approvals', 'approvalHistory', 'fx', 'invoices', 'allocations',
  'payments', 'audit', 'exports',
];
// Evidence file bytes live in their own store and are only read on demand.
export const BLOBS = 'blobs';

const MIGRATIONS = [
  null,
  db => { for (const t of [...TABLES, BLOBS]) db.createObjectStore(t, { keyPath: 'id' }); },
];

let dbp;
function open() {
  return dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, MIGRATIONS.length - 1);
    req.onupgradeneeded = e => {
      for (let v = e.oldVersion + 1; v < MIGRATIONS.length; v++) MIGRATIONS[v](req.result, req.transaction);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database upgrade blocked — close other TimeLedger tabs.'));
  });
}

const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
const result = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function loadAll() {
  const db = await open();
  const t = db.transaction(TABLES, 'readonly');
  const out = {};
  await Promise.all(TABLES.map(async n => { out[n] = await result(t.objectStore(n).getAll()); }));
  return out;
}

export async function put(table, rec) {
  const t = (await open()).transaction(table, 'readwrite');
  t.objectStore(table).put(rec);
  return done(t);
}

export async function del(table, id) {
  const t = (await open()).transaction(table, 'readwrite');
  t.objectStore(table).delete(id);
  return done(t);
}

export async function get(table, id) {
  const t = (await open()).transaction(table, 'readonly');
  return result(t.objectStore(table).get(id));
}

export async function getAll(table) {
  const t = (await open()).transaction(table, 'readonly');
  return result(t.objectStore(table).getAll());
}

// Replace every table in one transaction (used by restore).
export async function replaceAll(data) {
  const db = await open();
  const names = [...TABLES, BLOBS];
  const t = db.transaction(names, 'readwrite');
  for (const n of names) {
    const s = t.objectStore(n);
    s.clear();
    for (const r of data[n] || []) s.put(r);
  }
  return done(t);
}
