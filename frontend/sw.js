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

const CACHE_VERSION = 'v2';
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

// ── Offline Store IndexedDB (point-offline) ──────────────────────────────────
const OFFLINE_DB = 'point-offline';
const OFFLINE_VERSION = 1;

function offlineDbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OFFLINE_DB, OFFLINE_VERSION);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function idbGet(storeName, query) {
  const db = await offlineDbOpen();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  return new Promise((res, rej) => {
    const req = query ? store.get(query) : store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

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
      .then(async (cache) => {
        // Cache each asset individually so one bad URL cannot abort the whole
        // install and leave the shell (especially '/') uncached.
        await Promise.allSettled(
          SHELL_URLS.map((url) =>
            cache.add(url).catch((err) =>
              console.warn('[SW] Failed to pre-cache:', url, err),
            ),
          ),
        );
      })
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

  // Offline API reads → serve from IDB
  if (!navigator.onLine && url.pathname.startsWith('/api/')) {
    event.respondWith(serveFromOfflineStore(request));
    return;
  }

  // Image intercept (path pattern /:year/:month/:filename)
  if (!navigator.onLine && isMediaPath(url.pathname)) {
    event.respondWith(
      caches.match(request.url, { cacheName: 'point-images-full-v1' })
        .then(r => r || caches.match(request.url, { cacheName: 'point-images-v1' }))
        .then(r => r || fetch(request))
    );
    return;
  }

  // API responses must never be cached.
  if (url.pathname.startsWith('/api/')) return;

  // SW and manifest must not be cached by the SW itself.
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return;

  // Navigation requests (HTML): cache-first (serve the pre-cached SPA shell).
  // If the cache is cold (install-time pre-cache failed), fetch from the
  // network and warm the cache so the next offline reload will succeed.
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match('/');
        if (cached) return cached;

        // Cache miss — fetch and store for next time.
        try {
          const response = await fetch(request);
          if (response.status === 200) cache.put('/', response.clone()).catch(() => {});
          return response;
        } catch {
          // Offline and cold cache — nothing we can serve.
          return new Response(
            '<!doctype html><html><head><meta charset="utf-8"><title>Offline</title></head>'
            + '<body style="font-family:sans-serif;padding:2rem">'
            + '<h1>You\'re offline</h1>'
            + '<p>Reload the page once you\'re back online.</p>'
            + '</body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        }
      }),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});
          return response;
        } catch {
          // Offline and cold cache — nothing we can serve.
          return new Response(
            '<!doctype html><html><head><meta charset="utf-8"><title>Offline</title></head>'
            + '<body style="font-family:sans-serif;padding:2rem">'
            + '<h1>You\'re offline</h1>'
            + '<p>Reload the page once you\'re back online.</p>'
            + '</body></html>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        }
      }),
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

// ── Offline Store Handlers ──────────────────────────────────────────────────

function isMediaPath(path) {
  // Matches /YYYY/MM/filename
  return /^\/\d{4}\/\d{2}\/[^/]+$/.test(path);
}

async function serveFromOfflineStore(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  try {
    // 1. /api/pages/home
    if (path === '/api/pages/home') {
      const posts = await idbGet('posts');
      const settings = await idbGet('meta', 'blog_settings') || {};
      
      // Minimal mock of what GetHomePage returns
      return new Response(JSON.stringify({
        posts: posts.slice(0, 10), // Basic pagination mock
        pagination: { page: 1, per_page: 10, total: posts.length, pages: Math.ceil(posts.length / 10) },
        tag_cloud: [], 
        nav_tags: [],
        settings: settings
      }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 2. /api/posts/slug/:slug
    const postSlugMatch = path.match(/^\/api\/posts\/slug\/([^/]+)$/);
    if (postSlugMatch) {
      const slug = postSlugMatch[1];
      const posts = await idbGet('posts');
      const post = posts.find(p => p.slug === slug);
      if (post) {
        return new Response(JSON.stringify(post), { headers: { 'Content-Type': 'application/json' } });
      }
    }

    // 3. /api/tags
    if (path === '/api/tags') {
      const tags = await idbGet('tags');
      return new Response(JSON.stringify(jsonTags(tags)), { headers: { 'Content-Type': 'application/json' } });
    }

    // Default fallback for other API calls when offline
    return new Response(JSON.stringify({ error: 'Offline' }), { 
      status: 503, 
      headers: { 'Content-Type': 'application/json' } 
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json' } 
    });
  }
}

function jsonTags(tags) {
  return tags.map(t => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    post_count: t.post_count
  }));
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
      // Only cache full 200 responses — the Cache API rejects 206 Partial
      // Content (used by range requests for audio/video) and other non-200
      // 2xx statuses.  Ignore the put() promise so a failure never surfaces
      // as an unhandled rejection.
      if (response.status === 200) cache.put(keyStr, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}
