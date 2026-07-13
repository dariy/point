#!/bin/sh
set -e
# Bundles CSS modules into minified bundle files.
#
# Ordering is significant (design tokens → reset → section tokens →
# components → responsive), so the partials are still listed explicitly per
# bundle rather than globbed. The concatenated CSS is piped through esbuild for
# minification — parity with the JS pipeline, and a ~40% payload cut versus the
# old unminified `cat`. A listed-but-missing partial fails the build loudly.
#
# Run from the repository root or its directory.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CSS_DIR="$ROOT_DIR/frontend/css"

# Prefer the lockfile-pinned esbuild; fall back to npx for a fresh checkout.
ESBUILD="$ROOT_DIR/node_modules/.bin/esbuild"
if [ ! -x "$ESBUILD" ]; then
  ESBUILD="npx --yes esbuild"
fi

# bundle <outfile> <partial>...  — concatenate partials in order, minify to out.
bundle() {
  out="$1"
  shift
  # shellcheck disable=SC2086  # $ESBUILD may be "npx --yes esbuild" (intended split)
  cat "$@" | $ESBUILD --loader=css --minify > "$out"
  echo "Built $(basename "$out") ($(wc -c < "$out") bytes, minified)"
}

echo "Building CSS bundles in $CSS_DIR..."

# Admin bundle
bundle "$CSS_DIR"/light.css \
    "$CSS_DIR"/common/tokens.css \
    "$CSS_DIR"/common/theme-tokens.css \
    "$CSS_DIR"/common/reset.css \
    "$CSS_DIR"/light/tokens.css \
    "$CSS_DIR"/common/buttons.css \
    "$CSS_DIR"/common/forms.css \
    "$CSS_DIR"/common/badges.css \
    "$CSS_DIR"/common/modals.css \
    "$CSS_DIR"/common/empty-state.css \
    "$CSS_DIR"/common/pagination.css \
    "$CSS_DIR"/common/theme-toggle.css \
    "$CSS_DIR"/common/utilities.css \
    "$CSS_DIR"/common/login-overlay.css \
    "$CSS_DIR"/common/prism.css \
    "$CSS_DIR"/light/layout.css \
    "$CSS_DIR"/light/login.css \
    "$CSS_DIR"/light/cards.css \
    "$CSS_DIR"/light/dashboard.css \
    "$CSS_DIR"/light/tables.css \
    "$CSS_DIR"/light/media.css \
    "$CSS_DIR"/light/tags.css \
    "$CSS_DIR"/light/tree-view.css \
    "$CSS_DIR"/light/editor.css \
    "$CSS_DIR"/light/filters.css \
    "$CSS_DIR"/light/system.css \
    "$CSS_DIR"/light/settings.css \
    "$CSS_DIR"/light/menu.css \
    "$CSS_DIR"/light/themes.css \
    "$CSS_DIR"/light/plugins.css \
    "$CSS_DIR"/light/exif.css \
    "$CSS_DIR"/light/responsive.css

# Public bundle
bundle "$CSS_DIR"/main.css \
    "$CSS_DIR"/common/tokens.css \
    "$CSS_DIR"/common/theme-tokens.css \
    "$CSS_DIR"/common/reset.css \
    "$CSS_DIR"/public/tokens.css \
    "$CSS_DIR"/common/buttons.css \
    "$CSS_DIR"/common/empty-state.css \
    "$CSS_DIR"/common/pagination.css \
    "$CSS_DIR"/common/theme-toggle.css \
    "$CSS_DIR"/common/utilities.css \
    "$CSS_DIR"/common/login-overlay.css \
    "$CSS_DIR"/common/prism.css \
    "$CSS_DIR"/public/layout.css \
    "$CSS_DIR"/public/header.css \
    "$CSS_DIR"/public/header-tags.css \
    "$CSS_DIR"/public/footer.css \
    "$CSS_DIR"/public/tag-strip.css \
    "$CSS_DIR"/public/post-grid.css \
    "$CSS_DIR"/public/sidebar.css \
    "$CSS_DIR"/public/single-post.css \
    "$CSS_DIR"/public/tag-archive.css \
    "$CSS_DIR"/public/error-page.css \
    "$CSS_DIR"/public/map.css \
    "$CSS_DIR"/public/atlas.css \
    "$CSS_DIR"/public/timeline.css \
    "$CSS_DIR"/public/drop-zone.css \
    "$CSS_DIR"/public/responsive.css \
    "$CSS_DIR"/public/exif.css

# Viewer bundle — media viewers shared by the public and admin sections
# (immersive post viewer, sheet viewer, carousel, lightbox). Loaded via its own
# always-active <link> in index.html so the rules aren't duplicated into both
# section bundles.
bundle "$CSS_DIR"/viewer.css \
    "$CSS_DIR"/public/immersive.css \
    "$CSS_DIR"/public/immersive-sheet.css \
    "$CSS_DIR"/public/carousel.css \
    "$CSS_DIR"/common/lightbox.css

# ── Per-plugin CSS chunks ───────────────────────────────────────────────────
# Mirror the JS plugin pipeline: a plugin that owns CSS keeps its partials under
# frontend/src/plugins/<id>/*.css; bundle them into frontend/css/p/<id>.css to
# be loaded alongside the plugin chunk. No-op until plugins ship CSS — keeps the
# "edit source CSS, never generated" rule intact (sources live under src/plugins,
# output under css/p).
PLUGIN_SRC="$ROOT_DIR/frontend/src/plugins"
PLUGIN_CSS_OUT="$CSS_DIR/p"
if [ -d "$PLUGIN_SRC" ]; then
  for dir in "$PLUGIN_SRC"/*/; do
    id="$(basename "$dir")"
    # shellcheck disable=SC2086
    set -- "$dir"*.css
    [ -e "$1" ] || continue
    mkdir -p "$PLUGIN_CSS_OUT"
    bundle "$PLUGIN_CSS_OUT/$id.css" "$@"
  done
fi
