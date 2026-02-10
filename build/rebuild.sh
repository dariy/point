#!/bin/bash
cd "$(dirname "$0")"
# Generate timestamp-based version for development builds
export DEV_BUILD_VERSION="dev-$(date +%Y%m%d-%H%M%S)"

echo "Building with version: $DEV_BUILD_VERSION"

# Build CSS bundles
./build_css.sh

podman compose -f docker-compose.dev.yml build --build-arg BUILD_VERSION=$DEV_BUILD_VERSION
podman compose -f docker-compose.dev.yml down -t 0
podman compose -f docker-compose.dev.yml up -d

rm ../app/static/css/main.css
rm ../app/static/css/light.css