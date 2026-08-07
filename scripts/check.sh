#!/bin/bash
# Full quality gate: lint, tests, vulnerability scan.
# Usage: ./scripts/check.sh [--fix] [--short] [--lint]
#   --fix    Pass --fix to golangci-lint (auto-fixes where possible)
#   --short  Skip long-running integration tests
#   --lint   Lint only — skip vet, tests and the vuln scan (`npm run lint`)

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

FIX_FLAG=""
SHORT_FLAG=""
LINT_ONLY=""
for arg in "$@"; do
    case $arg in
        --fix)   FIX_FLAG="--fix" ;;
        --short) SHORT_FLAG="--short" ;;
        --lint)  LINT_ONLY=1 ;;
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
# Use the lockfile-pinned eslint (flat config, eslint.config.js) — the system
# eslint may be a different major version reading a different config format.
run_step "JS lint" bash -c "
    cd '$ROOT_DIR'
    [ -x node_modules/.bin/eslint ] || npm ci --no-audit --no-fund
    node_modules/.bin/eslint frontend/src frontend/sw.js scripts/*.mjs \\
        demo/mock demo/*.mjs demo/scripts/*.mjs
"

if [ -n "$LINT_ONLY" ]; then
    if [ ${#FAIL[@]} -gt 0 ]; then
        echo ""
        for s in "${FAIL[@]}"; do echo "  FAIL  $s"; done
        exit 1
    fi
    echo ""
    echo "  Linting passed."
    exit 0
fi

# ── Go vet ────────────────────────────────────────────────────────────────────
run_step "Go vet" bash -c "
    cd '$ROOT_DIR/api'
    go vet -tags=integration ./...
"

# ── Go tests ──────────────────────────────────────────────────────────────────
run_step "Go tests" bash -c "
    cd '$ROOT_DIR/api'
    go test -tags=integration $SHORT_FLAG -coverprofile=coverage.out ./...
    go tool cover -func=coverage.out | tail -1
"

# ── Go coverage floor ────────────────────────────────────────────────────────
# Skipped under --short: that flag drops the long-running integration tests,
# so the profile it produces is not comparable to the floor.
if [ -n "$SHORT_FLAG" ]; then
    echo ""
    echo "==> Go coverage  (skipped — --short profile is not comparable)"
else
    run_step "Go coverage" "$SCRIPT_DIR/coverage-gate.sh" "$ROOT_DIR/api/coverage.out"
fi

# ── JS tests ──────────────────────────────────────────────────────────────────
# Coverage is collected in the same pass (V8 instrumentation, no extra runner)
# and written as lcov for the gate below and for codecov in CI.
run_step "JS tests" bash -c "
    cd '$ROOT_DIR'
    node --test --experimental-test-coverage \
        --test-coverage-include='frontend/src/**' \
        --test-reporter=spec --test-reporter-destination=stdout \
        --test-reporter=lcov --test-reporter-destination=coverage-frontend.lcov \
        frontend/test/*.test.js
"

# ── JS coverage floor ────────────────────────────────────────────────────────
run_step "JS coverage" node "$SCRIPT_DIR/js-coverage-report.mjs" "$ROOT_DIR/coverage-frontend.lcov"

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
