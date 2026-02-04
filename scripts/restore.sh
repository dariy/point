#!/bin/bash
# Restore script for Photo Blog

set -e

if [ -z "$1" ]; then
    echo "Usage: $0 <backup_file>"
    exit 1
fi

BACKUP_FILE="$1"
DATA_DIR="data"
DB_FILE="${DATA_DIR}/point.db"
MEDIA_DIR="${DATA_DIR}/media"

if [ ! -f "$BACKUP_FILE" ]; then
    echo "Error: Backup file not found: $BACKUP_FILE"
    exit 1
fi

echo "WARNING: This will overwrite current data!"
read -p "Are you sure you want to continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Restore cancelled."
    exit 1
fi

echo "Restoring from $BACKUP_FILE..."

# Create temp dir
TEMP_DIR=$(mktemp -d)

# Extract backup
tar -xzf "$BACKUP_FILE" -C "$TEMP_DIR"

# Restore database
if [ -f "$TEMP_DIR/point.db" ]; then
    mkdir -p "$DATA_DIR"
    cp "$TEMP_DIR/point.db" "$DB_FILE"
    echo "  Database restored (from point.db)"
elif [ -f "$TEMP_DIR/blog.db" ]; then
    mkdir -p "$DATA_DIR"
    cp "$TEMP_DIR/blog.db" "$DB_FILE"
    echo "  Database restored (from legacy blog.db)"
fi

# Restore media
if [ -d "$TEMP_DIR/media" ]; then
    mkdir -p "$MEDIA_DIR"
    cp -r "$TEMP_DIR/media/"* "$MEDIA_DIR/"
    echo "  Media restored"
fi

# Cleanup
rm -rf "$TEMP_DIR"

echo "Restore complete."
