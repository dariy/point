/**
 * Mutation Queue helper for Admin Offline CRUD.
 */
import { setOfflineStatus } from '../store.ts';

const DB_NAME = 'point-offline';
const VERSION = 1;

/** One queued offline write, as stored in the `mutation_queue` store. */
export interface QueuedOp {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  body: unknown;
  blob_key: string | null;
  status: 'pending' | 'syncing' | 'failed';
  error: string | null;
  temp_id_map: Record<string, unknown>;
}

/** A queued file, as stored in the `blobs` store. */
export interface QueuedBlob {
  id: string;
  data: ArrayBuffer;
  type: string;
  name: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Enqueue a mutation.
 */
export async function enqueue<T = unknown>(
  method: string,
  url: string,
  body: unknown = null,
  file: File | null = null,
): Promise<T> {
  const id = `local_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  const db = await openDB();
  const tx = db.transaction(['mutation_queue', 'blobs'], 'readwrite');
  
  let blob_key: string | null = null;
  if (file) {
    blob_key = id;
    tx.objectStore('blobs').put({ id, data: await file.arrayBuffer(), type: file.type, name: file.name });
  }

  const op: QueuedOp = {
    id,
    timestamp: Date.now(),
    method,
    url,
    body,
    blob_key,
    status: 'pending',
    error: null,
    temp_id_map: {}
  };

  tx.objectStore('mutation_queue').put(op);

  return new Promise<T>((resolve, reject) => {
    tx.oncomplete = () => {
      updateStatus();
      resolve({ id, ...(body as object) } as T);
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get all pending operations.
 */
export async function getQueue(): Promise<QueuedOp[]> {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore('mutation_queue').getAll();
    req.onsuccess = () => res((req.result as QueuedOp[]).sort((a, b) => a.timestamp - b.timestamp));
    req.onerror = () => rej(req.error);
  });
}

/**
 * Update global store with queue status.
 */
/**
 * Reset all failed ops back to 'pending' so they can be retried.
 */
export async function resetFailedOps() {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readwrite');
  const store = tx.objectStore('mutation_queue');
  const all = await new Promise<QueuedOp[]>((res, rej) => {
    const req = store.getAll();
    req.onsuccess = () => res(req.result as QueuedOp[]);
    req.onerror = () => rej(req.error);
  });
  all.filter(op => op.status === 'failed').forEach(op => {
    store.put({ ...op, status: 'pending', error: null });
  });
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

export async function updateStatus() {
  const queue = await getQueue();
  const pending = queue.filter(op => op.status === 'pending').length;
  const failed = queue.filter(op => op.status === 'failed').length;
  const syncing = queue.filter(op => op.status === 'syncing').length;

  setOfflineStatus({
    pending,
    failed,
    syncing,
    has_ops: queue.length > 0
  });
}
