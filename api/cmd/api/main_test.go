package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"io"
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

	"github.com/labstack/echo/v4"
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
		{"Content-Security-Policy", "default-src 'self'; script-src 'self' " + inlineHash + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://server.arcgisonline.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src 'self' https://server.arcgisonline.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"},
		{"Referrer-Policy", "strict-origin-when-cross-origin"},
		{"Permissions-Policy", "geolocation=(), microphone=(), camera=()"},
	}

	for _, tt := range tests {
		if got := headers.Get(tt.key); got != tt.value {
			t.Errorf("header %s: expected %q, got %q", tt.key, tt.value, got)
		}
	}
}

// TestHSTS verifies Strict-Transport-Security is emitted for HTTPS requests
// (here signalled via X-Forwarded-Proto from the reverse proxy) but withheld
// from plain-HTTP requests, so a dev server over http never advertises HSTS.
func TestHSTS(t *testing.T) {
	cfg := config.Config{
		AppVersion:  "1.0.0",
		FrontendDir: t.TempDir(),
	}
	if err := os.WriteFile(filepath.Join(cfg.FrontendDir, "index.html"), []byte("<html></html>"), 0o644); err != nil {
		t.Fatalf("failed to write index.html: %v", err)
	}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatalf("failed to create repo: %v", err)
	}
	defer func() { _ = repo.Close() }()
	e := setupEcho(cfg, repo, initServices(&cfg, repo))

	const want = "max-age=31536000; includeSubdomains"

	httpsReq := httptest.NewRequest(http.MethodGet, "/health", nil)
	httpsReq.Header.Set("X-Forwarded-Proto", "https")
	httpsRec := httptest.NewRecorder()
	e.ServeHTTP(httpsRec, httpsReq)
	if got := httpsRec.Header().Get("Strict-Transport-Security"); got != want {
		t.Errorf("https request HSTS: expected %q, got %q", want, got)
	}

	httpRec := httptest.NewRecorder()
	e.ServeHTTP(httpRec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if got := httpRec.Header().Get("Strict-Transport-Security"); got != "" {
		t.Errorf("http request should not carry HSTS, got %q", got)
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
	seedOwner(t, repo)

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
	if !strings.Contains(csp, "connect-src 'self' https://server.arcgisonline.com https://analytics.example") {
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

// seedOwner marks the install as configured. Without an owner user the SPA
// fallback treats every request as a fresh install and redirects it to /setup,
// so any test asserting on the served shell must seed one first.
func seedOwner(t *testing.T, repo repository.Repository) {
	t.Helper()
	if _, err := repo.CreateUser(context.Background(), models.CreateUserParams{
		Username:     "the_owner",
		Email:        "owner@example.com",
		PasswordHash: "hash",
		DisplayName:  "Owner",
	}); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
}

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

// The credential rate limiter and session audit trail key off c.RealIP().
// setupEcho must install an IPExtractor that only trusts X-Forwarded-For hops
// from our own proxy (loopback/private), so an attacker can't mint a fresh
// bucket per request by rotating the header. See point-sec-ratelimit-xff-bypass.
func TestSetupEcho_RealIPIgnoresSpoofedXFF(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	if e.IPExtractor == nil {
		t.Fatal("setupEcho left IPExtractor nil: RealIP() trusts X-Forwarded-For verbatim")
	}

	// Peer is an untrusted public address: XFF is attacker-controlled and must
	// be ignored entirely — RealIP falls back to the socket remote address.
	directReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	directReq.RemoteAddr = "203.0.113.7:5555"
	directReq.Header.Set(echo.HeaderXForwardedFor, "1.2.3.4")
	if got := e.IPExtractor(directReq); got != "203.0.113.7" {
		t.Errorf("untrusted peer: got RealIP %q, want socket address 203.0.113.7", got)
	}

	// Peer is our trusted proxy (loopback): the real client is the rightmost
	// untrusted XFF entry; a spoofed value prepended by the client is skipped.
	proxiedReq := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
	proxiedReq.RemoteAddr = "127.0.0.1:5555"
	proxiedReq.Header.Set(echo.HeaderXForwardedFor, "9.9.9.9, 203.0.113.7")
	if got := e.IPExtractor(proxiedReq); got != "203.0.113.7" {
		t.Errorf("proxied request: got RealIP %q, want real client 203.0.113.7", got)
	}
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
	req.Host = "www.Example.Com"
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if m["name"] != "example.com" || m["short_name"] != "example.com" {
		t.Errorf("expected name/short_name example.com, got %v/%v", m["name"], m["short_name"])
	}
	if m["display"] != "fullscreen" {
		t.Errorf("other manifest keys should survive, got display=%v", m["display"])
	}
}

func TestSiteNameFromHost(t *testing.T) {
	cases := map[string]string{
		"example.org":      "example.org",
		"example.com:8001": "example.com",
		"www.example.com":  "example.com",
		"EXAMPLE.com":      "example.com",
		"localhost:8001":   "localhost",
		"":                 "",
		"  ":               "",
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
		FileType:     "image",
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
	// og:image points at the 1024 rung, not the original: a full-size camera
	// JPEG is past the size ceiling every social card renderer applies.
	if !strings.Contains(body, `og:image" content="https://example.com/2024/01/test.jpg?s=1024&amp;v=1"`) {
		t.Errorf("expected og:image at the 1024 rung in HTML, got:\n%s", body)
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

// Gzip must be installed for text payloads (the CSS/JS bundles and JSON API
// responses are the bulk of the transfer) and must NOT be applied to already-
// compressed binaries like photos. See point-perf-enable-gzip.
func TestSetupEcho_GzipCompressesCSS(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(cssDir, 0o755)
	// Comfortably over the 1KB MinLength threshold, and highly compressible.
	_ = os.WriteFile(filepath.Join(cssDir, "app.css"), []byte(strings.Repeat("body{color:red}\n", 500)), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	req := httptest.NewRequest(http.MethodGet, "/assets/css/app.css", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("expected gzip Content-Encoding on CSS, got %q", enc)
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	body, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !strings.HasPrefix(string(body), "body{color:red}") {
		t.Errorf("decompressed body does not match source: %.40q", body)
	}
	if rec.Body.Len() >= len(body) {
		t.Errorf("gzip did not shrink the payload: %d compressed vs %d raw", rec.Body.Len(), len(body))
	}
}

func TestSkipGzip(t *testing.T) {
	cases := map[string]bool{
		"/assets/css/light.css":     false,
		"/assets/js/app.js":         false,
		"/api/posts":                false,
		"/2026/07/photo.jpg":        true,
		"/2026/07/photo.JPG":        true,
		"/2026/07/clip.mp4":         true,
		"/assets/vendor/font.woff2": true,
		"/backups/backup.tar.gz":    true,
	}
	e := echo.New()
	for path, want := range cases {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		c := e.NewContext(req, httptest.NewRecorder())
		if got := skipGzip(c); got != want {
			t.Errorf("skipGzip(%q) = %v, want %v", path, got, want)
		}
	}
}

// Content-hashed esbuild chunks are immutable by construction; the unhashed
// entry points must keep revalidating. See point-perf-immutable-cache-headers.
func TestSetupEcho_AssetCacheControl(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	jsDir := filepath.Join(cfg.FrontendDir, "js")
	_ = os.MkdirAll(filepath.Join(jsDir, "chunks"), 0o755)
	_ = os.WriteFile(filepath.Join(jsDir, "app.js"), []byte("//app"), 0o644)
	_ = os.WriteFile(filepath.Join(jsDir, "chunks", "chunk-26AYO3DK.js"), []byte("//chunk"), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	for path, want := range map[string]string{
		"/assets/js/chunks/chunk-26AYO3DK.js": immutableCacheControl,
		"/assets/js/app.js":                   "no-cache",
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if cc := rec.Header().Get("Cache-Control"); cc != want {
			t.Errorf("%s: expected Cache-Control %q, got %q", path, want, cc)
		}
	}
}

// The public read surface had no rate limit at all — only the auth endpoints
// were throttled. See point-sec-public-ratelimit.
func TestSetupEcho_PublicRateLimit(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	// The burst is 200, so a run well past it must start getting 429s.
	var limited bool
	for i := 0; i < 260; i++ {
		req := httptest.NewRequest(http.MethodGet, "/api/pages/home", nil)
		req.RemoteAddr = "203.0.113.9:5555"
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			limited = true
			break
		}
	}
	if !limited {
		t.Error("public API is not rate limited")
	}

	// A different client IP has its own bucket — one scraper must not lock
	// everyone else out.
	req := httptest.NewRequest(http.MethodGet, "/api/pages/home", nil)
	req.RemoteAddr = "203.0.113.10:5555"
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	if rec.Code == http.StatusTooManyRequests {
		t.Error("rate limiter is not keyed per client IP")
	}
}

// Static assets are skipped: a first page load pulls dozens of them and would
// otherwise spend the budget the API calls need.
func TestSetupEcho_RateLimitSkipsAssets(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(cssDir, 0o755)
	_ = os.WriteFile(filepath.Join(cssDir, "app.css"), []byte("body{}"), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	for i := 0; i < 300; i++ {
		req := httptest.NewRequest(http.MethodGet, "/assets/css/app.css", nil)
		req.RemoteAddr = "203.0.113.11:5555"
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		if rec.Code == http.StatusTooManyRequests {
			t.Fatalf("static assets got rate limited at request %d", i)
		}
	}
}

func TestStripCSSBundleHash(t *testing.T) {
	for name, want := range map[string]struct {
		base   string
		hashed bool
	}{
		"light.81e2e81c.css":  {"light.css", true},
		"main.14ed7c52.css":   {"main.css", true},
		"light.css":           {"light.css", false},
		"light.81E2E81C.css":  {"light.81E2E81C.css", false}, // uppercase is not our format
		"light.81e2e81.css":   {"light.81e2e81.css", false},  // 7 chars
		"light.81e2e81cc.css": {"light.81e2e81cc.css", false},
		"asset-manifest.json": {"asset-manifest.json", false},
	} {
		base, hashed := stripCSSBundleHash(name)
		if base != want.base || hashed != want.hashed {
			t.Errorf("stripCSSBundleHash(%q) = %q, %v; want %q, %v", name, base, hashed, want.base, want.hashed)
		}
	}
}

// A content-addressed CSS URL is cacheable forever, but only when its hash
// matches what is on disk — otherwise a client on a stale HTML shell would pin
// today's bytes under yesterday's URL for a year.
// See point-css-esbuild-pipeline.
func TestSetupEcho_HashedCSSBundle(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(cssDir, 0o755)
	body := []byte("body{color:red}")
	_ = os.WriteFile(filepath.Join(cssDir, "light.css"), body, 0o644)
	_ = os.WriteFile(filepath.Join(cssDir, "asset-manifest.json"),
		[]byte(`{"light.css":"81e2e81c"}`), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	// Matching hash: served, immutable.
	rec := get("/assets/css/light.81e2e81c.css")
	if rec.Code != http.StatusOK {
		t.Fatalf("hashed URL status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != string(body) {
		t.Errorf("hashed URL served %q, want %q", rec.Body.String(), body)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != immutableCacheControl {
		t.Errorf("hashed URL Cache-Control = %q, want %q", cc, immutableCacheControl)
	}

	// Stale hash: still served (a page with no stylesheet is worse), but must
	// not be cached under that URL.
	rec = get("/assets/css/light.deadbeef.css")
	if rec.Code != http.StatusOK {
		t.Fatalf("stale-hash URL status = %d, want 200", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("stale-hash URL Cache-Control = %q, want no-cache", cc)
	}

	// Plain name keeps revalidating.
	rec = get("/assets/css/light.css")
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("plain URL Cache-Control = %q, want no-cache", cc)
	}
}

// Hashed-bundle resolution must not cost us the rest of the /assets/css tree.
// A `/assets/css/:name` route claimed the whole subtree from e.Static and
// flattened multi-segment paths through filepath.Base, which 404'd every
// partial under a subdirectory — including common/theme.css, the file the
// theme service rewrites at runtime, so every light/dark theme lost its
// tokens — while happily serving a bundle under any made-up prefix.
func TestSetupEcho_CSSSubdirectoriesStillServed(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(filepath.Join(cssDir, "common"), 0o755)
	theme := []byte(":root{--bg-primary:#fff}")
	_ = os.WriteFile(filepath.Join(cssDir, "common", "theme.css"), theme, 0o644)
	_ = os.WriteFile(filepath.Join(cssDir, "light.css"), []byte("body{color:red}"), 0o644)
	_ = os.WriteFile(filepath.Join(cssDir, "asset-manifest.json"),
		[]byte(`{"light.css":"81e2e81c"}`), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	// The active theme is the whole point: it must be served, with its bytes.
	rec := get("/assets/css/common/theme.css")
	if rec.Code != http.StatusOK {
		t.Fatalf("common/theme.css status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != string(theme) {
		t.Errorf("common/theme.css served %q, want %q", rec.Body.String(), theme)
	}
	// It changes at runtime under a fixed URL, so it must never go immutable.
	if cc := rec.Header().Get("Cache-Control"); cc != "no-cache" {
		t.Errorf("common/theme.css Cache-Control = %q, want no-cache", cc)
	}

	// A subdirectory path must resolve within that subdirectory, not collapse
	// to its last segment and pick up a same-named bundle from the top level.
	if rec := get("/assets/css/common/light.css"); rec.Code != http.StatusNotFound {
		t.Errorf("common/light.css status = %d, want 404 (must not alias the bundle)", rec.Code)
	}
	if rec := get("/assets/css/does/not/exist/light.css"); rec.Code != http.StatusNotFound {
		t.Errorf("bogus-prefix light.css status = %d, want 404", rec.Code)
	}

	// A hash is only ours at the top level; deeper it is part of a real name.
	if rec := get("/assets/css/common/theme.81e2e81c.css"); rec.Code != http.StatusNotFound {
		t.Errorf("hashed subdirectory path status = %d, want 404", rec.Code)
	}
}

// Without a manifest the shell must still ship working stylesheet links.
func TestSetupEcho_NoCSSManifestFallsBackToVersionedURLs(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	seedOwner(t, repo)
	cssDir := filepath.Join(cfg.FrontendDir, "css")
	_ = os.MkdirAll(cssDir, 0o755)
	_ = os.WriteFile(filepath.Join(cssDir, "light.css"), []byte("body{}"), 0o644)
	_ = os.WriteFile(filepath.Join(cfg.FrontendDir, "index.html"),
		[]byte(`<html><head><link href="/assets/css/light.css?v=__BUILD_VERSION__"></head><body></body></html>`), 0o644)

	svcs := initServices(&cfg, repo)
	e := setupEcho(cfg, repo, svcs)

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if !strings.Contains(rec.Body.String(), "/assets/css/light.css?v="+cfg.AppVersion) {
		t.Errorf("shell lost its stylesheet link without a manifest:\n%s", rec.Body.String())
	}
}

// A fresh install (no owner user) must send every document request to the
// first-run wizard, not just the admin section — "/" included. The redirect is
// also uncacheable, or a CDN could keep bouncing visitors to /setup after the
// blog has been configured.
func TestSetupEcho_FreshInstallRedirectsToSetup(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	if err := os.WriteFile(filepath.Join(cfg.FrontendDir, "index.html"),
		[]byte("<html><head></head><body></body></html>"), 0o644); err != nil {
		t.Fatalf("write index.html: %v", err)
	}
	e := setupEcho(cfg, repo, initServices(&cfg, repo))

	get := func(path string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		return rec
	}

	for _, p := range []string{"/", "/posts/hello", "/tags", "/light", "/light/posts"} {
		rec := get(p)
		if rec.Code != http.StatusFound {
			t.Errorf("GET %s on a fresh install = %d, want 302", p, rec.Code)
			continue
		}
		if loc := rec.Header().Get("Location"); loc != "/setup" {
			t.Errorf("GET %s redirected to %q, want /setup", p, loc)
		}
		if cc := rec.Header().Get("Cache-Control"); cc != "private, no-store" {
			t.Errorf("GET %s redirect Cache-Control = %q, want private, no-store", p, cc)
		}
	}

	// /setup itself must serve, or the redirect would loop.
	if rec := get("/setup"); rec.Code != http.StatusOK {
		t.Errorf("GET /setup on a fresh install = %d, want 200", rec.Code)
	}

	// The settings an unconfigured install returns are empty and stop being true
	// the moment the wizard finishes. Caching them for 60s (what visibilityCache
	// stamps on a guest GET) leaves the browser replaying the empty payload to
	// the admin right after setup — no blog title, wrong theme.
	if rec := get("/api/settings/public"); rec.Header().Get("Cache-Control") != "private, no-store" {
		t.Errorf("pre-setup /api/settings/public Cache-Control = %q, want private, no-store",
			rec.Header().Get("Cache-Control"))
	}

	// Once an owner exists the redirect stops and the shell serves again — the
	// gate re-queries until it first sees a user, so no restart is needed.
	seedOwner(t, repo)
	for _, p := range []string{"/", "/light"} {
		if rec := get(p); rec.Code != http.StatusOK {
			t.Errorf("GET %s after setup = %d, want 200", p, rec.Code)
		}
	}

	// ...and a configured install goes back to being edge-cacheable.
	if rec := get("/api/settings/public"); rec.Header().Get("Cache-Control") != "public, max-age=60" {
		t.Errorf("post-setup /api/settings/public Cache-Control = %q, want public, max-age=60",
			rec.Header().Get("Cache-Control"))
	}
}

// The health endpoint must be registered and behind auth — it reports internal
// job state and error strings. See point-system-health-admin.
func TestSetupEcho_HealthEndpointIsAuthed(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	if svcs.Health == nil {
		t.Fatal("initServices did not create a health registry")
	}
	e := setupEcho(cfg, repo, svcs)

	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/system/health", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unauthenticated /api/system/health = %d, want 401", rec.Code)
	}
}

// The registry initServices builds must be the one the scheduler and the post
// service record into — otherwise the endpoint reports an empty list forever.
func TestInitServices_HealthRegistryIsShared(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)

	// Drive a task through the scheduler's choke point and confirm it lands in
	// the registry the handler was given.
	svcs.Scheduler.RunTaskForTest(context.Background(), "probe", func(context.Context) error { return nil })
	snap := svcs.Health.Snapshot()
	if len(snap) != 1 || snap[0].Name != "probe" {
		t.Fatalf("scheduler outcomes did not reach the shared registry: %+v", snap)
	}
}
