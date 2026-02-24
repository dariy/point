package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

func TestAuthHandler_Login(t *testing.T) {
	repo := setupTestDB(t)
	defer repo.Close()

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
	handler := NewAuthHandler(authService, cfg)

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
	defer repo.Close()

	authService := services.NewAuthService(repo)
	handler := NewAuthHandler(authService, &config.Config{})

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
	defer repo.Close()
	authService := services.NewAuthService(repo)
	handler := NewAuthHandler(authService, nil)
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
	handler.Logout(c)

	// Test Login with invalid JSON
	req = httptest.NewRequest(http.MethodPost, "/login", bytes.NewReader([]byte("{bad}")))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec = httptest.NewRecorder()
	handler.Login(e.NewContext(req, rec))
}

