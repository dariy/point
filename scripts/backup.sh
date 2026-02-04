#!/bin/bash
# Backup script for Photo Blog

set -e

# Configuration
DATA_DIR="data"
BACKUP_DIR="${DATA_DIR}/backups"
DB_FILE="${DATA_DIR}/point.db"
MEDIA_DIR="${DATA_DIR}/media"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_FILE="${BACKUP_DIR}/backup_${TIMESTAMP}.tar.gz"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

echo "Creating backup at $BACKUP_FILE..."

# Create temporary directory
TEMP_DIR=$(mktemp -d)
mkdir -p "$TEMP_DIR/media"

# Copy database
if [ -f "$DB_FILE" ]; then
    cp "$DB_FILE" "$TEMP_DIR/point.db"
    echo "  Database included"
else
    echo "  WARNING: Database file not found at $DB_FILE"
fi

# Copy media
if [ -d "$MEDIA_DIR" ]; then
    cp -r "$MEDIA_DIR/"* "$TEMP_DIR/media/" 2>/dev/null || true
    echo "  Media files included"
else
    echo "  WARNING: Media directory not found at $MEDIA_DIR"
fi

# Create archive
# We cd into TEMP_DIR to store relative paths in the archive
cd "$TEMP_DIR" && tar -czf "$OLDPWD/$BACKUP_FILE" .

# Cleanup
cd "$OLDPWD"
rm -rf "$TEMP_DIR"

echo "Backup created successfully: $BACKUP_FILE"
