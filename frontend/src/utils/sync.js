/**
 * Sync Engine for Point offline mutation queue.
 */
import { getQueue } from './mutationQueue.js';
import { api } from '../api/client.js';
import { store } from '../store.js';

let isSyncing = false;

/**
 * Attempt to sync the mutation queue to the server.
 */
export async function syncQueue() {
  if (isSyncing || !navigator.onLine) return;
  
  const queue = await getQueue();
  const pending = queue.filter(op => op.status === 'pending' || op.status === 'failed');
  if (pending.length === 0) return;

  isSyncing = true;
  console.log(`[Sync] Starting sync of ${pending.length} operations...`);

  const idMap = {}; // tempId -> realId

  try {
    for (const op of pending) {
      // 1. Mark as syncing
      await updateOpStatus(op.id, 'syncing');

      try {
        // 2. Resolve temp IDs in body
        const resolvedBody = resolveTempIds(op.body, idMap);
        
        // 3. Handle file upload if needed (bypass offline interceptor)
        if (op.blob_key) {
          const blob = await getBlob(op.blob_key);
          const formData = new FormData();
          formData.append('file', new Blob([blob.data], { type: blob.type }), blob.name);
          
          const uploadResp = await api.request(op.url, {
            method: 'POST',
            body: formData,
          });
          if (uploadResp && uploadResp.id) {
            idMap[op.id] = uploadResp.id;
          }
        } else {
          // 4. Execute request (bypass offline interceptor)
          let resp;
          const method = op.method;
          const headers = { 'Content-Type': 'application/json' };
          const body = (method !== 'DELETE' && op.body) ? JSON.stringify(resolvedBody) : undefined;
          
          resp = await api.request(op.url, { method, headers, body });

          // 5. Track ID mapping for POST
          if (op.method === 'POST' && resp && resp.id) {
            idMap[op.id] = resp.id;
          }
        }

        // 6. Delete on success
        await deleteOp(op.id);
        if (op.blob_key) await deleteBlob(op.blob_key);

      } catch (err) {
        console.error(`[Sync] Operation ${op.id} failed:`, err);
        await updateOpStatus(op.id, 'failed', err.message || 'Server error');
        // Halt on first error
        break;
      }
    }
  } finally {
    isSyncing = false;
    // Re-trigger status update
    window.dispatchEvent(new CustomEvent('sync:complete'));
  }
}

function resolveTempIds(obj, idMap) {
  if (!obj || typeof obj !== 'object') return obj;
  const newObj = Array.isArray(obj) ? [] : {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string' && idMap[value]) {
      newObj[key] = idMap[value];
    } else if (typeof value === 'object') {
      newObj[key] = resolveTempIds(value, idMap);
    } else {
      newObj[key] = value;
    }
  }
  return newObj;
}

// ── IDB Helpers ─────────────────────────────────────────────────────────────

const DB_NAME = 'point-offline';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function updateOpStatus(id, status, error = null) {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readwrite');
  const store = tx.objectStore('mutation_queue');
  const op = await new Promise(res => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result);
  });
  if (op) {
    op.status = status;
    op.error = error;
    store.put(op);
  }
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function deleteOp(id) {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readwrite');
  tx.objectStore('mutation_queue').delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function getBlob(id) {
  const db = await openDB();
  const tx = db.transaction('blobs', 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function deleteBlob(id) {
  const db = await openDB();
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}
