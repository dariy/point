# Plugin System — Implementation Progress

Living log of decisions and status for the plugin-system refactor
(`point-plugin-system-tdgw`). Companion to the design in
[`plugin-system_proposal.md`](plugin-system_proposal.md); that doc is the plan,
this one records what was actually built and why.

**Hard constraint (never relax):** the client receives an **enabled-only**
manifest. Disabled plugins must never appear in served HTML/JS, their chunks
must 404, and their API routes must 404. Server is the source of truth.

## Status

| Phase | Issue | Status |
|---|---|---|
| 1 — Backend foundation | `point-plugin-system-tdgw.1` | ✅ Done |
| 2 — Frontend foundation | `point-plugin-system-tdgw.2` | ⏳ Not started (unblocked) |
| 3 — Admin Plugins page | `point-plugin-system-tdgw.3` | ⏳ Blocked on Phase 2 |
| 4 — Extract plugins (.4–.12) | `point-plugin-system-tdgw.4`…`.12` | ⏳ Blocked |
| 5 — Hardening | `point-plugin-system-tdgw.13` | ⏳ Blocked |

---

## Phase 1 — Backend foundation ✅

Shipped with **all plugins enabled by default → zero behavior change.** Commit
`c476d37` on branch `plugins`.

### What was built

- **`api/internal/plugins/registry.go`** (new package, source of truth):
  - `Descriptor` + static `Registry` slice — 20 plugins, all `DefaultEnabled:true`.
  - `EnabledKey(id)` → `plugin.<id>.enabled` settings key.
  - `IsEnabled(id, settings)` — absent key falls back to `DefaultEnabled`; unknown id never enabled.
  - `BuildManifest(settings, chunks)` — **enabled-only** `[]ManifestEntry`; resolves `Entry` to `/assets/js/p/<chunk>` when a chunk exists.
  - `PluginForChunk(chunks, name)` — reverse map for chunk authorization.
  - `LoadChunkMap(path)` — reads `frontend/js/plugin-manifest.json`; missing/malformed → empty map.
- **`api/cmd/api/main.go`**:
  - `pluginManifestScript()` injects `window.__PLUGINS__` into served `index.html` — **both** the per-post `</head>` rewrite *and* the generic SPA-fallback branch (previously `c.File`, now read+inject+`c.HTML`).
  - Gated `GET /assets/js/p/*` handler: 404s disabled/unknown chunks, `filepath.Base(filepath.Clean(...))` blocks traversal; registered **before** `e.Static("/assets/js", …)` so the longer literal prefix wins.
  - `chunkMap` loaded once at startup.
- **`api/internal/api/middleware.go`**: `RequirePlugin(settingsService, id)` → 404 when disabled. Defined only; wraps no routes yet (Phase 4 adopts it).
- **`api/internal/api/setup.go`**: seeds `plugin.<id>.enabled` for fresh installs.

### Key decisions (and the reasoning)

1. **`plugins` package imports nothing project-internal.** Enabled-state is
   resolved from a plain `map[string]string` (the `GetAllSettings` result), not
   a service handle. Avoids an import cycle (`api` → `plugins`) and lets callers
   own caching/storage policy.
2. **Manifest computed per request; chunk map loaded once.** Enabled-state is
   runtime-mutable (admin toggles), so it cannot be cached at boot; the chunk
   map only changes on deploy, so it is read once.
3. **Inline injection is XSS-safe via default `json.Marshal`** (escapes `<`,
   `>`, `&` → `<` etc.). Registry content is static/trusted anyway, but the
   escaping is the durable guarantee.
4. **`plugin.<id>.enabled` is deliberately NOT in `publicSettingKeys`.**
   Exposing it via `/api/settings/public` would leak the *existence* of disabled
   plugins, violating the hard constraint. The enabled-only manifest is the
   single delivery channel.
5. **Existing installs need no migration.** Absent keys fall back to
   `DefaultEnabled:true`, so upgrades behave as fully-enabled. Seeding in
   `setup.go` only fixes values for fresh installs.
6. **Phase 1 ships an empty chunk map** (no per-plugin chunks built until Phase
   2's `--splitting` pipeline). Consequence: every `/assets/js/p/*` request
   404s and every manifest `Entry` is empty — the correct foundation state, and
   why there is no observable behavior change.
7. **Generic SPA branch now reads + templates `index.html` per request**
   (was `c.File`). Minor per-request cost, mirrors the existing per-post path.
   Caching is a Phase 5 hardening concern (see Open items).

### Plugin catalog as encoded in `Registry`

`tags-atlas`/`tags-map`/`tags-graph` (route, slot `tags-route`), `timeline`
(slot), `tag-cloud` (slot `home-explore`), `nav-menu` (slot), `breadcrumbs`
(slot), `public-header` (slot `header`), `public-footer` (slot `footer`),
`immersive` (enhancer, slot `post-viewer`), `custom-css` (enhancer),
`media-library`/`admin-posts-list`/`admin-home` (admin routes), `instagram`/
`ai-analysis`/`passkeys`/`api-keys`/`backups`/`offline-sync` (services).

### Verification

`go build ./...`, `go vet`, `gofmt` clean; full backend suite passes. New tests:
`internal/plugins/registry_test.go` (logic + enabled-only invariant: no disabled
id and no `DefaultEnabled` field ever marshals), `internal/api/middleware_test.go`
(`RequirePlugin` enable→pass / disable→404 / re-enable→pass), and
`cmd/api/main_plugins_test.go` (router-level: static `app.js` still serves,
enabled chunk serves, disabled/unknown/traversal 404, disabled plugin absent
from served HTML).

### Carry-forward notes for later phases

- **Phase 2** must make `scripts/build-js.sh` emit `frontend/js/plugin-manifest.json`
  mapping each plugin `EntryName` → hashed chunk filename, and place chunks under
  `frontend/js/p/`. Until then `Entry` stays empty (no breakage). The frontend
  `PluginHost` reads `window.__PLUGINS__` (already injected). `EntryName` values
  in `Registry` are the contract — keep them in sync with build entry points.
- **Phase 4** wires `RequirePlugin(svcs.Settings, "<id>")` onto each service/
  admin route group. The `Routes` field in each `Descriptor` documents the
  intended prefixes.
- **`run-local.sh` mutates `frontend/index.html`** (dev build). The manifest is
  injected at serve time, not into the file, so it survives the dev rewrite —
  but Phase 2's build changes must keep a `</head>` present in `index.html`.

## Open items / risks (tracked for Phase 5)

- Per-request `GetAllSettings` on the SPA fallback + gated chunk handler is an
  uncached DB read per page load. Acceptable now; revisit with settings caching.
- Manifest injection only covers the `/*` SPA fallback. The
  `serveSimplifiedMedia` path that serves `index.html` for SPA-style media URLs
  was **not** updated — edge case; confirm/extend if it surfaces.
- CSS splitting (per-plugin chunks) is unstarted and is the harder half of the
  payload win; may lag JS by a phase per the proposal.
