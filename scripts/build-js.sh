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
# Each set contains its own core bundle (app.js), plugin chunks (p/<id>-<hash>.js)
# and plugin-manifest.json. `__DEBUG__` is a compile-time constant: there is no
# runtime flag, so a visitor can never enable debug logging — the operator picks
# the build via the backend env.
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

# Collect "<id>=<entry>" args for every frontend/src/plugins/<id>/index.js once;
# both bundle sets share the same plugin entries.
# ponytail: space-separated string + word-splitting instead of a bash array so
# this runs under POSIX sh. Plugin ids/paths never contain spaces.
PLUGIN_ARGS=""
PLUGIN_COUNT=0
if [ -d "$PLUGIN_SRC" ]; then
  for dir in "$PLUGIN_SRC"/*/; do
    entry="${dir}index.js"
    [ -f "$entry" ] || continue
    id="$(basename "$dir")"
    PLUGIN_ARGS="$PLUGIN_ARGS ${id}=${entry}"
    PLUGIN_COUNT=$((PLUGIN_COUNT + 1))
  done
fi

# build_set <out-js-dir> <__DEBUG__ value> <extra esbuild flags...>
# Extra esbuild flags are kept in the positional params ("$@") after the shift.
build_set() {
  js_dir="$1"; shift
  debug_val="$1"; shift
  # remaining "$@" = extra esbuild flags (e.g. --minify)

  plugin_out="$js_dir/p"
  manifest="$js_dir/plugin-manifest.json"
  meta="$js_dir/plugin-meta.json"

  mkdir -p "$js_dir"

  # ── Core bundle (single file, unchanged contract) ─────────────────────────
  "$ESBUILD" "$APP_ENTRY" \
      --bundle \
      --format=esm \
      --target="$ES_TARGET" \
      "--define:__DEBUG__=${debug_val}" \
      "--external:/assets/vendor/*" \
      "$@" \
      --outfile="$js_dir/app.js"
  echo "Built $js_dir/app.js ($(wc -c < "$js_dir/app.js") bytes, __DEBUG__=${debug_val})"

  # ── Plugin chunks + manifest ──────────────────────────────────────────────
  if [ "$PLUGIN_COUNT" -gt 0 ]; then
    rm -rf "$plugin_out"
    mkdir -p "$plugin_out"
    # shellcheck disable=SC2086  # PLUGIN_ARGS is an intentional word-split list
    "$ESBUILD" $PLUGIN_ARGS \
        --bundle \
        --splitting \
        --format=esm \
        --target="$ES_TARGET" \
        "--define:__DEBUG__=${debug_val}" \
        "--external:/assets/vendor/*" \
        --entry-names="[name]-[hash]" \
        --chunk-names="chunk-[hash]" \
        --metafile="$meta" \
        "$@" \
        --outdir="$plugin_out"
    node "$SCRIPT_DIR/build-plugin-manifest.mjs" "$meta" "$manifest"
    # The metafile is only an intermediate for the manifest builder. It lands
    # in the served js dir and enumerates every source path (including
    # disabled plugins'), so drop it rather than expose it via /assets/js.
    rm -f "$meta"
    echo "Built ${PLUGIN_COUNT} plugin chunk(s) → $plugin_out (see $manifest)"
  else
    echo '{}' > "$manifest"
    echo "No plugin entries — wrote empty $manifest"
  fi
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
