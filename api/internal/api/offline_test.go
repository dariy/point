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
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
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
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
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
