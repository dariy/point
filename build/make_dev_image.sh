#!/bin/bash
cd "$(dirname "$0")"
# Build the base development image containing dependencies
echo "Building base development image (point:base-dev)..."
podman build -f base.Dockerfile -t point:base-dev ..
echo "Done. You can now run ./rebuild.sh to build the application layer."
