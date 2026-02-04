#!/bin/bash
# Test production server access for backup scripts
# Usage: ./test-production-access.sh

set -e

echo "================================================"
echo "Production Access Test"
echo "================================================"
echo ""

# Load configuration
if [ -f "scripts/backup-config.sh" ]; then
    source scripts/backup-config.sh
    echo "✓ Configuration loaded from backup-config.sh"
else
    echo "⚠ backup-config.sh not found, using defaults"
    PROD_HOST="${PROD_HOST:-user@production-server.com}"
    PROD_CONTAINER="${PROD_CONTAINER:-point-prod}"
    PROD_SUDO="${PROD_SUDO:-}"
fi

echo ""
echo "Configuration:"
echo "  PROD_HOST: $PROD_HOST"
echo "  PROD_CONTAINER: $PROD_CONTAINER"
echo "  PROD_SUDO: ${PROD_SUDO:-<none>}"
echo ""

DOCKER_CMD="${PROD_SUDO:+$PROD_SUDO }docker"

# Test 1: SSH Connection
echo "[Test 1/5] Testing SSH connection..."
if ssh "$PROD_HOST" echo "Connected" > /dev/null 2>&1; then
    echo "✓ SSH connection successful"
else
    echo "✗ SSH connection failed"
    echo "  Fix: Run 'ssh-copy-id $PROD_HOST' to setup key authentication"
    exit 1
fi
echo ""

# Test 2: Docker Access
echo "[Test 2/5] Testing Docker access..."
if ssh "$PROD_HOST" "$DOCKER_CMD ps" > /dev/null 2>&1; then
    echo "✓ Docker access successful"
else
    echo "✗ Docker access failed"
    echo "  Fix: See scripts/SETUP-PRODUCTION.md for docker permission setup"
    exit 1
fi
echo ""

# Test 3: Container Exists
echo "[Test 3/5] Checking if container exists..."
if ssh "$PROD_HOST" "$DOCKER_CMD ps --format '{{.Names}}' | grep -q '^${PROD_CONTAINER}$'"; then
    echo "✓ Container '$PROD_CONTAINER' found and running"
else
    echo "⚠ Container '$PROD_CONTAINER' not found or not running"
    echo ""
    echo "Available containers:"
    ssh "$PROD_HOST" "$DOCKER_CMD ps --format 'table {{.Names}}\t{{.Status}}'"
    echo ""
    echo "  Fix: Update PROD_CONTAINER in backup-config.sh with the correct name"
    exit 1
fi
echo ""

# Test 4: Container Exec
echo "[Test 4/5] Testing container exec access..."
if ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER echo 'OK'" > /dev/null 2>&1; then
    echo "✓ Container exec access successful"
else
    echo "✗ Container exec access failed"
    exit 1
fi
echo ""

# Test 5: Backup Directory
echo "[Test 5/5] Checking backup directory in container..."
BACKUP_COUNT=$(ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER sh -c 'ls /data/backups/*.tar.gz 2>/dev/null | wc -l' || echo '0'")
if [ "$BACKUP_COUNT" -gt 0 ]; then
    echo "✓ Found $BACKUP_COUNT backup(s) in /data/backups/"
    echo ""
    echo "Latest backups:"
    ssh "$PROD_HOST" "$DOCKER_CMD exec $PROD_CONTAINER sh -c 'ls -lht /data/backups/*.tar.gz | head -3'" || true
else
    echo "⚠ No backups found in /data/backups/"
    echo "  This is normal if backups haven't been created yet"
    echo "  The pull script will create one if needed"
fi
echo ""

# Success!
echo "================================================"
echo "✓ All tests passed!"
echo "================================================"
echo ""
echo "You're ready to use the backup scripts:"
echo "  ./scripts/pull-from-production.sh"
echo "  ./scripts/push-to-production.sh <backup-file>"
echo ""
