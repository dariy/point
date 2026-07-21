# Utility Scripts

This directory contains scripts for development, testing, building, and deploying
Point.

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
- **run-remark42-local.sh**: Runs the bundled remark42 comments engine locally
  for dev, mirroring what `build/Dockerfile` + `entrypoint.sh` do in the
  container.

## Quality Gate

- **check.sh**: The full quality gate — lint, tests, vulnerability scan. Flags:
  `--fix` (auto-fix lint issues), `--short` (skip long-running integration
  tests). Run this before committing.
- **run-tests.sh**: Go test runner underlying `check.sh`. Runs unit + integration
  tests (`-tags=integration`) by default; `--unit` for unit-only, `--race` for
  the race detector, `--html` for a coverage report. See
  [docs/testing.md](../docs/testing.md).
- **lint.sh**: Combined lint for the Go backend and JS frontend.

## Docker / Podman Build

- **rebuild.sh**: Builds the container image (`build/Dockerfile`) and restarts
  it — this is the Docker/Podman path, served on :8000, distinct from
  `run.sh`'s native :8001 dev server.
- **entrypoint.sh**: Container entrypoint — creates data directories if missing
  before starting the app.

## Production Deployment

- **setup-production.sh**: One-shot server bootstrap (Docker/Podman install,
  `deploy` user, directory structure, Certbot, fail2ban, UFW, systemd unit, log
  rotation, backup cron). See
  [SETUP-PRODUCTION.md](SETUP-PRODUCTION.md) for the full guide.
- **deploy.sh**: Production deployment script — drives
  `build/docker-compose.prod.yml` with safety checks.

## Stress Testing

- **run-stress.sh**, **stress-http.sh**, **stress-measure.sh**: Boot the app
  against a dedicated stress-test database and measure query plans/timings for
  heavy endpoints.

## Misc

- **version.sh**: Prints the running container's build version.
