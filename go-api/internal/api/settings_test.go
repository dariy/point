package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

func TestSettingsHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

	settingsService := services.NewSettingsService(repo)
	handler := NewSettingsHandler(settingsService)

	e := echo.New()

	// Test Update
	updates := map[string]string{"blog_title": "Test Blog"}
	body, _ := json.Marshal(updates)
	req := httptest.NewRequest(http.MethodPost, "/settings", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.UpdateSettings(c); err != nil {
		t.Fatalf("UpdateSettings failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test Get Public
	req = httptest.NewRequest(http.MethodGet, "/settings/public", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	if err := handler.GetPublicSettings(c); err != nil {
		t.Fatalf("GetPublicSettings failed: %v", err)
	}
	var res map[string]string
	json.Unmarshal(rec.Body.Bytes(), &res)
	if res["blog_title"] != "Test Blog" {
		t.Errorf("expected Test Blog, got %s", res["blog_title"])
	}
}
