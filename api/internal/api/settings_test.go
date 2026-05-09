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

func TestSettingsHandler_GetPublicSettings(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	_ = svc.SetSetting(ctx, "blog_title", "Test Blog", "string")
	h := NewSettingsHandler(svc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/settings/public", nil)
	rec := httptest.NewRecorder()
	if err := h.GetPublicSettings(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetPublicSettings: %v", err)
	}
	var res map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &res)
	if res["blog_title"] != "Test Blog" {
		t.Errorf("expected Test Blog, got %q", res["blog_title"])
	}
}

func TestSettingsHandler_GetSettings_SecretKeysAbsent(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	// Store secrets — they must never appear in the response.
	_ = svc.SetSecret(ctx, "_secret_key", "super_secret")
	_ = svc.SetSecret(ctx, "gemini_api_key", "gkey")
	_ = svc.SetSetting(ctx, "blog_title", "My Blog", "string")

	h := NewSettingsHandler(svc)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	rec := httptest.NewRecorder()
	if err := h.GetSettings(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var res map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	if _, ok := res["_secret_key"]; ok {
		t.Error("_secret_key must not appear in settings response")
	}
	if _, ok := res["gemini_api_key"]; ok {
		t.Error("gemini_api_key value must not appear in settings response")
	}
	if res["gemini_api_key_is_set"] != "true" {
		t.Errorf("gemini_api_key_is_set should be true, got %q", res["gemini_api_key_is_set"])
	}
	if res["media_import_path_is_set"] != "false" {
		t.Errorf("media_import_path_is_set should be false, got %q", res["media_import_path_is_set"])
	}
	if res["blog_title"] != "My Blog" {
		t.Errorf("blog_title should be My Blog, got %q", res["blog_title"])
	}
}

func TestSettingsHandler_UpdateSettings_SecretRouted(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	h := NewSettingsHandler(svc)
	e := echo.New()

	body, _ := json.Marshal(map[string]string{"gemini_api_key": "new_key", "blog_title": "Updated"})
	req := httptest.NewRequest(http.MethodPut, "/api/settings", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.UpdateSettings(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	var res map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &res)

	// Secret value never returned.
	if _, ok := res["gemini_api_key"]; ok {
		t.Error("gemini_api_key value must not appear in update response")
	}
	// Synthetic flag present.
	if res["gemini_api_key_is_set"] != "true" {
		t.Errorf("expected gemini_api_key_is_set=true, got %q", res["gemini_api_key_is_set"])
	}
	// Normal setting updated.
	if res["blog_title"] != "Updated" {
		t.Errorf("expected blog_title=Updated, got %q", res["blog_title"])
	}
	// Value written to secrets table.
	val, _ := svc.GetSecret(ctx, "gemini_api_key")
	if val != "new_key" {
		t.Errorf("expected secret new_key, got %q", val)
	}
}

func TestSettingsHandler_GetSettingByKey(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()
	ctx := context.Background()

	svc := services.NewSettingsService(repo)
	_ = svc.SetSetting(ctx, "my_key", "my_value", "string")
	h := NewSettingsHandler(svc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodGet, "/settings/my_key", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("key")
	c.SetParamValues("my_key")
	if err := h.GetSettingByKey(c); err != nil {
		t.Fatalf("GetSettingByKey: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestUpdateSettings_InvalidBind(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	svc := services.NewSettingsService(repo)
	h := NewSettingsHandler(svc)
	e := echo.New()

	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader([]byte(`"not_an_object"`)))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.UpdateSettings(e.NewContext(req, rec)); err == nil {
		t.Error("expected bind error")
	}
}
