#!/usr/bin/env bash
# Ratchet gate for the move to "strict": true (epic p-3cfv). tsc cannot set
# strict per directory, so this runs tsc --strict and counts the errors per
# directory. A count above frontend/strict-baseline.txt fails. A count below
# it passes, with a hint to lower the baseline. The last child of the epic
# turns strict on and deletes this script and the baseline.
#
#   scripts/ts-strict-ratchet.sh            compare with the baseline
#   scripts/ts-strict-ratchet.sh --update   write the current counts
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT_DIR/frontend/strict-baseline.txt"
cd "$ROOT_DIR"

# One line per directory: "<count> <dir>". The directory is frontend/src/<x>,
# or frontend/src/<x>/<y> for components, pages and plugins.
current=$(node_modules/.bin/tsc -p tsconfig.json --pretty false --strict 2>&1 |
    grep -oE '^[^(: ]+\([0-9]+,[0-9]+\): error' |
    sed -E 's/\(.*//' |
    awk -F/ '{
        if ($2 == "src" && ($3 == "components" || $3 == "pages" || $3 == "plugins") && NF > 4)
            d = $1 "/" $2 "/" $3 "/" $4
        else if ($2 == "src" && NF > 3) d = $1 "/" $2 "/" $3
        else { d = $1; for (i = 2; i < NF; i++) d = d "/" $i }
        n[d]++
    } END { for (d in n) print n[d], d }' | sort -k2)

if [ "${1:-}" = "--update" ]; then
    { echo "# tsc --strict errors per directory. Written by scripts/ts-strict-ratchet.sh --update."
      echo "$current"; } >"$BASELINE"
    echo "  wrote $BASELINE ($(echo "$current" | awk '{s+=$1} END {print s+0}') errors)"
    exit 0
fi

[ -f "$BASELINE" ] || { echo "  FAIL  $BASELINE is missing (run $0 --update)" >&2; exit 1; }

# Join the two lists on the directory; a missing side counts as 0.
report=$(awk '
    FNR == NR { if ($0 !~ /^#/ && NF == 2) base[$2] = $1; next }
    NF == 2 { cur[$2] = $1 }
    END {
        for (d in base) if (!(d in cur)) cur[d] = 0
        for (d in cur) {
            b = (d in base) ? base[d] : 0
            if (cur[d] > b) print "UP", d, b, cur[d]
            else if (cur[d] < b) print "DOWN", d, b, cur[d]
        }
    }' "$BASELINE" - <<<"$current" | sort -k2)

if grep -q '^UP' <<<"$report"; then
    echo "  FAIL  tsc --strict errors went up (fix them; do not raise the baseline):" >&2
    grep '^UP' <<<"$report" | awk '{printf "        %s: %d -> %d\n", $2, $3, $4}' >&2
    exit 1
fi
if grep -q '^DOWN' <<<"$report"; then
    echo "  tsc --strict errors went down. Lower the baseline: scripts/ts-strict-ratchet.sh --update"
    grep '^DOWN' <<<"$report" | awk '{printf "        %s: %d -> %d\n", $2, $3, $4}'
fi
exit 0
