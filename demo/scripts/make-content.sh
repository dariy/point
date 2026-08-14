#!/bin/bash
# Builds the demo fixture bundle from scratch: synthetic content in,
# demo/mock/fixtures/fixtures.json out.
#
# Runs a THROWAWAY Point instance on its own database and storage directory,
# fills it with generated content, records the API responses, and tears it down.
# Nothing touches your real instance or its data.
#
# Content is generated rather than copied: photos come from picsum.photos and
# the text is written by Gemini from each image, so the demo can be published
# without deciding whether to publish anybody's real blog.
#
# Usage:
#   GEMINI_API_KEY=... demo/scripts/make-content.sh [--count=28] [--port=8002]
#   GEMINI_API_KEY=... demo/scripts/make-content.sh --add=20
#
# --add grows the archive instead of replacing it. The scratch instance is
# rebuilt from the recorded fixtures first (import-fixtures.mjs) when it is
# missing, so the posts already in demo/mock/fixtures/fixtures.json come back
# with their own photographs and prose, and only the new ones are generated.
# That is what makes the scratch directory disposable: the fixture bundle plus
# the originals is the archive, and the database is a working copy of it.
#
# Then:  demo/scripts/build.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEMO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DEMO_DIR/.." && pwd)"
cd "$ROOT_DIR"

COUNT=28
PORT=8002
KEEP=0
RETAG=0
ADD=0
MEDIA_SRC_DEFAULT=""
for arg in "$@"; do
  case "$arg" in
    --count=*) COUNT="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    # Leaves the scratch instance running so it can be inspected in a browser.
    --keep) KEEP=1 ;;
    # Reuse the existing scratch instance: restructure its tags and re-record,
    # generating nothing. No Gemini key, no new photographs, same prose.
    --retag) RETAG=1 ;;
    # Append N posts to the archive already in the fixtures, leaving every
    # existing post exactly as it was recorded.
    --add=*) ADD="${arg#*=}" ;;
    # Where import-fixtures.mjs reads the recorded photographs from. Defaults to
    # the scratch instance's own originals, which survive its database.
    --media=*) MEDIA_SRC_DEFAULT="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ "$RETAG" = "1" ] && [ "$ADD" != "0" ]; then
  echo "--retag and --add do different things to the same instance; pick one." >&2
  exit 1
fi

if [ "$RETAG" = "0" ] && [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set." >&2
  echo "Point stores one in blog_secrets; export it, or pass your own." >&2
  exit 1
fi

SCRATCH="${DEMO_SCRATCH:-$DEMO_DIR/.scratch}"
BASE="http://127.0.0.1:$PORT"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && [ "$KEEP" = "0" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "${STAGED_MEDIA:-}" ]; then rm -rf "$STAGED_MEDIA"; fi
}
trap cleanup EXIT INT TERM

# ── Binary ────────────────────────────────────────────────────────────────

echo "==> Building point binary"
(cd api && go build -ldflags="-X main.Version=demo" -o ../point ./cmd/api)

# ── Scratch instance ──────────────────────────────────────────────────────

IMPORT=0

if [ "$RETAG" = "1" ]; then
  if [ ! -f "$SCRATCH/point.db" ]; then
    echo "--retag needs an existing scratch instance at $SCRATCH." >&2
    echo "Run without --retag first (needs GEMINI_API_KEY)." >&2
    exit 1
  fi
  echo "==> Reusing scratch instance at $SCRATCH"
elif [ "$ADD" != "0" ] && [ -f "$SCRATCH/point.db" ]; then
  echo "==> Reusing scratch instance at $SCRATCH ($ADD post(s) to add)"
else
  # Adding to an archive whose database is gone: rebuild it from the recording.
  # The photographs are not in the fixture — it holds paths, not pixels — so the
  # originals have to survive the wipe below, which is what the staging copy is
  # for. Without them the import would restore 28 posts with no images.
  if [ "$ADD" != "0" ]; then
    MEDIA_SRC="${MEDIA_SRC_DEFAULT:-$SCRATCH/media/originals}"
    if [ ! -d "$MEDIA_SRC" ]; then
      echo "--add needs the recorded photographs, but $MEDIA_SRC does not exist." >&2
      echo "Pass --media=/path/to/originals, or run without --add to regenerate." >&2
      exit 1
    fi
    STAGED_MEDIA="$(mktemp -d)"
    cp -a "$MEDIA_SRC/." "$STAGED_MEDIA/"
    echo "==> Staged $(find "$STAGED_MEDIA" -type f | wc -l | tr -d ' ') original(s) from $MEDIA_SRC"
    IMPORT=1
  fi

  echo "==> Preparing scratch instance at $SCRATCH"
  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH"/{media/originals,media/thumbnails,logs,backups,themes}

  # `point setup` takes the client-side SHA-256 of the password, which is what
  # the login form sends — not the plaintext.
  PW_HASH=$(printf 'demo' | sha256sum | cut -d' ' -f1)

  DATABASE_URL="$SCRATCH/point.db" STORAGE_PATH="$SCRATCH" FRONTEND_DIR=frontend \
    ./point setup --title="Point Demo" --user=demo \
      --email=demo@example.com --password="$PW_HASH" >/dev/null
fi

echo "==> Starting scratch instance on :$PORT"
DATABASE_URL="$SCRATCH/point.db" STORAGE_PATH="$SCRATCH" FRONTEND_DIR=frontend \
  PORT="$PORT" HOST=127.0.0.1 APP_VERSION=demo \
  GEMINI_API_KEY="${GEMINI_API_KEY:-}" ENABLE_REMARK42=false \
  ./point > "$SCRATCH/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -sf -o /dev/null --max-time 2 "$BASE/health"; then break; fi
  sleep 1
done
if ! curl -sf -o /dev/null --max-time 2 "$BASE/health"; then
  echo "scratch instance did not come up; see $SCRATCH/server.log" >&2
  tail -20 "$SCRATCH/server.log" >&2
  exit 1
fi

# A session is minted directly rather than by logging in, so the generator never
# needs the password on a command line.
SESSION=$(python3 - "$SCRATCH/point.db" <<'PY'
import sqlite3, hashlib, secrets, sys, datetime
token = secrets.token_hex(32)
now = datetime.datetime.now(datetime.UTC)
db = sqlite3.connect(sys.argv[1], timeout=10)
db.execute(
    "insert into sessions (user_id, token, ip_address, user_agent,"
    " created_at, expires_at, last_activity) values (1,?,?,?,?,?,?)",
    (hashlib.sha256(token.encode()).hexdigest(), "127.0.0.1", "demo-generator",
     now.isoformat(sep=" "),
     (now + datetime.timedelta(hours=12)).isoformat(sep=" "),
     now.isoformat(sep=" ")),
)
db.commit()
print(token)
PY
)

# ── Restore ───────────────────────────────────────────────────────────────

if [ "$IMPORT" = "1" ]; then
  echo "==> Restoring the recorded archive"
  node "$SCRIPT_DIR/import-fixtures.mjs" \
    --base="$BASE" \
    --session="$SESSION" \
    --db="$SCRATCH/point.db" \
    --media="$STAGED_MEDIA"
fi

# ── Generate ──────────────────────────────────────────────────────────────

if [ "$RETAG" = "1" ]; then
  echo "==> Restructuring tags"
  node "$SCRIPT_DIR/retag-content.mjs" \
    --base="$BASE" \
    --session="$SESSION" \
    --db="$SCRATCH/point.db"
elif [ "$ADD" != "0" ]; then
  echo "==> Adding $ADD posts"
  node "$SCRIPT_DIR/generate-content.mjs" \
    --base="$BASE" \
    --session="$SESSION" \
    --db="$SCRATCH/point.db" \
    --gemini-key="$GEMINI_API_KEY" \
    --add="$ADD"
else
  echo "==> Generating $COUNT posts"
  node "$SCRIPT_DIR/generate-content.mjs" \
    --base="$BASE" \
    --session="$SESSION" \
    --db="$SCRATCH/point.db" \
    --gemini-key="$GEMINI_API_KEY" \
    --count="$COUNT"
fi

# ── Record ────────────────────────────────────────────────────────────────

echo "==> Recording fixtures"
node "$SCRIPT_DIR/record-fixtures.mjs" \
  --base="$BASE" \
  --session="$SESSION"

echo
echo "==> Done. Next: demo/scripts/build.sh"
if [ "$KEEP" = "1" ]; then
  echo "    Scratch instance left running at $BASE (pid $SERVER_PID)"
  echo "    Log in with password: demo"
fi
