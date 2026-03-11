# Offline Standalone Experience

**Date:** 2026-03-10
**Branch:** offline_standalone_experience
**Status:** Planning — bootstrap fix already shipped

---

## Context

Point is a self-hosted photo blog with an existing PWA shell but zero data caching. All API requests pass through to the server; going offline shows "Failed to start the application."

Two phases:
1. **Public offline reading** — Admin downloads all public posts, tags, and images. The public blog works completely offline.
2. **Admin offline CRUD** — Create/edit/delete posts/tags/media while offline, sync to server on reconnect.

Single-device use. No conflict resolution needed. Sync halts on error and alerts the user.

---

## Already Shipped

**Bootstrap crash fix** (`frontend/src/app.js`, `frontend/sw.js`):
- `getMe()` was the only bootstrap step without error handling — network failure crashed the app
- Wrapped in try/catch with null fallback; offline users are treated as unauthenticated
- Added direct static imports of `app.js` to `SHELL_URLS` for pre-caching on SW install

---

## Architecture

```
point-offline IDB (structured data)         Cache API (blobs)
├── posts[]                                  ├── point-images-v1 (thumbnails)
├── tags[]                                   └── point-images-full-v1 (originals)
├── tag_relationships[]
├── tag_locations[]
├── media[]           ←── snapshot download
├── mutation_queue[]  ←── offline admin writes
└── meta              ←── { last_sync, image_scope }

Service Worker (sw.js)
├── Intercepts offline API reads → reconstruct Response from IDB
├── Intercepts offline image fetches → serve from Cache API
└── Online API writes pass through (queue handled in client.js)
```

---

## Phase 1: Public Offline Snapshot

### Backend — 2 new routes (`api/internal/api/offline.go`)

Both require authentication.

**`GET /api/offline/stats`**
```json
{ "post_count": 143, "image_count": 891, "thumbnail_bytes": 148900000, "original_bytes": 8940000000 }
```
Queries DB for counts; walks `STORAGE_PATH` for file sizes.

**`GET /api/offline/snapshot`**
```json
{
  "posts": [...],           // all published posts with embedded tags
  "tags": [...],            // all tags with hierarchy flags
  "tag_relationships": [...],
  "tag_locations": [...],
  "media": [...],           // images only (file_type='image', is_public=1)
  "exported_at": "2026-03-10T..."
}
```
Each media item includes both `thumbnail_url` and `original_url`.
Register both routes in `api/cmd/api/main.go`.

### Frontend — Download UI

**New panel in `/light/system`** (`frontend/src/pages/light/SystemPage.js`):
- "Download for offline" button
- Calls `/api/offline/stats` → dialog:
  *"Thumbnails: 142 MB (891 images) | Full resolution: 8.5 GB — choose scope"*
- Radio: **Thumbnails only** / **Thumbnails + originals**
- Confirm → download progress bar → "Last synced: just now"

**New files:**
- `frontend/src/api/offline.js` — `getOfflineStats()`, `getSnapshot()`
- `frontend/src/utils/offlineStore.js` — IDB for `point-offline` database (extends `idb.js` pattern)
- `frontend/src/utils/imageCache.js` — Cache API bulk pre-cache with progress callback

**`offlineStore.js` IDB schema (`point-offline` v1):**
- Stores: `posts` (keyPath: `id`), `tags` (keyPath: `id`), `tag_relationships`, `tag_locations`, `media`, `mutation_queue`, `meta`
- Key methods: `saveSnapshot(data)`, `getPost(slug)`, `listPosts(params)`, `getTags()`, `getMeta()`, `saveMeta(data)`

**Download sequence:**
1. `GET /api/offline/snapshot` → `offlineStore.saveSnapshot(data)`
2. Extract all image URLs from snapshot based on chosen scope
3. `imageCache.preCacheImages(urls, cacheName, onProgress)` — fetch + store in Cache API
4. `offlineStore.saveMeta({ last_sync: Date.now(), image_scope })`
5. Update `store.set('offline_status', { available: true, last_sync, image_scope })`

### Service Worker Changes (`frontend/sw.js`)

Add offline API intercept **before** the existing "never cache API" rule:

```js
// Offline API reads → serve from IDB
if (!navigator.onLine && url.pathname.startsWith('/api/')) {
  event.respondWith(serveFromOfflineStore(request));
  return;
}
```

**URL → IDB mapping:**
| URL pattern | IDB query |
|---|---|
| `/api/pages/home` | compose posts + tags from IDB |
| `/api/posts?*` | paginate `posts` store |
| `/api/posts/slug/:slug` | lookup by slug |
| `/api/tags*` | `tags` store |
| `/api/pages/tag/:slug` | posts filtered by tag |
| `/api/pages/tags` | tags with hierarchy |
| `/api/pages/map` | `tag_locations` join |

**Image intercept** (path pattern `/:year/:month/:filename`):
```js
if (!navigator.onLine && isMediaPath(url.pathname)) {
  event.respondWith(
    caches.match(request.url, { cacheName: 'point-images-full-v1' })
      .then(r => r || caches.match(request.url, { cacheName: 'point-images-v1' }))
      .then(r => r || fetch(request))
  );
  return;
}
```

The SW accesses IDB via the same helpers as the app (inlined or via `importScripts`).

---

## Phase 2: Admin Offline CRUD + Sync

### Mutation Queue (IDB `mutation_queue` store)

```js
{
  id: 'local_<timestamp>_<rand>',
  timestamp: number,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  body: object | null,
  blob_key: string | null,    // references 'blobs' store entry for file uploads
  status: 'pending' | 'syncing' | 'failed',
  error: string | null,
  temp_id_map: Record<string, string | null>  // tempId → realId (filled during sync)
}
```

Add `blobs` store to `point-offline` IDB (keyPath: `id`, value: ArrayBuffer).

### Offline Interceptor (`frontend/src/api/client.js`)

Wrap mutating methods (`post`, `put`, `patch`, `delete`, `upload`):

```js
if (!navigator.onLine) {
  return offlineQueue.enqueue(method, url, body, file);
}
```

`enqueue()`:
1. Generate `local_<ts>_<rand>` temp ID for POST operations
2. Store op in `mutation_queue`
3. Apply optimistic update to IDB data stores (so UI reflects the change immediately)
4. Return `{ id: tempId, ...body }` as fake success response

### Sync Engine (`frontend/src/utils/sync.js`)

Exports: `syncQueue()`, `getSyncStatus()`

**`syncQueue()` algorithm:**
1. Load all `status: 'pending'` ops ordered by timestamp
2. Mark as `syncing`
3. For each op:
   - If `blob_key`: read blob from IDB → `POST /api/media/upload` → capture real `media.id`
   - Substitute real IDs for temp IDs in body (using resolved `temp_id_map` from prior ops in this batch)
   - Execute HTTP request (bypasses offline check — we know we're online)
   - **On success:** delete op from queue; record `{ tempId: realId }` for downstream ops
   - **On failure:** mark `status: 'failed'`, set `error`, **halt**, dispatch `sync:failed` event
4. On full success: dispatch `sync:complete`, update `meta.last_sync`

**Triggers:**
- `window.addEventListener('online', syncQueue)`
- Manual "Sync now" button in System panel

### Admin UI Changes

**`AdminLayout` component** — sync status pill in header:
- `● N pending` — offline, queue has items (gray)
- `⟳ Syncing…` — draining queue (blue)
- `✓ Synced` — all clear, fades after 3s (green)
- `⚠ Sync failed` — halted, clickable → System page (red)

**`/light/system` Sync panel:**
- Pending operation count + last successful sync timestamp
- "Sync now" button (disabled when offline or queue empty)
- Error detail card on failure (failed op URL + server error message)
- "Dismiss & retry" button → resets failed op to pending, re-triggers sync

### Temp ID Resolution

- Local creates return `{ id: 'local_<ts>_<rand>', ... }` immediately
- Optimistic IDB records use temp IDs as keys
- After sync resolves a create: update IDB record with real server ID, rewrite downstream queue op bodies

---

## Critical Files

| File | Change |
|------|--------|
| `api/internal/api/offline.go` | **New** — stats + snapshot handlers |
| `api/cmd/api/main.go` | Register 2 new routes |
| `frontend/sw.js` | Add offline API + image intercept layer |
| `frontend/src/utils/offlineStore.js` | **New** — IDB for `point-offline` |
| `frontend/src/utils/imageCache.js` | **New** — Cache API bulk pre-caching |
| `frontend/src/utils/sync.js` | **New** — mutation queue drain engine |
| `frontend/src/api/offline.js` | **New** — stats + snapshot API client |
| `frontend/src/api/client.js` | Add offline interceptor to mutating methods |
| `frontend/src/pages/light/SystemPage.js` | Add Offline + Sync panels |
| `frontend/src/components/light/AdminLayout.js` | Add sync status pill |
| `frontend/src/store.js` | Add `offline_status` key |

---

## Build Order

1. **Backend:** `offline.go` (stats + snapshot) → register routes in `main.go`
2. **Frontend IDB:** `offlineStore.js` (shared by SW and app)
3. **Frontend API/cache:** `offline.js` + `imageCache.js`
4. **SW:** Add offline intercept layer to `sw.js`
5. **Frontend UI — Phase 1:** System page offline panel + download flow + progress bar
6. **Phase 2 queue:** Offline interceptor in `client.js` + `sync.js`
7. **Frontend UI — Phase 2:** AdminLayout sync pill + System sync panel

---

## Verification

**Phase 1 — public offline:**
1. Log in, go to `/light/system`, click "Download for offline"
2. Dialog shows realistic byte counts for both scopes
3. Select thumbnails → progress bar fills → "Last synced: just now"
4. DevTools → Application → IndexedDB: `point-offline` contains posts/tags/media
5. DevTools → Application → Cache Storage: `point-images-v1` has thumbnail URLs
6. Enable DevTools offline mode
7. Navigate to `/`, `/post/:slug`, `/tag/:slug`, `/tags`, `/map` — all render
8. Images display (no broken icons)

**Phase 2 — admin offline:**
1. Enable offline mode in DevTools
2. Create a new post → appears in list immediately (optimistic)
3. Edit an existing post → changes appear immediately
4. Header shows "1 pending" pill
5. Disable offline mode → "Syncing…" → "✓ Synced"
6. Verify server has changes (check via API or DB)
7. Test error path: break a queued op → sync → "⚠ Sync failed" + error detail shown
8. "Dismiss & retry" → re-attempts → succeeds
