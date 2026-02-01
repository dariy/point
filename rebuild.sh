#!/bin/bash
# Generate timestamp-based version for development builds
export DEV_BUILD_VERSION="dev-$(date +%Y%m%d-%H%M%S)"

echo "Building with version: $DEV_BUILD_VERSION"

podman compose build --build-arg BUILD_VERSION=$DEV_BUILD_VERSION
podman compose down
podman compose up -d