package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

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
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
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
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
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
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	handler := NewSystemHandler(repo, mediaSvc, settingsSvc, tagSvc, tmpDir)
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
