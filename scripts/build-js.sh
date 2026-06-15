#!/bin/bash
# Bundles and minifies JS modules into a single output file using esbuild.
# Run from the repository root or its directory.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$ROOT_DIR/frontend/js"

npx --yes esbuild "$ROOT_DIR/frontend/src/app.js" \
    --bundle \
    --minify \
    --format=esm \
    "--external:/assets/vendor/*" \
    --outfile="$ROOT_DIR/frontend/js/app.js"

echo "Built frontend/js/app.js ($(wc -c < "$ROOT_DIR/frontend/js/app.js") bytes)"
