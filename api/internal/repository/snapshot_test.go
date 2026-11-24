package repository

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSnapshotHelpers(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := repo.DB().Exec(
		`INSERT INTO users (username, email, password_hash, display_name) VALUES ('snap','s@x.com','h','Snap')`,
	); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// A path with a space and a "?" must not break the URI form.
	path := filepath.Join(t.TempDir(), "a dir?", "snap.db")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := repo.BackupDB(ctx, path); err != nil {
		t.Fatalf("BackupDB: %v", err)
	}
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	counts, err := SnapshotTableCounts(ctx, path)
	if err != nil {
		t.Fatalf("SnapshotTableCounts: %v", err)
	}
	if counts["users"] != 1 {
		t.Errorf("users = %d, want 1 (all: %v)", counts["users"], counts)
	}
	for name := range counts {
		if len(name) > 7 && name[:7] == "sqlite_" {
			t.Errorf("internal table %s is counted", name)
		}
	}

	res, err := SnapshotQuickCheck(ctx, path)
	if err != nil || res != "ok" {
		t.Errorf("SnapshotQuickCheck = %q, %v; want ok", res, err)
	}

	// Read-only: the file is as before.
	if after, err := os.Stat(path); err != nil || !after.ModTime().Equal(before.ModTime()) || after.Size() != before.Size() {
		t.Errorf("the snapshot changed: %v -> %v (%v)", before, after, err)
	}

	// A file that is not a database fails.
	bad := filepath.Join(t.TempDir(), "bad.db")
	if err := os.WriteFile(bad, []byte("not a database at all, just text"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := SnapshotQuickCheck(ctx, bad); err == nil {
		t.Error("SnapshotQuickCheck on a text file: want an error")
	}
	if _, err := SnapshotTableCounts(ctx, bad); err == nil {
		t.Error("SnapshotTableCounts on a text file: want an error")
	}
}
