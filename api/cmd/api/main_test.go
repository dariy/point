package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

	got := resolveJSDir(root, false)
	if got != dirs["js"] {
		t.Errorf("expected js/ bundle dir %q, got %q", dirs["js"], got)
	}
}

func TestResolveJSDir_FallsBackToSrc(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "src")

	got := resolveJSDir(root, false)
	if got != dirs["src"] {
		t.Errorf("expected src/ fallback %q, got %q", dirs["src"], got)
	}
}

func TestResolveJSDir_NeitherExists(t *testing.T) {
	root := t.TempDir()
	// no js/ or src/ created

	got := resolveJSDir(root, false)
	if got != "" {
		t.Errorf("expected empty string when neither dir exists, got %q", got)
	}
}

func TestResolveJSDir_OnlyBundleExists(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js")

	got := resolveJSDir(root, false)
	if got != dirs["js"] {
		t.Errorf("expected js/ dir %q, got %q", dirs["js"], got)
	}
}

func TestResolveJSDir_NonexistentFrontendDir(t *testing.T) {
	got := resolveJSDir("/tmp/does-not-exist-point-test", false)
	if got != "" {
		t.Errorf("expected empty string for missing frontend dir, got %q", got)
	}
}

func TestResolveJSDir_DebugPreferredWhenBuilt(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js", "js-debug")

	got := resolveJSDir(root, true)
	if got != dirs["js-debug"] {
		t.Errorf("expected js-debug/ when debug on, got %q", got)
	}
}

func TestResolveJSDir_DebugFallsBackToReleaseWhenNotBuilt(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js")
	// no js-debug/ built — debug mode must fall back to the release bundle.

	got := resolveJSDir(root, true)
	if got != dirs["js"] {
		t.Errorf("expected js/ fallback when js-debug missing, got %q", got)
	}
}

func TestResolveJSDir_DebugOffIgnoresDebugBundle(t *testing.T) {
	root := t.TempDir()
	dirs := mkdirs(t, root, "js", "js-debug")

	got := resolveJSDir(root, false)
	if got != dirs["js"] {
		t.Errorf("expected js/ when debug off even if js-debug exists, got %q", got)
	}
}

func TestSecurityHeaders(t *testing.T) {
	cfg := config.Config{
		AppVersion:  "1.0.0",
		FrontendDir: t.TempDir(),
	}
	// The script-src policy is computed at startup from index.html's inline
	// <script> blocks (see inlineScriptHashes); give setupEcho a shell with a
	// known inline script and expect its hash in the header.
	inline := "console.log('csp probe');"
	shell := "<html><head><script>" + inline + "</script></head><body></body></html>"
	if err := os.WriteFile(filepath.Join(cfg.FrontendDir, "index.html"), []byte(shell), 0o644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}
	sum := sha256.Sum256([]byte(inline))
	inlineHash := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"

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
		{"Content-Security-Policy", "default-src 'self'; script-src 'self' " + inlineHash + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src 'self' https://*.basemaps.cartocdn.com; frame-ancestors 'none'"},
		{"Referrer-Policy", "strict-origin-when-cross-origin"},
		{"Permissions-Policy", "geolocation=(), microphone=(), camera=()"},
	}

	for _, tt := range tests {
		if got := headers.Get(tt.key); got != tt.value {
			t.Errorf("header %s: expected %q, got %q", tt.key, tt.value, got)
		}
	}
}

// TestDeploymentHeadInjection verifies the deployment-driven head/CSP knobs:
// HEAD_HTML is substituted into the served shell, and CSP_SCRIPT_SRC /
// CSP_CONNECT_SRC extend those directives so an injected external script is
// allowed. All three are empty in the shipped engine.
func TestDeploymentHeadInjection(t *testing.T) {
	cfg := config.Config{
		AppVersion:    "1.0.0",
		FrontendDir:   t.TempDir(),
		HeadHTML:      `<script defer src="https://analytics.example/s.js" data-website-id="abc"></script>`,
		CSPScriptSrc:  "https://analytics.example",
		CSPConnectSrc: "https://analytics.example",
	}
	shell := "<html><head>\n<!-- __HEAD_HTML__ -->\n</head><body></body></html>"
	if err := os.WriteFile(filepath.Join(cfg.FrontendDir, "index.html"), []byte(shell), 0o644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}

	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/some-spa-route", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, cfg.HeadHTML) {
		t.Errorf("served shell missing injected HEAD_HTML; body:\n%s", body)
	}
	if strings.Contains(rec.Body.String(), "__HEAD_HTML__") {
		t.Errorf("HEAD_HTML placeholder was not substituted")
	}
	csp := rec.Header().Get("Content-Security-Policy")
	// The per-request handler prepends the plugin-manifest hash after
	// "script-src", so assert on the directive's tail rather than "script-src 'self'".
	if !strings.Contains(csp, "https://analytics.example; style-src") {
		t.Errorf("script-src missing extra origin; CSP: %q", csp)
	}
	if !strings.Contains(csp, "connect-src 'self' https://*.basemaps.cartocdn.com https://analytics.example") {
		t.Errorf("connect-src missing extra origin; CSP: %q", csp)
	}

	// Admin ("light") routes must NOT carry the injected third-party markup —
	// it never runs in the authenticated context.
	adminReq := httptest.NewRequest(http.MethodGet, "/light/dashboard", nil)
	adminRec := httptest.NewRecorder()
	e.ServeHTTP(adminRec, adminReq)
	if adminRec.Code != http.StatusOK {
		t.Fatalf("admin route: expected 200, got %d", adminRec.Code)
	}
	if strings.Contains(adminRec.Body.String(), "analytics.example") {
		t.Errorf("admin shell must not contain injected HEAD_HTML; body:\n%s", adminRec.Body.String())
	}
	if strings.Contains(adminRec.Body.String(), "__HEAD_HTML__") {
		t.Errorf("admin shell leaked the HEAD_HTML placeholder")
	}
	// The CSP header is global, so admin routes still allow-list the origin
	// (harmless when nothing loads it) — the defense is the absent markup.

	// A logged-in admin viewing a PUBLIC page (admin controls are present there
	// too) must also get the injection-free shell — the session cookie is the
	// signal, so the third-party script never runs in an authenticated DOM.
	authReq := httptest.NewRequest(http.MethodGet, "/some-spa-route", nil)
	authReq.AddCookie(&http.Cookie{Name: "session", Value: "tok"})
	authRec := httptest.NewRecorder()
	e.ServeHTTP(authRec, authReq)
	if authRec.Code != http.StatusOK {
		t.Fatalf("authed public route: expected 200, got %d", authRec.Code)
	}
	if strings.Contains(authRec.Body.String(), "analytics.example") {
		t.Errorf("authenticated viewer must not receive injected HEAD_HTML on a public page")
	}
}

func TestSanitizeCSPSources(t *testing.T) {
	// Normal inputs pass through, whitespace-normalized.
	exact := []struct{ in, want string }{
		{"", ""},
		{"   ", ""},
		{"https://a.example", "https://a.example"},
		{"https://a.example https://b.example", "https://a.example https://b.example"},
		{"  https://a.example   https://b.example  ", "https://a.example https://b.example"},
		{"https://*.cdn.example", "https://*.cdn.example"},
		{"https://a.example;object-src", ""},   // ';'-fused token dropped whole
		{"https://a.example,https://evil", ""}, // ','-fused token dropped whole
	}
	for _, c := range exact {
		if got := sanitizeCSPSources(c.in); got != c.want {
			t.Errorf("sanitizeCSPSources(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// A breakout character (new directive ';', new policy ',', header split
	// CR/LF) must never survive into the output, whatever the arrangement.
	for _, in := range []string{
		"https://a; object-src *",
		"https://a, default-src *",
		"https://a.example\r\nX-Injected: 1",
		"a;b,c\r\nd",
	} {
		if got := sanitizeCSPSources(in); strings.ContainsAny(got, ";,\r\n") {
			t.Errorf("sanitizeCSPSources(%q) = %q still contains a breakout char", in, got)
		}
	}
}

func TestBodyLimitEnforced(t *testing.T) {
	cfg := config.Config{
		AppVersion:      "1.0.0",
		FrontendDir:     t.TempDir(),
		MaxUploadSizeMB: 1,
	}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	// A body over the 1MB limit must be rejected at the middleware layer with
	// 413 before reaching any handler.
	oversized := bytes.Repeat([]byte("a"), 2*1024*1024)
	req := httptest.NewRequest(http.MethodPost, "/api/media/upload", bytes.NewReader(oversized))
	req.Header.Set("Content-Type", "application/octet-stream")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("expected 413 for oversized body, got %d", rec.Code)
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

func newEchoWithRepo(t *testing.T) (repository.Repository, config.Config) {
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

func TestSetupEcho_ManifestNamedAfterHost(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	_ = os.WriteFile(filepath.Join(cfg.FrontendDir, "manifest.webmanifest"),
		[]byte(`{"name":"Point","short_name":"Point","display":"fullscreen"}`), 0644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/manifest.webmanifest", nil)
	req.Host = "www.Point.Photos"
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if m["name"] != "point.photos" || m["short_name"] != "point.photos" {
		t.Errorf("expected name/short_name point.photos, got %v/%v", m["name"], m["short_name"])
	}
	if m["display"] != "fullscreen" {
		t.Errorf("other manifest keys should survive, got display=%v", m["display"])
	}
}

func TestSiteNameFromHost(t *testing.T) {
	cases := map[string]string{
		"darii.net":         "darii.net",
		"point.photos:8001": "point.photos",
		"www.point.photos":  "point.photos",
		"POINT.photos":      "point.photos",
		"localhost:8001":    "localhost",
		"":                  "",
		"  ":                "",
	}
	for host, want := range cases {
		if got := siteNameFromHost(host); got != want {
			t.Errorf("siteNameFromHost(%q) = %q, want %q", host, got, want)
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

func TestSetupEcho_SPAFallback_WithFullPost(t *testing.T) {
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

	// Create media for the post
	_, _ = repo.CreateMedia(ctx, models.CreateMediaParams{
		Filename:     "test.jpg",
		OriginalPath: "originals/2024/01/test.jpg",
		Checksum:     "abc",
		UploadedAt:   time.Now(),
	})

	_, _ = repo.CreatePost(ctx, models.CreatePostParams{
		Title:           "My Post 2",
		Slug:            "my-post-2",
		AuthorID:        u.ID,
		Status:          "published",
		MetaDescription: sql.NullString{String: "My Meta Desc", Valid: true},
		ThumbnailPath:   sql.NullString{String: "thumbnails/2024/01/test_thumb.jpg", Valid: true},
		Content:         "Some content here! /originals/2024/01/test.jpg",
	})

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/posts/my-post-2", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Errorf("expected 200 for SPA post route, got %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "My Meta Desc") {
		t.Errorf("expected meta description in HTML")
	}
	if !strings.Contains(body, "test.jpg") {
		t.Errorf("expected og:image in HTML")
	}
	if !strings.Contains(body, "https://") {
		t.Errorf("expected https in og:url")
	}
}

func TestSetupEcho_FrontendDirs(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	// Create all static dirs
	dirs := []string{"css", "js", "images", "vendor"}
	for _, d := range dirs {
		_ = os.MkdirAll(filepath.Join(cfg.FrontendDir, d), 0755)
	}

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)
	_ = e // Just checking it registers without panic
}

func TestMain_FullRun(t *testing.T) {
	origArgs := os.Args
	defer func() { os.Args = origArgs }()
	os.Args = []string{"point"}

	t.Setenv("DATABASE_URL", ":memory:")
	t.Setenv("PORT", "0")
	t.Setenv("STORAGE_PATH", t.TempDir())
	t.Setenv("FRONTEND_DIR", t.TempDir())
	t.Setenv("GEMINI_API_KEY", "dummy_key")
	t.Setenv("PHOTO_LIBRARY_PATH", "/dummy/path")

	// Run a background goroutine to signal interrupt after startup
	go func() {
		time.Sleep(200 * time.Millisecond)
		proc, err := os.FindProcess(os.Getpid())
		if err == nil {
			_ = proc.Signal(os.Interrupt)
		}
	}()

	// Should start up, block, receive interrupt, and gracefully shut down
	main()
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
