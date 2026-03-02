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

# Inject GEMINI_API_KEY from the system keyring for the deployment.
# The key is appended to .env now and stripped on EXIT (success or failure).
_GEMINI_KEY=$(secret-tool lookup service gemini account light 2>/dev/null)
if [ -n "$_GEMINI_KEY" ]; then
    sed -i '/^GEMINI_API_KEY=/d' .env          # remove any stale entry
    echo "GEMINI_API_KEY=$_GEMINI_KEY" >> .env
    trap 'sed -i "/^GEMINI_API_KEY=/d" .env' EXIT
fi
unset _GEMINI_KEY

# Use podman as the standard container engine
# Using build/Dockerfile which is a multi-stage build
# We tag the builder stage to avoid dangling images and reuse it
echo "Starting container build..."
podman build $PULL_FLAG \
    --target builder \
    -t point-builder:latest \
    -f Dockerfile \
    ..

podman build $PULL_FLAG \
    -t point:dev \
    -f Dockerfile \
    --cache-from point-builder \
    --build-arg BUILD_VERSION=$DEV_BUILD_VERSION \
    .. && \
podman-compose -f docker-compose.yml down -t 0 && \
podman-compose -f docker-compose.yml up -d

# Clean up dangling images to save space (optional, but addresses user's concern)
echo "Cleaning up dangling images..."
podman image prune -f
rm ../frontend/css/*.css # clear css artifacts for development builds
