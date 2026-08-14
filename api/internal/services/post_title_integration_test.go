//go:build !unit

package services

import (
	"context"
	"testing"
	"time"

	"point-api/internal/repository"
)

// setupPostServiceWithSettings is setupPostService plus a real SettingsService,
// so tests can change default_post_title_format.
func setupPostServiceWithSettings(t *testing.T) (*PostService, *SettingsService, repository.Repository) {
	repo := setupTestDB(t)
	settings := NewSettingsService(repo)
	return NewPostService(repo, settings, nil, nil, ""), settings, repo
}

func TestPostService_UntitledPostGetsDateTitle(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	today := time.Now().Format("2006-01-02")

	post, _, err := svc.CreatePost(ctx, CreatePostParams{AuthorID: 1, Status: "draft", Content: "no title here"})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if post.Title != today {
		t.Errorf("expected title %q, got %q", today, post.Title)
	}
	if post.Slug != today {
		t.Errorf("expected slug %q, got %q", today, post.Slug)
	}

	// A title of only whitespace is as untitled as an empty one.
	blank, _, err := svc.CreatePost(ctx, CreatePostParams{AuthorID: 1, Status: "draft", Title: "   "})
	if err != nil {
		t.Fatalf("CreatePost (blank title) failed: %v", err)
	}
	if blank.Title != today {
		t.Errorf("expected title %q, got %q", today, blank.Title)
	}
	// Same day, same derived slug — the second one must be disambiguated, not
	// rejected as a conflict.
	if blank.Slug != today+"-2" {
		t.Errorf("expected slug %q, got %q", today+"-2", blank.Slug)
	}

	third, _, err := svc.CreatePost(ctx, CreatePostParams{AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost (third) failed: %v", err)
	}
	if third.Slug != today+"-3" {
		t.Errorf("expected slug %q, got %q", today+"-3", third.Slug)
	}
}

func TestPostService_UntitledPostUsesConfiguredFormat(t *testing.T) {
	svc, settings, repo := setupPostServiceWithSettings(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	if err := settings.SetSetting(ctx, DefaultPostTitleFormatKey, "DD MMMM YYYY", "string"); err != nil {
		t.Fatalf("SetSetting failed: %v", err)
	}

	post, _, err := svc.CreatePost(ctx, CreatePostParams{AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	want := time.Now().Format("02 January 2006")
	if post.Title != want {
		t.Errorf("expected title %q, got %q", want, post.Title)
	}

	// A blank setting falls back to the built-in format rather than leaving the
	// post untitled.
	if err := settings.SetSetting(ctx, DefaultPostTitleFormatKey, "  ", "string"); err != nil {
		t.Fatalf("SetSetting failed: %v", err)
	}
	fallback, _, err := svc.CreatePost(ctx, CreatePostParams{AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}
	if fallback.Title != time.Now().Format("2006-01-02") {
		t.Errorf("expected built-in format, got %q", fallback.Title)
	}
}

func TestPostService_UpdateKeepsPostTitled(t *testing.T) {
	svc, repo := setupPostService(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()
	insertTestUser(t, svc)

	post, _, err := svc.CreatePost(ctx, CreatePostParams{Title: "Named", Slug: "named", AuthorID: 1, Status: "draft"})
	if err != nil {
		t.Fatalf("CreatePost failed: %v", err)
	}

	updated, _, err := svc.UpdatePost(ctx, UpdatePostParams{
		ID: post.ID, AuthorID: 1, Slug: "named", Status: "draft", Formatter: "markdown", Content: "body",
	})
	if err != nil {
		t.Fatalf("UpdatePost failed: %v", err)
	}
	if updated.Title != time.Now().Format("2006-01-02") {
		t.Errorf("expected date title, got %q", updated.Title)
	}
}
