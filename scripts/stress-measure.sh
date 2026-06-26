#!/usr/bin/env bash
# Stress-test measurement harness. Runs EXPLAIN QUERY PLAN + timed execution for
# the heavy queries against the stress DB. Usage: stress-measure.sh [label]
set -euo pipefail
DB=${DB:-/mnt/lab_storage/point-data/point-stress.db}
LABEL=${1:-baseline}
HOT=$(sqlite3 "$DB" "SELECT id FROM tags ORDER BY post_count DESC LIMIT 1;")
HOTCNT=$(sqlite3 "$DB" "SELECT post_count FROM tags ORDER BY post_count DESC LIMIT 1;")

echo "############################################################"
echo "# label=$LABEL  hot_tag=$HOT (post_count=$HOTCNT)"
echo "# perf indexes present on post_tags / tag_relationships:"
sqlite3 "$DB" "SELECT '  '||name FROM sqlite_master WHERE type='index' AND tbl_name IN ('post_tags','tag_relationships');"
echo "############################################################"

# 1. Hierarchical post counts (atlas snapshot builds this twice per request)
HPC="WITH RECURSIVE ehp(id) AS (SELECT id FROM tags WHERE hides_posts=1 UNION SELECT tr.child_id FROM tag_relationships tr JOIN ehp ON tr.parent_id=ehp.id),
descendants(root_id,tag_id) AS (SELECT id,id FROM tags UNION SELECT d.root_id,tr.child_id FROM descendants d JOIN tag_relationships tr ON d.tag_id=tr.parent_id)
SELECT d.root_id, COUNT(DISTINCT pt.post_id) FROM descendants d JOIN post_tags pt ON pt.tag_id=d.tag_id JOIN posts p ON pt.post_id=p.id
WHERE p.deleted_at IS NULL AND LOWER(p.status)='published' GROUP BY d.root_id;"
# 2. Graph post nodes (loads full content for every published post)
GRAPH="SELECT id, slug, title, thumbnail_path, content FROM posts WHERE LOWER(status)='published' AND deleted_at IS NULL ORDER BY published_at DESC, created_at DESC;"
# 3. Hot-tag listing page (first page)
BYTAG="SELECT p.id,p.title,p.slug FROM posts p WHERE p.deleted_at IS NULL AND p.id IN (SELECT DISTINCT post_id FROM post_tags WHERE tag_id IN ($HOT)) AND LOWER(p.status)='published' ORDER BY p.published_at DESC, p.created_at DESC LIMIT 20 OFFSET 0;"
# 4. Homepage feed
FEED="SELECT p.id,p.title,p.slug FROM posts p WHERE LOWER(p.status)='published' AND p.deleted_at IS NULL AND p.type!='page' ORDER BY p.published_at DESC, p.created_at DESC LIMIT 20;"

plan() { echo; echo "===== $1 ====="; echo "--- EXPLAIN QUERY PLAN ---"; sqlite3 "$DB" "EXPLAIN QUERY PLAN $2"; }
timeit() { # wall-clock of executing the query (rows discarded)
  local q="$1" t0 t1
  t0=$(date +%s.%N)
  sqlite3 "$DB" "$q" >/dev/null
  t1=$(date +%s.%N)
  awk -v a="$t0" -v b="$t1" 'BEGIN{printf "--- wall: %.3f s\n", b-a}'
}

plan "1. GetHierarchicalPostCounts" "$HPC"; timeit "$HPC"
plan "2. ListPostNodesForGraph (full content)" "$GRAPH"
echo "--- payload size ---"; sqlite3 "$DB" "$GRAPH" | wc -c | awk '{printf "  ~%.1f MB\n",$1/1048576}'; timeit "$GRAPH"
plan "3. GetPostsByTagIDs (hot tag $HOT)" "$BYTAG"; timeit "$BYTAG"
plan "4. GetPublishedPostsForFeed (homepage)" "$FEED"; timeit "$FEED"
echo; echo "# done ($LABEL)"
