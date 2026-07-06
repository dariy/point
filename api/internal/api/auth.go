package api

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/go-pkgz/auth/v2/token"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v4"
)

type AuthHandler struct {
	authService *services.AuthService
	cfg         *config.Config
	repo        repository.Repository
}

func NewAuthHandler(authService *services.AuthService, cfg *config.Config, repo repository.Repository) *AuthHandler {
	return &AuthHandler{
		authService: authService,
		cfg:         cfg,
		repo:        repo,
	}
}

type LoginRequest struct {
	Username   string `json:"username"`
	Password   string `json:"name"`
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
	h.setRemark42Cookies(c, user, expiresAt)

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
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cfg.AppEnv == "production",
	}
	c.SetCookie(newCookie)
	h.clearRemark42Cookies(c)

	return c.JSON(http.StatusOK, map[string]string{"message": "Logged out successfully"})
}

func (h *AuthHandler) Me(c echo.Context) error {
	user := c.Get("user")
	userID := extractUserID(user)
	if userID == 0 {
		return echo.NewHTTPError(http.StatusUnauthorized, "not authenticated")
	}

	var username, displayName string
	if s, ok := user.(models.GetSessionByTokenRow); ok {
		username = s.Username
		displayName = s.DisplayName
	} else if k, ok := user.(models.GetAPIKeyByHashRow); ok {
		username = k.Username
		displayName = k.DisplayName
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"id":           userID,
		"username":     username,
		"display_name": displayName,
	})
}

type ChangePasswordRequest struct {
	CurrentPassword string `json:"current_name"`
	NewPassword     string `json:"new_name"`
}

func (h *AuthHandler) ChangePassword(c echo.Context) error {
	userID := extractUserID(c.Get("user"))
	sessionID := extractSessionID(c.Get("user"))

	var req ChangePasswordRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if req.NewPassword == "" {
		return echo.NewHTTPError(http.StatusBadRequest, "new password is required")
	}

	if err := h.authService.ChangePassword(c.Request().Context(), userID, sessionID, req.CurrentPassword, req.NewPassword); err != nil {
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
		UABrowser    string    `json:"ua_browser"`
		UAOS         string    `json:"ua_os"`
		CreatedAt    time.Time `json:"created_at"`
		LastActivity time.Time `json:"last_active_at"`
		ExpiresAt    time.Time `json:"expires_at"`
		IsCurrent    bool      `json:"is_current"`
	}

	result := make([]sessionItem, len(sessions))
	for i, s := range sessions {
		browser, os := parseUserAgent(s.UserAgent)
		result[i] = sessionItem{
			ID:           s.ID,
			IPAddress:    s.IpAddress,
			UserAgent:    s.UserAgent,
			UABrowser:    browser,
			UAOS:         os,
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

func (h *AuthHandler) ForgotPassword(c echo.Context) error {
	var req struct {
		Email string `json:"email"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid request"})
	}

	// Always return the same message to prevent email enumeration.
	const okMsg = "If an account with that email exists, you will receive a password reset link shortly."

	if strings.TrimSpace(req.Email) == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "email is required"})
	}

	if h.cfg.SMTPHost == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Password reset is not configured. Set SMTP_HOST in your .env file.",
		})
	}
	if strings.TrimSpace(h.cfg.AppURL) == "" {
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Password reset is not configured. Set APP_URL in your .env file.",
		})
	}

	ctx := c.Request().Context()
	user, err := h.repo.GetUserByEmail(ctx, strings.TrimSpace(req.Email))
	if err != nil {
		// No account — return the same OK message to prevent enumeration.
		return c.JSON(http.StatusOK, map[string]string{"detail": okMsg})
	}

	token, err := h.authService.CreatePasswordResetToken(ctx, user.ID)
	if err != nil {
		slog.Error("forgot-password: create token failed", "error", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "could not generate reset token"})
	}

	appURL := strings.TrimRight(strings.TrimSpace(h.cfg.AppURL), "/")

	resetLink := fmt.Sprintf("%s/light/pss/%s", appURL, token)
	body := fmt.Sprintf(
		"You requested a password reset for your blog.\n\n"+
			"Click the link below to set a new password (valid for 1 hour):\n\n"+
			"%s\n\n"+
			"If you did not request this, ignore this email — your password has not changed.\n",
		resetLink,
	)

	from := h.cfg.SMTPFrom
	if from == "" {
		from = h.cfg.SMTPUsername
	}
	smtpCfg := services.SMTPConfig{
		Host:     h.cfg.SMTPHost,
		Port:     h.cfg.SMTPPort,
		Username: h.cfg.SMTPUsername,
		Password: h.cfg.SMTPPassword,
		From:     from,
	}

	if err := services.SendEmail(smtpCfg, user.Email, "Password Reset Request", body); err != nil {
		slog.Error("forgot-password: send email failed", "error", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to send reset email"})
	}

	return c.JSON(http.StatusOK, map[string]string{"detail": okMsg})
}

func (h *AuthHandler) ResetPassword(c echo.Context) error {
	var req struct {
		Token    string `json:"token"`
		Password string `json:"name"`
	}
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid request"})
	}

	if req.Token == "" || req.Password == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "token and password are required"})
	}

	// Password arrives pre-hashed (SHA-256 hex, 64 chars) just like login/change-password.
	if len(req.Password) != 64 {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid password format"})
	}

	ctx := c.Request().Context()
	if err := h.authService.ResetPassword(ctx, req.Token, req.Password); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": err.Error()})
	}

	return c.JSON(http.StatusOK, map[string]string{"detail": "Password reset successfully. You can now log in."})
}

func (h *AuthHandler) setRemark42Cookies(c echo.Context, user models.User, expiresAt time.Time) {
	secret := os.Getenv("REMARK_SECRET")
	if secret == "" {
		return
	}
	svc := token.NewService(token.Opts{
		SecretReader: token.SecretFunc(func(id string) (string, error) {
			return secret, nil
		}),
		CookieDuration: time.Until(expiresAt),
		Issuer:         "remark42",
	})

	name := user.DisplayName
	if name == "" {
		name = user.Username
	}

	var authorName string
	err := h.repo.DB().QueryRowContext(c.Request().Context(), "SELECT value FROM blog_settings WHERE key = 'author_name'").Scan(&authorName)
	if err == nil && authorName != "" {
		name = authorName
	}

	var logoURL string
	_ = h.repo.DB().QueryRowContext(c.Request().Context(), "SELECT value FROM blog_settings WHERE key = 'logo_url'").Scan(&logoURL)

	u := &token.User{
		ID:      fmt.Sprintf("point_%d", user.ID),
		Name:    name,
		Picture: logoURL,
	}
	u.SetAdmin(true)

	xsrf := GenerateToken()[:20]

	claims := token.Claims{
		User: u,
	}
	claims.Audience = jwt.ClaimStrings{"remark"}
	claims.Issuer = "remark42"
	claims.ExpiresAt = jwt.NewNumericDate(expiresAt)
	claims.ID = xsrf

	tokenStr, err := svc.Token(claims)
	if err != nil {
		slog.Error("Failed to generate remark42 token", "err", err)
		return
	}

	c.SetCookie(&http.Cookie{
		Name:     "JWT",
		Value:    tokenStr,
		Expires:  expiresAt,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cfg.AppEnv == "production",
	})
	c.SetCookie(&http.Cookie{
		Name:     "XSRF-TOKEN",
		Value:    xsrf,
		Expires:  expiresAt,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cfg.AppEnv == "production",
	})
}

func (h *AuthHandler) clearRemark42Cookies(c echo.Context) {
	past := time.Now().Add(-1 * time.Hour).UTC().Round(0)
	c.SetCookie(&http.Cookie{
		Name:     "JWT",
		Value:    "",
		Expires:  past,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cfg.AppEnv == "production",
	})
	c.SetCookie(&http.Cookie{
		Name:     "XSRF-TOKEN",
		Value:    "",
		Expires:  past,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   h.cfg.AppEnv == "production",
	})
}
