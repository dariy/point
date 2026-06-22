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
| 2 — Frontend foundation | `point-plugin-system-tdgw.2` | ✅ Done |
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

## Phase 2 — Frontend foundation ✅

Shipped with **all plugins enabled and no chunks built → zero behavior change.**
Branch `plugins`.

### What was built

- **`frontend/src/core/pluginHost.js`** (new, the frontend half of the system):
  - `init(manifest)` reads the enabled-only `window.__PLUGINS__` (defaults to it).
  - `isEnabled(id)`, `size`, `slotEntries(slot)`, `hasSlot(slot)` — a slot is only
    *claimed* once a plugin has a built `entry` (chunk URL); enabled-but-not-yet-
    extracted plugins do **not** claim, so the shell keeps rendering them.
  - `fill(slot, el, ctx)` lazily `import()`s each claiming chunk and calls its
    `mount`/default export; one broken plugin is logged and skipped.
  - `claimRoute(slot, choose)` resolves the single module owning a single-claim
    route slot (`tags-route`); returns null when no claimant has a chunk.
  - `routes()` lists manifest route plugins (with chunks) to merge, excluding the
    single-claim `tags-route`. `loadEntry(e)` imports a route plugin's chunk.
  - Singleton `pluginHost`, memoising each chunk import.
- **`frontend/src/app.js`**: `pluginHost.init()` at module load;
  `resolveTagsModule()` rewritten as the `tags-route` claimant (manifest-driven,
  falls back to core `Atlas/Map/Tags` pages until Phase 4 builds chunks);
  manifest route-merge loop appended after the static route table.
- **Shell slot insertion points** (guarded `hasSlot` → `fill`, else core render):
  `HomePage.js` (`home-explore` tag cloud, `timeline`), `PostContent.js`
  (`post-viewer` immersive viewer), `PublicHeader.js` (`breadcrumbs`, `nav-menu`).
- **Build pipeline**:
  - `scripts/build-js.sh` keeps the single-file core `app.js` (unchanged
    contract) **and** builds `frontend/src/plugins/<id>/index.js` entries with
    `--splitting --format=esm`, hashed under `frontend/js/p/<id>-<hash>.js`.
  - `scripts/build-plugin-manifest.mjs` turns the esbuild metafile into
    `frontend/js/plugin-manifest.json` (`{id: "<id>-hash.js"}`), the map the Go
    server reads (`plugins.LoadChunkMap`).
  - No plugin entries yet → manifest is `{}` (was absent before; now always
    present). `scripts/build-css.sh` mirrors with per-plugin CSS chunks under
    `frontend/css/p/<id>.css` (no-op until plugins ship CSS; wired in Phase 5).

### Key decisions (and the reasoning)

1. **Core `app.js` stays a single bundle (no `--splitting` on the core entry).**
   Splitting the core would emit many runtime chunks the PWA service-worker shell
   cache doesn't precache (offline regression) for **zero** payload win in Phase 2
   — the shrink comes in Phase 4 when feature code *moves out* of the core graph
   into plugin entries, not from splitting the same code. So only the plugin pass
   uses `--splitting`. Revisit core splitting + SW cache-from-manifest in Phase 5.
2. **A plugin claims a slot only when it has a built chunk (`entry` non-empty).**
   In Phase 2 every manifest entry has an empty `entry` (Phase 1 ships an empty
   chunk map), so `hasSlot` is uniformly false and the shell renders every feature
   directly — byte-for-behavior identical to today. Phase 4 flips each slot by
   shipping the chunk; the `hasSlot` guard switches the branch automatically.
3. **`pluginHost` is inert without a manifest.** `size === 0` (absent/empty
   `window.__PLUGINS__`, e.g. unit tests) means slots stay unfilled, routes empty,
   and the `tags-route` enablement gate is skipped — callers fall back to current
   behavior. The hard constraint is enforced server-side (chunks/routes 404); the
   frontend gate is a UX nicety, so failing open here is safe.
4. **Two esbuild passes, not one.** `index.html` references `/assets/js/app.js`
   by a fixed (unhashed) name, while plugin chunks must be content-hashed — a
   single invocation can't apply two `--entry-names` policies. The cost is that
   code shared between core and plugins is duplicated across the two split graphs;
   plugins are leaf features, so this is acceptable.
5. **`tags-route` keeps reading `tags_module`/`tags_visibility`.** That route-gate
   policy is unchanged; the plugin layer only (a) maps the chosen module to a
   plugin id, (b) treats an admin-disabled tag-viz plugin as "none" when a
   manifest is present, and (c) prefers the plugin chunk once built. With all
   plugins enabled and no chunks, every path resolves to the same core module.

### Verification

- `node --test frontend/test/*.test.js` — 96 pass, incl. new
  `frontend/test/pluginHost.test.js` (manifest read, slot-claim only with chunk,
  `routes()` excludes `tags-route`, `claimRoute`/`fill` import via data: URLs,
  inert empty manifest). `eslint frontend/src` clean. `go build ./...` +
  `internal/plugins` / `cmd/api` tests pass (backend unchanged; now finds a real
  `{}` manifest file).
- Build smoke test with a throwaway `frontend/src/plugins/demo-plugin/`: emits
  `frontend/js/p/demo-plugin-<hash>.js`, `plugin-manifest.json` →
  `{"demo-plugin": "demo-plugin-<hash>.js"}`, and `css/p/demo-plugin.css`.
- Live (`./point` on :8001): served HTML injects the enabled-only
  `window.__PLUGINS__` (entries with no `entry` URL), `/assets/js/app.js` → 200,
  `/assets/js/p/<unknown>.js` → 404.

### Carry-forward notes for later phases

- **Phase 3** (admin Plugins page): toggling `plugin.<id>.enabled` changes the
  injected manifest on next load; the frontend already reacts (disabled tag-viz →
  home redirect, slot unfilled). No frontend host changes needed to *gate*; the
  page just needs the list/toggle API.
- **Phase 4** (extraction): create `frontend/src/plugins/<id>/index.js` exporting
  `mount(el, ctx)` (slot/enhancer) or `{ default: PageClass }` (route). The build
  then emits its chunk and `plugin-manifest.json` gains the id → `hasSlot` flips
  the shell branch and removes the need for the direct core render. `EntryName` in
  the Go `Registry` is the directory name under `src/plugins/`.
- **`build-css.sh`** already emits `css/p/<id>.css` from plugin CSS partials;
  Phase 5 wires loading those alongside the chunk and derives the SW precache list
  from the manifest.

## Open items / risks (tracked for Phase 5)

- Per-request `GetAllSettings` on the SPA fallback + gated chunk handler is an
  uncached DB read per page load. Acceptable now; revisit with settings caching.
- Manifest injection only covers the `/*` SPA fallback. The
  `serveSimplifiedMedia` path that serves `index.html` for SPA-style media URLs
  was **not** updated — edge case; confirm/extend if it surfaces.
- CSS splitting (per-plugin chunks) is unstarted and is the harder half of the
  payload win; may lag JS by a phase per the proposal.
