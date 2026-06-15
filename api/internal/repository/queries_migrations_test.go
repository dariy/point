package repository

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// TestRepository_InstagramColumnsMigration verifies that opening a pre-existing
// database (one created before the Instagram integration) backfills the new
// posts.instagram_* columns via the ADD COLUMN migration path (point-xq28).
func TestRepository_InstagramColumnsMigration(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "old.db")

	// Seed an "old" database: the four core tables NewRepository checks for,
	// with a posts table that predates the Instagram columns.
	seed, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open seed db: %v", err)
	}
	for _, stmt := range []string{
		`CREATE TABLE users (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE tags (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE blog_settings (id INTEGER PRIMARY KEY)`,
		`CREATE TABLE posts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			title TEXT NOT NULL,
			slug TEXT NOT NULL,
			content TEXT NOT NULL,
			author_id INTEGER NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft'
		)`,
	} {
		if _, err := seed.Exec(stmt); err != nil {
			t.Fatalf("seed stmt %q: %v", stmt, err)
		}
	}
	if err := seed.Close(); err != nil {
		t.Fatalf("close seed db: %v", err)
	}

	// Reopen through the real constructor, which runs the migrations.
	repo, err := NewRepository(dbPath)
	if err != nil {
		t.Fatalf("NewRepository (migrate) failed: %v", err)
	}
	defer func() { _ = repo.Close() }()

	for _, col := range []string{
		"instagram_share",
		"instagram_status",
		"instagram_media_id",
		"instagram_published_at",
		"instagram_error",
	} {
		var count int
		if err := repo.DB().QueryRow(
			`SELECT COUNT(*) FROM pragma_table_info('posts') WHERE name = ?`, col,
		).Scan(&count); err != nil {
			t.Fatalf("pragma_table_info(%q): %v", col, err)
		}
		if count != 1 {
			t.Errorf("expected migrated column posts.%s to exist, found %d", col, count)
		}
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

func TestRepository_MigrateFlagsToSystemTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags failed: %v", err)
	}
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags (idempotent) failed: %v", err)
	}
}

func TestRepository_RebuildTagsTableDropBooleans(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans failed: %v", err)
	}
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans (idempotent) failed: %v", err)
	}
}

func TestRepository_MigrateWithOldSchema(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	boolCols := []string{
		"ALTER TABLE tags ADD COLUMN custom_url VARCHAR(200)",
		"ALTER TABLE tags ADD COLUMN sort_order INTEGER",
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

	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug, post_count, is_featured, is_hidden) VALUES ('Featured','featured',1,1,0)`)

	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags (old schema) failed: %v", err)
	}
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		t.Fatalf("MigrateFlagsToSystemTags idempotent: %v", err)
	}
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans (old schema) failed: %v", err)
	}
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		t.Fatalf("RebuildTagsTableDropBooleans idempotent: %v", err)
	}
}

func TestRepository_ApplyMigrationBadSQL(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	err := repo.ApplyMigration(ctx, "bad_migration_test", "INVALID SQL STATEMENT !!!")
	if err == nil {
		t.Error("expected error for invalid SQL, got nil")
	}
}

func TestRepository_GetMigrationsNoTable(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	migrations, err := repo.GetMigrations(ctx)
	if err != nil {
		t.Fatalf("GetMigrations (no table) returned error: %v", err)
	}
	if len(migrations) != 0 {
		t.Errorf("expected 0 migrations, got %d", len(migrations))
	}
}

func TestRepository_GetMigrations_EmptyHistory(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

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

func TestRepository_GetMigrations_WithRecord(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

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

func TestRepository_EnsureSystemTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if err := repo.EnsureSystemTags(ctx); err != nil {
		t.Fatalf("EnsureSystemTags failed: %v", err)
	}
	// Idempotent
	if err := repo.EnsureSystemTags(ctx); err != nil {
		t.Fatalf("EnsureSystemTags idempotent failed: %v", err)
	}

	// Test conflict rename
	_, _ = repo.DB().Exec(`DELETE FROM migration_history WHERE name = 'ensure_system_tags'`)
	_, _ = repo.DB().Exec(`DELETE FROM tags WHERE slug = '_pending'`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('_pending', 'pending')`)

	if err := repo.EnsureSystemTags(ctx); err != nil {
		t.Fatalf("EnsureSystemTags with conflict failed: %v", err)
	}
}
