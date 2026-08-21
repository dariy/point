# Repository map

The one page that answers **"which file do I edit?"**. It maps the path a request
takes through the code, and names the places where the optional parts — plugins,
themes, migrations, MCP — attach to it.

Deliberately shallow: it tells you where to look, not how the thing works. For
depth read [backend.md](./backend.md), [frontend.md](./frontend.md) and the
per-feature docs in [docs/features/](../features/). For commands read
[AGENTS.md](../../AGENTS.md), which carries a compact version of the backend
table below.

Point is one Go binary. It serves the JSON API, the SPA's static assets and the
media bytes from the same process and the same port; there is no separate
frontend server, and no service to run beside it except the optional remark42
comments sidecar.

---

## A request, from URL to SQL

| # | Step | Lives in | Owns |
|---|---|---|---|
| 1 | Route | `api/cmd/api/routes.go` | Path, method, and the middleware chain for that route. Every route is reached from here — one `register*Routes` per domain. |
| 2 | Handler | `api/internal/api/<domain>.go` | Parsing params, authorization checks, shaping the JSON. `mappers.go` turns DB models into response shapes; `MapError` in `errors.go` turns a service sentinel error into a status code. |
| 3 | Service | `api/internal/services/<domain>_service.go` | Business logic and side effects. Takes the `repository.Repository` **interface**, never a concrete type — that is what makes unit-test mocks possible. A service that outgrows one file splits by concern beside it, not into a subpackage: `PostService` is `post_service.go` + `post_render.go`, `post_css.go`, `post_publish.go`. The one subpackage is `services/pageview` — see below. |
| 4 | Repository | `api/internal/repository/queries_<domain>.go` | Hand-written SQL: anything sqlc cannot express (dynamic filters, multi-statement work, `IN (?…)` fan-outs). The interface itself is `db.go`. |
| 5 | sqlc | `api/internal/models/` | **Generated.** `queries.sql.go`, `models.go`, `querier.go`, `db.go` — regenerate, never hand-edit. `extra.go` is the one hand-written file in the package, for types that outlived their table. |
| 6 | SQL | `api/sql/queries.sql`, `api/sql/schema.sql` | The source of truth for both the schema and every generated query. |

`api/internal/services/pageview` is the single exception to the
"split beside it, not into a subpackage" rule above. The BFF page endpoints
(`/api/pages/...`) are aggregates named after frontend screens, and each one
composes across posts, tags, media and settings at once — it belongs to no
single domain service, so it sits beside them rather than inside one. It holds
the composition and the reading rules (visibility, the scheduled queue, the
public settings subset) and returns a typed view; `internal/api/pages.go` still
owns the wire format, so the JSON shape has exactly one author. The split is
what lets those rules be tested without an HTTP harness, and
`internal/api/testdata/pages_payloads.json` pins the resulting payloads.

Two kinds of middleware run before step 2. The global chain — logging, recover,
gzip, CORS, security headers and CSP, the public rate limiter — is built in
`api/cmd/api/server.go`. The per-route ones are attached in `routes.go` where
the route is declared: `AuthMiddleware`, `OptionalAuthMiddleware`,
`RequirePlugin` and `SessionOnlyMiddleware` from
`api/internal/api/middleware.go`, plus the edge-cache policy from
`api/cmd/api/cache.go`.

Two subsystems mount a whole subtree rather than individual paths, so grepping
`routes.go` for their URLs finds nothing: `registerMCPRoutes` calls
`mcp.Register`, which declares `/mcp` and the OAuth endpoints in
`api/internal/mcp/server.go`; `registerCommentRoutes` calls
`api.RegisterCommentsProxy`, which declares the `/comments` proxy group in
`api/internal/api/comments.go`. Both are still *reached* from `routes.go` — that
is the invariant. A new route goes in `routes.go` itself.

**Step 4 is often skipped.** `repository.Repository` embeds `models.Querier`, so
every sqlc-generated query is already a method on it. A service calling
`s.repo.GetPost(ctx, id)` goes straight from step 3 to step 5 — there is no
hand-written wrapper to find, and adding one is not the convention. Look in
`queries_*.go` only when the query is not in `queries.sql`.

Worked example, `GET /api/posts/42`:

`routes.go` → `registerPostRoutes` → `PostHandler.GetPostByID`
(`internal/api/posts.go`) → `PostService.GetPostByID`
(`internal/services/post_service.go`) → `repo.GetPost` (sqlc) → `-- name: GetPost`
in `api/sql/queries.sql`.

## Inside `api/cmd/api`

One concern per file. This is the package doc pointers rot in fastest, so check
the list below before trusting an older reference to `main.go`.

| File | Holds |
|---|---|
| `main.go` | Process lifecycle: config, migrations, start, graceful shutdown. |
| `cli.go` | Which subcommand the args name (`setup`, `reset-password`); each command's body gets its own file. `--create-api-key` is the exception — it needs the wired services, so `main.go` dispatches it after `initServices`. |
| `wiring.go` | `AppServices` — constructing every service once and handing them around. |
| `server.go` | `setupEcho`: Echo's own config, the global `e.Use`/`e.Pre` chain, handler construction, the two `index.html` shells. |
| `routes.go` | Route registration only. One `register*Routes` per domain; **registration order is load-bearing** (the `/*` SPA fallback must come last, the dated media path after `/api`). |
| `cache.go` | Request-time HTTP cache policy for HTML and API responses. |
| `assets.go` | The JS directory choice, the CSS content-hash manifest, and the shell markup — including `bootstrapScript`, the one inline `<script>` every document carries (`window.__PLUGINS__`, `window.__MEDIA__`). One body means one CSP hash. |
| `media.go` | Serving media bytes at `/YYYY/MM/filename`: visibility enforcement, which rung of the thumbnail ladder `?s=` selects, and the `Cache-Control` each outcome earns. |

## Where the optional parts attach

| Concern | Server side | Client side |
|---|---|---|
| **Plugin** | `api/internal/plugins/registry.go` — the catalog. A disabled plugin's routes 404 (`RequirePlugin`) and its JS chunk is withheld from the manifest. | `frontend/src/plugins/<id>/index.js` — exports `mount(el, ctx)` for a slot, or a page module for a route. Loaded by `frontend/src/core/pluginHost.js` from the enabled-only `window.__PLUGINS__`. |
| **Theme** | `api/internal/services/theme_service.go` scans the directory at runtime. | `frontend/themes/<name>.css` — a file of CSS custom properties plus three metadata comments. Not a template. |
| **Migration** | `api/internal/migrations/migrations.go` — the default place to append. `api/internal/repository/bootstrap_migrations.go` only for what a query in *that* package needs before it can run at all; additive statements only. | — |
| **MCP tool** | `api/internal/mcp/tools.go`, mounted by `registerMCPRoutes`. MCP has **no data path of its own** — `invoke.go` dispatches to the REST handlers with the caller's identity injected. Changing a handler changes the tool. | — |
| **Scheduled work** | `api/internal/services/scheduler.go`. | — |
| **Static assets, PWA, SPA fallback** | `registerStaticRoutes`, `registerPWARoutes`, `registerSPAFallback` in `routes.go`. | `frontend/index.html`, `frontend/sw.js`, `frontend/manifest.webmanifest`. |

## Adding a setting

The one common change that lands in four places rather than one, because a
setting is a DB row and not a config field. In order:

1. `frontend/src/pages/light/SettingsPage.js` — add the key to a group in
   `SETTING_GROUPS`; that alone renders an input and saves it.
2. `frontend/src/components/light/settingsFields.js` — a label override if the
   snake_case name does not humanise well, plus `NUMERIC_KEYS` or
   `DEFAULT_ON_KEYS` if it is a number or an on-by-default toggle.
3. `api/internal/api/settings.go` — add the key to `publicSettingKeys` **only**
   if unauthenticated visitors need it (it goes into every public page load);
   to `secretIsSetKeys` if it is a credential, so the value is never returned.
4. Wherever it is read: `settingsService.GetSetting(ctx, key, default)`. No
   registration step and no schema change — an unknown key simply has no row
   until it is first saved, which is why the default belongs at the read site.

An **environment variable** is the other thing: `api/internal/config/config.go`
plus a line in `.env.example`. Use one for what an operator sets before the
process starts (paths, ports, credentials); use a setting for what the owner
changes from the admin UI. `GetConfigSetting` bridges the two for the handful
that are both — env wins over the DB row, so a set env var permanently shadows
the admin input.

## The SPA

| Step | Lives in |
|---|---|
| Shell | `frontend/index.html` — served by the Go binary, with the CSS hashes and the bootstrap script injected at serve time. |
| Bootstrap | `frontend/src/app.js` — loads public settings, checks the session, applies the theme, declares the route table, starts the router. |
| Routing | `frontend/src/router.js` — History API, `load: () => import(…)` per route, auth guard. |
| Page | `frontend/src/pages/public/` (reader) and `frontend/src/pages/light/` (admin, under `/light`). |
| Component | `frontend/src/components/{public,light,shared}/`, all extending the base class in `frontend/src/components/Component.js`. |
| Server calls | `frontend/src/api/<domain>.js`, all built on the `api` fetch wrapper in `frontend/src/api/client.js`. |
| Shared state | `frontend/src/store.js` — a pub/sub key-value store; subscribe by key. |
| Cross-cutting machinery | `frontend/src/core/` — the plugin host, the grid and media pagers, gestures. Not a dumping ground: four files, each a subsystem a page uses rather than a helper it calls. |
| Helpers | `frontend/src/utils/` — small, pure, individually tested (EXIF parsing, media URLs, grid fitting, post-node serialisation). |
| Styles | `frontend/css/{common,light,public}/*.css` (sources) plus `frontend/src/plugins/<id>/*.css`. |

## Generated — never edit

An edit to any of these survives until the next build and no further.

| Generated | Edit instead | Then run | In git? |
|---|---|---|---|
| `api/internal/models/*.sql.go`, `models.go`, `querier.go` | `api/sql/queries.sql`, `api/sql/schema.sql` | `cd api && sqlc generate` (sqlc is optional to install — you only need it if you change the SQL) | **Committed** — regenerate and commit the result in the same change as the SQL. |
| `frontend/js/`, `frontend/js-debug/` | `frontend/src/` | `./scripts/build-js.sh` | gitignored |
| `frontend/css/main.css`, `light.css`, `viewer.css`, `css/p/`, `asset-manifest.json` | `frontend/css/{common,light,public}/*.css` and `frontend/src/plugins/<id>/*.css` | `./scripts/build-css.sh` | gitignored |
| `frontend/css/common/theme.css` | `frontend/themes/<name>.css`, or the custom-CSS setting | nothing — `ThemeService.SyncActiveTheme` rewrites it at startup and whenever the active theme changes | gitignored |

The sqlc output is the exception worth remembering: it is the only generated
tree that is committed, so a diff in `api/internal/models/` is expected in any
change that touches the SQL — and a *missing* one means you edited the schema
without regenerating.

Asset URLs are content-hashed and read once at startup, so **rebuilding is not
enough — restart the server** or the browser keeps loading the old hash.

## Everything else

| | |
|---|---|
| Go tests | Beside the code. `*_integration_test.go` carries `//go:build !unit` and uses a real in-memory SQLite; it runs by default, and `-tags=unit` is what narrows a run to the unit tests. |
| Frontend tests | `frontend/test/*.test.js`, run by `node --test`. |
| Scripts | `scripts/` — build, run, check, doctor, release. Indexed in `scripts/README.md`. |
| Config | `api/internal/config/config.go`; environment variables documented in `.env.example`. |
| Feature docs | `docs/features/<feature>.md` — each records what was built **and what was considered and rejected**. |
| Plugin docs | `docs/plugins/<id>.md`. |
| Backend-less UI demo | `demo/`. |
