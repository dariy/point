#!/bin/bash
# Deployment Verification Script
# Checks which version of the application is currently deployed

set -e

echo "=== Deployment Verification ==="
echo ""

# Check if docker is available
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed or not in PATH"
    exit 1
fi

# Find the container name (try both prod and dev names)
CONTAINER_NAME=""
if docker ps --format '{{.Names}}' | grep -q "point-prod"; then
    CONTAINER_NAME="point-prod"
elif docker ps --format '{{.Names}}' | grep -q "point"; then
    CONTAINER_NAME="point"
elif docker ps --format '{{.Names}}' | grep -q "photo-blog-prod"; then
    CONTAINER_NAME="photo-blog-prod"
elif docker ps --format '{{.Names}}' | grep -q "photo-blog"; then
    CONTAINER_NAME="photo-blog"
else
    echo "❌ No running point container found"
    echo ""
    echo "Available containers:"
    docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"
    exit 1
fi

echo "📦 Container: $CONTAINER_NAME"
echo ""

# Get container information
IMAGE=$(docker inspect $CONTAINER_NAME --format='{{.Config.Image}}')
CREATED=$(docker inspect $CONTAINER_NAME --format='{{.Created}}')
STATUS=$(docker inspect $CONTAINER_NAME --format='{{.State.Status}}')

echo "🖼️  Image: $IMAGE"
echo "📅 Created: $CREATED"
echo "🚦 Status: $STATUS"
echo ""

# Get environment variables from container
echo "🔧 Environment Configuration:"
APP_VERSION=$(docker exec $CONTAINER_NAME printenv APP_VERSION 2>/dev/null || echo "not set")
echo "   APP_VERSION: $APP_VERSION"

# Try to get version from .env file if mounted
if [ -f .env ]; then
    echo ""
    echo "📝 .env file configuration:"
    grep "^APP_VERSION=" .env 2>/dev/null || echo "   APP_VERSION not in .env"
    grep "^IMAGE_TAG=" .env 2>/dev/null || echo "   IMAGE_TAG not in .env"
fi

# Get image digest for verification
echo ""
echo "🔐 Image Digest:"
docker inspect $IMAGE --format='{{index .RepoDigests 0}}' 2>/dev/null || echo "   Digest not available"

# Check health status
echo ""
echo "💚 Health Status:"
HEALTH=$(docker inspect $CONTAINER_NAME --format='{{.State.Health.Status}}' 2>/dev/null || echo "no healthcheck")
echo "   Status: $HEALTH"

if [ "$HEALTH" = "healthy" ] || [ "$HEALTH" = "no healthcheck" ]; then
    # Try to call the application's version endpoint if it exists
    echo ""
    echo "🌐 Application Status:"
    if docker exec $CONTAINER_NAME curl -f -s http://localhost:8000/health > /dev/null 2>&1; then
        echo "   ✅ Health endpoint responding"
    else
        echo "   ❌ Health endpoint not responding"
    fi
fi

echo ""
echo "=== Verification Complete ==="
