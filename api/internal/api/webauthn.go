package api

import (
	"log/slog"
	"net/http"
	"time"

	"point-api/internal/config"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

const webauthnSessionCookie = "webauthn_session"

type WebAuthnHandler struct {
	webauthn *services.WebAuthnService
	auth     *services.AuthService
	cfg      *config.Config
}

func NewWebAuthnHandler(webauthn *services.WebAuthnService, auth *services.AuthService, cfg *config.Config) *WebAuthnHandler {
	return &WebAuthnHandler{
		webauthn: webauthn,
		auth:     auth,
		cfg:      cfg,
	}
}

// BeginRegistration starts the WebAuthn registration ceremony.
// POST /api/auth/webauthn/register/begin
func (h *WebAuthnHandler) BeginRegistration(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusServiceUnavailable, echo.Map{"message": "WebAuthn is not configured"})
	}

	userID := extractUserID(c.Get("user"))

	options, sessionKey, err := h.webauthn.BeginRegistration(c.Request().Context(), userID)
	if err != nil {
		slog.Error("BeginRegistration failed", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not begin registration")
	}

	cookie := new(http.Cookie)
	cookie.Name = webauthnSessionCookie
	cookie.Value = sessionKey
	cookie.HttpOnly = true
	cookie.Secure = h.cfg.AppEnv == "production"
	cookie.SameSite = http.SameSiteStrictMode
	cookie.Path = "/api/auth/webauthn"
	cookie.Expires = time.Now().Add(5 * time.Minute)
	c.SetCookie(cookie)

	return c.JSON(http.StatusOK, options)
}

// FinishRegistration completes the WebAuthn registration ceremony.
// POST /api/auth/webauthn/register/finish
func (h *WebAuthnHandler) FinishRegistration(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusServiceUnavailable, echo.Map{"message": "WebAuthn is not configured"})
	}

	cookie, err := c.Cookie(webauthnSessionCookie)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Missing registration session")
	}
	cookie.MaxAge = -1
	c.SetCookie(cookie)

	userID := extractUserID(c.Get("user"))
	if err := h.webauthn.FinishRegistration(c.Request().Context(), userID, cookie.Value, c.Request()); err != nil {
		slog.Error("FinishRegistration failed", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not finish registration")
	}

	return c.NoContent(http.StatusOK)
}

// BeginLogin starts the discoverable WebAuthn login ceremony.
// POST /api/auth/webauthn/login/begin
func (h *WebAuthnHandler) BeginLogin(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusServiceUnavailable, echo.Map{"message": "WebAuthn is not configured"})
	}

	options, sessionKey, err := h.webauthn.BeginLoginWithoutUser(c.Request().Context())
	if err != nil {
		slog.Error("BeginLogin failed", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not begin login")
	}

	cookie := new(http.Cookie)
	cookie.Name = webauthnSessionCookie
	cookie.Value = sessionKey
	cookie.HttpOnly = true
	cookie.Secure = h.cfg.AppEnv == "production"
	cookie.SameSite = http.SameSiteLaxMode
	cookie.Path = "/api/auth/webauthn"
	cookie.Expires = time.Now().Add(5 * time.Minute)
	c.SetCookie(cookie)

	return c.JSON(http.StatusOK, options)
}

// FinishLogin completes the WebAuthn login ceremony and creates a session.
// POST /api/auth/webauthn/login/finish
func (h *WebAuthnHandler) FinishLogin(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusServiceUnavailable, echo.Map{"message": "WebAuthn is not configured"})
	}

	cookie, err := c.Cookie(webauthnSessionCookie)
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "Missing login session")
	}
	cookie.MaxAge = -1
	c.SetCookie(cookie)

	userID, err := h.webauthn.FinishLogin(c.Request().Context(), cookie.Value, c.Request())
	if err != nil {
		slog.Error("FinishLogin failed", "error", err)
		return echo.NewHTTPError(http.StatusUnauthorized, "Login failed")
	}

	// Create a standard session — same flow as password login.
	token := GenerateToken()
	expiresAt := time.Now().Add(time.Duration(h.cfg.SessionExpiryHours) * time.Hour).UTC().Round(0)

	_, err = h.auth.CreateSession(c.Request().Context(), userID, c.RealIP(), c.Request().UserAgent(), expiresAt, token)
	if err != nil {
		slog.Error("Failed to create session after webauthn login", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not create session")
	}

	sessionCookie := &http.Cookie{
		Name:     "session",
		Value:    token,
		Expires:  expiresAt,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
	}
	if h.cfg.AppEnv == "production" {
		sessionCookie.Secure = true
	}
	c.SetCookie(sessionCookie)

	user, err := h.auth.GetUserByID(c.Request().Context(), userID)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not retrieve user data")
	}

	return c.JSON(http.StatusOK, echo.Map{
		"message": "Login successful",
		"user": echo.Map{
			"id":           user.ID,
			"username":     user.Username,
			"display_name": user.DisplayName,
			"email":        user.Email,
		},
	})
}

// DeleteCredential removes the user's WebAuthn credential.
// DELETE /api/auth/webauthn/credential
func (h *WebAuthnHandler) DeleteCredential(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusServiceUnavailable, echo.Map{"message": "WebAuthn is not configured"})
	}

	userID := extractUserID(c.Get("user"))
	if err := h.webauthn.DeleteCredential(c.Request().Context(), userID); err != nil {
		slog.Error("DeleteCredential failed", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not delete credential")
	}

	return c.NoContent(http.StatusNoContent)
}

// GetStatus checks if the current user has a WebAuthn credential registered.
// GET /api/auth/webauthn/status
func (h *WebAuthnHandler) GetStatus(c echo.Context) error {
	if h.webauthn == nil {
		return c.JSON(http.StatusOK, echo.Map{"has_passkey": false, "configured": false})
	}

	userID := extractUserID(c.Get("user"))
	hasCredential, err := h.webauthn.HasCredential(c.Request().Context(), userID)
	if err != nil {
		slog.Error("GetStatus failed", "error", err)
		return echo.NewHTTPError(http.StatusInternalServerError, "Could not check credential status")
	}

	return c.JSON(http.StatusOK, echo.Map{"has_passkey": hasCredential, "configured": true})
}
