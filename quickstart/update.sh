#!/usr/bin/env sh
set -e

# Change to the directory containing this script so compose finds its files
cd "$(dirname "$0")"

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

echo "Updating Point..."

$COMPOSE pull
$COMPOSE up -d

echo "Done! Point has been updated."
