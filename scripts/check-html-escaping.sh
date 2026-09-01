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
#   2. Growth in the set of no-restricted-syntax suppressions. Each one is a
#      place where safety is asserted by a human rather than enforced by a rule
#      — a raw() around a value the reader cannot check, or the two lines of
#      utils/helpers.js that hold the only innerHTML and insertAdjacentHTML in
#      the frontend — so a new one is a deliberate act, not a quiet edit.
#
# A third shape needs a parser rather than a grep, so it lives in
# frontend/test/htmlInterpolation.test.js: markup in a plain template literal
# interpolated into html``, which the tag escapes into visible text.
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

# ── 2. The suppression budget ────────────────────────────────────────────────
# Every line here is a place a human asserted the value is already safe. Adding
# one means editing this list, which is the point. helpers.js is the odd one:
# its two are not raw() exceptions but the sinks themselves — the single
# innerHTML write (setHTML) and the single insertAdjacentHTML (insertHTML) that
# every other write in the frontend goes through.
expected=$(cat <<'LIST'
frontend/src/components/light/CssEditor.js 1
frontend/src/components/light/MarkdownEditor.js 1
frontend/src/components/light/settingsFields.js 1
frontend/src/components/light/tags/TagEditorForm.js 2
frontend/src/pages/light/PluginsPage.js 1
frontend/src/plugins/tags-map/index.js 2
frontend/src/utils/copyright.js 1
frontend/src/utils/helpers.js 2
LIST
)
actual=$(grep -rl 'eslint-disable-next-line no-restricted-syntax' "$SRC" 2>/dev/null | sort | while read -r f; do
    echo "$f $(grep -c 'eslint-disable-next-line no-restricted-syntax' "$f")"
done)
if [ "$actual" != "$expected" ]; then
    report "the suppression list moved" \
        "Each of these turns off a rule that would otherwise hold — the one" \
        "keeping raw() away from values the reader cannot check, or the one" \
        "keeping HTML sinks inside setHTML()/insertHTML(). If the change is" \
        "deliberate, update the list in scripts/check-html-escaping.sh and say" \
        "why in the commit." \
        "--- expected ---" "$expected" "--- actual ---" "${actual:-(none)}"
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "  html\`\` conventions hold."
