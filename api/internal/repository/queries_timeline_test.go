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

func TestRepository_TimelineQueries(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "timeline-post", "published")

	// Setup _in_timeline -> 2024 -> timeline-post
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (10, 'Timeline', '_in_timeline'), (11, '2024', '2024')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (10, 11)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, 11)`, pid)

	// Location tag
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (12, 'Paris', 'paris')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (12, 48.85, 2.35)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, 12)`, pid)

	// ListMapTagsForYearRange
	mapTags, err := repo.ListMapTagsForYearRange(ctx, 2024, 2024)
	if err != nil || len(mapTags) != 1 {
		t.Errorf("ListMapTagsForYearRange failed: %v, len=%d", err, len(mapTags))
	}

	// ListInTimelineDescendants
	itTags, err := repo.ListInTimelineDescendants(ctx)
	if err != nil || len(itTags) != 1 {
		t.Errorf("ListInTimelineDescendants failed: %v, len=%d", err, len(itTags))
	}

	// ListInTimelineDescendantsForTag
	itTags2, err := repo.ListInTimelineDescendantsForTag(ctx, "paris")
	if err != nil || len(itTags2) != 1 {
		t.Errorf("ListInTimelineDescendantsForTag failed: %v, len=%d", err, len(itTags2))
	}

	// GetLocationTagsCoOccurringWith
	locTags, err := repo.GetLocationTagsCoOccurringWith(ctx, "2024", "", 10)
	if err != nil || len(locTags) != 1 {
		t.Errorf("GetLocationTagsCoOccurringWith failed: %v, len=%d", err, len(locTags))
	}

	// with context tag
	locTags2, err := repo.GetLocationTagsCoOccurringWith(ctx, "2024", "paris", 10)
	if err != nil || len(locTags2) != 1 {
		t.Errorf("GetLocationTagsCoOccurringWith (context) failed: %v, len=%d", err, len(locTags2))
	}
}
