#!/bin/bash
# Local script to serve the static dist-demo directory using Node.js.
#
# Serving goes through scripts/serve-demo.mjs rather than `npx serve` because
# the demo needs the SPA fallback declared in the build's own `_redirects` —
# without it every /light route 404s and the admin demo is unreachable.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    source .env
    set +a
fi

HOST=${LOCAL_RUN:-0.0.0.0}
PORT=${PORT:-8002}

if [ ! -f dist-demo/index.html ]; then
    echo "dist-demo is not built. Run scripts/build-demo.sh first." >&2
    exit 1
fi

echo "==> Ensuring port $PORT is free..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

echo "==> Serving dist-demo on http://$HOST:$PORT"
echo "Press Ctrl+C to stop"

exec node scripts/serve-demo.mjs --dir=dist-demo --host="$HOST" --port="$PORT"
