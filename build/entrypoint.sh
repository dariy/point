#!/bin/sh
set -e

# Create data directories if missing (handles volume-mount overlay case).
# Runs as root so it can write regardless of host ownership; exits gracefully
# if the mount is genuinely unwritable (will surface as a clear app error).
mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups 2>/dev/null || true
chown -R appuser:appuser /data 2>/dev/null || true

exec su-exec appuser "$@"
