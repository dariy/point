package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/services"
)

// ── NavMenu ────────────────────────────────────────────────────────────────

func newNavMenuHandler(t *testing.T) *NavMenuHandler {
	t.Helper()
	repo := setupTestDB(t)
	return NewNavMenuHandler(services.NewSettingsService(repo))
}

func TestNavMenuHandler_GetAdminNavMenu_Default(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/nav-menu", nil)
	rec := httptest.NewRecorder()
	if err := h.GetAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected default mode 'tags', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_Tags(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	body := `{"mode":"tags","items":[]}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.UpdateAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected mode 'tags', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_Custom(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	body := `{"mode":"custom","items":[{"id":1,"label":"Home","url":"/"}]}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.UpdateAdminNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("UpdateAdminNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	// Round-trip: GetAdminNavMenu should reflect the saved custom items.
	req2 := httptest.NewRequest(http.MethodGet, "/api/nav-menu", nil)
	rec2 := httptest.NewRecorder()
	_ = h.GetAdminNavMenu(e.NewContext(req2, rec2))
	var resp map[string]interface{}
	_ = json.Unmarshal(rec2.Body.Bytes(), &resp)
	if resp["mode"] != "custom" {
		t.Errorf("expected mode 'custom', got %v", resp["mode"])
	}
}

func TestNavMenuHandler_UpdateAdminNavMenu_InvalidMode(t *testing.T) {
	h := newNavMenuHandler(t)
	e := echo.New()

	// Invalid mode should fall back to "tags".
	body := `{"mode":"invalid","items":null}`
	req := httptest.NewRequest(http.MethodPut, "/api/nav-menu", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	_ = h.UpdateAdminNavMenu(e.NewContext(req, rec))
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if resp["mode"] != "tags" {
		t.Errorf("expected fallback mode 'tags', got %v", resp["mode"])
	}
}

// ── ForgotPassword ─────────────────────────────────────────────────────────

func newAuthHandlerForTest(t *testing.T, cfg *config.Config) *AuthHandler {
	t.Helper()
	repo := setupTestDB(t)
	authSvc := services.NewAuthService(repo)
	if cfg == nil {
		cfg = &config.Config{}
	}
	return NewAuthHandler(authSvc, cfg, repo)
}

func TestAuthHandler_ForgotPassword_EmptyEmail(t *testing.T) {
	h := newAuthHandlerForTest(t, nil)
	e := echo.New()
	body := `{"email":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ForgotPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ForgotPassword: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for empty email, got %d", rec.Code)
	}
}

func TestAuthHandler_ForgotPassword_SMTPNotConfigured(t *testing.T) {
	h := newAuthHandlerForTest(t, &config.Config{SMTPHost: ""})
	e := echo.New()
	body := `{"email":"test@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ForgotPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ForgotPassword: %v", err)
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503 when SMTP not configured, got %d", rec.Code)
	}
}

func TestAuthHandler_ForgotPassword_UserNotFound(t *testing.T) {
	// When SMTP is configured but the user doesn't exist, return 200 (no enumeration).
	h := newAuthHandlerForTest(t, &config.Config{SMTPHost: "smtp.example.com"})
	e := echo.New()
	body := `{"email":"nobody@example.com"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/forgot-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ForgotPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ForgotPassword: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 (no enumeration) when user not found, got %d", rec.Code)
	}
}

// ── ResetPassword ──────────────────────────────────────────────────────────

func TestAuthHandler_ResetPassword_MissingFields(t *testing.T) {
	h := newAuthHandlerForTest(t, nil)
	e := echo.New()
	body := `{"token":"","name":""}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ResetPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing fields, got %d", rec.Code)
	}
}

func TestAuthHandler_ResetPassword_InvalidPasswordLength(t *testing.T) {
	h := newAuthHandlerForTest(t, nil)
	e := echo.New()
	// Password must be 64 chars (SHA-256 hex); this is shorter.
	body := `{"token":"some-token","name":"tooshort"}`
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ResetPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid password length, got %d", rec.Code)
	}
}

func TestAuthHandler_ResetPassword_InvalidToken(t *testing.T) {
	h := newAuthHandlerForTest(t, nil)
	e := echo.New()
	// 64-char hash but token is bogus.
	hash64 := strings.Repeat("a", 64)
	reqBody, _ := json.Marshal(map[string]string{"token": "bogus-token", "name": hash64})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/reset-password", bytes.NewReader(reqBody))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := h.ResetPassword(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ResetPassword: %v", err)
	}
	if rec.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid token, got %d: %s", rec.Code, rec.Body.String())
	}
}

// ── GetNavMenu (pages) ─────────────────────────────────────────────────────

func newPagesHandlerForTest(t *testing.T) *PagesHandler {
	t.Helper()
	repo := setupTestDB(t)
	cfg := &config.Config{}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	cacheSvc := services.NewCacheService(t.TempDir())
	return NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheSvc)
}

func TestPagesHandler_GetNavMenu_TagsMode(t *testing.T) {
	h := newPagesHandlerForTest(t)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/pages/nav", nil)
	rec := httptest.NewRecorder()
	if err := h.GetNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	if _, ok := resp["menu"]; !ok {
		t.Error("response missing 'menu' key")
	}
}

func TestPagesHandler_GetNavMenu_CustomMode(t *testing.T) {
	repo := setupTestDB(t)
	cfg := &config.Config{}
	settingsSvc := services.NewSettingsService(repo)
	tagSvc := services.NewTagService(repo)
	postSvc := services.NewPostService(repo)
	mediaSvc := services.NewMediaService(repo, cfg, settingsSvc, tagSvc)
	cacheSvc := services.NewCacheService(t.TempDir())
	h := NewPagesHandler(repo, postSvc, tagSvc, mediaSvc, settingsSvc, cacheSvc)

	ctx := t.Context()
	_ = settingsSvc.SetSetting(ctx, "nav_menu_mode", "custom", "string")
	_ = settingsSvc.SetSetting(ctx, "custom_nav_menu", `[{"id":1,"label":"Home","url":"/"}]`, "string")

	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/pages/nav", nil)
	rec := httptest.NewRecorder()
	if err := h.GetNavMenu(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetNavMenu: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var resp map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &resp)
	menu, ok := resp["menu"].([]interface{})
	if !ok || len(menu) == 0 {
		t.Errorf("expected custom menu items, got %v", resp["menu"])
	}
}
