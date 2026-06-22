package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/plugins"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

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
	// An untouched plugin falls back to DefaultEnabled (true).
	if v, ok := state["immersive"]; !ok || !v.Enabled {
		t.Errorf("immersive should be present and enabled by default: %+v (ok=%v)", v, ok)
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
			if he, ok := err.(*echo.HTTPError); ok {
				return he.Code, pluginView{}
			}
			return http.StatusInternalServerError, pluginView{}
		}
		var v pluginView
		_ = json.Unmarshal(rec.Body.Bytes(), &v)
		return rec.Code, v
	}

	// Disable → 200, response reflects disabled, and it persists to settings.
	code, v := toggle("immersive", `{"enabled":false}`)
	if code != http.StatusOK || v.Enabled {
		t.Fatalf("disable: code=%d enabled=%v", code, v.Enabled)
	}
	all, _ := svc.GetAllSettings(ctx)
	if plugins.IsEnabled("immersive", all) {
		t.Error("immersive should be disabled in settings after toggle")
	}

	// Re-enable → 200, response reflects enabled, persists.
	code, v = toggle("immersive", `{"enabled":true}`)
	if code != http.StatusOK || !v.Enabled {
		t.Fatalf("enable: code=%d enabled=%v", code, v.Enabled)
	}
	all, _ = svc.GetAllSettings(ctx)
	if !plugins.IsEnabled("immersive", all) {
		t.Error("immersive should be enabled in settings after toggle")
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
	he, ok := err.(*echo.HTTPError)
	if !ok || he.Code != http.StatusNotFound {
		t.Fatalf("expected 404 HTTPError for unknown plugin, got %v", err)
	}
}
