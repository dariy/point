package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/mcp"
	"point-api/internal/plugins"
	"point-api/internal/repository"
	"point-api/internal/services"
	"point-api/internal/utils"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

// Version is set at build time via -ldflags="-X main.Version=..."
var Version = "dev"

func init() {
	if Version == "dev" {
		Version = "dev-" + time.Now().Format("20060102-150405")
	}
}

// resolveJSDir returns the directory to serve under /assets/js.
// It prefers the pre-built bundle directory (frontend/js/) over the raw
// source directory (frontend/src/), enabling zero-config dev/prod switching.
// pluginManifestScript renders the enabled-only plugin manifest as an inline
// <script> assigning window.__PLUGINS__. The manifest is computed per request
// because enabled-state can change at runtime; chunks is the static build map.
// json.Marshal HTML-escapes <, > and & by default, so the payload is safe to
// embed inline. Disabled plugins are absent from the result entirely.
func pluginManifestScript(ctx context.Context, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) (string, string) {
	// Snapshot, not GetAllSettings: this runs on every HTML serve and
	// BuildManifest only reads the map.
	all, err := settings.Snapshot(ctx)
	if err != nil {
		all = map[string]string{}
	}
	b, err := json.Marshal(plugins.BuildManifest(all, chunks, cssMap))
	if err != nil {
		b = []byte("[]")
	}
	scriptContent := "window.__PLUGINS__=" + string(b) + ";"
	hash := sha256.Sum256([]byte(scriptContent))
	hashBase64 := base64.StdEncoding.EncodeToString(hash[:])
	return "\n  <script>" + scriptContent + "</script>", hashBase64
}

// isAdminPath reports whether p is served by the admin ("light") SPA section.
// Mirrors the section switch in index.html's inline bootstrap so the two agree
// on what counts as admin.
func isAdminPath(p string) bool {
	return strings.HasPrefix(p, "/light") || p == "/setup"
}

// newSetupGate returns a predicate reporting whether the install has an owner
// user yet, i.e. whether first-run setup has been completed. Setup runs once and
// never reverts, so the answer is latched the first time it comes back true and
// the query only costs anything while the install is still unconfigured.
func newSetupGate(repo repository.Repository) func(context.Context) bool {
	var complete atomic.Bool
	return func(ctx context.Context) bool {
		if complete.Load() {
			return true
		}
		if _, err := repo.GetFirstUser(ctx); err == nil {
			complete.Store(true)
			return true
		}
		return false
	}
}

// noStoreBeforeSetup keeps the responses of an unconfigured install out of
// caches. Listed AFTER visibilityCache on a route so it overrides the
// `public, max-age=60` a guest GET is stamped with: everything a fresh install
// returns is empty, and it stops being true the instant the wizard finishes.
// The settings payload is the one that bites — the wizard's own page load puts
// the empty version in the browser cache, and the admin, loading seconds later,
// reads it back with no blog title and the wrong theme.
func noStoreBeforeSetup(setupComplete func(context.Context) bool) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			if !setupComplete(c.Request().Context()) {
				c.Response().Header().Set("Cache-Control", "private, no-store")
			}
			return next(c)
		}
	}
}

// hasSession reports whether the request carries a non-empty session cookie —
// i.e. the viewer is (or claims to be) logged in. Used to keep deployment-
// injected third-party markup out of any authenticated DOM. It only checks for
// the cookie's presence, not validity: a stale cookie merely costs one visitor
// their analytics ping, never a security regression, and it avoids a DB lookup
// on every HTML page load.
func hasSession(c echo.Context) bool {
	ck, err := c.Cookie("session")
	return err == nil && ck.Value != ""
}

// isGuestRequest reports whether a request is an anonymous public reader: no
// session cookie, no Bearer API key, and not an admin path. Such a response is
// identical for every anonymous visitor, so it is safe to share at a CDN edge.
// It mirrors the guest test serveSimplifiedMedia already uses for media
// (isAuthenticated := c.Get("user") != nil), but reads the request directly so
// it does not depend on auth middleware having run first.
func isGuestRequest(c echo.Context) bool {
	if hasSession(c) {
		return false
	}
	if h := c.Request().Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return false
	}
	return !isAdminPath(c.Request().URL.Path)
}

// visibilityCache emits a visibility-aware Cache-Control on a public read route
// so a Cloudflare Cache Rule can edge-cache the anonymous response while never
// storing an authenticated one — the HTML/API analogue of serveSimplifiedMedia's
// media caching, for surviving a traffic spike behind a CDN. A guest GET
// gets `public, max-age=60`; everything else (authenticated reads, any write)
// gets private,no-store so a per-user response is never stored at the edge even
// if the CF rule misfires. The header is set before the handler runs because
// Echo flushes headers on first write; handlers that set their own Cache-Control
// (media) still win by overwriting it.
//
// Why plain max-age=60 and not `s-maxage=60, max-age=0` (edge caches, browser
// revalidates): Cloudflare Cache Rules treat max-age=0 as non-cacheable even
// when s-maxage is also present (Origin Cache Control is always on for
// Free/Pro/Business and cannot be disabled), so that header yields
// CF-Cache-Status: DYNAMIC and never caches — verified empirically against both
// bypass_by_default and respect_origin. The browser-revalidation half is instead
// handled at the edge: the CF Cache Rule sets Browser TTL = 0 (override_origin),
// which also stops the zone's 4 h default Browser Cache TTL from leaking a long
// max-age downstream. So the origin just advertises the 60 s edge TTL here.
func visibilityCache(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if c.Request().Method == http.MethodGet && isGuestRequest(c) {
			c.Response().Header().Set("Cache-Control", "public, max-age=60")
			// Cloudflare treats any response whose Vary lists a value other than
			// Accept-Encoding as uncacheable. The global CORS middleware adds
			// `Vary: Origin`, but a guest public read does not vary by Origin
			// (ACAO is a constant `*`, no credentialed CORS), so Origin in Vary
			// only defeats edge caching — strip it while keeping Accept-Encoding.
			stripVaryOrigin(c.Response().Header())
		} else {
			c.Response().Header().Set("Cache-Control", "private, no-store")
		}
		return next(c)
	}
}

// stripVaryOrigin removes the Origin token from the Vary header, preserving any
// other tokens (notably Accept-Encoding). CORS (main.go's global middleware)
// runs outside this route-level middleware, so `Vary: Origin` is already set by
// the time visibilityCache runs and can be rewritten here.
func stripVaryOrigin(h http.Header) {
	vals := h.Values("Vary")
	if len(vals) == 0 {
		return
	}
	var kept []string
	for _, v := range vals {
		for _, tok := range strings.Split(v, ",") {
			t := strings.TrimSpace(tok)
			if t == "" || strings.EqualFold(t, "Origin") {
				continue
			}
			kept = append(kept, t)
		}
	}
	h.Del("Vary")
	for _, k := range kept {
		h.Add("Vary", k)
	}
}

// sanitizeCSPSources normalizes an operator-supplied CSP source list (the
// CSP_SCRIPT_SRC / CSP_CONNECT_SRC deploy config) into a safe space-separated
// token list before it is appended to a directive. It splits on whitespace and
// drops any token carrying a character that could break out of the directive:
// ';' would start a new directive, ',' a second policy, and CR/LF could split
// the header. Trusted config, but validated as defense-in-depth.
func sanitizeCSPSources(s string) string {
	var out []string
	for _, tok := range strings.Fields(s) {
		if strings.ContainsAny(tok, ";,\r\n") {
			continue
		}
		out = append(out, tok)
	}
	return strings.Join(out, " ")
}

// inlineScriptRe matches attribute-less inline <script> blocks in index.html.
// Scripts with attributes (src=, type=module) load external files and are
// covered by CSP 'self'.
var inlineScriptRe = regexp.MustCompile(`(?s)<script>(.*?)</script>`)

// inlineScriptHashes returns CSP 'sha256-…' source tokens for every inline
// <script> in the file, so the script-src policy always matches the shell that
// is actually served — no hardcoded hash to keep in sync with index.html by
// hand. Computed once at startup: index.html only changes at build/deploy time
// (the __BUILD_VERSION__ stamp rewrites URLs, not inline script bodies).
func inlineScriptHashes(path string) []string {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range inlineScriptRe.FindAllSubmatch(b, -1) {
		h := sha256.Sum256(m[1])
		out = append(out, "'sha256-"+base64.StdEncoding.EncodeToString(h[:])+"'")
	}
	return out
}

// precompressedExt lists the file extensions whose payloads are already
// compressed (photos, video, audio, modern web fonts, archives). Running them
// through gzip burns CPU on every byte served for a saving of roughly nothing,
// so the Gzip middleware skips them. Keyed by lowercase extension with the dot.
var precompressedExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".avif": true, ".heic": true, ".heif": true, ".ico": true,
	".mp4": true, ".mov": true, ".webm": true, ".m4v": true,
	".mp3": true, ".m4a": true, ".ogg": true,
	".woff": true, ".woff2": true,
	".zip": true, ".gz": true, ".tgz": true, ".br": true, ".7z": true,
}

// skipGzip reports whether the response for this request should be left
// uncompressed. Decided from the request path's extension because it is known
// before the handler runs: media is served from /:year/:month/:filename and
// backups from archive-named routes, both of which keep their real extension.
func skipGzip(c echo.Context) bool {
	return precompressedExt[strings.ToLower(filepath.Ext(c.Request().URL.Path))]
}

func resolveJSDir(frontendDir string, debug bool) string {
	// When FRONTEND_DEBUG is on, prefer the debug bundle (frontend/js-debug) if
	// it was built — it carries plugin/console debug logging. Falls through to
	// the normal resolution otherwise, so a missing debug bundle is harmless.
	if debug {
		debugDir := filepath.Join(frontendDir, "js-debug")
		if fi, err := os.Stat(debugDir); err == nil && fi.IsDir() {
			return debugDir
		}
	}
	jsDir := filepath.Join(frontendDir, "js")
	if _, err := os.Stat(jsDir); err == nil {
		return jsDir
	}
	srcDir := filepath.Join(frontendDir, "src")
	if fi, err := os.Stat(srcDir); err == nil && fi.IsDir() {
		return srcDir
	}
	return ""
}

// siteNameFromHost turns a request Host into the name an installed PWA shows
// under its icon: "www.Example.Com:8001" → "example.com". Returns "" when the
// host is unusable, in which case the manifest's own name is kept.
func siteNameFromHost(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	if hostOnly, _, err := net.SplitHostPort(h); err == nil {
		h = hostOnly
	}
	h = strings.Trim(h, ".")
	h = strings.TrimPrefix(h, "www.")
	if h == "" || strings.ContainsAny(h, "/ ") {
		return ""
	}
	return h
}

type AppServices struct {
	Settings    *services.SettingsService
	Auth        *services.AuthService
	ApiKey      *services.ApiKeyService
	Tag         *services.TagService
	Post        *services.PostService
	Media       *services.MediaService
	System      *services.SystemService
	Cache       *services.CacheService
	Scheduler   *services.SchedulerService
	Health      *services.HealthRegistry
	Theme       *services.ThemeService
	Timeline    *services.TimelineService
	Instagram   *services.InstagramService
	S3Presigner *services.S3Presigner
}

func initServices(cfg *config.Config, repo repository.Repository) *AppServices {
	settingsService := services.NewSettingsService(repo)
	authService := services.NewAuthService(repo)
	apiKeyService := services.NewApiKeyService(repo)
	tagService := services.NewTagService(repo)
	instagramService := services.NewInstagramService(settingsService)
	// One registry, shared by everything that runs work outside a request, so
	// the admin health view has a single source rather than one per service.
	healthRegistry := services.NewHealthRegistry()
	postService := services.NewPostService(repo, settingsService, instagramService, tagService, cfg.AppURL).WithHealth(healthRegistry)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	systemService := services.NewSystemService(repo, cfg.StoragePath, cfg.DatabaseURL)
	// Drop any half-written backup left by a process that was interrupted mid-backup.
	systemService.CleanupPartialBackups()
	cacheService := services.NewCacheService(cfg.StoragePath)
	themeService := services.NewThemeService(cfg, settingsService)
	timelineService := services.NewTimelineService(repo)
	schedulerService := services.NewSchedulerService(authService, postService, systemService, mediaService, settingsService, instagramService).WithHealth(healthRegistry)

	s3Presigner, err := services.NewS3Presigner(
		os.Getenv("S3_ENDPOINT"),
		os.Getenv("S3_REGION"),
		os.Getenv("S3_ACCESS_KEY_ID"),
		os.Getenv("S3_SECRET_ACCESS_KEY"),
		os.Getenv("S3_BUCKET"),
	)
	if err != nil {
		log.Printf("Warning: failed to initialize S3 presigner: %v", err)
	}

	return &AppServices{
		Settings:    settingsService,
		Auth:        authService,
		ApiKey:      apiKeyService,
		Tag:         tagService,
		Post:        postService,
		Media:       mediaService,
		System:      systemService,
		Cache:       cacheService,
		Scheduler:   schedulerService,
		Health:      healthRegistry,
		Theme:       themeService,
		Timeline:    timelineService,
		Instagram:   instagramService,
		S3Presigner: s3Presigner,
	}
}

func setupEcho(cfg config.Config, repo repository.Repository, svcs *AppServices) *echo.Echo {
	// Initialize Echo

	e := echo.New()
	e.HideBanner = true

	// Derive the client IP by walking X-Forwarded-For from the right and
	// skipping only trusted hops (loopback + private networks — i.e. our own
	// reverse proxy). This returns the real client address and ignores any
	// XFF entries an attacker prepends, so c.RealIP() can't be spoofed to
	// dodge the credential rate limiter or poison the session audit trail.
	// Direct (no-proxy) connections fall back to the socket remote address.
	e.IPExtractor = echo.ExtractIPFromXFFHeader(
		echo.TrustLoopback(true),
		echo.TrustPrivateNet(true),
	)

	// Redirect HTTP to HTTPS if AppURL is configured as HTTPS.
	if strings.HasPrefix(cfg.AppURL, "https://") {
		e.Pre(middleware.HTTPSRedirect())
	}

	e.HTTPErrorHandler = api.CustomHTTPErrorHandler

	// Handlers
	authHandler := api.NewAuthHandler(svcs.Auth, &cfg, repo)
	apiKeyHandler := api.NewApiKeyHandler(svcs.ApiKey)
	tagHandler := api.NewTagHandler(svcs.Tag, svcs.Settings)
	postHandler := api.NewPostHandler(svcs.Post, svcs.Settings, svcs.Media, svcs.Tag)
	mediaHandler := api.NewMediaHandler(svcs.Media, svcs.Settings)
	remarkSupervisor := services.NewRemarkSupervisor(svcs.Settings, repo).WithHealth(svcs.Health)
	go remarkSupervisor.Start()

	settingsHandler := api.NewSettingsHandler(svcs.Settings, remarkSupervisor)
	pluginsHandler := api.NewPluginsHandler(svcs.Settings)
	themeHandler := api.NewThemeHandler(svcs.Theme)
	systemHandler := api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, svcs.Auth, cfg.StoragePath, cfg.AppVersion).WithHealth(svcs.Health).WithStorageQuotaMB(cfg.StorageQuotaMB)
	feedsHandler := api.NewFeedsHandler(repo, svcs.Post, svcs.Tag, svcs.Settings, svcs.Cache)
	pagesHandler := api.NewPagesHandler(repo, svcs.Post, svcs.Tag, svcs.Media, svcs.Settings, svcs.Cache)
	timelineHandler := api.NewTimelineHandler(svcs.Timeline, svcs.Settings)
	setupHandler := api.NewSetupHandler(svcs.Auth, svcs.Settings, repo, &cfg)
	navMenuHandler := api.NewNavMenuHandler(svcs.Settings, svcs.Tag)
	instagramImportService := services.NewInstagramImportService(svcs.Instagram, svcs.Media, svcs.Post)
	instagramHandler := api.NewInstagramHandler(svcs.Instagram, instagramImportService, svcs.Settings, &cfg)

	// WebAuthn handler — nil service if AppURL is not configured (passkeys require HTTPS + known origin)
	var webauthnSvc *services.WebAuthnService
	if cfg.AppURL != "" {
		origin := services.SanitizeOrigin(cfg.AppURL)
		rpID := services.GetRPIDFromURL(cfg.AppURL)
		if origin != "" && rpID != "" {
			var waErr error
			webauthnSvc, waErr = services.NewWebAuthnService(repo, rpID, cfg.AppName, origin)
			if waErr != nil {
				slog.Warn("WebAuthn service init failed", "error", waErr)
			}
		}
	}
	webAuthnHandler := api.NewWebAuthnHandler(webauthnSvc, svcs.Auth, &cfg, repo)

	// Global middleware
	e.Use(middleware.RequestLoggerWithConfig(middleware.RequestLoggerConfig{
		LogStatus:   true,
		LogURI:      true,
		LogMethod:   true,
		LogLatency:  true,
		LogError:    true,
		LogRemoteIP: true,
		LogValuesFunc: func(c echo.Context, v middleware.RequestLoggerValues) error {
			if v.Error != nil {
				slog.Error("request error",
					"method", v.Method,
					"uri", v.URI,
					"status", v.Status,
					"remote_ip", v.RemoteIP,
					"latency", v.Latency,
					"err", v.Error,
				)
			} else {
				slog.Info("request",
					"method", v.Method,
					"uri", v.URI,
					"status", v.Status,
					"remote_ip", v.RemoteIP,
					"latency", v.Latency,
				)
			}
			return nil
		},
	}))
	e.Use(middleware.Recover())
	// Compress text payloads: the CSS/JS bundles and every JSON API response
	// gzip to roughly a quarter of their size. Sits high in the chain so it
	// wraps the static file routes as well as the handlers. Responses under
	// 1KB are left alone — the gzip framing overhead can exceed the saving.
	e.Use(middleware.GzipWithConfig(middleware.GzipConfig{
		Skipper:   skipGzip,
		MinLength: 1024,
	}))
	// Cap request bodies at the configured upload limit (default 50MB). This is
	// the ceiling for the largest legitimate request (a media upload); every
	// other endpoint is smaller. Echo enforces it both via Content-Length and
	// while streaming the body, returning 413 when exceeded — so a client can't
	// exhaust memory by lying about Content-Length.
	uploadLimitMB := cfg.MaxUploadSizeMB
	if uploadLimitMB <= 0 {
		uploadLimitMB = 50
	}
	e.Use(middleware.BodyLimitWithConfig(middleware.BodyLimitConfig{
		// The "move in" archive upload streams a multi-GB body straight to a temp
		// file; the global limit would abort it. It's gated by a session cookie
		// plus password re-entry instead of a size ceiling.
		Skipper: func(c echo.Context) bool {
			return c.Request().Method == http.MethodPost && c.Path() == "/api/system/backups/upload"
		},
		Limit: fmt.Sprintf("%dM", uploadLimitMB),
	}))
	// Wildcard origin for the public read API. AllowCredentials is deliberately
	// omitted: browsers reject `Access-Control-Allow-Origin: *` together with
	// credentials, and the admin SPA is same-origin (served by this server), so
	// cookie auth never needs a cross-origin credentialed CORS grant. Bearer
	// (API-key) auth is unaffected.
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"*"},
	}))
	// script-src allows the shell's inline <script> blocks by hash, computed
	// from index.html at startup (see inlineScriptHashes) so an edit to the
	// inline bootstrap script can never silently break CSP. The per-request
	// __PLUGINS__ manifest hash is appended where index.html is served.
	scriptSrc := strings.Join(append([]string{"'self'"}, inlineScriptHashes(filepath.Join(cfg.FrontendDir, "index.html"))...), " ")
	connectSrc := "'self' https://*.basemaps.cartocdn.com"
	// Deployment-supplied extra CSP origins. They let an operator allow-list a
	// script injected via HEAD_HTML (analytics, verification, …) without the
	// open-source engine hardcoding any third-party domain. Empty by default, so
	// the shipped policy is unchanged unless a deployment opts in.
	if extra := sanitizeCSPSources(cfg.CSPScriptSrc); extra != "" {
		scriptSrc += " " + extra
	}
	if extra := sanitizeCSPSources(cfg.CSPConnectSrc); extra != "" {
		connectSrc += " " + extra
	}
	e.Use(middleware.SecureWithConfig(middleware.SecureConfig{
		XSSProtection:      "1; mode=block",
		ContentTypeNosniff: "nosniff",
		XFrameOptions:      "DENY",
		// base-uri and form-action have no default-src fallback, so leaving them
		// out means "anything goes": an injected <base> could repoint every
		// relative script/form URL at an attacker origin, and an injected form
		// could post credentials off-site. Both are 'self' — every form in the
		// frontend targets a same-origin path (/search), and nothing sets <base>.
		// object-src does fall back to default-src, but 'none' is stated outright
		// so the plugin surface stays closed even if default-src is ever widened;
		// no <object>/<embed>/<applet> exists in the frontend.
		ContentSecurityPolicy: "default-src 'self'; script-src " + scriptSrc + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src " + connectSrc + "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
		ReferrerPolicy:        "strict-origin-when-cross-origin",
		// HSTS: instruct browsers to only reach this origin over HTTPS for a year,
		// including subdomains. Echo only emits the header when the request is
		// actually over TLS (direct or via X-Forwarded-Proto: https), so a plain
		// HTTP dev server never sends it. Preload is deliberately left off — it's
		// an effectively irreversible browser-baked commitment that an operator
		// should opt into for their own domain, not a shipped default.
		HSTSMaxAge: 31536000,
	}))
	// Extra security headers not covered by middleware.Secure
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
			return next(c)
		}
	})
	// Prevent Safari on iOS from serving stale JS/CSS after a redeploy — except
	// for the esbuild code-split chunks under /assets/js/chunks/, whose names
	// embed a content hash and so can never change meaning at a fixed URL.
	// Those get the immutable treatment, as do content-addressed CSS bundle
	// URLs whose hash matches what is currently on disk. The unhashed entry
	// points — app.js, the p/* plugin bundles, and a CSS bundle requested under
	// its plain name — keep revalidating.
	//
	// A hash that does NOT match (a client on a cached HTML shell from before a
	// deploy) is still served the current bundle, because 404ing it would leave
	// that page with no stylesheet at all — but it is served no-cache, so the
	// client never pins today's bytes under yesterday's URL for a year.
	//
	// This also rewrites a content-addressed bundle URL back to the plain
	// on-disk name, and so runs as Pre — before routing — rather than as a
	// route of its own. A `/assets/css/:name` route would claim the whole
	// /assets/css/ subtree from e.Static and take the files in it down with
	// it, including the runtime-generated common/theme.css.
	cssManifest := loadCSSManifest(filepath.Join(cfg.FrontendDir, "css"))
	e.Pre(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			r := c.Request()
			p := r.URL.Path
			switch {
			case strings.HasPrefix(p, "/assets/js/chunks/"):
				c.Response().Header().Set("Cache-Control", immutableCacheControl)
			case strings.HasPrefix(p, "/assets/css/"):
				c.Response().Header().Set("Cache-Control", "no-cache")
				// Only bundles sit directly in /assets/css; a hash anywhere
				// deeper is part of some partial's real filename, not ours.
				if path.Dir(p) != "/assets/css" {
					break
				}
				if base, hashed := stripCSSBundleHash(path.Base(p)); hashed {
					if cssManifest[base] == path.Base(p) {
						c.Response().Header().Set("Cache-Control", immutableCacheControl)
					}
					r.URL.Path = "/assets/css/" + base
				}
			case strings.HasPrefix(p, "/assets/js/"):
				c.Response().Header().Set("Cache-Control", "no-cache")
			}
			return next(c)
		}
	})

	// Load index.html once and substitute the build version here, at serve
	// time, instead of mutating the file on disk (the old sed/skip-worktree
	// dance in run.sh + Dockerfile). indexHTML stays on disk pristine with the
	// literal __BUILD_VERSION__ placeholder and is a normally tracked file.
	// Empty when the frontend isn't built — the SPA routes fall back to a 503.
	indexHTML := filepath.Join(cfg.FrontendDir, "index.html")
	// Two shells are built: the public one carries the deployment-supplied
	// <head> markup (analytics/verification tags); the admin one omits it, so the
	// injected third-party script never loads in the authenticated /light context
	// — a smaller XSS blast radius, and it keeps admin traffic out of analytics.
	indexHTMLContent := ""
	indexHTMLAdmin := ""
	if b, err := os.ReadFile(indexHTML); err == nil {
		base := strings.ReplaceAll(string(b), "__BUILD_VERSION__", cfg.AppVersion)
		// Rewrite the CSS bundle links to their content-addressed URLs so an
		// unchanged bundle keeps the same URL across deploys and can be cached
		// forever. Without a manifest the ?v=<build version> links stay, which
		// still busts correctly on deploy — just on every deploy.
		for name, hashed := range cssManifest {
			base = strings.ReplaceAll(base,
				"/assets/css/"+name+"?v="+cfg.AppVersion,
				"/assets/css/"+hashed)
		}
		// Public shell. Note: an inline <script> injected via HEAD_HTML is NOT
		// covered by the CSP script-src hashes (those are computed from the
		// on-disk shell), so deployments should inject external scripts and
		// allow-list their origin via CSP_SCRIPT_SRC.
		indexHTMLContent = strings.Replace(base, "<!-- __HEAD_HTML__ -->", cfg.HeadHTML, 1)
		// Admin shell — placeholder dropped, no third-party markup.
		indexHTMLAdmin = strings.Replace(base, "<!-- __HEAD_HTML__ -->", "", 1)
	}

	// ── Public health check ────────────────────────────────────────────────────
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"status":  "ok",
			"version": cfg.AppVersion,
		})
	})

	// ── Feed routes (crawlers & feed readers) ──────────────────────────────────
	rssGate := api.RequirePlugin(svcs.Settings, "rss")
	e.GET("/feed.xml", feedsHandler.RSSFeed, rssGate)
	e.GET("/feed", feedsHandler.RSSFeed, rssGate) // alias used by the public footer link
	e.GET("/sitemap.xml", feedsHandler.Sitemap)
	e.GET("/robots.txt", feedsHandler.RobotsTxt)

	// ── Setup Routes (unauthenticated — first-run wizard) ──────────────────────
	e.GET("/api/setup/status", setupHandler.SetupStatus)
	e.POST("/api/setup", setupHandler.Setup)

	// ── Auth Routes ────────────────────────────────────────────────────────────
	// Brute-force throttle for credential endpoints, keyed by client IP (the
	// default identifier). One shared store → the bucket is spent across all of
	// login/forgot/reset/passkey, so an attacker can't fan out across them.
	// ~10 burst, refilling 1 every 6s (≈10/min sustained).
	authLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(6 * time.Second),
			Burst:     10,
			ExpiresIn: 10 * time.Minute,
		}),
	})

	// Blanket throttle for everything else, keyed by client IP like authLimiter.
	// Nothing bounded the public read surface: /api/posts, /api/pages/*,
	// /api/timeline and media byte-serving were all unlimited.
	//
	// Sized to be invisible to a real visitor and a real admin — a page load
	// costs a handful of API calls plus its images, so 200 burst refilling at
	// 10/s (600/min) is far above human use while still bounding a scraper.
	// It applies to authenticated requests too: the alternative is keying the
	// exemption off a session cookie, which any client can simply present,
	// turning the limiter into a formality.
	//
	// Static assets are skipped: they are plain file serves behind long cache
	// headers, and a first page load pulls dozens of them, which would otherwise
	// consume the budget the API calls need.
	publicLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Skipper: func(c echo.Context) bool {
			p := c.Request().URL.Path
			return strings.HasPrefix(p, "/assets/") || p == "/health"
		},
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(100 * time.Millisecond),
			Burst:     200,
			ExpiresIn: 3 * time.Minute,
		}),
	})
	e.Use(publicLimiter)

	// The tag graph walks the whole tag/post relation set to build its payload,
	// so it is the one public read where a modest request rate is still a real
	// load. ~1/s sustained, 20 burst — well above what rendering the graph page
	// needs, far below what makes it a cheap way to pin a CPU.
	graphLimiter := middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(time.Second),
			Burst:     20,
			ExpiresIn: 3 * time.Minute,
		}),
	})

	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", authHandler.Login, authLimiter)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.GET("/me", authHandler.Me, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	authGroup.POST("/change-password", authHandler.ChangePassword, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/change-email", authHandler.ChangeEmail, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.GET("/sessions", authHandler.ListSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions/:id", authHandler.DeleteSession, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions", authHandler.DeleteOtherSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/forgot-password", authHandler.ForgotPassword, authLimiter)
	authGroup.POST("/reset-password", authHandler.ResetPassword, authLimiter)

	// API Key Management
	authGroup.GET("/api-keys", apiKeyHandler.ListKeys, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.POST("/api-keys", apiKeyHandler.CreateKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.POST("/api-keys/:id/revoke", apiKeyHandler.RevokeKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.DELETE("/api-keys/:id", apiKeyHandler.DeleteKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))

	// ── WebAuthn / Passkey Routes ──────────────────────────────────────────────
	webauthnGroup := e.Group("/api/auth/webauthn", api.RequirePlugin(svcs.Settings, "passkeys"))
	webauthnGroup.POST("/register/begin", webAuthnHandler.BeginRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/register/finish", webAuthnHandler.FinishRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/login/begin", webAuthnHandler.BeginLogin, authLimiter)
	webauthnGroup.POST("/login/finish", webAuthnHandler.FinishLogin, authLimiter)
	webauthnGroup.GET("/status", webAuthnHandler.GetStatus, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	webauthnGroup.DELETE("/credential", webAuthnHandler.DeleteCredential, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)

	// Shared by the pre-setup no-store rule below and the SPA fallback's
	// redirect to the wizard: one latch, so the "is this install configured yet"
	// query stops running the moment it has an answer.
	setupComplete := newSetupGate(repo)

	// API route groups — registered per domain (see routes.go).
	registerPostRoutes(e, postHandler, svcs)
	registerTagRoutes(e, tagHandler, svcs)
	registerMediaRoutes(e, mediaHandler, svcs)
	registerSettingsRoutes(e, settingsHandler, svcs, setupComplete)
	registerPluginRoutes(e, pluginsHandler, svcs)
	registerInstagramRoutes(e, instagramHandler, svcs)
	registerThemeRoutes(e, themeHandler, svcs)
	registerSystemRoutes(e, systemHandler, svcs)

	// ── MCP plugin (/mcp) ──────────────────────────────────────────────────────
	// In-process Model Context Protocol server. Gated by the "mcp" plugin; serves
	// the streamable endpoint plus OAuth 2.1 discovery. Reuses the REST handlers
	// for all data access (see RegisterMCP / mcpServiceClient).
	mcpBaseURL := cfg.MCPBaseURL
	if mcpBaseURL == "" {
		mcpBaseURL = cfg.AppURL
	}
	var mcpOwnerID int64
	if owner, err := repo.GetFirstUser(context.Background()); err == nil {
		mcpOwnerID = owner.ID
	}
	mcp.Register(e, mcp.Deps{
		Echo:            e,
		Post:            postHandler,
		Tag:             tagHandler,
		Media:           mediaHandler,
		Theme:           themeHandler,
		Settings:        settingsHandler,
		System:          systemHandler,
		Auth:            svcs.Auth,
		ApiKey:          svcs.ApiKey,
		SettingsService: svcs.Settings,
		OwnerUserID:     mcpOwnerID,
		BaseURL:         mcpBaseURL,
		Version:         cfg.AppVersion,
		UploadRoot:      cfg.PhotoLibraryPath,
	})

	// ── Comments plugin (/comments → remark42 sidecar) ─────────────────────────
	// Gated reverse proxy to the remark42 process started by entrypoint.sh on
	// loopback; this is its only external access path (see api.RegisterCommentsProxy).
	remark42URL, _ := url.Parse("http://127.0.0.1:8081")
	api.RegisterCommentsProxy(e, svcs.Settings, remark42URL)

	// Moderation endpoints for the /light/comments admin page. ADMIN_PASSWD is
	// generated and exported by entrypoint.sh when the sidecar is configured.
	commentsAdmin := api.NewCommentsAdminHandler(remark42URL, os.Getenv("ADMIN_PASSWD"))
	commentsAdminGroup := e.Group("/api/admin/comments", api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "comments"))
	commentsAdminGroup.GET("/recent", commentsAdmin.Recent)
	commentsAdminGroup.GET("/blocked", commentsAdmin.Blocked)
	commentsAdminGroup.DELETE("/comment/:id", commentsAdmin.DeleteComment)
	commentsAdminGroup.PUT("/user/:id/block", commentsAdmin.SetBlock)

	// ── Nav Menu Routes (admin) ────────────────────────────────────────────────
	e.GET("/api/nav-menu", navMenuHandler.GetAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))
	e.PUT("/api/nav-menu", navMenuHandler.UpdateAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))

	// ── Utility Routes ─────────────────────────────────────────────────────────
	utilGroup := e.Group("/api/util")
	utilGroup.GET("/parse-maps-coords", api.ParseMapsCoords, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Page compound data Routes (for SPA) ────────────────────────────────────
	// visibilityCache is group-level: every route here is an OptionalAuth public
	// read, so an anonymous GET is edge-cacheable (authenticated reads and any
	// write get private,no-store). These are the compound payloads the public SPA
	// fetches to render a page, so caching them offloads the flood's follow-on
	// /api traffic alongside the HTML shell.
	pagesGroup := e.Group("/api/pages", visibilityCache)
	pagesGroup.GET("/home", pagesHandler.GetHomePage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags/:slug", pagesHandler.GetTagPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags", pagesHandler.GetTagsPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/graph", pagesHandler.GetTagsGraph, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), graphLimiter)
	pagesGroup.GET("/graph/tag/:id", pagesHandler.GetTagCloud, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), graphLimiter)
	pagesGroup.GET("/map", pagesHandler.GetMapPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/nav", pagesHandler.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))

	// ── Timeline Routes ────────────────────────────────────────────────────────
	// Both routes are OptionalAuth public reads — group-level visibilityCache.
	timelineGroup := e.Group("/api/timeline", visibilityCache)
	timelineGroup.GET("", timelineHandler.GetTimeline, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	timelineGroup.GET("/locations", timelineHandler.GetTimelineLocations, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Frontend SPA + static assets ──────────────────────────────────────────
	frontendDir := cfg.FrontendDir
	// Resolve the JS bundle directory once: the release bundle (frontend/js), or
	// the debug bundle (frontend/js-debug) when FRONTEND_DEBUG is set and built.
	// The chunk map MUST come from the same directory we serve so plugin chunk
	// hashes match the bundle the browser loads.
	jsDir := resolveJSDir(frontendDir, cfg.FrontendDebug)
	manifestDir := jsDir
	if manifestDir == "" {
		manifestDir = filepath.Join(frontendDir, "js")
	}
	// Static build map (plugin id → hashed chunk filename). Empty in Phase 1
	// (no per-plugin chunks built yet), which makes every /assets/js/p/* request
	// 404 and every manifest Entry empty — the intended foundation state.
	chunkMap := plugins.LoadChunkMap(filepath.Join(manifestDir, "plugin-manifest.json"))
	cssMap := plugins.LoadCssMap(filepath.Join(frontendDir, "css", "p"))

	// ── Media file serving: /YYYY/MM/filename[?thumb] ─────────────────────────
	// Auth-gated: unauthenticated clients see 404 for non-public media.
	// Registered after /api routes to avoid collisions (e.g. /api/settings/public).
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath, indexHTMLContent, repo, svcs.Media, svcs.S3Presigner, svcs.Settings, chunkMap, cssMap), api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	if fi, err := os.Stat(frontendDir); err == nil && fi.IsDir() {
		cssDir := filepath.Join(frontendDir, "css")
		imagesDir := filepath.Join(frontendDir, "images")
		vendorDir := filepath.Join(frontendDir, "vendor")

		if fi, err := os.Stat(cssDir); err == nil && fi.IsDir() {
			// Serves the whole tree: the bundles at the top level plus the
			// subdirectories under it, notably common/theme.css, which the
			// theme service rewrites at runtime. Content-addressed bundle URLs
			// (light.<hash>.css) have already been rewritten to the plain
			// on-disk name by the Pre middleware above.
			e.Static("/assets/css", cssDir)
		}
		if jsDir != "" {
			// Gated plugin-chunk handler: serves /assets/js/p/* only for ENABLED
			// plugins, so disabled code 404s even if a filename is guessed.
			// Registered before the broad /assets/js static route so the more
			// specific prefix wins. Chunks live under <jsDir>/p/.
			pluginChunkDir := filepath.Join(jsDir, "p")
			e.GET("/assets/js/p/*", func(c echo.Context) error {
				name := filepath.Base(filepath.Clean("/" + c.Param("*")))
				if name == "." || name == "/" || name == "" {
					return echo.NewHTTPError(http.StatusNotFound, "not found")
				}
				// Named entry chunks (a plugin id in plugin-manifest.json) are
				// gated: a disabled plugin's entry 404s even if its filename is
				// guessed. Shared code-split chunks (chunk-*.js) are not entries —
				// they carry common code imported by multiple plugin entries and
				// must be served so enabled plugins can resolve their imports.
				if id, ok := plugins.PluginForChunk(chunkMap, name); ok {
					all, err := svcs.Settings.GetAllSettings(c.Request().Context())
					if err != nil {
						return echo.NewHTTPError(http.StatusInternalServerError, "failed to resolve plugin state")
					}
					if !plugins.IsEnabled(id, all) {
						return echo.NewHTTPError(http.StatusNotFound, "not found")
					}
				}
				return c.File(filepath.Join(pluginChunkDir, name))
			})
			e.Static("/assets/js", jsDir)
		}
		if fi, err := os.Stat(imagesDir); err == nil && fi.IsDir() {
			e.Static("/assets/images", imagesDir)
		}
		if fi, err := os.Stat(vendorDir); err == nil && fi.IsDir() {
			e.Static("/assets/vendor", vendorDir)
		}
	}

	// ── PWA: manifest + service worker at root scope ──────────────────────────
	// These must be served as real files (not index.html) and must be registered
	// before the /* SPA fallback that would otherwise intercept them.
	if fi, err := os.Stat(filepath.Join(cfg.FrontendDir, "manifest.webmanifest")); err == nil && !fi.IsDir() {
		manifestPath := filepath.Join(cfg.FrontendDir, "manifest.webmanifest")
		e.GET("/manifest.webmanifest", func(c echo.Context) error {
			c.Response().Header().Set("Content-Type", "application/manifest+json")
			// One image can serve several sites, so the installed-app name comes
			// from the host the manifest was fetched from rather than the file's
			// placeholder name.
			raw, err := os.ReadFile(manifestPath)
			if err != nil {
				return c.File(manifestPath)
			}
			var m map[string]any
			if err := json.Unmarshal(raw, &m); err != nil {
				return c.Blob(http.StatusOK, "application/manifest+json", raw)
			}
			if name := siteNameFromHost(c.Request().Host); name != "" {
				m["name"] = name
				m["short_name"] = name
			}
			out, err := json.Marshal(m)
			if err != nil {
				return c.Blob(http.StatusOK, "application/manifest+json", raw)
			}
			return c.Blob(http.StatusOK, "application/manifest+json", out)
		})
	}
	if fi, err := os.Stat(filepath.Join(cfg.FrontendDir, "sw.js")); err == nil && !fi.IsDir() {
		swPath := filepath.Join(cfg.FrontendDir, "sw.js")
		e.GET("/sw.js", func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-cache")
			// Stamp the build version into the SW's cache name (CACHE_VERSION
			// in sw.js) so each deploy retires the previous shell cache; the
			// byte change is also what triggers the browser's SW update.
			b, err := os.ReadFile(swPath)
			if err != nil {
				return c.File(swPath)
			}
			js := strings.ReplaceAll(string(b), "__BUILD_VERSION__", cfg.AppVersion)
			return c.Blob(http.StatusOK, "text/javascript; charset=utf-8", []byte(js))
		})
	}

	// ── SPA fallback — must be last ────────────────────────────────────────────
	e.GET("/*", func(c echo.Context) error {
		if indexHTMLContent != "" {
			path := c.Request().URL.Path

			// Fresh install: every document lands on the first-run wizard, not
			// just the admin section. A blog with no owner has nothing to show
			// on "/" either, and doing it here (rather than only in the SPA's
			// route guard) means the very first page load goes straight to
			// /setup — no public shell rendered first, no JS required.
			if path != "/setup" && !setupComplete(c.Request().Context()) {
				// visibilityCache already stamped `public, max-age=60` on this
				// guest GET; a cached redirect would outlive setup itself and
				// bounce visitors to /setup after the blog is configured.
				c.Response().Header().Set("Cache-Control", "private, no-store")
				return c.Redirect(http.StatusFound, "/setup")
			}
			// Pick the shell: the admin one (no deployment-injected third-party
			// markup) whenever the viewer is privileged — an admin route, or any
			// request carrying a session. A logged-in admin shows admin controls
			// on public pages too, so the injected script must not run there
			// either; keeping it out of every authenticated DOM shrinks the blast
			// radius if that origin is compromised (it can't ride the session).
			shell := indexHTMLContent
			if isAdminPath(path) || hasSession(c) {
				shell = indexHTMLAdmin
			}
			if slug, ok := strings.CutPrefix(path, "/posts/"); ok {
				post, err := svcs.Post.GetPostBySlug(c.Request().Context(), slug)
				if err == nil && strings.EqualFold(post.Status, "published") {
					{
						htmlStr := shell
						htmlStr = strings.Replace(htmlStr, "<title>Loading…</title>", "", 1)

						var sb strings.Builder
						desc := post.MetaDescription.String
						if !post.MetaDescription.Valid || desc == "" {
							desc = post.Excerpt.String
						}

						fmt.Fprintf(&sb, "\n  <title>%s</title>", html.EscapeString(post.Title))
						if desc != "" {
							fmt.Fprintf(&sb, "\n  <meta name=\"description\" content=\"%s\">", html.EscapeString(desc))
							fmt.Fprintf(&sb, "\n  <meta property=\"og:description\" content=\"%s\">", html.EscapeString(desc))
							fmt.Fprintf(&sb, "\n  <meta name=\"twitter:description\" content=\"%s\">", html.EscapeString(desc))
						}

						sb.WriteString("\n  <meta property=\"og:type\" content=\"article\">")
						fmt.Fprintf(&sb, "\n  <meta property=\"og:title\" content=\"%s\">", html.EscapeString(post.Title))
						fmt.Fprintf(&sb, "\n  <meta name=\"twitter:title\" content=\"%s\">", html.EscapeString(post.Title))

						scheme := c.Scheme()
						if fwd := c.Request().Header.Get("X-Forwarded-Proto"); fwd != "" {
							scheme = fwd
						}
						fullURL := fmt.Sprintf("%s://%s%s", scheme, c.Request().Host, c.Request().URL.Path)
						fmt.Fprintf(&sb, "\n  <meta property=\"og:url\" content=\"%s\">", html.EscapeString(fullURL))

						media, _ := svcs.Media.GetMediaByContent(c.Request().Context(), post.Content, post.ThumbnailPath.String)
						if len(media) > 0 {
							mPath := "/" + strings.TrimPrefix(media[0].OriginalPath, "originals/")
							imgURL := fmt.Sprintf("%s://%s%s", scheme, c.Request().Host, mPath)
							sb.WriteString("\n  <meta name=\"twitter:card\" content=\"summary_large_image\">")
							fmt.Fprintf(&sb, "\n  <meta property=\"og:image\" content=\"%s\">", html.EscapeString(imgURL))
							fmt.Fprintf(&sb, "\n  <meta name=\"twitter:image\" content=\"%s\">", html.EscapeString(imgURL))
						} else {
							sb.WriteString("\n  <meta name=\"twitter:card\" content=\"summary\">")
						}

						script, hash := pluginManifestScript(c.Request().Context(), svcs.Settings, chunkMap, cssMap)
						sb.WriteString(script)
						sb.WriteString("\n</head>")
						htmlStr = strings.Replace(htmlStr, "</head>", sb.String(), 1)

						csp := c.Response().Header().Get("Content-Security-Policy")
						csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
						c.Response().Header().Set("Content-Security-Policy", csp)

						return c.HTML(http.StatusOK, htmlStr)
					}
				}
			}
			// Generic SPA route: serve index.html with the enabled-only plugin
			// manifest injected so the client bootstrap always sees __PLUGINS__.
			// shell (chosen above) already omits third-party markup for admin
			// routes and authenticated viewers.
			{
				script, hash := pluginManifestScript(c.Request().Context(), svcs.Settings, chunkMap, cssMap)
				htmlStr := strings.Replace(shell, "</head>", script+"\n</head>", 1)

				csp := c.Response().Header().Get("Content-Security-Policy")
				csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
				c.Response().Header().Set("Content-Security-Policy", csp)

				return c.HTML(http.StatusOK, htmlStr)
			}
		}
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Frontend not available — build the frontend first",
		})
	}, visibilityCache)

	return e
}

// installLogger points slog (and the legacy log package) at w.
func installLogger(w io.Writer) {
	logger := slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Redirect standard log to slog to handle legacy log.Printf calls
	log.SetOutput(slog.NewLogLogger(logger.Handler(), slog.LevelInfo).Writer())
	log.SetFlags(0)
}

func main() {
	// Start on stdout alone: the log file lives under the storage path, which
	// isn't known until the config is loaded below.
	installLogger(os.Stdout)

	// Check for CLI commands early.
	isSetup := false
	for _, arg := range os.Args {
		trimmed := strings.Trim(arg, " \t\n\r\"'")
		// Match "setup" as standalone OR part of a merged string like "point setup"
		if trimmed == "setup" || strings.HasPrefix(trimmed, "setup ") || strings.Contains(trimmed, " setup ") || strings.HasSuffix(trimmed, " setup") {
			isSetup = true
			break
		}
	}

	if isSetup {
		slog.Info("CLI Setup command detected. Initializing...")
		cfg, err := config.LoadConfig(".")
		if err != nil {
			slog.Error("setup: failed to load config", "error", err)
			os.Exit(1)
		}
		slog.Debug("config loaded", "DATABASE_URL", cfg.DatabaseURL, "STORAGE_PATH", cfg.StoragePath)

		repo, err := repository.NewRepository(cfg.DatabaseURL)
		if err != nil {
			slog.Error("setup: failed to initialize repository", "error", err)
			os.Exit(1)
		}
		svcs := initServices(&cfg, repo)
		slog.Info("Running CLI setup...")
		runSetupCLI(repo, svcs)
		os.Exit(0)
	}

	// Offline operator password recovery: `point reset-password ...`. Runs against
	// /data/point.db with no SMTP and no manual SQL (see resetpassword.go).
	if isResetPasswordCmd(os.Args) {
		slog.Info("CLI reset-password command detected. Initializing...")
		cfg, err := config.LoadConfig(".")
		if err != nil {
			slog.Error("reset-password: failed to load config", "error", err)
			os.Exit(1)
		}
		repo, err := repository.NewRepository(cfg.DatabaseURL)
		if err != nil {
			slog.Error("reset-password: failed to initialize repository", "error", err)
			os.Exit(1)
		}
		runResetPasswordCLI(repo)
		os.Exit(0)
	}

	for _, arg := range os.Args[1:] {
		if arg == "-v" || arg == "--version" || arg == "-version" {
			fmt.Println(Version)
			os.Exit(0)
		}
	}

	// Load configuration
	cfg, err := config.LoadConfig(".")
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}
	if cfg.AppVersion == "" || cfg.AppVersion == "dev" {
		cfg.AppVersion = Version
	}

	// Now that the storage path is known, tee logging to disk as well. stdout
	// stays authoritative (docker logs, journald); the file is what the admin
	// Logs page reads, which is otherwise unreachable inside a container.
	logFile := utils.NewRotatingFile(
		filepath.Join(cfg.StoragePath, "logs", "app.log"),
		utils.LogMaxBytes, utils.LogMaxBackups,
	)
	defer func() { _ = logFile.Close() }()
	installLogger(io.MultiWriter(os.Stdout, logFile))

	// Apply any backup restore scheduled from the admin UI. This must run BEFORE
	// the database is opened: extracting a backup over an open SQLite file corrupts
	// it, so the restore is deferred to here.
	sysBoot := services.NewSystemService(nil, cfg.StoragePath, cfg.DatabaseURL)
	if applied, err := sysBoot.ApplyPendingRestore(); err != nil {
		slog.Error("failed to apply pending backup restore", "error", err)
	} else if applied {
		slog.Info("applied pending backup restore before opening database")
	}

	// Finish a pre-migration snapshot restore that a crash or a kill interrupted.
	// Same rule as above — it swaps the database file, so it has to happen before
	// anything opens it. Unlike a scheduled restore this one is not allowed to
	// fail quietly: the file at point.db may be the one a failed migration left.
	if applied, err := sysBoot.ApplyPendingMigrationRestore(); err != nil {
		slog.Error("could not finish an interrupted pre-migration restore — refusing to start", "error", err)
		os.Exit(1)
	} else if applied {
		slog.Warn("finished an interrupted pre-migration restore before opening database")
	}

	// Initialize repository
	repo, err := repository.NewRepository(cfg.DatabaseURL)
	if err != nil {
		slog.Error("failed to initialize repository", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := repo.Close(); err != nil {
			slog.Error("error closing repository", "error", err)
		}
	}()

	svcs := initServices(&cfg, repo)

	// API Key Creation CLI fallback
	if name := parseCreateAPIKeyName(os.Args[1:]); name != "" {
		runCreateAPIKeyCLI(svcs, name)
	}

	// Ensure media directories exist
	for _, dir := range []string{"originals", "thumbnails"} {
		path := filepath.Join(cfg.StoragePath, "media", dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			slog.Warn("could not create media dir", "path", path, "error", err)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Apply DB schema + data migrations (see internal/migrations). A failure
	// here means the database is not at the schema this build expects, so we
	// stop rather than serve against it — the alternative is failing later,
	// somewhere unrelated, on whatever the mismatch happens to break. The guard
	// snapshots the database first and puts it back on failure, so stopping
	// leaves it at its pre-upgrade state rather than half-migrated.
	if restored, err := runMigrationsGuarded(ctx, repo, svcs.System, cfg); err != nil {
		slog.Error("database migrations failed — refusing to start",
			"error", err, "database_restored", restored)
		os.Exit(1)
	}

	// Sync env-var secrets into blog_secrets so they're available at runtime.
	if cfg.GeminiAPIKey != "" {
		if err := svcs.Settings.SetSecret(ctx, "gemini_api_key", cfg.GeminiAPIKey); err != nil {
			slog.Warn("failed to sync gemini_api_key to secrets", "error", err)
		}
	}
	if cfg.PhotoLibraryPath != "" {
		if err := svcs.Settings.SetSecret(ctx, "photo_library_path", cfg.PhotoLibraryPath); err != nil {
			slog.Warn("failed to sync photo_library_path to secrets", "error", err)
		}
	}

	// Synchronize active theme with public theme.css for the frontend
	if err := svcs.Theme.SyncActiveTheme(ctx); err != nil {
		slog.Warn("failed to sync active theme", "error", err)
	}

	e := setupEcho(cfg, repo, svcs)

	// Start background scheduler (goroutines honor ctx cancellation)
	svcs.Scheduler.Start(ctx)

	// Start server
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	slog.Info("Point API starting", "address", address)
	go func() {
		if err := e.Start(address); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("failed to start server", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for interrupt or SIGTERM
	<-ctx.Done()
	stop()

	slog.Info("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
	slog.Info("graceful shutdown complete")

	// A UI-triggered restart re-execs this binary in place: same PID and container,
	// a fresh program that re-runs initialization (including applying any pending
	// backup restore before the DB opens). No external supervisor is required. The
	// DB/listener fds are O_CLOEXEC, so they close automatically across the exec.
	if api.RestartRequested.Load() {
		exe, err := os.Executable()
		if err != nil {
			exe = os.Args[0]
		}
		slog.Info("restart requested: re-executing in place", "exe", exe)
		// Re-executing this very binary (os.Executable), not a caller-named one.
		if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil { //nolint:gosec // G204: exec of self
			slog.Error("re-exec failed; exiting so a supervisor can restart instead", "error", err)
			os.Exit(1)
		}
	}
}

// isResetPasswordCmd reports whether the args invoke the reset-password
// subcommand, tolerating merged args like "point reset-password" the same way
// setup detection does.
func isResetPasswordCmd(args []string) bool {
	for _, arg := range args {
		trimmed := strings.Trim(arg, " \t\n\r\"'")
		if trimmed == "reset-password" || strings.HasPrefix(trimmed, "reset-password ") ||
			strings.Contains(trimmed, " reset-password ") || strings.HasSuffix(trimmed, " reset-password") {
			return true
		}
	}
	return false
}

// parseCreateAPIKeyName scans args for --create-api-key=<name> or
// --create-api-key <name> and returns the name, or "" if not present.
func parseCreateAPIKeyName(args []string) string {
	for i, arg := range args {
		if val, ok := strings.CutPrefix(arg, "--create-api-key="); ok {
			return val
		}
		if arg == "--create-api-key" && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// checksumRe matches the 8-char hex checksum embedded in a media filename,
// e.g. "video_89017c29.mp4" → "89017c29".
var checksumRe = regexp.MustCompile(`_([0-9a-f]{8})\.[^.]+$`)

// neutralizeSVG locks down the response when the file being served is an SVG.
//
// SVG is the only allowlisted upload format a browser will execute script from:
// navigating straight to /2026/07/x.svg renders it as a document, in this
// origin. Uploads are scanned for active content (services.ScanSVG) and
// admin-only, but neither is a reason to let the served bytes rely on the
// site-wide CSP staying exactly as it is today — one regression there would
// turn a stored file into stored XSS.
//
// The per-response policy denies everything and sandboxes the document, so
// nothing in the SVG runs regardless of the global policy. Embedding via <img>
// is unaffected: that context never executes script and ignores this header.
func neutralizeSVG(c echo.Context, path string) {
	if !strings.EqualFold(filepath.Ext(path), ".svg") {
		return
	}
	c.Response().Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; sandbox")
	c.Response().Header().Set("X-Content-Type-Options", "nosniff")
}

// cssBundleRe matches a content-addressed CSS bundle URL — "light.81e2e81c.css"
// → base "light.css", hash "81e2e81c". The hash exists only in the URL; one
// bundle is written to disk under its plain name, and the server maps back.
var cssBundleRe = regexp.MustCompile(`^([a-zA-Z0-9_-]+)\.([0-9a-f]{8})\.css$`)

// stripCSSBundleHash turns a hashed bundle filename back into the on-disk name,
// reporting whether the name was hashed at all.
func stripCSSBundleHash(name string) (string, bool) {
	m := cssBundleRe.FindStringSubmatch(name)
	if m == nil {
		return name, false
	}
	return m[1] + ".css", true
}

// loadCSSManifest reads the content hashes scripts/build-css.sh records for the
// CSS bundles, mapping "light.css" → "light.81e2e81c.css". An absent or
// unreadable manifest yields nil, and the shell falls back to the plain
// ?v=<build version> URLs — a missing manifest must never mean no stylesheet.
func loadCSSManifest(cssDir string) map[string]string {
	b, err := os.ReadFile(filepath.Join(cssDir, "asset-manifest.json"))
	if err != nil {
		return nil
	}
	var hashes map[string]string
	if err := json.Unmarshal(b, &hashes); err != nil {
		slog.Warn("css asset manifest is unreadable; falling back to versioned URLs", "error", err)
		return nil
	}
	out := make(map[string]string, len(hashes))
	for name, hash := range hashes {
		base, ok := strings.CutSuffix(name, ".css")
		if !ok || !regexp.MustCompile(`^[0-9a-f]{8}$`).MatchString(hash) {
			continue
		}
		out[name] = base + "." + hash + ".css"
	}
	return out
}

// immutableCacheControl is the header for content-addressed URLs: the name
// embeds a hash of the bytes, so the bytes at that URL can never change and a
// revalidation round-trip is pure waste. A year is the practical maximum
// browsers honour.
const immutableCacheControl = "public, max-age=31536000, immutable"

// serveSimplifiedMedia handles /YYYY/MM/filename for media files.
//
// Access rules:
//   - Authenticated users (session cookie present) may access any file.
//   - Unauthenticated users may only access files where media.is_public = 1.
//   - Files not found in the media table return 404.
//
// Variant selection:
//   - ?thumb=<size> serves an on-demand square thumbnail (e.g. the atlas
//     cloud's 128px chips), generated and cached lazily from the original.
//   - ?thumb (no value) serves the stored thumbnail (media/thumbnails/…) when one exists.
//   - No query param serves the original (media/originals/…).
//
// Non-numeric year/month segments are SPA routes — index.html is served instead.
func serveSimplifiedMedia(storagePath, indexHTMLContent string, repo repository.Repository, mediaSvc *services.MediaService, s3Presigner *services.S3Presigner, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) echo.HandlerFunc {
	return func(c echo.Context) error {
		year := c.Param("year")
		month := c.Param("month")
		filename := c.Param("filename")

		// Validate year/month are numeric — non-numeric means this is an SPA route.
		yearInt, yearErr := strconv.Atoi(year)
		monthInt, monthErr := strconv.Atoi(month)
		if yearErr != nil || monthErr != nil || yearInt < 1000 || yearInt > 9999 || monthInt < 1 || monthInt > 12 {
			if indexHTMLContent != "" {
				script, hash := pluginManifestScript(c.Request().Context(), settings, chunks, cssMap)
				htmlStr := strings.Replace(indexHTMLContent, "</head>", script+"\n</head>", 1)

				csp := c.Response().Header().Get("Content-Security-Policy")
				csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
				c.Response().Header().Set("Content-Security-Policy", csp)

				return c.HTML(http.StatusOK, htmlStr)
			}
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"detail": "Frontend not available — build the frontend first",
			})
		}

		// Sanitize year and month by reconstructing them from the validated integers.
		// This ensures they contain only digits and satisfies static analysis.
		year = strconv.Itoa(yearInt)
		month = fmt.Sprintf("%02d", monthInt)

		// Prevent path traversal in the filename segment.
		if filename == "" || filename == "." || strings.Contains(filename, "..") || strings.ContainsAny(filename, "/\\") {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid path")
		}

		isAuthenticated := c.Get("user") != nil

		// Resolve the media record from the DB using the original_path key.
		origRelPath := "originals/" + year + "/" + month + "/" + filename
		ctx := c.Request().Context()
		media, err := repo.GetMediaByPath(ctx, origRelPath)
		if err != nil {
			// DB record not found — try the checksum-glob fallback to handle
			// renamed files, then retry the DB lookup with the resolved name.
			dir := filepath.Join(storagePath, "media", "originals", year, month)
			if m := checksumRe.FindStringSubmatch(filename); m != nil {
				matches, _ := filepath.Glob(filepath.Join(dir, "*_"+m[1]+".*"))
				if len(matches) == 1 {
					resolvedName := filepath.Base(matches[0])
					resolvedPath := "originals/" + year + "/" + month + "/" + resolvedName
					media, err = repo.GetMediaByPath(ctx, resolvedPath)
				}
			}
			if err != nil {
				// no-store so the edge never caches a 404 keyed on the .jpg
				// extension and then serves it stale after the file appears.
				c.Response().Header().Set("Cache-Control", "no-store")
				return echo.NewHTTPError(http.StatusNotFound, "media not found")
			}
		}

		// Enforce visibility: unauthenticated clients cannot access private media.
		if media.IsPublic == 0 && !isAuthenticated {
			// no-store so publishing a previously-hidden post is not masked by
			// a cached 404 at the edge (see the DB-miss branch above).
			c.Response().Header().Set("Cache-Control", "no-store")
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		// Public media is edge-cacheable so a CDN absorbs traffic without
		// hitting the origin: s-maxage lets a shared cache serve it for a day,
		// while a short browser max-age bounds client staleness. Media can be
		// renamed/replaced/unpublished at the same URL, so a change requires a
		// manual edge purge (rare, operator-driven) — we deliberately trade
		// no-cache revalidation for full offload. Private media must never be
		// cached by a shared cache, or an authenticated preview response could
		// leak hidden media to the edge for unauthenticated requests to reuse.
		if media.IsPublic != 0 {
			if checksumRe.MatchString(filename) {
				// Content-addressed: the filename carries a checksum of the bytes,
				// so replacing the image produces a different URL and this one can
				// be cached forever. The trade-off is unpublishing — a client that
				// already fetched the file keeps its copy until the year is up, so
				// visibility changes are not retroactive for cached bytes. That is
				// the same bargain the existing s-maxage=86400 edge cache makes.
				c.Response().Header().Set("Cache-Control", immutableCacheControl)
			} else {
				c.Response().Header().Set("Cache-Control", "public, max-age=300, s-maxage=86400")
			}
		} else {
			c.Response().Header().Set("Cache-Control", "private, no-store")
		}

		// Determine which file to serve.
		thumbVals, wantThumb := c.Request().URL.Query()["thumb"]
		if wantThumb {
			// `?thumb=<size>` requests an on-demand square thumbnail; a bare
			// `?thumb` serves the stored thumbnail variant. An unsupported size is
			// rejected, but a generation failure (e.g. an undecodable image) falls
			// through to the original below so the image still renders. A bare
			// `?thumb` whose stored thumbnail is absent (no path, outside the media
			// dir, or file missing) likewise falls through to the original rather
			// than 404ing, so the image still renders.
			if sizeStr := thumbVals[0]; sizeStr != "" {
				n, convErr := strconv.Atoi(sizeStr)
				if convErr != nil || !services.AllowedSquareThumbSize(n) {
					return echo.NewHTTPError(http.StatusBadRequest, "invalid thumbnail size")
				}
				if thumbFile, genErr := mediaSvc.SquareThumbnail(ctx, media, n); genErr == nil {
					return c.File(thumbFile)
				}
			} else if media.ThumbnailPath.Valid {
				thumbFile := filepath.Clean(filepath.Join(storagePath, "media", media.ThumbnailPath.String))

				// Security: ensure the resolved file is within the media storage
				// directory before serving it; otherwise fall through to the original.
				if strings.HasPrefix(thumbFile, filepath.Join(storagePath, "media")) {
					if _, err := os.Stat(thumbFile); err == nil {
						return c.File(thumbFile)
					}
				}
			}

			// Falling through to the original is only a graceful degradation when
			// the original is itself a still. For a video or audio file the caller
			// asked for a thumbnail and would get an <img> pointed at a media
			// stream — a broken image that costs a full download. 404 instead;
			// the UI drops back to a type glyph on error.
			if strings.EqualFold(media.FileType, "video") || strings.EqualFold(media.FileType, "audio") {
				return echo.NewHTTPError(http.StatusNotFound, "no thumbnail for this media")
			}
		}

		// Serve original — try exact path first, then checksum-glob fallback.
		origDir := filepath.Join(storagePath, "media", "originals", year, month)
		origFile := filepath.Clean(filepath.Join(origDir, filepath.Base(filename)))

		// Security: ensure the resolved file is within the expected originals directory.
		if !strings.HasPrefix(origFile, filepath.Join(storagePath, "media", "originals")) {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		if _, err := os.Stat(origFile); err == nil {
			neutralizeSVG(c, origFile)

			s3Enabled := c.Request().Header.Get("X-Point-Direct-S3") == "1"
			if s3Enabled && s3Presigner != nil {
				relPath, err := filepath.Rel(storagePath, origFile)
				if err == nil {
					// filepath.Rel uses os-specific separators, but S3 requires forward slashes.
					// We can assume Linux here since point runs on Linux in Docker, but let's be safe.
					relPath = filepath.ToSlash(relPath)

					url, presignErr := s3Presigner.PresignGetObject(c.Request().Context(), relPath)
					if presignErr == nil {
						c.Response().Header().Set("X-S3-Presigned-Url", url)
						// Determine the correct Content-Type before bypassing
						contentType := mime.TypeByExtension(filepath.Ext(origFile))
						if contentType != "" {
							c.Response().Header().Set("Content-Type", contentType)
						}
						return c.NoContent(http.StatusOK)
					} else {
						// log error, fall back to disk
						log.Printf("S3 presign error: %v", presignErr)
					}
				}
			}

			return c.File(origFile)
		}
		if m := checksumRe.FindStringSubmatch(filename); m != nil {
			matches, _ := filepath.Glob(filepath.Join(origDir, "*_"+m[1]+".*"))
			if len(matches) == 1 {
				matchFile := filepath.Clean(filepath.Join(origDir, filepath.Base(matches[0])))
				// Security: double-check the globbed file prefix.
				if strings.HasPrefix(matchFile, filepath.Join(storagePath, "media", "originals")) {
					neutralizeSVG(c, matchFile)
					return c.File(matchFile)
				}
			}
		}

		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
}
