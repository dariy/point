# Web Share Target — Design

**Date**: 2026-03-09
**Status**: Approved

## Problem

There is no way to share photos directly from mobile apps (Google Photos, Files, camera roll) into Point. The current workflow requires:

1. Open a browser, navigate to the admin.
2. Log in (if session expired).
3. Navigate to New Post.
4. Manually pick a file or drag-and-drop.

This is too many steps for a personal photo blog whose primary use-case is rapid capture-and-post from a mobile device.

## Goal

Allow the user to share one or more photos from any app on their device directly into a new Point post, with the upload and post-creation handled automatically. Offline shares (no connectivity at share time) must be queued and processed transparently when connectivity returns.

---

## Solution: Web Share Target Level 2

[Web Share Target Level 2](https://w3c.github.io/web-share-target/) allows an installed PWA to register as a share destination. When the user picks the app from the system share sheet, the OS sends a `POST` request to a registered URL with the shared files as `multipart/form-data`.

### Why Level 2 (not Level 1)

Level 1 only receives `title`/`text`/`url` as GET query params — no files. Level 2 adds file support. Since the primary use-case is sharing photos, Level 1 alone is insufficient.

### Constraints

- Web Share Target only works when the app is **installed as a PWA** (added to home screen / installed via browser prompt). This requires HTTPS in production.
- The service worker **cannot access HttpOnly session cookies**. It cannot upload files directly to `/api/media/upload`. File data must be stored in IndexedDB by the SW and uploaded by the page once the authenticated session cookie is available.
- The `manifest.webmanifest` and `sw.js` files must be served at the **root scope** (`/`). The Go server currently has no explicit routes for these — a `/*` SPA fallback catches everything. Explicit routes must be added before the fallback.

---

## Architecture

### Share flow (online, authenticated)

```
User taps Share → picks Point in system sheet
  OS sends POST /share-target  (multipart/form-data; files in field "media")
  ↓
  Service Worker intercepts (before the Go server sees the request)
  SW reads files from formData
  SW saves entry to IndexedDB: { id, files: [{name, type, data: ArrayBuffer}], title, timestamp }
  SW returns 303 → /light/posts/new?share=pending
  ↓
  Browser navigates to /light/posts/new?share=pending
  SPA router loads PostEditPage
  PostEditPage.mount() detects query.share === 'pending'
  Reads all entries from IndexedDB
  First entry: upload each file → insert path into visual editor
  Extra queued entries (offline backlog): create draft posts, upload files into each
  Clears IndexedDB
```

### Share flow (offline or not yet authenticated)

```
[Same SW interception and IDB save as above]
SW returns 303 → /light/posts/new?share=pending
  ↓
  If offline: SPA served from SW shell cache
  If not authenticated: router auth guard redirects to
    /light/login?next=%2Flight%2Fposts%2Fnew%3Fshare%3Dpending
  User logs in → LoginPage follows ?next= param
  → /light/posts/new?share=pending
  PostEditPage drains IDB as above
```

### Multiple queued shares (offline backlog)

If the user shared three separate times while offline, there are three IDB entries. When they next open the app online:

- **Entry 0** (first/current): all files inserted into the new post editor currently open.
- **Entry 1..N** (backlog): one draft post created per entry via `POST /api/posts`, files uploaded with `post_id` set.

If a single share event contained multiple files (e.g. multi-select in Google Photos), all those files go into the same post.

---

## Components

### New files

| File | Purpose |
|---|---|
| `frontend/manifest.webmanifest` | PWA manifest — declares `share_target`, icons, display mode |
| `frontend/sw.js` | Service worker — share target interception, IDB queue, shell caching |
| `frontend/src/utils/idb.js` | Thin IndexedDB wrapper for the share queue |

### Modified files

| File | Change |
|---|---|
| `frontend/index.html` | Add `<link rel="manifest">`, `<meta name="theme-color">` |
| `frontend/src/app.js` | Register SW in `bootstrap()` |
| `frontend/src/router.js` | Auth guard redirect includes `?next=<currentPath>` |
| `frontend/src/pages/light/LoginPage.js` | After login, navigate to `props.query.next` if present |
| `frontend/src/pages/light/PostEditPage.js` | On mount with `?share=pending`, drain IDB queue |
| `api/cmd/api/main.go` | Add explicit GET routes for `/manifest.webmanifest` and `/sw.js` |

---

## IndexedDB schema

```
Database:     point-share  (version 1)
Object store: queue  (keyPath: 'id')

Entry shape:
{
  id:        string,   // crypto.randomUUID()
  files:     Array<{ name: string, type: string, data: ArrayBuffer }>,
  title:     string,   // from share title param, may be empty
  timestamp: number,   // Date.now() at share time
}
```

Entries are cleared atomically after all uploads and post creations succeed for a batch. On partial failure (e.g. network error mid-upload), the entry is left in IDB so the next page visit can retry.

---

## Service worker caching strategy

| Resource | Strategy | Rationale |
|---|---|---|
| `POST /share-target` | SW handles entirely — never reaches Go server | Core feature |
| `/` and all SPA routes | Stale-while-revalidate | Offline shell |
| `/assets/js/*`, `/assets/css/*`, `/assets/images/*` | Stale-while-revalidate | Offline shell |
| `/api/*` | Network-only | Never cache API responses |
| `/manifest.webmanifest`, `/sw.js` | Not cached by SW (handled by HTTP cache) | Avoid circular caching |

Cache name is versioned (`point-v1`). On SW `activate`, all caches with a different name are deleted.

The Go server already sets `Cache-Control: no-cache` on `/assets/js/*` and `/assets/css/*`. The SW cache is independent of the HTTP cache, so stale-while-revalidate works regardless.

---

## PWA manifest icons

Web Share Target on Android requires at least one maskable or any-purpose PNG icon ≥ 192×192. The project currently only has `favicon.svg`. Two PNG icons must be generated:

- `frontend/images/icon-192.png` — 192×192
- `frontend/images/icon-512.png` — 512×512

Until these are created the manifest will reference them but Android may not show the app icon correctly in the share sheet. The share target functionality itself is unaffected.

---

## Backend changes

No new API endpoints. Two new static file routes in `main.go`:

```go
// Serve PWA manifest and service worker at root scope (must be before /* fallback)
e.GET("/manifest.webmanifest", func(c echo.Context) error {
    f := filepath.Join(cfg.FrontendDir, "manifest.webmanifest")
    c.Response().Header().Set("Content-Type", "application/manifest+json")
    return c.File(f)
})
e.GET("/sw.js", func(c echo.Context) error {
    f := filepath.Join(cfg.FrontendDir, "sw.js")
    c.Response().Header().Set("Cache-Control", "no-cache")
    return c.File(f)
})
```

`sw.js` is served with `Cache-Control: no-cache` so the browser always checks for a new version. The manifest is served with `Content-Type: application/manifest+json` for spec compliance.

---

## Router: ?next= redirect-after-login

Currently `router.js` auth guard redirects to `/light/login` with no return path. Two changes:

1. **`router.js`**: encode the full path+query as `?next=` when redirecting to login.
2. **`LoginPage.js`**: after successful login, read `this.props.query.next`; if present navigate there (decoded), otherwise fall back to `/light`.

The already-logged-in auto-redirect in `LoginPage.afterRender()` follows the same `?next=` logic.

---

## Limitations and future work

- Web Share Target requires HTTPS. In local development (HTTP) the SW will register but share target registration in the manifest will be ignored by the browser. Testing requires a production deployment or a tunneled HTTPS dev environment.
- The SW cannot deduplicate shares across browser sessions or devices — IDB is per-origin per-browser.
- No push notification is shown when offline shares are processed. A future enhancement could dispatch a Web Notification when backlog posts are created.
- Video files are accepted by the manifest (`video/*`) but the backend's thumbnail generation only handles images. Videos are uploaded as raw files with no thumbnail.
