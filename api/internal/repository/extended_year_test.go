package repository

import (
	"context"
	"testing"

	"point-api/internal/models"
)

// insertTimelineHierarchy sets up _in_timeline → year tag → post for year-range tests.
// Returns (timelineTagID, yearTagID, postID).
func insertTimelineHierarchy(t *testing.T, repo *Repository, year string) (int64, int64, int64) {
	t.Helper()
	db := repo.DB()

	_, _ = db.Exec(`INSERT OR IGNORE INTO tags (id,name,slug) VALUES (100,'in_timeline','_in_timeline')`)
	res, _ := db.Exec(`INSERT INTO tags (name,slug) VALUES (?,?)`, year, year)
	yearTagID, _ := res.LastInsertId()
	_, _ = db.Exec(`INSERT INTO tag_relationships (parent_id,child_id) VALUES (100,?)`, yearTagID)

	_, _ = db.Exec(`INSERT OR IGNORE INTO users (id,username,email,password_hash,display_name) VALUES (1,'u','u@t.com','h','U')`)
	pr, _ := db.Exec(`INSERT INTO posts (title,slug,content,formatter,status,author_id,published_at) VALUES ('P',?,?,'markdown','published',1,datetime('now'))`, year+"-post", year+"-content")
	postID, _ := pr.LastInsertId()

	_, _ = db.Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, yearTagID)
	return 100, yearTagID, postID
}

func TestRepository_ListPostsInYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _, postID := insertTimelineHierarchy(t, repo, "2023")

	params := models.ListPostsParams{
		StatusFilter:  false,
		IncludeDrafts: false,
		IncludeHidden: false,
		Limit:         10,
		Offset:        0,
	}
	posts, err := repo.ListPostsInYearRange(ctx, 2022, 2024, params)
	if err != nil {
		t.Fatalf("ListPostsInYearRange failed: %v", err)
	}
	if len(posts) != 1 || posts[0].ID != postID {
		t.Errorf("expected post %d in year range, got %+v", postID, posts)
	}

	// Outside range should return nothing
	postsOut, err := repo.ListPostsInYearRange(ctx, 2000, 2010, params)
	if err != nil {
		t.Fatalf("ListPostsInYearRange (out of range) failed: %v", err)
	}
	if len(postsOut) != 0 {
		t.Errorf("expected 0 posts outside year range, got %d", len(postsOut))
	}
}

func TestRepository_CountPostsInYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTimelineHierarchy(t, repo, "2024")

	cp := models.CountPostsParams{
		StatusFilter:  false,
		IncludeDrafts: false,
		IncludeHidden: false,
	}
	n, err := repo.CountPostsInYearRange(ctx, 2024, 2024, cp)
	if err != nil {
		t.Fatalf("CountPostsInYearRange failed: %v", err)
	}
	if n != 1 {
		t.Errorf("expected count 1, got %d", n)
	}

	n2, _ := repo.CountPostsInYearRange(ctx, 1900, 1901, cp)
	if n2 != 0 {
		t.Errorf("expected count 0 outside range, got %d", n2)
	}
}

func TestRepository_ListInTimelineDescendants(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTimelineHierarchy(t, repo, "2025")

	tags, err := repo.ListInTimelineDescendants(ctx)
	if err != nil {
		t.Fatalf("ListInTimelineDescendants failed: %v", err)
	}
	found := false
	for _, tg := range tags {
		if tg.Slug == "2025" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected '2025' tag in timeline descendants, got %+v", tags)
	}
}

func TestRepository_ListInTimelineDescendantsForTag(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _, postID := insertTimelineHierarchy(t, repo, "2026")

	// Insert a context tag and link it to the same post
	res, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('France','france')`)
	ctxTagID, _ := res.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, ctxTagID)

	tags, err := repo.ListInTimelineDescendantsForTag(ctx, "france")
	if err != nil {
		t.Fatalf("ListInTimelineDescendantsForTag failed: %v", err)
	}
	found := false
	for _, tg := range tags {
		if tg.Slug == "2026" {
			found = true
		}
	}
	if !found {
		t.Errorf("expected '2026' in co-occurring timeline tags for 'france', got %+v", tags)
	}

	// With a tag that shares no posts
	tagsNone, _ := repo.ListInTimelineDescendantsForTag(ctx, "nonexistent")
	if len(tagsNone) != 0 {
		t.Errorf("expected 0 results for nonexistent context tag, got %d", len(tagsNone))
	}
}

func TestRepository_ListMapTagsForYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _, postID := insertTimelineHierarchy(t, repo, "2027")

	// Insert a location tag and link it to the post
	res, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('Berlin','berlin')`)
	locTagID, _ := res.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id,latitude,longitude) VALUES (?,52.5,13.4)`, locTagID)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, locTagID)

	results, err := repo.ListMapTagsForYearRange(ctx, 2027, 2027)
	if err != nil {
		t.Fatalf("ListMapTagsForYearRange failed: %v", err)
	}
	found := false
	for _, r := range results {
		if r.TagID == locTagID {
			found = true
		}
	}
	if !found {
		t.Errorf("expected berlin location tag in map year range results, got %+v", results)
	}

	// Empty year range
	empty, _ := repo.ListMapTagsForYearRange(ctx, 1900, 1901)
	if len(empty) != 0 {
		t.Errorf("expected 0 results for out-of-range years, got %d", len(empty))
	}
}

func TestRepository_GetLocationTagsCoOccurringWith(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, yearTagID, postID := insertTimelineHierarchy(t, repo, "2028")

	// Insert a location tag and link to post
	res, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('Tokyo','tokyo')`)
	locTagID, _ := res.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id,latitude,longitude) VALUES (?,35.6,139.7)`, locTagID)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, locTagID)

	// Query co-occurring location tags for the year tag slug
	db := repo.DB()
	var yearSlug string
	_ = db.QueryRow(`SELECT slug FROM tags WHERE id = ?`, yearTagID).Scan(&yearSlug)

	results, err := repo.GetLocationTagsCoOccurringWith(ctx, yearSlug, "", 10)
	if err != nil {
		t.Fatalf("GetLocationTagsCoOccurringWith failed: %v", err)
	}
	found := false
	for _, r := range results {
		if r.ID == locTagID {
			found = true
		}
	}
	if !found {
		t.Errorf("expected tokyo in location co-occurrence results, got %+v", results)
	}

	// With context tag filter
	res2, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('Europe','europe')`)
	ctxTagID, _ := res2.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, ctxTagID)

	results2, err := repo.GetLocationTagsCoOccurringWith(ctx, yearSlug, "europe", 10)
	if err != nil {
		t.Fatalf("GetLocationTagsCoOccurringWith (with context) failed: %v", err)
	}
	if len(results2) == 0 {
		t.Error("expected results with context tag filter")
	}
}

func TestRepository_GetPostsByTagIDsInYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, yearTagID, postID := insertTimelineHierarchy(t, repo, "2029")

	// Empty tag IDs returns empty
	empty, err := repo.GetPostsByTagIDsInYearRange(ctx, []int64{}, 2029, 2029, true, false, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDsInYearRange (empty) failed: %v", err)
	}
	if len(empty) != 0 {
		t.Errorf("expected empty for no tagIDs, got %d", len(empty))
	}

	// Insert a subject tag and link it to the post
	res, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('Hiking','hiking')`)
	subjectTagID, _ := res.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, subjectTagID)

	posts, err := repo.GetPostsByTagIDsInYearRange(ctx, []int64{subjectTagID}, 2029, 2029, true, false, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDsInYearRange failed: %v", err)
	}
	if len(posts) != 1 {
		t.Errorf("expected 1 post, got %d (yearTagID=%d)", len(posts), yearTagID)
	}

	// includeDrafts=true path
	posts2, err := repo.GetPostsByTagIDsInYearRange(ctx, []int64{subjectTagID}, 2029, 2029, false, true, false, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDsInYearRange (includeDrafts) failed: %v", err)
	}
	if len(posts2) == 0 {
		t.Error("expected results with includeDrafts=true")
	}

	// includeHidden path
	posts3, err := repo.GetPostsByTagIDsInYearRange(ctx, []int64{subjectTagID}, 2029, 2029, false, false, true, 10, 0)
	if err != nil {
		t.Fatalf("GetPostsByTagIDsInYearRange (includeHidden) failed: %v", err)
	}
	_ = posts3
}

func TestRepository_CountPostsByTagIDsInYearRange(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _, postID := insertTimelineHierarchy(t, repo, "2030")

	// Empty tag IDs
	n, err := repo.CountPostsByTagIDsInYearRange(ctx, []int64{}, 2030, 2030, true, false, false)
	if err != nil {
		t.Fatalf("CountPostsByTagIDsInYearRange (empty) failed: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 for empty tagIDs, got %d", n)
	}

	res, _ := repo.DB().Exec(`INSERT INTO tags (name,slug) VALUES ('Cycling','cycling')`)
	tagID, _ := res.LastInsertId()
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id,tag_id) VALUES (?,?)`, postID, tagID)

	n2, err := repo.CountPostsByTagIDsInYearRange(ctx, []int64{tagID}, 2030, 2030, true, false, false)
	if err != nil {
		t.Fatalf("CountPostsByTagIDsInYearRange failed: %v", err)
	}
	if n2 != 1 {
		t.Errorf("expected count 1, got %d", n2)
	}

	// includeDrafts=true path
	n3, _ := repo.CountPostsByTagIDsInYearRange(ctx, []int64{tagID}, 2030, 2030, false, true, false)
	_ = n3

	// includeHidden=true path
	n4, _ := repo.CountPostsByTagIDsInYearRange(ctx, []int64{tagID}, 2030, 2030, false, false, true)
	_ = n4
}
