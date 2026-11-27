package repository

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestRepository_ImportWriters(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	posts, media, err := repo.CountContentRows(ctx)
	if err != nil || posts != 0 || media != 0 {
		t.Fatalf("CountContentRows on a new database = %d, %d, %v", posts, media, err)
	}

	mustExec := func(q string) {
		t.Helper()
		if _, err := repo.DB().Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
	mustExec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1, 'u', 'u@x.com', 'h', 'U')`)
	mustExec(`INSERT INTO posts (id, title, slug, content, formatter, status, type, author_id, deleted_at)
		VALUES (1, 't', 's', '', 'markdown', 'draft', 'post', 1, '2024-01-01 00:00:00')`)
	mustExec(`INSERT INTO media (id, filename, original_path, file_type, mime_type, file_size, checksum)
		VALUES (1, 'a.jpg', 'originals/2024/01/a.jpg', 'image', 'image/jpeg', 1, 'c')`)

	// The trash counts: an instance with a trashed post is not empty.
	posts, media, err = repo.CountContentRows(ctx)
	if err != nil || posts != 1 || media != 1 {
		t.Fatalf("CountContentRows = %d, %d, %v, want 1, 1", posts, media, err)
	}

	created := time.Date(2024, 1, 5, 17, 0, 0, 0, time.UTC)
	updated := time.Date(2024, 1, 6, 9, 0, 0, 0, time.FixedZone("x", 3600))
	if err := repo.SetPostTimestamps(ctx, 1, created, updated, sql.NullTime{Time: created, Valid: true}); err != nil {
		t.Fatal(err)
	}
	var c, u, p string
	if err := repo.DB().QueryRow(`SELECT created_at, updated_at, published_at FROM posts WHERE id = 1`).Scan(&c, &u, &p); err != nil {
		t.Fatal(err)
	}
	if c != "2024-01-05T17:00:00Z" && c != "2024-01-05 17:00:00" {
		t.Errorf("created_at = %q", c)
	}
	if u != "2024-01-06T08:00:00Z" && u != "2024-01-06 08:00:00" {
		t.Errorf("updated_at = %q, want the UTC time", u)
	}
	if err := repo.SetPostTimestamps(ctx, 1, created, updated, sql.NullTime{}); err != nil {
		t.Fatal(err)
	}
	var pub sql.NullString
	_ = repo.DB().QueryRow(`SELECT published_at FROM posts WHERE id = 1`).Scan(&pub)
	if pub.Valid {
		t.Errorf("published_at = %q, want NULL", pub.String)
	}

	if err := repo.SetImportedMediaFields(ctx, 1, sql.NullInt64{Int64: 1, Valid: true}, created,
		sql.NullString{String: `{"Make":"X"}`, Valid: true}, sql.NullString{}); err != nil {
		t.Fatal(err)
	}
	var postID int64
	var meta string
	var orig sql.NullString
	if err := repo.DB().QueryRow(`SELECT post_id, metadata, original_metadata FROM media WHERE id = 1`).Scan(&postID, &meta, &orig); err != nil {
		t.Fatal(err)
	}
	if postID != 1 || meta != `{"Make":"X"}` || orig.Valid {
		t.Errorf("media fields = %d %q %v", postID, meta, orig)
	}
}
