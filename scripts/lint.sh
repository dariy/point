#!/bin/bash
# Combined lint script for Go backend and JS frontend.

# Exit on error
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Linting Go backend..."
cd "$ROOT_DIR/api"
golangci-lint run --timeout 5m --fix --build-tags integration

echo "==> Linting JS frontend..."
cd "$ROOT_DIR"
# Use the lockfile-pinned eslint (flat config, eslint.config.js) — the system
# eslint may be a different major version reading a different config format.
[ -x node_modules/.bin/eslint ] || npm ci --no-audit --no-fund
node_modules/.bin/eslint frontend/src frontend/sw.js scripts/*.mjs

echo "All linting passed!"
