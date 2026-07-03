package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"point-api/internal/plugins"

	"github.com/labstack/echo/v4"
)

// Plugin presets are named sets of enabled plugins the admin can apply with one
// click and edit freely. They persist in blog_settings: presetsKey holds the
// JSON map (preset id -> plugin ids) and activePresetKey holds the id of the
// last-applied preset, or presetCustom once individual toggles diverge from it.
const (
	presetsKey      = "plugins.presets"
	activePresetKey = "plugins.active_preset"
	presetCustom    = "custom"
)

// presetsResponse is the body of GET /api/plugins/presets.
type presetsResponse struct {
	Presets map[string][]string `json:"presets"`
	Active  string              `json:"active"`
}

// loadPresets returns the stored preset map, seeding (and persisting) the
// defaults the first time it is absent or unparseable.
func (h *PluginsHandler) loadPresets(c echo.Context) (map[string][]string, error) {
	ctx := c.Request().Context()
	all, err := h.settingsService.GetAllSettings(ctx)
	if err != nil {
		return nil, err
	}

	if raw, ok := all[presetsKey]; ok && raw != "" {
		var m map[string][]string
		if json.Unmarshal([]byte(raw), &m) == nil && len(m) > 0 {
			return m, nil
		}
	}

	defaults := plugins.DefaultPresets()
	if err := h.savePresets(c, defaults); err != nil {
		return nil, err
	}
	return defaults, nil
}

func (h *PluginsHandler) savePresets(c echo.Context, m map[string][]string) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	return h.settingsService.SetSetting(c.Request().Context(), presetsKey, string(b), "json")
}

// GetPresets returns the preset definitions and the active preset id.
func (h *PluginsHandler) GetPresets(c echo.Context) error {
	presets, err := h.loadPresets(c)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	active := all[activePresetKey]
	if active == "" {
		active = presetCustom
	}
	return c.JSON(http.StatusOK, presetsResponse{Presets: presets, Active: active})
}

// updatePresetRequest is the body for editing a preset's membership.
type updatePresetRequest struct {
	Plugins []string `json:"plugins"`
}

// UpdatePreset replaces the plugin list of preset :id. Unknown plugin ids are
// rejected; the preset id must already exist.
func (h *PluginsHandler) UpdatePreset(c echo.Context) error {
	id := c.Param("id")
	presets, err := h.loadPresets(c)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	if _, ok := presets[id]; !ok {
		return echo.NewHTTPError(http.StatusNotFound, "unknown preset")
	}

	var req updatePresetRequest
	if err := c.Bind(&req); err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "invalid request")
	}

	clean := make([]string, 0, len(req.Plugins))
	seen := make(map[string]bool, len(req.Plugins))
	for _, pid := range req.Plugins {
		if _, ok := plugins.Get(pid); !ok {
			return echo.NewHTTPError(http.StatusBadRequest, "unknown plugin: "+pid)
		}
		if !seen[pid] {
			seen[pid] = true
			clean = append(clean, pid)
		}
	}

	presets[id] = clean
	if err := h.savePresets(c, presets); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, presetsResponse{Presets: presets, Active: presetActive(c, h)})
}

// ApplyPreset sets every plugin's enabled state from preset :id, then guarantees
// every core area keeps at least one enabled member, and records the active
// preset. It returns the full plugin catalog so the client re-renders in one
// round-trip.
func (h *PluginsHandler) ApplyPreset(c echo.Context) error {
	ctx := c.Request().Context()
	id := c.Param("id")

	presets, err := h.loadPresets(c)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	list, ok := presets[id]
	if !ok {
		return echo.NewHTTPError(http.StatusNotFound, "unknown preset")
	}

	want := make(map[string]bool, len(list))
	for _, pid := range list {
		want[pid] = true
	}

	// Guarantee each core area keeps a member: if the preset enables none, fall
	// back to the area's default plugin (or its first descriptor).
	for _, d := range plugins.Registry {
		if !d.Core || d.Area == "" {
			continue
		}
		members := plugins.AreaPlugins(d.Area)
		anyOn := false
		for _, m := range members {
			if want[m.ID] {
				anyOn = true
				break
			}
		}
		if !anyOn {
			want[coreAreaFallback(members)] = true
		}
	}

	// Exclusive areas keep at most one member: if a preset enables several
	// alternatives, keep the first (registry order) and drop the rest.
	doneAreas := map[string]bool{}
	for _, d := range plugins.Registry {
		if !d.Exclusive || d.Area == "" || doneAreas[d.Area] {
			continue
		}
		doneAreas[d.Area] = true
		kept := false
		for _, m := range plugins.AreaPlugins(d.Area) {
			if !want[m.ID] {
				continue
			}
			if kept {
				want[m.ID] = false
			} else {
				kept = true
			}
		}
	}

	for _, d := range plugins.Registry {
		if err := h.settingsService.SetSetting(ctx, plugins.EnabledKey(d.ID), strconv.FormatBool(want[d.ID]), "string"); err != nil {
			return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
		}
	}
	if err := h.settingsService.SetSetting(ctx, activePresetKey, id, "string"); err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}

	all, err := h.settingsService.GetAllSettings(ctx)
	if err != nil {
		return echo.NewHTTPError(http.StatusInternalServerError, err.Error())
	}
	return c.JSON(http.StatusOK, listViews(all))
}

// coreAreaFallback picks the plugin to keep enabled for a core area that a
// preset left empty: the descriptor marked DefaultEnabled, else the first.
func coreAreaFallback(members []plugins.Descriptor) string {
	for _, m := range members {
		if m.DefaultEnabled {
			return m.ID
		}
	}
	return members[0].ID
}

// presetActive reads the active preset id, defaulting to custom.
func presetActive(c echo.Context, h *PluginsHandler) string {
	all, err := h.settingsService.GetAllSettings(c.Request().Context())
	if err != nil {
		return presetCustom
	}
	if a := all[activePresetKey]; a != "" {
		return a
	}
	return presetCustom
}
