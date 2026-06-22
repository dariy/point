package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/plugins"
	"point-api/internal/repository"
)

// writePluginFrontend builds a minimal frontend tree with a built chunk for the
// given plugin id and returns the frontend dir + chunk filename.
func writePluginFrontend(t *testing.T, pluginID string) (string, string) {
	t.Helper()
	root := t.TempDir()
	jsDir := filepath.Join(root, "js")
	pDir := filepath.Join(jsDir, "p")
	if err := os.MkdirAll(pDir, 0o755); err != nil {
		t.Fatal(err)
	}
	chunk := pluginID + "-DEADBEEF.js"
	if err := os.WriteFile(filepath.Join(pDir, chunk), []byte("export const x=1;"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jsDir, "app.js"), []byte("export const app=1;"), 0o644); err != nil {
		t.Fatal(err)
	}
	manifest := `{"` + pluginID + `":"` + chunk + `"}`
	if err := os.WriteFile(filepath.Join(jsDir, "plugin-manifest.json"), []byte(manifest), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"),
		[]byte("<html><head><title>Loading…</title></head><body></body></html>"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, chunk
}

func TestPluginChunkGating(t *testing.T) {
	const id = "immersive"
	root, chunk := writePluginFrontend(t, id)

	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	get := func(path string) int {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec.Code
	}

	// Static JS still serves (route precedence: /assets/js/p/* must not shadow it).
	if code := get("/assets/js/app.js"); code != http.StatusOK {
		t.Errorf("static app.js should serve 200, got %d", code)
	}

	// Enabled-by-default plugin chunk serves.
	if code := get("/assets/js/p/" + chunk); code != http.StatusOK {
		t.Errorf("enabled plugin chunk should serve 200, got %d", code)
	}

	// Unknown chunk under the gated prefix 404s.
	if code := get("/assets/js/p/ghost-00000000.js"); code != http.StatusNotFound {
		t.Errorf("unknown chunk should 404, got %d", code)
	}

	// Path-traversal attempt 404s rather than escaping the chunk dir.
	if code := get("/assets/js/p/../app.js"); code == http.StatusOK {
		t.Errorf("traversal should not serve app.js via gated handler (got %d)", code)
	}

	// Disable the plugin → its chunk now 404s.
	if err := svcs.Settings.SetSetting(context.Background(), plugins.EnabledKey(id), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	if code := get("/assets/js/p/" + chunk); code != http.StatusNotFound {
		t.Errorf("disabled plugin chunk should 404, got %d", code)
	}
}

func TestPluginManifestInjection(t *testing.T) {
	const id = "immersive"
	root, _ := writePluginFrontend(t, id)

	cfg := config.Config{AppVersion: "1.0.0", FrontendDir: root}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = repo.Close() }()
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	body := func() string {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("SPA fallback should serve 200, got %d", rec.Code)
		}
		return rec.Body.String()
	}

	// All enabled (default): manifest present, names the immersive plugin and its
	// resolved chunk URL.
	html := body()
	if !strings.Contains(html, "window.__PLUGINS__=") {
		t.Fatalf("manifest script missing from served HTML:\n%s", html)
	}
	if !strings.Contains(html, `"immersive"`) {
		t.Errorf("enabled plugin 'immersive' missing from manifest:\n%s", html)
	}
	if !strings.Contains(html, "/assets/js/p/immersive-DEADBEEF.js") {
		t.Errorf("immersive chunk URL missing from manifest:\n%s", html)
	}

	// Disable the plugin → it must vanish from the served HTML entirely
	// (enabled-only manifest, the system's hard constraint).
	if err := svcs.Settings.SetSetting(context.Background(), plugins.EnabledKey(id), "false", "boolean"); err != nil {
		t.Fatal(err)
	}
	html = body()
	if strings.Contains(html, `"immersive"`) {
		t.Errorf("disabled plugin 'immersive' must NOT appear in served HTML:\n%s", html)
	}
	if strings.Contains(html, "immersive-DEADBEEF.js") {
		t.Errorf("disabled plugin chunk URL must NOT appear in served HTML:\n%s", html)
	}
}
