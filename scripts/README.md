# Utility Scripts

Development, build and test scripts for Point. Production deployment lives
outside this repo — see [Production](#production) below.

## Local Development

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

## Quality Gate

- **check.sh**: The full quality gate — lint, vet, tests, vulnerability scan. Run
  this before committing. Flags:
  - `--fix` — auto-fix lint issues
  - `--short` — skip long-running integration tests
  - `--lint` — lint only, skipping vet/tests/vuln scan (this is `npm run lint`)
- **run-tests.sh**: Go test runner. Runs unit + integration tests
  (`-tags=integration`) by default; `--unit` for unit-only, `--race` for the race
  detector, `--html` for a coverage report. See
  [docs/testing.md](../docs/testing.md).

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
