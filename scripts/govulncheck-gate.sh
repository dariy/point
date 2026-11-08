#!/bin/bash
# govulncheck with a reviewed exception list.
# Usage: scripts/govulncheck-gate.sh [ignore-file]   (run from the Go module dir)
#
# Runs `govulncheck ./...`. When it passes, this passes. When it fails, the
# script reads the same scan as JSON and takes each finding that reaches a
# symbol (the findings that make govulncheck fail). The step passes only when
# each of those IDs has an entry in the ignore file whose date is not in the
# past. Default ignore file: govulncheck-ignore.txt in the current directory.
#
# Ignore file: one entry per line, `<OSV id> <until YYYY-MM-DD> <reason>`;
# `#` starts a comment. An entry that has expired does not apply, so each
# exception gets a review on its date. Entries that match no finding print a
# note: remove them.

set -eo pipefail

IGNORE_FILE="${1:-govulncheck-ignore.txt}"
TODAY="${GOVULNCHECK_TODAY:-$(date -u +%F)}"

if govulncheck ./...; then
    exit 0
fi

command -v jq >/dev/null || { echo "govulncheck-gate: jq is needed to apply $IGNORE_FILE" >&2; exit 1; }

# Symbol-level findings only: the first trace frame names a function.
mapfile -t found < <(govulncheck -format json ./... |
    jq -r 'select(.finding) | .finding | select(.trace[0].function) | .osv' | sort -u)
if [ ${#found[@]} -eq 0 ]; then
    echo "govulncheck-gate: govulncheck failed with no symbol-level finding (see output above)" >&2
    exit 1
fi

declare -A until=()
if [ -f "$IGNORE_FILE" ]; then
    while read -r id date _; do
        case "$id" in ''|'#'*) continue ;; esac
        if ! [[ "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
            echo "govulncheck-gate: $IGNORE_FILE: bad date for $id: '$date'" >&2
            exit 1
        fi
        until[$id]=$date
    done < "$IGNORE_FILE"
fi

echo
fail=0
for id in "${found[@]}"; do
    d="${until[$id]:-}"
    if [ -z "$d" ]; then
        echo "FAIL  $id: not in $IGNORE_FILE"
        fail=1
    elif [[ "$d" < "$TODAY" ]]; then
        echo "FAIL  $id: exception expired on $d — review it in $IGNORE_FILE"
        fail=1
    else
        echo "IGNORE $id: reviewed exception until $d ($IGNORE_FILE)"
    fi
done
for id in "${!until[@]}"; do
    [[ " ${found[*]} " == *" $id "* ]] || echo "NOTE  $id: in $IGNORE_FILE but not found — remove the entry"
done
exit $fail
