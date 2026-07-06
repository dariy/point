package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/plugins"

	"github.com/labstack/echo/v4"
)

// GetPresets seeds the defaults on first read and reports the active preset.
func TestGetPresets_SeedsDefaultsAndReportsActive(t *testing.T) {
	h, svc, e := newPluginsHandler(t)

	req := httptest.NewRequest(http.MethodGet, "/api/plugins/presets", nil)
	rec := httptest.NewRecorder()
	if err := h.GetPresets(e.NewContext(req, rec)); err != nil {
		t.Fatalf("GetPresets error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var got presetsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for id := range plugins.DefaultPresets() {
		if _, ok := got.Presets[id]; !ok {
			t.Errorf("default preset %q missing from response", id)
		}
	}
	if got.Active != presetCustom {
		t.Errorf("active = %q, want %q", got.Active, presetCustom)
	}

	// Defaults were persisted so a second read is stable.
	all, _ := svc.GetAllSettings(context.Background())
	if all[presetsKey] == "" {
		t.Error("presets were not persisted on first read")
	}
}

// UpdatePreset replaces membership, dedups, and reports the active preset.
func TestUpdatePreset_ReplacesMembershipAndDedups(t *testing.T) {
	h, _, e := newPluginsHandler(t)

	body := `{"plugins":["timeline","timeline","tag-cloud"]}`
	req := httptest.NewRequest(http.MethodPut, "/api/plugins/presets/standalone", strings.NewReader(body))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("standalone")

	if err := h.UpdatePreset(c); err != nil {
		t.Fatalf("UpdatePreset error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var got presetsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if want := []string{"timeline", "tag-cloud"}; !equalSlice(got.Presets["standalone"], want) {
		t.Errorf("standalone = %v, want %v (deduped)", got.Presets["standalone"], want)
	}
}

func TestUpdatePreset_UnknownPreset404(t *testing.T) {
	h, _, e := newPluginsHandler(t)

	req := httptest.NewRequest(http.MethodPut, "/api/plugins/presets/nope", strings.NewReader(`{"plugins":[]}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("nope")

	he, ok := h.UpdatePreset(c).(*echo.HTTPError)
	if !ok || he.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %v", he)
	}
}

func TestUpdatePreset_UnknownPlugin400(t *testing.T) {
	h, _, e := newPluginsHandler(t)

	req := httptest.NewRequest(http.MethodPut, "/api/plugins/presets/standalone", strings.NewReader(`{"plugins":["not-a-plugin"]}`))
	req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("standalone")

	he, ok := h.UpdatePreset(c).(*echo.HTTPError)
	if !ok || he.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %v", he)
	}
}

// TestApplyPreset_ExclusiveAreaKeepsFirst applies "fully-featured" (which
// enables every plugin, including all three tag-viz alternatives) and verifies
// the exclusive-area guard leaves only the first member (tags-atlas) enabled.
func TestApplyPreset_ExclusiveAreaKeepsFirst(t *testing.T) {
	h, svc, e := newPluginsHandler(t)
	ctx := context.Background()

	req := httptest.NewRequest(http.MethodPost, "/api/plugins/presets/fully-featured/apply", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	c.SetParamNames("id")
	c.SetParamValues("fully-featured")
	if err := h.ApplyPreset(c); err != nil {
		t.Fatalf("ApplyPreset error: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	all, _ := svc.GetAllSettings(ctx)
	if got := plugins.EnabledInArea("tags-viz", all); len(got) != 1 || got[0] != "tags-atlas" {
		t.Errorf("exclusive area should keep only tags-atlas, got %v", got)
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
