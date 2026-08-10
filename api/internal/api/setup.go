package api

import (
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/plugins"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type SetupHandler struct {
	authService     *services.AuthService
	settingsService *services.SettingsService
	repo            repository.Repository
	cfg             *config.Config
}

func NewSetupHandler(authService *services.AuthService, settingsService *services.SettingsService, repo repository.Repository, cfg *config.Config) *SetupHandler {
	return &SetupHandler{
		authService:     authService,
		settingsService: settingsService,
		repo:            repo,
		cfg:             cfg,
	}
}

func (h *SetupHandler) SetupStatus(c echo.Context) error {
	_, err := h.repo.GetFirstUser(c.Request().Context())
	if err == nil {
		return c.JSON(http.StatusOK, map[string]bool{"setup_complete": true})
	}
	return c.JSON(http.StatusOK, map[string]bool{"setup_complete": false})
}

func (h *SetupHandler) Setup(c echo.Context) error {
	var req struct {
		Password   string `json:"name"`
		BlogTitle  string `json:"blog_title"`
		AuthorName string `json:"author_name"`
		Email      string `json:"email"`
	}

	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid request body"})
	}

	req.Email = strings.TrimSpace(req.Email)

	if req.Password == "" || req.BlogTitle == "" || req.AuthorName == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "all fields are required"})
	}

	// req.Password is a SHA-256 hex string sent by the frontend (always 64 chars)
	if len(req.Password) != 64 {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid password format"})
	}

	ctx := c.Request().Context()
	_, err := h.repo.GetFirstUser(ctx)
	if err == nil {
		return c.JSON(http.StatusConflict, map[string]string{"detail": "setup already complete"})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		slog.Error("setup: GetFirstUser failed", "error", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "database error"})
	}

	hash, err := services.HashPassword(req.Password)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to hash password"})
	}

	user, err := h.repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "the_owner",
		Email:        req.Email,
		PasswordHash: hash,
		DisplayName:  req.AuthorName,
	})
	if err != nil {
		slog.Error("setup: CreateUser failed", "error", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to create user"})
	}

	seedSettings := []struct {
		key   string
		value string
		vType string
	}{
		{"blog_title", req.BlogTitle, "string"},
		{"author_name", req.AuthorName, "string"},
		{"posts_per_page", "10", "integer"},
		{"default_theme", "dark", "string"},
		{"active_css_theme", "default", "string"},
		{"show_view_counts", "false", "boolean"},

		{"tags_visibility", "hidden", "string"},
		{"atlas_post_limit", "10", "integer"},
		{"enable_backup", "false", "boolean"},

		// Header nav: tags mode with the first 4 root tags inline, so the
		// header is useful before the menu editor is ever opened.
		{"nav_menu_mode", "tags", "string"},
		{"nav_inline_max", "4", "string"},
		{"nav_more_title", "More", "string"},
	}

	// Seed per-plugin enabled state (plugin.<id>.enabled). Existing installs lack
	// these keys and fall back to each descriptor's DefaultEnabled at read time,
	// so seeding only fixes the value for fresh installs.
	for _, d := range plugins.Registry {
		seedSettings = append(seedSettings, struct {
			key   string
			value string
			vType string
		}{plugins.EnabledKey(d.ID), plugins.SeedValue(d), "boolean"})
	}

	for _, s := range seedSettings {
		if err := h.settingsService.SetSetting(ctx, s.key, s.value, s.vType); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to seed settings"})
		}
	}

	// Log the owner straight in. They just chose this password one field ago;
	// bouncing them to the login screen to retype it is pure ceremony. Failing
	// to mint the session is not fatal — the install is set up either way, so
	// fall back to the login screen rather than undoing the whole wizard.
	session := h.startOwnerSession(c, user)

	return c.JSON(http.StatusOK, map[string]any{
		"detail":        "setup complete",
		"authenticated": session,
		"user": map[string]any{
			"id":           user.ID,
			"username":     user.Username,
			"display_name": user.DisplayName,
			"email":        user.Email,
		},
	})
}

// startOwnerSession issues a session cookie for the freshly created owner,
// exactly as a password login would (same expiry, same cookie flags, same
// remark42 bridge). Reports whether the session was established.
func (h *SetupHandler) startOwnerSession(c echo.Context, user models.User) bool {
	if h.cfg == nil {
		return false
	}

	// Same lifetime a login without "remember me" gets. A zero here would mint
	// an already-expired cookie, so fall back to the config default (24h) when
	// the value is unset.
	expiryHours := h.cfg.SessionExpiryPublicHours
	if expiryHours <= 0 {
		expiryHours = 24
	}

	token := GenerateToken()
	expiresAt := time.Now().Add(time.Duration(expiryHours) * time.Hour).UTC().Round(0)

	if _, err := h.authService.CreateSession(
		c.Request().Context(),
		user.ID,
		c.RealIP(),
		c.Request().UserAgent(),
		expiresAt,
		token,
	); err != nil {
		slog.Error("setup: CreateSession failed, owner must log in manually", "error", err)
		return false
	}

	secure := secureCookieFor(h.cfg, c)
	c.SetCookie(&http.Cookie{
		Name:     "session",
		Value:    token,
		Expires:  expiresAt,
		HttpOnly: true,
		Path:     "/",
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	IssueRemark42Cookies(c, h.repo, user.ID, user.DisplayName, user.Username, expiresAt, secure)

	return true
}
