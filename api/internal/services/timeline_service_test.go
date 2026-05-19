package services

import (
	"context"
	"testing"
)

func setupTimelineService(t *testing.T) (*TimelineService, *TagService, *PostService, int64) {
	repo := setupTestDB(t)
	// Ensure system tags exist so _in_timeline is available
	if err := repo.EnsureSystemTags(context.Background()); err != nil {
		t.Fatalf("failed to ensure system tags: %v", err)
	}
	// Create a user for posts
	res, err := repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('test', 'test@test.com', 'hash', 'Test User')`)
	if err != nil {
		t.Fatalf("failed to create test user: %v", err)
	}
	userID, _ := res.LastInsertId()

	timelineService := NewTimelineService(repo)
	tagService := NewTagService(repo)
	postService := NewPostService(repo)
	return timelineService, tagService, postService, userID
}

func TestTimelineService_Timeline(t *testing.T) {
	ctx := context.Background()
	svc, tagSvc, postSvc, userID := setupTimelineService(t)

	// 1. Setup tag hierarchy
	// _in_timeline is already there from EnsureSystemTags
	inTimeline, _ := svc.repo.GetTagBySlug(ctx, "_in_timeline")

	// Create some year/decade tags
	y2024, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "2024"})
	y2023, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "2023"})
	d2020s, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "2020s"})
	garbage, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "not-a-year"})

	// Reparent them to _in_timeline
	_ = tagSvc.SetTagChildren(ctx, inTimeline.ID, []int64{y2024.ID, y2023.ID, d2020s.ID, garbage.ID})

	// 2. Create some posts and tag them
	p1, _ := postSvc.CreatePost(ctx, CreatePostParams{Title: "Post 1", Status: "published", AuthorID: userID})
	p2, _ := postSvc.CreatePost(ctx, CreatePostParams{Title: "Post 2", Status: "published", AuthorID: userID})

	_ = postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024"})
	_ = postSvc.UpdatePostTags(ctx, p2.ID, []string{"2020s"})

	// 3. Test global timeline
	payload, err := svc.Timeline(ctx, "")
	if err != nil {
		t.Fatalf("Timeline failed: %v", err)
	}

	// Should have 2024, 2023, 2020s. "not-a-year" should be omitted by parseTimelineYear.
	if len(payload.Pills) != 3 {
		t.Errorf("expected 3 pills, got %d", len(payload.Pills))
	}

	// Check sorting (by year)
	if payload.Pills[0].Year != 2020 || payload.Pills[1].Year != 2023 || payload.Pills[2].Year != 2024 {
		t.Errorf("unexpected sort order: %v, %v, %v", payload.Pills[0].Year, payload.Pills[1].Year, payload.Pills[2].Year)
	}

	// Check IsDecade
	if !payload.Pills[0].IsDecade {
		t.Errorf("2020s should be a decade")
	}
	if payload.Pills[2].IsDecade {
		t.Errorf("2024 should not be a decade")
	}

	// 4. Test extent
	if payload.Extent.Min != 2020 || payload.Extent.Max != 2024 {
		t.Errorf("expected extent 2020-2024, got %d-%d", payload.Extent.Min, payload.Extent.Max)
	}

	// 5. Test context filtering
	// Create a location tag
	_, err = tagSvc.CreateTag(ctx, CreateTagParams{Name: "Berlin"})
	if err != nil {
		t.Logf("Berlin creation error: %v", err)
	}
	err = postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024", "berlin"}) // p1 has both
	if err != nil {
		t.Logf("p1 update error: %v", err)
	}

	payloadFiltered, err := svc.Timeline(ctx, "berlin")
	if err != nil {
		t.Logf("TimelineFiltered error: %v", err)
	}
	t.Logf("PayloadFiltered Pills: %+v", payloadFiltered.Pills)
	// Only 2024 co-occurs with berlin
	if len(payloadFiltered.Pills) != 1 || payloadFiltered.Pills[0].Slug != "2024" {
		t.Errorf("expected only 2024 for context berlin, got %v", payloadFiltered.Pills)
	}
}

func TestTimelineService_LocationsFor(t *testing.T) {
	ctx := context.Background()
	svc, tagSvc, postSvc, userID := setupTimelineService(t)

	// Setup tags
	y2024, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "2024"})
	berlin, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "Berlin"})
	paris, _ := tagSvc.CreateTag(ctx, CreateTagParams{Name: "Paris"})

	// InTimeline
	inTimeline, _ := svc.repo.GetTagBySlug(ctx, "_in_timeline")
	_ = tagSvc.SetTagChildren(ctx, inTimeline.ID, []int64{y2024.ID})

	// Mark as locations
	_ = svc.repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)
	_ = svc.repo.UpsertTagLocation(ctx, paris.ID, 48.8, 2.3)

	// Create posts
	p1, _ := postSvc.CreatePost(ctx, CreatePostParams{Title: "P1", Status: "published", AuthorID: userID})
	p2, _ := postSvc.CreatePost(ctx, CreatePostParams{Title: "P2", Status: "published", AuthorID: userID})
	p3, _ := postSvc.CreatePost(ctx, CreatePostParams{Title: "P3", Status: "published", AuthorID: userID})
	t.Logf("Posts created: %d, %d, %d", p1.ID, p2.ID, p3.ID)

	// p1, p2 in 2024 at Berlin
	err1 := postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024", "berlin"})
	err2 := postSvc.UpdatePostTags(ctx, p2.ID, []string{"2024", "berlin"})
	// p3 in 2024 at Paris
	err3 := postSvc.UpdatePostTags(ctx, p3.ID, []string{"2024", "paris"})
	t.Logf("UpdatePostTags errors: %v, %v, %v", err1, err2, err3)

	// Test locations for 2024
	locs, err := svc.LocationsFor(ctx, "2024", "", 10)
	if err != nil {
		t.Fatalf("LocationsFor failed: %v", err)
	}
	t.Logf("LocationsFor: %+v", locs)

	if len(locs) != 2 {
		t.Errorf("expected 2 locations, got %d", len(locs))
	}

	// Berlin should be first (2 posts vs 1 for Paris)
	if locs[0].Slug != "berlin" || locs[0].PostCount != 2 {
		t.Errorf("expected Berlin first with 2 posts, got %v", locs[0])
	}
}
