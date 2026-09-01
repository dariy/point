#!/bin/bash
# The html`` convention, asserted against the tree rather than trusted.
#
# eslint.config.js catches the shapes a parser can see: raw() around a call or a
# template literal, an interpolation in an unquoted attribute, a bare innerHTML.
# This covers the two things it cannot:
#
#   1. Hand-applied escapeHtml() inside an interpolation. The tag escapes by
#      default, so calling it by hand means either a plain template literal
#      (unescaped by definition) or a double-escape.
#   2. Growth in the set of raw() exceptions. Each one is a place where the
#      escaping is asserted by a human rather than performed by the tag, so a
#      new one is a deliberate act, not a quiet edit.
#
# Usage: scripts/check-html-escaping.sh

set -eo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

SRC=frontend/src
fail=0

report() {
    fail=1
    echo "  FAIL  $1"
    shift
    printf '        %s\n' "$@"
}

# ── 1. No hand-applied escaping inside an interpolation ──────────────────────
hits=$(grep -rn '\${escapeHtml(' "$SRC" || true)
if [ -n "$hits" ]; then
    report "hand-applied escapeHtml() in an interpolation" \
        "The html\`\` tag escapes every interpolation already. Drop the call:" \
        "an escaped value inside html\`\` is escaped twice, and inside a plain" \
        "template literal it is the convention this epic removed." "$hits"
fi

# escapeHtml is the wrong tool for a URL: it does not touch javascript: or
# data:. The tag applies safeUrl() in href/src position instead.
hits=$(grep -rnE '(href|src|formaction|xlink:href)="\$\{escapeHtml' "$SRC" || true)
if [ -n "$hits" ]; then
    report "escapeHtml() on a URL attribute" \
        "escapeHtml leaves javascript: and data: intact. Interpolate the raw" \
        "URL inside html\`\` so the tag applies safeUrl() instead." "$hits"
fi

# ── 2. The raw() exception budget ────────────────────────────────────────────
# Every line here is a place a human asserted the value is already safe. Adding
# one means editing this list, which is the point.
expected=$(cat <<'LIST'
frontend/src/components/light/CssEditor.js 1
frontend/src/components/light/MarkdownEditor.js 1
frontend/src/components/light/settingsFields.js 1
frontend/src/components/light/tags/TagEditorForm.js 2
frontend/src/pages/light/PluginsPage.js 1
frontend/src/plugins/tags-map/index.js 2
frontend/src/utils/copyright.js 1
LIST
)
actual=$(grep -rl 'eslint-disable-next-line no-restricted-syntax' "$SRC" 2>/dev/null | sort | while read -r f; do
    echo "$f $(grep -c 'eslint-disable-next-line no-restricted-syntax' "$f")"
done)
if [ "$actual" != "$expected" ]; then
    report "the raw() exception list moved" \
        "Each of these suppresses the rule that keeps raw() away from values the" \
        "reader cannot check. If the change is deliberate, update the list in" \
        "scripts/check-html-escaping.sh and say why in the commit." \
        "--- expected ---" "$expected" "--- actual ---" "${actual:-(none)}"
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "  html\`\` conventions hold."
