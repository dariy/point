#!/bin/bash
# Bundles and minifies JS with esbuild.
#
# Two outputs:
#   1. Core bundle  → frontend/js/app.js (single file, loaded by index.html).
#   2. Plugin chunks → frontend/js/p/<id>-<hash>.js, one per plugin entry at
#      frontend/src/plugins/<id>/index.js, code-split so plugins share common
#      chunks. The id→chunk map is written to frontend/js/plugin-manifest.json,
#      which the Go server reads to resolve each enabled plugin to its chunk URL
#      and to authorize the gated /assets/js/p/* handler.
#
# Until plugins are extracted (Phase 4) there are no plugin entries, so the
# manifest is "{}" and every manifest Entry stays empty — no behavior change.
#
# Run from the repository root or its directory.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
JS_DIR="$ROOT_DIR/frontend/js"
PLUGIN_SRC="$ROOT_DIR/frontend/src/plugins"
PLUGIN_OUT="$JS_DIR/p"
MANIFEST="$JS_DIR/plugin-manifest.json"

mkdir -p "$JS_DIR"

# ── 1. Core bundle (single file, unchanged contract) ────────────────────────
npx --yes esbuild "$ROOT_DIR/frontend/src/app.js" \
    --bundle \
    --minify \
    --format=esm \
    "--external:/assets/vendor/*" \
    --outfile="$JS_DIR/app.js"

echo "Built frontend/js/app.js ($(wc -c < "$JS_DIR/app.js") bytes)"

# ── 2. Plugin chunks + manifest ─────────────────────────────────────────────
# Collect "<id>=<entry>" args for every frontend/src/plugins/<id>/index.js.
PLUGIN_ARGS=()
if [ -d "$PLUGIN_SRC" ]; then
  for dir in "$PLUGIN_SRC"/*/; do
    entry="${dir}index.js"
    [ -f "$entry" ] || continue
    id="$(basename "$dir")"
    PLUGIN_ARGS+=("${id}=${entry}")
  done
fi

if [ ${#PLUGIN_ARGS[@]} -gt 0 ]; then
  rm -rf "$PLUGIN_OUT"
  mkdir -p "$PLUGIN_OUT"
  npx --yes esbuild "${PLUGIN_ARGS[@]}" \
      --bundle \
      --minify \
      --splitting \
      --format=esm \
      "--external:/assets/vendor/*" \
      --entry-names="[name]-[hash]" \
      --chunk-names="chunk-[hash]" \
      --metafile="$JS_DIR/plugin-meta.json" \
      --outdir="$PLUGIN_OUT"
  node "$SCRIPT_DIR/build-plugin-manifest.mjs" "$JS_DIR/plugin-meta.json" "$MANIFEST"
  echo "Built ${#PLUGIN_ARGS[@]} plugin chunk(s) → frontend/js/p/ (see plugin-manifest.json)"
else
  echo '{}' > "$MANIFEST"
  echo "No plugin entries — wrote empty frontend/js/plugin-manifest.json"
fi
