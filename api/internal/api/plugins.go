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
	Area           string       `json:"area,omitempty"`
	Core           bool         `json:"core,omitempty"`
	Exclusive      bool         `json:"exclusive,omitempty"`
	// Locked is true when the plugin may not be disabled because it is the sole
	// enabled member of a core area. The frontend renders its toggle read-only.
	Locked bool `json:"locked,omitempty"`
}

// viewFor builds a pluginView from a descriptor and the resolved settings map.
func viewFor(d plugins.Descriptor, settings map[string]string) pluginView {
	return pluginView{
		ID:             d.ID,
		Type:           d.Type,
		Slot:           d.Slot,
		Routes:         d.Routes,
		Enabled:        plugins.IsEnabled(d.ID, settings),
		DefaultEnabled: d.DefaultEnabled,
		Area:           d.Area,
		Core:           d.Core,
		Exclusive:      d.Exclusive,
		Locked:         plugins.IsLockedOff(d.ID, settings),
	}
}

// listViews returns the full catalog as views, in registry order.
func listViews(settings map[string]string) []pluginView {
	out := make([]pluginView, 0, len(plugins.Registry))
	for _, d := range plugins.Registry {
		out = append(out, viewFor(d, settings))
	}
	return out
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
	return c.JSON(http.StatusOK, listViews(all))
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

	all, err := h.settingsService.GetAllSettings(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	// Refuse to empty a core area: the sole enabled plugin there can't go off.
	if !req.Enabled && plugins.IsLockedOff(id, all) {
		return echo.NewHTTPError(http.StatusConflict, "at least one plugin must stay enabled in this area")
	}

	if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(id), strconv.FormatBool(req.Enabled), "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	all[plugins.EnabledKey(id)] = strconv.FormatBool(req.Enabled)

	// Exclusive area: enabling a member turns its peers off (radio semantics).
	if req.Enabled {
		for _, peer := range plugins.ExclusivePeers(id) {
			if !plugins.IsEnabled(peer, all) {
				continue
			}
			if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(peer), "false", "string"); err != nil {
				return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
			}
			all[plugins.EnabledKey(peer)] = "false"
		}
	}
	// An individual toggle diverges from any preset.
	if err := h.settingsService.SetSetting(ctx, activePresetKey, presetCustom, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	return c.JSON(http.StatusOK, viewFor(d, all))
}
