#!/usr/bin/env sh
# Creates a Point API key from the CLI — useful before you have a browser
# session yet. Prints the raw key exactly once; save it securely. Run this
# from your Point install directory (next to docker-compose.yml), or copy it
# there first.
set -e

cd "$(dirname "$0")"

if [ $# -eq 0 ]; then
  echo "Usage: $0 \"My Key Name\""
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

$COMPOSE exec point ./point --create-api-key="$1"
