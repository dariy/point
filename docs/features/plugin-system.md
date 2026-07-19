# Plugin System

Most of Point's features ship as plugins that the admin can toggle from
`/light/plugins`. The defining property — the **hard constraint, never relax it** — is
that the client receives an **enabled-only** manifest: disabled plugins never appear in
served HTML/JS, their JS chunks 404, and their API routes 404. The server is the single
source of truth.

## What is implemented

All five phases of the original refactor (beads epic `point-plugin-system-tdgw`) are done.

### Backend (`api/internal/plugins/registry.go`)

- `Descriptor` + static `Registry` slice (~30 plugins). Fields: `ID`, `Type`
  (route / slot / enhancer / service), `Slot`, `Routes`, `EntryName`, `DefaultEnabled`,
  `Title`, `Area`, `Exclusive`, `Core`.
- Enabled state persists in `blog_settings` as `plugin.<id>.enabled` (string
  `"true"`/`"false"`); absent key falls back to `DefaultEnabled`, so existing installs
  need no migration. Fresh installs are seeded in `setup.go`.
- `BuildManifest` emits the enabled-only manifest, injected into served `index.html` as
  `window.__PLUGINS__` (XSS-safe via `json.Marshal` escaping) on every SPA-fallback and
  per-post render.
- Gated chunk handler at `/assets/js/p/*` 404s disabled/unknown chunks (path traversal
  blocked); `RequirePlugin(settings, id)` middleware 404s disabled plugins' API routes.
- Admin API: `GET /api/plugins` (full catalog — the one surface allowed to reveal
  disabled plugins, behind `AuthMiddleware`), `PATCH /api/plugins/:id`.

### Frontend (`frontend/src/core/pluginHost.js`)

- Reads `window.__PLUGINS__` at bootstrap. A slot is *claimed* only when the plugin has
  a built chunk (`entry` URL); `fill(slot, el, ctx)` lazily imports and mounts claimants;
  `claimRoute` resolves single-claim route slots (`tags-route`); `routes()` merges plugin
  routes into the router. Broken plugins are logged and skipped; an absent/empty manifest
  leaves the host inert (safe for tests — the hard constraint is enforced server-side).
- Plugins live under `frontend/src/plugins/<id>/index.js`, exporting `mount(el, ctx)`
  (slot/enhancer) or a page class (route). `EntryName` in the Go registry must match the
  directory name.

### Build pipeline

- `scripts/build-js.sh`: core `app.js` stays a **single unsplit bundle** (the PWA service
  worker precaches it; splitting the core would break offline for zero win). A second
  esbuild pass builds plugin entries with `--splitting --format=esm`, hashed into
  `frontend/js/p/<id>-<hash>.js`; `scripts/build-plugin-manifest.mjs` writes
  `frontend/js/plugin-manifest.json` (id → chunk), which the Go server reads at startup.
- `scripts/build-css.sh` emits per-plugin CSS to `frontend/css/p/<id>.css`, auto-wired
  into the manifest (`css` field). Never edit generated CSS bundles.
- Because the server loads the chunk map and hashed manifest **at startup**, JS changes
  require both a rebuild and a server restart in dev.

### Plugin catalog (registry as of 2026-07)

- **Route / tags-viz** (`Area: "tags-viz"`, `Exclusive` — exactly one claims `/tags`):
  `tags-atlas` (default), `tags-map` (Leaflet world map), `tags-graph` (force graph).
- **Slots**: `timeline`, `tag-cloud` (home-explore `ExploreBlock`), `nav-menu`,
  `breadcrumbs`, `public-header`, `public-footer`, `distraction-free`
  (post-list-tools), `immersive-share`, `slideshow`.
- **Enhancers**: `immersive` / `immersive-sheet` (exclusive pair, `Area: "immersive"`),
  `custom-css`, `comments` (remark42), `post-navigation`.
- **Admin routes** (`Core`): `media-library`, `admin-posts-list`, `admin-home`.
- **Services**: `instagram`, `ai-analysis`, `passkeys`, `api-keys`, `backups`,
  `offline-sync`, `rss`, `mcp` (the only `DefaultEnabled: false` service).

## Key architectural decisions

1. **Server-driven manifest, not a client plugin table** — the only design that satisfies
   the hard constraint.
2. **Manifest computed per request; chunk map loaded once** — enabled state is
   runtime-mutable, chunk names change only on deploy.
3. **`plugin.<id>.enabled` is deliberately NOT in `publicSettingKeys`** — exposing it
   would leak the existence of disabled plugins.
4. **Two esbuild passes** — `index.html` references `/assets/js/app.js` unhashed while
   chunks are content-hashed; one invocation can't apply both entry-name policies. Code
   shared between core and plugins is duplicated across the two graphs; acceptable since
   plugins are leaf features.
5. **`Core: true`** marks plugins whose absence leaves the admin unusable; the Plugins
   page treats them accordingly. `Exclusive`/`Area` model radio-button groups
   (tags-viz, immersive variants).

## Notes for future development

- Adding a plugin: create `frontend/src/plugins/<id>/index.js` (+ optional
  `<id>.css`), add one `Descriptor` line to `registry.go`, rebuild. CSS and manifest
  wiring is automatic.
- The settings deep-link mapping on the Plugins page lives in the frontend
  (`SETTINGS_PATHS` in `PluginsPage.js`), keeping the Go package free of admin routing.
- Known open items: per-request `GetAllSettings` on every SPA fallback is uncached
  (`point-perf-settings-cache-fxyf`); the esbuild metafile is publicly served
  (`point-ops-buildmeta-served-id0u`); CSS pipeline should gain esbuild parity
  (`point-css-esbuild-pipeline-ggxd`).
- `scripts/run.sh` mutates `frontend/index.html` (dev build version) — never commit it;
  the manifest is injected at serve time so it survives the dev rewrite, but builds must
  keep a literal `</head>` in `index.html`.
