#!/bin/bash
# Manual end-to-end test for the `version-check` plugin.
#
# The plugin compares the running build against the newest upstream git tag, so
# on a dev build there is nothing to compare (a "dev-…" version is not semver)
# and the update paths never render. This runs the normal dev server but reports
# an OLD release version, making upstream always look newer.
#
#   scripts/run-old-version-check.sh                 # pretend to be v0.1.35
#   scripts/run-old-version-check.sh v0.1.20         # …or any version
#   scripts/run-old-version-check.sh --reset-cache   # also forget the last check
#
# Any other flags are passed through to run.sh (e.g. -d for the debug frontend).
#
# What to look for on http://localhost:8001:
#   1. /light            — blue banner: "Point <newer> is available. Update with:
#                          ./update.sh", dismissible (per version, via localStorage).
#   2. /light/plugins    — Version Check → Settings: running version, latest
#                          upstream, last checked, and an "update available" verdict.
#   3. Check now         — re-checks immediately, ignoring the 24h cache: the
#                          timestamp moves and it confirms the answer came from
#                          GitHub. A failure is reported verbatim instead of
#                          silently looking like "you're up to date".
#   4. Toggle the plugin off — /api/system/version 404s and the banner is gone.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

OLD_VERSION="v0.1.35"
RESET_CACHE=0
PASSTHROUGH=()

for arg in "$@"; do
    case "$arg" in
        --reset-cache) RESET_CACHE=1 ;;
        # A bare version argument (v0.1.20 / 0.1.20); anything else is run.sh's.
        v[0-9]*|[0-9]*.[0-9]*) OLD_VERSION="$arg" ;;
        *) PASSTHROUGH+=("$arg") ;;
    esac
done

# Clearing the cached upstream answer exercises the cold path: the first request
# has to reach GitHub, and until it does the drawer reads "never checked".
if [ "$RESET_CACHE" = "1" ]; then
    DB="${DATABASE_URL:-}"
    if [ -z "$DB" ] && [ -f "$PROJECT_ROOT/.env" ]; then
        DB=$(grep -E '^DATABASE_URL=' "$PROJECT_ROOT/.env" | tail -1 | cut -d= -f2-)
    fi
    DB="${DB:-$PROJECT_ROOT/data/point.db}"
    if command -v sqlite3 >/dev/null && [ -f "$DB" ]; then
        sqlite3 "$DB" "DELETE FROM blog_settings WHERE key = '_version_check_cached';"
        echo "==> Cleared the cached upstream version in $DB"
    else
        echo "==> Skipping --reset-cache: need sqlite3 and an existing $DB" >&2
    fi
fi

echo "==> Running as $OLD_VERSION so upstream looks newer (see the header of this script)"

# run.sh stamps its own dev version, but honours APP_VERSION when it is already set.
export APP_VERSION="$OLD_VERSION"
exec "$SCRIPT_DIR/run.sh" "${PASSTHROUGH[@]}"
