package repository

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"

	"point-api/internal/models"
)

func TestListPublishedPostStubs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()
	// Create two published posts
	uid, _ := insertUserAndPost(t, repo, "first", "published")
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-01-01 10:00:00' WHERE slug='first'`)

	// Second post, newer
	_, _ = repo.DB().Exec(
		`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('Second', 'second', 'C', ?, 'published', '2024-01-01 11:00:00')`,
		uid)

	// Draft — should not appear
	_, _ = repo.DB().Exec(
		`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('Draft', 'draft', 'C', ?, 'draft', '2024-01-01 12:00:00')`,
		uid)

	stubs, err := repo.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(stubs) != 2 {
		t.Fatalf("expected 2 stubs, got %d", len(stubs))
	}
	// newest first
	if stubs[0].Slug != "second" || stubs[1].Slug != "first" {
		t.Errorf("wrong order: %v %v", stubs[0].Slug, stubs[1].Slug)
	}
}

func TestRepository_ListPostsLiteOmitsContent(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "lite-post", "published")
	if _, err := repo.DB().Exec(`UPDATE posts SET content=? WHERE id=?`, "full body text", pid); err != nil {
		t.Fatalf("set content: %v", err)
	}
	if err := repo.SetPostMediaURL(ctx, pid, "/cover.jpg"); err != nil {
		t.Fatalf("SetPostMediaURL: %v", err)
	}

	// Lite (default): content is not selected; media_url is.
	lite, err := repo.ListPosts(ctx, models.ListPostsParams{Limit: 10})
	if err != nil {
		t.Fatalf("ListPosts lite: %v", err)
	}
	if len(lite) != 1 {
		t.Fatalf("expected 1 post, got %d", len(lite))
	}
	if lite[0].Content != "" {
		t.Errorf("expected empty content in lite mode, got %q", lite[0].Content)
	}
	if !lite[0].MediaURL.Valid || lite[0].MediaURL.String != "/cover.jpg" {
		t.Errorf("expected media_url /cover.jpg, got %#v", lite[0].MediaURL)
	}

	// IncludeContent: full body returned (offline snapshot path).
	full, err := repo.ListPosts(ctx, models.ListPostsParams{Limit: 10, IncludeContent: true})
	if err != nil {
		t.Fatalf("ListPosts full: %v", err)
	}
	if len(full) != 1 || full[0].Content != "full body text" {
		t.Errorf("expected full content, got %q", full[0].Content)
	}
}

func TestRepository_ListPostsWithSearch(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	insertUserAndPost(t, repo, "hello-world", "published")

	rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "hello", "", false, 10, 0)
	if err != nil {
		t.Fatalf("ListPostsWithSearch failed: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("expected 1 result, got %d", len(rows))
	}

	count, err := repo.CountPostsWithSearch(ctx, false, "", false, false, false, "hello", "", false)
	if err != nil {
		t.Fatalf("CountPostsWithSearch failed: %v", err)
	}
	if count != 1 {
		t.Errorf("expected count 1, got %d", count)
	}

	// no match
	rows2, _ := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "zzznomatch", "", false, 10, 0)
	if len(rows2) != 0 {
		t.Errorf("expected 0 results for no-match, got %d", len(rows2))
	}
}

func TestRepository_GetPostByPreviewToken(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "preview-post", "draft")
	_, _ = repo.DB().Exec(`UPDATE posts SET preview_token='tok123' WHERE id=?`, pid)

	post, err := repo.GetPostByPreviewToken(ctx, "tok123")
	if err != nil {
		t.Fatalf("GetPostByPreviewToken failed: %v", err)
	}
	if post.Slug != "preview-post" {
		t.Errorf("expected slug 'preview-post', got %q", post.Slug)
	}
}

func TestRepository_GetPostNavigation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid1 := insertUserAndPost(t, repo, "post-older", "published")
	_, pid2 := insertUserAndPost(t, repo, "post-newer", "published")
	// Ensure ordering
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-01-01' WHERE id=?`, pid1)
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-06-01' WHERE id=?`, pid2)

	// Debug the DB values
	var ts1, ts2 string
	_ = repo.DB().QueryRow(`SELECT published_at FROM posts WHERE id=?`, pid1).Scan(&ts1)
	_ = repo.DB().QueryRow(`SELECT published_at FROM posts WHERE id=?`, pid2).Scan(&ts2)
	t.Logf("pid1=%d ts1=%s, pid2=%d ts2=%s", pid1, ts1, pid2, ts2)

	prev, next, err := repo.GetPostNavigation(ctx, pid2, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation failed: %v", err)
	}
	if prev == nil || prev.ID != pid1 {
		t.Errorf("expected prev post %d, got %v", pid1, prev)
	}
	if next != nil {
		t.Errorf("expected no next post, got %v", next)
	}
}

// A post waiting in the scheduled queue has no published_at, so it has no place
// in the sequence prev/next walks. It must come back with no neighbours — the
// NULL used to be scanned into a string, failing the whole call, which is a 500
// from the navigation endpoint for every scheduled post.
func TestRepository_GetPostNavigation_Unpublished(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, live := insertUserAndPost(t, repo, "nav-live", "published")
	_, queued := insertUserAndPost(t, repo, "nav-queued", "scheduled")
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-01-01' WHERE id=?`, live)
	_, _ = repo.DB().Exec(
		`UPDATE posts SET published_at=NULL, scheduled_at='2030-01-01 10:00:00' WHERE id=?`, queued)

	prev, next, err := repo.GetPostNavigation(ctx, queued, false, "")
	if err != nil {
		t.Fatalf("GetPostNavigation on a scheduled post failed: %v", err)
	}
	if prev != nil || next != nil {
		t.Errorf("scheduled post got neighbours prev=%v next=%v, want none", prev, next)
	}
}

// TestRepository_GetPostNavigation_TagScoped verifies the optional tag argument
// restricts adjacency to posts under that tag (skipping untagged neighbours),
// while pages are always excluded.
func TestRepository_GetPostNavigation_TagScoped(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	uid, pidA := insertUserAndPost(t, repo, "p-a", "published")
	_, pidB := insertUserAndPost(t, repo, "p-b", "published")
	_, pidC := insertUserAndPost(t, repo, "p-c", "published")
	// Chronology: A oldest, B middle, C newest.
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-01-01' WHERE id=?`, pidA)
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-03-01' WHERE id=?`, pidB)
	_, _ = repo.DB().Exec(`UPDATE posts SET published_at='2024-05-01' WHERE id=?`, pidC)

	// A page between A and C must never surface as a neighbour.
	_, _ = repo.DB().Exec(
		`INSERT INTO posts (title, slug, content, author_id, status, published_at, type) VALUES ('Pg','pg','C',?,'published','2024-04-01','page')`, uid)

	// A and C carry the 'travel' tag; B does not.
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Travel','travel')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1),(?,1)`, pidA, pidC)

	// Unscoped: prev of C is its immediate neighbour B.
	prev, next, err := repo.GetPostNavigation(ctx, pidC, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation (unscoped): %v", err)
	}
	if prev == nil || prev.ID != pidB {
		t.Errorf("unscoped prev = %v, want p-b (%d)", prev, pidB)
	}
	if next != nil {
		t.Errorf("unscoped next = %v, want nil", next)
	}

	// Tag-scoped: B is skipped, so prev of C is A.
	prev, next, err = repo.GetPostNavigation(ctx, pidC, true, "travel")
	if err != nil {
		t.Fatalf("GetPostNavigation (tag): %v", err)
	}
	if prev == nil || prev.ID != pidA {
		t.Errorf("tag-scoped prev = %v, want p-a (%d)", prev, pidA)
	}
	if next != nil {
		t.Errorf("tag-scoped next = %v, want nil", next)
	}
}

func TestRepository_ReplacePostContentPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "rpath-post", "published")
	_, _ = repo.DB().Exec(`UPDATE posts SET content='see /old/path/img.jpg here' WHERE id=?`, pid)

	n, err := repo.ReplacePostContentPath(ctx, "/old/path/img.jpg", "/new/path/img.jpg")
	if err != nil {
		t.Fatalf("ReplacePostContentPath failed: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 updated post, got %d", n)
	}
}

func TestRepository_GetTagsByPostIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "tagged-post", "published")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'TG','tg')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1)`, pid)

	m, err := repo.GetTagsByPostIDs(ctx, []int64{pid})
	if err != nil {
		t.Fatalf("GetTagsByPostIDs failed: %v", err)
	}
	if len(m[pid]) != 1 {
		t.Errorf("expected 1 tag for post %d, got %d", pid, len(m[pid]))
	}

	// empty input
	m2, err := repo.GetTagsByPostIDs(ctx, nil)
	if err != nil || len(m2) != 0 {
		t.Errorf("GetTagsByPostIDs(nil): err=%v len=%d", err, len(m2))
	}
}

func TestRepository_PostsByTagIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "tag-post", "published")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1)`, pid)

	posts, err := repo.GetPostsByTagIDs(ctx, []int64{1}, true, false, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs failed: %v", err)
	}
	if len(posts) != 1 {
		t.Errorf("expected 1 post, got %d", len(posts))
	}

	count, err := repo.CountPostsByTagIDs(ctx, []int64{1}, true, false, false)
	if err != nil || count != 1 {
		t.Errorf("CountPostsByTagIDs: err=%v count=%d", err, count)
	}

	// empty tag IDs
	posts2, _ := repo.GetPostsByTagIDs(ctx, nil, true, false, false, 10, 0)
	if len(posts2) != 0 {
		t.Errorf("expected empty for nil tagIDs")
	}
	count2, _ := repo.CountPostsByTagIDs(ctx, nil, true, false, false)
	if count2 != 0 {
		t.Errorf("expected 0 count for nil tagIDs")
	}
}

func TestRepository_GetAllPublishedPostContents(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "pub-content", "published")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1)`, pid)

	items, err := repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		t.Fatalf("GetAllPublishedPostContents failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 post content, got %d", len(items))
	}
	if len(items[0].TagIDs) != 1 {
		t.Errorf("expected 1 tag ID, got %d", len(items[0].TagIDs))
	}
}

func TestRepository_GetHierarchicalPostCounts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "hpc-post", "published")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Parent','parent'),(2,'Child','child')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,2)`, pid)

	counts, err := repo.GetHierarchicalPostCounts(ctx, true)
	if err != nil {
		t.Fatalf("GetHierarchicalPostCounts failed: %v", err)
	}
	// Parent should count the post from child tag
	if counts[1] != 1 {
		t.Errorf("expected parent count=1, got %d", counts[1])
	}

	// admin mode (include hidden)
	counts2, err := repo.GetHierarchicalPostCounts(ctx, false)
	if err != nil {
		t.Fatalf("GetHierarchicalPostCounts(false) failed: %v", err)
	}
	if counts2[1] != 1 {
		t.Errorf("expected parent count=1 (admin), got %d", counts2[1])
	}
}

// A scheduled post is written and tagged; it just hasn't gone live. The admin
// count includes it (that is the badge in /light/tags), the public one does not.
func TestRepository_GetHierarchicalPostCounts_Scheduled(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pubID := insertUserAndPost(t, repo, "hpcs-live", "published")
	_, schedID := insertUserAndPost(t, repo, "hpcs-soon", "scheduled")
	_, draftID := insertUserAndPost(t, repo, "hpcs-draft", "draft")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1),(?,1),(?,1)`, pubID, schedID, draftID)

	public, err := repo.GetHierarchicalPostCounts(ctx, true)
	if err != nil {
		t.Fatalf("GetHierarchicalPostCounts(true) failed: %v", err)
	}
	if public[1] != 1 {
		t.Errorf("public count = %d, want 1 (published only)", public[1])
	}

	admin, err := repo.GetHierarchicalPostCounts(ctx, false)
	if err != nil {
		t.Fatalf("GetHierarchicalPostCounts(false) failed: %v", err)
	}
	if admin[1] != 2 {
		t.Errorf("admin count = %d, want 2 (published + scheduled, never the draft)", admin[1])
	}
}

// The scheduled queue reads soonest-first, which is what puts the post about to
// go live next to the newest published one on the feed's first future page.
func TestRepository_ListScheduledPosts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, later := insertUserAndPost(t, repo, "sched-later", "scheduled")
	_, sooner := insertUserAndPost(t, repo, "sched-sooner", "scheduled")
	insertUserAndPost(t, repo, "sched-live", "published")
	insertUserAndPost(t, repo, "sched-draft", "draft")
	_, _ = repo.DB().Exec(`UPDATE posts SET scheduled_at = ? WHERE id = ?`, "2030-06-01 10:00:00", later)
	_, _ = repo.DB().Exec(`UPDATE posts SET scheduled_at = ? WHERE id = ?`, "2030-01-01 10:00:00", sooner)

	total, err := repo.CountScheduledPosts(ctx)
	if err != nil {
		t.Fatalf("CountScheduledPosts failed: %v", err)
	}
	if total != 2 {
		t.Errorf("CountScheduledPosts = %d, want 2", total)
	}

	posts, err := repo.ListScheduledPosts(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListScheduledPosts failed: %v", err)
	}
	if len(posts) != 2 {
		t.Fatalf("got %d scheduled posts, want 2", len(posts))
	}
	if posts[0].ID != sooner || posts[1].ID != later {
		t.Errorf("order = [%d %d], want soonest first [%d %d]", posts[0].ID, posts[1].ID, sooner, later)
	}
	if !posts[0].ScheduledAt.Valid {
		t.Error("scheduled_at must be selected — the card renders the publish time from it")
	}

	// Paging walks further into the queue.
	page2, err := repo.ListScheduledPosts(ctx, 1, 1)
	if err != nil {
		t.Fatalf("ListScheduledPosts(offset) failed: %v", err)
	}
	if len(page2) != 1 || page2[0].ID != later {
		t.Errorf("second page = %v, want [%d]", page2, later)
	}
}

// A tag page shows its own slice of the queue. The tag IDs it passes are the
// tag plus its descendants (the service resolves those), so this only has to
// hold the narrowing itself: same ordering, nothing from another tag.
func TestRepository_ListScheduledPostsByTagIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, later := insertUserAndPost(t, repo, "tsched-later", "scheduled")
	_, sooner := insertUserAndPost(t, repo, "tsched-sooner", "scheduled")
	_, elsewhere := insertUserAndPost(t, repo, "tsched-elsewhere", "scheduled")
	_, live := insertUserAndPost(t, repo, "tsched-live", "published")
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t'), (2,'Other','other')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,1),(?,1),(?,1),(?,2)`,
		later, sooner, live, elsewhere)
	_, _ = repo.DB().Exec(`UPDATE posts SET scheduled_at = ? WHERE id = ?`, "2030-06-01 10:00:00", later)
	_, _ = repo.DB().Exec(`UPDATE posts SET scheduled_at = ? WHERE id = ?`, "2030-01-01 10:00:00", sooner)
	_, _ = repo.DB().Exec(`UPDATE posts SET scheduled_at = ? WHERE id = ?`, "2029-01-01 10:00:00", elsewhere)

	total, err := repo.CountScheduledPostsByTagIDs(ctx, []int64{1})
	if err != nil {
		t.Fatalf("CountScheduledPostsByTagIDs failed: %v", err)
	}
	if total != 2 {
		t.Errorf("count = %d, want 2 (the published post and the other tag's are not queued here)", total)
	}

	posts, err := repo.ListScheduledPostsByTagIDs(ctx, []int64{1}, 10, 0)
	if err != nil {
		t.Fatalf("ListScheduledPostsByTagIDs failed: %v", err)
	}
	if len(posts) != 2 {
		t.Fatalf("got %d posts, want 2", len(posts))
	}
	if posts[0].ID != sooner || posts[1].ID != later {
		t.Errorf("order = [%d %d], want soonest first [%d %d]", posts[0].ID, posts[1].ID, sooner, later)
	}

	// Paging walks further into the tag's queue.
	page2, err := repo.ListScheduledPostsByTagIDs(ctx, []int64{1}, 1, 1)
	if err != nil {
		t.Fatalf("ListScheduledPostsByTagIDs(offset) failed: %v", err)
	}
	if len(page2) != 1 || page2[0].ID != later {
		t.Errorf("second page = %v, want [%d]", page2, later)
	}

	// No tags is no queue, not the whole one.
	if n, err := repo.CountScheduledPostsByTagIDs(ctx, nil); err != nil || n != 0 {
		t.Errorf("count for no tags = (%d, %v), want (0, nil)", n, err)
	}
	if got, err := repo.ListScheduledPostsByTagIDs(ctx, nil, 10, 0); err != nil || len(got) != 0 {
		t.Errorf("list for no tags = (%v, %v), want empty", got, err)
	}
}

func TestRepository_ListPostsWithSearchStatusFilters(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	insertUserAndPost(t, repo, "pub-post", "published")
	insertUserAndPost(t, repo, "draft-post", "draft")

	// Status filter: only published
	rows, _ := repo.ListPostsWithSearch(ctx, true, "published", false, false, false, "", "", false, 10, 0)
	if len(rows) != 1 {
		t.Errorf("status filter published: expected 1, got %d", len(rows))
	}

	// Include drafts
	rows2, _ := repo.ListPostsWithSearch(ctx, false, "", false, true, false, "", "", false, 10, 0)
	if len(rows2) != 2 {
		t.Errorf("includeDrafts: expected 2, got %d", len(rows2))
	}

	// Featured filter
	_, _ = repo.DB().Exec(`UPDATE posts SET is_featured=1 WHERE slug='pub-post'`)
	rows3, _ := repo.ListPostsWithSearch(ctx, false, "", true, true, false, "", "", false, 10, 0)
	if len(rows3) != 1 {
		t.Errorf("featured filter: expected 1, got %d", len(rows3))
	}
}

func TestRepository_ListPostsAndCountPosts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES
		('P1','p1','b',1,'published',datetime('now')),
		('P2','p2','b',1,'draft',datetime('now')),
		('P3','p3','b',1,'published',datetime('now'))`)

	posts, err := repo.ListPosts(ctx, models.ListPostsParams{
		StatusFilter: false, FeaturedFilter: false, IncludeDrafts: true, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListPosts failed: %v", err)
	}
	if len(posts) < 2 {
		t.Errorf("expected at least 2 posts, got %d", len(posts))
	}

	posts, err = repo.ListPosts(ctx, models.ListPostsParams{
		StatusFilter: true, Status: "published", FeaturedFilter: false, IncludeDrafts: false, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListPosts with status filter failed: %v", err)
	}
	for _, p := range posts {
		if p.Status != "published" {
			t.Errorf("expected published, got %s", p.Status)
		}
	}

	count, err := repo.CountPosts(ctx, models.CountPostsParams{
		StatusFilter: false, FeaturedFilter: false, IncludeDrafts: true,
	})
	if err != nil {
		t.Fatalf("CountPosts failed: %v", err)
	}
	if count < 2 {
		t.Errorf("expected at least 2, got %d", count)
	}

	count, err = repo.CountPosts(ctx, models.CountPostsParams{
		StatusFilter: true, Status: "published", FeaturedFilter: false, IncludeDrafts: false,
	})
	if err != nil {
		t.Fatalf("CountPosts with status filter failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 published, got %d", count)
	}
}

// TestRepository_ListPostsByViews covers the popular-posts ordering. The only
// test this query ever had ran against the sqlc-generated ListPostsByViews,
// which was shadowed by the method below and so never executed.
func TestRepository_ListPostsByViews(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, view_count, published_at) VALUES
		('Quiet','quiet','b',1,'published',10,datetime('now')),
		('Popular','popular','b',1,'published',20,datetime('now'))`)

	posts, err := repo.ListPostsByViews(ctx, models.ListPostsByViewsParams{
		StatusFilter: false, FeaturedFilter: false, IncludeDrafts: true, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListPostsByViews failed: %v", err)
	}
	if len(posts) != 2 {
		t.Fatalf("expected 2 posts, got %d", len(posts))
	}
	if posts[0].Slug != "popular" {
		t.Errorf("expected the most-viewed post first, got %q", posts[0].Slug)
	}

	// The status filter has to reach the SQL, not just the Go struct.
	posts, err = repo.ListPostsByViews(ctx, models.ListPostsByViewsParams{
		StatusFilter: true, Status: "draft", FeaturedFilter: false, IncludeDrafts: true, Limit: 10,
	})
	if err != nil {
		t.Fatalf("ListPostsByViews with status filter failed: %v", err)
	}
	if len(posts) != 0 {
		t.Errorf("expected no drafts, got %d", len(posts))
	}
}

func TestRepository_PostsInYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "year-post", "published")

	// Setup 2024 -> year-post
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, kind) VALUES (11, '2024', '2024', 'year')`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, 11)`, pid)

	arg := models.ListPostsParams{Limit: 10}
	posts, err := repo.ListPostsInYearRange(ctx, 2024, 2024, arg)
	if err != nil {
		t.Fatalf("ListPostsInYearRange failed: %v", err)
	}
	if len(posts) != 1 {
		t.Errorf("expected 1 post, got %d", len(posts))
	}

	count, err := repo.CountPostsInYearRange(ctx, 2024, 2024, models.CountPostsParams{})
	if err != nil || count != 1 {
		t.Errorf("CountPostsInYearRange failed: %v, count=%d", err, count)
	}

	// Tag IDs version
	posts2, err := repo.GetPostsByTagIDsInYearRange(ctx, []int64{11}, 2024, 2024, true, false, false, 10, 0)
	if err != nil || len(posts2) != 1 {
		t.Errorf("GetPostsByTagIDsInYearRange failed: %v, len=%d", err, len(posts2))
	}

	count2, err := repo.CountPostsByTagIDsInYearRange(ctx, []int64{11}, 2024, 2024, true, false, false)
	if err != nil || count2 != 1 {
		t.Errorf("CountPostsByTagIDsInYearRange failed: %v, count=%d", err, count2)
	}
}

// mustExec runs a fixture statement and fails the test if it does not land —
// a silently dropped INSERT here would make a visibility test pass for the
// wrong reason.
func mustExec(t *testing.T, repo Repository, q string, args ...interface{}) {
	t.Helper()
	if _, err := repo.DB().Exec(q, args...); err != nil {
		t.Fatalf("exec %q: %v", q, err)
	}
}

// navSeries lays out three published posts in chronological order (A oldest,
// C newest) so a navigation test can hide the middle one and watch the chain
// close over it.
func navSeries(t *testing.T, repo Repository) (a, b, c int64) {
	t.Helper()
	_, a = insertUserAndPost(t, repo, "nav-a", "published")
	_, b = insertUserAndPost(t, repo, "nav-b", "published")
	_, c = insertUserAndPost(t, repo, "nav-c", "published")
	for id, at := range map[int64]string{a: "2024-01-01", b: "2024-03-01", c: "2024-05-01"} {
		if _, err := repo.DB().Exec(`UPDATE posts SET published_at=? WHERE id=?`, at, id); err != nil {
			t.Fatalf("set published_at: %v", err)
		}
	}
	return a, b, c
}

// A post carried by a hides_posts tag is absent from every public list, so it
// must be absent from the public prev/next chain too. It used to pass the
// navigation query's status-only filter, and clicking through to it hit the
// post-detail endpoint, which applies the full rule and answers 404.
//
// publicOnly is what an anonymous visitor gets — the handler sets it whenever
// there is no principal on the request. That covers the plain signed-out reader
// as much as the guest-view switch; they are one code path.
func TestRepository_GetPostNavigation_SkipsHiddenByTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	pidA, pidB, pidC := navSeries(t, repo)
	mustExec(t, repo, `INSERT INTO tags (id, name, slug, hides_posts) VALUES (1,'Secret','secret',1)`)
	mustExec(t, repo, `INSERT INTO post_tags (post_id, tag_id) VALUES (?,1)`, pidB)

	// Public: B is skipped in both directions.
	prev, next, err := repo.GetPostNavigation(ctx, pidC, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation (public, from C): %v", err)
	}
	if prev == nil || prev.ID != pidA {
		t.Errorf("public prev of C = %v, want nav-a (%d)", prev, pidA)
	}
	if next != nil {
		t.Errorf("public next of C = %v, want nil", next)
	}

	prev, next, err = repo.GetPostNavigation(ctx, pidA, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation (public, from A): %v", err)
	}
	if next == nil || next.ID != pidC {
		t.Errorf("public next of A = %v, want nav-c (%d)", next, pidC)
	}
	if prev != nil {
		t.Errorf("public prev of A = %v, want nil", prev)
	}

	// Signed in: the owner still walks through B.
	prev, _, err = repo.GetPostNavigation(ctx, pidC, false, "")
	if err != nil {
		t.Fatalf("GetPostNavigation (owner): %v", err)
	}
	if prev == nil || prev.ID != pidB {
		t.Errorf("owner prev of C = %v, want nav-b (%d)", prev, pidB)
	}
}

// The exclusion follows the tag tree: a post under a child of a hides_posts tag
// is hidden too, which is what the list queries do.
func TestRepository_GetPostNavigation_SkipsHiddenByDescendantTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	pidA, pidB, pidC := navSeries(t, repo)
	mustExec(t, repo, `INSERT INTO tags (id, name, slug, hides_posts) VALUES (1,'Secret','secret',1)`)
	mustExec(t, repo, `INSERT INTO tags (id, name, slug, hides_posts) VALUES (2,'Sub','sub',0)`)
	mustExec(t, repo, `INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	mustExec(t, repo, `INSERT INTO post_tags (post_id, tag_id) VALUES (?,2)`, pidB)

	prev, _, err := repo.GetPostNavigation(ctx, pidC, true, "")
	if err != nil {
		t.Fatalf("GetPostNavigation: %v", err)
	}
	if prev == nil || prev.ID != pidA {
		t.Errorf("public prev of C = %v, want nav-a (%d)", prev, pidA)
	}
}

// Scoping navigation to a tag narrows the chain; it must not widen it back onto
// a post the hides-posts rule excluded, even when that post carries the tag
// being scoped to.
func TestRepository_GetPostNavigation_TagScopedRespectsHidden(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	pidA, pidB, pidC := navSeries(t, repo)
	mustExec(t, repo, `INSERT INTO tags (id, name, slug, hides_posts) VALUES (1,'Secret','secret',1)`)
	mustExec(t, repo, `INSERT INTO tags (id, name, slug, hides_posts) VALUES (2,'Travel','travel',0)`)
	// All three are in the travel collection; B is additionally hidden.
	mustExec(t, repo, `INSERT INTO post_tags (post_id, tag_id) VALUES (?,2),(?,2),(?,2),(?,1)`,
		pidA, pidB, pidC, pidB)

	prev, _, err := repo.GetPostNavigation(ctx, pidC, true, "travel")
	if err != nil {
		t.Fatalf("GetPostNavigation (tag-scoped): %v", err)
	}
	if prev == nil || prev.ID != pidA {
		t.Errorf("tag-scoped public prev of C = %v, want nav-a (%d)", prev, pidA)
	}
}

func TestListPostNodesForGraph(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if nodes, err := repo.ListPostNodesForGraph(ctx, true); err != nil {
		t.Fatalf("ListPostNodesForGraph on an empty database: %v", err)
	} else if len(nodes) != 0 {
		t.Fatalf("empty database returned %d nodes", len(nodes))
	}

	// Four posts an hour apart, oldest first, so newest-first is a real claim
	// about the result and not the insertion order read back.
	db := repo.DB()
	if _, err := db.Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u1','e1','h','D')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	insert := func(slug, status string, hoursAgo int) int64 {
		t.Helper()
		res, err := db.Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at, created_at)
			VALUES (?, ?, 'c', 1, ?, datetime('now', ?), datetime('now', ?))`,
			slug, slug, status, fmt.Sprintf("-%d hours", hoursAgo), fmt.Sprintf("-%d hours", hoursAgo))
		if err != nil {
			t.Fatalf("insert %s: %v", slug, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	insert("oldest", "published", 4)
	insert("draft", "draft", 3)
	vaulted := insert("vaulted", "published", 2)
	insert("newest", "published", 1)

	// A post carried by a hides_posts tag: published, but not public.
	res, err := db.Exec(
		`INSERT INTO tags (name, slug, post_count, created_at, hides_posts) VALUES ('Vault','vault',0,CURRENT_TIMESTAMP,1)`)
	if err != nil {
		t.Fatalf("insert tag: %v", err)
	}
	tagID, _ := res.LastInsertId()
	if _, err := db.Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)`, vaulted, tagID); err != nil {
		t.Fatalf("tag the vaulted post: %v", err)
	}

	slugs := func(publishedOnly bool) []string {
		t.Helper()
		nodes, err := repo.ListPostNodesForGraph(ctx, publishedOnly)
		if err != nil {
			t.Fatalf("ListPostNodesForGraph(%v): %v", publishedOnly, err)
		}
		out := make([]string, len(nodes))
		for i, n := range nodes {
			out[i] = n.Slug
		}
		return out
	}

	// publishedOnly is what the public graph is drawn from: the draft is gone,
	// and so is the post the vault tag hides.
	if got, want := slugs(true), []string{"newest", "oldest"}; !slices.Equal(got, want) {
		t.Errorf("ListPostNodesForGraph(true) = %v, want %v", got, want)
	}
	// The owner's graph keeps both, and still reads newest first.
	if got, want := slugs(false), []string{"newest", "vaulted", "draft", "oldest"}; !slices.Equal(got, want) {
		t.Errorf("ListPostNodesForGraph(false) = %v, want %v", got, want)
	}
}

// The search path is an FTS5 index now, which brings two things the LIKE scan
// it replaced did not have: a query language the user can trip over, and an
// index that has to be kept in step with the posts table by triggers.
func TestRepository_ListPostsWithSearchFullText(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertUserAndPost(t, repo, "cold-mountain", "published")
	if _, err := repo.DB().Exec(
		`UPDATE posts SET title = 'A Cold Mountain', content = 'snow above the treeline' WHERE slug = 'cold-mountain'`,
	); err != nil {
		t.Fatalf("update post: %v", err)
	}

	search := func(term string) int {
		t.Helper()
		rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, term, "", false, 10, 0)
		if err != nil {
			t.Fatalf("ListPostsWithSearch(%q): %v", term, err)
		}
		count, err := repo.CountPostsWithSearch(ctx, false, "", false, false, false, term, "", false)
		if err != nil {
			t.Fatalf("CountPostsWithSearch(%q): %v", term, err)
		}
		if int(count) != len(rows) {
			t.Errorf("search %q: count %d but %d rows", term, count, len(rows))
		}
		return len(rows)
	}

	// The AFTER UPDATE trigger reindexed the row the UPDATE above rewrote:
	// title, content and slug are all searchable, and a half-typed word
	// matches by prefix because the admin box searches as you type.
	for _, term := range []string{"mountain", "treeline", "snow above", "moun", "cold mou"} {
		if n := search(term); n != 1 {
			t.Errorf("search %q = %d results, want 1", term, n)
		}
	}
	if n := search("zzznomatch"); n != 0 {
		t.Errorf("search for a term in no post = %d results, want 0", n)
	}

	// FTS5 query syntax typed into the search box is data, not syntax: none of
	// these may reach MATCH as an operator, and none may fail the query.
	for _, term := range []string{`"`, `*`, `OR`, `NEAR`, `mountain OR ""`, `snow*`, `NEAR(a b)`, `!!!`, `^`} {
		_ = search(term)
	}

	// A tag match is still a substring one — tags are small enough to scan.
	if _, err := repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('Hiking', 'hiking')`); err != nil {
		t.Fatalf("insert tag: %v", err)
	}
	if _, err := repo.DB().Exec(
		`INSERT INTO post_tags (post_id, tag_id) SELECT p.id, t.id FROM posts p, tags t WHERE p.slug='cold-mountain' AND t.slug='hiking'`,
	); err != nil {
		t.Fatalf("link tag: %v", err)
	}
	if n := search("ikin"); n != 1 {
		t.Errorf("substring search of a tag name = %d results, want 1", n)
	}

	// The delete trigger has to retract the row, or a deleted post keeps
	// answering searches.
	if _, err := repo.DB().Exec(`DELETE FROM posts WHERE slug = 'cold-mountain'`); err != nil {
		t.Fatalf("delete post: %v", err)
	}
	if n := search("mountain"); n != 0 {
		t.Errorf("search after deleting the only match = %d results, want 0", n)
	}
}

// The point of the index: the search query must not read the posts table
// end to end any more.
func TestRepository_SearchQueryIsIndexed(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	q, args := buildPostsQuery("SELECT COUNT(*) FROM posts p", "", "", "post",
		false, "", false, false, false, "", "mountain", 0, 0)

	rows, err := repo.DB().Query("EXPLAIN QUERY PLAN "+q, args...)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer func() { _ = rows.Close() }()

	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("plan rows: %v", err)
	}

	// "SCAN p" or "SCAN posts" — with or without a trailing "USING INDEX ..."
	// — is the whole table or index read end to end, which is what the FTS
	// index exists to remove. posts_fts scanning itself is the index lookup.
	for _, detail := range plan {
		if f := strings.Fields(detail); len(f) >= 2 && f[0] == "SCAN" && (f[1] == "p" || f[1] == "posts") {
			t.Errorf("search still reads every post (%q):\n%s", detail, strings.Join(plan, "\n"))
		}
	}
	if !strings.Contains(strings.Join(plan, "\n"), "posts_fts") {
		t.Errorf("search does not go through posts_fts:\n%s", strings.Join(plan, "\n"))
	}
}

func TestFTSMatchQuery(t *testing.T) {
	cases := []struct{ in, want string }{
		{"mountain", `"mountain"*`},
		{"cold mou", `"cold"* "mou"*`},
		{`"quoted"`, `"quoted"*`},
		{"a OR b", `"a"* "OR"* "b"*`},
		{"NEAR(a b)", `"NEAR"* "a"* "b"*`},
		{"hello-world", `"hello"* "world"*`},
		{"2024", `"2024"*`},
		{"", ""},
		{`"`, ""},
		{"!!! ***", ""},
	}
	for _, c := range cases {
		if got := ftsMatchQuery(c.in); got != c.want {
			t.Errorf("ftsMatchQuery(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
