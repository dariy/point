#!/bin/sh
set -e

# Create data directories if missing (handles volume-mount overlay case).
# Runs as root so it can write regardless of host ownership; exits gracefully
# if the mount is genuinely unwritable (will surface as a clear app error).
mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups /data/themes 2>/dev/null || true

# If running as root, try to drop privileges to appuser.
# In some environments (like rootless Podman), su-exec might fail with
# "setgroups: Operation not permitted". If so, we fall back to running as-is.
if [ "$(id -u)" = '0' ]; then
    chown -R appuser:appuser /data 2>/dev/null || true
    exec su-exec appuser "$@" 2>/dev/null || {
        echo "Warning: su-exec failed, running as $(id -u -n)"
        exec "$@"
    }
else
    # Already running as a non-root user (e.g. via --user flag)
    exec "$@"
fi
