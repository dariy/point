package repository

import (
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

// helpers: insert a user and a published post, return (userID, postID).
func insertUserAndPost(t *testing.T, repo Repository, slug, status string) (int64, int64) {
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
