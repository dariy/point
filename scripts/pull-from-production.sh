#!/bin/bash
# Pull latest backup from production server to lab
# Usage: ./pull-from-production.sh

set -e

# Configuration - adjust these or set via environment variables
PROD_HOST="${PROD_HOST:-user@production-server.com}"
PROD_CONTAINER="${PROD_CONTAINER:-photo-blog}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-./backups}"
PROD_SUDO="${PROD_SUDO:-}"  # Set to "sudo" if docker requires root
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

# Build docker command prefix
DOCKER_CMD="${PROD_SUDO:+$PROD_SUDO }docker"

echo "================================================"
echo "Pull Backup from Production"
echo "================================================"
echo "Production host: $PROD_HOST"
echo "Container name: $PROD_CONTAINER"
echo "Local backup dir: $LOCAL_BACKUP_DIR"
echo ""

# Ensure local backup directory exists
mkdir -p "$LOCAL_BACKUP_DIR"

# Step 1: Find the latest backup in the production container
echo "[1/4] Finding latest backup on production..."
LATEST_BACKUP=$(ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER sh -c 'ls -t /data/backups/backup_*.tar.gz 2>/dev/null | head -1' || echo ''")

if [ -z "$LATEST_BACKUP" ]; then
    echo "Error: No backups found on production server"
    echo "Attempting to create a new backup on production..."

    # Trigger backup creation on production
    ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER python -c 'from app.services.backup_service import BackupService; print(BackupService().create_backup())'" || {
        echo "Failed to create backup. Please check the production server."
        exit 1
    }

    # Try finding the backup again
    LATEST_BACKUP=$(ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER sh -c 'ls -t /data/backups/backup_*.tar.gz | head -1'")
fi

BACKUP_NAME=$(basename "$LATEST_BACKUP")
echo "Found: $BACKUP_NAME"

# Step 2: Copy backup from container to production host temp directory
echo "[2/4] Extracting backup from Docker volume..."
ssh "$PROD_HOST" "$DOCKER_CMD cp $PROD_CONTAINER:$LATEST_BACKUP /tmp/$BACKUP_NAME"

# Step 3: Download backup from production host to lab
echo "[3/4] Downloading backup to lab..."
LOCAL_FILE="$LOCAL_BACKUP_DIR/${BACKUP_NAME%.tar.gz}_pulled_${TIMESTAMP}.tar.gz"
scp "$PROD_HOST:/tmp/$BACKUP_NAME" "$LOCAL_FILE"

# Step 4: Cleanup temp file on production
echo "[4/4] Cleaning up..."
ssh "$PROD_HOST" "rm -f /tmp/$BACKUP_NAME"

echo ""
echo "================================================"
echo "✓ Backup pulled successfully!"
echo "================================================"
echo "Location: $LOCAL_FILE"
echo ""
echo "To restore locally, run:"
echo "  ./scripts/restore.sh $LOCAL_FILE"
echo ""
