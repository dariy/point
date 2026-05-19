package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"point-api/internal/config"
	"point-api/internal/repository"
	"testing"
)

// mkdirs creates subdirectories inside base and returns their paths.
func mkdirs(t *testing.T, base string, names ...string) map[string]string {
	t.Helper()
	dirs := make(map[string]string, len(names))
	for _, name := range names {
		p := filepath.Join(base, name)
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatalf("mkdirAll %s: %v", p, err)
		}
		dirs[name] = p
	}
	return dirs
}

func TestResolveJSDir_BundlePreferredOverSrc(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js", "src")

	got := resolveJSDir(root)
	if got != dirs["js"] {
		t.Errorf("expected js/ bundle dir %q, got %q", dirs["js"], got)
	}
}

func TestResolveJSDir_FallsBackToSrc(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "src")

	got := resolveJSDir(root)
	if got != dirs["src"] {
		t.Errorf("expected src/ fallback %q, got %q", dirs["src"], got)
	}
}

func TestResolveJSDir_NeitherExists(t *testing.T) {
	root := t.TempDir()
	// no js/ or src/ created

	got := resolveJSDir(root)
	if got != "" {
		t.Errorf("expected empty string when neither dir exists, got %q", got)
	}
}

func TestResolveJSDir_OnlyBundleExists(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js")

	got := resolveJSDir(root)
	if got != dirs["js"] {
		t.Errorf("expected js/ dir %q, got %q", dirs["js"], got)
	}
}

func TestResolveJSDir_NonexistentFrontendDir(t *testing.T) {
	got := resolveJSDir("/tmp/does-not-exist-point-test")
	if got != "" {
		t.Errorf("expected empty string for missing frontend dir, got %q", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	cfg := config.Config{
		AppVersion:  "1.0.0",
		FrontendDir: t.TempDir(),
	}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}

	headers := rec.Header()
	tests := []struct {
		key   string
		value string
	}{
		{"X-Content-Type-Options", "nosniff"},
		{"X-Frame-Options", "DENY"},
		{"X-Xss-Protection", "1; mode=block"},
		{"Content-Security-Policy", "default-src 'self'; script-src 'self' 'sha256-+20twPiohHfGLZsSvahDBaYeh7l+te5yNz5UDCAfqsA='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com; media-src 'self' blob:; connect-src 'self' https://*.basemaps.cartocdn.com; frame-ancestors 'none'"},
		{"Referrer-Policy", "strict-origin-when-cross-origin"},
		{"Permissions-Policy", "geolocation=(), microphone=(), camera=()"},
	}

	for _, tt := range tests {
		if got := headers.Get(tt.key); got != tt.value {
			t.Errorf("header %s: expected %q, got %q", tt.key, tt.value, got)
		}
	}
}

func TestCustomErrorHandlerInMain(t *testing.T) {
	cfg := config.Config{
		AppVersion:  "1.0.0",
		FrontendDir: t.TempDir(),
	}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	// Test error handler (hitting SPA fallback which returns 503 if index.html missing)
	req := httptest.NewRequest(http.MethodGet, "/not-exists", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("expected 503, got %d", rec.Code)
	}

	var resp map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["detail"] == "" {
		t.Errorf("expected detail in response, got empty")
	}
}
