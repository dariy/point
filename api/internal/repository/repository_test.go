package repository

import (
	"context"
	"fmt"
	"testing"
)

func setupTestDB(t *testing.T) Repository {
	repo, err := NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create test repository: %v", err)
	}

	return repo
}

// setupNewSchemaTestDB creates an in-memory test DB with the post-migration schema
// (typed flag columns on tags, no tag_locations table, sort_order on tag_relationships).
func setupNewSchemaTestDB(t *testing.T) Repository {
	t.Helper()
	repo := setupTestDB(t)
	if err := repo.MigrateTagFlagsFromSystemTags(context.Background()); err != nil {
		t.Fatalf("MigrateTagFlagsFromSystemTags: %v", err)
	}
	return repo
}

// helpers: insert a user and a published post, return (userID, postID).
func insertUserAndPost(t *testing.T, repo Repository, slug, status string) (int64, int64) {
	t.Helper()
	if _, err := repo.DB().Exec(
		`INSERT OR IGNORE INTO users (username, email, password_hash, display_name) VALUES ('u1','e1','h','D')`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	// Always resolve uid by lookup: on repeat calls the INSERT OR IGNORE is a
	// no-op and LastInsertId would return the previous post's rowid, not the user.
	var uid int64
	if err := repo.DB().QueryRow(`SELECT id FROM users WHERE username='u1'`).Scan(&uid); err != nil {
		t.Fatalf("lookup user: %v", err)
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

func TestIsDuplicateColumnError(t *testing.T) {
	err := fmt.Errorf("duplicate column name: test")
	if !isDuplicateColumnError(err) {
		t.Errorf("expected true for duplicate column error")
	}

	err2 := fmt.Errorf("some other error")
	if isDuplicateColumnError(err2) {
		t.Errorf("expected false for other error")
	}
}
