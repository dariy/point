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
| **C** | Public Blog Migration | ⬜ Not started | — |
| **D** | Admin (Light) Migration | ⬜ Not started | — |
| **E** | Cleanup & Hardening | ⬜ Not started | — |

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

## Phase C — Public Blog Migration ⬜

**Status**: Not started (blocked on Phase B)

### Pages to build
- [ ] `HomePage` → `GET /api/pages/home`
- [ ] `PostPage` → `GET /api/posts/slug/:slug` (with lightbox, immersive mode)
- [ ] `TagPage` → `GET /api/pages/tag/:slug`
- [ ] `TagsPage` → `GET /api/pages/tags`
- [ ] `MapPage` → Leaflet + `GET /api/tags` (with locations)
- [ ] `PreviewPage` → `GET /preview/:token`

---

## Phase D — Admin (Light) Migration ⬜

**Status**: Not started (blocked on Phase B)

### Pages to build
- [ ] `LoginPage`
- [ ] `DashboardPage`
- [ ] `PostsListPage`
- [ ] `PostEditPage` (complex: editor, tags, media, auto-save)
- [ ] `MediaPage`
- [ ] `TagsManagerPage` (tree view, drag-reorder)
- [ ] `SettingsPage`
- [ ] `SecurityPage`
- [ ] `SystemPage`

---

## Phase E — Cleanup & Hardening ⬜

**Status**: Not started (blocked on Phases C + D)

- [ ] Remove `app/static/` (migrated to `frontend/css/`, `frontend/src/`)
- [ ] Remove `jinja2` from `pyproject.toml` dependencies
- [ ] Update `Dockerfile` to `COPY frontend/ /app/frontend/`
- [ ] Update `README.md` with new architecture diagram
- [ ] Update `CLAUDE.md` phase status
- [ ] Update `phases.md` (add Phase 15)
- [ ] Verify CORS in production config
- [ ] Full integration test in Docker container

---

## Key Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| 2026-02-19 | RSS/sitemap moved to `feeds.py` (not Phase E) | Tests required these routes immediately |
| 2026-02-19 | Feeds generate XML as Python strings (no templates) | Templates directory deleted |
| 2026-02-19 | `cors_origins` config field with sensible defaults | Avoid hardcoding `["*"]` in production |
| 2026-02-19 | OpenAPI at `/api/docs` (not `/docs`) | Keeps all API concerns under `/api/` prefix |
| 2026-02-19 | SPA fallback returns 503 if `frontend/index.html` absent | Graceful degradation during development |
