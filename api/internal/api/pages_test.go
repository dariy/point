package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func setupPagesHandler(t *testing.T) (*PagesHandler, *testHandlers) {
	h := setupHandlers(t)
	ph := NewPagesHandler(h.repo, h.postSvc, h.tagSvc, h.mediaSvc, h.settingsSvc, h.cacheSvc)
	return ph, h
}

func TestPagesHandler_PostGrid(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Create post
	_, _, _ = h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title:    "Post 1",
		Status:   "published",
		AuthorID: userID,
	})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/posts", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := ph.GetHomePage(c); err != nil {
		t.Fatalf("GetHomePage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if len(resp["posts"].([]interface{})) != 1 {
		t.Errorf("expected 1 post, got %v", len(resp["posts"].([]interface{})))
	}
}

func TestPagesHandler_PostPage(t *testing.T) {
	_, h := setupPagesHandler(t)
	defer h.close()
	postH := NewPostHandler(h.postSvc, h.settingsSvc, h.mediaSvc, h.tagSvc)

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Create post
	post, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{
		Title:    "Post 1",
		Slug:     "post-1",
		Status:   "published",
		AuthorID: userID,
	})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/posts/post-1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("post-1")

	if err := postH.GetPostBySlug(c); err != nil {
		t.Fatalf("GetPostBySlug failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["slug"] != post.Slug {
		t.Errorf("expected post-1, got %v", resp["slug"])
	}
}

func TestPagesHandler_TagPage(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create tag
	tag, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Tag1", Slug: "tag-1"})

	// Public user
	req := httptest.NewRequest(http.MethodGet, "/tags/tag-1", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("tag-1")

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["tag"].(map[string]interface{})["slug"] != tag.Slug {
		t.Errorf("expected tag-1, got %v", resp["tag"].(map[string]interface{})["slug"])
	}
}

func TestPagesHandler_TagPageHidden(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	// Create hidden-tag directly with Hidden: true
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "HiddenTag", Slug: "hidden-tag", Hidden: true})

	e := echo.New()
	// Public user requesting hidden tag should get 404
	req := httptest.NewRequest(http.MethodGet, "/tags/hidden-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("hidden-tag")
	err := ph.GetTagPage(c)
	if err == nil {
		t.Error("expected error for hidden tag accessed publicly")
	}
}

func TestPagesHandler_TagPageWithAuth(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	tag, _ := h.tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "AuthTag", Slug: "auth-tag", Hidden: true})

	e := echo.New()
	// Authenticated user requesting hidden tag should get 200
	req := httptest.NewRequest(http.MethodGet, "/tags/auth-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("auth-tag")
	c.Set("user", "test-user")

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["tag"].(map[string]interface{})["slug"] != tag.Slug {
		t.Errorf("expected auth-tag, got %v", resp["tag"].(map[string]interface{})["slug"])
	}
}

func TestPagesHandler_GetMapPage_YearFilter(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	ctx := context.Background()
	_ = h.settingsSvc.SetSetting(ctx, "map_mode", "all", "string")

	// Create user
	userID := insertUser(h.repo)

	// 2024 tag in timeline (using Kind: "year")
	_, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2024", Slug: "2024", Kind: "year"})
	if err != nil {
		t.Fatalf("y2024 creation failed: %v", err)
	}

	// Berlin location
	berlin, err := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin", Slug: "berlin"})
	if err != nil {
		t.Fatalf("Berlin creation failed: %v", err)
	}
	_ = h.repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)

	// Post in 2024 at Berlin
	p1, _, err := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P1", Status: "published", AuthorID: userID})
	if err != nil {
		t.Fatalf("p1 creation failed: %v", err)
	}
	err = h.postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024", "berlin"})
	if err != nil {
		t.Fatalf("p1 tags update failed: %v", err)
	}

	// Post NOT in 2024 (e.g. 2023) at Paris
	_, _ = h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2023", Slug: "2023", Kind: "year"})
	paris, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Paris", Slug: "paris"})
	_ = h.repo.UpsertTagLocation(ctx, paris.ID, 48.8, 2.3)
	p2, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P2", Status: "published", AuthorID: userID})
	_ = h.postSvc.UpdatePostTags(ctx, p2.ID, []string{"2023", "paris"})

	e := echo.New()

	// Test with year_from=2024&year_to=2024
	req := httptest.NewRequest(http.MethodGet, "/api/pages/map?year_from=2024&year_to=2024", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := ph.GetMapPage(c); err != nil {
		t.Fatalf("GetMapPage failed: %v", err)
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	tags := resp["tags"].([]interface{})

	// Should only have Berlin
	if len(tags) != 1 {
		t.Errorf("expected 1 tag, got %d: %v", len(tags), tags)
	} else {
		tag := tags[0].(map[string]interface{})
		if tag["slug"] != "berlin" {
			t.Errorf("expected berlin, got %v", tag["slug"])
		}
	}
}

func TestPagesHandler_TagPage_ViewCountVisibility(t *testing.T) {
	ph, h := setupPagesHandler(t)
	defer h.close()

	e := echo.New()
	ctx := context.Background()

	// Create user
	userID := insertUser(h.repo)

	// Case 1: Tag above threshold
	tag1, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Popular1"})
	for i := 1; i <= 5; i++ {
		p, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P" + strconv.Itoa(i), Status: "published", AuthorID: userID})
		_ = h.postSvc.UpdatePostTags(ctx, p.ID, []string{tag1.Slug})
	}
	_ = h.settingsSvc.SetSetting(ctx, "min_tag_posts_to_show", "3", "int")

	req := httptest.NewRequest(http.MethodGet, "/tags/"+tag1.Slug, nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues(tag1.Slug)

	if err := ph.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage (above) failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Case 2: Tag below threshold
	tag2, _ := h.tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Popular2"})
	for i := 1; i <= 5; i++ {
		p, _, _ := h.postSvc.CreatePost(ctx, services.CreatePostParams{Title: "Q" + strconv.Itoa(i), Status: "published", AuthorID: userID})
		_ = h.postSvc.UpdatePostTags(ctx, p.ID, []string{tag2.Slug})
	}
	_ = h.settingsSvc.SetSetting(ctx, "min_tag_posts_to_show", "10", "int")

	req2 := httptest.NewRequest(http.MethodGet, "/tags/"+tag2.Slug, nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("slug")
	c2.SetParamValues(tag2.Slug)

	err := ph.GetTagPage(c2)
	if err == nil {
		t.Error("expected 404 for tag under threshold (public)")
	}

	// Case 3: Admin sees it anyway
	rec3 := httptest.NewRecorder()
	c3 := e.NewContext(req2, rec3)
	c3.SetParamNames("slug")
	c3.SetParamValues(tag2.Slug)
	c3.Set("user", "admin")

	if err := ph.GetTagPage(c3); err != nil {
		t.Fatalf("GetTagPage (admin) failed: %v", err)
	}
	if rec3.Code != http.StatusOK {
		t.Errorf("expected status 200 for admin, got %d", rec3.Code)
	}
}
