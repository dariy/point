#!/bin/bash
# Push backup from lab to production and restore
# Usage: ./push-to-production.sh <backup_file>

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
PROD_HOST="${PROD_HOST:-user@production-server.com}"
PROD_CONTAINER="${PROD_CONTAINER:-point-prod}"
PROD_SUDO="${PROD_SUDO:-}"  # Set to "sudo" if docker requires root

# Build docker command prefix
DOCKER_CMD="${PROD_SUDO:+$PROD_SUDO }docker"

BACKUP_NAME=$(basename "$BACKUP_FILE")

echo "================================================"
echo "Push Backup to Production and Restore"
echo "================================================"
echo "Backup file: $BACKUP_FILE"
echo "Production host: $PROD_HOST"
echo "Container name: $PROD_CONTAINER"
echo ""
echo "⚠️  WARNING: This will OVERWRITE production data!"
echo ""

read -p "Are you sure you want to continue? (type 'yes' to confirm): " -r
echo
if [[ ! $REPLY == "yes" ]]; then
    echo "Restore cancelled."
    exit 1
fi

# Step 1: Upload backup to production host
echo "[1/5] Uploading backup to production..."
scp "$BACKUP_FILE" "$PROD_HOST:/tmp/$BACKUP_NAME"

# Step 2: Copy backup into container
echo "[2/5] Copying backup into container..."
ssh "$PROD_HOST" "$DOCKER_CMD cp /tmp/$BACKUP_NAME $PROD_CONTAINER:/tmp/$BACKUP_NAME"

# Step 3: Stop the application (keep container running)
echo "[3/5] Stopping application..."
ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER pkill -f uvicorn || true"
sleep 2

# Step 4: Restore backup inside container
echo "[4/5] Restoring backup..."
ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER sh -c '
set -e
echo \"Extracting backup...\"
TEMP_DIR=\$(mktemp -d)
tar -xzf /tmp/$BACKUP_NAME -C \$TEMP_DIR

echo \"Restoring database...\"
if [ -f \$TEMP_DIR/point.db ]; then
    cp \$TEMP_DIR/point.db /data/point.db
    echo \"  Database restored (from point.db)\"
elif [ -f \$TEMP_DIR/blog.db ]; then
    cp \$TEMP_DIR/blog.db /data/point.db
    echo \"  Database restored (from legacy blog.db -> point.db)\"
fi

echo \"Restoring media...\"
if [ -d \$TEMP_DIR/media ]; then
    rm -rf /data/media
    mkdir -p /data/media
    cp -r \$TEMP_DIR/media/* /data/media/
    echo \"  Media restored\"
fi

echo \"Cleaning up...\"
rm -rf \$TEMP_DIR /tmp/$BACKUP_NAME
echo \"Restore complete\"
'"

# Step 5: Restart the application
echo "[5/5] Restarting container..."
ssh "$PROD_HOST" "$DOCKER_CMD restart $PROD_CONTAINER"

# Cleanup temp file on production host
ssh "$PROD_HOST" "rm -f /tmp/$BACKUP_NAME"

echo ""
echo "================================================"
echo "✓ Backup restored on production successfully!"
echo "================================================"
echo ""
echo "Production should be accessible in ~10 seconds"
echo "Check status: ssh $PROD_HOST 'docker ps | grep $PROD_CONTAINER'"
echo ""
