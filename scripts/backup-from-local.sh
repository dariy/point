#!/bin/bash
# Create backup from local Docker container
# Usage: ./backup-from-local.sh

set -e

# Configuration - adjust these or set via environment variables
LOCAL_CONTAINER="${LOCAL_CONTAINER:-photo-blog}"
LOCAL_SUDO="${LOCAL_SUDO:-}"  # Set to "sudo" if docker requires root
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-./backups}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

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

echo "================================================"
echo "Backup from Local Container"
echo "================================================"
echo "Container name: $LOCAL_CONTAINER"
echo "Backup directory: $LOCAL_BACKUP_DIR"
echo ""

# Ensure local backup directory exists
mkdir -p "$LOCAL_BACKUP_DIR"

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

# Step 2: Trigger backup creation inside container
echo "[2/5] Creating backup inside container..."
$DOCKER_CMD exec $LOCAL_CONTAINER python -c "from app.services.backup_service import BackupService; print(BackupService().create_backup())" || {
    echo "Warning: Could not create backup via Python service"
    echo "Attempting manual backup creation..."

    # Manual backup creation
    $DOCKER_CMD exec $LOCAL_CONTAINER sh -c '
        set -e
        TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
        BACKUP_FILE="/data/backups/backup_${TIMESTAMP}.tar.gz"
        mkdir -p /data/backups
        TEMP_DIR=$(mktemp -d)

        # Copy database and media
        cp /data/blog.db "$TEMP_DIR/blog.db" 2>/dev/null || true
        mkdir -p "$TEMP_DIR/media"
        cp -r /data/media/* "$TEMP_DIR/media/" 2>/dev/null || true

        # Create archive
        cd "$TEMP_DIR" && tar -czf "$BACKUP_FILE" .
        rm -rf "$TEMP_DIR"
        echo "$BACKUP_FILE"
    '
}

# Step 3: Find the latest backup
echo "[3/5] Finding latest backup..."
LATEST_BACKUP=$($DOCKER_CMD exec $LOCAL_CONTAINER sh -c 'ls -t /data/backups/backup_*.tar.gz 2>/dev/null | head -1' || echo '')

if [ -z "$LATEST_BACKUP" ]; then
    echo "Error: No backup found in container"
    exit 1
fi

BACKUP_NAME=$(basename "$LATEST_BACKUP")
echo "Found: $BACKUP_NAME"

# Step 4: Copy backup from container to host
echo "[4/5] Extracting backup from Docker volume..."
LOCAL_FILE="$LOCAL_BACKUP_DIR/backup_${TIMESTAMP}_local.tar.gz"
$DOCKER_CMD cp $LOCAL_CONTAINER:$LATEST_BACKUP "$LOCAL_FILE"

# Step 5: Verify backup
echo "[5/5] Verifying backup..."
if [ -f "$LOCAL_FILE" ]; then
    SIZE=$(du -h "$LOCAL_FILE" | cut -f1)
    echo "✓ Backup verified (size: $SIZE)"
else
    echo "Error: Backup file not found"
    exit 1
fi

echo ""
echo "================================================"
echo "✓ Backup created successfully!"
echo "================================================"
echo "Location: $LOCAL_FILE"
echo ""
echo "To push to production, run:"
echo "  source scripts/backup-config.sh"
echo "  ./scripts/push-to-production.sh $LOCAL_FILE"
echo ""
echo "To restore locally, run:"
echo "  ./scripts/restore-to-local.sh $LOCAL_FILE"
echo ""
