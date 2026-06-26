#!/bin/bash
# Local development script to run the project without Docker.
# Rebuilds all artifacts and runs on port 8001.
set -eo pipefail

# Get the absolute path to the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST=$LOCAL_RUN
cd "$PROJECT_ROOT"

# Debug switch: -d/--debug (or DEBUG=1) builds and serves only the debug
# frontend; otherwise build and serve only the release frontend. Either way we
# build a single set instead of both.
DEBUG=${DEBUG:-0}
case "${1:-}" in
    -d|--debug) DEBUG=1 ;;
esac

# Cleanup function to be called on EXIT
cleanup() {
    trap - EXIT INT TERM
    echo ""
    echo "==> Shutting down and cleaning up..."
    if [ -f frontend/index.html.bak ]; then
        mv frontend/index.html.bak frontend/index.html 2>/dev/null || true
    fi
    # Only remove data.yml if we copied it to the root during this run
    if [ "${COPIED_DATA_YML:-false}" = "true" ]; then
        rm data.yml 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# Load .env if it exists
if [ -f .env ]; then
    echo "==> Loading .env..."
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

echo "==> Building CSS..."
./scripts/build-css.sh

if [ "$DEBUG" = "1" ]; then
    echo "==> Building JS (debug only)..."
    BUILD_RELEASE_FRONTEND=0 ./scripts/build-js.sh
else
    echo "==> Building JS (release only)..."
    BUILD_DEBUG_FRONTEND=0 ./scripts/build-js.sh
fi

# Generate a temporary version string for this run
DEV_VERSION="dev-$(date +%Y%m%d-%H%M%S)"

echo "==> Building Go backend with version $DEV_VERSION..."
(cd api && go build -ldflags="-s -w -X main.Version=$DEV_VERSION" -o ../point ./cmd/api)

PORT=8001

echo "==> Ensuring port $PORT is free..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

# Ensure data directories exist locally
mkdir -p data/media/originals data/media/thumbnails data/logs data/backups data/themes

# Temporarily stamp version in index.html for cache-busting
if [ -f frontend/index.html ]; then
    sed -i.bak "s/__BUILD_VERSION__/$DEV_VERSION/g" frontend/index.html
fi

# Copy data.yml to root if it exists in api but not in root
# The application looks for it in the current directory or STORAGE_PATH
COPIED_DATA_YML=false
if [ -f api/data.yml ] && [ ! -f data.yml ]; then
    cp api/data.yml .
    COPIED_DATA_YML=true
fi

# Adjust paths if they look like container paths from .env
if [[ "${DATABASE_URL:-}" == /data/* ]]; then
    DATABASE_URL="data/${DATABASE_URL#/data/}"
fi
if [[ "${STORAGE_PATH:-}" == /data ]]; then
    STORAGE_PATH="data"
fi

# Set default environment variables for local run if not already set
export DATABASE_URL=${DATABASE_URL:-data/point.db}
export STORAGE_PATH=${STORAGE_PATH:-data}
export FRONTEND_DIR=frontend
export PORT=$PORT
export HOST=${HOST:-127.0.0.1}
export APP_VERSION=$DEV_VERSION
export FRONTEND_DEBUG=$DEBUG

echo "DATABASE_URL: ", $DATABASE_URL
echo "STORAGE_PATH: ", $STORAGE_PATH

echo "==> Starting Point on http://localhost:$PORT"
echo "Press Ctrl+C to stop"

# Run the application
./point
