package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/services"
)

func TestSystemHandler_Stats(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "system-api-test")
	defer os.RemoveAll(tmpDir)

	settingsService := services.NewSettingsService(repo)
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService)
	tagService := services.NewTagService(repo)
	handler := NewSystemHandler(repo, mediaService, settingsService, tagService, tmpDir)

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
	defer repo.Close()

	tmpDir, _ := os.MkdirTemp("", "system-api-test-logs")
	defer os.RemoveAll(tmpDir)

	// Create logs dir and file
	os.MkdirAll(filepath.Join(tmpDir, "logs"), 0755)
	logPath := filepath.Join(tmpDir, "logs", "app.log")
	os.WriteFile(logPath, []byte(`line1
line2
`), 0644)

	settingsService := services.NewSettingsService(repo)
	mediaService := services.NewMediaService(repo, &config.Config{}, settingsService)
	tagService := services.NewTagService(repo)
	handler := NewSystemHandler(repo, mediaService, settingsService, tagService, tmpDir)

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
