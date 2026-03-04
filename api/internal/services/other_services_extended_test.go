package services

import (
	"context"
	"testing"
)

func TestPostService_Render(t *testing.T) {
	service, repo := setupPostService(t)
	defer repo.Close()

	// 1. Plain text rendering
	html, _ := service.RenderContent("hello world")
	if html != "<p>hello world</p>\n" {
		t.Errorf("expected <p>hello world</p>\\n, got %s", html)
	}

	// 2. Media rendering (embedded in content)
	// Add media record so it can be resolved by UpdateMediaVisibilityForPaths if called
	// but RenderContent itself is mostly about markdown for now.
}

func TestPostService_PreviewToken(t *testing.T) {
	service, repo := setupPostService(t)
	defer repo.Close()

	ctx := context.Background()

	// 1. Create a draft post
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	post, _ := service.CreatePost(ctx, CreatePostParams{
		Title:    "Draft",
		Slug:     "draft",
		Content:  "content",
		AuthorID: 1,
		Status:   "draft",
	})

	// 2. Generate preview link
	link, _, err := service.GeneratePreviewLink(ctx, post.ID)
	if err != nil {
		t.Fatalf("GeneratePreviewLink failed: %v", err)
	}
	if link == "" {
		t.Error("expected non-empty preview link")
	}

	// 3. Get by token
	fetched, err := service.GetPostByPreviewToken(ctx, link)
	if err != nil {
		t.Fatalf("GetPostByPreviewToken failed: %v", err)
	}
	if fetched.ID != post.ID {
		t.Error("ID mismatch")
	}

	// 4. Invalid token
	_, err = service.GetPostByPreviewToken(ctx, "invalid-token")
	if err == nil {
		t.Error("expected error for invalid token")
	}
}

func TestPostService_ListPosts(t *testing.T) {
	service, repo := setupPostService(t)
	defer repo.Close()

	ctx := context.Background()

	// Setup: create multiple posts with different statuses
	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	// 1 published
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P1','p1','b',1,'published',datetime('now'))`)
	// 1 draft
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status) VALUES ('D1','d1','b',1,'draft')`)

	// List only published
	posts, total, _ := service.ListPosts(ctx, ListPostsParams{
		Page:       1,
		PerPage:    10,
		Status: "published",
	})
	if total != 1 {
		t.Errorf("expected 1 published post, got %d", total)
	}
	if posts[0].Status != "published" {
		t.Errorf("expected status published, got %s", posts[0].Status)
	}

	// List all (admin)
	posts, total, _ = service.ListPosts(ctx, ListPostsParams{
		Page:       1,
		PerPage:    10,
		IncludeDrafts: true,
	})
	if total != 2 {
		t.Errorf("expected 2 total posts, got %d", total)
	}
}

func TestSettingsService_Defaults(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	service := NewSettingsService(repo)
	ctx := context.Background()

	// 1. Get nonexistent setting with default
	val, _ := service.GetSetting(ctx, "site_name", "Point Blog")
	if val != "Point Blog" {
		t.Errorf("expected default Point Blog, got %s", val)
	}

	// 2. Set it
	_ = service.SetSetting(ctx, "site_name", "My Own Blog", "string")

	// 3. Get it again
	val, _ = service.GetSetting(ctx, "site_name", "Point Blog")
	if val != "My Own Blog" {
		t.Errorf("expected My Own Blog, got %s", val)
	}

	// 4. GetAllSettings (with data)
	settings, _ := service.GetAllSettings(ctx)
	if settings["site_name"] != "My Own Blog" {
		t.Error("site_name missing from GetAllSettings")
	}
}
