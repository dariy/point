/**
 * IndexedDB helper for the Point offline store.
 *
 * Database:     point-offline (version 1)
 * Object stores:
 *   - posts             (keyPath: 'id')
 *   - tags              (keyPath: 'id')
 *   - tag_relationships (keyPath: ['parent_id', 'child_id'])
 *   - tag_locations     (keyPath: 'tag_id')
 *   - media             (keyPath: 'id')
 *   - mutation_queue    (keyPath: 'id')
 *   - meta              (keyPath: 'key')
 *   - blobs             (keyPath: 'id')
 */

const DB_NAME = 'point-offline';
const VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('posts')) {
        db.createObjectStore('posts', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tags')) {
        db.createObjectStore('tags', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tag_relationships')) {
        db.createObjectStore('tag_relationships', { keyPath: ['parent_id', 'child_id'] });
      }
      if (!db.objectStoreNames.contains('tag_locations')) {
        db.createObjectStore('tag_locations', { keyPath: 'tag_id' });
      }
      if (!db.objectStoreNames.contains('media')) {
        db.createObjectStore('media', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('mutation_queue')) {
        db.createObjectStore('mutation_queue', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/**
 * Save a full snapshot to IndexedDB.
 */
export async function saveSnapshot(data) {
  const db = await openDB();
  const tx = db.transaction(
    ['posts', 'tags', 'tag_relationships', 'tag_locations', 'media'],
    'readwrite'
  );

  const clearAndPut = (storeName, items) => {
    const store = tx.objectStore(storeName);
    store.clear();
    if (items) {
      items.forEach(item => store.put(item));
    }
  };

  clearAndPut('posts', data.posts);
  clearAndPut('tags', data.tags);
  clearAndPut('tag_relationships', data.tag_relationships);
  clearAndPut('tag_locations', data.tag_locations);
  clearAndPut('media', data.media);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get a post by its slug.
 */
export async function getPostBySlug(slug) {
  const db = await openDB();
  const tx = db.transaction('posts', 'readonly');
  const store = tx.objectStore('posts');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const posts = request.result;
      resolve(posts.find(p => p.slug === slug));
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * List all posts, optionally filtered.
 */
export async function listPosts() {
  const db = await openDB();
  const tx = db.transaction('posts', 'readonly');
  const store = tx.objectStore('posts');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      // Sort by published_at DESC, created_at DESC
      const posts = request.result.sort((a, b) => {
        const dateA = a.published_at || a.created_at;
        const dateB = b.published_at || b.created_at;
        return new Date(dateB) - new Date(dateA);
      });
      resolve(posts);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get metadata (e.g. last_sync).
 */
export async function getMeta(key) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  const store = tx.objectStore('meta');

  return new Promise((resolve, reject) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Save metadata.
 */
export async function saveMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  const store = tx.objectStore('meta');
  store.put({ key, value });

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Get all tags.
 */
export async function getTags() {
  const db = await openDB();
  const tx = db.transaction('tags', 'readonly');
  const store = tx.objectStore('tags');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all tag relationships.
 */
export async function getTagRelationships() {
  const db = await openDB();
  const tx = db.transaction('tag_relationships', 'readonly');
  const store = tx.objectStore('tag_relationships');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get all tag locations.
 */
export async function getTagLocations() {
  const db = await openDB();
  const tx = db.transaction('tag_locations', 'readonly');
  const store = tx.objectStore('tag_locations');

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
