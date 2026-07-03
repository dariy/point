package api

import (
	"context"
	"net/http"
	"strconv"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type SettingsHandler struct {
	settingsService *services.SettingsService
}

func NewSettingsHandler(settingsService *services.SettingsService) *SettingsHandler {
	return &SettingsHandler{settingsService: settingsService}
}

// publicSettingKeys are settings safe to expose to unauthenticated users.
var publicSettingKeys = map[string]bool{
	"blog_title":              true,
	"blog_subtitle":           true,
	"logo_url":                true,
	"author_name":             true,
	"posts_per_page":          true,
	"default_language":        true,
	"default_theme":           true,
	"active_css_theme":        true,
	"show_view_counts":        true,
	"google_analytics_id":     true,
	"use_thumbnails":          true,
	"about_post_id":           true,
	"home_page_post_id":       true,
	"multi_user_mode":         true,

	"tags_visibility":         true,
	"timeline_mode":           true,
	"enable_backup":           true,
	"immersive_nav_direction": true,
	"exif_visibility":         true,
	"nav_menu_mode":           true,
	"footer_copyright":        true,
}

// writableSecretKeys are secrets the admin may set through the API.
// Values are routed to blog_secrets and never returned in responses.
var writableSecretKeys = map[string]bool{
	"gemini_api_key":             true,
	"instagram_app_id":           true,
	"instagram_app_secret":       true,
	"instagram_access_token":     true,
	"instagram_user_id":          true,
	"instagram_token_expires_at": true,
}

// secretIsSetKeys are secret keys whose presence (but never value) is surfaced to
// the admin UI as "<key>_is_set" booleans on the settings response.
var secretIsSetKeys = []string{
	"gemini_api_key",
	"photo_library_path",
	"instagram_app_id",
	"instagram_app_secret",
	"instagram_access_token",
	"instagram_user_id",
	"instagram_token_expires_at",
}

// addSecretIsSetFlags annotates the settings map with "<key>_is_set" booleans
// reflecting whether each secret has a stored value, without exposing the value.
func (h *SettingsHandler) addSecretIsSetFlags(ctx context.Context, settings map[string]string) {
	for _, key := range secretIsSetKeys {
		settings[key+"_is_set"] = strconv.FormatBool(h.settingsService.SecretIsSet(ctx, key))
	}
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
	ctx := c.Request().Context()
	all, err := h.settingsService.GetAllSettings(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	h.addSecretIsSetFlags(ctx, all)
	return c.JSON(http.StatusOK, all)
}

func (h *SettingsHandler) GetSettingByKey(c echo.Context) error {
	ctx := c.Request().Context()
	key := c.Param("key")
	value, err := h.settingsService.GetSetting(ctx, key, "")
	if err != nil {
		return echo.NewHTTPError(http.StatusNotFound, "setting not found")
	}
	return c.JSON(http.StatusOK, map[string]string{"key": key, "value": value})
}

func (h *SettingsHandler) UpdateSettings(c echo.Context) error {
	ctx := c.Request().Context()
	var updates map[string]string
	if err := c.Bind(&updates); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	for key, value := range updates {
		if writableSecretKeys[key] {
			if err := h.settingsService.SetSecret(ctx, key, value); err != nil {
				return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
			}
			continue
		}
		if err := h.settingsService.SetSetting(ctx, key, value, "string"); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}

	all, err := h.settingsService.GetAllSettings(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	h.addSecretIsSetFlags(ctx, all)
	return c.JSON(http.StatusOK, all)
}
