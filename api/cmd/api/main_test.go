package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/models"
	"point-api/internal/repository"
	"point-api/internal/services"
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

func TestRunSetupCLI_AlreadySetup(t *testing.T) {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	svcs := initServices(cfg, repo)

	// Pre-create a user so the CLI detects "already setup" and returns early.
	ctx := context.Background()
	_, err = repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "the_owner",
		Email:        "test@example.com",
		PasswordHash: "hash",
		DisplayName:  "Test User",
	})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	origArgs := os.Args
	defer func() { os.Args = origArgs }()
	os.Args = []string{"point", "setup", "--title=My Blog", "--user=Admin", "--email=a@b.com", "--password=abc123"}

	// Should return without calling os.Exit since user already exists.
	runSetupCLI(repo, svcs)
}

func TestRunSetupCLI_NewSetup(t *testing.T) {
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	cfg := &config.Config{StoragePath: t.TempDir()}
	svcs := initServices(cfg, repo)

	origArgs := os.Args
	defer func() { os.Args = origArgs }()
	os.Args = []string{"point", "setup", "--title=My Blog", "--user=Admin", "--email=a@b.com", "--password=abc123"}

	runSetupCLI(repo, svcs)

	// Verify the user was created.
	ctx := context.Background()
	u, err := repo.GetFirstUser(ctx)
	if err != nil {
		t.Fatalf("GetFirstUser after setup: %v", err)
	}
	if u.DisplayName != "Admin" {
		t.Errorf("expected display name 'Admin', got %q", u.DisplayName)
	}
}

// ── setupEcho additional coverage ─────────────────────────────────────────

func newEchoWithRepo(t *testing.T) (*repository.Repository, config.Config) {
	t.Helper()
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("NewRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	cfg := config.Config{
		AppVersion:  "1.0.0",
		FrontendDir: t.TempDir(),
	}
	return repo, cfg
}

func TestSetupEcho_FeedRoutes(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	for _, route := range []string{"/feed.xml", "/sitemap.xml", "/robots.txt"} {
		req := httptest.NewRequest(http.MethodGet, route, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Errorf("%s: expected non-5xx, got %d", route, rec.Code)
		}
	}
}

func TestSetupEcho_SetupAPIRoute(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/api/setup/status", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 from /api/setup/status, got %d", rec.Code)
	}
}

func TestSetupEcho_ManifestAndSW(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	// Create manifest and sw.js files so those routes are registered.
	_ = os.WriteFile(filepath.Join(cfg.FrontendDir, "manifest.webmanifest"), []byte(`{}`), 0644)
	_ = os.WriteFile(filepath.Join(cfg.FrontendDir, "sw.js"), []byte(`// sw`), 0644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	for _, route := range []string{"/manifest.webmanifest", "/sw.js"} {
		req := httptest.NewRequest(http.MethodGet, route, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: expected 200, got %d", route, rec.Code)
		}
	}
}

func TestSetupEcho_CSSCacheControlHeader(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	// Create css dir so static middleware is registered.
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(cssDir, 0755)
	_ = os.WriteFile(filepath.Join(cssDir, "app.css"), []byte("body{}"), 0644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/assets/css/app.css", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("expected Cache-Control: no-cache on CSS, got %q", cc)
	}
}

func TestSetupEcho_SPAFallback_WithPublishedPost(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	// Create index.html for SPA fallback.
	indexHTML := filepath.Join(cfg.FrontendDir, "index.html")
	_ = os.WriteFile(indexHTML, []byte(`<html><head><title>Loading…</title></head><body></body></html>`), 0644)

	// Create a published post.
	ctx := context.Background()
	settingsSvc := services.NewSettingsService(repo)
	_ = settingsSvc.SetSetting(ctx, "blog_title", "Test Blog", "string")
	hash, _ := services.HashPassword("pass")
	u, _ := repo.CreateUser(ctx, models.CreateUserParams{
		Username:     "owner",
		Email:        "owner@test.com",
		PasswordHash: hash,
		DisplayName:  "Owner",
	})
	_, _ = repo.CreatePost(ctx, models.CreatePostParams{
		Title:    "My Post",
		Slug:     "my-post",
		AuthorID: u.ID,
		Status:   "published",
	})

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/posts/my-post", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for SPA post route, got %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "My Post") {
		t.Errorf("expected post title in HTML, got: %s", rec.Body.String()[:min(200, rec.Body.Len())])
	}
}

func TestSetupEcho_WebAuthn_WithAppURL(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	cfg.AppURL = "https://example.com"
	cfg.AppName = "TestBlog"
	svcs := initServices(&cfg, repo)
	// Just ensure setupEcho doesn't panic when AppURL is set.
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", rec.Code)
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// ── parseCreateAPIKeyName ──────────────────────────────────────────────────

func TestParseCreateAPIKeyName(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"flag=value form", []string{"--create-api-key=mykey"}, "mykey"},
		{"flag space value form", []string{"--create-api-key", "mykey"}, "mykey"},
		{"flag space value with surrounding args", []string{"--port=8080", "--create-api-key", "mykey", "--other"}, "mykey"},
		{"flag=value with surrounding args", []string{"--create-api-key=mykey", "--other"}, "mykey"},
		{"no flag returns empty", []string{"--port=8080", "--other"}, ""},
		{"empty args returns empty", []string{}, ""},
		{"flag at end without value", []string{"--create-api-key"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := parseCreateAPIKeyName(tt.args)
			if got != tt.want {
				t.Errorf("parseCreateAPIKeyName(%v) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}
