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
./build_css.sh

# Use podman as the standard container engine (with DNS workaround)
# Using build/Dockerfile which is a multi-stage build
podman build $PULL_FLAG -t point:dev -f Dockerfile --build-arg BUILD_VERSION=$DEV_BUILD_VERSION .. && \
podman-compose -f docker-compose.dev.yml down -t 0 && \
podman-compose -f docker-compose.dev.yml up -d
