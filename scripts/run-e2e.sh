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

# Each e2e file gets its own server and an empty storage path, so no file sees
# what an earlier file left behind and the result does not depend on the order.
# A start costs about 0.3 s. Pass test files as arguments to run a subset or a
# different order (for example `$(ls -r frontend/e2e/*.test.ts)`).
WORK_DIR=$(mktemp -d)
# Serve a private copy of the built frontend. build-js.sh starts with
# `rm -rf frontend/js`, and `run.sh --watch` runs it whenever frontend/src
# changes — which check.sh's js-test lane does (eslintRules.test.ts writes its
# fixtures there). Served from the shared tree, the page then gets no app.js
# and never boots, and a test fails on a handle that never appears.
cp -a frontend "$WORK_DIR/frontend"
export FRONTEND_DIR="$WORK_DIR/frontend"

APP_PID=""
stop_server() {
    if [ -n "$APP_PID" ]; then
        kill $APP_PID 2>/dev/null || true
        wait $APP_PID 2>/dev/null || true
        APP_PID=""
    fi
}

cleanup() {
    stop_server
    rm -rf "$WORK_DIR"
    rm -f point-e2e
}
trap cleanup EXIT INT TERM

start_server() {
    export STORAGE_PATH="$WORK_DIR/storage-$1"
    export DATABASE_URL="sqlite:$STORAGE_PATH/point.db"
    mkdir -p "$STORAGE_PATH/media/originals" "$STORAGE_PATH/media/thumbnails" "$STORAGE_PATH/media/variants" "$STORAGE_PATH/logs" "$STORAGE_PATH/themes"
    ./point-e2e > "$STORAGE_PATH/logs/e2e.log" 2>&1 &
    APP_PID=$!
    for i in $(seq 1 150); do
        if curl -s http://127.0.0.1:$PORT/health > /dev/null; then
            return 0
        fi
        sleep 0.02
    done
    echo "Server failed to start. Logs:"
    cat "$STORAGE_PATH/logs/e2e.log"
    exit 1
}

export E2E_BASE_URL="http://127.0.0.1:$PORT"
if [ $# -gt 0 ]; then
    FILES=("$@")
else
    FILES=(frontend/e2e/*.test.ts)
fi

# One file at a time: every file uses the same port. Serial also keeps a
# failure readable — the browser log belongs to one file.
FAILED=()
n=0
for f in "${FILES[@]}"; do
    n=$((n + 1))
    echo "==> [$n/${#FILES[@]}] $f"
    start_server "$n"
    if ! node --test "$f"; then
        FAILED+=("$f")
        echo "Server log for $f:"
        tail -n 50 "$STORAGE_PATH/logs/e2e.log"
    fi
    stop_server
done

if [ ${#FAILED[@]} -gt 0 ]; then
    echo "==> Failed e2e files:"
    printf '    %s\n' "${FAILED[@]}"
    exit 1
fi
echo "==> All ${#FILES[@]} e2e files passed"
