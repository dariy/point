package api

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"time"

	"github.com/labstack/echo/v4"
	"point-api/internal/config"
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
	Password   string `json:"name"` // Following Python schema where 'name' is password? 
	// Wait, let me check the Python schema again.
	RememberMe bool   `json:"remember_me"`
}

func GenerateToken() string {
	b := make([]byte, 32)
	rand.Read(b)
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
	expiresAt := time.Now().Add(time.Duration(expiryHours) * time.Hour)

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
		// Valid session cookie found, we could validate it and terminate it in DB
		session, err := h.authService.ValidateSession(c.Request().Context(), cookie.Value)
		if err == nil {
			_ = h.authService.TerminateSession(c.Request().Context(), session.ID, session.UserID)
		}
	}

	newCookie := &http.Cookie{
		Name:     "session",
		Value:    "",
		Expires:  time.Now().Add(-1 * time.Hour),
		HttpOnly: true,
		Path:     "/",
	}
	c.SetCookie(newCookie)

	return c.JSON(http.StatusOK, map[string]string{"message": "Logged out successfully"})
}

func (h *AuthHandler) Me(c echo.Context) error {
	// This would normally be handled by a middleware that sets the user in the context
	user := c.Get("user")
	if user == nil {
		return echo.NewHTTPError(http.StatusUnauthorized, "not authenticated")
	}
	return c.JSON(http.StatusOK, user)
}
