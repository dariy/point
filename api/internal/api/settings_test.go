package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

func TestSettingsHandler(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

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
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res["blog_title"] != "Test Blog" {
		t.Errorf("expected Test Blog, got %s", res["blog_title"])
	}
}

func TestSettingsHandler_GetSettings(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	handler := NewSettingsHandler(settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.GetSettings(c); err != nil {
		t.Fatalf("GetSettings failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestSettingsHandler_GetSettingByKey(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	settingsSvc := services.NewSettingsService(repo)
	handler := NewSettingsHandler(settingsSvc)
	e := echo.New()

	// Existing key
	req := httptest.NewRequest(http.MethodGet, "/api/settings/blog_title", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("key")
	c.SetParamValues("blog_title")
	if err := handler.GetSettingByKey(c); err != nil {
		t.Fatalf("GetSettingByKey failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestUpdateSettings_InvalidBind(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	settingsSvc := services.NewSettingsService(repo)
	h := NewSettingsHandler(settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(`"not_an_object"`)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.UpdateSettings(e.NewContext(req, rec)); err == nil {
		t.Error("expected bind error")
	}
}

func TestSettingsHandler_GetSettingByKey_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	settingsSvc := services.NewSettingsService(repo)
	_ = settingsSvc.SetSetting(ctx, "my_key", "my_value", "string")
	h := NewSettingsHandler(settingsSvc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/settings/my_key", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("key")
	c.SetParamValues("my_key")
	if err := h.GetSettingByKey(c); err != nil {
		t.Fatalf("GetSettingByKey failed: %v", err)
	}
}
