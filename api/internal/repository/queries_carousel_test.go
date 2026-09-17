package repository

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"point-api/internal/models"
)

// The carousel queries are pure sqlc, but the table's contract — one row per
// carousel block, upsert on (post_id, block_key), cascade on post delete — is
// worth pinning. Two carousels in one post are the point of the composite key:
// they round-trip independently, and neither verb on one can reach the other.
func TestRepository_Carousels(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, postID := insertUserAndPost(t, repo, "carousel-post", "draft")
	first := models.GetCarouselByBlockKeyParams{PostID: postID, BlockKey: "c-7f3a"}
	second := models.GetCarouselByBlockKeyParams{PostID: postID, BlockKey: "c-91b0"}

	// Absent.
	if _, err := repo.GetCarouselByBlockKey(ctx, first); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetCarouselByBlockKey on empty: want sql.ErrNoRows, got %v", err)
	}
	empty, err := repo.ListCarouselsByPostID(ctx, postID)
	if err != nil || len(empty) != 0 {
		t.Fatalf("ListCarouselsByPostID on empty: %d rows, err=%v", len(empty), err)
	}

	// Insert.
	row, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: postID, BlockKey: first.BlockKey, Doc: `{"version":1}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarousel insert: %v", err)
	}
	if row.Doc != `{"version":1}` || row.BlockKey != first.BlockKey {
		t.Fatalf("stored row = %+v", row)
	}

	// Upsert replaces the doc and keeps the row (same id), one row total.
	row2, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: postID, BlockKey: first.BlockKey, Doc: `{"version":1,"aspect":"1:1"}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarousel update: %v", err)
	}
	if row2.ID != row.ID {
		t.Fatalf("upsert made a new row: %d -> %d", row.ID, row2.ID)
	}
	got, err := repo.GetCarouselByBlockKey(ctx, first)
	if err != nil || got.Doc != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("after upsert: doc=%q err=%v", got.Doc, err)
	}

	// A second block in the same post is a second row, not a conflict — and
	// saving it leaves the first alone.
	other, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: postID, BlockKey: second.BlockKey, Doc: `{"version":2}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarousel second block: %v", err)
	}
	if other.ID == row.ID {
		t.Fatalf("the second block landed on the first block's row (id %d)", other.ID)
	}
	if got, err := repo.GetCarouselByBlockKey(ctx, first); err != nil || got.Doc != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("first block after saving the second: doc=%q err=%v", got.Doc, err)
	}

	// The listing carries both keys in id order and no doc at all — the same
	// deliberate asymmetry as ListCarouselTemplates, and the row type is the
	// compile-time half of it.
	list, err := repo.ListCarouselsByPostID(ctx, postID)
	if err != nil {
		t.Fatalf("ListCarouselsByPostID: %v", err)
	}
	if len(list) != 2 || list[0].BlockKey != first.BlockKey || list[1].BlockKey != second.BlockKey {
		t.Fatalf("ListCarouselsByPostID returned %+v", list)
	}

	// Delete is block-scoped: the other row survives.
	if err := repo.DeleteCarouselByBlockKey(ctx, models.DeleteCarouselByBlockKeyParams(second)); err != nil {
		t.Fatalf("DeleteCarouselByBlockKey: %v", err)
	}
	if _, err := repo.GetCarouselByBlockKey(ctx, second); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("after delete: want sql.ErrNoRows, got %v", err)
	}
	if _, err := repo.GetCarouselByBlockKey(ctx, first); err != nil {
		t.Fatalf("delete took the other block's row with it: %v", err)
	}
	// Idempotent.
	if err := repo.DeleteCarouselByBlockKey(ctx, models.DeleteCarouselByBlockKeyParams(second)); err != nil {
		t.Fatalf("DeleteCarouselByBlockKey on absent row: %v", err)
	}

	// The same key in a different post is a different row: the key is unique
	// per post, not globally.
	_, otherPost := insertUserAndPost(t, repo, "carousel-post-2", "draft")
	if _, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: otherPost, BlockKey: first.BlockKey, Doc: `{"version":3}`,
	}); err != nil {
		t.Fatalf("same key in another post: %v", err)
	}

	// Deleting the post cascades, and takes only its own rows.
	if _, err := repo.DB().ExecContext(ctx, `DELETE FROM posts WHERE id = ?`, postID); err != nil {
		t.Fatalf("delete post: %v", err)
	}
	var n int
	if err := repo.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM carousels WHERE post_id = ?`, postID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Fatalf("%d carousel rows survived the post delete", n)
	}
	if _, err := repo.GetCarouselByBlockKey(ctx, models.GetCarouselByBlockKeyParams{
		PostID: otherPost, BlockKey: first.BlockKey,
	}); err != nil {
		t.Fatalf("the other post's carousel went with the cascade: %v", err)
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
