#!/bin/bash
# restore-db.sh — put a known-good database back, by hand.
#
# Point restores automatically in two places: a backup scheduled from the admin
# UI is applied at the next boot, and a failed migration is rolled back to the
# snapshot the boot took before it (see docs/plugins/backups.md). This script is
# for everything those two cannot cover:
#
#   - the automatic restore itself failed, or was interrupted twice
#   - a migration "succeeded" but the result is wrong, and you want the
#     pre-migration snapshot back
#   - the container will not boot far enough to reach the admin UI
#   - you have an archive from another machine and no session to upload it with
#
# It accepts either a database snapshot (.db — what the migration guard writes)
# or a full backup archive (.tar.gz — what the admin UI and the scheduler write).
#
# The one rule this exists to enforce: the SQLite WAL/SHM sidecars next to the
# database belong to the database being replaced. Copying a snapshot over
# point.db and leaving them there makes SQLite replay the old WAL into the new
# file and report "database disk image is malformed". They are deleted here.
#
# Usage:
#   scripts/restore-db.sh --list
#   scripts/restore-db.sh data/backups/migrations/premigration_20260808_120000.db
#   scripts/restore-db.sh -container point data/backups/backup_20260808_030000.tar.gz
#
# Flags:
#   -data DIR         data directory (default $STORAGE_PATH, else ./data)
#   -db PATH          database file (default $DATABASE_URL, else <data>/point.db)
#   -container NAME   stop this container around the swap and start it after
#   --with-media      .tar.gz only: also restore the media/ tree
#   --list            list what is available to restore, newest first, and exit
#   --yes             skip the confirmation prompt (required on a non-TTY)
#   --dry-run         print every step, change nothing
#
# The database being replaced is moved to <data>/backups/migrations/replaced_<ts>.db
# and kept there, so this script is itself undoable — the restore is verified
# before it commits, and rolled back if that verification fails.

set -eo pipefail

DATA_DIR="${STORAGE_PATH:-}"
DB_PATH=""
CONTAINER=""
WITH_MEDIA=false
DO_LIST=false
ASSUME_YES=false
DRY_RUN=false
SOURCE=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
log()     { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1" >&2; exit 1; }

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

run() {
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}[dry-run]${NC} $*"
    else
        "$@"
    fi
}

while [ $# -gt 0 ]; do
    case "$1" in
        -data)       DATA_DIR="$2"; shift 2 ;;
        -db)         DB_PATH="$2"; shift 2 ;;
        -container)  CONTAINER="$2"; shift 2 ;;
        --with-media) WITH_MEDIA=true; shift ;;
        --list)      DO_LIST=true; shift ;;
        --yes|-y)    ASSUME_YES=true; shift ;;
        --dry-run)   DRY_RUN=true; shift ;;
        -h|--help)   usage ;;
        -*)          error "Unknown flag: $1" ;;
        *)           [ -n "$SOURCE" ] && error "Only one source file may be given."; SOURCE="$1"; shift ;;
    esac
done

# ---------------------------------------------------------------- paths

DATA_DIR="${DATA_DIR:-./data}"
[ -d "$DATA_DIR" ] || error "Data directory not found: $DATA_DIR (use -data)"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

if [ -z "$DB_PATH" ]; then
    # DATABASE_URL carries the same sqlite: prefixes the Go config strips.
    DB_PATH="${DATABASE_URL:-}"
    DB_PATH="${DB_PATH#sqlite+aiosqlite:///}"
    DB_PATH="${DB_PATH#sqlite:///}"
    DB_PATH="${DB_PATH#sqlite:}"
    DB_PATH="${DB_PATH:-$DATA_DIR/point.db}"
fi
SNAP_DIR="$DATA_DIR/backups/migrations"

# ---------------------------------------------------------------- list

if [ "$DO_LIST" = true ]; then
    shopt -s nullglob
    entries=("$SNAP_DIR"/premigration_*.db "$SNAP_DIR"/replaced_*.db "$SNAP_DIR"/failed_*.db "$DATA_DIR"/backups/backup_*.tar.gz)
    shopt -u nullglob
    if [ ${#entries[@]} -eq 0 ]; then
        warn "Nothing to restore under $DATA_DIR/backups/"
        exit 0
    fi
    echo "Restorable files under $DATA_DIR/backups/ (newest first):"
    echo
    ls -lht "${entries[@]}" | awk '{printf "  %-6s %s %s %s  %s\n", $5, $6, $7, $8, $9}'
    echo
    echo "  premigration_*  snapshot taken just before a migration ran"
    echo "  replaced_*      database this script replaced on an earlier run"
    echo "  failed_*        database a failed migration left behind (for diagnosis)"
    echo "  backup_*        full backup archive (database + media)"
    exit 0
fi

[ -n "$SOURCE" ] || usage
[ -f "$SOURCE" ] || error "Source file not found: $SOURCE"
[ -s "$SOURCE" ] || error "Source file is empty: $SOURCE"
SOURCE="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"

case "$SOURCE" in
    *.db)     KIND=db ;;
    *.tar.gz) KIND=archive ;;
    *)        error "Unrecognized source: expected a .db snapshot or a .tar.gz archive." ;;
esac

if [ "$WITH_MEDIA" = true ] && [ "$KIND" != archive ]; then
    error "--with-media only applies to a .tar.gz archive."
fi

# ---------------------------------------------------------------- preflight

log "Checking $SOURCE"
if [ "$KIND" = db ]; then
    if command -v sqlite3 >/dev/null 2>&1; then
        # `|| true`: sqlite3 exits non-zero on a file that isn't a database, and
        # under `set -o pipefail` that would kill the script here — silently,
        # before the message below ever prints.
        check="$(sqlite3 "$SOURCE" "PRAGMA integrity_check;" 2>&1 | head -1 || true)"
        [ "$check" = "ok" ] || error "Snapshot fails its integrity check ($check). Refusing to restore it."
        success "Snapshot passes PRAGMA integrity_check"
    else
        warn "sqlite3 not on PATH — restoring without an integrity check"
    fi
else
    # Same rule the server applies before it will schedule a restore: the
    # archive has to actually contain the database.
    tar -tzf "$SOURCE" >/dev/null 2>&1 || error "Archive is not readable gzip/tar (truncated?)."
    DB_ENTRY="$(tar -tzf "$SOURCE" | grep -E "(^|/)$(basename "$DB_PATH")$" | head -1 || true)"
    [ -n "$DB_ENTRY" ] || error "Archive contains no $(basename "$DB_PATH") — this is not a Point backup."
    success "Archive contains $DB_ENTRY"
fi

echo
echo "  restore from : $SOURCE"
echo "  into         : $DB_PATH"
[ "$WITH_MEDIA" = true ] && echo "  media        : $DATA_DIR/media will be REPLACED"
[ -n "$CONTAINER" ]      && echo "  container    : $CONTAINER (stopped for the swap, started after)"
echo

if [ "$ASSUME_YES" != true ] && [ "$DRY_RUN" != true ]; then
    [ -t 0 ] || error "Not a TTY — pass --yes to confirm."
    printf "This overwrites the current database. Continue? (y/N) "
    read -r reply
    [[ "$reply" =~ ^[yY]([eE][sS])?$ ]] || error "Cancelled."
fi

# ---------------------------------------------------------------- quiesce

DOCKER=""
if [ -n "$CONTAINER" ]; then
    if command -v docker >/dev/null 2>&1; then DOCKER=docker
    elif command -v podman >/dev/null 2>&1; then DOCKER=podman
    else error "Neither docker nor podman found, but -container was given."
    fi
    log "Stopping container $CONTAINER"
    run $DOCKER stop "$CONTAINER" >/dev/null
elif [ -e "$DB_PATH" ]; then
    # Swapping the file under a running server is the corruption path this
    # script exists to avoid, so check as best the box allows.
    holder=""
    if command -v fuser >/dev/null 2>&1; then
        holder="$(fuser "$DB_PATH" 2>/dev/null || true)"
    elif command -v lsof >/dev/null 2>&1; then
        holder="$(lsof -t "$DB_PATH" 2>/dev/null || true)"
    else
        warn "Neither fuser nor lsof available — cannot confirm the database is closed."
    fi
    [ -n "$holder" ] && error "Something still has $DB_PATH open (pid$holder). Stop Point first, or pass -container."
fi

# ---------------------------------------------------------------- swap
#
# Four steps: rename the old aside, copy the new in, verify it, and — unlike the
# automatic paths — keep the old rather than deleting it, because this script's
# whole promise is that the operator can undo it. Renaming first is what makes
# the verification useful: a failure rolls back with a rename, having
# overwritten nothing.
#
# This does leave a moment where the database path does not exist, which Point
# would read as a fresh install. That is acceptable here and only here: someone
# is watching, and the marker written below names the renamed file. The boot's
# own restore cannot take that trade — nobody is watching a container restart —
# so it stages and renames over the top instead.

TS="$(date +%Y%m%d_%H%M%S)"
REPLACED="$SNAP_DIR/replaced_$TS.db"
MARKER="$SNAP_DIR/restore_in_progress"
TMP_EXTRACT=""
ROLLED_BACK=false

cleanup() {
    if [ -n "$TMP_EXTRACT" ] && [ -d "$TMP_EXTRACT" ]; then rm -rf "$TMP_EXTRACT"; fi
    return 0
}
trap cleanup EXIT

# rollback undoes every mutation below, in reverse. Each branch is a full if,
# never "test && cmd": under set -e a false test would abort the rollback.
rollback() {
    ROLLED_BACK=true
    warn "Rolling back — putting the original database back"
    rm -f "$DB_PATH"
    if [ -f "$REPLACED" ]; then
        mv "$REPLACED" "$DB_PATH"
    fi
    for suffix in wal shm; do
        if [ -f "$REPLACED-$suffix" ]; then
            mv "$REPLACED-$suffix" "$DB_PATH-$suffix"
        fi
    done
    if [ -n "${REPLACED_MEDIA:-}" ] && [ -d "$REPLACED_MEDIA" ]; then
        rm -rf "$DATA_DIR/media"
        mv "$REPLACED_MEDIA" "$DATA_DIR/media"
    fi
    rm -f "$MARKER"
    error "Restore failed and was rolled back. Nothing was changed."
}

# Get the incoming database into a readable place before anything moves.
NEW_DB="$SOURCE"
if [ "$KIND" = archive ]; then
    TMP_EXTRACT="$(mktemp -d)"
    log "Extracting the archive"
    run tar -xzf "$SOURCE" -C "$TMP_EXTRACT"
    if [ "$DRY_RUN" != true ]; then
        [ -f "$TMP_EXTRACT/$DB_ENTRY" ] || error "Extracted archive has no $DB_ENTRY"
    fi
    NEW_DB="$TMP_EXTRACT/$DB_ENTRY"
fi

run mkdir -p "$SNAP_DIR"
[ "$DRY_RUN" = true ] || echo "database moved to $REPLACED; if that is all you have, it is the real one" > "$MARKER"

# 1. rename the old out of the way, sidecars with it. They belong to the
#    database being replaced; beside the new one SQLite replays that stale WAL
#    into it and reports "database disk image is malformed".
if [ -e "$DB_PATH" ]; then
    log "Moving the current database aside as $REPLACED"
    run mv "$DB_PATH" "$REPLACED"
fi
for suffix in wal shm; do
    if [ -f "$DB_PATH-$suffix" ]; then
        run mv "$DB_PATH-$suffix" "$REPLACED-$suffix"
    fi
done

# 2. copy the new one in
log "Copying the restore into place"
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}[dry-run]${NC} cp $NEW_DB $DB_PATH"
elif ! cp "$NEW_DB" "$DB_PATH"; then
    rollback
fi

# Match the replaced file's ownership and mode — inside a container the server
# runs as a fixed uid and a root-owned database is unwritable to it.
if [ -f "$REPLACED" ] && [ "$DRY_RUN" != true ]; then
    chmod --reference="$REPLACED" "$DB_PATH" 2>/dev/null || true
    chown --reference="$REPLACED" "$DB_PATH" 2>/dev/null || true
fi
run sync

# 3. verify
if [ "$DRY_RUN" != true ]; then
    log "Verifying"
    if [ "$(wc -c < "$DB_PATH")" != "$(wc -c < "$NEW_DB")" ]; then
        warn "The copy is a different size from the source"
        rollback
    fi
    if [ "$(head -c 15 "$DB_PATH")" != "SQLite format 3" ]; then
        warn "The copy has no SQLite header"
        rollback
    fi
    if command -v sqlite3 >/dev/null 2>&1; then
        # `|| true` for the same reason as the preflight: a hard sqlite3 failure
        # must reach the rollback below, not abort the script mid-swap.
        check="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" 2>&1 | head -1 || true)"
        if [ "$check" != "ok" ]; then
            warn "The copy fails PRAGMA integrity_check: $check"
            rollback
        fi
    fi
    success "Restored database verified"
fi

if [ "$WITH_MEDIA" = true ] && [ -d "$TMP_EXTRACT/media" ]; then
    REPLACED_MEDIA="$SNAP_DIR/media_replaced_$TS"
    log "Moving $DATA_DIR/media aside as $REPLACED_MEDIA"
    if [ -d "$DATA_DIR/media" ]; then
        run mv "$DATA_DIR/media" "$REPLACED_MEDIA"
    fi
    log "Copying the archive's media in"
    if [ "$DRY_RUN" = true ]; then
        echo -e "${YELLOW}[dry-run]${NC} cp -a $TMP_EXTRACT/media $DATA_DIR/media"
    elif ! cp -a "$TMP_EXTRACT/media" "$DATA_DIR/media"; then
        rollback
    fi
    if [ "$DRY_RUN" != true ]; then
        want=$(find "$TMP_EXTRACT/media" -type f | wc -l)
        got=$(find "$DATA_DIR/media" -type f | wc -l)
        if [ "$got" -lt "$want" ]; then
            warn "Media copy is short ($got of $want files)"
            rollback
        fi
        success "Restored media verified ($got files)"
    fi
fi

# 4. the old is deliberately NOT removed — see the header comment.
[ "$DRY_RUN" = true ] || rm -f "$MARKER"

# A marker left by an interrupted automatic restore is now stale: the database
# at DB_PATH is the one the operator just chose.
if [ -f "$SNAP_DIR/restore_pending" ]; then
    log "Clearing the interrupted-restore marker"
    run rm -f "$SNAP_DIR/restore_pending"
fi

# ---------------------------------------------------------------- finish

if [ -n "$CONTAINER" ]; then
    log "Starting container $CONTAINER"
    run $DOCKER start "$CONTAINER" >/dev/null
fi

success "Restore complete."
echo
echo "Check the logs on the way up. If Point still refuses to start, the schema"
echo "may be newer than this database — run the image version that wrote it."
if [ "$DRY_RUN" != true ] && [ -f "$REPLACED" ]; then
    echo
    echo "To undo this, put back what it replaced:"
    echo "  $0 -data $DATA_DIR $REPLACED"
    if [ -n "${REPLACED_MEDIA:-}" ]; then
        echo "The media it replaced is at $REPLACED_MEDIA."
    fi
    echo "Delete those once you are satisfied — nothing prunes them for you."
fi
