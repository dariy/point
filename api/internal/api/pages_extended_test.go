package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

func TestPagesHandler_GetTagPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, settingsSvc, cacheService)
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1, 'News', 'news')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('P','p','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1)`)

	// 1. Existing tag
	req := httptest.NewRequest(http.MethodGet, "/tag/news", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("news")

	if err := handler.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// 2. Non-existent tag
	req = httptest.NewRequest(http.MethodGet, "/tag/missing", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("missing")

	err := handler.GetTagPage(c)
	if err == nil {
		t.Error("expected error for non-existent tag")
	}

	// 3. GetMapPage
	req = httptest.NewRequest(http.MethodGet, "/map", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.GetMapPage(c); err != nil {
		t.Fatalf("GetMapPage failed: %v", err)
	}
}
