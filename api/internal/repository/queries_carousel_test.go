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

// The template queries are pure sqlc too. What is worth pinning is the UNIQUE
// slug upsert and the one deliberate asymmetry: the list query never selects
// doc, so a gallery of names cannot pull every inlined asset in the table.
func TestRepository_CarouselTemplates(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	if _, err := repo.GetCarouselTemplateBySlug(ctx, "zine"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetCarouselTemplateBySlug on empty: want sql.ErrNoRows, got %v", err)
	}
	empty, err := repo.ListCarouselTemplates(ctx)
	if err != nil {
		t.Fatalf("ListCarouselTemplates on empty: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("ListCarouselTemplates on empty: got %d rows", len(empty))
	}

	row, err := repo.UpsertCarouselTemplate(ctx, models.UpsertCarouselTemplateParams{
		Slug: "zine", Name: "Zine", Doc: `{"version":1}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarouselTemplate insert: %v", err)
	}
	if row.Slug != "zine" || row.Name != "Zine" || row.Doc != `{"version":1}` {
		t.Fatalf("insert returned %+v", row)
	}

	// Same slug upserts in place: name and doc replaced, id and created_at kept.
	row2, err := repo.UpsertCarouselTemplate(ctx, models.UpsertCarouselTemplateParams{
		Slug: "zine", Name: "Zine v2", Doc: `{"version":1,"aspect":"1:1"}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarouselTemplate update: %v", err)
	}
	if row2.ID != row.ID {
		t.Fatalf("upsert inserted a new row: id %d -> %d", row.ID, row2.ID)
	}
	if row2.Name != "Zine v2" || row2.Doc != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("upsert did not replace: %+v", row2)
	}

	// A second slug, sorting ahead of the first: the list is ordered by name.
	if _, err := repo.UpsertCarouselTemplate(ctx, models.UpsertCarouselTemplateParams{
		Slug: "album", Name: "Album", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatalf("UpsertCarouselTemplate second: %v", err)
	}
	list, err := repo.ListCarouselTemplates(ctx)
	if err != nil {
		t.Fatalf("ListCarouselTemplates: %v", err)
	}
	if len(list) != 2 || list[0].Slug != "album" || list[1].Slug != "zine" {
		t.Fatalf("ListCarouselTemplates returned %+v", list)
	}
	// The row type has no Doc field at all — this is the compile-time half of
	// the guarantee, and the type would have to change for it to regress.
	if list[1].Name != "Zine v2" {
		t.Fatalf("list row lost the updated name: %+v", list[1])
	}

	if err := repo.DeleteCarouselTemplate(ctx, "zine"); err != nil {
		t.Fatalf("DeleteCarouselTemplate: %v", err)
	}
	if _, err := repo.GetCarouselTemplateBySlug(ctx, "zine"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("after delete: want sql.ErrNoRows, got %v", err)
	}
	// Idempotent.
	if err := repo.DeleteCarouselTemplate(ctx, "zine"); err != nil {
		t.Fatalf("DeleteCarouselTemplate on absent row: %v", err)
	}
}
