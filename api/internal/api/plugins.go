package api

import (
	"net/http"
	"os"
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
	Title          string       `json:"title,omitempty"`
	Type           plugins.Type `json:"type"`
	Slot           string       `json:"slot,omitempty"`
	Routes         []string     `json:"routes,omitempty"`
	Enabled        bool         `json:"enabled"`
	DefaultEnabled bool         `json:"default_enabled"`
	// SlotRule is the cardinality of the plugin's slot ("0-1", "1", …), omitted
	// for plugins that claim no slot. It tells the page which rows are
	// alternatives for one region and which of them may be switched off.
	SlotRule plugins.Cardinality `json:"slot_rule,omitempty"`
	// Locked is true when the plugin may not be disabled because its slot
	// requires a claimant and this is the only enabled one. The frontend renders
	// its toggle read-only.
	Locked bool `json:"locked,omitempty"`
}

// viewFor builds a pluginView from a descriptor and the resolved settings map.
func viewFor(d plugins.Descriptor, settings map[string]string) pluginView {
	v := pluginView{
		ID:             d.ID,
		Title:          d.Title,
		Type:           d.Type,
		Slot:           d.Slot,
		Routes:         d.Routes,
		Enabled:        plugins.IsEnabled(d.ID, settings),
		DefaultEnabled: d.DefaultEnabled,
		Locked:         plugins.IsLockedOff(d.ID, settings),
	}
	if d.Slot != "" {
		v.SlotRule = plugins.SlotRule(d.Slot)
	}
	return v
}

// listViews returns the full catalog as views, in registry order,
// omitting plugins that are not available in the current build/environment.
func listViews(settings map[string]string) []pluginView {
	// remark42 is completely disabled in the slim image (IS_SLIM=true)
	// or explicitly turned off in local dev (ENABLE_REMARK42=false).
	hasRemark42 := os.Getenv("IS_SLIM") != "true" && os.Getenv("ENABLE_REMARK42") != "false"

	out := make([]pluginView, 0, len(plugins.Registry))
	for _, d := range plugins.Registry {
		if d.ID == "comments" && !hasRemark42 {
			continue
		}
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
		return MapError(err)
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
		return MapError(err)
	}

	// Refuse to empty a slot that requires a claimant: its sole enabled plugin
	// can't go off (the way to switch is to enable another candidate, below).
	if !req.Enabled && plugins.IsLockedOff(id, all) {
		return echo.NewHTTPError(http.StatusConflict, "at least one plugin must stay enabled in this slot")
	}

	if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(id), strconv.FormatBool(req.Enabled), "string"); err != nil {
		return MapError(err)
	}
	all[plugins.EnabledKey(id)] = strconv.FormatBool(req.Enabled)

	// Single-claim slot: enabling a candidate turns its peers off (radio
	// semantics). This is also how a required slot switches claimant, since the
	// outgoing one is locked against being disabled directly.
	if req.Enabled {
		for _, peer := range plugins.SlotPeers(id) {
			if !plugins.IsEnabled(peer, all) {
				continue
			}
			if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(peer), "false", "string"); err != nil {
				return MapError(err)
			}
			all[plugins.EnabledKey(peer)] = "false"
		}
	}
	// An individual toggle diverges from any preset.
	if err := h.settingsService.SetSetting(ctx, activePresetKey, presetCustom, "string"); err != nil {
		return MapError(err)
	}

	return c.JSON(http.StatusOK, viewFor(d, all))
}
