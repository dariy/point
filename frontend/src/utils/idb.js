/**
 * IndexedDB helper for the Web Share Target queue.
 *
 * Database:     point-share  (version 1)
 * Object store: queue  (keyPath: 'id')
 *
 * Entry shape:
 *   {
 *     id:        string,   // crypto.randomUUID()
 *     files:     Array<{ name: string, type: string, data: ArrayBuffer }>,
 *     title:     string,
 *     timestamp: number,
 *   }
 */

const DB_NAME = 'point-share';
const STORE   = 'queue';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

export async function addShareEntry(entry) {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(entry);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

export async function getAllShareEntries() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => res(req.result.sort((a, b) => a.timestamp - b.timestamp));
    req.onerror   = () => rej(req.error);
  });
}

export async function clearShareEntries() {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).clear();
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}
