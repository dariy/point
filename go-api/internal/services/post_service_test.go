package services

import (
	"context"
	"testing"

	"point-api/internal/models"
)

func TestPostService_CRUD(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
