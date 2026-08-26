#!/bin/sh
# Guards the boundary between the sqlc-generated SQL layer and the hand-written
# repository. Two failure modes, neither of which any compiler or linter sees:
#
#   1. Shadowing. sqliteRepository embeds *models.Queries, so every generated
#      method is promoted onto the repository. A hand-written method of the same
#      name silently wins — the generated one compiles, passes review, and never
#      runs. ListPosts, ListPostsByViews, CountPosts and DeleteSession were
#      shadowed this way; the only test ListPostsByViews had was testing the
#      dead copy.
#
#   2. Stale generated code. api/internal/models is committed, and nothing in
#      the build reads api/sql/queries.sql — so SQL edited without a successful
#      `sqlc generate` leaves a tree that compiles and passes every test while
#      running SQL that no longer matches the file describing it. That is how
#      posts.media_url ended up scanned by the hand-written queries and absent
#      from every generated one. A failed regeneration looks the same from the
#      outside: sqlc writes nothing, and a single non-ASCII character in
#      queries.sql is enough to cause it (it throws off the byte offsets sqlc
#      uses to expand `SELECT *`).
#
# Usage: scripts/check-sql-layer.sh
# sqlc is optional tooling, so check 2 is skipped (loudly) when it is absent.
# CI installs it, which is what makes the skip safe.

set -eu

# comm compares byte-wise; sort must agree or it rejects its own input as unsorted.
export LC_ALL=C

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

MODELS_DIR="$ROOT_DIR/api/internal/models"
REPO_DIR="$ROOT_DIR/api/internal/repository"

status=0

# ── 1. Method-set overlap ────────────────────────────────────────────────────
# Receiver names are fixed by the code being matched: sqlc always emits
# `func (q *Queries)`, and the repository consistently uses `(r *sqliteRepository)`.
generated=$(mktemp)
handwritten=$(mktemp)
trap 'rm -f "$generated" "$handwritten"' EXIT

grep -ho '^func (q \*Queries) [A-Za-z0-9_]*(' "$MODELS_DIR"/*.go 2>/dev/null |
    sed 's/^func (q \*Queries) //; s/($//; s/(//' | sort -u > "$generated"

grep -ho '^func (r \*sqliteRepository) [A-Za-z0-9_]*(' "$REPO_DIR"/*.go 2>/dev/null |
    sed 's/^func (r \*sqliteRepository) //; s/($//; s/(//' | sort -u > "$handwritten"

if [ ! -s "$generated" ]; then
    echo "check-sql-layer: found no methods on *Queries in $MODELS_DIR" >&2
    echo "  The grep pattern no longer matches sqlc's output — fix this script." >&2
    exit 2
fi
if [ ! -s "$handwritten" ]; then
    echo "check-sql-layer: found no methods on *sqliteRepository in $REPO_DIR" >&2
    echo "  The grep pattern no longer matches the repository — fix this script." >&2
    exit 2
fi

overlap=$(comm -12 "$generated" "$handwritten")
if [ -n "$overlap" ]; then
    echo "check-sql-layer: FAIL — these names are defined on both *models.Queries and *sqliteRepository:" >&2
    echo "$overlap" | sed 's/^/    /' >&2
    cat >&2 <<'MSG'

  Go promotes the embedded *models.Queries methods onto sqliteRepository, and a
  concrete method beats a promoted one — so the generated version never runs.
  Nothing else will tell you: the call site reads r.Name(...) either way.

  Fix it by giving the query one owner:
    - the repository needs dynamic SQL sqlc cannot express -> delete the query
      from api/sql/queries.sql, regenerate, and declare the method on the
      Repository interface in api/internal/repository/db.go; or
    - sqlc is enough -> delete the hand-written method.
MSG
    status=1
else
    echo "check-sql-layer: no method-set overlap ($(wc -l < "$generated" | tr -d ' ') generated, $(wc -l < "$handwritten" | tr -d ' ') hand-written)"
fi

# ── 2. Generated code matches the SQL ────────────────────────────────────────
if ! command -v sqlc >/dev/null 2>&1; then
    echo "check-sql-layer: sqlc not installed — skipping the regeneration check."
    echo "  Install it with: go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest"
    exit "$status"
fi

snapshot=$(mktemp -d)
sqlc_log=$(mktemp)
# shellcheck disable=SC2064  # expand now, not at trap time
trap "rm -rf '$snapshot'; rm -f '$generated' '$handwritten' '$sqlc_log'" EXIT

# The files sqlc writes. extra.go and the tests share the directory and are
# hand-written, so the check snapshots these four by name rather than diffing
# the package — and restores them afterwards, leaving the tree as it found it.
GENERATED_FILES="db.go models.go querier.go queries.sql.go"

for f in $GENERATED_FILES; do
    if [ ! -f "$MODELS_DIR/$f" ]; then
        echo "check-sql-layer: expected generated file $MODELS_DIR/$f is missing" >&2
        exit 2
    fi
    cp "$MODELS_DIR/$f" "$snapshot/$f"
done

if ! (cd "$ROOT_DIR/api" && sqlc generate) > "$sqlc_log" 2>&1; then
    echo "check-sql-layer: FAIL - sqlc generate errored:" >&2
    sed 's/^/    /' "$sqlc_log" >&2
    echo "  A non-ASCII character anywhere in api/sql/queries.sql will do this." >&2
    for f in $GENERATED_FILES; do cp "$snapshot/$f" "$MODELS_DIR/$f"; done
    exit 1
fi

# Belt and braces: treat any diagnostic as failure, even one sqlc chose to
# survive. A warning here means it did not generate what the SQL says.
if [ -s "$sqlc_log" ]; then
    echo "check-sql-layer: FAIL - sqlc generate printed diagnostics:" >&2
    sed 's/^/    /' "$sqlc_log" >&2
    for f in $GENERATED_FILES; do cp "$snapshot/$f" "$MODELS_DIR/$f"; done
    exit 1
fi

drifted=""
for f in $GENERATED_FILES; do
    if ! cmp -s "$snapshot/$f" "$MODELS_DIR/$f"; then
        drifted="$drifted $f"
    fi
    cp "$snapshot/$f" "$MODELS_DIR/$f"
done

if [ -n "$drifted" ]; then
    echo "check-sql-layer: FAIL - committed sqlc output does not match api/sql/:" >&2
    for f in $drifted; do echo "    internal/models/$f" >&2; done
    echo "  Run 'cd api && sqlc generate' and commit the result." >&2
    exit 1
fi

echo "check-sql-layer: generated models match api/sql/queries.sql"

exit "$status"
