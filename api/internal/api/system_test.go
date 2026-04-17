package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestSystemHandler_Stats(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "system-api-test")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService, tagService)
	systemService := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaService, postService, settingsService, tagService, systemService, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/system/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestSystemHandler_Logs(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "system-api-test-logs")
	defer func() {
		_ = repo.Close()
		_ = os.RemoveAll(tmpDir)
	}()

	// Create a log file
	logPath := filepath.Join(tmpDir, "logs", "app.log")
	_ = os.MkdirAll(filepath.Join(tmpDir, "logs"), 0755)
	_ = os.WriteFile(logPath, []byte(`line1
line2
line3`), 0644)

	settingsService := services.NewSettingsService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService, tagService)
	systemService := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	handler := NewSystemHandler(repo, mediaService, postService, settingsService, tagService, systemService, cacheSvc, tmpDir, "1.0.0")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/system/logs", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetLogs(c); err != nil {
		t.Fatalf("GetLogs failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestSystemHandler_GetMigrations(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
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
	req := httptest.NewRequest(http.MethodGet, "/system/migrations", nil)
	rec := httptest.NewRecorder()

	if err := handler.GetMigrations(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMigrations failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_RecalculateMediaVisibility(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
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
	req := httptest.NewRequest(http.MethodPost, "/system/media/recalculate", nil)
	rec := httptest.NewRecorder()

	if err := handler.RecalculateMediaVisibility(e.NewContext(req, rec)); err != nil {
		t.Fatalf("RecalculateMediaVisibility failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_UpdateMapCoords(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
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
	req := httptest.NewRequest(http.MethodPost, "/system/tags/update-coords", nil)
	rec := httptest.NewRecorder()

	if err := handler.UpdateMapCoords(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateMapCoords failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_ClearCache(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "sys-test")
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
	req := httptest.NewRequest(http.MethodPost, "/api/system/cache/clear", nil)
	rec := httptest.NewRecorder()

	if err := handler.ClearCache(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ClearCache failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["status"] != "success" {
		t.Errorf("expected status 'success', got %v", resp["status"])
	}

	if _, ok := resp["updated_media"]; !ok {
		t.Errorf("expected 'updated_media' field in response")
	}
}

func TestSystemHandler_GetStats_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	tmpDir := t.TempDir()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{StoragePath: tmpDir}, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.2.3")
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1})
	if err := h.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
}
