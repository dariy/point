package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// registryDefaultIDs picks one plugin that ships enabled and one that ships
// disabled. Tests that need "a plugin in state X" use these instead of naming a
// plugin: the shipped defaults are product tuning that changes between releases
// and deployments, and a test that hardcodes them goes red on every retune
// without having found a bug.
// Ids in exclude are skipped, for tests that already drive one plugin directly.
func registryDefaultIDs(t *testing.T, exclude ...string) (on, off string) {
	t.Helper()
	skip := make(map[string]bool, len(exclude))
	for _, id := range exclude {
		skip[id] = true
	}
	for _, d := range plugins.Registry {
		if skip[d.ID] {
			continue
		}
		if d.DefaultEnabled && on == "" {
			on = d.ID
		}
		if !d.DefaultEnabled && off == "" {
			off = d.ID
		}
	}
	if on == "" || off == "" {
		t.Fatalf("registry needs a default-on and a default-off plugin; got on=%q off=%q", on, off)
	}
	return on, off
}

// coreAreaSplit returns a core area's default-enabled member (the one the
// toggle endpoint must refuse to disable) and a default-disabled sibling that
// can take over the area.
func coreAreaSplit(t *testing.T) (on, off string) {
	t.Helper()
	for _, d := range plugins.Registry {
		if !d.Core || d.Area == "" {
			continue
		}
		on, off = "", ""
		for _, m := range plugins.AreaPlugins(d.Area) {
			if m.DefaultEnabled && on == "" {
				on = m.ID
			}
			if !m.DefaultEnabled && off == "" {
				off = m.ID
			}
		}
		if on != "" && off != "" {
			return on, off
		}
	}
	t.Fatal("registry has no core area with one enabled and one disabled member")
	return "", ""
}

func newPluginsHandler(t *testing.T) (*PluginsHandler, *services.SettingsService, *echo.Echo) {
	t.Helper()
	repo := setupTestDB(t)
	t.Cleanup(func() { _ = repo.Close() })
	svc := services.NewSettingsService(repo)
	return NewPluginsHandler(svc), svc, echo.New()
}

func TestListPlugins_ReturnsFullCatalogWithState(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	// Disable one plugin so the list must reflect mixed state.
	if err := svc.SetSetting(ctx, plugins.EnabledKey("timeline"), "false", "string"); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, "/api/plugins", nil)
	rec := httptest.NewRecorder()
	if err := h.ListPlugins(e.NewContext(req, rec)); err != nil {
		t.Fatalf("ListPlugins error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var views []pluginView
	if err := json.Unmarshal(rec.Body.Bytes(), &views); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Full catalog, including disabled plugins (admin-only endpoint).
	if len(views) != len(plugins.Registry) {
		t.Fatalf("expected %d plugins, got %d", len(plugins.Registry), len(views))
	}

	state := make(map[string]pluginView, len(views))
	for _, v := range views {
		state[v.ID] = v
	}
	if v, ok := state["timeline"]; !ok || v.Enabled {
		t.Errorf("timeline should be present and disabled: %+v (ok=%v)", v, ok)
	}
	// An untouched plugin reports its DefaultEnabled, whichever way that falls
	// (timeline excluded — this test just overrode it).
	defaultOn, defaultOff := registryDefaultIDs(t, "timeline")
	if v, ok := state[defaultOn]; !ok || !v.Enabled {
		t.Errorf("%s should be present and enabled by default: %+v (ok=%v)", defaultOn, v, ok)
	}
	if v, ok := state[defaultOff]; !ok || v.Enabled {
		t.Errorf("%s should be present and disabled by default: %+v (ok=%v)", defaultOff, v, ok)
	}
}

func TestTogglePlugin_DisableThenEnable(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	toggle := func(id, body string) (int, pluginView) {
		req := httptest.NewRequest(http.MethodPatch, "/api/plugins/"+id, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("id")
		c.SetParamValues(id)
		err := h.TogglePlugin(c)
		if err != nil {
			var he *echo.HTTPError
			if errors.As(err, &he) {
				return he.Code, pluginView{}
			}
			return http.StatusInternalServerError, pluginView{}
		}
		var v pluginView
		_ = json.Unmarshal(rec.Body.Bytes(), &v)
		return rec.Code, v
	}

	// Disable → 200, response reflects disabled, and it persists to settings.
	// Uses a non-core plugin so the toggle isn't blocked by the core-area guard.
	code, v := toggle("timeline", `{"enabled":false}`)
	if code != http.StatusOK || v.Enabled {
		t.Fatalf("disable: code=%d enabled=%v", code, v.Enabled)
	}
	all, _ := svc.GetAllSettings(ctx)
	if plugins.IsEnabled("timeline", all) {
		t.Error("timeline should be disabled in settings after toggle")
	}

	// Re-enable → 200, response reflects enabled, persists.
	code, v = toggle("timeline", `{"enabled":true}`)
	if code != http.StatusOK || !v.Enabled {
		t.Fatalf("enable: code=%d enabled=%v", code, v.Enabled)
	}
	all, _ = svc.GetAllSettings(ctx)
	if !plugins.IsEnabled("timeline", all) {
		t.Error("timeline should be enabled in settings after toggle")
	}
}

func TestTogglePlugin_CoreAreaCannotBeEmptied(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	toggle := func(id, body string) int {
		req := httptest.NewRequest(http.MethodPatch, "/api/plugins/"+id, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("id")
		c.SetParamValues(id)
		if err := h.TogglePlugin(c); err != nil {
			var he *echo.HTTPError
			if errors.As(err, &he) {
				return he.Code
			}
			return http.StatusInternalServerError
		}
		return rec.Code
	}

	// The immersive viewers are the only core area left (the admin routes that
	// used to be single-member core areas are ordinary routes in app.js).
	// Whichever of the two ships enabled is the area's sole member → locked.
	sole, sibling := coreAreaSplit(t)
	if code := toggle(sole, `{"enabled":false}`); code != http.StatusConflict {
		t.Fatalf("disabling sole viewer %q should 409, got %d", sole, code)
	}

	// Enable the sibling, and the first may be disabled — the area stays alive.
	if code := toggle(sibling, `{"enabled":true}`); code != http.StatusOK {
		t.Fatalf("enabling %q should 200, got %d", sibling, code)
	}
	if code := toggle(sole, `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("disabling %q with %q on should 200, got %d", sole, sibling, code)
	}
	all, _ := svc.GetAllSettings(ctx)
	if plugins.IsEnabled(sole, all) || !plugins.IsEnabled(sibling, all) {
		t.Errorf("expected %s on, %s off; got %s=%v %s=%v",
			sibling, sole, sole, plugins.IsEnabled(sole, all), sibling, plugins.IsEnabled(sibling, all))
	}
}

func TestTogglePlugin_ExclusiveAreaKeepsAtMostOne(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	toggle := func(id, body string) int {
		req := httptest.NewRequest(http.MethodPatch, "/api/plugins/"+id, strings.NewReader(body))
		req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
		rec := httptest.NewRecorder()
		c := e.NewContext(req, rec)
		c.SetParamNames("id")
		c.SetParamValues(id)
		if err := h.TogglePlugin(c); err != nil {
			var he *echo.HTTPError
			if errors.As(err, &he) {
				return he.Code
			}
			return http.StatusInternalServerError
		}
		return rec.Code
	}

	// Atlas is the default-enabled tags viz. Enabling Map disables Atlas (radio).
	if code := toggle("tags-map", `{"enabled":true}`); code != http.StatusOK {
		t.Fatalf("enabling tags-map should 200, got %d", code)
	}
	all, _ := svc.GetAllSettings(ctx)
	if got := plugins.EnabledInArea("tags-viz", all); len(got) != 1 || got[0] != "tags-map" {
		t.Fatalf("exclusive area should hold only tags-map, got %v", got)
	}

	// Switching to Graph likewise leaves it the sole enabled member.
	if code := toggle("tags-graph", `{"enabled":true}`); code != http.StatusOK {
		t.Fatalf("enabling tags-graph should 200, got %d", code)
	}
	all, _ = svc.GetAllSettings(ctx)
	if got := plugins.EnabledInArea("tags-viz", all); len(got) != 1 || got[0] != "tags-graph" {
		t.Fatalf("exclusive area should hold only tags-graph, got %v", got)
	}

	// "None" is allowed: disabling the active viz empties the area (not locked).
	if code := toggle("tags-graph", `{"enabled":false}`); code != http.StatusOK {
		t.Fatalf("disabling the sole tags viz should 200 (none allowed), got %d", code)
	}
	all, _ = svc.GetAllSettings(ctx)
	if got := plugins.EnabledInArea("tags-viz", all); len(got) != 0 {
		t.Fatalf("exclusive area should be empty, got %v", got)
	}
}

func TestApplyPreset_SetsStateAndKeepsCoreAreas(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	req := httptest.NewRequest(http.MethodPost, "/api/plugins/presets/minimalistic/apply", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("minimalistic")
	if err := h.ApplyPreset(c); err != nil {
		t.Fatalf("ApplyPreset error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	all, _ := svc.GetAllSettings(ctx)
	// Minimalistic disables public chrome…
	if plugins.IsEnabled("public-header", all) || plugins.IsEnabled("timeline", all) {
		t.Error("minimalistic should disable header/timeline")
	}
	// …enables the Sheet viewer and disables Standard…
	if !plugins.IsEnabled("immersive-sheet", all) || plugins.IsEnabled("immersive", all) {
		t.Error("minimalistic should enable Sheet and disable Standard")
	}
	// …and never empties a core area: some viewer stays enabled.
	if !plugins.IsEnabled("immersive-sheet", all) && !plugins.IsEnabled("immersive", all) {
		t.Error("a preset must not leave the immersive core area empty")
	}
	// The active preset is recorded.
	if all[activePresetKey] != "minimalistic" {
		t.Errorf("active preset = %q, want minimalistic", all[activePresetKey])
	}
}

func TestTogglePlugin_UnknownID404(t *testing.T) {
	h, _, e := newPluginsHandler(t)

	req := httptest.NewRequest(http.MethodPatch, "/api/plugins/nope", strings.NewReader(`{"enabled":false}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("nope")

	err := h.TogglePlugin(c)
	var he *echo.HTTPError
	ok := errors.As(err, &he)
	if !ok || he.Code != http.StatusNotFound {
		t.Fatalf("expected 404 HTTPError for unknown plugin, got %v", err)
	}
}
