#!/bin/bash
# Unified Backup & Restore Management Script
# Handles local container backups, production sync, and restores.

set -e

# Configuration - can be overridden by scripts/backup-config.sh
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/backup-config.sh"

if [ -f "$CONFIG_FILE" ]; then
    source "$CONFIG_FILE"
fi

# Default values if not in config
PROD_HOST="${PROD_HOST:-user@your-production-server.com}"
PROD_CONTAINER="${PROD_CONTAINER:-point-prod}"
PROD_SUDO="${PROD_SUDO:-}"
LOCAL_CONTAINER="${LOCAL_CONTAINER:-point}"
LOCAL_SUDO="${LOCAL_SUDO:-}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-${PROJECT_DIR}/backups}"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

usage() {
    echo "Usage: $0 [command] [args]"
    echo ""
    echo "Commands:"
    echo "  create          Create backup from local container"
    echo "  restore [file]  Restore backup to local container"
    echo "  pull            Pull latest backup from production to local machine"
    echo "  push [file]     Push local backup to production and restore it"
    echo "  test            Test production access and configuration"
    echo ""
    exit 1
}

# Detect container runtime
get_docker_cmd() {
    local sudo_cmd=$1
    if command -v docker &> /dev/null; then
        echo "${sudo_cmd:+$sudo_cmd }docker"
    elif command -v podman &> /dev/null; then
        echo "${sudo_cmd:+$sudo_cmd }podman"
    else
        error "Neither docker nor podman found."
    fi
}

DOCKER_LOCAL=$(get_docker_cmd "$LOCAL_SUDO")
DOCKER_PROD="${PROD_SUDO:+$PROD_SUDO }docker"

# Command to run INSIDE the container to create a backup
BACKUP_CMD_IN_CONTAINER='
    set -e
    TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
    BACKUP_FILE="/data/backups/backup_${TIMESTAMP}.tar.gz"
    mkdir -p /data/backups
    TEMP_DIR=$(mktemp -d)
    
    # Copy database and media
    [ -f /data/point.db ] && cp /data/point.db "$TEMP_DIR/point.db"
    mkdir -p "$TEMP_DIR/media"
    [ -d /data/media ] && cp -r /data/media/* "$TEMP_DIR/media/" 2>/dev/null || true
    
    # Create archive
    cd "$TEMP_DIR" && tar -czf "$BACKUP_FILE" .
    rm -rf "$TEMP_DIR"
    echo "$BACKUP_FILE"
'

create_local_backup() {
    log "Creating backup from local container: $LOCAL_CONTAINER"
    mkdir -p "$LOCAL_BACKUP_DIR"
    
    local latest_in_container
    latest_in_container=$($DOCKER_LOCAL exec "$LOCAL_CONTAINER" sh -c "$BACKUP_CMD_IN_CONTAINER" | tail -n 1)
    
    [ -z "$latest_in_container" ] && error "Backup creation failed in container."
    
    local backup_name=$(basename "$latest_in_container")
    local local_dest="$LOCAL_BACKUP_DIR/${backup_name%.tar.gz}_local.tar.gz"
    
    $DOCKER_LOCAL cp "$LOCAL_CONTAINER:$latest_in_container" "$local_dest"
    success "Backup saved to: $local_dest"
}

restore_local_backup() {
    local backup_file=$1
    [ -z "$backup_file" ] && error "Backup file required."
    [ ! -f "$backup_file" ] && error "File not found: $backup_file"
    
    warn "This will OVERWRITE data in $LOCAL_CONTAINER. Continue? (y/N)"
    read -r response
    [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]] || error "Restore cancelled."
    
    local backup_name=$(basename "$backup_file")
    log "Restoring $backup_name to $LOCAL_CONTAINER..."
    
    $DOCKER_LOCAL cp "$backup_file" "$LOCAL_CONTAINER:/tmp/$backup_name"
    $DOCKER_LOCAL exec "$LOCAL_CONTAINER" pkill -f api-bin || true
    
    $DOCKER_LOCAL exec "$LOCAL_CONTAINER" sh -c "
        set -e
        TEMP_DIR=\$(mktemp -d)
        tar -xzf /tmp/$backup_name -C \$TEMP_DIR
        [ -f \$TEMP_DIR/point.db ] && cp \$TEMP_DIR/point.db /data/point.db
        [ -d \$TEMP_DIR/media ] && rm -rf /data/media && cp -r \$TEMP_DIR/media /data/media
        rm -rf \$TEMP_DIR /tmp/$backup_name
    "
    
    $DOCKER_LOCAL restart "$LOCAL_CONTAINER"
    success "Restore complete."
}

pull_prod_backup() {
    log "Pulling backup from production: $PROD_HOST"
    mkdir -p "$LOCAL_BACKUP_DIR"
    
    local latest_prod_backup=$(ssh "$PROD_HOST" "$DOCKER_PROD exec $PROD_CONTAINER sh -c 'ls -t /data/backups/backup_*.tar.gz 2>/dev/null | head -1' || echo ''")
    
    if [ -z "$latest_prod_backup" ]; then
        warn "No backups found on production. Creating one now..."
        latest_prod_backup=$(ssh "$PROD_HOST" "$DOCKER_PROD exec $PROD_CONTAINER sh -c '$BACKUP_CMD_IN_CONTAINER'" | tail -n 1)
    fi
    
    [ -z "$latest_prod_backup" ] && error "Failed to find or create backup on production."
    
    local backup_name=$(basename "$latest_prod_backup")
    local local_file="$LOCAL_BACKUP_DIR/${backup_name%.tar.gz}_pulled_${TIMESTAMP}.tar.gz"
    
    log "Downloading $backup_name..."
    ssh "$PROD_HOST" "$DOCKER_PROD cp $PROD_CONTAINER:$latest_prod_backup /tmp/$backup_name"
    scp "$PROD_HOST:/tmp/$backup_name" "$local_file"
    ssh "$PROD_HOST" "rm -f /tmp/$backup_name"
    
    success "Backup pulled to: $local_file"
}

push_prod_backup() {
    local backup_file=$1
    [ -z "$backup_file" ] && error "Backup file required."
    [ ! -f "$backup_file" ] && error "File not found: $backup_file"
    
    warn "This will OVERWRITE data on PRODUCTION ($PROD_HOST). Are you SURE? (type 'yes')"
    read -r response
    [ "$response" == "yes" ] || error "Push cancelled."
    
    local backup_name=$(basename "$backup_file")
    log "Uploading $backup_name to production..."
    
    scp "$backup_file" "$PROD_HOST:/tmp/$backup_name"
    ssh "$PROD_HOST" "$DOCKER_PROD cp /tmp/$backup_name $PROD_CONTAINER:/tmp/$backup_name"
    ssh "$PROD_HOST" "$DOCKER_PROD exec $PROD_CONTAINER pkill -f api-bin || true"
    
    ssh "$PROD_HOST" "$DOCKER_PROD exec $PROD_CONTAINER sh -c \"
        set -e
        TEMP_DIR=\\\$(mktemp -d)
        tar -xzf /tmp/$backup_name -C \\\$TEMP_DIR
        [ -f \\\$TEMP_DIR/point.db ] && cp \\\$TEMP_DIR/point.db /data/point.db
        [ -d \\\$TEMP_DIR/media ] && rm -rf /data/media && cp -r \\\$TEMP_DIR/media /data/media
        rm -rf \\\$TEMP_DIR /tmp/$backup_name
    \""
    
    ssh "$PROD_HOST" "$DOCKER_PROD restart $PROD_CONTAINER"
    ssh "$PROD_HOST" "rm -f /tmp/$backup_name"
    success "Push and restore on production complete."
}

test_prod_access() {
    log "Testing SSH connection to $PROD_HOST..."
    ssh -o ConnectTimeout=5 "$PROD_HOST" echo "SSH OK" || error "SSH connection failed."
    
    log "Testing Docker access on production..."
    ssh "$PROD_HOST" "$DOCKER_PROD ps" > /dev/null || error "Docker access failed on production."
    
    log "Checking for container $PROD_CONTAINER..."
    ssh "$PROD_HOST" "$DOCKER_PROD ps --format '{{.Names}}' | grep -q '^$PROD_CONTAINER$'" || error "Container $PROD_CONTAINER not found on production."
    
    success "All production tests passed."
}

case "$1" in
    create)  create_local_backup ;;
    restore) restore_local_backup "$2" ;;
    pull)    pull_prod_backup ;;
    push)    push_prod_backup "$2" ;;
    test)    test_prod_access ;;
    *)       usage ;;
esac
