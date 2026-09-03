package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/plugins"
	"point-api/internal/repository"
)

// The carousel plugin is a route plugin that ships disabled. This drives the
// gate end to end: with a built chunk and the plugin enabled the studio chunk
// serves and the manifest carries it; disabled, the chunk 404s and the manifest
// forgets it ever existed. The /api/carousel prefix it declares is gated the
// same way — disabled it 404s like a route nothing registered; enabled the
// not-yet-built endpoints answer past the gate (401 without a session, since
// auth runs after RequirePlugin), never the 200 SPA shell.
func TestCarouselPluginGate(t *testing.T) {
	const id = "carousel"
	root, chunk := writePluginFrontend(t, id)

	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	seedOwner(t, repo)
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	get := func(path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	setEnabled := func(on string) {
		if err := svcs.Settings.SetSetting(context.Background(), plugins.EnabledKey(id), on, "boolean"); err != nil {
			t.Fatal(err)
		}
	}

	// Sanity: it is not on by default.
	if plugins.IsEnabled(id, map[string]string{}) {
		t.Fatal("carousel must not be enabled by default")
	}

	// ── Enabled ──────────────────────────────────────────────────────────────
	setEnabled("true")

	if code := get("/assets/js/p/" + chunk).Code; code != http.StatusOK {
		t.Errorf("enabled carousel chunk should serve 200, got %d", code)
	}
	html := get("/").Body.String()
	if !strings.Contains(html, `"carousel"`) {
		t.Errorf("enabled carousel missing from the served manifest:\n%s", html)
	}
	if !strings.Contains(html, "/assets/js/p/"+chunk) {
		t.Errorf("carousel chunk URL missing from the manifest:\n%s", html)
	}
	if !strings.Contains(html, "/light/carousel") {
		t.Errorf("carousel admin route missing from the manifest:\n%s", html)
	}

	// The prefix is registered and gated: with the plugin on, the request gets
	// past RequirePlugin and is stopped by auth (401) — not served the SPA shell.
	if code := get("/api/carousel").Code; code != http.StatusUnauthorized {
		t.Errorf("enabled /api/carousel should reach auth (401), got %d", code)
	}

	// ── Disabled ─────────────────────────────────────────────────────────────
	setEnabled("false")

	if code := get("/assets/js/p/" + chunk).Code; code != http.StatusNotFound {
		t.Errorf("disabled carousel chunk should 404, got %d", code)
	}
	html = get("/").Body.String()
	if strings.Contains(html, `"carousel"`) {
		t.Errorf("disabled carousel must not appear in the served HTML:\n%s", html)
	}
	if strings.Contains(html, chunk) {
		t.Errorf("disabled carousel chunk URL must not appear in the served HTML:\n%s", html)
	}
	if code := get("/api/carousel").Code; code != http.StatusNotFound {
		t.Errorf("/api/carousel should 404 when disabled, got %d", code)
	}
}
