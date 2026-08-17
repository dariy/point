# Agent Instructions

Point is a self-hosted photo blog engine: Go 1.26 + Echo v4 backend, SQLite (pure-Go
`modernc.org/sqlite`, no CGO), and a vanilla-JS SPA with no runtime dependencies. One binary serves
the API, the SPA, and media bytes.

This file is the contract for anyone — human or agent — changing this repository. Everything in it
is meant to be true and runnable; if a command here does not work, that is a bug worth reporting.

## Start here

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
| Dev server (no Docker) | `./scripts/run.sh` — port 8001; `-d`/`--debug` serves the debug bundle |
| Dev server (Docker) | `./scripts/rebuild.sh` — port 8000 |
| Full quality gate | `./scripts/check.sh` (`--fix` autofixes lint, `--short` skips slow tests, `--lint` lints only) |
| Go tests | `./scripts/run-tests.sh` (`--unit`, `--verbose`, `--race`, `--short`, `--bench`, `--html`) |
| Frontend tests | `npm run test:frontend` — `node --test frontend/test/*.test.js` |
| Rebuild CSS | `./scripts/build-css.sh` |
| Rebuild JS | `./scripts/build-js.sh` |
| Regenerate SQL layer | `cd api && sqlc generate` |

## Conventions that will bite you

**Never edit generated files.** They are gitignored and rebuilt on every run:

- `frontend/css/main.css`, `light.css`, `viewer.css`, `common/theme.css`, `css/p/`,
  `asset-manifest.json` — edit the sources in `frontend/css/{light,common,public}/*.css`, then run
  `./scripts/build-css.sh`.
- `frontend/js/`, `frontend/js-debug/` — edit `frontend/src/`, then `./scripts/build-js.sh`.
- `api/internal/models/queries.sql.go` — edit `api/sql/queries.sql` (and `schema.sql` for DDL), then
  `cd api && sqlc generate`. Config lives in `api/sqlc.yaml`.

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
| An HTTP route | `api/cmd/api/routes.go` — but note some routes are still registered inline in `api/cmd/api/main.go` (health, feeds, setup, auth, webauthn, comments, nav-menu, pages, timeline, MCP, static/SPA) |
| Request handling / validation | `api/internal/api/` |
| Business logic | `api/internal/services/` |
| Database access | `api/internal/repository/` (hand-written) and `api/internal/models/` (sqlc-generated) |
| The schema | `api/sql/schema.sql` + a migration in `api/internal/migrations/` |
| Auth, sessions, API keys | `api/internal/api/middleware.go`, `api/internal/services/auth_service.go` |
| MCP tools | `api/internal/mcp/tools.go` (see `api/internal/mcp/README.md`) |
| A page or component | `frontend/src/pages/`, `frontend/src/components/` |
| A plugin | `api/internal/plugins/registry.go` + `frontend/src/plugins/<id>/` |
| Themes | `frontend/themes/*.css` — a theme is a CSS custom-property file, not a template |

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
