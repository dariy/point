#!/bin/bash
# Builds the static UI demo into dist-demo/ — a self-contained copy of the Point
# frontend that runs with no backend at all.
#
# The demo bundles recorded fixtures (scripts/record-demo-fixtures.mjs) and a
# fetch/XHR shim (frontend/src/mock/) that answers every API call from memory,
# so the output is plain static files: no origin to attack, no database, no
# credentials, and nothing to reset — a reload restores the pristine state.
#
# This script reproduces at build time what the Go server normally does to
# index.html in memory (version stamping, HEAD_HTML substitution, and injecting
# the window.__PLUGINS__ manifest). Skipping any of those yields a page that
# loads but silently drops half the UI.
#
# Usage:
#   scripts/build-demo.sh [--skip-media]
#
# Prerequisites: fixtures recorded to frontend/src/mock/fixtures/fixtures.json.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

DIST="$ROOT_DIR/dist-demo"
FIXTURES="$ROOT_DIR/frontend/src/mock/fixtures/fixtures.json"
DEMO_VERSION="demo"

# Source of the original media files referenced by the fixtures. Overridable so
# the demo can be rebuilt from any instance's storage.
MEDIA_SRC="${MEDIA_SRC:-/mnt/lab_storage/point-data/media/originals}"

# Downscale target. Demo images only ever appear on a screen, and the bundle is
# shipped to a CDN, so full-resolution originals (330MB+) are pure cost.
MAX_WIDTH="${MAX_WIDTH:-1400}"
JPEG_QUALITY="${JPEG_QUALITY:-4}" # ffmpeg -q:v scale, 2 (best) … 31 (worst)

SKIP_MEDIA=0
[ "${1:-}" = "--skip-media" ] && SKIP_MEDIA=1

if [ ! -f "$FIXTURES" ]; then
  echo "Missing $FIXTURES" >&2
  echo "Record it first:  node scripts/record-demo-fixtures.mjs --session=<token>" >&2
  exit 1
fi

echo "==> Cleaning $DIST"
rm -rf "$DIST"
mkdir -p "$DIST/assets"

# ── JS ────────────────────────────────────────────────────────────────────
#
# Same esbuild pass as a normal build, with the mock entry swapped in. Only the
# release set is built: the debug set exists so an operator can switch a
# deployed server's bundle, which has no meaning here.

echo "==> Building JS (mock entry)"
# JS_DEBUG_DIR is redirected into the demo tree even though the debug set is
# skipped: build-js.sh removes that directory when skipping, and the default
# points at frontend/js-debug — the working tree's dev bundle.
APP_ENTRY="$ROOT_DIR/frontend/src/mock/entry.js" \
JS_RELEASE_DIR="$DIST/assets/js" \
JS_DEBUG_DIR="$DIST/.js-debug-unused" \
BUILD_DEBUG_FRONTEND=0 \
  "$SCRIPT_DIR/build-js.sh"

# ── CSS ───────────────────────────────────────────────────────────────────
#
# frontend/css is copied wholesale because it carries common/theme.css, which
# the server generates at runtime from the active theme and which themeLoader.js
# fetches as text before first paint. A build that omits it renders unstyled.

echo "==> Building CSS"
"$SCRIPT_DIR/build-css.sh" >/dev/null
cp -r "$ROOT_DIR/frontend/css" "$DIST/assets/css"

if [ ! -f "$DIST/assets/css/common/theme.css" ]; then
  echo "WARNING: assets/css/common/theme.css is missing — the server generates" >&2
  echo "         it at startup. Run the app once before building the demo." >&2
fi

# ── Static assets ─────────────────────────────────────────────────────────
#
# vendor/ is --external to esbuild (leaflet, prismjs, codejar) and must ship
# verbatim or the map and code-highlighting break at runtime.

echo "==> Copying static assets"
cp -r "$ROOT_DIR/frontend/vendor" "$DIST/assets/vendor"
cp -r "$ROOT_DIR/frontend/images" "$DIST/assets/images"
cp "$ROOT_DIR/frontend/manifest.webmanifest" "$DIST/manifest.webmanifest"

# ── index.html ────────────────────────────────────────────────────────────

echo "==> Templating index.html"
node "$SCRIPT_DIR/build-demo-html.mjs" \
  --src="$ROOT_DIR/frontend/index.html" \
  --out="$DIST/index.html" \
  --js-dir="$DIST/assets/js" \
  --css-dir="$DIST/assets/css" \
  --version="$DEMO_VERSION"

# ── Media ─────────────────────────────────────────────────────────────────
#
# Only the files the fixtures actually reference are copied; walking the source
# media tree would sweep in originals belonging to unpublished posts.

if [ "$SKIP_MEDIA" = "1" ]; then
  echo "==> Skipping media (--skip-media)"
else
  echo "==> Copying and downscaling media from $MEDIA_SRC"
  if [ ! -d "$MEDIA_SRC" ]; then
    echo "WARNING: $MEDIA_SRC not found — the demo will render without images." >&2
  else
    copied=0
    missing=0
    while IFS= read -r rel; do
      src="$MEDIA_SRC$rel"
      dst="$DIST${rel}"
      if [ ! -f "$src" ]; then
        missing=$((missing + 1))
        continue
      fi
      mkdir -p "$(dirname "$dst")"
      case "${rel,,}" in
        *.jpg | *.jpeg | *.png)
          # Scale down only — `min(w,iw)` never upscales a small original.
          if ! ffmpeg -nostdin -loglevel error -y -i "$src" \
              -vf "scale='min($MAX_WIDTH,iw)':-2" \
              -q:v "$JPEG_QUALITY" "$dst" 2>/dev/null; then
            cp "$src" "$dst"
          fi
          ;;
        *.mp4 | *.mov | *.m4v | *.webm)
          # Source videos are camera originals — one was 254MB, which alone is
          # larger than every other asset combined. Re-encode to 720p H.264 with
          # a web-friendly bitrate and move the moov atom to the front so the
          # player can start before the whole file arrives.
          if ! ffmpeg -nostdin -loglevel error -y -i "$src" \
              -vf "scale='min(1280,iw)':-2" \
              -c:v libx264 -preset medium -crf 28 \
              -c:a aac -b:a 96k \
              -movflags +faststart "$dst" 2>/dev/null; then
            echo "    ! could not transcode $rel — skipping" >&2
            rm -f "$dst"
            continue
          fi
          ;;
        *.dng | *.raw | *.arw | *.cr2 | *.nef | *.heic)
          # Raw files are megabytes of sensor data no browser can display; the
          # UI only ever shows their derived JPEG. Ship a JPEG at the same path
          # so any <img> pointing at it still resolves.
          if ! ffmpeg -nostdin -loglevel error -y -i "$src" \
              -vf "scale='min($MAX_WIDTH,iw)':-2" \
              -q:v "$JPEG_QUALITY" -f mjpeg "$dst" 2>/dev/null; then
            echo "    ! could not convert $rel — skipping" >&2
            rm -f "$dst"
            continue
          fi
          ;;
        *)
          cp "$src" "$dst"
          ;;
      esac
      copied=$((copied + 1))
    done < <(node -e '
      const fx = require("'"$FIXTURES"'");
      (fx.mediaFiles || []).forEach((p) => console.log(p));
    ')
    echo "    $copied file(s) copied, $missing missing"
  fi
fi

# ── Host configuration ────────────────────────────────────────────────────

echo "==> Writing host config"

# SPA fallback: every unknown path renders index.html so deep links and reloads
# work. Media paths are listed first so a missing image 404s honestly instead of
# returning HTML with a 200 (which would defeat dropBrokenImages()).
cat > "$DIST/_redirects" <<'EOF'
/assets/*  /assets/:splat  404
/*         /index.html     200
EOF

cat > "$DIST/_headers" <<'EOF'
# Content-hashed chunks can never change meaning at a fixed URL.
/assets/js/chunks/*
  Cache-Control: public, max-age=31536000, immutable

# Entry bundles and the shell are unhashed — they must revalidate so a redeploy
# is picked up rather than served stale from a year-long cache.
/assets/js/*.js
  Cache-Control: public, max-age=0, must-revalidate
/index.html
  Cache-Control: public, max-age=0, must-revalidate

/assets/css/*
  Cache-Control: public, max-age=3600
/assets/vendor/*
  Cache-Control: public, max-age=31536000, immutable

# Demo media never changes; it is baked into the deploy.
/20*
  Cache-Control: public, max-age=31536000, immutable

/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
EOF

cat > "$DIST/robots.txt" <<'EOF'
# Demonstration instance — sample content, not a real publication.
User-agent: *
Disallow: /light
Allow: /
EOF

# feed.xml and sitemap.xml are rendered by the Go server in production, so a
# static build has to emit them as files or the <link rel=alternate> in the
# shell points at a 404.
node "$SCRIPT_DIR/build-demo-feeds.mjs" \
  --fixtures="$FIXTURES" \
  --out="$DIST"

echo
echo "==> Done: $DIST"
du -sh "$DIST" 2>/dev/null || true
echo
echo "Serve locally with the backend STOPPED, then confirm zero /api/ requests:"
echo "  npx --yes serve -s $DIST -l 3000"
