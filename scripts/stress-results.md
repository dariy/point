# Stress-test results — bottleneck diagnosis

Dataset (synthetic, `point-stress.db`): **100,000 posts · 1,000,000 media · 10,600 tags
(10k plain in a 3-level hierarchy, 100 year, 500 geo) · 2,000,000 post_tags · 9,900
hierarchy edges**. Zipf tag skew: hot tag = 95,869 posts; 222 tags >1000; full coverage.
Image bank: 13,400 hardlinks to one JPEG (≈0 real bytes). DB ≈706 MB (+20 MB indexes).

App uses **`modernc.org/sqlite` (pure-Go)**, which is ~2× slower than the `sqlite3` C CLI
for CPU-bound recursive/aggregate queries — so CLI timings *understate* real latency.
HTTP timings below are the source of truth.

## Headline findings

1. **Atlas was a hard failure, not just slow.** `GET /api/pages/graph` returned **HTTP 500
   — "too many SQL variables"** after ~19 s. `GetTagsByPostIDs` passed *every* published
   post ID (~100k) as bound params in one `IN(...)`, overflowing SQLite's ~32,766 cap.
   **Atlas breaks above ~32k published posts.** → fixed by chunking the IN list (5000/chunk).
2. **Atlas payload is ~133 MB.** `ListPostNodesForGraph` SELECTs full `content` for every
   published post (to regex out a preview image). Even once it returns 200, 133 MB JSON +
   a 110k-node force-graph is unrenderable. → needs content-drop + server-side aggregation.
3. **The homepage is the quiet disaster: 14.4 s cold.** Dominated by the tag-snapshot
   rebuild — `GetHierarchicalPostCounts` runs **twice** (public+admin) + `buildNavTree`
   over 10.6k tags. Rebuilt on every cache-cold homepage/tag/atlas hit and on any
   tag/post mutation. CPU-bound and **index-immune**.
4. **The "obvious" index fix barely helps.** `idx_post_tags_tag_id` left the hierarchical
   count unchanged (2.80→2.80 s — SQLite already builds a runtime auto-index) and did
   nothing for the 133 MB payload. It only helped hot-tag listing (0.245→0.202 s). Added
   anyway (cheap; helps pagination/COUNT paths) but it is **not** the lever.

## SQL-level (sqlite3 C CLI; understates app cost)

| Query | baseline | +indexes | notes |
|---|---|---|---|
| GetHierarchicalPostCounts (public) | 2.80 s | 2.80 s | ×2 per snapshot; COUNT(DISTINCT) over descendant expansion; plan unchanged |
| GetHierarchicalPostCounts (admin) | 2.81 s | — | same shape |
| ListPostNodesForGraph | 0.44 s / **133 MB** | 0.39 s / 133 MB | payload is the problem, not time |
| GetPostsByTagIDs (hot tag, 95,869) | 0.245 s | **0.202 s** | index now used (was PK scan); helps deep pages more |
| GetPublishedPostsForFeed (homepage) | 0.009 s | 0.009 s | fine |

## HTTP end-to-end

| Endpoint | baseline | +indexes | +chunk-fix |
|---|---|---|---|
| atlas `/api/pages/graph` (cold) | 404* | 19.2 s → **500** | **24.9 s / 62 MB / 200** |
| atlas `/api/pages/graph` (warm) | 404* | 6.1 s → **500** | **11.3 s / 62 MB / 200** |
| homepage `/api/pages/home` (cold) | **14.4 s** | (warm 0.001 s) | (warm 0.011 s) |
| hot-tag `/api/pages/tags/...` | 1.77 s | (warm 0.001 s) | (warm 0.009 s) |

Atlas: chunk fix turns the 500 into a 200, but it's still **11.3 s warm / 62 MB** — i.e.
it now *works* and *proves* the real problem is payload + frontend, not the crash. A
110k-node force-graph won't render regardless of backend speed.

\* baseline atlas 404 = default `tags_visibility='hidden'` blocks public; set to `'all'` to test.

## Fixes applied this pass
- `GetTagsByPostIDs`: chunk the `IN(...)` list (5000/chunk) → stops the atlas 500. (`queries_tags.go`)
- Startup migrations: `idx_post_tags_tag_id`, `idx_tag_relationships_child_id` + (existing) ANALYZE. (`cmd/api/main.go`)
- Seeder backfill rewritten correlated-subquery → grouped `UPDATE…FROM` (101 s → 0.2 s/5k).

## Recommended follow-ups (ranked — the real wins)
1. **Tag-snapshot cost** (drives homepage/tag/atlas cold latency): cache with TTL +
   async rebuild, and/or stop recomputing `GetHierarchicalPostCounts` twice; consider
   computing hierarchical counts in Go from `tags.post_count` + the in-memory graph, or a
   materialized counts table refreshed incrementally. *Highest leverage.*
2. **Atlas payload + frontend**: drop `content` from `ListPostNodesForGraph` (derive preview
   from `thumbnail_path`/first media); return geo/aggregate nodes first and lazy-load the
   cloud around a clicked place instead of all tags+posts+edges. Force-graph must simulate
   only the active neighborhood, not 110k nodes.
3. Replace `LOWER(p.status)='published'` with `status='published'` (status is normalized
   lowercase by `normalize_post_status_case`) so `idx_posts_status` is usable.
