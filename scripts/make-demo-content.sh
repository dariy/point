#!/bin/bash
# Builds the demo fixture bundle from scratch: synthetic content in,
# frontend/src/mock/fixtures/fixtures.json out.
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
#   GEMINI_API_KEY=... scripts/make-demo-content.sh [--count=28] [--port=8002]
#
# Then:  scripts/build-demo.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

COUNT=28
PORT=8002
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --count=*) COUNT="${arg#*=}" ;;
    --port=*) PORT="${arg#*=}" ;;
    # Leaves the scratch instance running so it can be inspected in a browser.
    --keep) KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set." >&2
  echo "Point stores one in blog_secrets; export it, or pass your own." >&2
  exit 1
fi

SCRATCH="${DEMO_SCRATCH:-$ROOT_DIR/.demo-scratch}"
BASE="http://127.0.0.1:$PORT"

cleanup() {
  if [ -n "${SERVER_PID:-}" ] && [ "$KEEP" = "0" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── Binary ────────────────────────────────────────────────────────────────

echo "==> Building point binary"
(cd api && go build -ldflags="-X main.Version=demo" -o ../point ./cmd/api)

# ── Scratch instance ──────────────────────────────────────────────────────

echo "==> Preparing scratch instance at $SCRATCH"
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH"/{media/originals,media/thumbnails,logs,backups,themes}

# `point setup` takes the client-side SHA-256 of the password, which is what the
# login form sends — not the plaintext.
PW_HASH=$(printf 'demo' | sha256sum | cut -d' ' -f1)

DATABASE_URL="$SCRATCH/point.db" STORAGE_PATH="$SCRATCH" FRONTEND_DIR=frontend \
  ./point setup --title="Point Demo" --user=demo \
    --email=demo@example.com --password="$PW_HASH" >/dev/null

echo "==> Starting scratch instance on :$PORT"
DATABASE_URL="$SCRATCH/point.db" STORAGE_PATH="$SCRATCH" FRONTEND_DIR=frontend \
  PORT="$PORT" HOST=127.0.0.1 APP_VERSION=demo \
  GEMINI_API_KEY="$GEMINI_API_KEY" ENABLE_REMARK42=false \
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

# ── Generate ──────────────────────────────────────────────────────────────

echo "==> Generating $COUNT posts"
node "$SCRIPT_DIR/generate-demo-content.mjs" \
  --base="$BASE" \
  --session="$SESSION" \
  --db="$SCRATCH/point.db" \
  --gemini-key="$GEMINI_API_KEY" \
  --count="$COUNT"

# ── Record ────────────────────────────────────────────────────────────────

echo "==> Recording fixtures"
node "$SCRIPT_DIR/record-demo-fixtures.mjs" \
  --base="$BASE" \
  --session="$SESSION"

echo
echo "==> Done. Next: scripts/build-demo.sh"
if [ "$KEEP" = "1" ]; then
  echo "    Scratch instance left running at $BASE (pid $SERVER_PID)"
  echo "    Log in with password: demo"
fi
