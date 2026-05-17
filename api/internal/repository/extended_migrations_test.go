package repository

import (
	"context"
	"testing"
)

func TestRepository_UpdatePostThumbnailPath(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	db := repo.DB()
	_, _ = db.Exec(`INSERT OR IGNORE INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = db.Exec(`INSERT INTO posts (title,slug,content,formatter,status,author_id,thumbnail_path) VALUES ('P','p','c','markdown','published',1,'/old/path.jpg')`)

	n, err := repo.UpdatePostThumbnailPath(ctx, "/old/path.jpg", "/new/path.jpg")
	if err != nil {
		t.Fatalf("UpdatePostThumbnailPath failed: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 row affected, got %d", n)
	}

	// Old path no longer exists
	n2, _ := repo.UpdatePostThumbnailPath(ctx, "/old/path.jpg", "/another.jpg")
	if n2 != 0 {
		t.Errorf("expected 0 rows for missing old path, got %d", n2)
	}
}

func TestRepository_GetMediaByPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	db := repo.DB()
	_, _ = db.Exec(`INSERT INTO media (filename,original_path,file_type,mime_type,file_size,checksum) VALUES ('f1','originals/2024/01/a.jpg','image','image/jpeg',1000,'csum1')`)
	_, _ = db.Exec(`INSERT INTO media (filename,original_path,file_type,mime_type,file_size,checksum) VALUES ('f2','originals/2024/01/b.jpg','image','image/jpeg',2000,'csum2')`)

	// Empty paths
	empty, err := repo.GetMediaByPaths(ctx, []string{})
	if err != nil {
		t.Fatalf("GetMediaByPaths (empty) failed: %v", err)
	}
	if empty != nil {
		t.Errorf("expected nil for empty paths, got %+v", empty)
	}

	// Single path
	items, err := repo.GetMediaByPaths(ctx, []string{"originals/2024/01/a.jpg"})
	if err != nil {
		t.Fatalf("GetMediaByPaths failed: %v", err)
	}
	if len(items) != 1 {
		t.Errorf("expected 1 media item, got %d", len(items))
	}

	// Multiple paths
	all, err := repo.GetMediaByPaths(ctx, []string{"originals/2024/01/a.jpg", "originals/2024/01/b.jpg"})
	if err != nil {
		t.Fatalf("GetMediaByPaths (multi) failed: %v", err)
	}
	if len(all) != 2 {
		t.Errorf("expected 2 media items, got %d", len(all))
	}

	// Non-existent path
	missing, _ := repo.GetMediaByPaths(ctx, []string{"originals/2024/01/missing.jpg"})
	if len(missing) != 0 {
		t.Errorf("expected 0 for missing path, got %d", len(missing))
	}
}

func TestRepository_DeleteSecret(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	db := repo.DB()
	_, _ = db.Exec(`INSERT INTO blog_secrets (key,value) VALUES ('pw_reset:abc123','payload')`)

	err := repo.DeleteSecret(ctx, "pw_reset:abc123")
	if err != nil {
		t.Fatalf("DeleteSecret failed: %v", err)
	}

	var count int
	_ = db.QueryRow(`SELECT COUNT(*) FROM blog_secrets WHERE key = 'pw_reset:abc123'`).Scan(&count)
	if count != 0 {
		t.Errorf("expected secret to be deleted, count=%d", count)
	}

	// Deleting non-existent key should not error
	err = repo.DeleteSecret(ctx, "pw_reset:nonexistent")
	if err != nil {
		t.Errorf("DeleteSecret non-existent: expected no error, got %v", err)
	}
}

func TestRepository_EnsureSystemTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// First call
	if err := repo.EnsureSystemTags(ctx); err != nil {
		t.Fatalf("EnsureSystemTags failed: %v", err)
	}

	// Idempotent — second call should not fail
	if err := repo.EnsureSystemTags(ctx); err != nil {
		t.Fatalf("EnsureSystemTags (second call) failed: %v", err)
	}

	// Verify _system tag exists
	db := repo.DB()
	var slug string
	err := db.QueryRow(`SELECT slug FROM tags WHERE slug = '_system' LIMIT 1`).Scan(&slug)
	if err != nil || slug != "_system" {
		t.Errorf("expected _system tag after EnsureSystemTags, got err=%v slug=%s", err, slug)
	}
}

func TestRepository_DropTagNameUnique(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// First call — handles missing or present constraint gracefully
	if err := repo.DropTagNameUnique(ctx); err != nil {
		t.Fatalf("DropTagNameUnique failed: %v", err)
	}

	// Idempotent
	if err := repo.DropTagNameUnique(ctx); err != nil {
		t.Fatalf("DropTagNameUnique (second call) failed: %v", err)
	}
}
