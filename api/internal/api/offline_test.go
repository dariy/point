package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/services"
)

func TestSystemHandler_OfflineStats(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "api-sys-offline-stats-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/api/system/offline/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetOfflineStats(c); err != nil {
		t.Fatalf("GetOfflineStats failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	// Verify required fields
	required := []string{"post_count", "image_count", "thumbnail_bytes", "original_bytes"}
	for _, field := range required {
		if _, ok := resp[field]; !ok {
			t.Errorf("expected field %s in response", field)
		}
	}
}

func TestSystemHandler_OfflineSnapshot(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "api-sys-offline-snapshot-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	cfg := &config.Config{StoragePath: tmpDir}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.0.0")
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/api/system/offline/snapshot", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetOfflineSnapshot(c); err != nil {
		t.Fatalf("GetOfflineSnapshot failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	// Verify required fields
	required := []string{"posts", "tags", "tag_relationships", "tag_locations", "media", "exported_at"}
	for _, field := range required {
		if _, ok := resp[field]; !ok {
			t.Errorf("expected field %s in response", field)
		}
	}
}

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

	_, _ = repo.DB().Exec(`INSERT INTO media (filename, original_path, thumbnail_path, file_type, mime_type, file_size, checksum, is_public) VALUES ('img.jpg','originals/img.jpg','thumbnails/img.jpg','image','image/jpeg',1024,'c1',1)`)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := handler.GetOfflineStats(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetOfflineStats with data failed: %v", err)
	}
}

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
	if err := handler.GetOfflineSnapshot(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetOfflineSnapshot with data failed: %v", err)
	}
}
