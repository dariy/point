package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/mcp"
	"point-api/internal/migrations"
	"point-api/internal/plugins"
	"point-api/internal/repository"
	"point-api/internal/services"

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
	all, err := settings.GetAllSettings(ctx)
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
// under its icon: "www.Point.Photos:8001" → "point.photos". Returns "" when the
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
	Settings  *services.SettingsService
	Auth      *services.AuthService
	ApiKey    *services.ApiKeyService
	Tag       *services.TagService
	Post      *services.PostService
	Media     *services.MediaService
	System    *services.SystemService
	Cache     *services.CacheService
	Scheduler *services.SchedulerService
	Theme     *services.ThemeService
	Timeline  *services.TimelineService
	Instagram *services.InstagramService
}

func initServices(cfg *config.Config, repo repository.Repository) *AppServices {
	settingsService := services.NewSettingsService(repo)
	authService := services.NewAuthService(repo)
	apiKeyService := services.NewApiKeyService(repo)
	tagService := services.NewTagService(repo)
	instagramService := services.NewInstagramService(settingsService)
	postService := services.NewPostService(repo, settingsService, instagramService, tagService, cfg.AppURL)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	systemService := services.NewSystemService(repo, cfg.StoragePath)
	cacheService := services.NewCacheService(cfg.StoragePath)
	themeService := services.NewThemeService(cfg, settingsService)
	timelineService := services.NewTimelineService(repo)
	schedulerService := services.NewSchedulerService(authService, postService, systemService, mediaService, settingsService, instagramService)

	return &AppServices{
		Settings:  settingsService,
		Auth:      authService,
		ApiKey:    apiKeyService,
		Tag:       tagService,
		Post:      postService,
		Media:     mediaService,
		System:    systemService,
		Cache:     cacheService,
		Scheduler: schedulerService,
		Theme:     themeService,
		Timeline:  timelineService,
		Instagram: instagramService,
	}
}

func setupEcho(cfg config.Config, repo repository.Repository, svcs *AppServices) *echo.Echo {
	// Initialize Echo

	e := echo.New()
	e.HideBanner = true

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
	remarkSupervisor := services.NewRemarkSupervisor(svcs.Settings, repo)
	go remarkSupervisor.Start()

	settingsHandler := api.NewSettingsHandler(svcs.Settings, remarkSupervisor)
	pluginsHandler := api.NewPluginsHandler(svcs.Settings)
	themeHandler := api.NewThemeHandler(svcs.Theme)
	systemHandler := api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, cfg.StoragePath, cfg.AppVersion)
	feedsHandler := api.NewFeedsHandler(repo, svcs.Post, svcs.Tag, svcs.Settings, svcs.Cache)
	pagesHandler := api.NewPagesHandler(repo, svcs.Post, svcs.Tag, svcs.Media, svcs.Settings, svcs.Cache)
	timelineHandler := api.NewTimelineHandler(svcs.Timeline, svcs.Settings)
	setupHandler := api.NewSetupHandler(svcs.Auth, svcs.Settings, repo)
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
	webAuthnHandler := api.NewWebAuthnHandler(webauthnSvc, svcs.Auth, &cfg)

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
	// Cap request bodies at the configured upload limit (default 50MB). This is
	// the ceiling for the largest legitimate request (a media upload); every
	// other endpoint is smaller. Echo enforces it both via Content-Length and
	// while streaming the body, returning 413 when exceeded — so a client can't
	// exhaust memory by lying about Content-Length.
	uploadLimitMB := cfg.MaxUploadSizeMB
	if uploadLimitMB <= 0 {
		uploadLimitMB = 50
	}
	e.Use(middleware.BodyLimit(fmt.Sprintf("%dM", uploadLimitMB)))
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
	e.Use(middleware.SecureWithConfig(middleware.SecureConfig{
		XSSProtection:         "1; mode=block",
		ContentTypeNosniff:    "nosniff",
		XFrameOptions:         "DENY",
		ContentSecurityPolicy: "default-src 'self'; script-src " + scriptSrc + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src 'self' https://*.basemaps.cartocdn.com; frame-ancestors 'none'",
		ReferrerPolicy:        "strict-origin-when-cross-origin",
	}))
	// Extra security headers not covered by middleware.Secure
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			c.Response().Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
			return next(c)
		}
	})
	// Prevent Safari on iOS from serving stale JS/CSS after a redeploy.
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			p := c.Request().URL.Path
			if strings.HasPrefix(p, "/assets/js/") || strings.HasPrefix(p, "/assets/css/") {
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
	indexHTMLContent := ""
	if b, err := os.ReadFile(indexHTML); err == nil {
		indexHTMLContent = strings.ReplaceAll(string(b), "__BUILD_VERSION__", cfg.AppVersion)
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

	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", authHandler.Login, authLimiter)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.GET("/me", authHandler.Me, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	authGroup.POST("/change-password", authHandler.ChangePassword, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
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

	// API route groups — registered per domain (see routes.go).
	registerPostRoutes(e, postHandler, svcs)
	registerTagRoutes(e, tagHandler, svcs)
	registerMediaRoutes(e, mediaHandler, svcs)
	registerSettingsRoutes(e, settingsHandler, svcs)
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
	pagesGroup := e.Group("/api/pages")
	pagesGroup.GET("/home", pagesHandler.GetHomePage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags/:slug", pagesHandler.GetTagPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags", pagesHandler.GetTagsPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/graph", pagesHandler.GetTagsGraph, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/graph/tag/:id", pagesHandler.GetTagCloud, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/map", pagesHandler.GetMapPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/nav", pagesHandler.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))

	// ── Timeline Routes ────────────────────────────────────────────────────────
	timelineGroup := e.Group("/api/timeline")
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
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath, indexHTMLContent, repo, svcs.Media, svcs.Settings, chunkMap, cssMap), api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	if fi, err := os.Stat(frontendDir); err == nil && fi.IsDir() {
		cssDir := filepath.Join(frontendDir, "css")
		imagesDir := filepath.Join(frontendDir, "images")
		vendorDir := filepath.Join(frontendDir, "vendor")

		if fi, err := os.Stat(cssDir); err == nil && fi.IsDir() {
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
			// The same image serves several sites (darii.net, point.photos), so
			// the installed-app name comes from the host the manifest was
			// fetched from rather than the file's placeholder name.
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
			if slug, ok := strings.CutPrefix(path, "/posts/"); ok {
				post, err := svcs.Post.GetPostBySlug(c.Request().Context(), slug)
				if err == nil && strings.EqualFold(post.Status, "published") {
					{
						htmlStr := indexHTMLContent
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
			{
				script, hash := pluginManifestScript(c.Request().Context(), svcs.Settings, chunkMap, cssMap)
				htmlStr := strings.Replace(indexHTMLContent, "</head>", script+"\n</head>", 1)

				csp := c.Response().Header().Get("Content-Security-Policy")
				csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
				c.Response().Header().Set("Content-Security-Policy", csp)

				return c.HTML(http.StatusOK, htmlStr)
			}
		}
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Frontend not available — build the frontend first",
		})
	})

	return e
}

func main() {
	// Initialize slog with TextHandler for logfmt output
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
	slog.SetDefault(logger)

	// Redirect standard log to slog to handle legacy log.Printf calls
	log.SetOutput(slog.NewLogLogger(logger.Handler(), slog.LevelInfo).Writer())
	log.SetFlags(0)

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

	// Apply DB schema + data migrations (see internal/migrations).
	migrations.Run(ctx, repo)

	// Ensure a secret key is available for session signing.
	if err := svcs.Settings.EnsureSecretKey(ctx, &cfg); err != nil {
		slog.Error("failed to ensure secret key", "error", err)
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
		if err := e.Start(address); err != nil && err != http.ErrServerClosed {
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
func serveSimplifiedMedia(storagePath, indexHTMLContent string, repo repository.Repository, mediaSvc *services.MediaService, settings *services.SettingsService, chunks map[string]string, cssMap map[string]bool) echo.HandlerFunc {
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
				return echo.NewHTTPError(http.StatusNotFound, "media not found")
			}
		}

		// Enforce visibility: unauthenticated clients cannot access private media.
		if media.IsPublic == 0 && !isAuthenticated {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		// Media files can be renamed or replaced at the same URL (e.g. rename to
		// name.png, delete, re-upload a different image, rename again to name.png).
		// Without this header browsers use heuristic caching and serve the stale
		// version. no-cache still allows local caching but requires revalidation,
		// so a 304 is returned on repeated loads when nothing changed.
		c.Response().Header().Set("Cache-Control", "no-cache")

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
		}

		// Serve original — try exact path first, then checksum-glob fallback.
		origDir := filepath.Join(storagePath, "media", "originals", year, month)
		origFile := filepath.Clean(filepath.Join(origDir, filepath.Base(filename)))

		// Security: ensure the resolved file is within the expected originals directory.
		if !strings.HasPrefix(origFile, filepath.Join(storagePath, "media", "originals")) {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		if _, err := os.Stat(origFile); err == nil {
			return c.File(origFile)
		}
		if m := checksumRe.FindStringSubmatch(filename); m != nil {
			matches, _ := filepath.Glob(filepath.Join(origDir, "*_"+m[1]+".*"))
			if len(matches) == 1 {
				matchFile := filepath.Clean(filepath.Join(origDir, filepath.Base(matches[0])))
				// Security: double-check the globbed file prefix.
				if strings.HasPrefix(matchFile, filepath.Join(storagePath, "media", "originals")) {
					return c.File(matchFile)
				}
			}
		}

		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
}
