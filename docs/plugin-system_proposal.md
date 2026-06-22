# Plugin System Refactor — Proposal

> Status: proposed. Tracked in beads epic `point-plugin-system-tdgw` (Phases 1–5 + extraction slices).

## Context

Point currently ships its entire public + admin frontend as **one esbuild bundle** (`frontend/js/app.js`, ~525 KB / 133 KB gzip). Although the source uses dynamic `import()` per page, the build runs `esbuild --bundle` **without `--splitting`**, so every page, component, and the full route table (including all `/light/*` admin routes) is inlined into that single file and downloaded by every visitor. Features are toggled only at *render time* via settings — the code is always shipped.

The goal is a **plugin system**: vertical slices of functionality that can be switched on/off in the admin panel, where **disabled plugins are never downloaded and the client never learns they exist**. This enables:

- Smaller payloads (a site showing only Atlas shouldn't ship Map + TagGraph + Timeline).
- Reduced attack surface (disabled backend integrations 404 instead of being dormant).
- Flexible, decoupled themes — e.g. reducing the site to "post list + immersive mode" for embedding elsewhere.

**Hard constraint:** the client must receive an *enabled-only* manifest. Disabled plugin chunk URLs/names must not appear in served HTML/JS, and their chunks must 404. This rules out a static client-side plugin table and forces a server-driven design.

---

## Architecture

### Core vs. plugins

**Core (always loaded, never a plugin):** router (`router.js`), store (`store.js`), `Component`/`BaseWebComponent`, Toast/Modal/Pagination, theme engine (`themeParser.js`, `PointBus.js`), API client core, `helpers.js`, the SPA shell, and the **post list / post content** baseline. Core must render a usable site with *zero* optional plugins enabled.

**Plugin** = a descriptor with: `id`, `type`, optional `slots`, optional `routes` (public/admin), optional frontend `entry` chunk, optional backend capability gate, optional settings, optional admin-nav contribution.

**Plugin types** (category metadata + how they attach):
- `route` — owns a route (e.g. `/tags` provider, admin pages).
- `slot` — fills a named shell region (breadcrumbs, nav menu, timeline, header, footer, explore/tag-cloud block).
- `enhancer` — augments post content (immersive viewer, custom-CSS injection).
- `service` — backend-gated capability, little/no public JS (Instagram, AI, backups, passkeys, API keys, sync).

### Extension points

The shell exposes **named slots** that plugins fill, instead of hardcoded imports:
`header`, `footer`, `breadcrumbs`, `nav-menu`, `home-explore` (tag cloud), `timeline`, `tags-route` (single-claim), `post-viewer`, `admin-nav`, plus dynamic `route` registration.

### Server-side registry (Go) — source of truth

- A `PluginRegistry` (static Go slice of descriptors): `id`, `type`, `slots`, public/admin `routes`, `defaultEnabled`, frontend `entryName`, required settings, backend capability key.
- **Enabled state** persisted in `blog_settings` as `plugin.<id>.enabled` (reuses existing settings infra — no new table needed; alternatively a dedicated `plugins` table if richer per-plugin config is wanted).
- Server emits a **runtime manifest** containing only *enabled* plugins: `[{ id, type, slot, routes, entry: "/assets/js/p/<hash>.js" }]`, mapping each plugin to its built chunk via the esbuild metafile (`frontend/js/plugin-manifest.json`).
- **Delivery:** inject the enabled-only manifest into `index.html` as an inline `<script>window.__PLUGINS__=[…]</script>`, reusing the existing per-post HTML-injection path in `api/cmd/api/main.go` (the SPA fallback already rewrites `</head>` for `/posts/:slug`). No extra round-trip; disabled plugins absent from the document.
- **Chunk authorization:** plugin chunks are served by a **handler that 404s disabled plugins** (not the plain `/assets/js` static dir), so disabled code can't be fetched even if a filename is guessed. Chunks live under a gated prefix (e.g. `/assets/js/p/`).
- **Backend gating:** `requirePlugin("<id>")` Echo middleware wraps each `service`/admin route group, returning 404 when disabled.

### Frontend plugin host

- `app.js` reads `window.__PLUGINS__` (enabled-only) at bootstrap.
- A new `PluginHost` (`frontend/src/core/pluginHost.js`): for each manifest entry, lazily `import(entry)` on demand and call the plugin's `register({ slots, routes, store, ctx })`.
- **Routes:** core routes stay static in `app.js`; plugin-provided routes are merged from the manifest. `resolveTagsModule()` (`app.js:266`) is replaced by the manifest's `tags-route` claimant.
- **Slots:** shell components (`PublicHeader.js`, `HomePage.js`, `PostContent.js`) call `PluginHost.fill(slot, ctx)` instead of importing features directly.

### Build pipeline

- Switch `scripts/build-js.sh` to `esbuild --splitting --format=esm --outdir=frontend/js` with multiple entry points: core `app.js` + one per plugin (`frontend/src/plugins/<id>/index.js`). Use `--metafile` + a small post-step to write `frontend/js/plugin-manifest.json` (plugin id → hashed chunk path) consumed by the Go server.
- **CSS:** mirror the split — each plugin owns CSS partials; extend `scripts/build-css.sh` to emit per-plugin CSS chunks loaded alongside the plugin (keeps the existing "edit source CSS, never generated" rule).

---

## Plugin catalog

| Plugin | Type | Key source today | Worth it? |
|---|---|---|---|
| `tags-atlas` / `tags-map` / `tags-graph` | route (`tags-route`, single-claim) | `AtlasPage.js`, `MapPage.js`, `TagsPage.js` + `tagGraph.js`, Leaflet | **High** — biggest JS win (Leaflet 145KB + 913-line graph) |
| `timeline` | slot (`timeline`) | `Timeline.js` (~1571 lines) | **High** — large, used on Home/Tag only |
| `immersive` | enhancer (`post-viewer`) | `MediaViewer.js`, `ImmersiveSheetViewer.js`, `gestures.js` | **High** — only needed on media posts |
| `breadcrumbs` | slot (`breadcrumbs`) | inside `PublicHeader.js` | Medium — needs PublicHeader extraction first |
| `nav-menu` | slot (`nav-menu`) | `PublicHeader.js`, `getNavMenu`, `MenuPage.js` | Medium |
| `tag-cloud` | slot (`home-explore`) | `ExploreBlock.js` | Medium |
| `public-header` | slot (`header`) | `PublicHeader.js` | Medium — enables minimal/embed mode (do late) |
| `public-footer` | slot (`footer`) | `PublicFooter.js` | Low/Medium |
| `instagram` | service | backend + Instagram settings | Medium — cheap gate, real attack-surface win |
| `ai-analysis` | service | Gemini integration | Medium — cheap gate |
| `media-library` | route (admin) | `MediaPage.js` | Medium |
| `custom-css` | enhancer | global + per-post CSS (`SanitizePostCSS`) | Medium |
| `passkeys` | service | `SecurityPage.js` + WebAuthn backend | Medium |
| `api-keys` | service | `apikey.go` + admin | Medium |
| `offline-sync` | service/core-ish | `sync.js`, `offlineStore.js`, SW | Medium — careful, touches PWA |
| `backups` | service | backup settings/handlers | Low/Medium |
| `admin-posts-list` | route (admin) | `PostsListPage.js` | Low — admin-only payload |
| `admin-home` (dashboard) | route (admin) | `DashboardPage.js` | Low |

**Keep as core (do NOT plugin-ize):** router, store, Component bases, Toast/Modal, theme engine, helpers, API client, post list/grid + PostContent baseline. These must render a working minimal site alone.

---

## Implementation plan (vertical slices → br tasks)

Each phase keeps the site fully working. Phases 1–3 are pure infrastructure shipped **with every plugin enabled** (zero behavior change). Phase 4 extracts one vertical at a time; each extraction is an independent, shippable br task.

**Phase 1 — Backend foundation**
1. `PluginRegistry` Go type + static descriptor list (all current features, `defaultEnabled: true`).
2. Enabled-state storage via `plugin.<id>.enabled` settings keys + seed in `setup.go`.
3. Enabled-only **manifest injection** into `index.html` (extend the per-post injection path in `main.go`).
4. **Gated chunk handler** at `/assets/js/p/*` that 404s disabled plugins.
5. `requirePlugin(id)` middleware; wrap no routes yet (added per-plugin in Phase 4).

**Phase 2 — Frontend foundation**
6. `PluginHost` + slot API (`frontend/src/core/pluginHost.js`); shell slot insertion points in `PublicHeader.js`, `HomePage.js`, `PostContent.js`.
7. Manifest-driven route merge in `app.js`; replace `resolveTagsModule()` with `tags-route` claimant.
8. Build pipeline: `build-js.sh` → `--splitting --outdir` + per-plugin entries + `plugin-manifest.json`; mirror in `build-css.sh`.

**Phase 3 — Admin**
9. `/api/plugins` endpoints (list + toggle, admin-only) + `/api/plugins/manifest` if not inlining only.
10. New `/light/plugins` page (`PluginsPage.js`) with enable/disable toggles, type/slot info, per-plugin settings link; add to admin nav.

**Phase 4 — Extract plugins (one br task each, ordered by value)**
11. `tags-atlas` / `tags-map` / `tags-graph` (+ shared Leaflet loader) — first, biggest win, already lazy.
12. `timeline`. 13. `immersive` (+ `gestures`). 14. `tag-cloud`. 15. `nav-menu`.
16. `breadcrumbs` (requires extracting from `PublicHeader.js`).
17. Service gates: `instagram`, `ai-analysis`, `passkeys`, `api-keys`, `backups`, `custom-css` (wrap routes with `requirePlugin`, hide admin UI).
18. Admin routes: `media-library`, `admin-posts-list`, `admin-home`, `offline-sync`.
19. `public-header` / `public-footer` slots — **last**; verify a minimal "post-list + immersive only" config renders correctly.

**Phase 5 — Hardening**
20. Per-plugin CSS chunk loading; "minimal embed" preset; docs; ensure core renders with all plugins off.

---

## Files to modify (representative)

- **Build:** `scripts/build-js.sh`, `scripts/build-css.sh` (code-splitting, per-plugin entries, manifest emit).
- **Backend:** `api/cmd/api/main.go` (manifest injection, gated chunk handler, route gating), new `api/internal/plugins/registry.go`, new `api/internal/api/plugins.go`, `api/internal/services/settings_service.go` (enabled state), `api/internal/api/setup.go` (seed), `api/internal/api/settings.go` (`publicSettingKeys`).
- **Frontend core:** `frontend/src/app.js` (bootstrap manifest read, route merge), new `frontend/src/core/pluginHost.js`, `frontend/index.html` (manifest script slot).
- **Frontend shell slots:** `frontend/src/components/public/PublicHeader.js`, `frontend/src/pages/public/HomePage.js`, `frontend/src/components/public/PostContent.js`.
- **Plugin extraction:** move each feature under `frontend/src/plugins/<id>/index.js` (re-exporting existing modules initially to minimize churn): `AtlasPage.js`, `MapPage.js`, `TagsPage.js`, `tagGraph.js`, `Timeline.js`, `MediaViewer.js`, `ImmersiveSheetViewer.js`, `gestures.js`, `ExploreBlock.js`, `PublicFooter.js`, etc.
- **Admin:** new `frontend/src/pages/light/PluginsPage.js`, route in `app.js`, nav in `LightSidebar.js`.

**Reuse, don't reinvent:** existing settings infra (`SettingsService`, `publicSettingKeys`, `setup.go` seed), existing per-post HTML injection in `main.go`, existing migration pattern (`ApplyMigration`), existing lazy `import()` route loaders, the existing runtime feature flags (`tags_module`, `timeline_mode`, `immersive_overlay_mode`) — fold these into plugin enabled-state rather than duplicating.

---

## Verification

- **Build:** run `scripts/build-js.sh`; confirm multiple chunks in `frontend/js/` + a valid `plugin-manifest.json`. Confirm core `app.js` shrinks substantially (target: tag-viz + Timeline + immersive no longer in core).
- **Disabled = absent:** with a plugin disabled in `/light/plugins`, load the site via `scripts/run-local.sh` (localhost:8001); verify (a) `window.__PLUGINS__` in served HTML omits it, (b) its chunk URL is absent, (c) requesting its chunk path returns **404**, (d) its API routes return **404**.
- **Enabled = works:** enable each plugin, confirm its feature renders/behaves as before (Atlas/Map/Graph on `/tags`, Timeline on Home, immersive on a media post, breadcrumbs/nav/footer).
- **Minimal config:** disable everything optional; confirm core renders a working "post list + immersive" site (the embed goal).
- **Tests:** run existing frontend tests (e.g. `frontend/test/gestures.test.js`) after immersive extraction; add a `PluginHost`/manifest test and a backend `requirePlugin` middleware test.
- **No regression with all enabled:** after Phases 1–3 (all plugins on), the site is byte-for-behavior identical to today.

---

## Open considerations / risks

- **Per-post HTML injection** already mutates `index.html`; manifest injection must compose with it (single `</head>` rewrite, both payloads).
- **CSS splitting** is the trickier half of bundle reduction; current CSS is two hand-concatenated bundles. Per-plugin CSS can lag JS by a phase if needed.
- **`public-header`/`breadcrumbs`** are entangled in one 802-line `PublicHeader.js`; extracting breadcrumbs cleanly requires refactoring it into slots first — sequence accordingly.
- **Offline/PWA**: `offline-sync` and the service worker shell-cache must keep working when other plugins toggle; the SW cache list should derive from the manifest.
- **`run-local.sh` mutates `frontend/index.html`** (dev build) — never commit `index.html`/`.bak`; the manifest slot must survive that dev rewrite.
