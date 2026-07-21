#!/usr/bin/env sh
# Resets a Point user's password directly in the database — no SMTP, no
# manual SQL. Run this from your Point install directory (next to
# docker-compose.yml), or copy it there first.
set -e

cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  echo "Usage: $0 --user=\"youruser\" --password=\"newpassword\""
  echo "  --user      username to reset (optional; defaults to the first/only user)"
  echo "  --password  the new plaintext password"
  exit 1
fi

# Detect compose engine: prefer rootless over sudo
if command -v docker >/dev/null 2>&1 && docker ps >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v podman >/dev/null 2>&1 && podman ps >/dev/null 2>&1; then
    COMPOSE="podman compose"
elif command -v docker >/dev/null 2>&1 && sudo -n docker ps >/dev/null 2>&1 && sudo -n docker compose version >/dev/null 2>&1; then
    COMPOSE="sudo docker compose"
elif command -v podman >/dev/null 2>&1 && sudo -n podman ps >/dev/null 2>&1; then
    COMPOSE="sudo podman compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    COMPOSE="docker compose"
elif command -v podman >/dev/null 2>&1; then
    COMPOSE="podman compose"
else
    echo "Error: neither docker nor podman found. Please install Docker first." >&2
    exit 1
fi

$COMPOSE exec point ./point reset-password "$@"
