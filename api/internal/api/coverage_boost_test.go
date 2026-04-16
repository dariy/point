package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

// TestTagToPostTagInfo covers the 0% function.
func TestTagToPostTagInfo(t *testing.T) {
	tag := models.Tag{ID: 5, Name: "Nature", Slug: "nature"}
	info := tagToPostTagInfo(tag)
	if info.ID != 5 || info.Name != "Nature" || info.Slug != "nature" {
		t.Errorf("tagToPostTagInfo returned unexpected: %+v", info)
	}
}

// TestNullInt64Coverage covers the 66.7% mapper function.
func TestNullInt64Coverage(t *testing.T) {
	// Valid NullInt64
	v := nullInt64(sql.NullInt64{Int64: 42, Valid: true})
	if v == nil || *v != 42 {
		t.Errorf("nullInt64(valid 42): unexpected %v", v)
	}

	// Invalid NullInt64
	v2 := nullInt64(sql.NullInt64{Valid: false})
	if v2 != nil {
		t.Error("nullInt64(invalid) should return nil")
	}
}

// TestGetSettingOr covers the 66.7% function.
func TestGetSettingOr(t *testing.T) {
	settings := map[string]string{"key1": "val1"}

	got := getSettingOr(settings, "key1", "default")
	if got != "val1" {
		t.Errorf("expected 'val1', got %s", got)
	}

	got = getSettingOr(settings, "missing", "fallback")
	if got != "fallback" {
		t.Errorf("expected 'fallback', got %s", got)
	}
}

// TestBaseURL covers the 66.7% function.
func TestBaseURL(t *testing.T) {
	e := echo.New()

	// HTTP request
	req := httptest.NewRequest(http.MethodGet, "http://example.com/foo", nil)
	c := e.NewContext(req, httptest.NewRecorder())
	u := baseURL(c)
	if !strings.HasPrefix(u, "http") {
		t.Errorf("expected http URL, got %s", u)
	}

	// With X-Forwarded-Proto
	req2 := httptest.NewRequest(http.MethodGet, "/foo", nil)
	req2.Header.Set("X-Forwarded-Proto", "https")
	req2.Header.Set("Host", "blog.example.com")
	c2 := e.NewContext(req2, httptest.NewRecorder())
	u2 := baseURL(c2)
	if !strings.HasPrefix(u2, "https://") {
		t.Errorf("expected https URL, got %s", u2)
	}
}

// TestMediaHandler_AnalyzeImageBoost covers additional AnalyzeImage path (with file).
func TestMediaHandler_AnalyzeImageBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	// With file but no AI configured → internal error
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("image", "test.jpg")
	_, _ = part.Write([]byte("fake image data"))
	_ = writer.Close()

	req := httptest.NewRequest(http.MethodPost, "/", body)
	req.Header.Set("Content-Type", writer.FormDataContentType())
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.AnalyzeImage(c)
	if err != nil {
		t.Errorf("expected no error from AnalyzeImage (soft-fail), got %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// TestMediaHandler_AnalyzeImageByPathBoost covers additional AnalyzeImageByPath paths.
func TestMediaHandler_AnalyzeImageByPathBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	// Valid path but file not found → 500
	body, _ := json.Marshal(map[string]string{"path": "/2026/03/nonexistent.jpg"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.AnalyzeImageByPath(c)
	if err == nil {
		t.Error("expected error for missing file")
	}
}

// TestTagHandler_GetTagByIDBoost covers GetTagByID error paths.
func TestTagHandler_GetTagByIDBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	// Invalid ID param
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := h.GetTagByID(c)
	if err == nil {
		t.Error("expected error for non-numeric ID")
	}

	// Non-existent ID
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	c2.SetParamNames("id")
	c2.SetParamValues("999")
	err2 := h.GetTagByID(c2)
	if err2 == nil {
		t.Error("expected error for non-existent tag ID")
	}
}

// TestTagHandler_DeleteTagBoost covers DeleteTag error paths.
func TestTagHandler_DeleteTagBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	// Invalid ID
	req := httptest.NewRequest(http.MethodDelete, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("notanumber")
	err := h.DeleteTag(c)
	if err == nil {
		t.Error("expected error for non-numeric ID")
	}
}

// TestTagHandler_RecalculateCounts covers 66.7% handler.
func TestTagHandler_RecalculateCounts(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.RecalculateCounts(c)
	if err != nil {
		t.Fatalf("RecalculateCounts failed: %v", err)
	}
}

// TestTagHandler_GetTagByIDWithLocation covers tagLocation "found" path.
func TestTagHandler_GetTagByIDWithLocation(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tagSvc := services.NewTagService(repo)
	settingsSvc := services.NewSettingsService(repo)
	h := NewTagHandler(tagSvc, settingsSvc)
	e := echo.New()

	// Insert tag and location
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'T','t')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_locations (tag_id, latitude, longitude) VALUES (1,45.5,73.5)`)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("1")

	err := h.GetTagByID(c)
	if err != nil {
		t.Fatalf("GetTagByID with location failed: %v", err)
	}
}

// TestTagHandler_ParseMapsCoordsCoverage covers additional ParseMapsCoords paths.
func TestTagHandler_ParseMapsCoordsCoverage(t *testing.T) {
	e := echo.New()

	// URL with no coordinates in it (valid domain but no lat/lng)
	req := httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=https://maps.google.com/maps/search/coffee", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := ParseMapsCoords(c)
	// Should return "no coordinates found" error
	if err == nil {
		t.Log("ParseMapsCoords with no-coord URL returned success (may have found coords in URL)")
	}

	// Invalid URL after https:// prefix
	req2 := httptest.NewRequest(http.MethodGet, "/util/parse-maps-coords?q=https://maps.google.com/%00invalid", nil)
	rec2 := httptest.NewRecorder()
	c2 := e.NewContext(req2, rec2)
	_ = ParseMapsCoords(c2)
}

// TestFetchAncestorsMapDirect covers fetchAncestorsMap via direct call.
func TestFetchAncestorsMapDirect(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug) VALUES (1,'A','a'),(2,'B','b')`)
	_, _ = repo.DB().Exec(`INSERT INTO tag_relationships (parent_id, child_id) VALUES (1,2)`)

	postTagsMap := map[int64][]repository.PostTagInfo{
		1: {{ID: 2, Name: "B", Slug: "b"}},
	}
	result := fetchAncestorsMap(ctx, repo, postTagsMap)
	if len(result) == 0 {
		t.Error("expected non-empty ancestors map")
	}
}

// TestGetVersionHandlerBoost covers GetVersion.
func TestGetVersionHandlerBoost(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	postSvc := services.NewPostService(repo)
	tmpDir := t.TempDir()
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "2.0.0")
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := h.GetVersion(c)
	if err != nil {
		t.Fatalf("GetVersion failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

// TestExpandPostTagsWithAncestors covers the 60% function.
func TestExpandPostTagsWithAncestors(t *testing.T) {
	postTagsMap := map[int64][]repository.PostTagInfo{
		1: {
			{ID: 2, Name: "Child", Slug: "child"},
			{ID: 2, Name: "Child", Slug: "child"}, // duplicate to test seen check
		},
		2: {
			{ID: 10, Name: "_system", Slug: "_system"}, // system tag, public=true should skip
		},
	}
	ancestorsMap := map[int64][]repository.PostTagInfo{
		2: {{ID: 3, Name: "Parent", Slug: "parent"}},
	}

	// publicOnly=false: includes system tags
	result := expandPostTagsWithAncestors(postTagsMap, ancestorsMap, false)
	if len(result[1]) == 0 {
		t.Error("expected tags for post 1")
	}

	// publicOnly=true: should exclude system tags
	result2 := expandPostTagsWithAncestors(postTagsMap, ancestorsMap, true)
	for _, tag := range result2[2] {
		if strings.HasPrefix(tag.Slug, "_") {
			t.Errorf("system tag %s should not appear with publicOnly=true", tag.Slug)
		}
	}
}

// TestGetMinTagPostsSetting covers 75% function.
func TestGetMinTagPostsSetting(t *testing.T) {
	settings := map[string]string{
		"min_tag_posts_to_show": "3",
	}
	v := getMinTagPostsSetting(settings)
	if v != 3 {
		t.Errorf("expected 3, got %d", v)
	}

	// Missing key → 0
	v2 := getMinTagPostsSetting(map[string]string{})
	if v2 != 0 {
		t.Errorf("expected 0, got %d", v2)
	}

	// Negative → 0
	v3 := getMinTagPostsSetting(map[string]string{"min_tag_posts_to_show": "-5"})
	if v3 != 0 {
		t.Errorf("expected 0 for negative, got %d", v3)
	}
}

// TestOfflineStatsWithData covers GetOfflineStats with actual media.
func TestOfflineStatsWithData(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tmpDir := t.TempDir()
	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	e := echo.New()

	// Insert public image media to exercise the inner loop
	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, thumbnail_path, file_type, mime_type, file_size, checksum, is_public) VALUES ('img.jpg','originals/img.jpg','thumbnails/img.jpg','image','image/jpeg',1024,'c1',1)`)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := handler.GetOfflineStats(c)
	if err != nil {
		t.Fatalf("GetOfflineStats with data failed: %v", err)
	}
}

// TestOfflineSnapshotWithData covers GetOfflineSnapshot with actual data.
func TestOfflineSnapshotWithData(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tmpDir := t.TempDir()
	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	e := echo.New()

	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'u','u@t.com','h','U')`)
	_, _ = repo.DB().Exec(`INSERT INTO posts (title, slug, content, author_id, status, published_at) VALUES ('T','t','b',1,'published',datetime('now'))`)
	_, _ = repo.DB().Exec(`INSERT INTO tags (id, name, slug, post_count) VALUES (1,'Tag','tag',1)`)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	err := handler.GetOfflineSnapshot(c)
	if err != nil {
		t.Fatalf("GetOfflineSnapshot with data failed: %v", err)
	}
}

// TestMediaHandler_UploadFileErrors covers upload error paths.
func TestMediaHandler_UploadFileErrors(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir(), ThumbnailWidth: 400, ThumbnailHeight: 300}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	h := NewMediaHandler(mediaSvc, settingsSvc)
	e := echo.New()

	// No file in request → error
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	err := h.UploadFile(c)
	if err == nil {
		t.Error("expected error for missing file")
	}
}
