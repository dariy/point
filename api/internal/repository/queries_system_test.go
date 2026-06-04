package repository

import (
	"context"
	"testing"
)

func TestRepository_SystemStats(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	ctx := context.Background()
	stats, err := repo.GetSystemStats(ctx)
	if err != nil {
		t.Fatalf("GetSystemStats failed: %v", err)
	}

	// Should be all zeros for empty DB
	if stats.PostCount != 0 {
		t.Errorf("expected 0 posts, got %d", stats.PostCount)
	}
}
