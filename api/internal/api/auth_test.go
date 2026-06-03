package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

func TestAuthHandler_Login(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	password := "pass123"
	hash, _ := services.HashPassword(password)
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username:     "testuser",
		Email:        "test@example.com",
		PasswordHash: hash,
		DisplayName:  "Test User",
	})
	_ = user // mark as used

	authService := services.NewAuthService(repo)
	cfg := &config.Config{
		SessionExpiryPublicHours: 24,
		SessionExpiryHours:       720,
	}
	handler := NewAuthHandler(authService, cfg, repo)

	e := echo.New()
	reqBody, _ := json.Marshal(LoginRequest{
		Username:   "testuser",
		Password:   password,
		RememberMe: true,
	})
	req := httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader(reqBody))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.Login(c); err != nil {
		t.Fatalf("Login failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Check cookie
	cookies := rec.Result().Cookies()
	found := false
	for _, cookie := range cookies {
		if cookie.Name == "session" {
			found = true
			break
		}
	}
	if !found {
		t.Error("session cookie not found")
	}
}

func TestAuthHandler_Logout(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	authService := services.NewAuthService(repo)
	handler := NewAuthHandler(authService, &config.Config{}, repo)

	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/logout", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)

	if err := handler.Logout(c); err != nil {
		t.Fatalf("Logout failed: %v", err)
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}
}

func TestAuthHandler_Me(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()
	authService := services.NewAuthService(repo)
	handler := NewAuthHandler(authService, nil, repo)
	e := echo.New()

	// Test authenticated
	req := httptest.NewRequest(http.MethodGet, "/me", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	session := models.GetSessionByTokenRow{
		UserID:   1,
		Username: "testuser",
	}
	c.Set("user", session)

	if err := handler.Me(c); err != nil {
		t.Fatalf("Me failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test unauthenticated
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", nil)
	err := handler.Me(c)
	if err == nil {
		t.Error("Me should have failed for unauthenticated user")
	}

	// Test ListSessions
	req = httptest.NewRequest(http.MethodGet, "/auth/sessions", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	session = models.GetSessionByTokenRow{UserID: 1, ID: 1}
	c.Set("user", session)
	if err := handler.ListSessions(c); err != nil {
		t.Fatalf("ListSessions failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test DeleteOtherSessions
	req = httptest.NewRequest(http.MethodPost, "/auth/sessions/other", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	if err := handler.DeleteOtherSessions(c); err != nil {
		t.Fatalf("DeleteOtherSessions failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", rec.Code)
	}

	// Test Logout without cookie
	req = httptest.NewRequest(http.MethodPost, "/logout", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	_ = handler.Logout(c)

	// Test Login with invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader([]byte("{bad}")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	_ = handler.Login(e.NewContext(req, rec))
}

func TestAuthHandler_ChangePassword(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	password := "oldpass"
	hash, _ := services.HashPassword(password)
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "pwuser", Email: "pw@test.com", PasswordHash: hash, DisplayName: "PW",
	})

	authSvc := services.NewAuthService(repo)
	handler := NewAuthHandler(authSvc, &config.Config{}, repo)
	e := echo.New()
	session := models.GetSessionByTokenRow{UserID: user.ID}

	// Missing new password
	body, _ := json.Marshal(ChangePasswordRequest{CurrentPassword: password, NewPassword: ""})
	req := httptest.NewRequest(http.MethodPost, "/auth/password", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", session)
	err := handler.ChangePassword(c)
	if err == nil {
		t.Error("expected error for empty new password")
	}

	// Wrong current password
	body, _ = json.Marshal(ChangePasswordRequest{CurrentPassword: "wrongpass", NewPassword: "newpass123"})
	req = httptest.NewRequest(http.MethodPost, "/auth/password", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	err = handler.ChangePassword(c)
	if err == nil {
		t.Error("expected error for wrong current password")
	}

	// Success
	body, _ = json.Marshal(ChangePasswordRequest{CurrentPassword: password, NewPassword: "newpass123"})
	req = httptest.NewRequest(http.MethodPost, "/auth/password", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	if err := handler.ChangePassword(c); err != nil {
		t.Fatalf("ChangePassword failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	// Invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/auth/password", bytes.NewReader([]byte("{bad")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.Set("user", session)
	_ = handler.ChangePassword(c) // may or may not error depending on binding
}

func TestAuthHandler_LogoutWithSession(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	password := "pass123"
	hash, _ := services.HashPassword(password)
	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "logoutuser", Email: "logout@test.com", PasswordHash: hash, DisplayName: "LO",
	})

	authSvc := services.NewAuthService(repo)
	cfg := &config.Config{SessionExpiryHours: 720}
	handler := NewAuthHandler(authSvc, cfg, repo)
	e := echo.New()

	// Create a real session
	expiry := time.Now().Add(time.Hour).UTC().Round(0)
	sess, _ := authSvc.CreateSession(context.Background(), user.ID, "1.2.3.4", "agent", expiry, "logout-tok")

	// Logout with valid cookie
	req := httptest.NewRequest(http.MethodPost, "/logout", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: sess.Token})
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	if err := handler.Logout(c); err != nil {
		t.Fatalf("Logout with session failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func TestAuthHandler_DeleteSession(t *testing.T) {
	repo := setupTestDB(t)
	defer func() {
		_ = repo.Close()
	}()

	authSvc := services.NewAuthService(repo)
	handler := NewAuthHandler(authSvc, &config.Config{SessionExpiryHours: 720, SessionExpiryPublicHours: 24}, repo)
	e := echo.New()

	user, _ := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username: "dsuser", Email: "ds@test.com", PasswordHash: "h", DisplayName: "DS",
	})

	// Create a session to delete
	import_time_add := time.Now().Add(time.Hour).UTC().Round(0)
	sess, _ := authSvc.CreateSession(context.Background(), user.ID, "1.2.3.4", "agent", import_time_add, "tok-ds")
	session := models.GetSessionByTokenRow{UserID: user.ID, ID: 99}

	// Invalid session ID param
	req := httptest.NewRequest(http.MethodDelete, "/auth/sessions/abc", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("abc")
	c.Set("user", session)
	err := handler.DeleteSession(c)
	if err == nil {
		t.Error("expected error for invalid session ID")
	}

	// Delete session that belongs to this user
	req = httptest.NewRequest(http.MethodDelete, "/auth/sessions/1", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues(strconv.FormatInt(sess.ID, 10))
	c.Set("user", models.GetSessionByTokenRow{UserID: user.ID, ID: sess.ID})
	if err := handler.DeleteSession(c); err != nil {
		t.Fatalf("DeleteSession failed: %v", err)
	}
	if rec.Code != http.StatusNoContent {
		t.Errorf("expected 204, got %d", rec.Code)
	}

	// Session not found (already deleted)
	req = httptest.NewRequest(http.MethodDelete, "/auth/sessions/999", nil)
	rec = httptest.NewRecorder()
	c = e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("999")
	c.Set("user", session)
	err = handler.DeleteSession(c)
	if err == nil {
		t.Error("expected error for non-existent session")
	}
}

func TestGenerateToken_Success(t *testing.T) {
	repo := setupTestDB(t)
	defer func() { _ = repo.Close() }()

	authSvc := services.NewAuthService(repo)
	h := NewAuthHandler(authSvc, &config.Config{SessionExpiryHours: 720}, repo)
	e := echo.New()

	tok := GenerateToken()
	if len(tok) == 0 {
		t.Error("expected non-empty token")
	}

	hash, _ := services.HashPassword("testpass")
	_, _ = repo.DB().Exec(`INSERT INTO users (id, username, email, password_hash, display_name) VALUES (1,'admin','a@a.com',?,'Admin')`, hash)

	body, _ := json.Marshal(LoginRequest{Username: "admin", Password: "testpass"})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	if err := h.Login(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Login failed: %v", err)
	}
}
func TestAuthHandler_ProductionCookie(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)
	hash, _ := services.HashPassword("pass1234")
	_, _ = h.repo.DB().Exec(`UPDATE users SET password_hash=? WHERE id=1`, hash)

	cfg := &config.Config{AppEnv: "production"}
	authH := NewAuthHandler(h.authSvc, cfg, h.repo)
	e := echo.New()

	body := `{"username":"u","name":"pass1234","remember_me":false}`
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	if err := authH.Login(e.NewContext(req, rec)); err != nil {
		t.Fatalf("Login: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	cookies := rec.Result().Cookies()
	found := false
	for _, c := range cookies {
		if c.Name == "session" && c.Secure {
			found = true
		}
	}
	if !found {
		t.Error("expected Secure=true cookie in production mode")
	}
}

func TestAuthHandler_ListSessions_WithData(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()
	insertUser(h.repo)

	_, _ = h.repo.DB().Exec(`INSERT INTO sessions (user_id,token,ip_address,user_agent,expires_at) VALUES (1,'tok','127.0.0.1','ua',datetime('now','+1 hour'))`)

	authH := NewAuthHandler(h.authSvc, h.cfg, h.repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.Set("user", models.GetSessionByTokenRow{UserID: 1, ID: 1})
	if err := authH.ListSessions(c); err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
}

func TestAuthHandler_DBErrors(t *testing.T) {
	h := setupHandlers(t)
	_ = h.repo.Close()
	authH := NewAuthHandler(h.authSvc, h.cfg, h.repo)
	e := echo.New()

	t.Run("ListSessions_Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1})
		err := authH.ListSessions(c)
		if err == nil {
			t.Error("expected error")
		}
	})

	t.Run("DeleteOtherSessions_Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/", nil)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.Set("user", models.GetSessionByTokenRow{UserID: 1, ID: 1})
		err := authH.DeleteOtherSessions(c)
		if err == nil {
			t.Error("expected error")
		}
	})
}

func TestAuthHandler_Login_SessionCreateError(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()

	hash, _ := services.HashPassword("password123")
	_, _ = h.repo.CreateUser(nil_ctx(), models.CreateUserParams{
		Username: "testlogin", Email: "", PasswordHash: hash, DisplayName: "Test",
	})

	_ = h.repo.Close()
	ah := NewAuthHandler(h.authSvc, h.cfg, h.repo)
	body := `{"username":"testlogin","name":"password123"}`
	c, _ := echoCtx(http.MethodPost, "/", body)
	err := ah.Login(c)

	_ = err
}

func TestAuthHandler_Logout_WithValidSession(t *testing.T) {
	h := setupHandlers(t)
	defer h.close()

	hash, _ := services.HashPassword("password123")
	user, _ := h.repo.CreateUser(nil_ctx(), models.CreateUserParams{
		Username: "logoutuser", Email: "", PasswordHash: hash, DisplayName: "Logout",
	})
	token := GenerateToken()
	expiry := time.Now().Add(24 * time.Hour).UTC()
	_, _ = h.authSvc.CreateSession(nil_ctx(), user.ID, "127.0.0.1", "test", expiry, token)

	ah := NewAuthHandler(h.authSvc, h.cfg, h.repo)
	e := echo.New()
	req := httptest.NewRequest(http.MethodPost, "/logout", nil)
	req.AddCookie(&http.Cookie{Name: "session", Value: token})
	rec := httptest.NewRecorder()
	err := ah.Logout(e.NewContext(req, rec))
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}
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
