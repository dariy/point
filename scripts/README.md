# Utility Scripts

Development, build and test scripts for Point. Production deployment lives
outside this repo — see [Production](#production) below.

## Local Development

- **doctor.sh**: Environment readiness — Go, Node, npm and the installed JS
  dependencies, `golangci-lint`, `govulncheck`, `sqlc`, whether port 8001 is
  free and whether `data/` is writable. Every wanted version is read from the
  file that already decides it (`api/go.mod`, `.github/workflows/test.yml`), so
  the report cannot drift from CI. `--json` emits the same rows for machines.
  FAIL means a build is impossible and sets exit status 1; the tools only
  `check.sh` needs are WARN, since you can build and run Point without them.
- **run.sh**: The local dev runner — no Docker. Rebuilds CSS/JS and runs the API
  directly on port 8001, sourcing machine-specific env (data paths, `HOST`) from
  `.env`. This is the primary way to run Point locally.
- **build-css.sh**: Concatenates CSS modules (`frontend/css/{light,common,public}/*.css`)
  into the served bundles (`main.css`, `light.css`, `common/theme.css`). Never
  edit the generated bundles directly — edit the sources and re-run this.
- **build-js.sh**: Bundles and minifies frontend JS with esbuild. Produces both a
  debug and a minified bundle set so the backend can serve either without a
  rebuild (`FRONTEND_DEBUG`).
- **build-plugin-manifest.mjs**: Writes the hashed plugin manifest consumed by the
  plugin loader. Invoked by `build-js.sh`; not run directly.
- **run-remark42-local.sh**: Runs the bundled remark42 comments engine locally
  for dev, mirroring what `build/Dockerfile` + `entrypoint.sh` do in the
  container. Started automatically by `run.sh` when comments are enabled.
- **run-old-version-check.sh**: `run.sh` with `APP_VERSION` pinned to an old
  release (default `v0.1.35`), so the upstream tag always looks newer and the
  `version-check` plugin's update paths render — the dashboard banner and the
  plugin's settings drawer. `--reset-cache` also forgets the last upstream
  answer, exercising the cold path. Manual test only; a dev build's "dev-…"
  version is not semver and never compares as out of date.

## Quality Gate

- **check.sh**: The full quality gate — lint, vet, tests, vulnerability scan. Run
  this before committing. Flags:
  - `--fix` — auto-fix lint issues
  - `--short` — skip long-running integration tests
  - `--lint` — lint only, skipping vet/tests/vuln scan (this is `npm run lint`)
- **run-tests.sh**: Go test runner. Runs unit + integration tests
  by default; `--unit` for unit-only, `--race` for the race
  detector, `--html` for a coverage report. See
  [docs/testing.md](../docs/testing.md).
- **check-docs.sh**: Runs the commands the documentation promises — the fenced
  `bash` blocks in `AGENTS.md`, `CONTRIBUTING.md`, `QUICKSTART.md` and
  `ai-declaration.md`, plus the command table in `AGENTS.md`. `--list` shows the plan without running it, and
  a trailing file list overrides which docs are read. A command that cannot run
  unattended is marked in the doc with `<!-- verify:skip reason -->` (or
  `<!-- verify:tmpdir -->` to run in a scratch directory) — the runner itself
  knows nothing about individual commands. The `docs-commands` CI job runs this
  on every PR; `check.sh` does not, because several of the blocks reach the
  network.

## Recovery

- **restore-db.sh**: Puts a known-good database back by hand, from either a
  `.db` snapshot (what the pre-migration guard writes to
  `data/backups/migrations/`) or a `.tar.gz` archive (what the admin UI and the
  scheduler write). Use it when the automatic restore failed, when a migration
  succeeded but was wrong, or when the container won't boot far enough to reach
  the UI. `--list` shows what is available; the database it replaces is kept.
  See [docs/plugins/backups.md](../docs/plugins/backups.md#pre-migration-snapshots).

## Docker / Podman Build

- **rebuild.sh**: Builds the container image (`build/Dockerfile`) and restarts
  it — this is the Docker/Podman path, served on :8000, distinct from
  `run.sh`'s native :8001 dev server.
- **entrypoint.sh**: Container entrypoint — creates data directories if missing
  before starting the app.

## Production

No deployment scripts live in this repo. To run Point on a server, see
[QUICKSTART.md](../QUICKSTART.md) — `quickstart/install.sh` and
`quickstart/docker-compose.yml` deploy the published image. Pin a version tag
rather than `latest` for production.
