package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// mockInstagramConnector is a test double for instagramConnector.
type mockInstagramConnector struct {
	exchangeFn    func(code, redirectURI string) (string, string, int64, error)
	getAccountFn  func() (string, string, string, error)
}

func (m *mockInstagramConnector) ExchangeCodeForLongLivedToken(_ context.Context, code, redirectURI string) (string, string, int64, error) {
	return m.exchangeFn(code, redirectURI)
}

func (m *mockInstagramConnector) GetConnectedAccount(_ context.Context) (string, string, string, error) {
	return m.getAccountFn()
}

func newTestInstagramHandler(t *testing.T, mock *mockInstagramConnector, appURL string) (*InstagramHandler, *services.SettingsService) {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	settingsSvc := services.NewSettingsService(repo)
	cfg := &config.Config{AppURL: appURL}
	h := &InstagramHandler{instagram: mock, settings: settingsSvc, cfg: cfg}
	return h, settingsSvc
}

// ── Connect ───────────────────────────────────────────────────────────────────

func TestInstagramHandler_Connect_MissingAppID(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, _ := newTestInstagramHandler(t, mock, "https://example.com")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/connect", nil)
	rec := httptest.NewRecorder()
	err := h.Connect(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error when app_id missing")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Connect_MissingAppURL(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_app_id", "123456")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/connect", nil)
	rec := httptest.NewRecorder()
	err := h.Connect(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error when APP_URL missing")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Connect_RedirectsToMeta(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_app_id", "APP123")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/connect", nil)
	rec := httptest.NewRecorder()
	if err := h.Connect(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.Contains(loc, "www.facebook.com/v25.0/dialog/oauth") {
		t.Errorf("redirect should point to Facebook OAuth, got: %s", loc)
	}
	if !strings.Contains(loc, "client_id=APP123") {
		t.Errorf("redirect should include client_id, got: %s", loc)
	}
	if !strings.Contains(loc, "redirect_uri=") {
		t.Errorf("redirect should include redirect_uri, got: %s", loc)
	}
	if !strings.Contains(loc, "state=") {
		t.Errorf("redirect should include state, got: %s", loc)
	}
	// State should be stored in secrets
	if !settingsSvc.SecretIsSet(context.Background(), "instagram_oauth_state") {
		t.Error("OAuth state should be stored in secrets")
	}
}

// ── Callback ─────────────────────────────────────────────────────────────────

func TestInstagramHandler_Callback_OAuthError(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, _ := newTestInstagramHandler(t, mock, "https://example.com")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?error=access_denied&error_description=User+denied", nil)
	rec := httptest.NewRecorder()
	err := h.Callback(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error for OAuth denial")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Callback_MissingParams(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, _ := newTestInstagramHandler(t, mock, "https://example.com")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=abc", nil)
	rec := httptest.NewRecorder()
	err := h.Callback(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error for missing state")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Callback_BadState(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_oauth_state", "correctstate")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=abc&state=wrongstate", nil)
	rec := httptest.NewRecorder()
	err := h.Callback(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error for bad CSRF state")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Callback_TokenExchangeFailure(t *testing.T) {
	mock := &mockInstagramConnector{
		exchangeFn: func(_, _ string) (string, string, int64, error) {
			return "", "", 0, fmt.Errorf("invalid code")
		},
	}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_oauth_state", "validstate")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=bad&state=validstate", nil)
	rec := httptest.NewRecorder()
	err := h.Callback(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error when token exchange fails")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Errorf("expected 400, got %v", err)
	}
}

func TestInstagramHandler_Callback_GetAccountFailure(t *testing.T) {
	mock := &mockInstagramConnector{
		exchangeFn: func(_, _ string) (string, string, int64, error) {
			return "longtoken", "1234567890", 5184000, nil
		},
		getAccountFn: func() (string, string, string, error) {
			return "", "", "", fmt.Errorf("API error")
		},
	}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_oauth_state", "validstate")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=good&state=validstate", nil)
	rec := httptest.NewRecorder()
	err := h.Callback(e.NewContext(req, rec))
	if err == nil {
		t.Fatal("expected error when GetConnectedAccount fails")
	}
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusInternalServerError {
		t.Errorf("expected 500, got %v", err)
	}
	// Token should be cleaned up after failure
	if settingsSvc.SecretIsSet(context.Background(), "instagram_access_token") {
		t.Error("access token should be cleaned up after GetConnectedAccount failure")
	}
}

func TestInstagramHandler_Callback_Success(t *testing.T) {
	mock := &mockInstagramConnector{
		exchangeFn: func(code, _ string) (string, string, int64, error) {
			if code != "authcode" {
				return "", "", 0, fmt.Errorf("unexpected code")
			}
			return "long-lived-token", "1234567890", 5184000, nil
		},
		getAccountFn: func() (string, string, string, error) {
			return "testuser", "1234567890", "BUSINESS", nil
		},
	}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_oauth_state", "goodstate")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=authcode&state=goodstate", nil)
	rec := httptest.NewRecorder()
	if err := h.Callback(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d: %s", rec.Code, rec.Body.String())
	}
	loc := rec.Header().Get("Location")
	if !strings.Contains(loc, "/light/settings") {
		t.Errorf("should redirect to settings, got: %s", loc)
	}

	ctx := context.Background()
	// Secrets stored
	if !settingsSvc.SecretIsSet(ctx, "instagram_access_token") {
		t.Error("access token should be stored")
	}
	if !settingsSvc.SecretIsSet(ctx, "instagram_user_id") {
		t.Error("user_id should be stored")
	}
	if !settingsSvc.SecretIsSet(ctx, "instagram_token_expires_at") {
		t.Error("token_expires_at should be stored")
	}
	if !settingsSvc.SecretIsSet(ctx, "instagram_username") {
		t.Error("username should be stored")
	}

	// State token consumed
	if settingsSvc.SecretIsSet(ctx, "instagram_oauth_state") {
		t.Error("OAuth state should be deleted after use")
	}
}

func TestInstagramHandler_Callback_PersonalAccount(t *testing.T) {
	mock := &mockInstagramConnector{
		exchangeFn: func(_, _ string) (string, string, int64, error) {
			return "longtoken", "1234567890", 5184000, nil
		},
		getAccountFn: func() (string, string, string, error) {
			return "personaluser", "1234567890", "PERSONAL", nil
		},
	}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	_ = settingsSvc.SetSecret(context.Background(), "instagram_oauth_state", "validstate")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/callback?code=good&state=validstate", nil)
	rec := httptest.NewRecorder()
	if err := h.Callback(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusFound {
		t.Fatalf("expected 302, got %d", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.Contains(loc, "/light/settings?error=instagram_personal#instagram") {
		t.Errorf("expected personal account error redirect, got: %s", loc)
	}

	ctx := context.Background()
	// Credentials should NOT be stored
	if settingsSvc.SecretIsSet(ctx, "instagram_access_token") {
		t.Error("access token should not be stored for personal account")
	}
	if settingsSvc.SecretIsSet(ctx, "instagram_user_id") {
		t.Error("user_id should not be stored for personal account")
	}

	// State token consumed
	if settingsSvc.SecretIsSet(ctx, "instagram_oauth_state") {
		t.Error("OAuth state should be deleted after use")
	}
}

// ── Disconnect ────────────────────────────────────────────────────────────────

func TestInstagramHandler_Disconnect(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	ctx := context.Background()
	_ = settingsSvc.SetSecret(ctx, "instagram_access_token", "tok")
	_ = settingsSvc.SetSecret(ctx, "instagram_user_id", "uid")
	_ = settingsSvc.SetSecret(ctx, "instagram_token_expires_at", "2026-01-01T00:00:00Z")
	_ = settingsSvc.SetSecret(ctx, "instagram_username", "user")
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/api/instagram/disconnect", nil)
	rec := httptest.NewRecorder()
	if err := h.Disconnect(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	for _, key := range []string{"instagram_access_token", "instagram_user_id", "instagram_token_expires_at", "instagram_username"} {
		if settingsSvc.SecretIsSet(ctx, key) {
			t.Errorf("secret %q should be deleted after disconnect", key)
		}
	}
}

// ── Status ────────────────────────────────────────────────────────────────────

func TestInstagramHandler_Status_NotConnected(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, _ := newTestInstagramHandler(t, mock, "https://example.com")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/status", nil)
	rec := httptest.NewRecorder()
	if err := h.Status(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	var resp InstagramStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp.Connected {
		t.Error("should not be connected")
	}
	if resp.Enabled {
		t.Error("should not be enabled")
	}
}

func TestInstagramHandler_Status_Connected(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	ctx := context.Background()
	_ = settingsSvc.SetSecret(ctx, "instagram_access_token", "tok")
	_ = settingsSvc.SetSecret(ctx, "instagram_username", "johndoe")
	_ = settingsSvc.SetSecret(ctx, "instagram_token_expires_at", "2027-01-01T00:00:00Z")
	_ = settingsSvc.SetSetting(ctx, "enable_instagram", "true", "boolean")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/status", nil)
	rec := httptest.NewRecorder()
	if err := h.Status(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var resp InstagramStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if !resp.Connected {
		t.Error("should be connected")
	}
	if resp.Username != "johndoe" {
		t.Errorf("expected username 'johndoe', got %q", resp.Username)
	}
	if resp.TokenExpiresAt != "2027-01-01T00:00:00Z" {
		t.Errorf("unexpected token_expires_at: %s", resp.TokenExpiresAt)
	}
	if !resp.Enabled {
		t.Error("should be enabled")
	}
	if resp.DefaultShare {
		t.Error("default_share should be false when setting not set")
	}
}

func TestInstagramHandler_Status_DefaultShare(t *testing.T) {
	mock := &mockInstagramConnector{}
	h, settingsSvc := newTestInstagramHandler(t, mock, "https://example.com")
	ctx := context.Background()
	_ = settingsSvc.SetSecret(ctx, "instagram_access_token", "tok")
	_ = settingsSvc.SetSetting(ctx, "enable_instagram", "true", "boolean")
	_ = settingsSvc.SetSetting(ctx, "instagram_default_share", "true", "boolean")
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/instagram/status", nil)
	rec := httptest.NewRecorder()
	if err := h.Status(e.NewContext(req, rec)); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	var resp InstagramStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if !resp.DefaultShare {
		t.Error("default_share should be true when setting is 'true'")
	}
}
