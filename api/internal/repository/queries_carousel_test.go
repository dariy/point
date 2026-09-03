package repository

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"point-api/internal/models"
)

// The carousel queries are pure sqlc, but the table's contract — one row per
// post, upsert on post_id, cascade on post delete — is worth pinning.
func TestRepository_Carousels(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, postID := insertUserAndPost(t, repo, "carousel-post", "draft")

	// Absent.
	if _, err := repo.GetCarouselByPostID(ctx, postID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetCarouselByPostID on empty: want sql.ErrNoRows, got %v", err)
	}

	// Insert.
	row, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{PostID: postID, Doc: `{"version":1}`})
	if err != nil {
		t.Fatalf("UpsertCarousel insert: %v", err)
	}
	if row.Doc != `{"version":1}` {
		t.Fatalf("stored doc = %q", row.Doc)
	}

	// Upsert replaces the doc and keeps the row (same id), one row total.
	row2, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{PostID: postID, Doc: `{"version":1,"aspect":"1:1"}`})
	if err != nil {
		t.Fatalf("UpsertCarousel update: %v", err)
	}
	if row2.ID != row.ID {
		t.Fatalf("upsert made a new row: %d -> %d", row.ID, row2.ID)
	}
	got, err := repo.GetCarouselByPostID(ctx, postID)
	if err != nil || got.Doc != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("after upsert: doc=%q err=%v", got.Doc, err)
	}

	// Deleting the post cascades.
	if _, err := repo.DB().ExecContext(ctx, `DELETE FROM posts WHERE id = ?`, postID); err != nil {
		t.Fatalf("delete post: %v", err)
	}
	var n int
	if err := repo.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM carousels`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("carousel row survived post delete: %d", n)
	}

	// DeleteCarouselByPostID is idempotent.
	if err := repo.DeleteCarouselByPostID(ctx, postID); err != nil {
		t.Fatalf("DeleteCarouselByPostID on absent row: %v", err)
	}
}
