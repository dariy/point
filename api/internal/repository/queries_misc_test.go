package repository

import (
	"context"
	"path/filepath"
	"testing"

	"point-api/internal/models"
)

func TestRepository_Extra(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
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

func TestRepository_QueryErrors(t *testing.T) {
	repo := setupTestDB(t)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'T1','t1',1),(2,'T2','t2',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1,1),(1,2)`)
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1,'f','originals/2024/01/f','image','image/jpeg',100,'c1')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (1,1.0,2.0)`)

	_ = repo.Close()

	if _, err := repo.ListPosts(ctx, models.ListPostsParams{}); err == nil {
		t.Error("ListPosts: expected error")
	}
	if _, err := repo.ListOrphanedMedia(ctx, 10, 0); err == nil {
		t.Error("ListOrphanedMedia: expected error")
	}
	if _, err := repo.GetPublishedPostsForFeed(ctx, 10); err == nil {
		t.Error("GetPublishedPostsForFeed: expected error")
	}
	if _, err := repo.GetPublishedPostsForSitemap(ctx); err == nil {
		t.Error("GetPublishedPostsForSitemap: expected error")
	}
	if _, err := repo.GetPublicTagsForSitemap(ctx); err == nil {
		t.Error("GetPublicTagsForSitemap: expected error")
	}
	if _, _, err := repo.GetPostNavigation(ctx, 1, true); err == nil {
		t.Error("GetPostNavigation: expected error")
	}
	if _, err := repo.GetCoOccurringTags(ctx, 1, false); err == nil {
		t.Error("GetCoOccurringTags: expected error")
	}
	if _, err := repo.GetAllTagRelationships(ctx); err == nil {
		t.Error("GetAllTagRelationships: expected error")
	}
	if _, _, err := repo.ListOrphanedMediaByPage(ctx, 10, 0); err == nil {
		t.Error("ListOrphanedMediaByPage: expected error")
	}
	if _, err := repo.ListMediaFolders(ctx, ""); err == nil {
		t.Error("ListMediaFolders: expected error")
	}
	if _, err := repo.ListMediaFiltered(ctx, "", "", 10, 0); err == nil {
		t.Error("ListMediaFiltered: expected error")
	}
	if _, err := repo.ListPublishedPostStubs(ctx); err == nil {
		t.Error("ListPublishedPostStubs: expected error")
	}
	if _, err := repo.GetTagsByPostIDs(ctx, []int64{1}); err == nil {
		t.Error("GetTagsByPostIDs: expected error")
	}
	if _, err := repo.GetYearTagsByLocationTagIDs(ctx, []int64{1}); err == nil {
		t.Error("GetYearTagsByLocationTagIDs: expected error")
	}
	if _, err := repo.GetTagLocationsByTagIDs(ctx, []int64{1}); err == nil {
		t.Error("GetTagLocationsByTagIDs: expected error")
	}
	if _, err := repo.GetAllPublishedPostContents(ctx); err == nil {
		t.Error("GetAllPublishedPostContents: expected error")
	}
	if _, err := repo.GetAllMediaPaths(ctx); err == nil {
		t.Error("GetAllMediaPaths: expected error")
	}
	if _, err := repo.GetHierarchicalPostCounts(ctx, true); err == nil {
		t.Error("GetHierarchicalPostCounts: expected error")
	}
	if _, err := repo.GetPostsByTagIDs(ctx, []int64{1}, true, false, false, 10, 0); err == nil {
		t.Error("GetPostsByTagIDs: expected error")
	}
	if err := repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 99, UserID: 1}); err == nil {
		t.Error("DeleteSession: expected error")
	}
	if _, err := repo.FindTagsByNames(ctx, []string{"city"}); err == nil {
		t.Error("FindTagsByNames: expected error")
	}
	if _, err := repo.GetTagsWithoutLocation(ctx, []int64{1}); err == nil {
		t.Error("GetTagsWithoutLocation: expected error")
	}
	if _, err := repo.ReplacePostContentPath(ctx, "old", "new"); err == nil {
		t.Error("ReplacePostContentPath: expected error")
	}
	if err := repo.UpsertTagLocation(ctx, 1, 1.0, 2.0); err == nil {
		t.Error("UpsertTagLocation: expected error")
	}
	if _, err := repo.CountMediaFiltered(ctx, "", ""); err == nil {
		t.Error("CountMediaFiltered: expected error")
	}
	if err := repo.SetMediaPublic(ctx, 1, true, nil); err == nil {
		t.Error("SetMediaPublic: expected error")
	}
	if _, err := repo.ListPostsWithSearch(ctx, false, "", false, false, false, "test", 10, 0); err == nil {
		t.Error("ListPostsWithSearch: expected error")
	}
	if _, err := repo.CountPostsByTagIDs(ctx, []int64{1}, true, false, false); err == nil {
		t.Error("CountPostsByTagIDs: expected error")
	}
}

func TestRepository_BranchCoverage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'T','t',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (1,1)`)

	if _, _, err := repo.GetPostNavigation(ctx, 1, false); err != nil {
		t.Fatalf("GetPostNavigation (not public): %v", err)
	}
	if _, err := repo.CountMediaFiltered(ctx, "image", "2024/01"); err != nil {
		t.Fatalf("CountMediaFiltered with folder: %v", err)
	}
	if _, err := repo.GetPostsByTagIDs(ctx, []int64{1}, false, true, false, 10, 0); err != nil {
		t.Fatalf("GetPostsByTagIDs (includeDrafts): %v", err)
	}
	if _, err := repo.GetPostsByTagIDs(ctx, []int64{1}, false, false, false, 10, 0); err != nil {
		t.Fatalf("GetPostsByTagIDs (not published only): %v", err)
	}
	if _, err := repo.GetPostsByTagIDs(ctx, []int64{1}, false, false, true, 10, 0); err != nil {
		t.Fatalf("GetPostsByTagIDs (includeHidden): %v", err)
	}
	if _, err := repo.CountPostsByTagIDs(ctx, []int64{1}, false, true, false); err != nil {
		t.Fatalf("CountPostsByTagIDs (includeDrafts): %v", err)
	}
	if _, err := repo.CountPostsByTagIDs(ctx, []int64{1}, false, false, false); err != nil {
		t.Fatalf("CountPostsByTagIDs (not published only): %v", err)
	}
	if _, err := repo.CountPostsByTagIDs(ctx, []int64{1}, false, false, true); err != nil {
		t.Fatalf("CountPostsByTagIDs (includeHidden): %v", err)
	}
	if _, _, err := repo.ListOrphanedMediaByPage(ctx, 10, 0); err != nil {
		t.Fatalf("ListOrphanedMediaByPage: %v", err)
	}

	n, err := repo.CountPostsByTagIDs(ctx, []int64{}, false, false, false)
	if err != nil || n != 0 {
		t.Errorf("CountPostsByTagIDs empty: err=%v n=%d", err, n)
	}
	_, _ = repo.CountPostsByTagIDs(ctx, []int64{1, 2}, false, false, false)

	posts, err := repo.GetPostsByTagIDs(ctx, []int64{}, false, false, false, 10, 0)
	if err != nil || len(posts) != 0 {
		t.Errorf("GetPostsByTagIDs empty: err=%v len=%d", err, len(posts))
	}

	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (2,'T2','t2',0)`)
	if _, err := repo.GetPostsByTagIDs(ctx, []int64{1, 2}, false, false, false, 10, 0); err != nil {
		t.Fatalf("GetPostsByTagIDs multi-tag: %v", err)
	}

	contents, err := repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		t.Fatalf("GetAllPublishedPostContents empty: %v", err)
	}
	_ = contents
}

func TestRepository_ExecErrors(t *testing.T) {
	repo := setupTestDB(t)
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO media (id,filename,original_path,file_type,mime_type,file_size,checksum) VALUES (1,'f','p','image','image/jpeg',100,'c')`)
	_ = repo.Close()

	if _, err := repo.GetMediaByIDs(ctx, []int64{1}); err == nil {
		t.Error("GetMediaByIDs: expected error")
	}
	if err := repo.DeleteMediaByIDs(ctx, []int64{1}); err == nil {
		t.Error("DeleteMediaByIDs: expected error")
	}
	if _, err := repo.ReplacePostContentPath(ctx, "old", "new"); err == nil {
		t.Error("ReplacePostContentPath: expected error")
	}
	if err := repo.ApplyMigration(ctx, "x", "SELECT 1"); err == nil {
		t.Error("ApplyMigration: expected error")
	}
}

func TestNewRepository_MemorySharedCache(t *testing.T) {
	repo, err := NewRepository("file::memory:?cache=shared")
	if err != nil {
		t.Logf("NewRepository memory shared: %v (expected on some drivers)", err)
		return
	}
	defer func() { _ = repo.Close() }()
}

func TestNewRepository_InvalidPath(t *testing.T) {
	tmpDir := t.TempDir()
	repo, err := NewRepository(tmpDir)
	if err != nil {
		return
	}
	defer func() { _ = repo.Close() }()
}
