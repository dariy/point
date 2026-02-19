# Refactoring Progress

> **Started**: 2026-02-19
> **Architecture**: Frontend / Backend Separation
> **Plan documents**: [REFACTORING.md](./REFACTORING.md) · [FRONTEND_ARCHITECTURE.md](./FRONTEND_ARCHITECTURE.md) · [API_CHANGES.md](./API_CHANGES.md)

---

## Status Overview

| Phase | Name | Status | Tests |
|-------|------|--------|-------|
| **A** | Backend — Pure JSON API | ✅ Complete | 346 pass |
| **B** | Frontend — SPA Scaffold | ✅ Complete | — |
| **C** | Public Blog Migration | ✅ Complete | — |
| **D** | Admin (Light) Migration | ✅ Complete | — |
| **E** | Cleanup & Hardening | ✅ Complete | — |

---

## Phase A — Backend: Pure JSON API ✅

**Completed**: 2026-02-19
**Tests**: 346 passed, 0 failed (was 157 collected before phase, some deleted)

### What changed

#### New files
| File | Purpose |
|------|---------|
| `app/api/pages.py` | Compound page endpoints: `/api/pages/home`, `/api/pages/tag/{slug}`, `/api/pages/tags` |
| `app/api/feeds.py` | Backend XML/text routes: `/feed.xml`, `/sitemap.xml`, `/robots.txt` |

#### Modified files
| File | Change |
|------|--------|
| `app/main.py` | Removed Jinja2; updated OpenAPI to `/api/docs`; CORS from config; added feeds + pages routers; mounted frontend static dirs; added SPA fallback (last route) |
| `app/config.py` | Added `cors_origins: list[str]` field (env: `CORS_ORIGINS`) |
| `app/api/settings.py` | Added `GET /api/settings/public` (no auth, returns public blog config) |
| `app/api/__init__.py` | Removed `light`, `public`; added `feeds`, `pages` |

#### Deleted files
| File | Reason |
|------|--------|
| `app/api/light.py` | Admin HTML routes replaced by SPA |
| `app/api/public.py` | Blog HTML routes replaced by SPA; feeds moved to `feeds.py` |
| `app/utils/template_helpers.py` | Jinja2 filter helpers no longer needed |
| `app/templates/` | All 27 Jinja2 templates replaced by SPA |
| `tests/public/` | Tests for deleted server-rendered public routes |
| `tests/light/` | Tests for deleted server-rendered admin routes |
| `tests/utils/test_template_helpers.py` | Tests for deleted template helpers |

#### Updated tests
| File | Change |
|------|--------|
| `tests/infrastructure/test_main.py` | Removed server-rendered route test classes; added `TestSPAFallback` and `TestFeedsEndpoints` |
| `tests/system/test_system_management.py` | Updated `test_root_access` / `test_root_content_type` to accept SPA fallback behavior |
| `tests/posts/test_post_integrations.py` | Replaced `/light/posts/new` HTML route hit with `/api/media/{id}` API call |

### Phase A checklist

- [x] CORS middleware config-driven (`cors_origins` in `Settings`)
- [x] OpenAPI metadata: title, description, tag groups at `/api/docs` + `/api/redoc`
- [x] All routes have `summary`, `response_model`, `tags`
- [x] `GET /api/settings/public` — no auth, returns public blog settings
- [x] `GET /api/pages/home` — posts + tag cloud + settings compound endpoint
- [x] `GET /api/pages/tag/{slug}` — tag + breadcrumbs + posts compound endpoint
- [x] `GET /api/pages/tags` — full tag list with hierarchy
- [x] Auth routes return JSON only (no redirects) — was already the case
- [x] `GET /feed.xml` — RSS 2.0, no Jinja2
- [x] `GET /sitemap.xml` — XML sitemap, no Jinja2
- [x] `GET /robots.txt` — plain text
- [x] SPA fallback route (serves `frontend/index.html`, last registered)
- [x] `app/api/light.py` deleted
- [x] `app/api/public.py` deleted
- [x] `app/utils/template_helpers.py` deleted
- [x] `app/templates/` directory deleted
- [x] `jinja2` import removed from `main.py`
- [x] Tests updated: 346 passing, 0 failing

---

## Phase B — Frontend: SPA Scaffold ✅

**Completed**: 2026-02-19

### Files created

| File | Purpose |
|------|---------|
| `frontend/index.html` | SPA shell — single mount point, loads `app.js` as ES module |
| `frontend/src/app.js` | Bootstrap: settings → auth check → theme → router start |
| `frontend/src/router.js` | History API router — lazy loading, auth guard, link interception |
| `frontend/src/store.js` | Reactive pub/sub key-value store |
| `frontend/src/components/Component.js` | Base component class: `render()`, `setState()`, `mountChild()`, lifecycle |
| `frontend/src/api/client.js` | Fetch wrapper: JSON, credentials, 401 event, FormData upload |
| `frontend/src/api/auth.js` | `login`, `logout`, `getMe` |
| `frontend/src/api/posts.js` | Full CRUD + status, slug lookup, navigation, preview |
| `frontend/src/api/media.js` | List, upload, update, delete |
| `frontend/src/api/tags.js` | CRUD + reorder |
| `frontend/src/api/settings.js` | Public + admin settings |
| `frontend/src/api/system.js` | Stats, logs, backups, cache flush |
| `frontend/src/api/pages.js` | Compound page endpoints (home, tag, tags index) |
| `frontend/src/utils/helpers.js` | `escapeHtml`, `safeUrl`, debounce, throttle, `createElement`, `navigate` |
| `frontend/src/utils/formatters.js` | Date, datetime, file size, truncate, `htmlExcerpt`, `formatCount` |
| `frontend/css/` | CSS migrated from `app/static/css/` (light, public, common) |
| `frontend/vendor/` | Vendor libs migrated from `app/static/vendor/` (Leaflet) |

### Phase B checklist

- [x] `frontend/index.html` SPA shell
- [x] `frontend/src/store.js` reactive store
- [x] `frontend/src/components/Component.js` base class
- [x] `frontend/src/utils/helpers.js`
- [x] `frontend/src/utils/formatters.js`
- [x] `frontend/src/api/client.js` fetch wrapper
- [x] `frontend/src/api/{auth,posts,media,tags,settings,system,pages}.js`
- [x] `frontend/src/router.js` History API router with lazy loading + auth guard
- [x] `frontend/src/app.js` bootstrap
- [x] `frontend/css/` CSS migrated
- [x] `frontend/vendor/` vendor libs migrated

See [FRONTEND_ARCHITECTURE.md](./FRONTEND_ARCHITECTURE.md) for full spec.

---

## Phase C — Public Blog Migration ✅

**Completed**: 2026-02-19

### Components created

| File | Purpose |
|------|---------|
| `src/components/shared/Pagination.js` | Compact page nav with ellipsis gaps; `onPage` callback |
| `src/components/shared/Toast.js` | `ToastContainer` — subscribes to `store('toast')`, auto-dismiss |
| `src/components/public/PublicHeader.js` | Blog title, nav (Home/Tags/Map), theme toggle |
| `src/components/public/PublicFooter.js` | Copyright, RSS, Sitemap, Admin links |
| `src/components/public/PostCard.js` | Card with thumbnail, title, excerpt, tags, date, view count |
| `src/components/public/PostGrid.js` | Responsive grid of `PostCard` children |
| `src/components/public/TagCloud.js` | Weighted tag cloud sidebar widget |
| `src/components/public/PostContent.js` | Full post: header, body (with lightbox/media), tags, prev/next nav |
| `src/components/public/MediaLightbox.js` | Full-screen image viewer; keyboard (Esc/←/→) + click-outside |

### Pages created

| File | API | Notes |
|------|-----|-------|
| `src/pages/public/HomePage.js` | `GET /api/pages/home` | Grid + tag cloud sidebar + pagination |
| `src/pages/public/PostPage.js` | `GET /api/posts/slug/:slug` | Sets document.title, meta description |
| `src/pages/public/TagPage.js` | `GET /api/pages/tag/:slug` | Breadcrumb navigation + post grid |
| `src/pages/public/TagsPage.js` | `GET /api/pages/tags` | Recursive tag tree with hierarchy |
| `src/pages/public/MapPage.js` | `GET /api/tags` | Leaflet map, lazy-loads vendor library |
| `src/pages/public/PreviewPage.js` | `GET /preview/:token` | Draft preview with notice banner |

### Phase C checklist

- [x] `HomePage` — posts + tag cloud + pagination
- [x] `PostPage` — full post with lightbox, prev/next navigation
- [x] `TagPage` — breadcrumb + post grid + pagination
- [x] `TagsPage` — hierarchical tag tree
- [x] `MapPage` — Leaflet map with tag location markers
- [x] `PreviewPage` — draft preview via token
- [x] `ToastContainer` wired into app bootstrap
- [x] PreviewPage route added to router table

---

## Phase D — Admin (Light) Migration ✅

**Completed**: 2026-02-19

### Pages created

| File | API | Notes |
|------|-----|-------|
| `src/pages/light/LoginPage.js` | `POST /api/auth/login` | Redirects to dashboard on success |
| `src/pages/light/DashboardPage.js` | `GET /api/system/stats` | Overview with quick actions |
| `src/pages/light/PostsListPage.js` | `GET /api/posts` | Paginated, filterable table; delete action |
| `src/pages/light/PostEditPage.js` | `GET /api/posts/{id}` | Complex editor; tags, media drag-drop, autosave |
| `src/pages/light/MediaPage.js` | `GET /api/media` | Grid of images/video/audio; upload zone |
| `src/pages/light/TagsManagerPage.js` | `GET /api/tags` | Hierarchical tree view; CRUD operations |
| `src/pages/light/SettingsPage.js` | `GET /api/settings` | Grouped configuration form |
| `src/pages/light/SecurityPage.js` | `GET /api/auth/sessions` | Password change + active sessions management |
| `src/pages/light/SystemPage.js` | `GET /api/system/*` | Logs, cache, backups, migrations |

### Components created

| File | Purpose |
|------|---------|
| `src/components/light/LightSidebar.js` | Admin navigation sidebar with icons |
| `src/components/light/TagsInput.js` | Tokenized tag input with autocomplete |
| `src/components/light/AdminLayout.js` | Shared layout wrapper for admin pages |
| `src/components/shared/Modal.js` | Generic overlay dialog base class |
| `src/components/shared/ConfirmDialog.js` | Specialized modal for confirmations |

### Phase D checklist

- [x] `LoginPage`
- [x] `DashboardPage`
- [x] `PostsListPage`
- [x] `PostEditPage` (complex: editor, tags, media, auto-save)
- [x] `MediaPage`
- [x] `TagsManagerPage` (tree view, drag-reorder)
- [x] `SettingsPage`
- [x] `SecurityPage`
- [x] `SystemPage`
- [x] `LightSidebar` wired into all admin pages
- [x] `TagsInput` integrated into `PostEditPage`
- [x] All admin API endpoints consumed correctly

---

## Phase E — Cleanup & Hardening ✅

**Completed**: 2026-02-19

- [x] Remove `app/static/` (migrated to `frontend/css/`, `frontend/src/`, `frontend/images/`)
- [x] Remove `jinja2` from `requirements.txt` dependencies
- [x] Update `Dockerfile` to `COPY frontend/ /app/frontend/`
- [x] Update `README.md` with new architecture diagram
- [x] Update `CLAUDE.md` phase status
- [x] Update `phases.md` (add Phase 15)
- [x] Verify CORS in production config
- [x] Mounted `frontend/images` as `/assets/images` in backend
- [x] Added favicon link to `index.html`

---

## Key Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-02-19 | RSS/sitemap moved to `feeds.py` (not Phase E) | Tests required these routes immediately |
| 2026-02-19 | Feeds generate XML as Python strings (no templates) | Templates directory deleted |
| 2026-02-19 | `cors_origins` config field with sensible defaults | Avoid hardcoding `["*"]` in production |
| 2026-02-19 | OpenAPI at `/api/docs` (not `/docs`) | Keeps all API concerns under `/api/` prefix |
| 2026-02-19 | SPA fallback returns 503 if `frontend/index.html` absent | Graceful degradation during development |
