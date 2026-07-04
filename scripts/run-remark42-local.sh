#!/bin/bash
# Run the remark42 comments engine locally for dev (scripts/run.sh on :8001).
# Mirrors what build/Dockerfile + entrypoint.sh do in the container: remark42
# on 127.0.0.1:8081, reached only through Point's gated /comments proxy.
#
# Reads REMARK_URL / REMARK_SECRET / ADMIN_PASSWD / AUTH_ANON from the repo
# .env (the same file scripts/run.sh loads, so Point sees ADMIN_PASSWD too).
# Idempotent: re-running replaces the container. Data persists in
# REMARK42_DATA (default: <repo>/data/remark42-local).
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

: "${REMARK_SECRET:?set REMARK_SECRET in .env (any long random string)}"
: "${ADMIN_PASSWD:?set ADMIN_PASSWD in .env (any long random string)}"
REMARK_URL=${REMARK_URL:-http://localhost:8001/comments}
REMARK42_DATA=${REMARK42_DATA:-$PROJECT_ROOT/data/remark42-local}
RUNTIME=$(command -v podman || command -v docker)

mkdir -p "$REMARK42_DATA"
"$RUNTIME" rm -f remark42-local >/dev/null 2>&1 || true
"$RUNTIME" run -d --name remark42-local --restart unless-stopped \
    -p 127.0.0.1:8081:8080 \
    -v "$REMARK42_DATA:/srv/var:z,U" \
    -e REMARK_URL="$REMARK_URL" \
    -e SECRET="$REMARK_SECRET" \
    -e SITE=remark \
    -e AUTH_ANON="${AUTH_ANON:-true}" \
    -e ADMIN_PASSWD="$ADMIN_PASSWD" \
    ghcr.io/umputun/remark42:latest

echo -n "waiting for remark42"
for _ in $(seq 1 30); do
    if curl -sf -o /dev/null http://127.0.0.1:8081/ping; then
        echo " — up on 127.0.0.1:8081 (URL: $REMARK_URL)"
        exit 0
    fi
    echo -n "."
    sleep 0.5
done
echo " — FAILED to start; check: $RUNTIME logs remark42-local" >&2
exit 1
