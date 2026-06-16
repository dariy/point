package api

import (
	"encoding/json"
	"net/http"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

type NavMenuHandler struct {
	settingsService *services.SettingsService
}

func NewNavMenuHandler(settingsService *services.SettingsService) *NavMenuHandler {
	return &NavMenuHandler{settingsService: settingsService}
}

// GetAdminNavMenu returns the current nav menu configuration for the admin editor.
// GET /api/nav-menu
func (h *NavMenuHandler) GetAdminNavMenu(c echo.Context) error {
	ctx := c.Request().Context()
	all, _ := h.settingsService.GetAllSettings(ctx)

	mode := all["nav_menu_mode"]
	if mode == "" {
		mode = "tags"
	}

	var items []services.NavTagNode
	if raw := all["custom_nav_menu"]; raw != "" {
		_ = json.Unmarshal([]byte(raw), &items)
	}
	if items == nil {
		items = []services.NavTagNode{}
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"mode":            mode,
		"items":           items,
		"custom_markdown": all["custom_markdown"],
	})
}

// UpdateAdminNavMenu saves the nav menu mode and custom items.
// PUT /api/nav-menu
func (h *NavMenuHandler) UpdateAdminNavMenu(c echo.Context) error {
	ctx := c.Request().Context()

	var body struct {
		Mode           string                `json:"mode"`
		Items          []services.NavTagNode `json:"items"`
		CustomMarkdown string                `json:"custom_markdown"`
	}
	if err := c.Bind(&body); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if body.Mode != "tags" && body.Mode != "custom" {
		body.Mode = "tags"
	}

	if err := h.settingsService.SetSetting(ctx, "nav_menu_mode", body.Mode, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if body.Items == nil {
		body.Items = []services.NavTagNode{}
	}
	data, err := json.Marshal(body.Items)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, "failed to encode menu")
	}
	if err := h.settingsService.SetSetting(ctx, "custom_nav_menu", string(data), "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	if err := h.settingsService.SetSetting(ctx, "custom_markdown", body.CustomMarkdown, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, map[string]interface{}{
		"mode":            body.Mode,
		"items":           body.Items,
		"custom_markdown": body.CustomMarkdown,
	})
}
