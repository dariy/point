package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestPagesHandler_GetHomePage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postService := services.NewPostService(repo)
	tagService := services.NewTagService(repo)
	settingsService := services.NewSettingsService(repo)
	mediaService := services.NewMediaService(repo, nil, settingsService, tagService)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postService, tagService, mediaService, settingsService, cacheService)

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
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	_, _ = tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "News", Slug: "news"})

	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	mediaService := services.NewMediaService(repo, nil, settingsService, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postService, tagSvc, mediaService, settingsService, cacheService)

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
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	settingsService := services.NewSettingsService(repo)
	mediaService := services.NewMediaService(repo, nil, settingsService, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postService, tagSvc, mediaService, settingsService, cacheService)

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

func TestPagesHandler_GetMapPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()
	_ = settingsSvc.SetSetting(context.Background(), "map_mode", "all", "string")

	// Public map (no user)
	req := httptest.NewRequest(http.MethodGet, "/map", nil)
	rec := httptest.NewRecorder()
	if err := handler.GetMapPage(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMapPage failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Admin map (with user set)
	req = httptest.NewRequest(http.MethodGet, "/map", nil)
	rec = httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", struct{}{})
	if err := handler.GetMapPage(c); err != nil {
		t.Fatalf("GetMapPage (admin) failed: %v", err)
	}
}

func TestPagesHandler_GetMapPageWithData(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	ctx := context.Background()

	// Create country tag and a child (city)
	country, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Country"})
	city, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "France"})
	_ = tagSvc.SetTagParents(ctx, city.ID, []int64{country.ID})

	// Give city a location
	_ = tagSvc.SetTagLocations(ctx, city.ID, []services.TagLocationInput{{Latitude: 48.8566, Longitude: 2.3522}})

	// Set post_count for city so it appears in ListTags
	_, _ = repo.DB().Exec(`UPDATE tags SET post_count = 1 WHERE id = ?`, city.ID)

	_ = settingsSvc.SetSetting(ctx, "map_mode", "all", "string")
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/map", nil)
	rec := httptest.NewRecorder()
	if err := handler.GetMapPage(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMapPage (with data) failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	_ = country
}

func TestPagesHandler_TagsPageAdmin(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	ctx := context.Background()
	parent, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Travel", })
	child, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Europe"})
	_ = tagSvc.SetTagParents(ctx, child.ID, []int64{parent.ID})
	// Set post_count > 0 so they appear in ListTags(includeEmpty=false)
	_, _ = repo.DB().Exec(`UPDATE tags SET post_count = 1`)
	// Add a location to parent tag so location branch is covered
	_ = tagSvc.SetTagLocations(ctx, parent.ID, []services.TagLocationInput{{Latitude: 48.8, Longitude: 2.3}})

	postSvc := services.NewPostService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()

	// Admin mode
	req := httptest.NewRequest(http.MethodGet, "/tags", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", struct{}{}) // authenticated

	if err := handler.GetTagsPage(c); err != nil {
		t.Fatalf("GetTagsPage (admin) failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestPagesHandler_TagPageNotFound(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/tag/nonexistent", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("nonexistent")
	err := handler.GetTagPage(c)
	if err == nil {
		t.Error("expected error for nonexistent tag")
	}
}

func TestPagesHandler_TagPageHidden(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	ctx := context.Background()
	// Create hidden-tag and make it a child of the _hidden system tag.
	hidden, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "HiddenTag", Slug: "hidden-tag"})
	_, _ = repo.DB().Exec(`INSERT OR IGNORE INTO tags (name, slug, post_count) VALUES ('Hidden','_hidden',0)`)
	_, _ = repo.DB().Exec(`
		INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
		SELECT h.id, ? FROM tags h WHERE h.slug = '_hidden'`, hidden.ID)

	postSvc := services.NewPostService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()

	// Public user requesting hidden tag should get 404
	req := httptest.NewRequest(http.MethodGet, "/tag/hidden-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("hidden-tag")
	err := handler.GetTagPage(c)
	if err == nil {
		t.Error("expected error for hidden tag accessed publicly")
	}
}

func TestPagesHandler_TagPageWithAuth(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	tagSvc := services.NewTagService(repo)
	_, _ = tagSvc.CreateTag(context.Background(), services.CreateTagParams{Name: "AuthTag", Slug: "auth-tag"})

	postSvc := services.NewPostService(repo)
	settingsSvc := services.NewSettingsService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/tag/auth-tag", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("slug")
	c.SetParamValues("auth-tag")
	c.Set("user", struct{}{}) // authenticated user — admin mode

	if err := handler.GetTagPage(c); err != nil {
		t.Fatalf("GetTagPage (admin) failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestPagesHandler_GetTagPage(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	postSvc := services.NewPostService(repo)
	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	_ = settingsSvc.SetSetting(context.Background(), "map_mode", "all", "string")
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheService := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheService)
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

func TestPagesHandler_GetMapPage_YearFilter(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, nil, settingsSvc, tagSvc)
	cacheSvc := services.NewCacheService(t.TempDir())
	handler := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheSvc)

	ctx := context.Background()
	_ = repo.EnsureSystemTags(ctx)
	_ = settingsSvc.SetSetting(ctx, "map_mode", "all", "string")

	// Create user
	res, _ := repo.DB().Exec(`INSERT INTO users (username, email, password_hash, display_name) VALUES ('test', 'test@test.com', 'hash', 'Test User')`)
	userID, _ := res.LastInsertId()

	// 2024 tag in timeline
	y2024, err := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2024"})
	if err != nil {
		t.Fatalf("y2024 creation failed: %v", err)
	}
	inTimeline, _ := repo.GetTagBySlug(ctx, "_in_timeline")
	err = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: inTimeline.ID, ChildID: y2024.ID})
	if err != nil {
		t.Fatalf("y2024 rel failed: %v", err)
	}

	// Berlin location
	berlin, err := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Berlin"})
	if err != nil {
		t.Fatalf("Berlin creation failed: %v", err)
	}
	_ = repo.UpsertTagLocation(ctx, berlin.ID, 52.5, 13.4)

	// Post in 2024 at Berlin
	p1, err := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P1", Status: "published", AuthorID: userID})
	if err != nil {
		t.Fatalf("p1 creation failed: %v", err)
	}
	err = postSvc.UpdatePostTags(ctx, p1.ID, []string{"2024", "berlin"})
	if err != nil {
		t.Fatalf("p1 tags update failed: %v", err)
	}

	// Post NOT in 2024 (e.g. 2023) at Paris
	y2023, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "2023"})
	_ = repo.AddTagRelationship(ctx, models.AddTagRelationshipParams{ParentID: inTimeline.ID, ChildID: y2023.ID})
	paris, _ := tagSvc.CreateTag(ctx, services.CreateTagParams{Name: "Paris"})
	_ = repo.UpsertTagLocation(ctx, paris.ID, 48.8, 2.3)
	p2, _ := postSvc.CreatePost(ctx, services.CreatePostParams{Title: "P2", Status: "published", AuthorID: userID})
	_ = postSvc.UpdatePostTags(ctx, p2.ID, []string{"2023", "paris"})

	// Verify repo has the link
	var ptCount int64
	_ = repo.DB().QueryRow(`SELECT COUNT(*) FROM post_tags`).Scan(&ptCount)
	t.Logf("PostTags count: %d", ptCount)

	var inTimelineID int64
	_ = repo.DB().QueryRow(`SELECT id FROM tags WHERE slug = '_in_timeline'`).Scan(&inTimelineID)
	t.Logf("_in_timeline ID: %d", inTimelineID)

	var y2024ID int64
	_ = repo.DB().QueryRow(`SELECT id FROM tags WHERE slug = '2024'`).Scan(&y2024ID)
	t.Logf("2024 ID: %d", y2024ID)

	var relCount int64
	_ = repo.DB().QueryRow(`SELECT COUNT(*) FROM tag_relationships WHERE parent_id = ? AND child_id = ?`, inTimelineID, y2024ID).Scan(&relCount)
	t.Logf("Relationship count (_in_timeline -> 2024): %d", relCount)

	rangeResults, err := repo.ListMapTagsForYearRange(ctx, 2024, 2024)
	t.Logf("Repo rangeResults (2024): %+v, error: %v", rangeResults, err)

	e := echo.New()

	// Test with year_from=2024&year_to=2024
	req := httptest.NewRequest(http.MethodGet, "/api/pages/map?year_from=2024&year_to=2024", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetMapPage(c); err != nil {
		t.Fatalf("GetMapPage failed: %v", err)
	}
	t.Logf("Response body: %s", rec.Body.String())

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
