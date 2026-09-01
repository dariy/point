# Agent Instructions

Point is a self-hosted photo blog engine: Go 1.26 + Echo v4 backend, SQLite (pure-Go
`modernc.org/sqlite`, no CGO), and a vanilla-JS SPA with no runtime dependencies. One binary serves
the API, the SPA, and media bytes.

This file is the contract for anyone — human or agent — changing this repository. Everything in it
is meant to be true and runnable; if a command here does not work, that is a bug worth reporting.

## Start here

<!-- verify:skip run.sh serves until interrupted (CI smokes it separately); check.sh is the gate CI already runs -->
```bash
./scripts/run.sh      # build everything, serve on http://localhost:8001
./scripts/check.sh    # the quality gate: lint, vet, tests, coverage floors, vuln scan
```

`run.sh` needs no configuration on a fresh clone. It builds CSS and JS (running `npm ci` itself if
`esbuild` is missing), compiles the Go binary, creates `data/`, initializes the SQLite schema, and
serves. First run opens a setup wizard at the root URL.

`check.sh` is the same set of checks CI runs. Run it before you open a PR — it keeps going after a
failure and prints a PASS/FAIL summary, so one red step still tells you about the rest.

## Commands

| Task | Command |
|---|---|
| Environment check | `./scripts/doctor.sh` — PASS/WARN/FAIL per tool, `--json` for machine use; exits non-zero only when a build is impossible |
| Dev server (no Docker) | `./scripts/run.sh` — port 8001; `-d`/`--debug` serves the debug bundle <!-- verify:skip serves until interrupted; CI starts it and curls /health instead --> |
| Dev server (Docker) | `./scripts/rebuild.sh` — port 8000 <!-- verify:skip needs Docker; the image is built by the docker-smoke job --> |
| Full quality gate | `./scripts/check.sh` (`--fix` autofixes lint, `--short` skips slow tests, `--lint` lints only) <!-- verify:skip the gate CI already runs, one job per step --> |
| Go tests | `./scripts/run-tests.sh` (`--unit`, `--verbose`, `--race`, `--short`, `--bench`, `--html`) |
| Frontend tests | `npm run test:frontend` — `node --test frontend/test/*.test.js` |
| Frontend typecheck | `npm run typecheck` — `tsc --noEmit` over the JSDoc types; no `.ts` files, no emit |
| Browser automation | `npx --no-install playwright-cli --version` — drives a real Chromium from the shell, so a UI change can be looked at; see [Verifying your change](#verifying-your-change) |
| Rebuild CSS | `./scripts/build-css.sh` |
| Rebuild JS | `./scripts/build-js.sh` |
| Regenerate SQL layer | `cd api && sqlc generate` <!-- verify:skip needs the sqlc binary, which is not part of the documented toolchain --> |
| Check the SQL layer | `./scripts/check-sql-layer.sh` — no shadowed queries, generated models match `api/sql/` |
| Release tarball | `./scripts/build-tarball.sh` — `dist/point-linux-{amd64,arm64}.tar.gz`, what `install.sh --method=native` downloads <!-- verify:skip cross-compiles both arches; the release workflow builds and boots it on every tag --> |

`check.sh` also needs `golangci-lint` and `govulncheck` on your `PATH`; everything else in this
table runs with just Go and Node. `doctor.sh` is where that becomes visible before a failing run
does it for you — it reports every version this repo requires against what you have, reading them
from `api/go.mod` and `.github/workflows/test.yml` so it cannot disagree with CI, and prints the
install line for whatever is missing.

Every command in this file, in [CONTRIBUTING.md](CONTRIBUTING.md), in [QUICKSTART.md](QUICKSTART.md)
and in [ai-declaration.md](ai-declaration.md) is executed on every PR by the `docs-commands` job — locally, that is `./scripts/check-docs.sh`. If a
command you add cannot run unattended, mark it in the source with
`<!-- verify:skip reason -->` rather than teaching the runner about it.

## Conventions that will bite you

**Never edit generated files.** They are gitignored and rebuilt on every run:

- `frontend/css/main.css`, `light.css`, `viewer.css`, `common/theme.css`, `css/p/`,
  `asset-manifest.json` — edit the sources in `frontend/css/{light,common,public}/*.css`, then run
  `./scripts/build-css.sh`.
- `frontend/js/`, `frontend/js-debug/` — edit `frontend/src/`, then `./scripts/build-js.sh`.
- `api/internal/models/queries.sql.go`, `models.go`, `querier.go`, `db.go` — edit
  `api/sql/queries.sql` (and `schema.sql` for DDL), then `cd api && sqlc generate`. Config lives in
  `api/sqlc.yaml`. `extra.go` in the same package is hand-written. Keep `queries.sql` ASCII: sqlc
  expands `SELECT *` by byte offset, so one em dash in a comment breaks every query after it.

**Two vendored files carry a Point patch.** `frontend/vendor/leaflet/leaflet.js`
and `frontend/vendor/codejar/codejar.js` route their own HTML writes through a
Trusted Types policy, because the CSP enforces
`require-trusted-types-for 'script'` and a plain string at `.innerHTML` is
refused — leaflet would die at import time, codejar would corrupt the buffer on
Ctrl+Z. A version bump that drops a fresh upstream build over either file
reverts the patch; re-apply the block marked `/* Point patch — Trusted Types */`
at the top of the file. `scripts/check-vendor-sinks.sh` fails when that has not
happened, and [docs/vendors.md](docs/vendors.md) has the detail.

**Do not add a query whose name is already a method on `*sqliteRepository`.** The repository embeds
`*models.Queries`, and a hand-written method shadows the promoted one — the generated query
compiles and never runs, with nothing to catch it. `scripts/check-sql-layer.sh` (part of
`check.sh` and CI) fails on any such collision, and on generated files that no longer match the
SQL. When the repository needs dynamic SQL sqlc cannot express, the query belongs only in
`api/internal/repository/queries_*.go`, declared on the `Repository` interface in `db.go`.

**Integration tests run by default.** They live in `*_integration_test.go` files carrying
`//go:build !unit` and use a real in-memory SQLite. A plain `go test ./...` builds and runs them.
Pass `-tags=unit` (or `./scripts/run-tests.sh --unit`) to narrow to unit tests only — and expect the
coverage number from a unit-only run to be much lower, because it is measured against a smaller set
of tests. Full conventions, including the `mockRepository` pattern for unit tests, are in
[docs/testing.md](docs/testing.md).

**New services take the `repository.Repository` interface**, not a concrete type — that is what
makes the unit-test mocks possible. The interface is defined in `api/internal/repository/db.go`.

**Plugins are gated end to end.** A feature registered in `api/internal/plugins/registry.go` only
exists when enabled: its API routes 404 via `RequirePlugin`, and its JS chunk is withheld from the
client manifest. If a route or a UI element "disappears", check whether its plugin is on before
assuming a bug.

**Local dev binds loopback by default.** `scripts/run.sh` honors an optional `LOCAL_RUN` environment
variable as the bind host; unset, the server listens on `127.0.0.1`. Set `LOCAL_RUN=0.0.0.0` only if
you need to reach the dev server from another device.

## Where things live

| To change… | Start at |
|---|---|
| An HTTP route | `api/cmd/api/routes.go` — one `register*Routes` function per domain, called from `setupEcho` in registration order. New routes go here; `/mcp` and `/comments` mount their own subtrees from their packages, but still only via this file |
| Global middleware, CSP, the HTML shells | `api/cmd/api/server.go` — `setupEcho`: Echo's own config, the `e.Use`/`e.Pre` chain, handler construction |
| Startup, shutdown, migrations | `api/cmd/api/main.go` — process lifecycle only; services are wired in `wiring.go`, subcommands dispatched in `cli.go` |
| A CLI subcommand (`setup`, `reset-password`, …) | `api/cmd/api/cli.go` decides which one the args name; the command itself gets its own file |
| Serving media bytes / frontend assets | `api/cmd/api/media.go`, `api/cmd/api/assets.go`; cache headers for HTML and API responses in `api/cmd/api/cache.go` |
| Request handling / validation | `api/internal/api/` |
| Business logic | `api/internal/services/` |
| A BFF page aggregate (`/api/pages/...`) | `api/internal/services/pageview/` composes the view; `api/internal/api/pages.go` renders it to JSON |
| Database access | `api/internal/repository/` (hand-written) and `api/internal/models/` (sqlc-generated) |
| The schema | `api/sql/schema.sql` + a migration in `api/internal/migrations/` |
| Auth, sessions, API keys | `api/internal/api/middleware.go`, `api/internal/services/auth_service.go` |
| MCP tools | `api/internal/mcp/tools.go` (see `api/internal/mcp/README.md`) |
| A page or component | `frontend/src/pages/`, `frontend/src/components/` |
| A plugin | `api/internal/plugins/registry.go` + `frontend/src/plugins/<id>/` |
| Themes | `frontend/themes/*.css` — a theme is a CSS custom-property file, not a template |

The fuller version of this table — the whole request path, where plugins, themes, migrations and MCP
attach, and which files are generated — is [docs/architecture/map.md](docs/architecture/map.md).

Architecture in depth: [docs/architecture/backend.md](docs/architecture/backend.md),
[docs/architecture/frontend.md](docs/architecture/frontend.md). Every significant feature has a doc
under [docs/features/](docs/features/) that records what was built **and what was considered and
rejected** — read the relevant one before redesigning something.

## Git & PRs

- **PRs target `develop`.** `main` is for releases only.
- Tests accompany new or changed behaviour; coverage floors are enforced in CI and will fail the
  build if you lower them.
- Run `./scripts/check.sh` before pushing.

## Verifying your change

Do not stop at "it compiles". Prove the change:

- **Backend** — a test in the matching `*_test.go` / `*_integration_test.go`, plus `curl` against
  `./scripts/run.sh` for anything HTTP-facing.
- **Frontend** — a test in `frontend/test/`, plus loading the page on :8001.
- **Anything user-visible** — say in the PR what you actually ran and what you saw.

If you are an agent, "loading the page" is something you can do too. `npm ci` puts `playwright-cli`
in `node_modules/.bin`, and one command makes it usable:

<!-- verify:skip downloads a browser; the Commands table checks that the CLI itself is installed -->
```bash
npx playwright-cli install                       # once: downloads Chromium, writes .playwright/
npx playwright-cli open http://localhost:8001    # then drive the page: snapshot, click, fill, console
```

Without that first command the CLI looks for Google Chrome at a system path and fails on a machine
that has none. `.claude/skills/playwright-cli/` ships in this repository so the whole command set is
documented where an agent will read it.

A clean clone has nothing to look at, though: the server 302s every path to `/setup` until an owner
exists, and an empty archive hides most of the public site. Get past both over the API, then drive
the page:

<!-- verify:skip drives a browser against a server this runner does not start -->
```bash
./scripts/run.sh &                                                          # :8001
PW=$(node -e 'console.log(require("crypto").createHash("sha256").update("devpassword").digest("hex"))')
curl -s -X POST http://localhost:8001/api/setup -H 'Content-Type: application/json' \
  -d "{\"name\":\"$PW\",\"blog_title\":\"Dev Blog\",\"author_name\":\"Dev\",\"email\":\"dev@example.com\"}"
curl -s -c cookies.txt -X POST http://localhost:8001/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"the_owner\",\"name\":\"$PW\"}"
curl -s -b cookies.txt -X POST http://localhost:8001/api/posts -H 'Content-Type: application/json' \
  -d '{"title":"A post","content":"Body text.","excerpt":"Card text.","status":"published"}'

npx playwright-cli open http://localhost:8001
npx playwright-cli screenshot --filename=before.png
```

The password field is named `name` and holds a SHA-256 hex digest — the browser hashes before
sending, and both endpoints expect what the browser would send. For the admin UI, hand the browser
that session instead of driving the login form:
`npx playwright-cli cookie-set session "$(awk '/session/{print $7}' cookies.txt)" --domain=localhost`.

**After editing CSS or JS, re-run `./scripts/run.sh` before reloading.** Assets are served at
content-hashed URLs read from `asset-manifest.json` at startup, so a rebuild alone leaves the page
pointing at the old hash it has already cached, and your change appears to have done nothing.

The full recipe — seeding media, which console errors are normal, and how to tell "my CSS did not
apply" from "that text comes from a different element" — is in
[docs/testing.md](docs/testing.md#verifying-a-ui-change).

That directory is written by the tool itself and is not edited by hand, which is why `package.json`
pins `@playwright/cli` to an exact version rather than a range. If the two ever drift — after a
dependency bump, say — the CLI prints a warning on every run, and `npx playwright-cli install
--skills` rewrites the skill to match.
