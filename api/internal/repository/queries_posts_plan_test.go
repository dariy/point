package repository

import (
	"fmt"
	"strconv"
	"strings"
	"testing"
)

// seedForPlanning gives the planner something to plan against. It matters: with
// an empty posts table SQLite falls back to default row estimates and picks the
// index the query text suggests, which is not the choice it makes on a real
// blog. The bug these tests exist to catch — a whole-column deleted_at index
// swallowing the feed — is invisible without rows and ANALYZE.
func seedForPlanning(t *testing.T, repo Repository) {
	t.Helper()
	db := repo.DB()
	if _, err := db.Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u1','e1','h','D')`); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	for i := range 500 {
		// One post in fifty is in the trash, which is the shape the partial
		// index is sized for.
		deleted := "NULL"
		if i%50 == 0 {
			deleted = "datetime('now')"
		}
		if _, err := tx.Exec(`INSERT INTO posts (title, slug, content, author_id, status, type, published_at, created_at, deleted_at)
			VALUES ('t', ?, 'c', 1, 'published', 'post', datetime('now', ?), datetime('now', ?), `+deleted+`)`,
			strconv.Itoa(i), fmt.Sprintf("-%d minutes", i), fmt.Sprintf("-%d minutes", i)); err != nil {
			t.Fatalf("seed post %d: %v", i, err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if _, err := db.Exec(`ANALYZE`); err != nil {
		t.Fatalf("analyze: %v", err)
	}
}

// queryPlan returns the EXPLAIN QUERY PLAN lines for q, one per row, joined so a
// failure message shows the whole plan rather than the one line that tripped.
func queryPlan(t *testing.T, repo Repository, q string, args ...any) []string {
	t.Helper()
	rows, err := repo.DB().Query("EXPLAIN QUERY PLAN "+q, args...)
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan row: %v", err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read plan: %v", err)
	}
	if len(plan) == 0 {
		t.Fatal("empty query plan")
	}
	return plan
}

func planContains(plan []string, substr string) bool {
	for _, line := range plan {
		if strings.Contains(line, substr) {
			return true
		}
	}
	return false
}

// listCards is the select ListPosts builds for a card list — the shape both the
// feed and a tag page are served with.
const listCards = `SELECT p.id, p.title, p.slug, '' AS content, p.excerpt, p.formatter, p.status, p.type, p.is_featured,
       p.view_count, p.published_at, p.created_at, p.updated_at, p.author_id,
       p.thumbnail_path, p.media_url, p.meta_description, p.preview_token, p.preview_expires_at, p.css
FROM posts p`

const listOrder = "ORDER BY p.published_at DESC, p.created_at DESC, p.id DESC"

// The two indexes these assert are the reason post_tags is not scanned and the
// feed does not sort by hand. Both are cheap to lose: an index dropped from
// schema.sql, or a WHERE clause reworded past the partial index's condition,
// changes no result and no test but costs every public page load. The plan is
// the only place that shows it, so the plan is what is asserted.
//
// Written against a schema.sql database, which is where the indexes live for a
// fresh install; migrations carry the same ones to databases that predate them.
// What a plan test cannot pin is the planner's choice between two indexes that
// both fit — see the note on the trash test below.
func TestBuildPostsQuery_TagFilterUsesTheTagIDIndex(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	q, args := buildPostsQuery(listCards, listOrder, "LIMIT ? OFFSET ?",
		"post", false, "", false, false, false, "sunsets", "", 0, 0)
	plan := queryPlan(t, repo, q, append(args, 20, 0)...)

	// Both post_tags reads — the tag filter and the hides_posts exclusion —
	// have to come off the index; either one scanning is a full table read on
	// every tag page.
	for _, scan := range []string{"SCAN post_tags", "SCAN pt"} {
		if planContains(plan, scan) {
			t.Errorf("tag-filtered list plan scans post_tags (%q):\n  %s", scan, strings.Join(plan, "\n  "))
		}
	}
	if !planContains(plan, "idx_post_tags_tag_id_post_id") {
		t.Errorf("tag-filtered list plan does not use idx_post_tags_tag_id_post_id:\n  %s", strings.Join(plan, "\n  "))
	}
}

func TestBuildPostsQuery_FeedSortsOffTheIndex(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	seedForPlanning(t, repo)

	// The public feed: no tag, drafts and hidden posts excluded, so the
	// hides_posts exclusion is in play — the ordinary homepage query.
	q, args := buildPostsQuery(listCards, listOrder, "LIMIT ? OFFSET ?",
		"post", false, "", false, false, false, "", "", 0, 0)
	plan := queryPlan(t, repo, q, append(args, 20, 0)...)

	if !planContains(plan, "idx_posts_live") {
		t.Errorf("feed plan does not use idx_posts_live:\n  %s", strings.Join(plan, "\n  "))
	}
	// idx_posts_live carries all three ORDER BY terms in the order the feed
	// asks for; anything it leaves out is sorted by hand instead.
	if planContains(plan, "TEMP B-TREE") {
		t.Errorf("feed plan builds a temp B-tree to sort:\n  %s", strings.Join(plan, "\n  "))
	}
}

// The trash view is the only reader of deleted_at, and the only reason to index
// it. What this pins is that the partial index still serves it — the half of
// the swap that could regress quietly.
//
// The other half is why the swap happened, and is not pinned here: over the
// whole column, that index is one SQLite prefers for `deleted_at IS NULL`,
// which every other query carries, and taking it reads nearly every post
// through the index and then sorts the feed by hand — 28.2ms against 2.06ms on
// a 20k-post database. That choice only reproduces on a database built the way
// a real one is, by NewRepository followed by migrations.Run; against the
// schema.sql database these tests use, the planner picks idx_posts_live either
// way, at every size and either journal mode. So the feed test above would not
// have caught it, and would not catch it coming back.
func TestListTrashedPosts_SeeksThePartialIndex(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	seedForPlanning(t, repo)

	plan := queryPlan(t, repo, `SELECT * FROM posts
WHERE deleted_at IS NOT NULL
ORDER BY deleted_at DESC
LIMIT ? OFFSET ?`, 20, 0)

	if !planContains(plan, "idx_posts_trashed") {
		t.Errorf("trash plan does not use idx_posts_trashed:\n  %s", strings.Join(plan, "\n  "))
	}
}
