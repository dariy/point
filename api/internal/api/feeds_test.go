package api

import (
	"context"
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
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

func TestFeedsHandler_XForwardedHost(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Forwarded-Host", "myhost.example.com")
	rec := httptest.NewRecorder()
	if err := feedsH.RSSFeed(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RSSFeed: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "myhost.example.com") {
		t.Errorf("expected X-Forwarded-Host in output")
	}
}

func TestFeedsHandler_RSSWithExcerpt(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	_, _ = h.repo.DB().Exec(`INSERT INTO posts (title,slug,content,excerpt,author_id,status,published_at) VALUES ('T','t','body','excerpt text',1,'published',datetime('now'))`)

	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := feedsH.RSSFeed(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RSSFeed: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "excerpt text") {
		t.Errorf("expected excerpt in RSS output")
	}
}

func TestFeedsHandler_DBError(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := feedsH.RSSFeed(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from RSSFeed on closed DB")
	}
}

func TestFeedsHandler_SitemapWithTags(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	_, _ = h.repo.DB().Exec(`INSERT INTO tags (id,name,slug,post_count) VALUES (1,'Nature','nature',1)`)

	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := feedsH.Sitemap(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Sitemap: %v", err)
	}
	if !strings.Contains(rec.Body.String(), "nature") {
		t.Errorf("expected tag slug in sitemap")
	}
}

func TestFeedsHandler_SitemapDBError(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
	feedsH := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := feedsH.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from Sitemap on closed DB")
	}
}

func TestFeedsHandler_Sitemap_DBError(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
	fh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	err := fh.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error from Sitemap with closed DB")
	}
}

func TestFeedsHandler_Feed_TLS(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	fh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, h.cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/feed", nil)

	req.TLS = &tls.ConnectionState{}
	rec := httptest.NewRecorder()
	err := fh.RSSFeed(e.NewContext(req, rec))
	_ = err
}
func TestFeedsHandler_Sitemap_TagRelationsError(t *testing.T) {
	h := setupHandlers(t)
	_, _ = h.repo.DB().Exec(`DROP TABLE tag_relationships`)
	cacheSvc := services.NewCacheService(t.TempDir())
	sh := NewFeedsHandler(h.repo, h.postSvc, h.tagSvc, h.settingsSvc, cacheSvc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/sitemap.xml", nil)
	rec := httptest.NewRecorder()
	err := sh.Sitemap(e.NewContext(req, rec))
	if err == nil {
		t.Error("expected error when tag_relationships is dropped")
	}
}
