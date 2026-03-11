/**
 * Point — Service Worker
 *
 * Responsibilities:
 *  1. Intercept POST /share-target (Web Share Target Level 2).
 *     Reads shared files, saves entry to IndexedDB, redirects to
 *     /light/posts/new?share=pending.
 *  2. Shell caching (stale-while-revalidate) for offline support.
 *     Caches SPA shell assets on install; serves stale from cache
 *     while updating in the background.
 *
 * Note: IDB helpers are inlined here because service workers are
 * registered as classic scripts and cannot use ES module imports
 * without explicit { type: 'module' } registration.
 */

const CACHE_VERSION = 'v1';
const CACHE_NAME    = `point-${CACHE_VERSION}`;

// Assets to cache on install (SPA shell).
// Includes app.js and its direct static imports so the bootstrap chain
// completes even on a fresh SW install with no network.
const SHELL_URLS = [
  '/',
  // Entry point
  '/assets/js/app.js',
  // Direct imports of app.js (must be pre-cached for offline bootstrap)
  '/assets/js/store.js',
  '/assets/js/router.js',
  '/assets/js/api/auth.js',
  '/assets/js/api/client.js',
  '/assets/js/api/settings.js',
  '/assets/js/utils/helpers.js',
  '/assets/js/components/Component.js',
  '/assets/js/components/shared/Toast.js',
  // Styles
  '/assets/css/main.css',
  '/assets/css/light.css',
  // Favicon
  '/assets/images/favicon.svg',
  '/assets/images/favicon-512.png',
  '/assets/images/favicon-dark-512.png',
];

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const IDB_DB    = 'point-share';
const IDB_STORE = 'queue';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB, 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function idbPut(entry) {
  const db = await idbOpen();
  const tx = db.transaction(IDB_STORE, 'readwrite');
  tx.objectStore(IDB_STORE).put(entry);
  return new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Share target: intercept POST entirely — never reaches the Go server.
  if (url.pathname === '/share-target' && request.method === 'POST') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // API responses must never be cached.
  if (url.pathname.startsWith('/api/')) return;

  // SW and manifest must not be cached by the SW itself.
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return;

  // Navigation requests (HTML): always serve the cached SPA shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/').then((cached) => cached || fetch(request)),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

// ── Share target handler ──────────────────────────────────────────────────────

async function handleShareTarget(request) {
  const formData    = await request.formData();
  const sharedFiles = formData.getAll('media');
  const title       = formData.get('title') || '';

  const fileEntries = await Promise.all(
    sharedFiles.map(async (file) => ({
      name: file.name,
      type: file.type,
      data: await file.arrayBuffer(),
    })),
  );

  await idbPut({
    id:        crypto.randomUUID(),
    files:     fileEntries,
    title,
    timestamp: Date.now(),
  });

  return Response.redirect('/light/posts/new?share=pending', 303);
}

// ── Cache strategy ────────────────────────────────────────────────────────────

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);

  // Strip query params for lookup so ?v=__BUILD_VERSION__ suffixes don't
  // prevent cache hits on versioned asset URLs.
  const cacheKey = new URL(request.url);
  cacheKey.search = '';
  const keyStr = cacheKey.toString();

  const cached = await cache.match(keyStr);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(keyStr, response.clone());
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}
