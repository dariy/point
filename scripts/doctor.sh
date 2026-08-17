#!/bin/bash
# Environment readiness: can this machine build, run and check Point?
#
# The alternative to this script is discovering the answer through a failing
# build — `check.sh` has always required `golangci-lint` and `govulncheck`
# without anything saying so. Every version below is read from the file that
# already decides it (api/go.mod for Go, .github/workflows/test.yml for Node
# and the two tool pins), so this report cannot drift from what CI enforces.
#
# Usage: ./scripts/doctor.sh [--json]
#   --json   the same report as one JSON object on stdout, nothing else
#
# FAIL is reserved for what makes a build impossible: no Go or Node, a version
# older than the repo requires, an unwritable data/. Tools only the quality
# gate needs are WARN — you can build and run Point without them, you just
# cannot run ./scripts/check.sh. Exit status is 1 if any row is FAIL, else 0,
# so `doctor.sh && run.sh` is a meaningful sequence.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$ROOT_DIR/.github/workflows/test.yml"

JSON=0
for arg in "$@"; do
    case "$arg" in
        --json) JSON=1 ;;
        -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [ "$JSON" = 0 ] && [ -t 1 ]; then
    C_PASS=$'\033[32m'; C_WARN=$'\033[33m'; C_FAIL=$'\033[31m'
    C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
else
    C_PASS=""; C_WARN=""; C_FAIL=""; C_DIM=""; C_OFF=""
fi

# ── Row collection ───────────────────────────────────────────────────────────
# One record per check, fields joined by US (0x1f) so notes may contain
# anything printable, tabs and pipes included.
SEP=$'\x1f'
ROWS=()
N_PASS=0; N_WARN=0; N_FAIL=0

# row <status> <id> <label> <found> <want> <note> [fix]
row() {
    local status="$1"
    case "$status" in
        pass) N_PASS=$((N_PASS + 1)) ;;
        warn) N_WARN=$((N_WARN + 1)) ;;
        fail) N_FAIL=$((N_FAIL + 1)) ;;
    esac
    ROWS+=("$1$SEP$2$SEP$3$SEP$4$SEP$5$SEP$6$SEP${7:-}")
}

# Compare dotted numeric versions field by field. `sort -V` would be shorter
# and is absent from BSD userlands; a contributor on macOS gets a real answer
# from this one. Only as many fields as the wanted version has are compared,
# so 1.26.6 satisfies a want of 1.26 and node's "22" needs no minor.
version_ge() {
    local -a have want
    local i x y
    IFS=. read -r -a have <<<"${1%%[-+]*}"
    IFS=. read -r -a want <<<"${2%%[-+]*}"
    for ((i = 0; i < ${#want[@]}; i++)); do
        x="${have[i]:-0}"; y="${want[i]:-0}"
        x="${x//[!0-9]/}"; y="${y//[!0-9]/}"
        x="${x:-0}"; y="${y:-0}"
        ((10#$x > 10#$y)) && return 0
        ((10#$x < 10#$y)) && return 1
    done
    return 0
}

# ── What the repo asks for ───────────────────────────────────────────────────
GO_WANT="$(awk '$1 == "go" { print $2; exit }' "$ROOT_DIR/api/go.mod" 2>/dev/null)"
NODE_WANT="$(sed -n 's/.*node-version: *"\{0,1\}\([0-9][0-9.]*\)"\{0,1\}.*/\1/p' "$WORKFLOW" 2>/dev/null | head -1)"
LINT_WANT="$(sed -n 's|.*golangci-lint@v\([0-9][0-9.]*\).*|\1|p' "$WORKFLOW" 2>/dev/null | head -1)"
VULN_WANT="$(sed -n 's|.*govulncheck@v\([0-9][0-9.]*\).*|\1|p' "$WORKFLOW" 2>/dev/null | head -1)"

# ── Go ───────────────────────────────────────────────────────────────────────
if ! command -v go >/dev/null 2>&1; then
    row fail go "Go" "not installed" "$GO_WANT" \
        "nothing in this repo builds without it" \
        "install Go $GO_WANT or newer — https://go.dev/dl/"
else
    go_found="$(go env GOVERSION 2>/dev/null)"; go_found="${go_found#go}"
    go_note="api/go.mod wants $GO_WANT"
    if [ -n "$go_found" ] && ! version_ge "$go_found" "$GO_WANT"; then
        # The version on PATH is not the whole answer: with GOTOOLCHAIN=auto
        # (the default) the go command downloads and runs the toolchain
        # api/go.mod names. Ask from inside the module, which is where the
        # switch happens — and only when the cheap check already failed, since
        # this line can pull a toolchain over the network.
        go_effective="$(cd "$ROOT_DIR/api" && go version 2>/dev/null | awk '{print $3}')"
        go_effective="${go_effective#go}"
        if [ -n "$go_effective" ] && version_ge "$go_effective" "$GO_WANT"; then
            go_note="$go_note; GOTOOLCHAIN fetches it ($go_found on PATH)"
            go_found="$go_effective"
        fi
    fi
    if [ -z "$go_found" ]; then
        row fail go "Go" "unreadable" "$GO_WANT" \
            "\`go env GOVERSION\` printed nothing" "check your Go installation"
    elif version_ge "$go_found" "$GO_WANT"; then
        row pass go "Go" "$go_found" "$GO_WANT" "$go_note"
    else
        row fail go "Go" "$go_found" "$GO_WANT" \
            "older than api/go.mod requires and GOTOOLCHAIN did not supply it" \
            "upgrade Go, or set GOTOOLCHAIN=auto and allow the download"
    fi
fi

# ── Node and npm ─────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
    row fail node "Node" "not installed" "$NODE_WANT" \
        "the CSS and JS bundles are built with it" \
        "install Node $NODE_WANT — https://nodejs.org/"
else
    node_found="$(node -v 2>/dev/null)"; node_found="${node_found#v}"
    if version_ge "$node_found" "$NODE_WANT"; then
        row pass node "Node" "$node_found" "$NODE_WANT" "CI builds on Node $NODE_WANT"
    else
        row fail node "Node" "$node_found" "$NODE_WANT" \
            "older than the Node CI builds on" "install Node $NODE_WANT or newer"
    fi
fi

if command -v npm >/dev/null 2>&1; then
    row pass npm "npm" "$(npm -v 2>/dev/null)" "" "installs the build-time dependencies"
else
    row fail npm "npm" "not installed" "" \
        "no way to install esbuild and eslint" "it ships with Node — reinstall Node"
fi

# ── JS dependencies ──────────────────────────────────────────────────────────
# run.sh installs these itself when esbuild is missing, and check.sh when
# eslint is; a warning here only tells you the first build will be slower.
missing_dep=""
for dep in esbuild eslint; do
    [ -x "$ROOT_DIR/node_modules/.bin/$dep" ] || missing_dep="${missing_dep:+$missing_dep, }$dep"
done
if [ -z "$missing_dep" ]; then
    row pass npm-deps "JS deps" "installed" "" "node_modules/ has esbuild and eslint"
else
    row warn npm-deps "JS deps" "missing" "" \
        "$missing_dep not in node_modules/ — run.sh and check.sh install them on demand" \
        "npm ci"
fi

# ── golangci-lint ────────────────────────────────────────────────────────────
# Any mismatch is a warning in both directions: a different linter release
# reports a different set of problems, so a newer one locally still means your
# green run and CI's disagree.
if ! command -v golangci-lint >/dev/null 2>&1; then
    row warn golangci-lint "golangci-lint" "not installed" "$LINT_WANT" \
        "./scripts/check.sh cannot lint Go without it" \
        "go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v$LINT_WANT"
else
    lint_found="$(golangci-lint version 2>&1 | sed -n 's/.*has version v\{0,1\}\([0-9][0-9.]*\).*/\1/p' | head -1)"
    if [ -z "$lint_found" ]; then
        row warn golangci-lint "golangci-lint" "unknown" "$LINT_WANT" \
            "installed, but its version line did not parse"
    elif [ "$lint_found" = "$LINT_WANT" ]; then
        row pass golangci-lint "golangci-lint" "$lint_found" "$LINT_WANT" "matches the CI pin"
    else
        row warn golangci-lint "golangci-lint" "$lint_found" "$LINT_WANT" \
            "CI pins $LINT_WANT — local lint results will differ" \
            "go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@v$LINT_WANT"
    fi
fi

# ── govulncheck ──────────────────────────────────────────────────────────────
# Unlike the linter, newer is fine here: a later scanner knows about strictly
# more vulnerabilities, so it cannot pass something CI would catch.
if ! command -v govulncheck >/dev/null 2>&1; then
    row warn govulncheck "govulncheck" "not installed" "$VULN_WANT" \
        "./scripts/check.sh cannot run its vulnerability scan" \
        "go install golang.org/x/vuln/cmd/govulncheck@v$VULN_WANT"
else
    vuln_found="$(govulncheck -version 2>&1 | sed -n 's|.*govulncheck@v\([0-9][0-9.]*\).*|\1|p' | head -1)"
    if [ -z "$vuln_found" ]; then
        row warn govulncheck "govulncheck" "unknown" "$VULN_WANT" \
            "installed, but its version line did not parse"
    elif version_ge "$vuln_found" "$VULN_WANT"; then
        row pass govulncheck "govulncheck" "$vuln_found" "$VULN_WANT" "CI pins $VULN_WANT"
    else
        row warn govulncheck "govulncheck" "$vuln_found" "$VULN_WANT" \
            "older than the CI pin — it knows about fewer advisories" \
            "go install golang.org/x/vuln/cmd/govulncheck@v$VULN_WANT"
    fi
fi

# ── sqlc ─────────────────────────────────────────────────────────────────────
# Deliberately optional: the generated code is committed, so sqlc is only
# needed by a change to api/sql/. AGENTS.md says the same.
if command -v sqlc >/dev/null 2>&1; then
    sqlc_found="$(sqlc version 2>/dev/null | head -1)"; sqlc_found="${sqlc_found#v}"
    row pass sqlc "sqlc" "${sqlc_found:-installed}" "" "\`cd api && sqlc generate\` is available"
else
    row warn sqlc "sqlc" "not installed" "" \
        "optional — only a change to api/sql/ needs it" \
        "go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest"
fi

# ── Port 8001 ────────────────────────────────────────────────────────────────
# Bash's /dev/tcp, so this needs no ss/lsof/netstat and behaves the same on
# every platform that can run this script.
if (exec 3<>/dev/tcp/127.0.0.1/8001) 2>/dev/null; then
    row warn port "Port 8001" "in use" "" \
        "something already listens there — ./scripts/run.sh will fail to bind" \
        "stop it, or find it with: ss -ltnp 'sport = :8001'"
else
    row pass port "Port 8001" "free" "" "./scripts/run.sh can bind it"
fi

# ── data/ ────────────────────────────────────────────────────────────────────
if [ -e "$ROOT_DIR/data" ]; then
    if [ ! -d "$ROOT_DIR/data" ]; then
        row fail data "data/" "not a directory" "" \
            "a file is sitting where the database and media go" "remove or rename $ROOT_DIR/data"
    elif [ -w "$ROOT_DIR/data" ]; then
        row pass data "data/" "writable" "" "holds the SQLite database and uploaded media"
    else
        row fail data "data/" "not writable" "" \
            "the server cannot open its database" "chmod u+w $ROOT_DIR/data"
    fi
elif [ -w "$ROOT_DIR" ]; then
    row pass data "data/" "will be created" "" "./scripts/run.sh creates it on first start"
else
    row fail data "data/" "cannot be created" "" \
        "the repository root is not writable" "chmod u+w $ROOT_DIR"
fi

# ── Report ───────────────────────────────────────────────────────────────────
json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\t'/\\t}"
    s="${s//$'\n'/\\n}"
    printf '%s' "$s"
}

# A string field, or null when the check had nothing to say.
json_field() {
    if [ -z "$2" ]; then printf '"%s": null' "$1"
    else printf '"%s": "%s"' "$1" "$(json_escape "$2")"; fi
}

if [ "$JSON" = 1 ]; then
    printf '{\n'
    printf '  "ok": %s,\n' "$([ "$N_FAIL" -eq 0 ] && echo true || echo false)"
    printf '  "summary": { "pass": %d, "warn": %d, "fail": %d },\n' "$N_PASS" "$N_WARN" "$N_FAIL"
    printf '  "checks": [\n'
    for i in "${!ROWS[@]}"; do
        IFS="$SEP" read -r status id label found want note fix <<<"${ROWS[$i]}"
        printf '    { "id": "%s", "label": "%s", "status": "%s", ' \
            "$(json_escape "$id")" "$(json_escape "$label")" "$status"
        json_field found "$found"; printf ', '
        json_field want "$want";   printf ', '
        json_field note "$note";   printf ', '
        json_field fix "$fix"
        printf ' }%s\n' "$([ "$i" -lt $((${#ROWS[@]} - 1)) ] && echo ,)"
    done
    printf '  ]\n}\n'
else
    echo ""
    echo "Point environment doctor"
    echo ""
    for r in "${ROWS[@]}"; do
        IFS="$SEP" read -r status id label found want note fix <<<"$r"
        case "$status" in
            pass) tag="${C_PASS}PASS${C_OFF}" ;;
            warn) tag="${C_WARN}WARN${C_OFF}" ;;
            *)    tag="${C_FAIL}FAIL${C_OFF}" ;;
        esac
        printf '  %b  %-15s %-16s %s%s%s\n' "$tag" "$label" "$found" "$C_DIM" "$note" "$C_OFF"
        [ -n "$fix" ] && [ "$status" != pass ] && printf '        %-15s %s→ %s%s\n' "" "$C_DIM" "$fix" "$C_OFF"
    done
    echo ""
    echo "════════════════════════════════════════"
    printf '  %d pass, %d warn, %d fail\n' "$N_PASS" "$N_WARN" "$N_FAIL"
    if [ "$N_FAIL" -gt 0 ]; then
        echo "  This machine cannot build Point yet — fix the FAIL rows above."
    elif [ "$N_WARN" -gt 0 ]; then
        echo "  This machine can build and run Point; the WARN rows limit what you can verify."
    else
        echo "  Ready: build, run and ./scripts/check.sh will all work here."
    fi
    echo "════════════════════════════════════════"
fi

[ "$N_FAIL" -eq 0 ]
