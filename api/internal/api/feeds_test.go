package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestFeedsHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postService := services.NewPostService(repo)
	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewFeedsHandler(repo, postService, tagService, settingsService, cacheService)

	e := echo.New()

	// Test RobotsTxt
	req := httptest.NewRequest(http.MethodGet, "/robots.txt", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.RobotsTxt(c); err != nil {
		t.Fatalf("RobotsTxt failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test RSS
	req = httptest.NewRequest(http.MethodGet, "/rss.xml", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.RSSFeed(c); err != nil {
		t.Fatalf("RSSFeed failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test Sitemap
	req = httptest.NewRequest(http.MethodGet, "/sitemap.xml", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.Sitemap(c); err != nil {
		t.Fatalf("Sitemap failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test RSS with posts
	ctx := context.Background()
	// Create user
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{Username: "u", Email: "e", PasswordHash: "h", DisplayName: "U"})
	// Create published post
	_, _, _ = postService.CreatePost(ctx, services.CreatePostParams{Title: "P1", Content: "C1", Status: "published", AuthorID: user.ID})

	req = httptest.NewRequest(http.MethodGet, "/feed.xml", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.RSSFeed(c); err != nil {
		t.Fatalf("RSSFeed failed: %v", err)
	}
}
