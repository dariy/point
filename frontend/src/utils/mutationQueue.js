/**
 * Mutation Queue helper for Admin Offline CRUD.
 */
import { store } from '../store.js';

const DB_NAME = 'point-offline';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

/**
 * Enqueue a mutation.
 */
export async function enqueue(method, url, body = null, file = null) {
  const id = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const db = await openDB();
  const tx = db.transaction(['mutation_queue', 'blobs'], 'readwrite');
  
  let blob_key = null;
  if (file) {
    blob_key = id;
    tx.objectStore('blobs').put({ id, data: await file.arrayBuffer(), type: file.type, name: file.name });
  }

  const op = {
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

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      updateStatus();
      resolve({ id, ...body });
    };
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get all pending operations.
 */
export async function getQueue() {
  const db = await openDB();
  const tx = db.transaction('mutation_queue', 'readonly');
  return new Promise((res, rej) => {
    const req = tx.objectStore('mutation_queue').getAll();
    req.onsuccess = () => res(req.result.sort((a, b) => a.timestamp - b.timestamp));
    req.onerror = () => rej(req.error);
  });
}

/**
 * Update global store with queue status.
 */
export async function updateStatus() {
  const queue = await getQueue();
  const pending = queue.filter(op => op.status === 'pending').length;
  const failed = queue.filter(op => op.status === 'failed').length;
  const syncing = queue.filter(op => op.status === 'syncing').length;

  store.set('offline_status', {
    pending,
    failed,
    syncing,
    has_ops: queue.length > 0
  });
}
