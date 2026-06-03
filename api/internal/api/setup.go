package api

import (
	"database/sql"
	"errors"
	"log"
	"net/http"
	"strings"

	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type SetupHandler struct {
	authService     *services.AuthService
	settingsService *services.SettingsService
	repo            repository.Repository
}

func NewSetupHandler(authService *services.AuthService, settingsService *services.SettingsService, repo repository.Repository) *SetupHandler {
	return &SetupHandler{
		authService:     authService,
		settingsService: settingsService,
		repo:            repo,
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
		log.Printf("setup: GetFirstUser error: %v", err)
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "database error"})
	}

	hash, err := services.HashPassword(req.Password)
	if err != nil {
		return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to hash password"})
	}

	_, err = h.repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "the_owner",
		Email:        req.Email,
		PasswordHash: hash,
		DisplayName:  req.AuthorName,
	})
	if err != nil {
		log.Printf("setup: CreateUser error: %v", err)
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
		{"use_thumbnails", "true", "boolean"},
		{"show_view_counts", "false", "boolean"},
		{"show_tag_cloud", "true", "boolean"},
		{"map_mode", "off", "string"},
		{"enable_backup", "false", "boolean"},
	}

	for _, s := range seedSettings {
		if err := h.settingsService.SetSetting(ctx, s.key, s.value, s.vType); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to seed settings"})
		}
	}

	return c.JSON(http.StatusOK, map[string]string{"detail": "setup complete"})
}
