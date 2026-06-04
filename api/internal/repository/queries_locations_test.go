package repository

import (
	"context"
	"testing"
)

func TestRepository_TagLocations(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_ = repo.UpsertTagLocation(ctx, 1, 48.85, 2.35)

	locs, err := repo.GetTagLocationsByTagIDs(ctx, []int64{1})
	if err != nil {
		t.Fatalf("GetTagLocationsByTagIDs failed: %v", err)
	}
	if len(locs) != 1 {
		t.Errorf("expected 1 location, got %d", len(locs))
	}

	// empty input
	locs2, _ := repo.GetTagLocationsByTagIDs(ctx, nil)
	if len(locs2) != 0 {
		t.Errorf("expected empty map for nil input")
	}

	if err := repo.DeleteTagLocation(ctx, 1); err != nil {
		t.Fatalf("DeleteTagLocation failed: %v", err)
	}
	locs3, _ := repo.GetTagLocationsByTagIDs(ctx, []int64{1})
	if len(locs3) != 0 {
		t.Errorf("expected 0 locations after delete, got %d", len(locs3))
	}
}

func TestRepository_UpsertTagLocation_InsertAndUpdate(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)

	if err := repo.UpsertTagLocation(ctx, 1, 48.85, 2.35); err != nil {
		t.Fatalf("UpsertTagLocation (insert): %v", err)
	}
	if err := repo.UpsertTagLocation(ctx, 1, 50.0, 3.0); err != nil {
		t.Fatalf("UpsertTagLocation (update): %v", err)
	}
}
