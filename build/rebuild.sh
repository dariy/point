#!/bin/bash
# Move to the build directory where this script is located
cd "$(dirname "$0")"

# Find repository root
ROOT_DIR="$(cd .. && pwd)"

# Check for --clean parameter
PULL_FLAG="--pull=never"
if [ "$1" == "--clean" ]; then
    PULL_FLAG=""
    echo "Clean build: pulling latest images"
fi

# Generate timestamp-based version for development builds
export DEV_BUILD_VERSION="dev-$(date +%Y%m%d-%H%M%S)"

echo "Building with version: $DEV_BUILD_VERSION"

# Build CSS bundles
../scripts/build-css.sh

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
    --build-arg BUILD_VERSION=$DEV_BUILD_VERSION \
    .. && \
podman rm -f point 2>/dev/null || true && \
podman run -d \
    --name point \
    --restart unless-stopped \
    --userns=keep-id \
    -p 8000:8000 \
    -v ../data:/data:z \
    --env-file .env \
    -e TZ=UTC \
    -e DATABASE_URL=/data/point.db \
    -e STORAGE_PATH=/data \
    -e FRONTEND_DIR=/app/frontend \
    -e PORT=8000 \
    -e HOST=0.0.0.0 \
    point:dev

# Clean up dangling images to save space (optional, but addresses user's concern)
echo "Cleaning up dangling images..."
podman image prune -f
rm ../frontend/css/*.css # clear css artifacts for development builds
