package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestFeedsHandler_Sitemap(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	postSvc := services.NewPostService(repo, nil, nil)
	tagSvc := services.NewTagService(repo)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewFeedsHandler(repo, postSvc, tagSvc, settingsSvc, cacheService)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (name, slug) VALUES ('T','t')`)

	// 1. Sitemap with data
	req := httptest.NewRequest(http.MethodGet, "/sitemap.xml", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.Sitemap(c); err != nil {
		t.Fatalf("Sitemap failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. RobotsTxt
	req = httptest.NewRequest(http.MethodGet, "/robots.txt", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	_ = handler.RobotsTxt(c)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestFeedsHandler_RSS(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	postSvc := services.NewPostService(repo, nil, nil)
	tagSvc := services.NewTagService(repo)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewFeedsHandler(repo, postSvc, tagSvc, settingsSvc, cacheService)
	e := echo.New()

	// RSS with missing base_url setting (fallback logic)
	req := httptest.NewRequest(http.MethodGet, "/feed.xml", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.RSSFeed(c); err != nil {
		t.Fatalf("RSSFeed failed: %v", err)
	}
}
