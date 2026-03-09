# Web Share Target — Implementation Plan

**Date**: 2026-03-09
**Design**: [2026-03-09-web-share-target-design.md](./2026-03-09-web-share-target-design.md)
**Status**: Ready

---

## Step 1 — PWA manifest

**File**: `frontend/manifest.webmanifest` *(create)*

```json
{
  "name": "Point",
  "short_name": "Point",
  "description": "Personal photo blog",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0a0a0a",
  "theme_color": "#0a0a0a",
  "icons": [
    { "src": "/assets/images/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any maskable" },
    { "src": "/assets/images/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ],
  "share_target": {
    "action": "/share-target",
    "method": "POST",
    "enctype": "multipart/form-data",
    "params": {
      "title": "title",
      "text":  "text",
      "files": [{ "name": "media", "accept": ["image/*", "video/*"] }]
    }
  }
}
```

**File**: `frontend/index.html` *(modify)*

Add to `<head>`:
```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0a0a0a" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
```

---

## Step 2 — Go routes for manifest and SW

**File**: `api/cmd/api/main.go` *(modify)*

Add before the `e.GET("/*", ...)` SPA fallback:

```go
// PWA: manifest and service worker must be at root scope
if fi, err := os.Stat(filepath.Join(cfg.FrontendDir, "manifest.webmanifest")); err == nil && !fi.IsDir() {
    e.GET("/manifest.webmanifest", func(c echo.Context) error {
        c.Response().Header().Set("Content-Type", "application/manifest+json")
        return c.File(filepath.Join(cfg.FrontendDir, "manifest.webmanifest"))
    })
}
if fi, err := os.Stat(filepath.Join(cfg.FrontendDir, "sw.js")); err == nil && !fi.IsDir() {
    e.GET("/sw.js", func(c echo.Context) error {
        c.Response().Header().Set("Cache-Control", "no-cache")
        return c.File(filepath.Join(cfg.FrontendDir, "sw.js"))
    })
}
```

---

## Step 3 — IndexedDB utility

**File**: `frontend/src/utils/idb.js` *(create)*

Exports:
- `addShareEntry(entry)` — put entry into `queue` store
- `getAllShareEntries()` — getAll from `queue` store, sorted by timestamp
- `clearShareEntries()` — clear entire store

Schema: DB `point-share` v1, object store `queue` with `keyPath: 'id'`.

---

## Step 4 — Service worker

**File**: `frontend/sw.js` *(create)*

### Constants
```javascript
const CACHE_VERSION = 'v1';
const CACHE_NAME    = `point-${CACHE_VERSION}`;
const SHARE_URL     = '/share-target';
const SHELL_URLS    = ['/', '/assets/js/app.js', '/assets/css/main.css',
                       '/assets/css/light.css', '/assets/images/favicon.svg'];
```

Note: SW uses a self-contained IDB helper (no import of `idb.js`) because SW module imports require explicit `type: 'module'` in the registration call and add complexity. Duplicate the 3-function IDB logic inline in `sw.js`.

### `install` event
- Cache all `SHELL_URLS`.
- Call `self.skipWaiting()`.

### `activate` event
- Delete all caches whose name !== `CACHE_NAME`.
- Call `self.clients.claim()`.

### `fetch` event
- `POST /share-target` → call `handleShareTarget(event.request)`, respond with result.
- `/api/*` → network-only (pass through, do not cache).
- `/manifest.webmanifest`, `/sw.js` → network-only (must not cache these in SW).
- Everything else → stale-while-revalidate: check cache first, respond immediately, fetch and update cache in background.

### `handleShareTarget(request)`
```
formData = await request.formData()
files    = formData.getAll('media')   // File objects
title    = formData.get('title') || ''

for each file:
  data = await file.arrayBuffer()
  fileEntries.push({ name: file.name, type: file.type, data })

entry = { id: crypto.randomUUID(), files: fileEntries, title, timestamp: Date.now() }
await idbPut(entry)

return Response.redirect('/light/posts/new?share=pending', 303)
```

---

## Step 5 — Register SW in bootstrap

**File**: `frontend/src/app.js` *(modify)*

At the top of `bootstrap()`, before any awaits:

```javascript
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.warn('[SW] Registration failed:', err);
  });
}
```

---

## Step 6 — Router: ?next= on auth guard

**File**: `frontend/src/router.js` *(modify)*

In `_render()`, replace:
```javascript
this.navigate(this._loginPath, { replace: true });
```
with:
```javascript
const next = encodeURIComponent(fullPath);
this.navigate(`${this._loginPath}?next=${next}`, { replace: true });
```

---

## Step 7 — LoginPage: follow ?next= after login

**File**: `frontend/src/pages/light/LoginPage.js` *(modify)*

In `afterRender()`, replace both `navigate('/light', ...)` calls with a helper:

```javascript
const _redirect = () => {
  const next = this.props?.query?.next;
  navigate(next ? decodeURIComponent(next) : '/light', { replace: true });
};
```

Apply `_redirect()` on successful login and on the already-logged-in auto-redirect.

---

## Step 8 — PostEditPage: drain IDB queue on mount

**File**: `frontend/src/pages/light/PostEditPage.js` *(modify)*

### Import
```javascript
import { getAllShareEntries, clearShareEntries } from '../../utils/idb.js';
```

### In `mount()`
After `super.mount()` and the existing `_loadPost` call, add:

```javascript
if (this.props.query?.share === 'pending') {
  // Wait for the existing loadPost (edit mode) or a tick (new post) before processing.
  // Use requestAnimationFrame to ensure afterRender has run and the editor is mounted.
  requestAnimationFrame(() => this._processShareQueue());
}
```

### New method `_processShareQueue()`

```
entries = await getAllShareEntries()
if (!entries.length) return

sort entries by timestamp ascending

[current, ...backlog] = entries

// Process current entry into the open editor
for each file in current.files:
  blob = new Blob([file.data], { type: file.type })
  f    = new File([blob], file.name, { type: file.type })
  await _uploadAndInsert(f)

// title pre-fill if editor title is empty and share had a title
if (current.title && !this.$('#title-input')?.value.trim()):
  this.$('#title-input').value = current.title

// Process backlog entries → one draft post per entry
for each entry in backlog:
  post = await createPost({ title: entry.title || '', status: 'draft', content: '' })
  for each file in entry.files:
    blob = new Blob([file.data], { type: file.type })
    f    = new File([blob], file.name, { type: file.type })
    media = await uploadMedia(f, { post_id: post.id })
    postContent += media.path + '\n'
  await updatePost(post.id, { content: postContent.trim() })

await clearShareEntries()

if (backlog.length > 0):
  store.set('toast', {
    message: `${backlog.length} offline share(s) saved as drafts.`,
    type: 'success'
  })
```

---

## Step 9 — PWA icons

Generate two PNG icons from the existing SVG favicon and save to:
- `frontend/images/icon-192.png`
- `frontend/images/icon-512.png`

This is a manual step (design asset, not code). The rest of the feature works without them; Android will show a default icon in the share sheet.

---

## Testing checklist

- [ ] `GET /manifest.webmanifest` returns JSON with `Content-Type: application/manifest+json`
- [ ] `GET /sw.js` returns JS with `Cache-Control: no-cache`
- [ ] SW registers without errors in browser DevTools → Application → Service Workers
- [ ] App is installable (browser shows install prompt / Add to Home Screen)
- [ ] Share from Google Photos → Point appears in share sheet
- [ ] Sharing a photo while online and logged in → lands on New Post with image inserted
- [ ] Sharing while offline → IDB entry written; on reconnect + page load → image uploaded and inserted
- [ ] Sharing while not logged in → redirected to login with `?next=` → after login lands on post creation with image
- [ ] Sharing 3 photos from separate offline shares → 1 post editor open + 2 draft posts created + toast shown
- [ ] Sharing a batch of 3 photos in one share → all 3 inserted into one post
- [ ] Navigating to `/light/login` directly (not from share) still redirects to `/light` after login
- [ ] Already-logged-in auto-redirect on login page still works
- [ ] CSS bundle switch (`/light/*` → admin CSS) still works correctly on share target redirect path

---

## Files summary

| Action | File |
|---|---|
| Create | `frontend/manifest.webmanifest` |
| Create | `frontend/sw.js` |
| Create | `frontend/src/utils/idb.js` |
| Modify | `frontend/index.html` |
| Modify | `frontend/src/app.js` |
| Modify | `frontend/src/router.js` |
| Modify | `frontend/src/pages/light/LoginPage.js` |
| Modify | `frontend/src/pages/light/PostEditPage.js` |
| Modify | `api/cmd/api/main.go` |
| Manual | `frontend/images/icon-192.png` + `icon-512.png` |
