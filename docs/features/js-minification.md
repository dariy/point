# JS Minification & Bundling

## Overview

In production, all frontend JavaScript is bundled and minified into a single file using [esbuild](https://esbuild.github.io/). This reduces network requests (50+ module files → 1) and payload size.

In development, JS is served as source files with no build step — changes are live immediately.

---

## How It Works

### Build script

```bash
./scripts/build-js.sh
```

Uses `npx esbuild` (Node.js required, no install step) to bundle `frontend/src/app.js` and all its ES module imports into a minified `frontend/js/app.js`.

### Server-side detection

The Go API server (`api/cmd/api/main.go`) checks for `frontend/js/` at startup:

- **If `frontend/js/` exists** → serves `/assets/js` from there (production bundle)
- **If not** → serves `/assets/js` from `frontend/src/` (development source files)

No configuration change is needed to switch between modes.

### Docker build

The `build/Dockerfile` builder stage installs Node.js and runs esbuild before the runtime image is assembled. The built `frontend/js/` directory is copied into the runtime image alongside the rest of the frontend.

---

## File Locations

| Path | Purpose |
|------|---------|
| `scripts/build-js.sh` | Local build script |
| `frontend/src/app.js` | Entry point (ES module, imports all other modules) |
| `frontend/js/app.js` | Built output — gitignored, generated at build time |

---

## Dev vs. Production

| | Development | Production (Docker) |
|-|-------------|---------------------|
| JS source | `frontend/src/` | `frontend/js/` |
| Build step | None | esbuild (in Dockerfile) |
| Module requests | Many (native ESM) | One (bundled) |
| Minified | No | Yes |

---

## Running the Build Locally

```bash
# From project root
./scripts/build-js.sh

# To revert to source-file serving, remove the output directory
rm -rf frontend/js/
```

The server picks up the change on next restart.
