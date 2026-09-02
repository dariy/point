#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Overridable, because the pre-flight below refuses to run when it is taken.
export PORT="${E2E_PORT:-8005}"
export HOST=127.0.0.1

# Refuse to start on a port something else already holds. Without this the run
# is worse than a failure: our binary dies on bind, every request below is
# answered by the foreign server, and the suite reports on data that is not ours
# — passing or failing for reasons nothing in this repo explains. Checked here
# rather than after launch because a child that died on bind is a zombie until
# reaped, and `kill -0` reports a zombie as alive.
if (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; then
    exec 3>&-
    echo "Port $PORT is already in use — refusing to run against a foreign server."
    echo "Stop whatever is listening, or re-run with E2E_PORT=<free port>."
    exit 1
fi

# Install Chromium if needed
echo "==> Ensuring Playwright Chromium is installed..."
npx playwright install chromium

# Always rebuild. The old guard tested frontend/css/public and frontend/js for
# existence, but the first is a *source* directory that is always present, so
# the whole build hinged on frontend/js — which exists in any tree that has been
# run once and is stale the moment frontend/src changes. The tests then assert
# against a build nobody made, and read as a product bug. Both builds together
# cost well under a second.
echo "==> Building JS/CSS..."
./scripts/build-css.sh
BUILD_DEBUG_FRONTEND=0 ./scripts/build-js.sh

echo "==> Building Go backend..."
cd "$ROOT_DIR/api"
go build -o ../point-e2e ./cmd/api
cd ..

export STORAGE_PATH=$(mktemp -d)
export DATABASE_URL="sqlite:$STORAGE_PATH/point.db"
export FRONTEND_DIR=frontend

mkdir -p "$STORAGE_PATH/media/originals" "$STORAGE_PATH/media/thumbnails" "$STORAGE_PATH/media/variants" "$STORAGE_PATH/logs" "$STORAGE_PATH/themes"

echo "==> Starting backend on port $PORT..."
./point-e2e > "$STORAGE_PATH/logs/e2e.log" 2>&1 &
APP_PID=$!

cleanup() {
    kill $APP_PID 2>/dev/null || true
    rm -rf "$STORAGE_PATH"
    rm -f point-e2e
}
trap cleanup EXIT INT TERM

# Wait for server
for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:$PORT/health > /dev/null; then
        echo "==> Server is up"
        break
    fi
    sleep 0.2
    if [ $i -eq 30 ]; then
        echo "Server failed to start. Logs:"
        cat "$STORAGE_PATH/logs/e2e.log"
        exit 1
    fi
done

export E2E_BASE_URL="http://127.0.0.1:$PORT"
# One file at a time: every e2e file drives the SAME server, and they all
# bootstrap it (POST /api/setup, publish a post). Run in parallel and two of
# them race on creating the owner, which the engine answers with a 409 for the
# loser at best and a 500 at worst. Serial also keeps a failure readable — the
# browser log belongs to one file.
node --test --test-concurrency=1 frontend/e2e/*.test.js
