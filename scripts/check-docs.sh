#!/bin/bash
# Run every command this repository documents, so the instructions cannot rot
# silently. Extracts the shell commands from the docs below and executes them:
#
#   * fenced ```bash / ```sh blocks — the whole block runs as one script, which
#     is how a reader copies it;
#   * the Command column of the table under `## Commands` in AGENTS.md.
#
# A command that cannot run unattended is marked in the source doc, not
# special-cased here. Put the directive on the line before the fence (or
# anywhere in the table row):
#
#   <!-- verify:skip reason the command cannot run here -->
#   <!-- verify:tmpdir -->    run the block in an empty scratch directory
#
# Skipped commands are not entirely unchecked: if the first word is a path in
# this repo, it still has to exist and be executable.
#
# Usage: ./scripts/check-docs.sh [--list] [doc.md ...]
#   --list   print what would run, and run nothing
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMEOUT="${DOC_CMD_TIMEOUT:-600}"

LIST=0
DOCS=()
for arg in "$@"; do
    case "$arg" in
        --list) LIST=1 ;;
        -*) echo "unknown option: $arg" >&2; exit 2 ;;
        *) DOCS+=("$arg") ;;
    esac
done
[ ${#DOCS[@]} -gt 0 ] || DOCS=(AGENTS.md CONTRIBUTING.md QUICKSTART.md ai-declaration.md)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Extract ───────────────────────────────────────────────────────────────────
# Writes one script per runnable command to $WORK/<id>.sh and prints a
# tab-separated plan: KIND, doc, line, id, mode|first word, label|reason.
for doc in "${DOCS[@]}"; do
    [ -f "$ROOT_DIR/$doc" ] || { echo "no such doc: $doc" >&2; exit 2; }
    awk -v work="$WORK" -v doc="$doc" '
        function reason_of(s,   r) {
            r = s
            sub(/^.*verify:skip[ \t]*/, "", r)
            sub(/[ \t]*-->.*$/, "", r)
            return (r == "" ? "no reason given" : r)
        }
        function first_word(s,   w) {
            w = s
            sub(/^[ \t]*/, "", w)
            sub(/[ \t].*$/, "", w)
            return w
        }
        function emit_run(body, line, mode, label,   id) {
            id = doc "-" line
            gsub(/\//, "_", id)
            printf "%s", body > (work "/" id ".sh")
            close(work "/" id ".sh")
            print "RUN\t" doc "\t" line "\t" id "\t" mode "\t" label
        }
        function emit_skip(cmd, line, reason) {
            print "SKIP\t" doc "\t" line "\t-\t" first_word(cmd) "\t" reason
        }

        # Directive on its own line: applies to the next fenced block.
        !in_block && /^[ \t]*<!--[ \t]*verify:/ {
            if ($0 ~ /verify:skip/)   { pend_skip = 1; pend_reason = reason_of($0) }
            if ($0 ~ /verify:tmpdir/) { pend_tmpdir = 1 }
            next
        }

        !in_block && /^##[ \t]/ { section = $2; next }

        !in_block && /^[ \t]*```(bash|sh)[ \t]*$/ {
            in_block = 1
            indent = match($0, /[^ \t]/) - 1
            start = FNR
            body = ""
            blk_skip = pend_skip; blk_reason = pend_reason; blk_tmpdir = pend_tmpdir
            pend_skip = 0; pend_reason = ""; pend_tmpdir = 0
            next
        }
        in_block && /^[ \t]*```[ \t]*$/ {
            in_block = 0
            if (blk_skip) emit_skip(body, start, blk_reason)
            else          emit_run(body, start, blk_tmpdir ? "tmpdir" : "repo", "fenced block")
            next
        }
        in_block { body = body substr($0, indent + 1) "\n"; next }

        # The Commands table: first inline code span of the Command column.
        section == "Commands" && /^\|/ {
            n = split($0, cells, "|")
            if (n < 3) next
            if (cells[2] ~ /^[ \t]*[-:]+[ \t]*$/) next            # separator row
            if (match(cells[3], /`[^`]+`/) == 0) next             # header row
            cmd = substr(cells[3], RSTART + 1, RLENGTH - 2)
            label = cells[2]
            gsub(/^[ \t]+|[ \t]+$/, "", label)
            if ($0 ~ /verify:skip/) emit_skip(cmd, FNR, reason_of($0))
            else                    emit_run(cmd "\n", FNR, "repo", label)
        }
    ' "$ROOT_DIR/$doc"
done > "$WORK/plan"

# ── Run ───────────────────────────────────────────────────────────────────────
PASS=(); FAIL=(); SKIP=()

while IFS=$'\t' read -r kind doc line id mode label; do
    where="$doc:$line"
    if [ "$kind" = "SKIP" ]; then
        SKIP+=("$where  $mode — $label")
        # `mode` holds the first word for a skipped command. A path into the
        # repo is still checked: a renamed script must not hide behind a skip.
        case "$mode" in
            ./*)
                if [ ! -x "$ROOT_DIR/${mode#./}" ]; then
                    echo "==> $where  SKIPPED, but $mode is missing or not executable"
                    FAIL+=("$where  $mode does not exist")
                fi
                ;;
        esac
        continue
    fi

    echo ""
    echo "==> $where  ($label)"
    sed 's/^/    /' "$WORK/$id.sh"
    [ "$LIST" = "1" ] && continue

    if [ "$mode" = "tmpdir" ]; then rundir="$(mktemp -d)"; else rundir="$ROOT_DIR"; fi
    # </dev/null: the plan is this loop's stdin, and a documented command that
    # reads stdin would otherwise swallow the rest of it.
    if (cd "$rundir" && timeout "$TIMEOUT" bash -euo pipefail "$WORK/$id.sh" </dev/null); then
        PASS+=("$where  $label")
    else
        status=$?
        [ "$status" = "124" ] && echo "    timed out after ${TIMEOUT}s"
        FAIL+=("$where  $label")
    fi
    [ "$mode" = "tmpdir" ] && rm -rf "$rundir"
done < "$WORK/plan"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
for s in "${SKIP[@]}"; do echo "  SKIP  $s"; done
for s in "${PASS[@]}"; do echo "  PASS  $s"; done
for s in "${FAIL[@]}"; do echo "  FAIL  $s"; done
echo "════════════════════════════════════════"

if [ ${#FAIL[@]} -gt 0 ]; then
    echo "  ${#FAIL[@]} documented command(s) failed."
    exit 1
fi
if [ "$LIST" = "1" ]; then
    echo "  ${#SKIP[@]} skipped. Nothing was run (--list)."
else
    echo "  ${#PASS[@]} documented command(s) ran, ${#SKIP[@]} skipped."
fi
