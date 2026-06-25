//go:build integration

package services

import (
	"context"
	"testing"
)

func TestPostService_GetPostByID(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "TestPost", Slug: "testpost", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}

	got, err := svc.GetPostByID(ctx, post.ID)
	if err != nil {
		t.Fatalf("GetPostByID failed: %v", err)
	}
	if got.ID != post.ID {
		t.Errorf("expected post ID %d, got %d", post.ID, got.ID)
	}

	_, err = svc.GetPostByID(ctx, 99999)
	if err == nil {
		t.Error("expected error for non-existent post ID")
	}
}

func TestPostService_CreateAndUpdateStoreMediaURL(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, err := svc.CreatePost(ctx, CreatePostParams{
		Title:    "WithMedia",
		Slug:     "with-media",
		AuthorID: 1,
		Status:   "published",
		Content:  "Intro\n\n![pic](/media/originals/cover.jpg)",
	})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if !post.MediaURL.Valid || post.MediaURL.String != "/cover.jpg" {
		t.Errorf("expected returned media_url /cover.jpg, got %#v", post.MediaURL)
	}

	var stored string
	if err := repo.DB().QueryRow(`SELECT media_url FROM posts WHERE id=?`, post.ID).Scan(&stored); err != nil {
		t.Fatalf("read media_url: %v", err)
	}
	if stored != "/cover.jpg" {
		t.Errorf("expected stored media_url /cover.jpg, got %q", stored)
	}

	// Removing the media on update clears the stored media_url.
	updated, _, err := svc.UpdatePost(ctx, UpdatePostParams{
		ID:       post.ID,
		Title:    "WithMedia",
		Slug:     "with-media",
		AuthorID: 1,
		Status:   "published",
		Content:  "No media now, just text",
	})
	if err != nil {
		t.Fatalf("UpdatePost failed: %v", err)
	}
	if updated.MediaURL.String != "" {
		t.Errorf("expected media_url cleared after removing media, got %q", updated.MediaURL.String)
	}
}

func TestPostService_GetPostBySlug(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "SlugPost", Slug: "slug-post", AuthorID: 1, Status: "draft"})

	got, err := svc.GetPostBySlug(ctx, "slug-post")
	if err != nil {
		t.Fatalf("GetPostBySlug failed: %v", err)
	}
	if got.ID != post.ID {
		t.Errorf("expected post ID %d, got %d", post.ID, got.ID)
	}

	// Upper-case slug should match (service lowercases it)
	got2, err := svc.GetPostBySlug(ctx, "SLUG-POST")
	if err != nil {
		t.Fatalf("GetPostBySlug (uppercase) failed: %v", err)
	}
	if got2.ID != post.ID {
		t.Errorf("expected post ID %d from uppercase slug, got %d", post.ID, got2.ID)
	}

	_, err = svc.GetPostBySlug(ctx, "nonexistent-slug")
	if err == nil {
		t.Error("expected error for non-existent slug")
	}
}

func TestPostService_ListPublishedPostStubs(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	// No published posts yet
	stubs, err := svc.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("ListPublishedPostStubs failed: %v", err)
	}
	if len(stubs) != 0 {
		t.Errorf("expected 0 stubs, got %d", len(stubs))
	}

	// Publish a post
	p, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Pub", Slug: "pub", AuthorID: 1, Status: "draft"})
	_, _ = svc.PublishPost(ctx, p.ID)

	stubs2, err := svc.ListPublishedPostStubs(ctx)
	if err != nil {
		t.Fatalf("ListPublishedPostStubs after publish failed: %v", err)
	}
	if len(stubs2) != 1 {
		t.Errorf("expected 1 stub, got %d", len(stubs2))
	}
}

func TestPostService_IncrementAndFlushViewCounts(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Views", Slug: "views", AuthorID: 1, Status: "published"})
	_, _ = svc.PublishPost(ctx, post.ID)

	// Increment view count
	if err := svc.IncrementViewCount(ctx, post.ID); err != nil {
		t.Fatalf("IncrementViewCount failed: %v", err)
	}
	if err := svc.IncrementViewCount(ctx, post.ID); err != nil {
		t.Fatalf("IncrementViewCount second call failed: %v", err)
	}

	// Flush should persist the counts
	if err := svc.FlushViewCounts(ctx); err != nil {
		t.Fatalf("FlushViewCounts failed: %v", err)
	}

	got, _ := svc.GetPostByID(ctx, post.ID)
	if got.ViewCount != 2 {
		t.Errorf("expected view count 2, got %d", got.ViewCount)
	}

	// Flush on empty buffer should be a no-op
	if err := svc.FlushViewCounts(ctx); err != nil {
		t.Fatalf("FlushViewCounts (empty) failed: %v", err)
	}
}

func TestPostService_GetTagsForPost(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{
		Title:    "Tagged",
		Slug:     "tagged",
		AuthorID: 1,
		Status:   "draft",
		Tags:     []string{"go", "testing"},
	})

	tags, err := svc.GetTagsForPost(ctx, post.ID)
	if err != nil {
		t.Fatalf("GetTagsForPost failed: %v", err)
	}
	if len(tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(tags))
	}
}

func TestPostService_GetTagsByPostIDs(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	p1, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "P1", Slug: "p1", AuthorID: 1, Status: "draft", Tags: []string{"alpha"}})
	p2, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "P2", Slug: "p2", AuthorID: 1, Status: "draft", Tags: []string{"beta"}})

	m, err := svc.GetTagsByPostIDs(ctx, []int64{p1.ID, p2.ID})
	if err != nil {
		t.Fatalf("GetTagsByPostIDs failed: %v", err)
	}
	if len(m[p1.ID]) == 0 {
		t.Errorf("expected tags for post p1")
	}
	if len(m[p2.ID]) == 0 {
		t.Errorf("expected tags for post p2")
	}
}

func TestPostService_UpdatePost(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Original", Slug: "original", AuthorID: 1, Status: "draft"})

	updated, _, err := svc.UpdatePost(ctx, UpdatePostParams{
		ID:       post.ID,
		AuthorID: 1,
		Title:    "Updated Title",
		Slug:     "updated-title",
		Status:   "draft",
		Tags:     []string{"newtag"},
	})
	if err != nil {
		t.Fatalf("UpdatePost failed: %v", err)
	}
	if updated.Title != "Updated Title" {
		t.Errorf("expected title 'Updated Title', got %q", updated.Title)
	}

	// Update non-existent post
	_, _, err = svc.UpdatePost(ctx, UpdatePostParams{ID: 99999, AuthorID: 1, Title: "X", Slug: "x", Status: "draft"})
	if err == nil {
		t.Error("expected error updating non-existent post")
	}
}

func TestPostService_DeletePost(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "ToDelete", Slug: "to-delete", AuthorID: 1, Status: "draft"})

	if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
		t.Fatalf("SoftDeletePost failed: %v", err)
	}

	_, err := svc.GetPostByID(ctx, post.ID)
	if err == nil {
		t.Error("expected error fetching soft-deleted post")
	}
}

func TestPostService_PublishAndWithdraw(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	post, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "PubWd", Slug: "pub-wd", AuthorID: 1, Status: "draft"})

	published, err := svc.PublishPost(ctx, post.ID)
	if err != nil {
		t.Fatalf("PublishPost failed: %v", err)
	}
	if published.Status != "published" {
		t.Errorf("expected status 'published', got %q", published.Status)
	}

	withdrawn, err := svc.WithdrawPost(ctx, post.ID)
	if err != nil {
		t.Fatalf("WithdrawPost failed: %v", err)
	}
	if withdrawn.Status != "draft" {
		t.Errorf("expected status 'draft' after withdraw, got %q", withdrawn.Status)
	}
}

func TestPostService_GetPostNavigation(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)
	p1, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "First", Slug: "first", AuthorID: 1, Status: "draft"})
	_, _ = svc.PublishPost(ctx, p1.ID)
	p2, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Second", Slug: "second", AuthorID: 1, Status: "draft"})
	_, _ = svc.PublishPost(ctx, p2.ID)

	_, _, err := svc.GetPostNavigation(ctx, p1.ID, true)
	if err != nil {
		t.Fatalf("GetPostNavigation failed: %v", err)
	}
}

func TestPostService_PublishDueScheduledPosts(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	// Insert a post scheduled in the past
	_, _ = svc.repo.DB().Exec(
		`INSERT INTO posts (title,slug,content,formatter,status,author_id,scheduled_at,created_at,updated_at) VALUES ('Sched','sched','c','markdown','scheduled',1,datetime('now','-1 minute'),datetime('now'),datetime('now'))`,
	)

	published, err := svc.PublishDueScheduledPosts(ctx)
	if err != nil {
		t.Fatalf("PublishDueScheduledPosts failed: %v", err)
	}
	if len(published) != 1 {
		t.Errorf("expected 1 published post, got %d", len(published))
	}

	// No more due posts
	published2, _ := svc.PublishDueScheduledPosts(ctx)
	if len(published2) != 0 {
		t.Errorf("expected 0 on second call, got %d", len(published2))
	}
}

func TestPostService_ListPosts_YearRange(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	// Also exercises ListPostsInYearRange + CountPostsInYearRange via the service layer
	// Just verify the call doesn't error on an empty DB
	posts, total, err := svc.ListPosts(ctx, ListPostsParams{
		Page:     1,
		PerPage:  10,
		YearFrom: 2020,
		YearTo:   2025,
	})
	if err != nil {
		t.Fatalf("ListPosts (year range) failed: %v", err)
	}
	_ = total
	if posts == nil {
		t.Error("expected non-nil posts slice")
	}
}
func TestPostService_RestoreAndPermanentlyDelete(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	t.Run("RestorePost", func(t *testing.T) {
		post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "RestoreMe", Slug: "restore-me", AuthorID: 1, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("SoftDeletePost: %v", err)
		}
		if err := svc.RestorePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("RestorePost: %v", err)
		}
	})

	t.Run("PermanentlyDeletePost", func(t *testing.T) {
		post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "DeleteMe", Slug: "delete-me", AuthorID: 1, Status: "draft"})
		if err != nil {
			t.Fatalf("CreatePost: %v", err)
		}
		if err := svc.PermanentlyDeletePost(ctx, post.ID, 1); err != nil {
			t.Fatalf("PermanentlyDeletePost: %v", err)
		}
	})
}

func TestPostService_ListTrashedPosts(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "TrashMe", Slug: "trash-me", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}
	if err := svc.SoftDeletePost(ctx, post.ID, 1); err != nil {
		t.Fatalf("SoftDeletePost: %v", err)
	}

	posts, total, err := svc.ListTrashedPosts(ctx, 1, 10)
	if err != nil {
		t.Fatalf("ListTrashedPosts: %v", err)
	}
	if total == 0 || len(posts) == 0 {
		t.Error("expected at least one trashed post")
	}
}

func TestPostService_GetPostAnalytics(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	// Need at least one published post; the SQL uses SUM/AVG which return NULL on empty sets.
	p, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: "AnalyticsPost", Slug: "analytics-post", AuthorID: 1, Status: "draft"})
	_, _ = svc.PublishPost(ctx, p.ID)

	stats, err := svc.GetPostAnalytics(ctx)
	if err != nil {
		t.Fatalf("GetPostAnalytics: %v", err)
	}
	if stats.TotalViews < 0 {
		t.Error("TotalViews should not be negative")
	}
	if stats.MostViewedPostID != p.ID {
		t.Errorf("expected most viewed post ID %d, got %d", p.ID, stats.MostViewedPostID)
	}
}

func TestPostService_UpdatePostStatus(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "StatusTest", Slug: "status-test", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost: %v", err)
	}

	updated, err := svc.UpdatePostStatus(ctx, post.ID, "published")
	if err != nil {
		t.Fatalf("UpdatePostStatus: %v", err)
	}
	if updated.Status != "published" {
		t.Errorf("expected status 'published', got %q", updated.Status)
	}

	// Non-existent post should return an error.
	_, err = svc.UpdatePostStatus(ctx, 99999, "published")
	if err == nil {
		t.Error("expected error for non-existent post")
	}
}

func TestPostService_ListPosts_SortByViews(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	insertTestUser(t, svc)

	// Create and publish two posts.
	for _, slug := range []string{"views-a", "views-b"} {
		p, _, _ := svc.CreatePost(ctx, CreatePostParams{Title: slug, Slug: slug, AuthorID: 1, Status: "draft"})
		_, _ = svc.PublishPost(ctx, p.ID)
	}

	posts, total, err := svc.ListPosts(ctx, ListPostsParams{
		Page:    1,
		PerPage: 10,
		SortBy:  "views",
		Status:  "published",
	})
	if err != nil {
		t.Fatalf("ListPosts (sort by views): %v", err)
	}
	if total == 0 || len(posts) == 0 {
		t.Error("expected at least one post")
	}
}
