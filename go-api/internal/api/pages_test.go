package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

func TestPagesHandler_GetHomePage(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	postService := services.NewPostService(repo)
	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewPagesHandler(repo, postService, tagService, settingsService)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetHomePage(c); err != nil {
		t.Fatalf("GetHomePage failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestPagesHandler_TagPage(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tagSvc := services.NewTagService(repo)
	tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "News", Slug: "news"})

	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewPagesHandler(repo, postService, tagSvc, settingsService)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/tag/news", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("news")

	if err := handler.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestPagesHandler_TagsPage(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tagSvc := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	handler := NewPagesHandler(repo, postService, tagSvc, settingsService)

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/tags", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetTagsPage(c); err != nil {
		t.Fatalf("GetTagsPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

