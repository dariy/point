/**
 * Point — Service Worker
 *
 * Responsibilities:
 *  1. Intercept POST /share-target (Web Share Target Level 2).
 *  2. Shell caching (stale-while-revalidate) for offline support.
 *  3. Offline API and Image serving.
 */

const CACHE_VERSION = 'v2';
const CACHE_NAME    = `point-${CACHE_VERSION}`;

// Assets to cache on install (SPA shell).
const SHELL_URLS = [
  '/',
  '/assets/js/app.js',
  '/assets/js/store.js',
  '/assets/js/router.js',
  '/assets/js/api/auth.js',
  '/assets/js/api/client.js',
  '/assets/js/api/settings.js',
  '/assets/js/utils/helpers.js',
  '/assets/js/components/Component.js',
  '/assets/js/components/shared/Toast.js',
  '/assets/css/main.css',
  '/assets/css/light.css',
  '/assets/images/favicon.svg',
  '/assets/images/favicon-128.png',
  '/assets/images/favicon-512.png',
  '/assets/images/favicon-dark-128.png',
  '/assets/images/favicon-dark-512.png',
];

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

const IDB_DB    = 'point-share';
const IDB_STORE = 'queue';

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
    req.onsuccess = () => {
      let result = req.result;
      if (query && storeName === 'meta') {
        // Return value property for meta records
        result = result ? result.value : null;
      }
      if (!query && storeName === 'posts' && Array.isArray(result)) {
        // Default sort for posts: published_at DESC, created_at DESC
        result = result.sort((a, b) => {
          const dateA = a.published_at || a.created_at;
          const dateB = b.published_at || b.created_at;
          return new Date(dateB) - new Date(dateA);
        });
      }
      res(result);
    };
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

  // 1. Share target: intercept POST entirely
  if (url.pathname === '/share-target' && request.method === 'POST') {
    event.respondWith(handleShareTarget(request));
    return;
  }

  // 2. Image intercept (path pattern /:year/:month/:filename)
  if (isMediaPath(url.pathname)) {
    event.respondWith(
      caches.match(request.url, { ignoreSearch: true, cacheName: 'point-images-full-v1' })
        .then(r => r || caches.match(request.url, { ignoreSearch: true, cacheName: 'point-images-v1' }))
        .then(r => r || (navigator.onLine ? fetch(request) : new Response('Not found', { status: 404 })))
        .catch(() => new Response('Not found', { status: 404 }))
    );
    return;
  }

  // 3. API reads: Network-first with IDB fallback
  if (url.pathname.startsWith('/api/') && request.method === 'GET') {
    event.respondWith(
      fetch(request)
        .catch(() => serveFromOfflineStore(request))
    );
    return;
  }

  // 4. API responses (non-GET) must never be cached in the shell cache.
  if (url.pathname.startsWith('/api/')) return;

  // 5. SW and manifest must not be cached.
  if (url.pathname === '/sw.js' || url.pathname === '/manifest.webmanifest') return;

  // 6. Navigation requests (HTML): cache-first (SPA shell).
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        // For SPA, any navigation request that doesn't match a specific file
        // should serve the root '/'.
        const cached = await cache.match('/');
        if (cached) return cached;

        try {
          const response = await fetch(request);
          if (response.status === 200) cache.put('/', response.clone()).catch(() => {});
          return response;
        } catch {
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

  // 7. Static assets: stale-while-revalidate.
  event.respondWith(staleWhileRevalidate(request));
});

// ── Handlers ──────────────────────────────────────────────────────────────────

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

function isMediaPath(path) {
  return /^\/\d{4}\/\d{2}\/[^/]+$/.test(path);
}

async function serveFromOfflineStore(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const page = parseInt(url.searchParams.get('page'), 10) || 1;
  const perPage = parseInt(url.searchParams.get('per_page'), 10) || 20;

  try {
    const allTags = await idbGet('tags');
    const allRelationships = await idbGet('tag_relationships');
    const settings = await idbGet('meta', 'blog_settings') || {};
    const minPosts = parseInt(settings.min_tag_posts_to_show || '0', 10);

    // Helper: Build tag hierarchy
    const buildTagTree = (parentID = null) => {
      return allTags
        .filter(t => {
          if (t.is_hidden) return false;
          const rels = allRelationships.filter(r => r.child_id === t.id);
          if (parentID === null) return rels.length === 0;
          return rels.some(r => r.parent_id === parentID);
        })
        .map(t => ({
          id: t.id,
          name: t.name,
          slug: t.slug,
          post_count: t.post_count,
          is_featured: t.is_featured,
          children: buildTagTree(t.id)
        }))
        .filter(t => t.is_featured || t.post_count >= minPosts || t.children.length > 0)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || a.name.localeCompare(b.name));
    };

    // 1. /api/pages/home
    if (path === '/api/pages/home') {
      const posts = await idbGet('posts');
      
      const tag_cloud = allTags
        .filter(t => t.post_count >= minPosts && !t.is_hidden)
        .map(t => ({
          name: t.name,
          slug: t.slug,
          count: t.post_count
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      const nav_tags = buildTagTree(null);

      const offset = (page - 1) * perPage;
      const paginatedPosts = posts.slice(offset, offset + perPage);

      return new Response(JSON.stringify({
        posts: paginatedPosts, 
        pagination: { 
          page, 
          per_page: perPage, 
          total: posts.length, 
          pages: Math.ceil(posts.length / perPage) 
        },
        tag_cloud, 
        nav_tags,
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
      return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // 2.1 /api/pages/tag/:slug
    const tagPageMatch = path.match(/^\/api\/pages\/tag\/([^/]+)$/);
    if (tagPageMatch) {
      const slug = tagPageMatch[1];
      const tag = allTags.find(t => t.slug === slug);
      if (tag) {
        const allPosts = await idbGet('posts');
        const posts = allPosts.filter(p => p.tags && p.tags.some(t => t.slug === slug));
        
        const offset = (page - 1) * perPage;
        const paginatedPosts = posts.slice(offset, offset + perPage);

        // Sub-nav for this tag
        const childItems = buildTagTree(tag.id);
        const rootNavTags = buildTagTree(null);

        // Breadcrumbs (reconstruct from relationships)
        const breadcrumbs = [];
        let curr = tag;
        while (curr) {
          const rel = allRelationships.find(r => r.child_id === curr.id);
          if (rel) {
            const parent = allTags.find(t => t.id === rel.parent_id);
            if (parent && parent.include_in_breadcrumbs) {
              breadcrumbs.unshift({
                id: parent.id,
                name: parent.name,
                slug: parent.slug,
                post_count: parent.post_count
              });
              curr = parent;
            } else {
              curr = null;
            }
          } else {
            curr = null;
          }
        }

        return new Response(JSON.stringify({
          tag: {
            ...tag,
            parents: [], 
            children: allTags.filter(t => allRelationships.some(r => r.parent_id === tag.id && r.child_id === t.id)),
            locations: []
          },
          breadcrumbs: breadcrumbs,
          posts: paginatedPosts,
          root_nav_tags: rootNavTags,
          pagination: { 
            page, 
            per_page: perPage, 
            total: posts.length, 
            pages: Math.ceil(posts.length / perPage) 
          },
          nav_tags: childItems
        }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Tag not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // 2.2 /api/pages/map
    if (path === '/api/pages/map') {
      const allLocs = await idbGet('tag_locations');
      const locMap = {};
      allLocs.forEach(l => locMap[l.tag_id] = l);

      const mapTags = allTags
        .filter(t => locMap[t.id])
        .map(t => ({
          name: t.name,
          slug: t.slug,
          post_count: t.post_count,
          lat: locMap[t.id].latitude,
          lng: locMap[t.id].longitude,
          type: 'other', // Simplified for offline
          years: []
        }));

      return new Response(JSON.stringify({ tags: mapTags }), { headers: { 'Content-Type': 'application/json' } });
    }

    // 3. /api/tags
    if (path === '/api/tags') {
      return new Response(JSON.stringify(allTags.map(t => ({ id: t.id, name: t.name, slug: t.slug, post_count: t.post_count }))), { headers: { 'Content-Type': 'application/json' } });
    }

    // 4. /api/posts/:id/navigation
    const navMatch = path.match(/^\/api\/posts\/(\d+)\/navigation$/);
    if (navMatch) {
      const id = parseInt(navMatch[1], 10);
      const posts = await idbGet('posts');
      const idx = posts.findIndex(p => p.id === id);
      if (idx !== -1) {
        const next = idx > 0 ? { id: posts[idx-1].id, title: posts[idx-1].title, slug: posts[idx-1].slug } : null;
        const prev = idx < posts.length - 1 ? { id: posts[idx+1].id, title: posts[idx+1].title, slug: posts[idx+1].slug } : null;
        return new Response(JSON.stringify({ prev, next }), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Post not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: 'Offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('[SW] Offline store error:', err);
    return new Response(JSON.stringify({ error: 'Offline store error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}s: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cacheKey = new URL(request.url);
  cacheKey.search = '';
  const keyStr = cacheKey.toString();

  const cached = await cache.match(keyStr);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.status === 200) cache.put(keyStr, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}
