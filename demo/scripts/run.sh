#!/bin/bash
# Builds the static demo and serves it locally.
#
# The build is the whole *local* pipeline — JS (mock entry), CSS, themes,
# static assets, index.html, media and the host config — so anything you edit
# in frontend/src, frontend/css, demo/mock or demo/settings.mjs is on screen
# after the next run. It takes a few seconds; pass --no-build to skip it and
# serve demo/dist as it stands.
#
# What it deliberately does NOT do is reach the network. Generating content
# (picsum.photos photographs, Gemini prose) and recording fixtures from a live
# instance are separate, explicit steps — demo/scripts/make-content.sh — and
# their output, demo/mock/fixtures/fixtures.json, is an input here.
#
# Serving goes through demo/scripts/serve.mjs rather than `npx serve` because
# the demo needs the SPA fallback declared in the build's own `_redirects` —
# without it every /light route 404s and the admin demo is unreachable.
#
# Usage:
#   demo/scripts/run.sh [--no-build] [--skip-media]
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

BUILD=1
BUILD_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --no-build) BUILD=0 ;;
        # Leaves demo/dist without images — only worth it when iterating on
        # markup or styling and the media step is the slow part.
        --skip-media) BUILD_ARGS+=("--skip-media") ;;
        *) echo "unknown argument: $arg" >&2; exit 1 ;;
    esac
done

if [ "$BUILD" = "1" ]; then
    "$SCRIPT_DIR/build.sh" "${BUILD_ARGS[@]}"
fi

if [ ! -f demo/dist/index.html ]; then
    echo "demo/dist is not built. Run demo/scripts/run.sh without --no-build." >&2
    exit 1
fi

echo "==> Ensuring port $PORT is free..."
lsof -ti:"$PORT" | xargs kill -9 2>/dev/null || true

echo "==> Serving demo/dist on http://$HOST:$PORT"
echo "Press Ctrl+C to stop"

exec node demo/scripts/serve.mjs --dir=demo/dist --host="$HOST" --port="$PORT"
