#!/bin/bash
set -euo pipefail

# Get the absolute path to the project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Move to the build directory
cd "$PROJECT_ROOT/build"

# Check for --clean parameter
PULL_FLAG="--pull=missing"
if [ "${1:-}" == "--clean" ]; then
    PULL_FLAG=""
    echo "Clean build: pulling latest images"
fi

# Generate timestamp-based version for development builds
GIT_VERSION=$(git describe --tags --abbrev=0 2>/dev/null || echo "v0.1.0")
VERSION_NUM=${GIT_VERSION#v}
export DEV_BUILD_VERSION="${VERSION_NUM}-dev-$(date +%Y%m%d-%H%M%S)"

echo "Building with version: $DEV_BUILD_VERSION"

# Ensure .env exists
if [ ! -f .env ] && [ -f .env.example ]; then
    cp .env.example .env
elif [ ! -f .env ]; then
    touch .env
fi

# Inject GEMINI_API_KEY from an age-encrypted file if it exists.
# The key is appended to .env now and stripped on EXIT (success or failure).
if [ -f gemini_api_key.age ]; then
    _GEMINI_KEY=$(age -d -i ~/.age/key gemini_api_key.age 2>/dev/null)
    if [ -n "$_GEMINI_KEY" ]; then
        sed -i '/^GEMINI_API_KEY=/d' .env          # remove any stale entry
        echo "GEMINI_API_KEY=$_GEMINI_KEY" >> .env
        trap 'sed -i "/^GEMINI_API_KEY=/d" .env' EXIT
    fi
fi
unset _GEMINI_KEY

# Use podman as the standard container engine
# Using build/Dockerfile which is a multi-stage build
# We tag the builder stage to avoid dangling images and reuse it
echo "Starting container build..."
podman build $PULL_FLAG \
    --format docker \
    --target builder \
    -t point-builder:latest \
    -f Dockerfile \
    ..

podman build $PULL_FLAG \
    --format docker \
    -t point:dev \
    -f Dockerfile \
    --cache-from point-builder \
    --build-arg "BUILD_VERSION=$DEV_BUILD_VERSION" \
    ..

# Stop and remove existing container to ensure a clean start
echo "Stopping and removing existing container..."
podman rm -f point-test 2>/dev/null || true

# Host data dir, overridable via POINT_DATA_DIR in .env (defaults to ../data)
_DATA_DIR=$(grep -E '^POINT_DATA_DIR=.+' .env 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
DATA_DIR=${_DATA_DIR:-../data}
unset _DATA_DIR

# Pre-create data dirs as host user so --userns=keep-id containers can write
mkdir -p "$DATA_DIR/media/originals" "$DATA_DIR/media/thumbnails" "$DATA_DIR/logs" "$DATA_DIR/backups"

# Optionally mount PHOTO_LIBRARY_PATH as a read-only volume when set in .env
_PHOTO_PATH=$(grep -E '^PHOTO_LIBRARY_PATH=.+' .env 2>/dev/null | cut -d= -f2- | tr -d '[:space:]' || true)
PHOTO_IMPORT_ARGS=()
if [ -n "$_PHOTO_PATH" ]; then
    PHOTO_IMPORT_ARGS=(-v "${_PHOTO_PATH}:/import:ro,z" -e PHOTO_LIBRARY_PATH=/import)
fi
unset _PHOTO_PATH

# Optionally set host port mapping via DEPLOY_PORT in .env
_HOST_PORT=$(grep -E '^DEPLOY_PORT=[0-9]+' .env 2>/dev/null | cut -d= -f2 | tr -d '[:space:]' || true)
HOST_PORT=${_HOST_PORT:-8000}
unset _HOST_PORT

echo "Starting container..."
podman run -d \
    --name point-test \
    --restart unless-stopped \
    --user "$(id -u):$(id -g)" \
    --userns=keep-id \
    -p "${HOST_PORT}:8000" \
    -v "$DATA_DIR:/data:z,U" \
    --env-file .env \
    -e TZ=UTC \
    -e DATABASE_URL=/data/point.db \
    -e STORAGE_PATH=/data \
    -e FRONTEND_DIR=/app/frontend \
    -e PORT=8000 \
    -e HOST=0.0.0.0 \
    -e TELEGRAM_TOKEN="${TELEGRAM_TOKEN:-}" \
    -e NOTIFY_TELEGRAM_CHAN="${NOTIFY_TELEGRAM_CHAN:-}" \
    -e NOTIFY_ADMINS="${NOTIFY_ADMINS:-}" \
    "${PHOTO_IMPORT_ARGS[@]}" \
    point:dev

# Clean up dangling images to save space
echo "Cleaning up dangling images..."
podman image prune -f

echo "Rebuild is done."
podman ps -f name=point-test
