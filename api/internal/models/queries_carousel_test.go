package models

import (
	"context"
	"database/sql"
	"errors"
	"testing"
)

// The carousel_templates queries are driven end to end from the repository and
// handler packages, but `go test ./...` carries no -coverpkg, so a call that
// crosses a package boundary attributes nothing back here. These tests exist to
// exercise the generated methods in their own package. See
// scripts/coverage-gate.sh for the single coverage number they feed.
func TestQueries_CarouselTemplates(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	// Empty store: :many returns no rows and no error.
	list, err := q.ListCarouselTemplates(ctx)
	if err != nil {
		t.Fatalf("ListCarouselTemplates on an empty table: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("empty table listed %d rows", len(list))
	}

	// Absent slug: :one surfaces sql.ErrNoRows, which is what the handler
	// turns into a 404.
	if _, err := q.GetCarouselTemplateBySlug(ctx, "nope"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("GetCarouselTemplateBySlug on an absent slug: want sql.ErrNoRows, got %v", err)
	}

	const doc = `{"version":1,"aspect":"4:5"}`
	row, err := q.UpsertCarouselTemplate(ctx, UpsertCarouselTemplateParams{
		Slug: "zine", Name: "Zine", Doc: doc,
	})
	if err != nil {
		t.Fatalf("UpsertCarouselTemplate: %v", err)
	}
	if row.Slug != "zine" || row.Name != "Zine" || row.Doc != doc {
		t.Fatalf("UpsertCarouselTemplate returned %+v", row)
	}
	if row.ID == 0 || row.CreatedAt.IsZero() || row.UpdatedAt.IsZero() {
		t.Fatalf("UpsertCarouselTemplate left id/timestamps unset: %+v", row)
	}

	if _, err := q.UpsertCarouselTemplate(ctx, UpsertCarouselTemplateParams{
		Slug: "album", Name: "Album", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatalf("UpsertCarouselTemplate second row: %v", err)
	}

	// ON CONFLICT(slug) replaces name and doc in place rather than inserting.
	replaced, err := q.UpsertCarouselTemplate(ctx, UpsertCarouselTemplateParams{
		Slug: "zine", Name: "Zine v2", Doc: `{"version":1,"aspect":"1:1"}`,
	})
	if err != nil {
		t.Fatalf("UpsertCarouselTemplate replace: %v", err)
	}
	if replaced.ID != row.ID || replaced.Name != "Zine v2" {
		t.Fatalf("replace did not update in place: was %+v, now %+v", row, replaced)
	}

	got, err := q.GetCarouselTemplateBySlug(ctx, "zine")
	if err != nil {
		t.Fatalf("GetCarouselTemplateBySlug: %v", err)
	}
	if got.Doc != `{"version":1,"aspect":"1:1"}` {
		t.Fatalf("GetCarouselTemplateBySlug returned doc %q", got.Doc)
	}

	// ORDER BY name, and no doc column in the row at all.
	list, err = q.ListCarouselTemplates(ctx)
	if err != nil {
		t.Fatalf("ListCarouselTemplates: %v", err)
	}
	if len(list) != 2 || list[0].Slug != "album" || list[1].Slug != "zine" {
		t.Fatalf("ListCarouselTemplates returned %+v", list)
	}
	if list[1].Name != "Zine v2" || list[1].CreatedAt.IsZero() {
		t.Fatalf("listed row is incomplete: %+v", list[1])
	}

	if err := q.DeleteCarouselTemplate(ctx, "zine"); err != nil {
		t.Fatalf("DeleteCarouselTemplate: %v", err)
	}
	// Deleting an absent slug is not an error — the handler answers 204 twice.
	if err := q.DeleteCarouselTemplate(ctx, "zine"); err != nil {
		t.Fatalf("DeleteCarouselTemplate is not idempotent: %v", err)
	}
	if _, err := q.GetCarouselTemplateBySlug(ctx, "zine"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("row survived the delete: %v", err)
	}
}

// A dropped table is the cheapest way to reach the driver-error return in each
// generated method — the paths a handler propagates as a 500.
func TestQueries_CarouselTemplates_DBError(t *testing.T) {
	q, db := setupTestDB(t)
	defer func() { _ = db.Close() }()
	ctx := context.Background()

	if _, err := db.Exec(`DROP TABLE carousel_templates`); err != nil {
		t.Fatalf("drop carousel_templates: %v", err)
	}

	if _, err := q.ListCarouselTemplates(ctx); err == nil {
		t.Error("ListCarouselTemplates: want an error against a dropped table")
	}
	if _, err := q.GetCarouselTemplateBySlug(ctx, "zine"); err == nil {
		t.Error("GetCarouselTemplateBySlug: want an error against a dropped table")
	}
	if _, err := q.UpsertCarouselTemplate(ctx, UpsertCarouselTemplateParams{
		Slug: "zine", Name: "Zine", Doc: `{}`,
	}); err == nil {
		t.Error("UpsertCarouselTemplate: want an error against a dropped table")
	}
	if err := q.DeleteCarouselTemplate(ctx, "zine"); err == nil {
		t.Error("DeleteCarouselTemplate: want an error against a dropped table")
	}
}
