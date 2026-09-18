package main

import (
	"context"
	"testing"

	"point-api/internal/models"
	"point-api/internal/repository"
)

func TestLiveBlockKeys(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    []string
	}{
		{"no fence", "just some text", nil},
		{
			"keyless fence backfills to the empty key",
			":::{.carousel-block}\n\n/2026/01/a.jpg\n\n:::",
			[]string{""},
		},
		{
			"keyed fence",
			":::{.carousel-block #c-7f3a}\n\n/2026/01/a.jpg\n\n:::",
			[]string{"c-7f3a"},
		},
		{
			"attribute order and spacing tolerated, like a hand-edited fence",
			":::{ #c-7f3a .carousel-block }\n\n/2026/01/a.jpg\n\n:::",
			[]string{"c-7f3a"},
		},
		{
			"several blocks in one post",
			":::{.carousel-block #a}\n\n/x.jpg\n\n:::\n\ntext between\n\n:::{.carousel-block #b}\n\n/y.jpg\n\n:::",
			[]string{"a", "b"},
		},
		{
			"a fence with no carousel-block class names no key",
			":::{.gallery}\n\n/x.jpg\n\n:::",
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := liveBlockKeys(tt.content)
			if len(got) != len(tt.want) {
				t.Fatalf("liveBlockKeys(%q) = %v, want keys %v", tt.content, got, tt.want)
			}
			for _, k := range tt.want {
				if !got[k] {
					t.Errorf("liveBlockKeys(%q) missing key %q: got %v", tt.content, k, got)
				}
			}
		})
	}
}

func TestIsSweepOrphanCarouselsCmd(t *testing.T) {
	tests := []struct {
		args []string
		want bool
	}{
		{[]string{"point", "sweep-orphan-carousels"}, true},
		{[]string{"point sweep-orphan-carousels"}, true},
		{[]string{"point", "setup"}, false},
		{[]string{"point"}, false},
		{[]string{"point", "reset-password"}, false},
	}
	for _, tt := range tests {
		if got := isSweepOrphanCarouselsCmd(tt.args); got != tt.want {
			t.Errorf("isSweepOrphanCarouselsCmd(%v) = %v, want %v", tt.args, got, tt.want)
		}
	}
}

// TestRunSweepOrphanCarouselsCLI covers the sweep's real reason to exist: a
// carousel block deleted by hand in Text mode leaves its row behind, and
// another post's row with the same block_key must not be touched.
func TestRunSweepOrphanCarouselsCLI(t *testing.T) {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	ctx := context.Background()
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "Post A",
		Slug:     "post-a",
		AuthorID: 1,
		Status:   "draft",
		Content:  ":::{.carousel-block #alive}\n\n/2026/01/a.jpg\n\n:::",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "Post B",
		Slug:     "post-b",
		AuthorID: 1,
		Status:   "draft",
		Content:  ":::{.carousel-block #alive}\n\n/2026/01/b.jpg\n\n:::",
	}); err != nil {
		t.Fatal(err)
	}

	// Post A: one row whose key is still fenced, one orphaned by a hand-edit.
	if _, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: 1, BlockKey: "alive", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: 1, BlockKey: "orphan", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatal(err)
	}
	// Post B: same block_key as post A's live row — must survive untouched,
	// pinning the sweep to the composite (post_id, block_key) key.
	if _, err := repo.UpsertCarousel(ctx, models.UpsertCarouselParams{
		PostID: 2, BlockKey: "alive", Doc: `{"version":1}`,
	}); err != nil {
		t.Fatal(err)
	}

	runSweepOrphanCarouselsCLI(repo)

	rowsA, err := repo.ListCarouselsByPostID(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(rowsA) != 1 || rowsA[0].BlockKey != "alive" {
		t.Fatalf("post A after sweep: %+v, want only the alive row", rowsA)
	}

	rowsB, err := repo.ListCarouselsByPostID(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(rowsB) != 1 || rowsB[0].BlockKey != "alive" {
		t.Fatalf("post B after sweep: %+v, want its row untouched", rowsB)
	}
}

// TestRunSweepOrphanCarouselsCLI_Empty covers the empty-table path: no posts,
// no carousels, nothing to delete.
func TestRunSweepOrphanCarouselsCLI_Empty(t *testing.T) {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)

	runSweepOrphanCarouselsCLI(repo)
}
