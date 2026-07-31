package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// newTestDB creates a posts table with the three columns the tool touches.
func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	_, err = db.Exec(`CREATE TABLE posts (
		id INTEGER PRIMARY KEY,
		title TEXT NOT NULL DEFAULT '',
		content TEXT NOT NULL DEFAULT '',
		thumbnail_path TEXT NOT NULL DEFAULT ''
	)`)
	if err != nil {
		t.Fatalf("create table: %v", err)
	}
	return db
}

func insertPost(t *testing.T, db *sql.DB, id int, title, content, thumb string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO posts (id, title, content, thumbnail_path) VALUES (?, ?, ?, ?)`,
		id, title, content, thumb)
	if err != nil {
		t.Fatalf("insert %d: %v", id, err)
	}
}

func TestStripMediaOriginals(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"legacy path", "/media/originals/2024/03/pic.jpg", "/2024/03/pic.jpg"},
		{"already simplified", "/2024/03/pic.jpg", "/2024/03/pic.jpg"},
		{"empty", "", ""},
		{"unrelated path", "/static/logo.png", "/static/logo.png"},
		// Replace(..., 1) — only the first occurrence is rewritten.
		{"repeated prefix", "/media/originals/a/media/originals/b", "/a/media/originals/b"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := stripMediaOriginals(tc.in); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCleanContent(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		want        string
		wantChanged bool
	}{
		{
			name:        "legacy path in markdown image",
			in:          "![alt](/media/originals/2024/03/pic.jpg)",
			want:        "/2024/03/pic.jpg",
			wantChanged: true,
		},
		{
			name:        "bare legacy path",
			in:          "see /media/originals/2024/03/pic.jpg here",
			want:        "see /2024/03/pic.jpg here",
			wantChanged: true,
		},
		{
			name:        "plain text untouched",
			in:          "no images here",
			want:        "no images here",
			wantChanged: false,
		},
		{
			name:        "empty",
			in:          "",
			want:        "",
			wantChanged: false,
		},
		{
			name:        "multiple images",
			in:          "![a](/media/originals/x.jpg)\n![b](/media/originals/y.jpg)",
			want:        "/x.jpg\n/y.jpg",
			wantChanged: true,
		},
		{
			// Documents a side effect wider than the tool's doc comment claims:
			// markdown image syntax is unwrapped on EVERY image, including ones
			// that never had a /media/originals/ prefix. Pinned deliberately —
			// if this is ever narrowed to legacy paths only, this test should
			// fail and be updated. See point-test-migrations-coverage-jrtd.
			name:        "non-legacy image is also unwrapped",
			in:          "![alt](/2024/03/pic.jpg)",
			want:        "/2024/03/pic.jpg",
			wantChanged: true,
		},
		{
			name:        "external image is also unwrapped",
			in:          "![alt](https://example.com/pic.jpg)",
			want:        "https://example.com/pic.jpg",
			wantChanged: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, changed := cleanContent(tc.in)
			if got != tc.want {
				t.Errorf("content: got %q, want %q", got, tc.want)
			}
			if changed != tc.wantChanged {
				t.Errorf("changed: got %v, want %v", changed, tc.wantChanged)
			}
		})
	}
}

func TestTruncate(t *testing.T) {
	tests := []struct {
		name string
		in   string
		max  int
		want string
	}{
		{"under limit", "short", 40, "short"},
		{"exactly at limit", "abcde", 5, "abcde"},
		{"over limit", "abcdefgh", 5, "abcd…"},
		{"empty", "", 5, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := truncate(tc.in, tc.max); got != tc.want {
				t.Errorf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestPreviewThumbnailPathsCountsOnlyLegacyRows(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "legacy", "", "/media/originals/2024/03/a.jpg")
	insertPost(t, db, 2, "already migrated", "", "/2024/03/b.jpg")
	insertPost(t, db, 3, "no thumbnail", "", "")
	insertPost(t, db, 4, "another legacy", "", "/media/originals/2025/01/c.jpg")

	count, err := previewThumbnailPaths(db)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if count != 2 {
		t.Errorf("got %d, want 2", count)
	}

	// A preview must not write anything.
	var thumb string
	if err := db.QueryRow(`SELECT thumbnail_path FROM posts WHERE id = 1`).Scan(&thumb); err != nil {
		t.Fatal(err)
	}
	if thumb != "/media/originals/2024/03/a.jpg" {
		t.Errorf("dry run mutated the database: thumbnail_path = %q", thumb)
	}
}

func TestPreviewContentPathsCountsChangedRows(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "has legacy path", "![a](/media/originals/x.jpg)", "")
	insertPost(t, db, 2, "plain text", "nothing to change", "")
	insertPost(t, db, 3, "bare legacy path", "/media/originals/y.jpg", "")

	count, err := previewContentPaths(db)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if count != 2 {
		t.Errorf("got %d, want 2", count)
	}

	var content string
	if err := db.QueryRow(`SELECT content FROM posts WHERE id = 1`).Scan(&content); err != nil {
		t.Fatal(err)
	}
	if content != "![a](/media/originals/x.jpg)" {
		t.Errorf("dry run mutated the database: content = %q", content)
	}
}

func TestApplyThumbnailPaths(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "legacy", "", "/media/originals/2024/03/a.jpg")
	insertPost(t, db, 2, "already migrated", "", "/2024/03/b.jpg")
	insertPost(t, db, 3, "empty", "", "")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := applyThumbnailPaths(tx); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	want := map[int]string{
		1: "/2024/03/a.jpg",
		2: "/2024/03/b.jpg",
		3: "",
	}
	for id, expected := range want {
		var got string
		if err := db.QueryRow(`SELECT thumbnail_path FROM posts WHERE id = ?`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != expected {
			t.Errorf("post %d: got %q, want %q", id, got, expected)
		}
	}
}

func TestApplyContentPaths(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "legacy image", "![a](/media/originals/x.jpg)", "")
	insertPost(t, db, 2, "plain", "nothing to change", "")
	insertPost(t, db, 3, "bare path", "see /media/originals/y.jpg", "")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := applyContentPaths(tx, db); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	want := map[int]string{
		1: "/x.jpg",
		2: "nothing to change",
		3: "see /y.jpg",
	}
	for id, expected := range want {
		var got string
		if err := db.QueryRow(`SELECT content FROM posts WHERE id = ?`, id).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != expected {
			t.Errorf("post %d: got %q, want %q", id, got, expected)
		}
	}
}

// The tool wraps both updates in one transaction. A rollback must leave the
// database exactly as it was — this is the safety property that matters for a
// tool that rewrites user content in place.
func TestApplyRollbackLeavesDataUntouched(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "legacy", "![a](/media/originals/x.jpg)", "/media/originals/2024/03/a.jpg")

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := applyThumbnailPaths(tx); err != nil {
		t.Fatal(err)
	}
	if err := applyContentPaths(tx, db); err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatal(err)
	}

	var content, thumb string
	if err := db.QueryRow(`SELECT content, thumbnail_path FROM posts WHERE id = 1`).
		Scan(&content, &thumb); err != nil {
		t.Fatal(err)
	}
	if content != "![a](/media/originals/x.jpg)" {
		t.Errorf("content survived rollback as %q", content)
	}
	if thumb != "/media/originals/2024/03/a.jpg" {
		t.Errorf("thumbnail_path survived rollback as %q", thumb)
	}
}

// Running the migration twice must be a no-op the second time.
func TestApplyIsIdempotent(t *testing.T) {
	db := newTestDB(t)
	insertPost(t, db, 1, "legacy", "![a](/media/originals/x.jpg)", "/media/originals/2024/03/a.jpg")

	for pass := 1; pass <= 2; pass++ {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		if err := applyThumbnailPaths(tx); err != nil {
			t.Fatalf("pass %d thumbnails: %v", pass, err)
		}
		if err := applyContentPaths(tx, db); err != nil {
			t.Fatalf("pass %d content: %v", pass, err)
		}
		if err := tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}

	var content, thumb string
	if err := db.QueryRow(`SELECT content, thumbnail_path FROM posts WHERE id = 1`).
		Scan(&content, &thumb); err != nil {
		t.Fatal(err)
	}
	if content != "/x.jpg" {
		t.Errorf("content = %q, want /x.jpg", content)
	}
	if thumb != "/2024/03/a.jpg" {
		t.Errorf("thumbnail_path = %q, want /2024/03/a.jpg", thumb)
	}

	// After a completed migration the preview must report nothing left to do.
	n, err := previewThumbnailPaths(db)
	if err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("thumbnail preview still reports %d rows after migrating", n)
	}
}

// A missing posts table must surface as an error rather than a panic.
func TestPreviewErrorsOnMissingTable(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "empty.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	if _, err := previewThumbnailPaths(db); err == nil {
		t.Error("expected an error for a database with no posts table")
	}
	if _, err := previewContentPaths(db); err == nil {
		t.Error("expected an error for a database with no posts table")
	}
}
