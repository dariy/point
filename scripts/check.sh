#!/bin/bash
# Full quality gate: lint, tests, vulnerability scan.
# Usage: ./scripts/check.sh [--fix] [--short]
#   --fix    Pass --fix to golangci-lint (auto-fixes where possible)
#   --short  Skip long-running integration tests

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIX_FLAG=""
SHORT_FLAG=""
for arg in "$@"; do
    case $arg in
        --fix)   FIX_FLAG="--fix" ;;
        --short) SHORT_FLAG="--short" ;;
    esac
done

PASS=()
FAIL=()

run_step() {
    local name="$1"
    shift
    echo ""
    echo "==> $name"
    if "$@"; then
        PASS+=("$name")
    else
        FAIL+=("$name")
        # Don't exit immediately — collect all failures
    fi
}

# ── Go lint ──────────────────────────────────────────────────────────────────
run_step "Go lint" bash -c "
    cd '$ROOT_DIR/api'
    golangci-lint run --timeout 5m $FIX_FLAG --build-tags integration
"

# ── JS lint ───────────────────────────────────────────────────────────────────
run_step "JS lint" bash -c "
    cd '$ROOT_DIR'
    eslint frontend/src
"

# ── Go vet ────────────────────────────────────────────────────────────────────
run_step "Go vet" bash -c "
    cd '$ROOT_DIR/api'
    go vet -tags=integration ./...
"

# ── Go tests ──────────────────────────────────────────────────────────────────
run_step "Go tests" bash -c "
    cd '$ROOT_DIR/api'
    go test -tags=integration $SHORT_FLAG -cover ./...
"

# ── JS tests ──────────────────────────────────────────────────────────────────
run_step "JS tests" bash -c "
    cd '$ROOT_DIR'
    node --test frontend/test/*.test.js
"

# ── Vulnerability scan ────────────────────────────────────────────────────────
run_step "govulncheck" bash -c "
    cd '$ROOT_DIR/api'
    govulncheck ./...
"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
for s in "${PASS[@]}"; do echo "  PASS  $s"; done
for s in "${FAIL[@]}"; do echo "  FAIL  $s"; done
echo "════════════════════════════════════════"

if [ ${#FAIL[@]} -gt 0 ]; then
    echo "  ${#FAIL[@]} check(s) failed."
    exit 1
else
    echo "  All checks passed."
fi
