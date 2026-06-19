#!/usr/bin/env bash
# Boot the app against the stress DB and time the key public endpoints.
# Usage: stress-http.sh [label]
set -uo pipefail
cd "$(dirname "$0")/.."
LABEL=${1:-baseline}
export DATABASE_URL=/mnt/lab_storage/point-data/point-stress.db
export STORAGE_PATH=/mnt/lab_storage/point-data
export FRONTEND_DIR=frontend PORT=8011 HOST=127.0.0.1 APP_VERSION=stress
./point > /tmp/stress-app.log 2>&1 &
APP=$!
trap 'kill -9 $APP 2>/dev/null' EXIT
for i in $(seq 1 40); do ss -ltn 2>/dev/null | grep -q ':8011' && break; kill -0 $APP 2>/dev/null || { echo "app died"; cat /tmp/stress-app.log; exit 1; }; sleep 1; done

HOTSLUG=$(sqlite3 "$DATABASE_URL" "SELECT slug FROM tags ORDER BY post_count DESC LIMIT 1;")
echo "############ HTTP ($LABEL) ############"
hit() { # name url
  local out; out=$(curl -s -o /tmp/_body -w '%{time_total}s  %{size_download} bytes  http=%{http_code}' "http://127.0.0.1:8011$2")
  printf "  %-28s %s\n" "$1" "$out"
}
echo "-- cold (first hit, builds tag snapshot) --"
hit "atlas /api/pages/graph" "/api/pages/graph"
echo "-- warm (snapshot cached) --"
hit "atlas /api/pages/graph" "/api/pages/graph"
hit "homepage /api/pages/home" "/api/pages/home"
hit "hot tag /api/pages/tags/$HOTSLUG" "/api/pages/tags/$HOTSLUG"
echo "########################################"
