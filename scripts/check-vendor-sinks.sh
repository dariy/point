#!/bin/bash
# Trusted Types enforcement, asserted against the vendored code that has a
# waiver for it.
#
# The enforcing CSP (trustedTypesCSP in api/cmd/api/csp.go) names three
# policies and no more: "point" for everything this frontend writes, plus
# "point-leaflet" and "point-codejar" for two vendored libraries that were
# patched to route their own writes through a policy of their own. Everything
# that makes that arrangement true lives in files nobody edits by hand — a
# version bump drops a fresh upstream build over the patch and the CSP goes on
# claiming a guarantee the page no longer keeps.
#
# So this asserts the arrangement rather than trusting it:
#
#   1. The raw HTML sinks left in frontend/vendor/ are exactly the ones on the
#      budget below — a new one is a re-vendored file that lost its patch.
#   2. Both vendor policies are still registered where they are supposed to be.
#   3. The policy names the frontend registers are exactly the ones the CSP
#      allows, in both directions.
#   4. Nothing calls Prism.highlightElement, the one vendored writer that was
#      dealt with by not calling it rather than by patching it.
#
# Usage: scripts/check-vendor-sinks.sh

set -eo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

VENDOR=frontend/vendor
SRC=frontend/src
SERVER=api/cmd/api/csp.go
fail=0

report() {
    fail=1
    echo "  FAIL  $1"
    shift
    printf '        %s\n' "$@"
}

# ── 1. The sink budget ───────────────────────────────────────────────────────
# One line per vendored file containing an HTML sink, counted as "raw routed":
# raw is a write that reaches the browser as a plain string, routed is one
# handed to the file's own pointTT helper first. Under
# `require-trusted-types-for 'script'` a raw write throws.
#
#   leaflet.js       0 1  the single write inside pointTTHTML().
#   codejar.js       0 3  undo, redo, and the escaped-text paste.
#   prism-core.js    1 0  highlightElement's write, which nothing calls —
#                         see check 4. Patching it would have to be redone for
#                         every one of the seventeen prism files on each
#                         upgrade; not calling it costs nothing and cannot rot.
#   prism-markdown.js 1 0 inside `if (Prism.plugins.autoloader)`. The autoloader
#                         plugin is not vendored, so the branch is unreachable.
expected=$(cat <<'LIST'
frontend/vendor/codejar/codejar.js 0 3
frontend/vendor/leaflet/leaflet.js 0 1
frontend/vendor/prismjs/prism-core.js 1 0
frontend/vendor/prismjs/prism-markdown.js 1 0
LIST
)
# .innerHTML/.outerHTML on the left of an assignment, insertAdjacentHTML, and
# execCommand('insertHTML') — the sinks Chromium refuses a plain string at.
# A read (`const h = el.innerHTML`) is not a sink and does not match.
SINK='\.(inner|outer)HTML[[:space:]]*=[^=]|insertAdjacentHTML|execCommand\([^)]*insertHTML'
actual=$(grep -rlE "$SINK" "$VENDOR" --include='*.js' 2>/dev/null | sort | while read -r f; do
    # Enough trailing context to see whether the value came from pointTT. The
    # vendored files are partly minified, so this cannot be done line by line.
    windows=$(grep -oE "($SINK).{0,120}" "$f")
    routed=$(echo "$windows" | grep -c 'pointTT' || true)
    total=$(echo "$windows" | grep -c '' || true)
    echo "$f $((total - routed)) $routed"
done)
if [ "$actual" != "$expected" ]; then
    report "the vendored HTML sinks moved" \
        "A raw sink in frontend/vendor/ is refused by the browser under the" \
        "enforcing Trusted Types policy. If a library was re-vendored, re-apply" \
        "the patch described at the top of the file (route the write through" \
        "its pointTT helper); if the change is deliberate, update this list and" \
        "the trusted-types directive in $SERVER together." \
        "--- expected (file raw routed) ---" "$expected" "--- actual ---" "${actual:-(none)}"
fi

# ── 2. The vendor policies are still registered ──────────────────────────────
while read -r file name; do
    if ! grep -q "createPolicy(['\"]$name['\"]" "$file" 2>/dev/null; then
        report "$file no longer registers the \"$name\" policy" \
            "Its writes have nothing to go through, so the library breaks under" \
            "enforcement. Re-apply the Point patch at the top of the file."
    fi
done <<'LIST'
frontend/vendor/leaflet/leaflet.js point-leaflet
frontend/vendor/codejar/codejar.js point-codejar
LIST

# ── 3. The registered names and the CSP agree ────────────────────────────────
# A policy the CSP does not name cannot be created, and a name in the CSP that
# nothing creates is a waiver granted to nobody — worth the same complaint,
# because it is how the directive quietly stops describing the page.
csp_names=$(grep -oE '^const trustedTypesCSP = ".*"$' "$SERVER" |
    grep -oE 'trusted-types [^"]*' | cut -d' ' -f2- | tr ' ' '\n' | sort -u)
code_names=$(grep -rhoE "createPolicy\(['\"][^'\"]+" "$SRC" "$VENDOR" --include='*.js' 2>/dev/null |
    sed -E "s/.*['\"]//" | sort -u)
if [ "$csp_names" != "$code_names" ]; then
    report "the trusted-types allowlist and the registered policies disagree" \
        "Every name in the CSP should be one the frontend actually creates, and" \
        "every policy the frontend creates has to be named in the CSP or the" \
        "browser refuses to mint it." \
        "--- named in $SERVER ---" "$csp_names" "--- created in the frontend ---" "${code_names:-(none)}"
fi

# ── 4. Prism's own writer stays uncalled ─────────────────────────────────────
# highlightElement writes the highlighted markup itself. Point uses
# Prism.highlight(), the string-returning form, and hands the result to
# setHTML(); utils/prismManual.js switches off the automatic pass that would
# otherwise call highlightElement on load.
hits=$(grep -rn 'highlightElement\|highlightAll' "$SRC" 2>/dev/null | grep -v '^\S*:[0-9]*: *[*/]' || true)
if [ -n "$hits" ]; then
    report "Prism's own HTML writer is being called" \
        "highlightElement/highlightAll assign innerHTML inside prism-core.js," \
        "which the enforcing policy refuses. Use Prism.highlight() and write the" \
        "result with setHTML() instead." "$hits"
fi
if ! grep -q 'manual' "$SRC/utils/prismManual.js" 2>/dev/null; then
    report "utils/prismManual.js no longer sets Prism.manual" \
        "prism-core calls highlightAll() on itself at load without it."
fi

if [ "$fail" -ne 0 ]; then
    exit 1
fi
echo "  Vendored Trusted Types waivers hold."
