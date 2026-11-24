package models

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// TestTrashQueries examines the media and post trash queries against real
// rows: a live row, a row trashed today, and a row trashed 31 days ago.
func TestTrashQueries(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	u, err := q.CreateUser(ctx, CreateUserParams{Username: "tr", Email: "tr@t.com", PasswordHash: "h", DisplayName: "T"})
	if err != nil {
		t.Fatal(err)
	}
	post, err := q.CreatePost(ctx, CreatePostParams{Title: "P", Slug: "p", AuthorID: u.ID, Status: "draft"})
	if err != nil {
		t.Fatal(err)
	}
	oldPost, err := q.CreatePost(ctx, CreatePostParams{Title: "Old", Slug: "old", AuthorID: u.ID, Status: "draft"})
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now().UTC().Round(0)
	postID := sql.NullInt64{Int64: post.ID, Valid: true}
	live, err := q.CreateMedia(ctx, CreateMediaParams{Filename: "live.jpg", Checksum: "c-live", FileType: "image", PostID: postID, UploadedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := q.CreateMedia(ctx, CreateMediaParams{Filename: "fresh.jpg", Checksum: "c-fresh", FileType: "image", PostID: postID, UploadedAt: now})
	if err != nil {
		t.Fatal(err)
	}
	expired, err := q.CreateMedia(ctx, CreateMediaParams{Filename: "expired.jpg", Checksum: "c-expired", FileType: "image", UploadedAt: now})
	if err != nil {
		t.Fatal(err)
	}

	mustExec := func(stmt string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, stmt, args...); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	mustExec(`UPDATE media SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, fresh.ID)
	mustExec(`UPDATE media SET deleted_at = datetime('now', '-31 days') WHERE id = ?`, expired.ID)
	mustExec(`UPDATE posts SET deleted_at = datetime('now', '-31 days') WHERE id = ?`, oldPost.ID)
	mustExec(`UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?`, post.ID)

	// The live queries skip trashed rows.
	byPost, err := q.GetMediaByPostID(ctx, postID)
	if err != nil {
		t.Fatal(err)
	}
	if len(byPost) != 1 || byPost[0].ID != live.ID {
		t.Errorf("GetMediaByPostID: got %v, want only media %d", byPost, live.ID)
	}
	listed, err := q.ListMedia(ctx, ListMediaParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].ID != live.ID {
		t.Errorf("ListMedia: got %d rows, want only media %d", len(listed), live.ID)
	}

	// The trash queries return trashed rows only, newest first.
	trashed, err := q.ListTrashedMedia(ctx, ListTrashedMediaParams{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(trashed) != 2 || trashed[0].ID != fresh.ID || trashed[1].ID != expired.ID {
		t.Errorf("ListTrashedMedia: got %v, want [%d %d]", trashed, fresh.ID, expired.ID)
	}
	if !trashed[0].DeletedAt.Valid {
		t.Error("ListTrashedMedia: DeletedAt is not set")
	}
	n, err := q.CountTrashedMedia(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("CountTrashedMedia = %d, want 2", n)
	}

	// Only the row older than 30 days has expired.
	ids, err := q.ListExpiredTrashedMediaIDs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(ids) != 1 || ids[0] != expired.ID {
		t.Errorf("ListExpiredTrashedMediaIDs = %v, want [%d]", ids, expired.ID)
	}

	purged, err := q.PurgeExpiredTrashedPosts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if purged != 1 {
		t.Errorf("PurgeExpiredTrashedPosts = %d, want 1", purged)
	}
	// The post trashed today stays in the trash.
	left, err := q.CountTrashedPosts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if left != 1 {
		t.Errorf("CountTrashedPosts after purge = %d, want 1", left)
	}
}

// TestTrashQueries_ClosedDB examines the error returns of the trash queries.
func TestTrashQueries_ClosedDB(t *testing.T) {
	q, db := setupTestDB(t)
	_ = db.Close()
	ctx := context.Background()

	if _, err := q.ListTrashedMedia(ctx, ListTrashedMediaParams{Limit: 1}); err == nil {
		t.Error("ListTrashedMedia: expected error on closed db")
	}
	if _, err := q.CountTrashedMedia(ctx); err == nil {
		t.Error("CountTrashedMedia: expected error on closed db")
	}
	if _, err := q.ListExpiredTrashedMediaIDs(ctx); err == nil {
		t.Error("ListExpiredTrashedMediaIDs: expected error on closed db")
	}
	if _, err := q.PurgeExpiredTrashedPosts(ctx); err == nil {
		t.Error("PurgeExpiredTrashedPosts: expected error on closed db")
	}
}
