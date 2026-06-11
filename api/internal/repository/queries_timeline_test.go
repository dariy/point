package repository

import (
	"context"
	"testing"
)

func TestRepository_GetYearTagsByLocationTagIDs(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "loc-post", "published")
	// year tag (kind='year'), location tag (lat/lng set), plus a junk tag
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, kind) VALUES (2,'2024','2024','year'),(3,'Paris','paris','tag')`)
	_, _ = repo.DB().Exec(`UPDATE tags SET latitude=48.85, longitude=2.35 WHERE id=3`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?,2),(?,3)`, pid, pid)

	m, err := repo.GetYearTagsByLocationTagIDs(ctx, []int64{3})
	if err != nil {
		t.Fatalf("GetYearTagsByLocationTagIDs failed: %v", err)
	}
	if len(m[3]) != 1 {
		t.Errorf("expected 1 year tag for loc 3, got %d", len(m[3]))
	}

	// empty input
	m2, _ := repo.GetYearTagsByLocationTagIDs(ctx, nil)
	if len(m2) != 0 {
		t.Errorf("expected empty map for nil input")
	}
}

func TestRepository_TimelineQueries(t *testing.T) {
	repo := setupNewSchemaTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, pid := insertUserAndPost(t, repo, "timeline-post", "published")

	// Year tag (kind='year') and location tag (lat/lng set directly on tag row).
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, kind) VALUES (11, '2024', '2024', 'year')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, latitude, longitude) VALUES (12, 'Paris', 'paris', 48.85, 2.35)`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (?, 11),(?, 12)`, pid, pid)

	// ListMapTagsForYearRange — uses kind='year' and lat IS NOT NULL
	mapTags, err := repo.ListMapTagsForYearRange(ctx, 2024, 2024)
	if err != nil || len(mapTags) != 1 {
		t.Errorf("ListMapTagsForYearRange failed: %v, len=%d", err, len(mapTags))
	}

	// ListInTimelineDescendants — returns tags with kind='year'
	itTags, err := repo.ListInTimelineDescendants(ctx)
	if err != nil || len(itTags) != 1 {
		t.Errorf("ListInTimelineDescendants failed: %v, len=%d", err, len(itTags))
	}

	// ListInTimelineDescendantsForTag — year tags co-occurring with contextTag
	itTags2, err := repo.ListInTimelineDescendantsForTag(ctx, "paris")
	if err != nil || len(itTags2) != 1 {
		t.Errorf("ListInTimelineDescendantsForTag failed: %v, len=%d", err, len(itTags2))
	}

	// GetLocationTagsCoOccurringWith — location tags (lat IS NOT NULL) co-occurring with date tag
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
