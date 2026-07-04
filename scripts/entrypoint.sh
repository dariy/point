#!/bin/sh
set -e

# Create data directories if missing (handles volume-mount overlay case).
# Runs as root so it can write regardless of host ownership; exits gracefully
# if the mount is genuinely unwritable (will surface as a clear app error).
mkdir -p /data/media/originals /data/media/thumbnails /data/logs /data/backups /data/themes /data/remark42/backup 2>/dev/null || true

# Start the remark42 comments sidecar on localhost if configured; the Point
# server reverse-proxies to it. Skipped (blog unaffected) when env is missing.
# ponytail: no supervisor — if remark42 crashes, comments 502 but blog stays up;
# have Point spawn/supervise it if flapping is ever observed.
start_remark42() {
    if [ -z "$REMARK_SECRET" ] || [ -z "$REMARK_URL" ]; then
        echo "remark42: REMARK_SECRET/REMARK_URL not set, not starting comments engine"
        return 0
    fi
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
        ADMIN_PASSWD=$(cat /data/remark42/admin_passwd)
    fi
    export ADMIN_PASSWD
    # Replicate upstream docker-init.sh: bake REMARK_URL into the web assets
    find /app/remark42/web -regex '.*\.\(html\|js\|mjs\)$' -exec sed -i "s|{% REMARK_URL %}|${REMARK_URL}|g" {} \;
    (
        export SECRET="$REMARK_SECRET" SITE=remark \
            REMARK_ADDRESS=127.0.0.1 REMARK_PORT=8081 \
            STORE_BOLT_PATH=/data/remark42 BACKUP_PATH=/data/remark42/backup \
            AVATAR_FS_PATH=/data/remark42/avatars IMAGE_FS_PATH=/data/remark42/pictures
        if [ "$(id -u)" = '0' ]; then
            exec su-exec appuser /app/remark42/remark42 server
        fi
        exec /app/remark42/remark42 server
    ) &
    echo "remark42: started on 127.0.0.1:8081"
}

# If running as root, try to drop privileges to appuser.
# In some environments (like rootless Podman), su-exec might fail with
# "setgroups: Operation not permitted". If so, we fall back to running as-is.
if [ "$(id -u)" = '0' ]; then
    chown -R appuser:appuser /data 2>/dev/null || true
    start_remark42
    exec su-exec appuser "$@" 2>/dev/null || {
        echo "Warning: su-exec failed, running as $(id -u -n)"
        exec "$@"
    }
else
    # Already running as a non-root user (e.g. via --user flag)
    start_remark42
    exec "$@"
fi
