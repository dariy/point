#!/bin/bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Install Chromium if needed
echo "==> Ensuring Playwright Chromium is installed..."
npx playwright install chromium

echo "==> Building JS/CSS if missing..."
if [ ! -d "frontend/css/public" ] || [ ! -d "frontend/js" ]; then
    ./scripts/build-css.sh
    BUILD_DEBUG_FRONTEND=0 ./scripts/build-js.sh
fi

echo "==> Building Go backend..."
cd "$ROOT_DIR/api"
go build -o ../point-e2e ./cmd/api
cd ..

export STORAGE_PATH=$(mktemp -d)
export DATABASE_URL="sqlite:$STORAGE_PATH/point.db"
export PORT=8005
export HOST=127.0.0.1
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
