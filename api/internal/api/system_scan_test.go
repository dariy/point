package api

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/services"
)

func TestSystemHandler_Restore_Error(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "api-sys-restore-test")
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

	// Restore non-existent backup
	req := httptest.NewRequest(http.MethodPost, "/system/restore/missing.tar.gz", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("missing.tar.gz")

	err := handler.RestoreBackup(c)
	if err == nil {
		t.Error("expected error for non-existent backup restore")
	}

	// Delete non-existent backup
	req = httptest.NewRequest(http.MethodDelete, "/system/backups/missing.tar.gz", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("filename")
	c.SetParamValues("missing.tar.gz")
	err = handler.DeleteBackup(c)
	if err == nil {
		t.Error("expected error for non-existent backup delete")
	} else if he, ok := err.(*echo.HTTPError); ok {
		if he.Code != http.StatusNotFound {
			t.Errorf("expected 404, got %d", he.Code)
		}
	}
}

func TestSystemHandler_StatsExtended(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "api-sys-stats-test")
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

	req := httptest.NewRequest(http.MethodGet, "/stats", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetStats(c); err != nil {
		t.Fatalf("GetStats failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_UpdateMapCoordsExtended(t *testing.T) {
	repo := setupTestDB(t)
	tmpDir, _ := os.MkdirTemp("", "api-sys-coords-test")
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

	reqBody, _ := json.Marshal(map[string]interface{}{})
	req := httptest.NewRequest(http.MethodPost, "/system/coords", bytes.NewReader(reqBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.UpdateMapCoords(c); err != nil {
		t.Fatalf("UpdateMapCoords failed: %v", err)
	}
}

func setupSystemHandler(t *testing.T) (*SystemHandler, func()) {
	t.Helper()
	repo := setupTestDB(t)
	tmpDir := t.TempDir()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.2.3")
	return h, func() { _ = repo.Close() }
}

func TestScanMediaImport_NotConfigured(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestScanMediaImport_PathNotExist(t *testing.T) {
	e := echo.New()

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsSvc := services.NewSettingsService(repo)

	ctx := context.Background()
	tmpDir2 := t.TempDir()
	systemSvc2 := services.NewSystemService(repo, tmpDir2)
	cacheSvc2 := services.NewCacheService(tmpDir2)
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", "/nonexistent/does/not/exist")
	h2 := NewSystemHandler(repo, nil, nil, settingsSvc, nil, systemSvc2, cacheSvc2, tmpDir2, "1.0")
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h2.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestScanMediaImport_WithFiles(t *testing.T) {
	e := echo.New()

	importDir := t.TempDir()

	img := image.NewRGBA(image.Rect(0, 0, 5, 5))
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, nil)
	imgPath := filepath.Join(importDir, "scan_test.jpg")
	_ = os.WriteFile(imgPath, buf.Bytes(), 0644)
	_ = os.WriteFile(filepath.Join(importDir, "readme.txt"), []byte("hello"), 0644)

	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	tmpDir := t.TempDir()
	mediaSvc := services.NewMediaService(repo, &config.Config{
		StoragePath:     tmpDir,
		ThumbnailWidth:  400,
		ThumbnailHeight: 300,
	}, settingsSvc, tagSvc)
	systemSvc := services.NewSystemService(repo, tmpDir)
	cacheSvc := services.NewCacheService(tmpDir)
	ctx := context.Background()
	_ = settingsSvc.SetSecret(ctx, "photo_library_path", importDir)
	h := NewSystemHandler(repo, mediaSvc, postSvc, settingsSvc, tagSvc, systemSvc, cacheSvc, tmpDir, "1.2.3")

	req := httptest.NewRequest(http.MethodPost, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ScanMediaImport(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ScanMediaImport with files failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}

	rec2 := httptest.NewRecorder()
	_ = h.ScanMediaImport(e.NewContext(httptest.NewRequest(http.MethodPost, "/", nil), rec2))
}

func TestListBackups_WithFiles(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	backupDir := filepath.Join(h.dataPath, "backups")
	_ = os.MkdirAll(backupDir, 0755)
	_ = os.WriteFile(filepath.Join(backupDir, "backup.tar.gz"), []byte("fake"), 0644)
	_ = os.WriteFile(filepath.Join(backupDir, "notes.txt"), []byte("skip me"), 0644)
	_ = os.Mkdir(filepath.Join(backupDir, "subdir"), 0755)

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.ListBackups(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListBackups failed: %v", err)
	}
	var result []interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &result)
	if len(result) != 1 {
		t.Errorf("expected 1 backup (only .tar.gz), got %d", len(result))
	}
}

func TestGetVersion_WithCache(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	cacheData := map[string]interface{}{
		"latest":     "v9.9.9",
		"checked_at": time.Now().UTC().Format(time.RFC3339),
	}
	cacheJSON, _ := json.Marshal(cacheData)
	ctx := context.Background()
	_ = h.settingsService.SetSetting(ctx, "_version_check_cached", string(cacheJSON), "string")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetVersion(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetVersion with cache failed: %v", err)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["latest"] != "v9.9.9" {
		t.Errorf("expected latest=v9.9.9, got %v", resp["latest"])
	}
	if resp["update_available"] != true {
		t.Errorf("expected update_available=true")
	}
}

func TestGetVersionHandlerBoost(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetVersion(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetVersion failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSystemHandler_GetMigrations_Success(t *testing.T) {
	h, cleanup := setupSystemHandler(t)
	defer cleanup()
	e := echo.New()

	ctx := context.Background()
	_ = h.repo.ApplyMigration(ctx, "test_mig", "SELECT 1")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	if err := h.GetMigrations(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetMigrations handler failed: %v", err)
	}
}
