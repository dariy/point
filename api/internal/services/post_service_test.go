package services

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"point-api/internal/models"
)

func TestPostService_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	service := NewPostService(repo)
	ctx := context.Background()

	// Need a user first
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "author",
		Email:        "author@example.com",
		PasswordHash: "hash",
		DisplayName:  "Author",
	})

	// Test Create
	post, err := service.CreatePost(ctx, CreatePostParams{
		Title:    "Test Post",
		Content:  "Content here",
		Status:   "published",
		AuthorID: user.ID,
		Tags:     []string{"Tag1", "Tag2"},
	})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if post.Title != "Test Post" {
		t.Errorf("expected title Test Post, got %s", post.Title)
	}
	if post.Slug != "test-post" {
		t.Errorf("expected slug test-post, got %s", post.Slug)
	}

	// Verify tags were created and linked
	tags, err := service.GetTagsForPost(ctx, post.ID)
	if err != nil {
		t.Errorf("GetTagsForPost failed: %v", err)
	}
	if len(tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(tags))
	}

	// Test GetByID
	fetched, err := service.GetPostByID(ctx, post.ID)
	if err != nil {
		t.Errorf("GetPostByID failed: %v", err)
	}
	if fetched.ID != post.ID {
		t.Errorf("expected ID %d, got %d", post.ID, fetched.ID)
	}

	// Test Update
	updated, err := service.UpdatePost(ctx, UpdatePostParams{
		ID:       post.ID,
		AuthorID: user.ID,
		Title:    "Updated Title",
		Content:  "Updated Content",
		Tags:     []string{"Tag1", "Tag3"}, // Replace Tag2 with Tag3
	})
	if err != nil {
		t.Errorf("UpdatePost failed: %v", err)
	}
	if updated.Title != "Updated Title" {
		t.Errorf("expected title Updated Title, got %s", updated.Title)
	}

	tags, _ = service.GetTagsForPost(ctx, post.ID)
	if len(tags) != 2 {
		t.Errorf("expected 2 tags after update, got %d", len(tags))
	}

	// Test List
	posts, total, err := service.ListPosts(ctx, ListPostsParams{
		Page:          1,
		PerPage:       10,
		IncludeDrafts: true,
	})
	if err != nil {
		t.Errorf("ListPosts failed: %v", err)
	}
	if total != 1 || len(posts) != 1 {
		t.Errorf("expected 1 post in list, got %d (total %d)", len(posts), total)
	}

	// Test Preview Link
	token, _, err := service.GeneratePreviewLink(ctx, post.ID)
	if err != nil {
		t.Errorf("GeneratePreviewLink failed: %v", err)
	}
	previewPost, err := service.GetPostByPreviewToken(ctx, token)
	if err != nil {
		t.Errorf("GetPostByPreviewToken failed: %v", err)
	}
	if previewPost.ID != post.ID {
		t.Errorf("preview post ID mismatch: %d vs %d", previewPost.ID, post.ID)
	}

	// Test Render
	html, err := service.RenderContent(`# Heading
**Bold**`)
	if err != nil {
		t.Errorf("RenderContent failed: %v", err)
	}
	if html == "" {
		t.Error("rendered HTML is empty")
	}

	// Test IncrementViewCount
	err = service.IncrementViewCount(ctx, post.ID)
	if err != nil {
		t.Errorf("IncrementViewCount failed: %v", err)
	}

	// Test Delete
	err = service.DeletePost(ctx, post.ID, user.ID)
	if err != nil {
		t.Errorf("DeletePost failed: %v", err)
	}
}

func TestPostService_GetPostBySlug(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "sluguser", Email: "slug@test.com", PasswordHash: "h", DisplayName: "Slug",
	})
	post, _ := svc.CreatePost(ctx, CreatePostParams{
		Title: "Slug Test", Content: "c", Status: "published", AuthorID: user.ID,
	})

	// Found
	_, err := svc.GetPostBySlug(ctx, post.Slug)
	if err != nil {
		t.Errorf("GetPostBySlug failed: %v", err)
	}

	// Not found
	_, err = svc.GetPostBySlug(ctx, "no-such-slug")
	if err == nil {
		t.Error("expected error for missing slug")
	}
}

func TestPostService_UpdatePostTags(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "tagowner", Email: "tagowner@test.com", PasswordHash: "h", DisplayName: "TagOwner",
	})
	post, _ := svc.CreatePost(ctx, CreatePostParams{
		Title: "Tag Update", Content: "c", Status: "published", AuthorID: user.ID,
		Tags: []string{"InitialTag"},
	})

	// Replace tags
	err := svc.UpdatePostTags(ctx, post.ID, []string{"NewTag1", "NewTag2"})
	if err != nil {
		t.Errorf("UpdatePostTags failed: %v", err)
	}

	tags, _ := svc.GetTagsForPost(ctx, post.ID)
	if len(tags) != 2 {
		t.Errorf("expected 2 tags, got %d", len(tags))
	}

	// Clear all tags
	err = svc.UpdatePostTags(ctx, post.ID, []string{})
	if err != nil {
		t.Errorf("UpdatePostTags with empty slice failed: %v", err)
	}

	// Non-existent post
	err = svc.UpdatePostTags(ctx, 9999, []string{"tag"})
	if err == nil {
		t.Error("expected error for non-existent post")
	}
}

func TestPostService_PublishWithdraw(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "pubuser", Email: "pub@test.com", PasswordHash: "h", DisplayName: "Pub",
	})
	post, _ := svc.CreatePost(ctx, CreatePostParams{
		Title: "Draft", Content: "c", Status: "draft", AuthorID: user.ID,
	})

	// Publish
	published, err := svc.PublishPost(ctx, post.ID)
	if err != nil {
		t.Fatalf("PublishPost failed: %v", err)
	}
	if published.Status != "published" {
		t.Errorf("expected status published, got %s", published.Status)
	}

	// Withdraw
	withdrawn, err := svc.WithdrawPost(ctx, post.ID)
	if err != nil {
		t.Fatalf("WithdrawPost failed: %v", err)
	}
	if withdrawn.Status != "draft" {
		t.Errorf("expected status draft, got %s", withdrawn.Status)
	}
}

func TestPostService_GetPostNavigation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "navpub", Email: "navpub@test.com", PasswordHash: "h", DisplayName: "NavPub",
	})

	// Create multiple published posts
	p1, _ := svc.CreatePost(ctx, CreatePostParams{Title: "First", Content: "c1", Status: "published", AuthorID: user.ID})
	_, _ = svc.PublishPost(ctx, p1.ID)
	p2, _ := svc.CreatePost(ctx, CreatePostParams{Title: "Second", Content: "c2", Status: "published", AuthorID: user.ID})
	_, _ = svc.PublishPost(ctx, p2.ID)

	// Navigation for first post (no prev, may have next)
	prev, next, err := svc.GetPostNavigation(ctx, p1.ID, true)
	if err != nil {
		t.Errorf("GetPostNavigation failed: %v", err)
	}
	_ = prev
	_ = next
}

func TestPostService_PreprocessContent(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "preprocessor", Email: "pre@test.com", PasswordHash: "h", DisplayName: "Pre",
	})

	// Content with markdown that has code blocks
	post, _ := svc.CreatePost(ctx, CreatePostParams{
		Title: "Code Post", Content: "# Hello\n```go\nfmt.Println(\"hi\")\n```\n",
		Status: "published", AuthorID: user.ID, Formatter: "markdown",
	})

	// RenderContent exercises preprocessContent
	rendered, _ := svc.RenderContent(post.Content)
	if rendered == "" {
		t.Error("RenderContent returned empty string")
	}

	// Test preprocessContent with bare image path (image extension match)
	rendered2, _ := svc.RenderContent("/2024/06/photo.jpg")
	if rendered2 == "" {
		t.Error("preprocessContent with bare image path returned empty")
	}

	// Test preprocessContent with bare path that has no image extension (no-op branch)
	rendered3, _ := svc.RenderContent("/2024/06/document.pdf")
	if rendered3 == "" {
		t.Error("preprocessContent with non-image path returned empty")
	}
}

func TestPostService_GetTagsByPostIDs(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "tagsuser", Email: "tags@test.com", PasswordHash: "h", DisplayName: "T",
	})
	post, _ := svc.CreatePost(ctx, CreatePostParams{
		Title: "Tagged", Content: "C", Status: "published", AuthorID: user.ID, Tags: []string{"alpha"},
	})

	m, err := svc.GetTagsByPostIDs(ctx, []int64{post.ID})
	if err != nil {
		t.Fatalf("GetTagsByPostIDs failed: %v", err)
	}
	if len(m[post.ID]) == 0 {
		t.Errorf("expected tags for post %d", post.ID)
	}
}

func TestPostService_ListPostsSearch(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "searcher", Email: "s@test.com", PasswordHash: "h", DisplayName: "S",
	})
	_, _ = svc.CreatePost(ctx, CreatePostParams{
		Title: "Unique Searchable Title", Content: "C", Status: "published", AuthorID: user.ID,
	})

	posts, total, err := svc.ListPosts(ctx, ListPostsParams{
		Page: 1, PerPage: 10, Search: "Searchable", IncludeDrafts: true,
	})
	if err != nil {
		t.Fatalf("ListPosts with search failed: %v", err)
	}
	if total != 1 || len(posts) != 1 {
		t.Errorf("expected 1 result, got total=%d len=%d", total, len(posts))
	}
}

func TestPostService_PreviewTokenExpired(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	svc := NewPostService(repo)
	ctx := context.Background()

	user, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username: "expuser", Email: "exp@t.com", PasswordHash: "h", DisplayName: "E",
	})
	post, _ := svc.CreatePost(ctx, CreatePostParams{Title: "T", Content: "C", Status: "draft", AuthorID: user.ID})

	// Set an already-expired preview token directly
	expiredAt := time.Now().Add(-time.Hour)
	_, _ = repo.DB().Exec(`UPDATE posts SET preview_token = 'expiredtok', preview_expires_at = ? WHERE id = ?`,
		expiredAt, post.ID)

	// GetPostByPreviewToken with expired token should return ErrNoRows (covers line 352-354)
	_, err := svc.GetPostByPreviewToken(ctx, "expiredtok")
	if err == nil {
		t.Error("expected error for expired preview token")
	}
	if err != sql.ErrNoRows {
		t.Errorf("expected sql.ErrNoRows, got %v", err)
	}
}
