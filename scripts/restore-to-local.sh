#!/bin/bash
# Restore backup to local Docker container
# Usage: ./restore-to-local.sh <backup_file>

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file>"
    echo ""
    echo "Example:"
    echo "  $0 ./backups/backup_2026-01-30_12-00-00.tar.gz"
    exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

# Configuration - adjust these or set via environment variables
LOCAL_CONTAINER="${LOCAL_CONTAINER:-photo-blog}"
LOCAL_SUDO="${LOCAL_SUDO:-}"  # Set to "sudo" if docker requires root

# Detect container runtime (docker or podman)
if command -v docker &> /dev/null; then
    CONTAINER_CMD="docker"
elif command -v podman &> /dev/null; then
    CONTAINER_CMD="podman"
    echo "Note: Using podman (docker not found)"
else
    echo "Error: Neither docker nor podman found"
    echo "Please install docker or podman to use this script"
    exit 1
fi

# Build docker command prefix
DOCKER_CMD="${LOCAL_SUDO:+$LOCAL_SUDO }${CONTAINER_CMD}"

BACKUP_NAME=$(basename "$BACKUP_FILE")

echo "================================================"
echo "Restore to Local Container"
echo "================================================"
echo "Backup file: $BACKUP_FILE"
echo "Container name: $LOCAL_CONTAINER"
echo ""
echo "⚠️  WARNING: This will OVERWRITE local container data!"
echo ""

read -p "Are you sure you want to continue? (type 'yes' to confirm): " -r
echo
if [[ ! $REPLY == "yes" ]]; then
    echo "Restore cancelled."
    exit 1
fi

# Step 1: Check if container is running
echo "[1/5] Checking container status..."
if ! $DOCKER_CMD ps --format '{{.Names}}' | grep -q "^${LOCAL_CONTAINER}$"; then
    echo "Error: Container '$LOCAL_CONTAINER' is not running"
    echo ""
    echo "Available containers:"
    $DOCKER_CMD ps --format 'table {{.Names}}\t{{.Status}}'
    exit 1
fi
echo "✓ Container is running"

# Step 2: Copy backup into container
echo "[2/5] Copying backup into container..."
$DOCKER_CMD cp "$BACKUP_FILE" $LOCAL_CONTAINER:/tmp/$BACKUP_NAME

# Step 3: Stop the application (keep container running)
echo "[3/5] Stopping application..."
$DOCKER_CMD exec $LOCAL_CONTAINER pkill -f uvicorn || true
sleep 2

# Step 4: Restore backup inside container
echo "[4/5] Restoring backup..."
$DOCKER_CMD exec $LOCAL_CONTAINER sh -c "
set -e
echo 'Extracting backup...'
TEMP_DIR=\$(mktemp -d)
tar -xzf /tmp/$BACKUP_NAME -C \$TEMP_DIR

echo 'Restoring database...'
if [ -f \$TEMP_DIR/blog.db ]; then
    cp \$TEMP_DIR/blog.db /data/blog.db
    echo '  Database restored'
fi

echo 'Restoring media...'
if [ -d \$TEMP_DIR/media ]; then
    rm -rf /data/media
    mkdir -p /data/media
    cp -r \$TEMP_DIR/media/* /data/media/
    echo '  Media restored'
fi

echo 'Cleaning up...'
rm -rf \$TEMP_DIR /tmp/$BACKUP_NAME
echo 'Restore complete'
"

# Step 5: Restart the application
echo "[5/5] Restarting container..."
$DOCKER_CMD restart $LOCAL_CONTAINER

echo ""
echo "================================================"
echo "✓ Backup restored successfully!"
echo "================================================"
echo ""
echo "Container should be accessible in ~10 seconds"
echo "Check status: docker ps | grep $LOCAL_CONTAINER"
echo ""
