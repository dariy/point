package api

import (
	"net/http"
	"strconv"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// PluginsHandler serves the admin Plugins page API: listing the full plugin
// catalog with each plugin's enabled state and toggling that state.
//
// Unlike the client-facing manifest (which is enabled-only — see the hard
// constraint in internal/plugins), these endpoints are admin-only and therefore
// MAY reveal disabled plugins. They are the single place the existence of a
// disabled plugin is exposed, and they sit behind AuthMiddleware accordingly.
type PluginsHandler struct {
	settingsService *services.SettingsService
}

func NewPluginsHandler(settingsService *services.SettingsService) *PluginsHandler {
	return &PluginsHandler{settingsService: settingsService}
}

// pluginView is one plugin as presented to the admin Plugins page. It carries
// the static descriptor metadata plus the resolved enabled state. The frontend
// owns any mapping from a plugin to an existing settings page, so no admin route
// is encoded here.
type pluginView struct {
	ID             string       `json:"id"`
	Type           plugins.Type `json:"type"`
	Slot           string       `json:"slot,omitempty"`
	Routes         []string     `json:"routes,omitempty"`
	Enabled        bool         `json:"enabled"`
	DefaultEnabled bool         `json:"default_enabled"`
}

// togglePluginRequest is the body for enabling/disabling a plugin.
type togglePluginRequest struct {
	Enabled bool `json:"enabled"`
}

// ListPlugins returns the full plugin catalog (enabled and disabled) with each
// plugin's resolved enabled state, in registry order.
func (h *PluginsHandler) ListPlugins(c echo.Context) error {
	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	out := make([]pluginView, 0, len(plugins.Registry))
	for _, d := range plugins.Registry {
		out = append(out, pluginView{
			ID:             d.ID,
			Type:           d.Type,
			Slot:           d.Slot,
			Routes:         d.Routes,
			Enabled:        plugins.IsEnabled(d.ID, all),
			DefaultEnabled: d.DefaultEnabled,
		})
	}
	return c.JSON(http.StatusOK, out)
}

// TogglePlugin sets the enabled state for the plugin identified by :id. Unknown
// plugin ids 404 so the endpoint never persists state for a plugin outside the
// registry. The updated plugin view is returned.
func (h *PluginsHandler) TogglePlugin(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")

	d, ok := plugins.Get(id)
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "unknown plugin")
	}

	var req togglePluginRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(id), strconv.FormatBool(req.Enabled), "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, pluginView{
		ID:             d.ID,
		Type:           d.Type,
		Slot:           d.Slot,
		Routes:         d.Routes,
		Enabled:        req.Enabled,
		DefaultEnabled: d.DefaultEnabled,
	})
}
