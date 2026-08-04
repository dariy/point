#!/bin/bash
# Local script to serve the static demo/dist directory using Node.js.
#
# Serving goes through demo/scripts/serve.mjs rather than `npx serve` because
# the demo needs the SPA fallback declared in the build's own `_redirects` —
# without it every /light route 404s and the admin demo is unreachable.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_ROOT="$(cd "$DEMO_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

HOST=${LOCAL_RUN:-0.0.0.0}
PORT=${PORT:-8002}

if [ ! -f demo/dist/index.html ]; then
    echo "demo/dist is not built. Run demo/scripts/build.sh first." >&2
    exit 1
fi

echo "==> Ensuring port $PORT is free..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

echo "==> Serving demo/dist on http://$HOST:$PORT"
echo "Press Ctrl+C to stop"

exec node demo/scripts/serve.mjs --dir=demo/dist --host="$HOST" --port="$PORT"
