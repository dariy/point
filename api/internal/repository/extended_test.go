package repository

import (
	"context"
	"path/filepath"
	"testing"

	"point-api/internal/models"
)

func TestRepository_SystemStats(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()
	stats, err := repo.GetSystemStats(ctx)
	if err != nil {
		t.Fatalf("GetSystemStats failed: %v", err)
	}

	// Should be all zeros for empty DB
	if stats.PostCount != 0 {
		t.Errorf("expected 0 posts, got %d", stats.PostCount)
	}
}

func TestRepository_OrphanedMedia(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()

	// Insert some media
	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1', 'p1', 'file', 'text/plain', 10, 'c1')`)

	orphans, err := repo.ListOrphanedMedia(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListOrphanedMedia failed: %v", err)
	}
	if len(orphans) != 1 {
		t.Errorf("expected 1 orphan, got %d", len(orphans))
	}

	count, _ := repo.CountOrphanedMedia(ctx)
	if count != 1 {
		t.Errorf("expected count 1, got %d", count)
	}
}

func TestRepository_Tags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	// Insert tags
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('T1', 't1'), ('T2', 't2')`)
	
	tags, err := repo.FindTagsByNames(ctx, []string{"t1", "t2"})
	if err != nil || len(tags) != 2 {
		t.Errorf("FindTagsByNames failed: %v, len=%d", err, len(tags))
	}

	// Hierarchy
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1, 2)`)
	desc, _ := repo.GetTagDescendants(ctx, 1)
	if len(desc) != 1 {
		t.Errorf("GetTagDescendants failed, got %d", len(desc))
	}

	anc, _ := repo.GetTagAncestors(ctx, 2)
	if len(anc) != 1 {
		t.Errorf("GetTagAncestors failed, got %d", len(anc))
	}
}

func TestRepository_Migrations(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	// Create table
	_, _ = repo.DB().Exec(`CREATE TABLE migration_history (id INTEGER PRIMARY KEY, name TEXT, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
	_, _ = repo.DB().Exec(`INSERT INTO migration_history (name) VALUES ('m1')`)

	m, err := repo.GetMigrations(ctx)
	if err != nil || len(m) != 1 {
		t.Errorf("GetMigrations failed: %v, len=%d", err, len(m))
	}
}

func TestRepository_Sitemap(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	if _, err := repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u', 'e', 'h', 'd')`); err != nil {
		t.Fatalf("insert user failed: %v", err)
	}
	if _, err := repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status) VALUES ('P1', 'p1', 'C1', 1, 'published')`); err != nil {
		t.Fatalf("insert post failed: %v", err)
	}
	if _, err := repo.DB().Exec(`INSERT INTO tags (name, slug, post_count) VALUES ('T1', 't1', 1)`); err != nil {
		t.Fatalf("insert tag failed: %v", err)
	}

	p, err := repo.GetPublishedPostsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublishedPostsForSitemap failed: %v", err)
	}
	if len(p) != 1 {
		t.Errorf("GetPublishedPostsForSitemap expected 1, got %d", len(p))
	}

	tags, err := repo.GetPublicTagsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublicTagsForSitemap failed: %v", err)
	}
	if len(tags) != 1 {
		t.Errorf("GetPublicTagsForSitemap expected 1, got %d", len(tags))
	}
}

func TestRepository_MediaIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1, 'f1', 'p1', 'file', 'text/plain', 10, 'c1'), (2, 'f2', 'p2', 'file', 'text/plain', 10, 'c2')`)

	m, _ := repo.GetMediaByIDs(ctx, []int64{1, 2})
	if len(m) != 2 {
		t.Errorf("GetMediaByIDs failed")
	}

	err := repo.DeleteMediaByIDs(ctx, []int64{1})
	if err != nil {
		t.Errorf("DeleteMediaByIDs failed")
	}
}


func TestRepository_Extra(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	// BackupDB
	tmpFile := filepath.Join(t.TempDir(), "backup.db")
	err := repo.BackupDB(ctx, tmpFile)
	if err != nil {
		t.Errorf("BackupDB failed: %v", err)
	}

	// UpsertTagLocation
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'T1', 't1')`)
	err = repo.UpsertTagLocation(ctx, 1, 10.0, 20.0)
	if err != nil {
		t.Errorf("UpsertTagLocation failed: %v", err)
	}

	// GetTagsWithoutLocation
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (3, 'T3', 't3')`)
	notLoc, _ := repo.GetTagsWithoutLocation(ctx, []int64{1, 3})
	if len(notLoc) != 1 || notLoc[0].ID != 3 {
		t.Errorf("GetTagsWithoutLocation failed, got %d", len(notLoc))
	}
}

// helpers: insert a user and a published post, return (userID, postID).
func insertUserAndPost(t *testing.T, repo *Repository, slug, status string) (int64, int64) {
	t.Helper()
	res, err := repo.DB().Exec(
		`INSERT OR IGNORE INTO users (username, email, password_hash, display_name) VALUES ('u1','e1','h','D')`)
	if err != nil {
		t.Fatalf("insert user: %v", err)
	}
	uid, _ := res.LastInsertId()
	if uid == 0 {
		_ = repo.DB().QueryRow(`SELECT id FROM users WHERE username='u1'`).Scan(&uid)
	}
	res2, err := repo.DB().Exec(
		`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('T', ?, 'C', ?, ?, datetime('now'))`,
		slug, uid, status)
	if err != nil {
		t.Fatalf("insert post: %v", err)
	}
	pid, _ := res2.LastInsertId()
	return uid, pid
}

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

func TestRepository_ListPostsWithSearch(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	insertUserAndPost(t, repo, "hello-world", "published")

	rows, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "hello", 10, 0)
	if err != nil {
		t.Fatalf("ListPostsWithSearch failed: %v", err)
	}
	if len(rows) != 1 {
		t.Errorf("expected 1 result, got %d", len(rows))
	}

	count, err := repo.CountPostsWithSearch(ctx, false, "", false, false, false, "hello")
	if err != nil {
		t.Fatalf("CountPostsWithSearch failed: %v", err)
	}
	if count != 1 {
		t.Errorf("expected count 1, got %d", count)
	}

	// no match
	rows2, _ := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "zzznomatch", 10, 0)
	if len(rows2) != 0 {
		t.Errorf("expected 0 results for no-match, got %d", len(rows2))
	}
}

func TestRepository_GetPublishedPostsForFeed(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	insertUserAndPost(t, repo, "feed-post", "published")

	items, err := repo.GetPublishedPostsForFeed(ctx, 10)
	if err != nil {
		t.Fatalf("GetPublishedPostsForFeed failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 post, got %d", len(items))
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

	prev, next, err := repo.GetPostNavigation(ctx, pid2, true)
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

func TestRepository_TagRelationships(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'P','p'),(2,'C','c')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	rels, err := repo.GetAllTagRelationships(ctx)
	if err != nil || len(rels) != 1 {
		t.Errorf("GetAllTagRelationships: err=%v len=%d", err, len(rels))
	}

	if err := repo.ClearTagParents(ctx, 2); err != nil {
		t.Errorf("ClearTagParents failed: %v", err)
	}
	rels, _ = repo.GetAllTagRelationships(ctx)
	if len(rels) != 0 {
		t.Errorf("expected 0 rels after ClearTagParents, got %d", len(rels))
	}

	// Re-insert and test ClearTagChildren
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	if err := repo.ClearTagChildren(ctx, 1); err != nil {
		t.Errorf("ClearTagChildren failed: %v", err)
	}
	rels, _ = repo.GetAllTagRelationships(ctx)
	if len(rels) != 0 {
		t.Errorf("expected 0 rels after ClearTagChildren, got %d", len(rels))
	}
}

func TestRepository_ListOrphanedMediaByPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','file','text/plain',10,'c1')`)

	media, count, err := repo.ListOrphanedMediaByPage(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListOrphanedMediaByPage failed: %v", err)
	}
	if len(media) != 1 || count != 1 {
		t.Errorf("expected 1 orphan, got len=%d count=%d", len(media), count)
	}
}

func TestRepository_MediaFolders(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','originals/2024/06/img.jpg','image','image/jpeg',100,'c1')`)

	folders, err := repo.ListMediaFolders(ctx, "")
	if err != nil {
		t.Fatalf("ListMediaFolders failed: %v", err)
	}
	if len(folders) != 1 || folders[0].Year != "2024" {
		t.Errorf("ListMediaFolders: unexpected %v", folders)
	}

	// ListMediaFiltered no filter
	items, err := repo.ListMediaFiltered(ctx, "", "", 10, 0)
	if err != nil {
		t.Fatalf("ListMediaFiltered failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 item, got %d", len(items))
	}

	// ListMediaFiltered with folder
	items2, _ := repo.ListMediaFiltered(ctx, "", "2024/06", 10, 0)
	if len(items2) != 1 {
		t.Errorf("expected 1 item with folder filter, got %d", len(items2))
	}

	// CountMediaFiltered
	count, err := repo.CountMediaFiltered(ctx, "", "")
	if err != nil || count != 1 {
		t.Errorf("CountMediaFiltered: err=%v count=%d", err, count)
	}

	// file type filter
	folders2, _ := repo.ListMediaFolders(ctx, "image")
	if len(folders2) != 1 {
		t.Errorf("ListMediaFolders with type: got %d", len(folders2))
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

func TestRepository_GetYearTagsByLocationTagIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "loc-post", "published")
	// yearParent=1, year tag=2, loc tag=3
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Years','years'),(2,'2024','2024'),(3,'Paris','paris')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,2),(?,3)`, pid, pid)

	m, err := repo.GetYearTagsByLocationTagIDs(ctx, []int64{3}, 1)
	if err != nil {
		t.Fatalf("GetYearTagsByLocationTagIDs failed: %v", err)
	}
	if len(m[3]) != 1 {
		t.Errorf("expected 1 year tag for loc 3, got %d", len(m[3]))
	}

	// empty input
	m2, _ := repo.GetYearTagsByLocationTagIDs(ctx, nil, 1)
	if len(m2) != 0 {
		t.Errorf("expected empty map for nil input")
	}
}

func TestRepository_TagLocations(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_ = repo.UpsertTagLocation(ctx, 1, 48.85, 2.35)

	locs, err := repo.GetTagLocationsByTagIDs(ctx, []int64{1})
	if err != nil {
		t.Fatalf("GetTagLocationsByTagIDs failed: %v", err)
	}
	if len(locs) != 1 {
		t.Errorf("expected 1 location, got %d", len(locs))
	}

	// empty input
	locs2, _ := repo.GetTagLocationsByTagIDs(ctx, nil)
	if len(locs2) != 0 {
		t.Errorf("expected empty map for nil input")
	}

	if err := repo.DeleteTagLocation(ctx, 1); err != nil {
		t.Fatalf("DeleteTagLocation failed: %v", err)
	}
	locs3, _ := repo.GetTagLocationsByTagIDs(ctx, []int64{1})
	if len(locs3) != 0 {
		t.Errorf("expected 0 locations after delete, got %d", len(locs3))
	}
}

func TestRepository_TagHierarchy(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, sort_order) VALUES (1,'P','p',0),(2,'C','c',0)`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	children, err := repo.GetChildrenOfTag(ctx, 1)
	if err != nil || len(children) != 1 {
		t.Errorf("GetChildrenOfTag: err=%v len=%d", err, len(children))
	}

	roots, err := repo.GetRootTags(ctx)
	if err != nil {
		t.Fatalf("GetRootTags failed: %v", err)
	}
	// only tag 1 is a root (no parent)
	if len(roots) != 1 || roots[0].ID != 1 {
		t.Errorf("GetRootTags: unexpected %v", roots)
	}

	if err := repo.UpdateTagSortOrder(ctx, 1, 5); err != nil {
		t.Errorf("UpdateTagSortOrder failed: %v", err)
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

	posts, err := repo.GetPostsByTagIDs(ctx, []int64{1}, true, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs failed: %v", err)
	}
	if len(posts) != 1 {
		t.Errorf("expected 1 post, got %d", len(posts))
	}

	count, err := repo.CountPostsByTagIDs(ctx, []int64{1}, true, false)
	if err != nil || count != 1 {
		t.Errorf("CountPostsByTagIDs: err=%v count=%d", err, count)
	}

	// empty tag IDs
	posts2, _ := repo.GetPostsByTagIDs(ctx, nil, true, false, 10, 0)
	if len(posts2) != 0 {
		t.Errorf("expected empty for nil tagIDs")
	}
	count2, _ := repo.CountPostsByTagIDs(ctx, nil, true, false)
	if count2 != 0 {
		t.Errorf("expected 0 count for nil tagIDs")
	}
}

func TestRepository_MediaByPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1,'f1','originals/2024/01/img.jpg','image','image/jpeg',100,'c1')`)

	m, err := repo.GetMediaByPath(ctx, "originals/2024/01/img.jpg")
	if err != nil {
		t.Fatalf("GetMediaByPath failed: %v", err)
	}
	if m.ID != 1 {
		t.Errorf("expected id 1, got %d", m.ID)
	}

	// SetMediaPublic true
	if err := repo.SetMediaPublic(ctx, 1, true, nil); err != nil {
		t.Fatalf("SetMediaPublic failed: %v", err)
	}

	// SetMediaPublic false with nil postID
	if err := repo.SetMediaPublic(ctx, 1, false, nil); err != nil {
		t.Fatalf("SetMediaPublic(false) failed: %v", err)
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

func TestRepository_GetAllMediaPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, file_type, mime_type, file_size, checksum) VALUES ('f1','p1','file','text/plain',10,'c1')`)

	items, err := repo.GetAllMediaPaths(ctx)
	if err != nil {
		t.Fatalf("GetAllMediaPaths failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 media path, got %d", len(items))
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

func TestRepository_ApplyMigration(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	// Create migration_history table (not in schema.sql)
	_, _ = repo.DB().Exec(`CREATE TABLE migration_history (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)

	// Apply a new migration
	err := repo.ApplyMigration(ctx, "test_add_column", `ALTER TABLE tags ADD COLUMN test_col TEXT`)
	if err != nil {
		t.Fatalf("ApplyMigration failed: %v", err)
	}

	// Idempotent: applying the same migration again should be a no-op
	err = repo.ApplyMigration(ctx, "test_add_column", `ALTER TABLE tags ADD COLUMN test_col TEXT`)
	if err != nil {
		t.Fatalf("ApplyMigration (idempotent) failed: %v", err)
	}

	m, err := repo.GetMigrations(ctx)
	if err != nil || len(m) != 1 {
		t.Errorf("GetMigrations after apply: err=%v len=%d", err, len(m))
	}
}

func TestRepository_DeleteSession(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	uid, _ := insertUserAndPost(t, repo, "sess-post", "published")
	// Insert session (ip_address and user_agent are NOT NULL in schema)
	_, err := repo.DB().Exec(`INSERT INTO sessions (id, user_id, token, ip_address, user_agent, expires_at) VALUES (10, ?, 'tok99', '127.0.0.1', 'test-agent', datetime('now','+1 hour'))`, uid)
	if err != nil {
		t.Fatalf("insert session failed: %v", err)
	}

	// Delete with wrong user_id — session not found
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 10, UserID: 99999})
	if err == nil {
		t.Error("expected error for wrong user_id")
	}

	// Delete correctly
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 10, UserID: uid})
	if err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
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
	rows, _ := repo.ListPostsWithSearch(ctx, true, "published", false, false, false, "", 10, 0)
	if len(rows) != 1 {
		t.Errorf("status filter published: expected 1, got %d", len(rows))
	}

	// Include drafts
	rows2, _ := repo.ListPostsWithSearch(ctx, false, "", false, true, false, "", 10, 0)
	if len(rows2) != 2 {
		t.Errorf("includeDrafts: expected 2, got %d", len(rows2))
	}

	// Featured filter
	_, _ = repo.DB().Exec(`UPDATE posts SET is_featured=1 WHERE slug='pub-post'`)
	rows3, _ := repo.ListPostsWithSearch(ctx, false, "", true, true, false, "", 10, 0)
	if len(rows3) != 1 {
		t.Errorf("featured filter: expected 1, got %d", len(rows3))
	}
}



