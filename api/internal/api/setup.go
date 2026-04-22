package api

import (
	"database/sql"
	"errors"
	"log"
	"net/http"

	"github.com/labstack/echo/v4"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
)

type SetupHandler struct {
	authService     *services.AuthService
	settingsService *services.SettingsService
	repo            *repository.Repository
}

func NewSetupHandler(authService *services.AuthService, settingsService *services.SettingsService, repo *repository.Repository) *SetupHandler {
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
		Username   string `json:"username"`
		Password   string `json:"name"`
		BlogTitle  string `json:"blog_title"`
		AuthorName string `json:"author_name"`
	}

	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "invalid request body"})
	}

	if req.Username == "" || req.Password == "" || req.BlogTitle == "" || req.AuthorName == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "all fields are required"})
	}

	if len(req.Password) < 8 {
		return c.JSON(http.StatusBadRequest, map[string]string{"detail": "password must be at least 8 characters"})
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
		Username:     req.Username,
		Email:        "",
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
		{"use_thumbnails", "true", "boolean"},
		{"show_view_counts", "false", "boolean"},
		{"show_tag_cloud", "true", "boolean"},
		{"enable_map", "false", "boolean"},
		{"enable_backup", "false", "boolean"},
	}

	for _, s := range seedSettings {
		if err := h.settingsService.SetSetting(ctx, s.key, s.value, s.vType); err != nil {
			return c.JSON(http.StatusInternalServerError, map[string]string{"detail": "failed to seed settings"})
		}
	}

	return c.JSON(http.StatusOK, map[string]string{"detail": "setup complete"})
}
