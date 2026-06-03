package repository

import (
	"context"
	"testing"
)

func TestRepository_GetYearTagsByLocationTagIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "loc-post", "published")
	// yearParent=1, year tag=2, loc tag=3
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'Years','years'),(2,'2024','2024'),(3,'Paris','paris')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,2),(?,3)`, pid, pid)

	m, err := repo.GetYearTagsByLocationTagIDs(ctx, []int64{3}, 1)
	if err != nil {
		t.Fatalf("GetYearTagsByLocationTagIDs failed: %v", err)
	}
	if len(m[3]) != 1 {
		t.Errorf("expected 1 year tag for loc 3, got %d", len(m[3]))
	}

	// empty input
	m2, _ := repo.GetYearTagsByLocationTagIDs(ctx, nil, 1)
	if len(m2) != 0 {
		t.Errorf("expected empty map for nil input")
	}
}
