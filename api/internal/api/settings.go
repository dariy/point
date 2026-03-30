package api

import (
	"net/http"

	"github.com/labstack/echo/v4"
	"point-api/internal/services"
)

type SettingsHandler struct {
	settingsService *services.SettingsService
}

func NewSettingsHandler(settingsService *services.SettingsService) *SettingsHandler {
	return &SettingsHandler{settingsService: settingsService}
}

// Public settings keys that are safe to expose without authentication.
var publicSettingKeys = map[string]bool{
	"blog_title":          true,
	"blog_subtitle":       true,
	"author_name":         true,
	"posts_per_page":      true,
	"default_language":    true,
	"default_theme":       true,
	"show_view_counts":    true,
	"enable_analytics":    true,
	"google_analytics_id": true,
	"use_thumbnails":      true,
	"about_post_id":       true,
	"multi_user_mode":     true,
	"show_tag_cloud":          true,
	"enable_map":              true,
	"enable_backup":           true,
	"immersive_nav_direction": true,
	"exif_visibility":         true,
}

func (h *SettingsHandler) GetPublicSettings(c echo.Context) error {
	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	public := make(map[string]string)
	for k, v := range all {
		if publicSettingKeys[k] {
			public[k] = v
		}
	}

	return c.JSON(http.StatusOK, public)
}

func (h *SettingsHandler) GetSettings(c echo.Context) error {
	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, all)
}

func (h *SettingsHandler) GetSettingByKey(c echo.Context) error {
	key := c.Param("key")
	value, err := h.settingsService.GetSetting(c.Request().Context(), key, "")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "setting not found")
	}
	return c.JSON(http.StatusOK, map[string]string{"key": key, "value": value})
}

func (h *SettingsHandler) UpdateSettings(c echo.Context) error {
	var updates map[string]string
	if err := c.Bind(&updates); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	for key, value := range updates {
		if err := h.settingsService.SetSetting(c.Request().Context(), key, value, "string"); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}

	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, all)
}
