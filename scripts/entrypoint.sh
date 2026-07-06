#!/bin/sh
set -e

# Create data directories if missing (handles volume-mount overlay case).
# Runs as root so it can write regardless of host ownership; exits gracefully
# if the mount is genuinely unwritable (will surface as a clear app error).
mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups /data/themes /data/remark42/backup 2>/dev/null || true

# Admin basic-auth password for server-to-server moderation calls (Point →
# remark42 admin API on loopback). Generated once and persisted; exported so
# both processes see the same value. The public /comments proxy strips
# basic auth, so this never becomes an outside-facing surface.
if [ -z "$ADMIN_PASSWD" ]; then
    if [ ! -s /data/remark42/admin_passwd ]; then
        head -c 24 /dev/urandom | base64 | tr -d '/+=\n' > /data/remark42/admin_passwd
        chmod 600 /data/remark42/admin_passwd
        chown appuser:appuser /data/remark42/admin_passwd 2>/dev/null || true
    fi
    ADMIN_PASSWD=$(cat /data/remark42/admin_passwd 2>/dev/null)
fi
export ADMIN_PASSWD

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
