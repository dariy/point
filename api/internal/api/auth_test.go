package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
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

