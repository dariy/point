package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/services"
)

type AuthHandler struct {
	authService *services.AuthService
	cfg         *config.Config
}

func NewAuthHandler(authService *services.AuthService, cfg *config.Config) *AuthHandler {
	return &AuthHandler{
		authService: authService,
		cfg:         cfg,
	}
}

type LoginRequest struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	RememberMe bool   `json:"remember_me"`
}

func GenerateToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func (h *AuthHandler) Login(c echo.Context) error {
	var req LoginRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	user, err := h.authService.Authenticate(c.Request().Context(), req.Username, req.Password)
	if err != nil {
		return echo.NewHTTPError(http.StatusUnauthorized, err.Error())
	}

	token := GenerateToken()

	expiryHours := h.cfg.SessionExpiryPublicHours
	if req.RememberMe {
		expiryHours = h.cfg.SessionExpiryHours
	}
	expiresAt := time.Now().Add(time.Duration(expiryHours) * time.Hour).UTC().Round(0)

	_, err = h.authService.CreateSession(
		c.Request().Context(),
		user.ID,
		c.RealIP(),
		c.Request().UserAgent(),
		expiresAt,
		token,
	)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to create session")
	}

	cookie := &http.Cookie{
		Name:     "session",
		Value:    token,
		Expires:  expiresAt,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
	}

	if h.cfg.AppEnv == "production" {
		cookie.Secure = true
	}

	c.SetCookie(cookie)

	return c.JSON(http.StatusOK, map[string]interface{}{
		"message": "Login successful",
		"user": map[string]interface{}{
			"id":           user.ID,
			"username":     user.Username,
			"display_name": user.DisplayName,
			"email":        user.Email,
		},
	})
}

func (h *AuthHandler) Logout(c echo.Context) error {
	cookie, err := c.Cookie("session")
	if err == nil {
		session, err := h.authService.ValidateSession(c.Request().Context(), cookie.Value)
		if err == nil {
			_ = h.authService.TerminateSession(c.Request().Context(), session.ID, session.UserID)
		}
	}

	newCookie := &http.Cookie{
		Name:     "session",
		Value:    "",
		Expires:  time.Now().Add(-1 * time.Hour).UTC().Round(0),
		HttpOnly: true,
		Path:     "/",
	}
	c.SetCookie(newCookie)

	return c.JSON(http.StatusOK, map[string]string{"message": "Logged out successfully"})
}

func (h *AuthHandler) Me(c echo.Context) error {
	session, ok := c.Get("user").(models.GetSessionByTokenRow)
	if !ok || session.UserID == 0 {
		return echo.NewHTTPError(http.StatusUnauthorized, "not authenticated")
	}
	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":           session.UserID,
		"username":     session.Username,
		"display_name": session.DisplayName,
	})
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_name"`
	NewPassword     string `json:"new_name"`
}

func (h *AuthHandler) ChangePassword(c echo.Context) error {
	userID := extractUserID(c.Get("user"))

	var req ChangePasswordRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if req.NewPassword == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "new password is required")
	}

	if err := h.authService.ChangePassword(c.Request().Context(), userID, req.CurrentPassword, req.NewPassword); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]string{"message": "Password changed successfully"})
}

func (h *AuthHandler) ListSessions(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	currentSessionID := extractSessionID(c.Get("user"))

	sessions, err := h.authService.ListSessions(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	type sessionItem struct {
		ID           int64     `json:"id"`
		IPAddress    string    `json:"ip_address"`
		UserAgent    string    `json:"user_agent"`
		CreatedAt    time.Time `json:"created_at"`
		LastActivity time.Time `json:"last_active_at"`
		ExpiresAt    time.Time `json:"expires_at"`
		IsCurrent    bool      `json:"is_current"`
	}

	result := make([]sessionItem, len(sessions))
	for i, s := range sessions {
		result[i] = sessionItem{
			ID:           s.ID,
			IPAddress:    s.IpAddress,
			UserAgent:    s.UserAgent,
			CreatedAt:    s.CreatedAt,
			LastActivity: s.LastActivity,
			ExpiresAt:    s.ExpiresAt,
			IsCurrent:    s.ID == currentSessionID,
		}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"sessions": result,
		"total":    len(result),
	})
}

func (h *AuthHandler) DeleteSession(c echo.Context) error {
	sessionID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid session id")
	}

	userID := extractUserID(c.Get("user"))

	if err := h.authService.TerminateSession(c.Request().Context(), sessionID, userID); err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "session not found")
	}

	return c.NoContent(http.StatusNoContent)
}

func (h *AuthHandler) DeleteOtherSessions(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	currentSessionID := extractSessionID(c.Get("user"))

	if err := h.authService.TerminateOtherSessions(c.Request().Context(), userID, currentSessionID); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]string{"message": "Other sessions terminated"})
}
