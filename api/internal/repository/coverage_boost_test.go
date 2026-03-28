package repository

import (
	"context"
	"os"
	"testing"

	"point-api/internal/models"
)

func TestRepository_ListPostsAndCountPosts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES
		('P1','p1','b',1,'published',datetime('now')),
		('P2','p2','b',1,'draft',datetime('now')),
		('P3','p3','b',1,'published',datetime('now'))`)

	// No filters, include drafts
	posts, err := repo.ListPosts(ctx, models.ListPostsParams{
		StatusFilter:   false,
		Status:         "",
		FeaturedFilter: false,
		IncludeDrafts:  true,
		IncludeHidden:  false,
		Limit:          10,
		Offset:         0,
	})
	if err != nil {
		t.Fatalf("ListPosts failed: %v", err)
	}
	if len(posts) < 2 {
		t.Errorf("expected at least 2 posts, got %d", len(posts))
	}

	// Filter by status=published
	posts, err = repo.ListPosts(ctx, models.ListPostsParams{
		StatusFilter:   true,
		Status:         "published",
		FeaturedFilter: false,
		IncludeDrafts:  false,
		IncludeHidden:  false,
		Limit:          10,
		Offset:         0,
	})
	if err != nil {
		t.Fatalf("ListPosts with status filter failed: %v", err)
	}
	for _, p := range posts {
		if p.Status != "published" {
			t.Errorf("expected published, got %s", p.Status)
		}
	}

	// CountPosts - no filters
	count, err := repo.CountPosts(ctx, models.CountPostsParams{
		StatusFilter:   false,
		Status:         "",
		FeaturedFilter: false,
		IncludeDrafts:  true,
		IncludeHidden:  false,
	})
	if err != nil {
		t.Fatalf("CountPosts failed: %v", err)
	}
	if count < 2 {
		t.Errorf("expected at least 2, got %d", count)
	}

	// CountPosts - published only
	count, err = repo.CountPosts(ctx, models.CountPostsParams{
		StatusFilter:   true,
		Status:         "published",
		FeaturedFilter: false,
		IncludeDrafts:  false,
		IncludeHidden:  false,
	})
	if err != nil {
		t.Fatalf("CountPosts with status filter failed: %v", err)
	}
	if count != 2 {
		t.Errorf("expected 2 published, got %d", count)
	}
}

func TestRepository_GetCoOccurringTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'T1','t1',1),(2,'T2','t2',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1,1),(1,2)`)

	_, err := repo.GetCoOccurringTags(ctx, 1, false)
	if err != nil {
		t.Fatalf("GetCoOccurringTags failed: %v", err)
	}

	_, err = repo.GetCoOccurringTags(ctx, 1, true)
	if err != nil {
		t.Fatalf("GetCoOccurringTags (public) failed: %v", err)
	}
}

func TestRepository_MigrateFlagsToSystemTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := repo.MigrateFlagsToSystemTags(ctx)
	if err != nil {
		t.Fatalf("MigrateFlagsToSystemTags failed: %v", err)
	}

	// Idempotent
	err = repo.MigrateFlagsToSystemTags(ctx)
	if err != nil {
		t.Fatalf("MigrateFlagsToSystemTags (idempotent) failed: %v", err)
	}
}

func TestRepository_RebuildTagsTableDropBooleans(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := repo.RebuildTagsTableDropBooleans(ctx)
	if err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans failed: %v", err)
	}

	// Idempotent
	err = repo.RebuildTagsTableDropBooleans(ctx)
	if err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans (idempotent) failed: %v", err)
	}
}


// TestRepository_MigrateWithOldSchema exercises the columnExists=true path in
// MigrateFlagsToSystemTags and RebuildTagsTableDropBooleans.
func TestRepository_MigrateWithOldSchema(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Add the old boolean columns to the tags table so the migration code sees them.
	boolCols := []string{
		"ALTER TABLE tags ADD COLUMN is_important BOOLEAN NOT NULL DEFAULT 0",
		"ALTER TABLE tags ADD COLUMN is_featured BOOLEAN NOT NULL DEFAULT 0",
		"ALTER TABLE tags ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT 0",
		"ALTER TABLE tags ADD COLUMN is_hidden_posts BOOLEAN NOT NULL DEFAULT 0",
		"ALTER TABLE tags ADD COLUMN include_in_breadcrumbs BOOLEAN NOT NULL DEFAULT 0",
		"ALTER TABLE tags ADD COLUMN show_related_tags_as_children BOOLEAN NOT NULL DEFAULT 0",
	}
	for _, col := range boolCols {
		if _, err := repo.DB().Exec(col); err != nil {
			t.Fatalf("add col: %v", err)
		}
	}

	// Insert a user tag with some flags set to exercise the migration queries.
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug, post_count, is_featured, is_hidden) VALUES ('Featured','featured',1,1,0)`)

	// Run migration (columnExists=true path).
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags (old schema) failed: %v", err)
	}
	// Idempotent.
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags idempotent: %v", err)
	}

	// Now rebuild (is_featured column still exists; exercises columnExists path).
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans (old schema) failed: %v", err)
	}
	// Idempotent.
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans idempotent: %v", err)
	}
}

// TestRepository_ApplyMigrationBadSQL covers the "failed SQL" error return in ApplyMigration.
func TestRepository_ApplyMigrationBadSQL(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := repo.ApplyMigration(ctx, "bad_migration_test", "INVALID SQL STATEMENT !!!")
	if err == nil {
		t.Error("expected error for invalid SQL, got nil")
	}
}

// TestRepository_GetMigrationsNoTable covers the "table doesn't exist" path
// that returns an empty list (not an error).
func TestRepository_GetMigrationsNoTable(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// schema.sql doesn't create migration_history, so the table doesn't exist.
	migrations, err := repo.GetMigrations(ctx)
	if err != nil {
		t.Fatalf("GetMigrations (no table) returned error: %v", err)
	}
	if len(migrations) != 0 {
		t.Errorf("expected 0 migrations, got %d", len(migrations))
	}
}

// TestRepository_QueryErrors covers the QueryContext error branches by closing the DB.
func TestRepository_QueryErrors(t *testing.T) {
	repo := setupTestDB(t)
	ctx := context.Background()

	// Insert minimal data before closing.
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'T1','t1',1),(2,'T2','t2',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id, title, slug, content, author_id, status, published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1,1),(1,2)`)
	_, _ = repo.DB().Exec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum) VALUES (1,'f','originals/2024/01/f','image','image/jpeg',100,'c1')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (1,1.0,2.0)`)

	// Close the DB — all subsequent queries will fail.
	_ = repo.Close()

	// The extended functions should all return errors.
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
	if _, err := repo.GetYearTagsByLocationTagIDs(ctx, []int64{1}, 1); err == nil {
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

// TestRepository_UpsertTagLocation_InsertAndUpdate covers the UPDATE path (n > 0).
func TestRepository_UpsertTagLocation_InsertAndUpdate(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)

	// First call: no existing location → INSERT path (n == 0).
	if err := repo.UpsertTagLocation(ctx, 1, 48.85, 2.35); err != nil {
		t.Fatalf("UpsertTagLocation (insert): %v", err)
	}
	// Second call: existing location → UPDATE path (n > 0).
	if err := repo.UpsertTagLocation(ctx, 1, 50.0, 3.0); err != nil {
		t.Fatalf("UpsertTagLocation (update): %v", err)
	}
}

// TestRepository_DeleteSessionPaths covers both n==0 (not found) and n>0 (deleted) paths.
func TestRepository_DeleteSessionPaths(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Not found → error.
	err := repo.DeleteSession(ctx, models.DeleteSessionParams{ID: 9999, UserID: 1})
	if err == nil {
		t.Error("expected error for non-existent session")
	}

	// Create user and session, then delete → success.
	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	res, _ := repo.DB().Exec(`INSERT INTO sessions (user_id,token,ip_address,user_agent,expires_at) VALUES (1,'tok','127.0.0.1','ua',datetime('now','+1 hour'))`)
	sessionID, _ := res.LastInsertId()
	err = repo.DeleteSession(ctx, models.DeleteSessionParams{ID: sessionID, UserID: 1})
	if err != nil {
		t.Errorf("DeleteSession (found): %v", err)
	}
}

// TestRepository_GetMigrations_EmptyHistory covers the items==nil → [] assignment.
func TestRepository_GetMigrations_EmptyHistory(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Create migration_history table with no records.
	_, _ = repo.DB().Exec(`CREATE TABLE IF NOT EXISTS migration_history (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name VARCHAR(255) NOT NULL UNIQUE,
		applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`)

	migrations, err := repo.GetMigrations(ctx)
	if err != nil {
		t.Fatalf("GetMigrations: %v", err)
	}
	if len(migrations) != 0 {
		t.Errorf("expected 0 migrations, got %d", len(migrations))
	}
}

// TestRepository_GetMigrations_WithRecord covers the row-scan path in GetMigrations.
func TestRepository_GetMigrations_WithRecord(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Apply a real migration so migration_history has a row.
	if err := repo.ApplyMigration(ctx, "test_migration", "SELECT 1"); err != nil {
		t.Fatalf("ApplyMigration: %v", err)
	}

	migrations, err := repo.GetMigrations(ctx)
	if err != nil {
		t.Fatalf("GetMigrations: %v", err)
	}
	if len(migrations) == 0 {
		t.Error("expected at least 1 migration")
	}
}

// TestRepository_BranchCoverage covers various uncovered conditional branches.
func TestRepository_BranchCoverage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'T','t',1)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (1,1)`)

	// GetPostNavigation with publicOnly=false (covers the !publicOnly statusFilter branch).
	_, _, err := repo.GetPostNavigation(ctx, 1, false)
	if err != nil {
		t.Fatalf("GetPostNavigation (not public): %v", err)
	}

	// CountMediaFiltered with non-empty folder (covers folderPrefix assignment).
	_, err = repo.CountMediaFiltered(ctx, "image", "2024/01")
	if err != nil {
		t.Fatalf("CountMediaFiltered with folder: %v", err)
	}

	// GetPostsByTagIDs with includeDrafts=true (covers statusClause = "1=1" branch).
	_, err = repo.GetPostsByTagIDs(ctx, []int64{1}, false, true, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs (includeDrafts): %v", err)
	}

	// GetPostsByTagIDs with publishedOnly=false, includeDrafts=false (covers IN ('published','hidden') branch).
	_, err = repo.GetPostsByTagIDs(ctx, []int64{1}, false, false, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs (not published only): %v", err)
	}

	// GetPostsByTagIDs with includeHidden=true (covers authenticated user branch).
	_, err = repo.GetPostsByTagIDs(ctx, []int64{1}, false, false, true, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs (includeHidden): %v", err)
	}

	// CountPostsByTagIDs with includeDrafts=true.
	_, err = repo.CountPostsByTagIDs(ctx, []int64{1}, false, true, false)
	if err != nil {
		t.Fatalf("CountPostsByTagIDs (includeDrafts): %v", err)
	}

	// CountPostsByTagIDs with publishedOnly=false.
	_, err = repo.CountPostsByTagIDs(ctx, []int64{1}, false, false, false)
	if err != nil {
		t.Fatalf("CountPostsByTagIDs (not published only): %v", err)
	}

	// CountPostsByTagIDs with includeHidden=true (covers authenticated user branch).
	_, err = repo.CountPostsByTagIDs(ctx, []int64{1}, false, false, true)
	if err != nil {
		t.Fatalf("CountPostsByTagIDs (includeHidden): %v", err)
	}

	// ListOrphanedMediaByPage with data.
	_, _, err = repo.ListOrphanedMediaByPage(ctx, 10, 0)
	if err != nil {
		t.Fatalf("ListOrphanedMediaByPage: %v", err)
	}

	// CountPostsByTagIDs with empty tagIDs → early return nil path.
	n, err := repo.CountPostsByTagIDs(ctx, []int64{}, false, false, false)
	if err != nil || n != 0 {
		t.Errorf("CountPostsByTagIDs empty: err=%v n=%d", err, n)
	}

	// CountPostsByTagIDs with 2 tagIDs → covers the `placeholders += ","` branch.
	_, _ = repo.CountPostsByTagIDs(ctx, []int64{1, 2}, false, false, false)

	// GetPostsByTagIDs with empty tagIDs → early return nil path.
	posts, err := repo.GetPostsByTagIDs(ctx, []int64{}, false, false, false, 10, 0)
	if err != nil || len(posts) != 0 {
		t.Errorf("GetPostsByTagIDs empty: err=%v len=%d", err, len(posts))
	}

	// GetPostsByTagIDs with 2 tagIDs → covers comma separator path; no matching posts → items nil → items=[].
	_, _ = repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (2,'T2','t2',0)`)
	_, err = repo.GetPostsByTagIDs(ctx, []int64{1, 2}, false, false, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDs multi-tag: %v", err)
	}

	// GetAllPublishedPostContents with no published posts → early len==0 return.
	contents, err := repo.GetAllPublishedPostContents(ctx)
	if err != nil {
		t.Fatalf("GetAllPublishedPostContents empty: %v", err)
	}
	_ = contents
}

// TestRepository_GetPublishedPostsForSitemap_RFC3339 covers the alternative time parse branch.
func TestRepository_GetPublishedPostsForSitemap_RFC3339(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	// Store published_at in RFC3339 format to trigger the alternative time.Parse branch.
	_, _ = repo.DB().Exec(`INSERT INTO posts (id,title,slug,content,author_id,status,published_at) VALUES (1,'P','p','b',1,'published','2024-01-01T12:00:00Z')`)

	items, err := repo.GetPublishedPostsForSitemap(ctx)
	if err != nil {
		t.Fatalf("GetPublishedPostsForSitemap RFC3339: %v", err)
	}
	_ = items
}

// TestRepository_ExecErrors covers ExecContext error branches with a closed DB.
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

// TestNewRepository_MemorySharedCache tests NewRepository with a shared-cache memory URL.
// Attempting WAL mode on memory DB triggers the warning branch.
func TestNewRepository_MemorySharedCache(t *testing.T) {
	// Shared-cache in-memory DB; WAL mode will fail (memory DBs don't support WAL).
	repo, err := NewRepository("file::memory:?cache=shared")
	if err != nil {
		t.Logf("NewRepository memory shared: %v (expected on some drivers)", err)
		return
	}
	defer func() { _ = repo.Close() }()
	schema, _ := os.ReadFile("../../sql/schema.sql")
	if len(schema) > 0 {
		_, _ = repo.DB().Exec(string(schema))
	}
}

// TestNewRepository_InvalidPath covers the PRAGMA/Ping error paths by using a directory.
func TestNewRepository_InvalidPath(t *testing.T) {
	// Using a directory path as a SQLite DB will cause failure at Exec/Ping time.
	tmpDir := t.TempDir()
	repo, err := NewRepository(tmpDir) // directory, not file
	if err != nil {
		// Expected — PRAGMA or Ping failed.
		return
	}
	// If it somehow succeeded, close it.
	defer func() { _ = repo.Close() }()
}
