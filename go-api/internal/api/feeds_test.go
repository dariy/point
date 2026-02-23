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
	defer repo.Close()

	postService := services.NewPostService(repo)
	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewFeedsHandler(repo, postService, tagService, settingsService)

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
	user, _ := repo.CreateUser(ctx, models.CreateUserParams{Username: "u", Email: "u@t", PasswordHash: "h", DisplayName: "U"})
	postService.CreatePost(ctx, services.CreatePostParams{Title: "P1", Content: "C1", Status: "published", AuthorID: user.ID})
	
	req = httptest.NewRequest(http.MethodGet, "/rss.xml", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.RSSFeed(c); err != nil {
		t.Fatalf("RSSFeed failed: %v", err)
	}
}

