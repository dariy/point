# Frontend / Backend Separation — Refactoring Plan

> **Created**: 2026-02-19
> **Status**: Planning
> **Scope**: Full architectural separation of client and server

---

## Table of Contents

1. [Goal](#goal)
2. [Current State](#current-state)
3. [Target Architecture](#target-architecture)
4. [Phase Overview](#phase-overview)
5. [Phase A: Backend — Pure JSON API](#phase-a-backend--pure-json-api)
6. [Phase B: Frontend — SPA Scaffold](#phase-b-frontend--spa-scaffold)
7. [Phase C: Public Blog Migration](#phase-c-public-blog-migration)
8. [Phase D: Admin (Light) Migration](#phase-d-admin-light-migration)
9. [Phase E: Cleanup & Hardening](#phase-e-cleanup--hardening)
10. [File Disposition Map](#file-disposition-map)
11. [Risk Register](#risk-register)
12. [Definition of Done](#definition-of-done)

---

## Goal

Transform the current tightly-coupled full-stack FastAPI application into two
independent layers:

- **Backend** — a pure JSON REST API documented with OpenAPI/Swagger, with no
  knowledge of HTML, CSS, or browser concerns.
- **Frontend** — a single-page application (SPA) built with vanilla JavaScript
  using a modular component system inspired by React/Angular, served as static
  files from the same container.

The split makes the backend re-implementable in any language (Go, Rust, Node,
etc.) without touching the frontend, and makes the frontend replaceable without
touching the backend.

---

## Current State

```
Browser
  │
  ▼
FastAPI (single process)
  ├─ /light/*      → Jinja2 templates (Admin HTML)
  ├─ /             → Jinja2 templates (Public blog HTML)
  ├─ /api/posts    → JSON
  ├─ /api/media    → JSON
  ├─ /api/tags     → JSON
  ├─ /api/auth     → JSON
  ├─ /api/settings → JSON
  └─ /api/system   → JSON
```

The REST API already exists and is mature. The server-rendered routes in
`app/api/light.py` and `app/api/public.py` are the only pieces to eliminate.
The existing JS in `app/static/js/` already calls the JSON API heavily —
this code becomes the seed of the new frontend.

---

## Target Architecture

```
Browser
  │
  ├── Static files (HTML/CSS/JS)
  │     served by FastAPI (or nginx in prod)
  │
  └── Fetch calls → FastAPI JSON API only
                      ├─ /api/auth/*
                      ├─ /api/posts/*
                      ├─ /api/media/*
                      ├─ /api/tags/*
                      ├─ /api/settings/*
                      └─ /api/system/*
```

```
point/
├── frontend/               ← NEW: all client-side code
│   ├── index.html          ← SPA shell (one HTML file)
│   ├── src/
│   │   ├── app.js          ← entry point, router init
│   │   ├── router.js       ← client-side router
│   │   ├── store.js        ← global reactive state
│   │   ├── api/            ← typed fetch wrappers per resource
│   │   ├── components/     ← reusable UI components
│   │   ├── pages/          ← page-level components (public + light)
│   │   └── utils/          ← helpers, formatters, validators
│   └── css/                ← migrated CSS (unchanged structure)
│
└── app/                    ← EXISTING: backend only
    ├── api/
    │   ├── auth.py         ← unchanged
    │   ├── posts.py        ← minor additions
    │   ├── media.py        ← unchanged
    │   ├── tags.py         ← unchanged
    │   ├── settings.py     ← add /public endpoint
    │   ├── system.py       ← unchanged
    │   ├── light.py        ← DELETE (replaced by frontend)
    │   └── public.py       ← DELETE (replaced by frontend)
    ├── templates/          ← DELETE entire directory
    └── utils/
        └── template_helpers.py  ← DELETE
```

---

## Phase Overview

| Phase | Name | Effort | Risk |
|-------|------|--------|------|
| A | Backend — Pure JSON API | Medium | Low |
| B | Frontend — SPA Scaffold | Medium | Low |
| C | Public Blog Migration | Large | Medium |
| D | Admin (Light) Migration | Large | Medium |
| E | Cleanup & Hardening | Small | Low |

Total estimated scope: 5 focused development sessions.

---

## Phase A: Backend — Pure JSON API

**Goal**: Make the backend a clean, fully-documented JSON API with no template
dependencies.

### A1 — Add CORS middleware

```python
# app/main.py
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,  # config-driven
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Add `CORS_ORIGINS` to `app/config.py` (default: `["http://localhost:3000"]`
for development, `["*"]` behind nginx in prod).

### A2 — OpenAPI / Swagger documentation

FastAPI generates OpenAPI automatically. Enhancements needed:

- Set proper `title`, `description`, `version`, `contact` in `app/main.py`
- Add `tags` metadata (list of tag objects with descriptions) in `main.py`
- Ensure every route has:
  - `summary` (one line)
  - `description` (docstring or explicit param)
  - `response_model` declared
  - `responses` dict for error codes (401, 403, 404, 422)
- Add example payloads to all Pydantic schemas via `model_config`

Swagger UI available at `/api/docs`.
ReDoc available at `/api/redoc`.
OpenAPI JSON at `/api/openapi.json`.

### A3 — New required endpoints

The frontend needs endpoints not yet exposed as pure JSON:

| New Endpoint | Purpose |
|---|---|
| `GET /api/settings/public` | Blog title, description, author — no auth needed |
| `GET /api/posts/public` | Published posts list with full context for public view |
| `GET /api/pages/home` | Compound: published posts + tag cloud + settings |
| `GET /api/pages/tag/{slug}` | Compound: tag info + posts + breadcrumbs |
| `GET /api/pages/tags` | Compound: all tags tree + post counts |

Compound page endpoints reduce the number of round-trips the SPA must make
on first load. They are read-only and require no auth.

### A4 — Auth: JSON-first responses

Current auth routes return redirects in some cases. Change to always return
JSON:

- `POST /api/auth/login` → `200 {user: ..., message: "ok"}` or `401 {detail: ...}`
- `POST /api/auth/logout` → `200 {message: "ok"}`
- Never return `RedirectResponse` from API routes

The frontend handles redirecting the browser after login/logout.

### A5 — Content formatting in responses

`PostResponse.content_html` is already present. Ensure:

- `content_html` is always populated (not null) before returning
- `thumbnail_url` (full relative URL) is included in `PostResponse`
- `author_display_name` and `author_avatar_url` are included
- `PostListItem` schema (lighter weight) for list views vs full `PostResponse`

### A6 — SPA fallback route

The backend must serve `frontend/index.html` for any route not matching
`/api/*` or a known static file:

```python
# app/main.py
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Mount frontend static files
app.mount("/assets", StaticFiles(directory="frontend/assets"), name="assets")

# SPA fallback — must come LAST
@app.get("/{full_path:path}")
async def spa_fallback(full_path: str):
    return FileResponse("frontend/index.html")
```

### A7 — Remove template routes

Delete `app/api/light.py` and `app/api/public.py` and their router
registrations in `main.py`. Remove `app/utils/template_helpers.py`.
Remove Jinja2 dependency from `main.py`.

### A8 — Remove Jinja2 / Starlette template config

```python
# DELETE from main.py:
from starlette.templating import Jinja2Templates
templates = Jinja2Templates(directory="app/templates")
```

Remove `jinja2` from `pyproject.toml` dependencies (or keep if used elsewhere).

### A9 — Update tests

- Delete tests that test HTML route responses (light.py, public.py routes)
- All remaining tests hit `/api/*` and expect JSON
- Add tests for new compound endpoints (A3)

### Checklist — Phase A

- [ ] CORS middleware added and config-driven
- [ ] OpenAPI metadata set (title, description, tag groups)
- [ ] All existing routes have `summary`, `response_model`, error `responses`
- [ ] `/api/settings/public` endpoint added
- [ ] `/api/pages/home`, `/api/pages/tag/{slug}`, `/api/pages/tags` added
- [ ] Auth routes return JSON only (no redirects)
- [ ] `PostResponse` includes `content_html`, `thumbnail_url`, author fields
- [ ] `PostListItem` schema added for list views
- [ ] SPA fallback route added (serves `frontend/index.html`)
- [ ] `app/api/light.py` deleted
- [ ] `app/api/public.py` deleted
- [ ] `app/utils/template_helpers.py` deleted
- [ ] `app/templates/` directory deleted
- [ ] Tests updated and passing

---

## Phase B: Frontend — SPA Scaffold

**Goal**: Create the frontend directory with the core component system,
router, state store, and API client. No page content yet — just the
plumbing.

See `FRONTEND_ARCHITECTURE.md` for the full component system design.

### B1 — Directory structure

```
frontend/
├── index.html
├── src/
│   ├── app.js
│   ├── router.js
│   ├── store.js
│   ├── api/
│   │   ├── client.js       ← base fetch wrapper (auth, errors, JSON)
│   │   ├── auth.js
│   │   ├── posts.js
│   │   ├── media.js
│   │   ├── tags.js
│   │   ├── settings.js
│   │   └── system.js
│   ├── components/
│   │   └── Component.js    ← base class
│   ├── pages/
│   │   ├── public/
│   │   └── light/
│   └── utils/
│       ├── formatters.js
│       └── helpers.js
└── css/
    └── (migrated from app/static/css/)
```

### B2 — index.html shell

Single HTML file. All routing is client-side. No server-rendered content.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loading…</title>
  <link rel="stylesheet" href="/assets/css/main.css" />
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/assets/js/app.js"></script>
</body>
</html>
```

### B3 — Component base class

See `FRONTEND_ARCHITECTURE.md` §2 for full specification.

Key concepts:
- `Component` base class with `render()`, `setState()`, `mount()`, `unmount()`
- Components write to a real DOM node they own
- State changes trigger a re-render of that component only
- Props flow downward; events bubble up via callbacks or a store

### B4 — Client-side router

See `FRONTEND_ARCHITECTURE.md` §3 for full specification.

- Uses `history.pushState` and `popstate`
- Route table maps URL patterns to page component classes
- Renders active page into `#app`
- Supports route parameters (`/posts/:slug`)
- Handles auth guard (redirects to login if not authenticated)

### B5 — API client

```javascript
// frontend/src/api/client.js
// Thin wrapper around fetch:
// - Always sends credentials (cookies)
// - Always expects JSON
// - Throws typed errors on non-2xx
// - Base URL from window.location.origin/api
```

### B6 — Static file serving

During development: serve `frontend/` from a local HTTP server (Python's
`http.server` or any static server). The API is proxied to the FastAPI
backend (CORS must be enabled, Phase A1).

In production: the backend `main.py` serves `frontend/` as static files
(Phase A6).

### Checklist — Phase B

- [ ] `frontend/` directory created with full structure
- [ ] `index.html` shell written
- [ ] `Component.js` base class implemented with lifecycle methods
- [ ] `router.js` implemented with History API, route params, auth guard
- [ ] `store.js` implemented (reactive state + subscriptions)
- [ ] `api/client.js` implemented (fetch wrapper, auth, error handling)
- [ ] `api/*.js` modules mirror all backend `/api/*` routes
- [ ] `utils/formatters.js` (date, size, content helpers)
- [ ] CSS migrated from `app/static/css/` to `frontend/css/`
- [ ] Dev workflow documented (how to run frontend + backend separately)

---

## Phase C: Public Blog Migration

**Goal**: Re-implement all public-facing pages as frontend components,
consuming the JSON API.

### Pages to build

| Route | Page Component | API Calls |
|---|---|---|
| `/` | `HomePage` | `GET /api/pages/home` |
| `/posts/:slug` | `PostPage` | `GET /api/posts/slug/:slug` |
| `/tag/:slug` | `TagPage` | `GET /api/pages/tag/:slug` |
| `/tags` | `TagsPage` | `GET /api/pages/tags` |
| `/map` | `MapPage` | `GET /api/tags` (with locations) |
| `/preview/:token` | `PreviewPage` | `GET /api/posts/preview/:token` |

### Reusable components to build (Public)

| Component | Description |
|---|---|
| `PostCard` | Thumbnail + title + date in grid/list view |
| `PostGrid` | Responsive grid of PostCards |
| `PostContent` | Renders formatted HTML post body |
| `MediaLightbox` | Full-screen image/video viewer |
| `TagBadge` | Pill/chip for a single tag |
| `TagCloud` | Weighted tag list |
| `Pagination` | Page navigation |
| `PublicHeader` | Blog header with nav and tag bar |
| `PublicFooter` | Footer |
| `ThemeToggle` | Dark/light mode switcher |
| `SearchBar` | (If search is added later, placeholder) |

### SEO considerations

Since the app is now a SPA, server-rendered meta tags are gone. Solutions:

1. **Primary**: Backend serves pre-populated `<title>` and meta tags for
   known routes via the SPA fallback route (inject into `index.html`
   dynamically based on path).
2. **Secondary**: JavaScript sets `document.title` and updates meta tags
   on every navigation.
3. For RSS/sitemap/robots.txt — keep these as pure backend routes
   (`/feed.xml`, `/sitemap.xml`, `/robots.txt`) returning the appropriate
   content type. These do NOT go through the SPA.

### Checklist — Phase C

- [ ] `HomePage` component built and wired to router
- [ ] `PostPage` component with lightbox, immersive mode
- [ ] `TagPage` component with paginated post list
- [ ] `TagsPage` component with tag tree/grid
- [ ] `MapPage` component with Leaflet integration
- [ ] `PreviewPage` component (draft preview via token)
- [ ] All public shared components built (PostCard, Pagination, etc.)
- [ ] `document.title` and meta tags updated on navigation
- [ ] RSS/sitemap/robots.txt served directly by backend (unchanged)
- [ ] Dark/light theme preserved and working
- [ ] AJAX navigation between public pages working (no full reload)
- [ ] Immersive mode working for image-heavy posts

---

## Phase D: Admin (Light) Migration

**Goal**: Re-implement the admin panel as frontend components, consuming
the JSON API.

### Pages to build

| Route | Page Component | API Calls |
|---|---|---|
| `/light/login` | `LoginPage` | `POST /api/auth/login` |
| `/light` | `DashboardPage` | `GET /api/system/stats`, `GET /api/posts` |
| `/light/posts` | `PostsListPage` | `GET /api/posts` |
| `/light/posts/new` | `PostEditPage` | `POST /api/posts` |
| `/light/posts/:id` | `PostEditPage` | `GET /api/posts/:id`, `PUT /api/posts/:id` |
| `/light/media` | `MediaPage` | `GET /api/media` |
| `/light/tags` | `TagsManagerPage` | `GET /api/tags` |
| `/light/settings` | `SettingsPage` | `GET /api/settings`, `PUT /api/settings` |
| `/light/security` | `SecurityPage` | `GET /api/auth/sessions` |
| `/light/system` | `SystemPage` | `GET /api/system/*` |

### Reusable components to build (Admin)

| Component | Description |
|---|---|
| `AdminLayout` | Sidebar + main content wrapper |
| `Sidebar` | Navigation menu |
| `StatusSelect` | Post status interactive dropdown |
| `TagSelector` | Autocomplete tag picker for editor |
| `MediaPicker` | Media chooser dialog |
| `MediaDropZone` | Drag-drop upload area |
| `MarkdownEditor` | Textarea with toolbar |
| `Modal` | Generic modal dialog |
| `Toast` | Flash message system |
| `DataTable` | Sortable/filterable table |
| `TreeView` | Hierarchical tag tree |
| `StatCard` | Dashboard metric card |
| `ConfirmDialog` | Destructive action confirmation |
| `BackupsCard` | Backup list with restore/delete |
| `LogViewer` | System log display |

### Auth guard

All `/light/*` routes require authentication. The router checks the store
for an authenticated user before rendering. If not logged in, redirect to
`/light/login`.

### Checklist — Phase D

- [ ] `LoginPage` with form and error display
- [ ] `DashboardPage` with stats and recent posts
- [ ] `PostsListPage` with filters, pagination, bulk actions
- [ ] `PostEditPage` with full editor (markdown, tags, media, status)
- [ ] `MediaPage` with grid, upload, orphan cleanup
- [ ] `TagsManagerPage` with tree view, CRUD, reorder
- [ ] `SettingsPage` with all settings fields
- [ ] `SecurityPage` with active sessions list
- [ ] `SystemPage` with logs, cache, backups, migrations
- [ ] All admin shared components built
- [ ] Auth guard on all `/light/*` routes
- [ ] Drag-drop media upload working
- [ ] GenAI image analysis working
- [ ] Tag hierarchy / tree reorder working
- [ ] Preview link generation working

---

## Phase E: Cleanup & Hardening

**Goal**: Remove all dead code, update documentation, harden the setup.

### E1 — Remove dead backend code

- Delete `app/templates/` (entire directory)
- Delete `app/api/light.py`
- Delete `app/api/public.py`
- Delete `app/utils/template_helpers.py`
- Remove `jinja2` and `python-multipart` (if no longer used) from deps
- Remove `Jinja2Templates` from `main.py`

### E2 — Update documentation

- Update `README.md`:
  - New architecture diagram
  - New development setup (backend + frontend separately)
  - Updated API documentation section
- Update `CLAUDE.md` — phase status, new file locations
- Update `phases.md` — add Phase 15 (this refactoring)

### E3 — Update tests

- Remove all tests for deleted routes
- Add integration tests for new compound endpoints
- Ensure 80%+ coverage maintained

### E4 — Docker update

The `Dockerfile` and `docker-compose.yml` need to account for `frontend/`:

```dockerfile
# In Dockerfile, copy frontend at build time
COPY frontend/ /app/frontend/
```

Or build frontend files before the Docker build step.

### E5 — Production readiness

- Verify CORS settings are correct in production config
- Verify SPA fallback does not break API routes
- Verify media file serving still works
- Verify RSS/sitemap/robots.txt still work (backend routes)
- Verify preview tokens still work

### Checklist — Phase E

- [ ] All dead backend code deleted
- [ ] `README.md` updated
- [ ] `CLAUDE.md` updated
- [ ] `phases.md` updated
- [ ] Tests all pass with 80%+ coverage
- [ ] `Dockerfile` updated for frontend
- [ ] CORS settings verified for production
- [ ] Full integration test (start container, visit homepage, admin, etc.)

---

## File Disposition Map

### Files to DELETE

| Path | Reason |
|---|---|
| `app/api/light.py` | Replaced by frontend |
| `app/api/public.py` | Replaced by frontend |
| `app/utils/template_helpers.py` | Jinja2 helpers, no longer needed |
| `app/templates/` | All Jinja2 templates replaced by frontend |
| `app/static/` | Migrated to `frontend/` |

### Files to MODIFY

| Path | Change |
|---|---|
| `app/main.py` | Remove template setup, add CORS, add SPA fallback |
| `app/api/settings.py` | Add `/public` endpoint |
| `app/schemas/post.py` | Add `PostListItem` schema, enrich `PostResponse` |
| `app/config.py` | Add `CORS_ORIGINS` setting |
| `pyproject.toml` | Remove jinja2 dep, update entry points |
| `Dockerfile` | Copy frontend directory |
| `README.md` | Complete rewrite of quickstart section |

### Files to CREATE

| Path | Purpose |
|---|---|
| `app/api/pages.py` | Compound page endpoints (home, tag, tags) |
| `frontend/index.html` | SPA shell |
| `frontend/src/app.js` | App entry point |
| `frontend/src/router.js` | Client-side router |
| `frontend/src/store.js` | Global state management |
| `frontend/src/api/client.js` | Fetch wrapper |
| `frontend/src/api/auth.js` | Auth API module |
| `frontend/src/api/posts.js` | Posts API module |
| `frontend/src/api/media.js` | Media API module |
| `frontend/src/api/tags.js` | Tags API module |
| `frontend/src/api/settings.js` | Settings API module |
| `frontend/src/api/system.js` | System API module |
| `frontend/src/api/pages.js` | Pages API module |
| `frontend/src/components/Component.js` | Base component class |
| `frontend/src/components/*.js` | All reusable components |
| `frontend/src/pages/public/*.js` | All public page components |
| `frontend/src/pages/light/*.js` | All admin page components |
| `frontend/src/utils/formatters.js` | Date, size, content helpers |
| `frontend/src/utils/helpers.js` | DOM helpers, event utils |
| `frontend/css/` | Migrated CSS |
| `REFACTORING.md` | This file |
| `FRONTEND_ARCHITECTURE.md` | Component system design |
| `API_CHANGES.md` | API change details |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SEO regression (no server-side HTML) | Medium | Medium | Set `<title>` + meta from JS; keep RSS/sitemap on backend |
| Breaking existing bookmark URLs | Low | Medium | SPA router handles same URL patterns as before |
| Auth cookie not sent cross-origin | Medium | High | Use `credentials: 'include'` in fetch; CORS must allow credentials |
| Media serving URLs change | Low | High | Keep `/data/media` serving unchanged in main.py |
| Large JS bundle load time | Low | Medium | Split by page, lazy-load admin code |
| RSS/sitemap crawlers get HTML | Low | Low | These remain backend routes, no SPA fallback applies |
| Preview token route breaks | Low | Medium | Keep `/preview/{token}` as a backend alias that redirects to SPA URL |

---

## Definition of Done

The refactoring is complete when:

1. `app/templates/` directory does not exist
2. `app/api/light.py` and `app/api/public.py` do not exist
3. The backend starts cleanly with no Jinja2 imports
4. `GET /api/openapi.json` returns a valid OpenAPI 3.x document
5. `GET /api/docs` renders Swagger UI
6. All `/api/*` routes return JSON (never HTML, never redirects except 301/302)
7. `GET /` returns `frontend/index.html`
8. `GET /light` returns `frontend/index.html` (SPA takes over)
9. The public blog is fully functional via the SPA
10. The admin panel is fully functional via the SPA
11. All existing tests pass
12. New tests cover the compound page endpoints
13. The Docker container builds and runs correctly
14. `README.md` accurately describes the new architecture

---

## Related Documents

- [`FRONTEND_ARCHITECTURE.md`](./FRONTEND_ARCHITECTURE.md) — Component system, router, store design
- [`API_CHANGES.md`](./API_CHANGES.md) — Detailed backend API changes
- [`specification.md`](./specification.md) — Original technical specification
- [`phases.md`](./phases.md) — Development phases tracker
