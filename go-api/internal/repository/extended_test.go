package repository

import (
	"context"
	"path/filepath"
	"testing"
)

func TestRepository_SystemStats(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	defer repo.Close()

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
	defer repo.Close()
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
	defer repo.Close()
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
	defer repo.Close()
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
	defer repo.Close()
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
	defer repo.Close()
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



