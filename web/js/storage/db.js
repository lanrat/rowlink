// Session history in IndexedDB.
//   sessions:    summary records (small; listed on the History screen)
//   sessionData: per-second samples + raw packets, keyed by the same id

import { MIN_SAVE_DISTANCE_M } from '../pipeline/index.js';

const DB_NAME = 'rower';
const DB_VERSION = 2; // 2: + workouts
const BACKUP_FORMAT = 'rower-backup';

let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sessionData')) db.createObjectStore('sessionData', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('workouts')) db.createObjectStore('workouts', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(stores, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const result = fn(...stores.map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});

export function saveSession(session, data) {
  return tx(['sessions', 'sessionData'], 'readwrite', (s, d) => {
    s.put(session);
    d.put(data);
  });
}

/** Newest first. */
export async function listSessions() {
  const db = await open();
  const all = await req(db.transaction('sessions').objectStore('sessions').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export async function getSession(id) {
  const db = await open();
  const t = db.transaction(['sessions', 'sessionData']);
  const [session, data] = await Promise.all([
    req(t.objectStore('sessions').get(id)),
    req(t.objectStore('sessionData').get(id)),
  ]);
  return session ? { session, data: data ?? { id, samples: [], raw: [] } } : null;
}

export function deleteSession(id) {
  return tx(['sessions', 'sessionData'], 'readwrite', (s, d) => {
    s.delete(id);
    d.delete(id);
  });
}

/**
 * Sessions autosaved while rowing but never finished (tab closed, crash):
 * keep the ones long enough to count, drop the rest.
 */
export async function finalizeInterrupted() {
  const all = await listSessions();
  for (const s of all.filter((x) => !x.complete)) {
    if (s.summary.distanceM >= MIN_SAVE_DISTANCE_M) {
      const full = await getSession(s.id);
      await saveSession({ ...s, complete: true }, full.data);
    } else {
      await deleteSession(s.id);
    }
  }
}

// ---------- user workouts ----------

export async function listWorkouts() {
  const db = await open();
  const all = await req(db.transaction('workouts').objectStore('workouts').getAll());
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveWorkout(workout) {
  return tx(['workouts'], 'readwrite', (w) => w.put(workout));
}

export function deleteWorkout(id) {
  return tx(['workouts'], 'readwrite', (w) => w.delete(id));
}

/** Delete all sessions, workouts and settings in this browser. */
export async function eraseAllData() {
  const db = await open();
  db.close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onblocked = () => resolve();
    r.onerror = () => reject(r.error);
  });
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('rower.')) localStorage.removeItem(key);
  } catch {
    // storage unavailable
  }
}

/** Everything, as one JSON-able object. */
export async function exportAll() {
  const sessions = await listSessions();
  const items = [];
  for (const s of sessions) items.push(await getSession(s.id));
  return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(), items, workouts: await listWorkouts() };
}

/** Accepts a full backup or a single-session export. Existing ids are overwritten. @returns count imported */
export async function importBackup(json) {
  const items = json.format === BACKUP_FORMAT ? json.items : json.session ? [json] : null;
  if (!items) throw new Error('Not a rower backup or session file');
  for (const { session, data } of items) {
    if (!session?.id || !session.summary) throw new Error('Backup contains an invalid session');
    await saveSession(session, data ?? { id: session.id, samples: [], raw: [] });
  }
  for (const w of json.workouts ?? []) if (w?.id && Array.isArray(w.segments)) await saveWorkout(w);
  return items.length;
}
