#!/bin/bash
# Full quality gate: lint, tests, vulnerability scan.
# Usage: ./scripts/check.sh [--fix] [--short] [--lint] [--changed] [--only <step>] [--verbose]
#   --fix      Pass --fix to golangci-lint (auto-fixes where possible)
#   --short    Skip long-running integration tests, and with them the Go
#              coverage floor and the E2E suite
#   --lint     Lint only — skip vet, tests and the vuln scan (`npm run lint`)
#   --changed  Only the lanes this branch touches: `git diff develop...HEAD`
#              plus uncommitted and untracked files (CHECK_BASE overrides develop)
#   --only S   Only step S; repeat it or comma-separate for more (`--list` names them)
#   --verbose  Stream every step's output as well as logging it (on in GitHub
#              Actions, where each CI step is one `--only` call)
#   --list     Print the steps, lane by lane, and exit
#
# The steps run in three lanes in parallel — Go, JS and E2E — and in order
# within a lane. Each step's output goes to tmp/check/<step>.log; the terminal
# gets one PASS/FAIL/SKIP line per step and, for a failed step only, the tail of
# its log (CHECK_TAIL lines, default 40). One red step does not stop the rest.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$ROOT_DIR/tmp/check"
TAIL="${CHECK_TAIL:-40}"

GO_LANE=(go-lint go-vet sql-layer go-test go-coverage govulncheck)
JS_LANE=(js-lint js-typecheck html-escaping vendor-sinks js-test js-coverage)
E2E_LANE=(e2e)
ALL_STEPS=("${GO_LANE[@]}" "${JS_LANE[@]}" "${E2E_LANE[@]}")
LINT_STEPS=" go-lint js-lint js-typecheck html-escaping vendor-sinks "

usage() { sed -n '2,/^$/{s/^# \{0,1\}//;p}' "$0"; }

list_steps() {
    echo "go:  ${GO_LANE[*]}"
    echo "js:  ${JS_LANE[*]}"
    echo "e2e: ${E2E_LANE[*]}"
}

FIX_FLAG=""
SHORT_FLAG=""
LINT_ONLY=""
CHANGED=""
VERBOSE="${GITHUB_ACTIONS:+1}"
ONLY=""
while [ $# -gt 0 ]; do
    case $1 in
        --fix)       FIX_FLAG="--fix" ;;
        --short)     SHORT_FLAG="--short" ;;
        --lint)      LINT_ONLY=1 ;;
        --changed)   CHANGED=1 ;;
        --verbose)   VERBOSE=1 ;;
        --only)      shift; ONLY="$ONLY ${1//,/ }" ;;
        --only=*)    v="${1#--only=}"; ONLY="$ONLY ${v//,/ }" ;;
        --list)      list_steps; exit 0 ;;
        -h|--help)   usage; exit 0 ;;
        *)           echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
    esac
    shift
done

for s in $ONLY; do
    case " ${ALL_STEPS[*]} " in
        *" $s "*) ;;
        *) echo "unknown step: $s" >&2; list_steps >&2; exit 2 ;;
    esac
done

# ── Steps ─────────────────────────────────────────────────────────────────────
# One function per step, named step_<name with _ for ->. run_step calls each in
# a subshell that sets `-eo pipefail` first, and not from an `if`, `&&` or `||`:
# in any of those positions bash ignores -e inside the body, even a -e the body
# sets itself, and then only the LAST command's status reaches run_step. That
# once passed "Go tests" while tests failed — `go test` was red, the `go tool
# cover` line after it was green, and green won.

step_go_lint() {
    cd "$ROOT_DIR/api"
    golangci-lint run --timeout 5m $FIX_FLAG
}

step_go_vet() {
    cd "$ROOT_DIR/api"
    go vet ./...
}

# Cheap and structural, so it runs before the test suite: a shadowed query or a
# stale generated file makes every result below it less meaningful.
step_sql_layer() {
    "$SCRIPT_DIR/check-sql-layer.sh"
}

# The coverage summary comes after `go test` under -e: a failed run must not be
# followed by a reassuring coverage line, and the failure must reach run_step.
# CI sets GOFLAGS=-count=1, because its restored Go cache holds test results.
step_go_test() {
    cd "$ROOT_DIR/api"
    go test $SHORT_FLAG -coverprofile=coverage.out ./...
    go tool cover -func=coverage.out | tail -1
}

step_go_coverage() {
    "$SCRIPT_DIR/coverage-gate.sh" "$ROOT_DIR/api/coverage.out"
}

step_govulncheck() {
    cd "$ROOT_DIR/api"
    govulncheck ./...
}

# The lockfile-pinned eslint (flat config, eslint.config.js) — the system eslint
# may be a different major version reading a different config format.
step_js_lint() {
    cd "$ROOT_DIR"
    node_modules/.bin/eslint frontend/src frontend/sw.js scripts/*.mjs \
        demo/mock demo/*.mjs demo/scripts/*.mjs
}

# The JSDoc annotations in frontend/src are types, and this is what makes them
# binding: tsc with checkJs, no emit, no .ts files. Files not yet clean carry
# `// @ts-nocheck` on line 1 — see jsconfig.json. Part of --lint, because a
# broken annotation is a static error like any other.
step_js_typecheck() {
    cd "$ROOT_DIR"
    node_modules/.bin/tsc --noEmit -p jsconfig.json
}

# What the AST rules in eslint.config.js cannot see: hand-applied escapeHtml in
# an interpolation, and growth in the set of raw() exceptions.
step_html_escaping() {
    "$SCRIPT_DIR/check-html-escaping.sh"
}

# The enforcing CSP names three policies; two of them live in patched vendored
# files that a version bump would overwrite. This is what notices.
step_vendor_sinks() {
    "$SCRIPT_DIR/check-vendor-sinks.sh"
}

# Coverage is collected in the same pass (V8 instrumentation, no extra runner)
# and written as lcov for the gate below and for codecov in CI.
step_js_test() {
    cd "$ROOT_DIR"
    node --test --experimental-test-coverage \
        --test-coverage-include='frontend/src/**' \
        --test-reporter=spec --test-reporter-destination=stdout \
        --test-reporter=lcov --test-reporter-destination=coverage-frontend.lcov \
        frontend/test/*.test.js
}

step_js_coverage() {
    node "$SCRIPT_DIR/js-coverage-report.mjs" "$ROOT_DIR/coverage-frontend.lcov"
}

# Builds its own binary and serves it on E2E_PORT (default 8005).
step_e2e() {
    "$SCRIPT_DIR/run-e2e.sh"
}

# ── Selection ─────────────────────────────────────────────────────────────────
declare -A SELECTED=()

if [ -n "$ONLY" ]; then
    for s in $ONLY; do SELECTED[$s]=1; done
else
    for s in "${ALL_STEPS[@]}"; do SELECTED[$s]=1; done
fi

if [ -n "$LINT_ONLY" ]; then
    for s in "${!SELECTED[@]}"; do
        [[ "$LINT_STEPS" == *" $s "* ]] || unset "SELECTED[$s]"
    done
fi

if [ -n "$CHANGED" ]; then
    base="${CHECK_BASE:-develop}"
    git -C "$ROOT_DIR" rev-parse -q --verify "$base" >/dev/null || base="origin/$base"
    go=""; js=""; e2e=""
    while IFS= read -r f; do
        case "$f" in
            api/*|scripts/check-sql-layer.sh|scripts/coverage-gate.sh) go=1 ;;
            frontend/*|demo/*|scripts/*.mjs|package.json|package-lock.json|eslint.config.js|jsconfig.json)
                js=1; e2e=1 ;;
            scripts/check-html-escaping.sh|scripts/check-vendor-sinks.sh) js=1 ;;
            scripts/run-e2e.sh|scripts/build-css.sh|scripts/build-js.sh) e2e=1 ;;
            scripts/check.sh) go=1; js=1; e2e=1 ;;
        esac
    done < <(cd "$ROOT_DIR" && {
        git diff --name-only "$base...HEAD"
        git diff --name-only HEAD
        git ls-files --others --exclude-standard
    })
    [ -n "$go" ]  || for s in "${GO_LANE[@]}";  do unset "SELECTED[$s]"; done
    [ -n "$js" ]  || for s in "${JS_LANE[@]}";  do unset "SELECTED[$s]"; done
    [ -n "$e2e" ] || for s in "${E2E_LANE[@]}"; do unset "SELECTED[$s]"; done
    lanes="${go:+go }${js:+js }${e2e:+e2e}"
    echo "Changed against $base: ${lanes:-no file any lane checks}"
fi

if [ ${#SELECTED[@]} -eq 0 ]; then
    echo "Nothing to check."
    exit 0
fi

# ── Runner ────────────────────────────────────────────────────────────────────
# A step is skipped, not run, when a flag rules it out or when the step it reads
# from failed in this same run — a coverage gate over a failed test run only
# repeats the failure with a misleading number. A prerequisite that was not
# selected (CI runs each step as its own `--only` call) does not count.
skip_reason() {
    case $1 in
        go-coverage)
            [ -z "$SHORT_FLAG" ] || { echo "--short profile is not comparable"; return; }
            failed_here go-test && echo "go-test failed" ;;
        js-coverage)
            failed_here js-test && echo "js-test failed" ;;
        e2e)
            [ -z "$SHORT_FLAG" ] || echo "--short" ;;
    esac
    return 0
}

failed_here() {
    [ -n "${SELECTED[$1]}" ] && [ "$(status_of "$1")" = FAIL ]
}

status_of() {
    local line=""
    [ -f "$LOG_DIR/$1.status" ] && read -r line < "$LOG_DIR/$1.status"
    echo "${line%% *}"
}

# Writes "<STATUS> <seconds> <reason>" for the summary, and prints the step's
# line as it finishes. Lanes print concurrently; each line is one short write.
record() {
    local name=$1 status=$2 secs=$3 reason=$4 detail
    echo "$status $secs $reason" > "$LOG_DIR/$name.status"
    if [ "$status" = SKIP ]; then detail="($reason)"; else detail="(${secs}s)"; fi
    printf '%-4s  %-14s %s\n' "$status" "$name" "$detail"
}

run_step() {
    local name=$1 fn="step_${1//-/_}" log="$LOG_DIR/$1.log" start=$SECONDS rc reason
    reason="$(skip_reason "$name")"
    if [ -n "$reason" ]; then
        record "$name" SKIP 0 "$reason"
        return 0
    fi
    set +e
    if [ -n "$VERBOSE" ]; then
        ( set -eo pipefail; "$fn" ) </dev/null 2>&1 | tee "$log"
        rc=${PIPESTATUS[0]}
    else
        ( set -eo pipefail; "$fn" ) </dev/null >"$log" 2>&1
        rc=$?
    fi
    set -e
    if [ "$rc" -eq 0 ]; then
        record "$name" PASS $((SECONDS - start)) ""
    else
        record "$name" FAIL $((SECONDS - start)) ""
    fi
}

run_lane() {
    local s
    for s in "$@"; do
        [ -n "${SELECTED[$s]}" ] || continue
        run_step "$s"
    done
}

mkdir -p "$LOG_DIR"
for s in "${!SELECTED[@]}"; do rm -f "$LOG_DIR/$s.log" "$LOG_DIR/$s.status"; done

# Both JS lanes need node_modules; installing once here keeps them from racing
# two `npm ci` runs over the same directory.
needs_node=""
for s in "${JS_LANE[@]}" "${E2E_LANE[@]}"; do [ -z "${SELECTED[$s]}" ] || needs_node=1; done
if [ -n "$needs_node" ] && { [ ! -x "$ROOT_DIR/node_modules/.bin/eslint" ] || [ ! -x "$ROOT_DIR/node_modules/.bin/tsc" ]; }; then
    echo "npm ci (node_modules is missing) — log: tmp/check/npm-ci.log"
    (cd "$ROOT_DIR" && npm ci --no-audit --no-fund) >"$LOG_DIR/npm-ci.log" 2>&1 || {
        tail -n "$TAIL" "$LOG_DIR/npm-ci.log"
        echo "npm ci failed."
        exit 1
    }
fi

# Each lane runs in its own process group (set -m), so Ctrl-C can stop a lane's
# whole tree — go test, node, the E2E server — without signalling whatever ran
# this script. run-e2e.sh traps TERM to stop its server and remove its scratch
# directory; the wait lets it finish doing so.
LANE_PIDS=()
stop_lanes() {
    local p
    trap - INT TERM
    # A lane that already finished has no group left to signal.
    for p in "${LANE_PIDS[@]}"; do kill -TERM -- "-$p" 2>/dev/null || true; done
    wait
    exit 130
}
trap stop_lanes INT TERM

start_lane() {
    local s
    for s in "$@"; do
        if [ -n "${SELECTED[$s]}" ]; then
            set -m
            run_lane "$@" &
            LANE_PIDS+=($!)
            set +m
            return
        fi
    done
}
start_lane "${GO_LANE[@]}"
start_lane "${JS_LANE[@]}"
start_lane "${E2E_LANE[@]}"
wait

# ── Summary ───────────────────────────────────────────────────────────────────
PASS=(); FAIL=(); SKIP=()
for s in "${ALL_STEPS[@]}"; do
    [ -n "${SELECTED[$s]}" ] || continue
    case "$(status_of "$s")" in
        PASS) PASS+=("$s") ;;
        SKIP) SKIP+=("$s") ;;
        *)    FAIL+=("$s") ;;
    esac
done

# The go test and node --test spec lines for passing packages and tests (and
# go's per-package line for packages with no tests) are dropped from the tail,
# so the failure is what fills it.
if [ -z "$VERBOSE" ]; then
    for s in "${FAIL[@]}"; do
        echo ""
        echo "──── $s — last $TAIL lines of tmp/check/$s.log ────"
        grep -vE '^(ok|\?)[[:space:]]|^[[:space:]]*✔ |^[[:space:]]+[^[:space:]]+[[:space:]]+coverage: ' \
            "$LOG_DIR/$s.log" | tail -n "$TAIL" || true
    done
fi

counts="${#PASS[@]} passed${SKIP:+, ${#SKIP[@]} skipped}, ${SECONDS}s"
echo ""
echo "════════════════════════════════════════"
if [ ${#FAIL[@]} -gt 0 ]; then
    for s in "${FAIL[@]}"; do echo "  FAIL  $s"; done
    echo "════════════════════════════════════════"
    echo "  ${#FAIL[@]} check(s) failed. ($counts)"
    exit 1
fi
if [ -n "$LINT_ONLY" ]; then
    echo "  Linting passed. ($counts)"
else
    echo "  All checks passed. ($counts)"
fi
