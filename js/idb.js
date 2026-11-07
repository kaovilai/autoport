// js/idb.js — vanilla IndexedDB wrapper shared by the pages (no deps, structured clone).
// Mirrors the DB/store names used in sw.js. Keep the two in sync.

export const DB_NAME = 'autoport';
export const DB_VERSION = 1;
export const STORE_INBOX = 'inbox';

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_INBOX)) {
        const store = db.createObjectStore(STORE_INBOX, { keyPath: 'id', autoIncrement: true });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked by another tab'));
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_INBOX, mode);
    let out;
    const req = run(t.objectStore(STORE_INBOX));
    if (req) {
      req.onsuccess = () => { out = req.result; };
      req.onerror = () => reject(req.error);
    }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export async function add(record) {
  const db = await openDb();
  try { return await tx(db, 'readwrite', (s) => s.add(record)); } finally { db.close(); }
}

export async function put(record) {
  const db = await openDb();
  try { return await tx(db, 'readwrite', (s) => s.put(record)); } finally { db.close(); }
}

export async function getAll() {
  const db = await openDb();
  try {
    const all = await tx(db, 'readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } finally { db.close(); }
}

export async function get(id) {
  const db = await openDb();
  try { return await tx(db, 'readonly', (s) => s.get(id)); } finally { db.close(); }
}

export async function remove(id) {
  const db = await openDb();
  try { return await tx(db, 'readwrite', (s) => s.delete(id)); } finally { db.close(); }
}

export async function clear() {
  const db = await openDb();
  try { return await tx(db, 'readwrite', (s) => s.clear()); } finally { db.close(); }
}

export async function count() {
  const db = await openDb();
  try { return await tx(db, 'readonly', (s) => s.count()); } finally { db.close(); }
}
