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
# remark42's server drops to uid 1001 inside the container; the volume must be
# writable for that uid or avatar writes (and thus anonymous login) 500.
# No :U on the mount — it would chown back to the container's root at start.
if [[ "$RUNTIME" == *podman ]]; then
    podman unshare chown -R 1001:1001 "$REMARK42_DATA"
else
    sudo chown -R 1001:1001 "$REMARK42_DATA"
fi
"$RUNTIME" rm -f remark42-local >/dev/null 2>&1 || true

# Email login for comments: reuses the engine's SMTP_* vars from .env
# (any SMTP relay — Mailgun, Brevo, self-hosted). Set AUTH_EMAIL_ENABLE=true
# in .env to turn it on for local dev.
EMAIL_ARGS=()
if [ "${AUTH_EMAIL_ENABLE:-false}" = "true" ] && [ -n "${SMTP_HOST:-}" ]; then
    EMAIL_ARGS=(
        -e AUTH_EMAIL_ENABLE=true
        -e SMTP_HOST="$SMTP_HOST"
        -e SMTP_PORT="${SMTP_PORT:-587}"
        -e SMTP_USERNAME="${SMTP_USERNAME:-}"
        -e SMTP_PASSWORD="${SMTP_PASSWORD:-}"
        -e AUTH_EMAIL_FROM="${SMTP_FROM:-${SMTP_USERNAME:-}}"
    )
    if [ "${SMTP_PORT:-587}" = "465" ]; then
        EMAIL_ARGS+=(-e SMTP_TLS=true)
    else
        EMAIL_ARGS+=(-e SMTP_STARTTLS=true)
    fi
fi

"$RUNTIME" run -d --name remark42-local --restart unless-stopped \
    -p 127.0.0.1:8081:8080 \
    -v "$REMARK42_DATA:/srv/var:z" \
    -e REMARK_URL="$REMARK_URL" \
    -e SECRET="$REMARK_SECRET" \
    -e SITE=remark \
    -e AUTH_ANON="${AUTH_ANON:-true}" \
    -e ADMIN_PASSWD="$ADMIN_PASSWD" \
    -e ADMIN_SHARED_ID="$(sqlite3 "$PROJECT_ROOT/data/point.db" "SELECT 'point_' || id FROM users;" 2>/dev/null | tr '\n' ',' | sed 's/,$//')" \
    -e AUTH_CUSTOM_NAME="point" \
    -e AUTH_CUSTOM_CID="point" \
    -e AUTH_CUSTOM_CSEC="point" \
    -e AUTH_CUSTOM_AUTH_URL="$REMARK_URL" \
    -e AUTH_CUSTOM_TOKEN_URL="$REMARK_URL" \
    -e AUTH_CUSTOM_INFO_URL="$REMARK_URL" \
    -e TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}" \
    -e NOTIFY_TELEGRAM_CHAN="${NOTIFY_TELEGRAM_CHAN:-}" \
    -e NOTIFY_ADMINS="${NOTIFY_ADMINS:-}" \
    "${EMAIL_ARGS[@]}" \
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
