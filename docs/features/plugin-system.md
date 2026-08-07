# Plugin System

Most of Point's features ship as plugins that the admin can toggle from
`/light/plugins`. The defining property — the **hard constraint, never relax it** — is
that the client receives an **enabled-only** manifest: disabled plugins never appear in
served HTML/JS, their JS chunks 404, and their API routes 404. The server is the single
source of truth.

## What is implemented

All five phases of the original refactor are done.

### Backend (`api/internal/plugins/registry.go`)

- `Descriptor` + static `Registry` slice (~30 plugins). Fields: `ID`, `Type`
  (route / slot / enhancer / service), `Slot`, `Routes`, `EntryName`, `DefaultEnabled`,
  `Title`. How many plugins may claim a slot is not a descriptor field — it belongs
  to the slot, in the `SlotCardinality` table (`0+`, `0-1`, `1`, `1+`).
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

- **Route / tags-viz** (slot `tags-route`, cardinality `0-1` — one claims `/tags`,
  or none and the route is hidden): `tags-atlas` (default), `tags-map` (Leaflet
  world map), `tags-graph` (force graph).
- **Slots**: `timeline`, `tag-cloud` (home-explore `ExploreBlock`), `nav-menu`,
  `breadcrumbs`, `public-header`, `public-footer`, `distraction-free`
  (post-list-tools), `immersive-share`, `slideshow`.
- **Enhancers**: `immersive` / `immersive-sheet` (slot `post-viewer`, cardinality
  `1` — exactly one viewer, always),
  `custom-css`, `comments` (remark42), `post-navigation`.
- **Admin routes** (`Core`): `media-library`, `admin-posts-list`, `admin-home`.
- **Services**: `instagram`, `ai-analysis`, `passkeys`, `api-keys`, `backups`,
  `offline-sync`, `rss`, `version-check`, `mcp` (the only `DefaultEnabled: false`
  service).

### Per-plugin settings drawer

`PLUGIN_SETTINGS` in `PluginsPage.js` maps a plugin id to the settings it shows in
the right-hand drawer (`PluginSettingsPanel.js`): `keys` renders plain settings
fields saved together through `PUT /api/settings`, `sections` mounts self-contained
components from `components/light/sections/` (backups, Instagram import, passkeys,
API keys, offline data, sync queue, version check). Plugins whose configuration is a
whole page instead deep-link via `SETTINGS_PAGE_PATHS`.

`version-check` is the pattern for a *verifiable* service plugin: the section shows
the running version, the newest upstream tag and when that answer was obtained, and
its **Check now** button posts to `/api/system/version/check`, which bypasses the 24h
cache and reports `fetched` plus the upstream `error` verbatim. Without it, a
plugin whose only visible output is an absent banner cannot be told apart from a
broken one. Failed checks never clear the last known `latest` — a flaky network must
not turn "update available" into "you're up to date". Exercising the update paths
locally needs a semver version to compare (a dev build's `dev-…` stamp never looks
out of date): `scripts/run-old-version-check.sh` runs the dev server pinned to an
old release for exactly that.

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
5. **Cardinality is a property of the slot, not of the plugins** — `SlotCardinality`
   says how many enabled plugins a region takes (`0+` default, `0-1`, `1`, `1+`), and
   every rule follows from it: a single-claim slot (`0-1`, `1`) makes its candidates a
   radio group — enabling one switches the peers off (`SlotPeers`) — and a slot that
   requires a claimant (`1`, `1+`) locks its last enabled one (`IsLockedOff` → 409).
   `tags-route` is `0-1` (none = /tags hidden), `post-viewer` is `1` (an immersive post
   renders nothing else). Whole-configuration writes go through `NormalizeSlots`, which
   trims and refills slots to satisfy the same rules; installs configured before a rule
   existed are reconciled once by a migration, the way `tags_module` was.

## Notes for future development

- Adding a plugin: create `frontend/src/plugins/<id>/index.js` (+ optional
  `<id>.css`), add one `Descriptor` line to `registry.go`, rebuild. CSS and manifest
  wiring is automatic.
- The settings deep-link mapping on the Plugins page lives in the frontend
  (`SETTINGS_PATHS` in `PluginsPage.js`), keeping the Go package free of admin routing.
- Known open items: per-request `GetAllSettings` on every SPA fallback is uncached;
  the esbuild metafile is publicly served; CSS pipeline should gain esbuild parity.
- `scripts/run.sh` mutates `frontend/index.html` (dev build version) — never commit it;
  the manifest is injected at serve time so it survives the dev rewrite, but builds must
  keep a literal `</head>` in `index.html`.
