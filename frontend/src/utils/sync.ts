/**
 * Sync Engine for Point offline mutation queue.
 */
import { getQueue, updateStatus } from './mutationQueue.ts';
import type { QueuedOp, QueuedBlob } from './mutationQueue.ts';
import { api } from '../api/client.ts';


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

  const idMap: Record<string, unknown> = {}; // tempId -> realId

  try {
    for (const op of pending) {
      // 1. Mark as syncing
      await updateOpStatus(op.id, 'syncing');
      await updateStatus();

      try {
        // 2. Resolve temp IDs in URL and body
        const resolvedUrl  = resolveUrl(op.url, idMap);
        const resolvedBody = resolveTempIds(op.body, idMap);

        // 3. Handle file upload if needed (bypass offline interceptor)
        if (op.blob_key) {
          const blob = await getBlob(op.blob_key);
          const formData = new FormData();
          formData.append('file', new Blob([blob.data], { type: blob.type }), blob.name);

          // The wire shape is only ever read for the server-assigned id, so
          // that is all the annotation claims.
          const uploadResp: {id?: unknown} = await api.request(resolvedUrl, {
            method: 'POST',
            body: formData,
          });
          if (uploadResp && uploadResp.id) {
            idMap[op.id] = uploadResp.id;
          }
        } else {
          // 4. Execute request (bypass offline interceptor)
          let resp: {id?: unknown};
          const method = op.method;
          const headers = { 'Content-Type': 'application/json' };
          const body = (method !== 'DELETE' && op.body) ? JSON.stringify(resolvedBody) : undefined;
          
          resp = await api.request(resolvedUrl, { method, headers, body });

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
        await updateOpStatus(op.id, 'failed', (err as Error | null)?.message || 'Server error');
        await updateStatus();
        window.dispatchEvent(new CustomEvent('sync:failed'));
        // Halt on first error
        break;
      }
    }
  } finally {
    isSyncing = false;
    await updateStatus();
    window.dispatchEvent(new CustomEvent('sync:complete'));
  }
}

// Replace any local_… segment in a URL with the real server ID from idMap.
function resolveUrl(url: string, idMap: Record<string, unknown>) {
  return url.replace(/local_[^/?#]+/g, (match) => String(idMap[match] ?? match));
}

function resolveTempIds(obj: unknown, idMap: Record<string, unknown>): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  const newObj = (Array.isArray(obj) ? [] : {}) as Record<string, unknown>;
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

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function updateOpStatus(id: string, status: QueuedOp['status'], error: string | null = null) {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readwrite');
  const store = tx.objectStore('mutation_queue');
  const op = await new Promise<QueuedOp | undefined>(res => {
    const req = store.get(id);
    req.onsuccess = () => res(req.result as QueuedOp | undefined);
  });
  if (op) {
    op.status = status;
    op.error = error;
    store.put(op);
  }
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function deleteOp(id: string) {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readwrite');
  tx.objectStore('mutation_queue').delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

async function getBlob(id: string): Promise<QueuedBlob> {
  const db = await openDB();
  const tx = db.transaction('blobs', 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = () => res(req.result as QueuedBlob);
    req.onerror = () => rej(req.error);
  });
}

async function deleteBlob(id: string) {
  const db = await openDB();
  const tx = db.transaction('blobs', 'readwrite');
  tx.objectStore('blobs').delete(id);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}
