#!/bin/sh
# Bundles and minifies JS with esbuild.
#
# Produces TWO complete bundle sets so the backend can serve either without a
# rebuild (selected by the FRONTEND_DEBUG env — see api/cmd/api/main.go):
#
#   frontend/js/        release build — minified, __DEBUG__=false. Debug logging
#                       (utils/debug.js) collapses to no-ops and is stripped.
#   frontend/js-debug/  debug build   — unminified, __DEBUG__=true. Plugin
#                       mount/unmount, the manifest and chunk loads are logged
#                       to the console (see core/pluginHost.js).
#
# Each set is ONE esbuild pass with --splitting over the core entry (app.js)
# plus every plugin entry (frontend/src/plugins/<id>/index.js):
#
#   app.js              stable, unhashed core entry — referenced from
#                       index.html (?v=__BUILD_VERSION__) and sw.js SHELL_URLS.
#   p/<id>.js           plugin entries; gated per-plugin by the server
#                       (/assets/js/p/* only serves enabled plugins).
#   chunks/*-[hash].js  code-split chunks: lazily imported pages and code
#                       shared between the core and plugin entries.
#
# The single module graph means dynamic import() in app.js produces real lazy
# chunks (pages parse on first navigation, not up front) and shared modules
# (store, Component, api/client) exist exactly once — no duplication between
# app.js and plugin chunks, and no globalThis singleton anchors needed.
#
# Entry names are deliberately unhashed: the server sends
# `Cache-Control: no-cache` for everything under /assets/js (see main.go), so
# entries revalidate on every load; hashed chunk names keep cross-chunk import
# graphs consistent within a build.
#
# `__DEBUG__` is a compile-time constant: there is no runtime flag, so a
# visitor can never enable debug logging — the operator picks the build via
# the backend env.
#
# Set BUILD_DEBUG_FRONTEND=0 to skip the debug set (e.g. lean production images),
# or BUILD_RELEASE_FRONTEND=0 to skip the release set (e.g. a debug-only run).
#
# Run from the repository root or its directory.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_ENTRY="$ROOT_DIR/frontend/src/app.js"
PLUGIN_SRC="$ROOT_DIR/frontend/src/plugins"

# Use the lockfile-pinned esbuild from node_modules — NOT `npx --yes esbuild`,
# which ignores package.json and downloads whatever is latest on the registry
# at build time (non-reproducible bundles). Install it first if missing.
ESBUILD="$ROOT_DIR/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  echo "esbuild not installed — running npm ci..."
  (cd "$ROOT_DIR" && npm ci --no-audit --no-fund)
fi

# Pin the emitted syntax level so output doesn't silently float with the
# esbuild default (esnext) across toolchain upgrades.
ES_TARGET="es2022"

# Collect "p/<id>=<entry>" args for every frontend/src/plugins/<id>/index.js
# once; both bundle sets share the same plugin entries. The p/ alias prefix
# routes each plugin entry's output to <js_dir>/p/<id>.js.
# ponytail: space-separated string + word-splitting instead of a bash array so
# this runs under POSIX sh. Plugin ids/paths never contain spaces.
PLUGIN_ARGS=""
PLUGIN_COUNT=0
if [ -d "$PLUGIN_SRC" ]; then
  for dir in "$PLUGIN_SRC"/*/; do
    entry="${dir}index.js"
    [ -f "$entry" ] || continue
    id="$(basename "$dir")"
    PLUGIN_ARGS="$PLUGIN_ARGS p/${id}=${entry}"
    PLUGIN_COUNT=$((PLUGIN_COUNT + 1))
  done
fi

# build_set <out-js-dir> <__DEBUG__ value> <extra esbuild flags...>
# Extra esbuild flags are kept in the positional params ("$@") after the shift.
build_set() {
  js_dir="$1"; shift
  debug_val="$1"; shift
  # remaining "$@" = extra esbuild flags (e.g. --minify)

  manifest="$js_dir/plugin-manifest.json"
  meta="$js_dir/build-meta.json"

  # Clean rebuild: hashed chunk names would otherwise accumulate stale files.
  rm -rf "$js_dir"
  mkdir -p "$js_dir"

  # One esbuild pass with --splitting over the core entry (app.js) plus every
  # plugin entry. Pinned binary (see $ESBUILD above) for reproducible bundles.
  # shellcheck disable=SC2086  # PLUGIN_ARGS is an intentional word-split list
  "$ESBUILD" "app=$APP_ENTRY" $PLUGIN_ARGS \
      --bundle \
      --splitting \
      --format=esm \
      --target="$ES_TARGET" \
      "--define:__DEBUG__=${debug_val}" \
      "--external:/assets/vendor/*" \
      --chunk-names="chunks/chunk-[hash]" \
      --metafile="$meta" \
      "$@" \
      --outdir="$js_dir"

  if [ "$PLUGIN_COUNT" -gt 0 ]; then
    node "$SCRIPT_DIR/build-plugin-manifest.mjs" "$meta" "$manifest"
  else
    echo '{}' > "$manifest"
    echo "No plugin entries — wrote empty $manifest"
  fi
  echo "Built $js_dir: app.js ($(wc -c < "$js_dir/app.js") bytes, __DEBUG__=${debug_val}), ${PLUGIN_COUNT} plugin entrie(s), $(ls "$js_dir/chunks" 2>/dev/null | wc -l | tr -d ' ') shared/page chunk(s)"
}

# Release set — minified, debug logging stripped.
# Set BUILD_RELEASE_FRONTEND=0 to skip it (e.g. a debug-only local run).
if [ "${BUILD_RELEASE_FRONTEND:-1}" != "0" ]; then
  build_set "$ROOT_DIR/frontend/js" "false" --minify
else
  echo "BUILD_RELEASE_FRONTEND=0 — skipped release bundle (frontend/js)"
fi

# Debug set — unminified for readable stack traces, debug logging active.
if [ "${BUILD_DEBUG_FRONTEND:-1}" != "0" ]; then
  build_set "$ROOT_DIR/frontend/js-debug" "true"
else
  rm -rf "$ROOT_DIR/frontend/js-debug"
  echo "BUILD_DEBUG_FRONTEND=0 — skipped debug bundle (frontend/js-debug)"
fi
