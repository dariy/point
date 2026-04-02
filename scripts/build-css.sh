#!/bin/bash
# Concatenates CSS modules into bundle files
# This script should be run from the repository root or its directory.
# But we'll make it robust by finding the repository root.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CSS_DIR="$ROOT_DIR/frontend/css"

echo "Building CSS bundles in $CSS_DIR..."

# Admin bundle
cat "$CSS_DIR"/common/tokens.css \
    "$CSS_DIR"/common/reset.css \
    "$CSS_DIR"/light/tokens.css \
    "$CSS_DIR"/common/buttons.css \
    "$CSS_DIR"/common/forms.css \
    "$CSS_DIR"/common/badges.css \
    "$CSS_DIR"/common/modals.css \
    "$CSS_DIR"/common/flash-messages.css \
    "$CSS_DIR"/common/empty-state.css \
    "$CSS_DIR"/common/pagination.css \
    "$CSS_DIR"/common/category-chips.css \
    "$CSS_DIR"/common/theme-toggle.css \
    "$CSS_DIR"/common/utilities.css \
    "$CSS_DIR"/common/login-overlay.css \
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
    "$CSS_DIR"/light/responsive.css \
    "$CSS_DIR"/common/lightbox.css \
    > "$CSS_DIR"/light.css

echo "Built light.css ($(wc -c < "$CSS_DIR"/light.css) bytes)"

# Public bundle
cat "$CSS_DIR"/common/tokens.css \
    "$CSS_DIR"/common/reset.css \
    "$CSS_DIR"/public/tokens.css \
    "$CSS_DIR"/common/buttons.css \
    "$CSS_DIR"/common/empty-state.css \
    "$CSS_DIR"/common/pagination.css \
    "$CSS_DIR"/common/category-chips.css \
    "$CSS_DIR"/common/theme-toggle.css \
    "$CSS_DIR"/common/utilities.css \
    "$CSS_DIR"/common/login-overlay.css \
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
    "$CSS_DIR"/public/immersive.css \
    "$CSS_DIR"/public/carousel.css \
    "$CSS_DIR"/common/lightbox.css \
    "$CSS_DIR"/public/map.css \
    "$CSS_DIR"/public/drop-zone.css \
    "$CSS_DIR"/public/responsive.css \
    "$CSS_DIR"/public/exif.css \
    > "$CSS_DIR"/main.css

echo "Built main.css ($(wc -c < "$CSS_DIR"/main.css) bytes)"
