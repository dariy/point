#!/bin/sh
# Go coverage floor — THE single source of truth for the number.
#
# History: this repo used to carry two contradictory coverage configs.
# .coverage-thresholds.json demanded 80% and claimed blockPRCreation /
# blockTaskCompletion powers, while codecov.yml set a 40% patch target — and
# neither gated anything, because nothing read the first file and codecov only
# posts a status. The 80% was aspirational, the 40% was based on a stale "~54%"
# estimate, and the real figure was 73.2%.
#
# So: one number, enforced here, called from both scripts/check.sh and CI.
# codecov.yml carries the same value for its status checks and points back at
# this file — keep the two in sync when changing it.
#
# Ratchet only. Raise FLOOR as coverage improves; never lower it to make a red
# build green.
#
# Usage: scripts/coverage-gate.sh <coverage-profile>

set -eu

FLOOR=70

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

profile="${1:-}"
if [ -z "$profile" ]; then
  echo "usage: $0 <coverage-profile>" >&2
  exit 2
fi
if [ ! -s "$profile" ]; then
  echo "coverage gate: profile '$profile' is missing or empty" >&2
  exit 2
fi
# Resolve before the cd below, so a relative profile path still works.
case "$profile" in
  /*) ;;
  *) profile="$(pwd)/$profile" ;;
esac

# Packages excluded from the measurement. MUST mirror the `ignore:` list in
# codecov.yml, or the local number and the codecov number drift apart and the
# repo is back to having two coverage figures. cmd/seed is a standalone
# stress-test data generator with its own main(); counting its 0% drags the
# total down 1.5pp against what codecov reports.
IGNORE_RE='^point-api/cmd/seed/'

# `go tool cover` resolves package paths against the module, so it has to run
# inside api/ regardless of where the caller invoked this script from.
cd "$ROOT_DIR/api"

filtered=$(mktemp)
# shellcheck disable=SC2064  # expand $filtered now, not at trap time
trap "rm -f '$filtered'" EXIT
head -n 1 "$profile" > "$filtered"                     # the "mode:" line
tail -n +2 "$profile" | grep -Ev "$IGNORE_RE" >> "$filtered" || true

# `go tool cover -func` ends with:  total:  (statements)  74.7%
total=$(go tool cover -func="$filtered" | awk '/^total:/ { gsub(/%/, "", $NF); print $NF }')

if [ -z "$total" ]; then
  echo "coverage gate: could not parse a total out of '$profile'" >&2
  exit 2
fi

# POSIX sh has no float comparison; awk exits 0 when the floor is met.
if awk -v t="$total" -v f="$FLOOR" 'BEGIN { exit !(t + 0 >= f + 0) }'; then
  echo "coverage gate: ${total}% (floor ${FLOOR}%)"
  exit 0
fi

echo "coverage gate: FAIL — ${total}% is below the ${FLOOR}% floor" >&2
echo "Raise coverage, or justify moving the floor in scripts/coverage-gate.sh." >&2
exit 1
