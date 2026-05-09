#!/bin/bash
# External backup script for Point photo blog.
# Runs on a local machine — SSHes to the Point server, downloads the latest backup that
# was created by Point's built-in scheduler, then removes old backups from
# Point to avoid disk overfill.
#
# Install: copy to /usr/local/bin/point-backup.sh and chmod +x
# Point's scheduler creates backups at 3am; run this at 4am to pick them up.

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────────
# Required — set via environment or edit /etc/systemd/system/point-backup.service
POINT_HOST="${POINT_HOST:?Set POINT_HOST (SSH host of the Point server)}"
POINT_BACKUP_DIR="${POINT_BACKUP_DIR:?Set POINT_BACKUP_DIR (path to backups on Point host)}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/var/backups/point}"
KEEP_ON_POINT="${KEEP_ON_POINT:-1}"   # backups to leave on Point after download
KEEP_LOCAL="${KEEP_LOCAL:-30}"        # local backups to retain on a local machine
LOG_TAG="point-backup"
# ───────────────────────────────────────────────────────────────────────────────

log()  { logger -t "$LOG_TAG" "$*"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die()  { log "ERROR: $*"; exit 1; }

mkdir -p "$LOCAL_BACKUP_DIR"

# 1. Find all non-empty backups on Point, newest first.
log "Checking for backups on $POINT_HOST:$POINT_BACKUP_DIR..."
REMOTE_BACKUPS=$(ssh "$POINT_HOST" "
    find '$POINT_BACKUP_DIR' -maxdepth 1 -name 'backup_*.tar.gz' -size +0c \
        -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | awk '{print \$2}'
") || die "SSH to $POINT_HOST failed"

if [ -z "$REMOTE_BACKUPS" ]; then
    die "No valid (non-empty) backups found on $POINT_HOST:$POINT_BACKUP_DIR"
fi

BACKUP_COUNT=$(echo "$REMOTE_BACKUPS" | wc -l)
log "Found $BACKUP_COUNT backup(s) on Point"

# 2. Download any backup not already present locally.
DOWNLOADED=0
while IFS= read -r REMOTE_FILE; do
    BACKUP_NAME=$(basename "$REMOTE_FILE")
    LOCAL_FILE="$LOCAL_BACKUP_DIR/$BACKUP_NAME"

    if [ -f "$LOCAL_FILE" ]; then
        log "Already have $BACKUP_NAME — skipping"
        continue
    fi

    log "Downloading $BACKUP_NAME..."
    scp "$POINT_HOST:$REMOTE_FILE" "$LOCAL_FILE" \
        || { log "WARNING: scp failed for $BACKUP_NAME"; continue; }
    log "Saved $(du -h "$LOCAL_FILE" | cut -f1) → $LOCAL_FILE"
    DOWNLOADED=$((DOWNLOADED + 1))
done <<< "$REMOTE_BACKUPS"

log "Downloaded $DOWNLOADED new backup(s)"

# 3. Remove old backups from Point, keeping the most recent $KEEP_ON_POINT.
log "Pruning Point backups (keeping $KEEP_ON_POINT)..."
DELETED_ON_POINT=$(ssh "$POINT_HOST" "
    FILES=\$(find '$POINT_BACKUP_DIR' -maxdepth 1 -name 'backup_*.tar.gz' \
        -printf '%T@ %p\n' 2>/dev/null | sort -rn | awk '{print \$2}')
    COUNT=\$(echo \"\$FILES\" | wc -l)
    TO_DELETE=\$(echo \"\$FILES\" | tail -n +\$((${KEEP_ON_POINT} + 1)))
    # Also delete zero-byte files
    ZERO=\$(find '$POINT_BACKUP_DIR' -maxdepth 1 -name 'backup_*.tar.gz' -size 0 2>/dev/null)
    ALL_DELETE=\"\$TO_DELETE\${ZERO:+\$'\n'\$ZERO}\"
    if [ -n \"\$ALL_DELETE\" ]; then
        echo \"\$ALL_DELETE\" | sort -u | xargs rm -f
        echo \"\$ALL_DELETE\" | sort -u | wc -l
    else
        echo 0
    fi
") || log "WARNING: remote pruning failed"

log "Removed $DELETED_ON_POINT old backup(s) from Point"

# 4. Prune old local backups on a local machine.
EXCESS=$(find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "backup_*.tar.gz" \
         | sort | head -n "-$KEEP_LOCAL" 2>/dev/null | wc -l)
if [ "$EXCESS" -gt 0 ]; then
    find "$LOCAL_BACKUP_DIR" -maxdepth 1 -name "backup_*.tar.gz" \
        | sort | head -n "-$KEEP_LOCAL" | xargs rm -f
    log "Pruned $EXCESS old local backup(s)"
fi

# 5. Report Point disk usage after cleanup.
POINT_USAGE=$(ssh "$POINT_HOST" "df -h / | awk 'NR==2{print \$3\"/\"\$2\" (\"\$5\" used)\"}'") \
    || POINT_USAGE="unknown"
log "Point disk after cleanup: $POINT_USAGE"

log "Done."
