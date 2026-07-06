package repository

import (
	"context"
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

func TestRepository_UpdatePostThumbnailPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "thumb-post", "published")
	_, _ = repo.DB().Exec(`UPDATE posts SET thumbnail_path='old' WHERE id=?`, pid)

	n, err := repo.UpdatePostThumbnailPath(ctx, "old", "new")
	if err != nil {
		t.Fatalf("UpdatePostThumbnailPath failed: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 updated post, got %d", n)
	}
}
