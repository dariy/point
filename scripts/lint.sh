#!/bin/bash
# Combined lint script for Go backend and JS frontend.

# Exit on error
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Linting Go backend..."
cd "$ROOT_DIR/api"
golangci-lint run --timeout 5m --fix

echo "==> Linting JS frontend..."
cd "$ROOT_DIR"
eslint frontend/src

echo "All linting passed!"
