package main

// The HTTP server itself: Echo's own configuration, the global middleware
// chain, the handlers built on top of the wired services, and the HTML shells.
// Individual routes are registered in routes.go; nothing here decides a URL.

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/plugins"
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

// trustedTypesCSP is appended to the enforcing Content-Security-Policy.
//
// require-trusted-types-for 'script' makes every HTML sink — .innerHTML,
// .outerHTML, insertAdjacentHTML — refuse a plain string; only a value minted
// by a registered TrustedTypePolicy gets through, and trusted-types names the
// policies allowed to exist at all. Chromium rejects a write from anywhere
// else at the sink, which is the point: it moves the escaping rule from lint,
// which an author can suppress, to the browser, which nobody can. Firefox and
// Safari ignore the directive entirely, so this is defence in depth on top of
// the lint rule, never a replacement for it.
//
// Three names, and the list is the security claim, so it is worth reading
// literally:
//
//	point           registered in utils/helpers.js, held by setHTML() /
//	                insertHTML() / setScriptSrc() / setScriptJSON(). Every
//	                write this frontend makes goes through it.
//	point-leaflet   frontend/vendor/leaflet/leaflet.js, patched.
//	point-codejar   frontend/vendor/codejar/codejar.js, patched.
//
// The two vendor policies are pass-through: those libraries build their own
// markup and there is no second escaping pass to add. What the split buys is
// that the waiver is *scoped and named*. A pass-through `default` policy — the
// cheap alternative — would have caught every unrouted sink on the page,
// including one reached by injected content, and left the directive decorative.
// These two catch only the writes inside two files that were read line by line
// (fourteen sinks between them; scripts/check-vendor-sinks.sh fails if a
// version bump adds a fifteenth). Prism needed no waiver at all: PostContent
// drives Prism.highlight(), the string-returning form, and writes the result
// with setHTML().
//
// There is no 'allow-duplicates', so each name can be minted exactly once per
// document — the three policies are created at load, and nothing that runs
// later can register another under the same name.
//
// Appending to the enforcing policy means the two script-src splices (the
// shell in routes.go, the media fallback in media.go) now rewrite a header that
// carries directives they did not put there. Both do a single
// strings.Replace on "script-src", which is unaffected by anything appended
// after it; main_bootstrap_test.go pins that.
const trustedTypesCSP = "require-trusted-types-for 'script'; trusted-types point point-leaflet point-codejar"

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

func setupEcho(cfg config.Config, repo repository.Repository, svcs *AppServices) *echo.Echo {
	// Initialize Echo

	e := echo.New()
	e.HideBanner = true

	// Derive the client IP by walking X-Forwarded-For from the right and
	// skipping only trusted hops (loopback + private networks — i.e. our own
	// reverse proxy — plus whatever TRUSTED_PROXIES adds for a deployment whose
	// proxy or CDN answers from a public address). This returns the real client
	// address and ignores any XFF entries an attacker prepends, so c.RealIP()
	// can't be spoofed to dodge the credential rate limiter or poison the
	// session audit trail. Direct (no-proxy) connections fall back to the socket
	// remote address.
	trustOpts := []echo.TrustOption{
		echo.TrustLoopback(true),
		echo.TrustPrivateNet(true),
	}
	trustedNets, err := config.ParseTrustedProxies(cfg.TrustedProxies)
	if err != nil {
		// LoadConfig rejects a malformed list before we get here, so this is a
		// Config built in code. Trust nothing extra: a narrower boundary costs
		// accurate client IPs, a wrong one hands them to the client.
		slog.Error("ignoring TRUSTED_PROXIES", "error", err)
	}
	for _, n := range trustedNets {
		trustOpts = append(trustOpts, echo.TrustIPRange(n))
	}
	e.IPExtractor = echo.ExtractIPFromXFFHeader(trustOpts...)

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
	// bootstrap script's hash is appended where index.html is served (see
	// bootstrapScript).
	scriptSrc := strings.Join(append([]string{"'self'"}, inlineScriptHashes(filepath.Join(cfg.FrontendDir, "index.html"))...), " ")
	connectSrc := "'self' https://server.arcgisonline.com"
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
		ContentSecurityPolicy: "default-src 'self'; script-src " + scriptSrc + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://server.arcgisonline.com https://github.com https://*.githubusercontent.com; media-src 'self' blob:; connect-src " + connectSrc + "; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " + trustedTypesCSP,
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

	// ── Routes ────────────────────────────────────────────────────────────────
	// Every route this server answers is registered in routes.go. The calls below
	// are in the order the Echo router needs them — see the header comment there
	// before moving one.
	registerHealthRoutes(e, cfg)
	registerFeedRoutes(e, feedsHandler, svcs)
	registerSetupRoutes(e, setupHandler)

	// Blanket throttle for the whole surface, keyed by client IP. Nothing bounded
	// the public read surface: /api/posts, /api/pages/*, /api/timeline and media
	// byte-serving were all unlimited.
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
	//
	// Global, and so it lives here rather than in routes.go — last in the e.Use
	// chain, which puts it innermost, inside Recover and Gzip.
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

	// One credential throttle instance, shared by the password and the passkey
	// login paths so the two can't be used as independent buckets against the
	// same secret (see newCredentialLimiter).
	credLimiter := newCredentialLimiter()
	registerAuthRoutes(e, authHandler, apiKeyHandler, svcs, credLimiter)
	registerWebAuthnRoutes(e, webAuthnHandler, svcs, credLimiter)

	// Shared by the pre-setup no-store rule on /api/settings/public and the SPA
	// fallback's redirect to the wizard: one latch, so the "is this install
	// configured yet" query stops running the moment it has an answer.
	setupComplete := newSetupGate(repo)

	registerPostRoutes(e, postHandler, svcs)
	registerTagRoutes(e, tagHandler, svcs)
	registerMediaRoutes(e, mediaHandler, svcs)
	registerSettingsRoutes(e, settingsHandler, svcs, setupComplete)
	registerPluginRoutes(e, pluginsHandler, svcs)
	registerInstagramRoutes(e, instagramHandler, svcs)
	registerThemeRoutes(e, themeHandler, svcs)
	registerSystemRoutes(e, systemHandler, svcs)

	registerMCPRoutes(e, cfg, repo, svcs, mcpHandlers{
		Post:     postHandler,
		Tag:      tagHandler,
		Media:    mediaHandler,
		Theme:    themeHandler,
		Settings: settingsHandler,
		System:   systemHandler,
	})
	registerCommentRoutes(e, svcs)
	registerNavMenuRoutes(e, navMenuHandler, svcs)
	registerUtilRoutes(e, svcs)
	registerPageRoutes(e, pagesHandler, svcs)
	registerTimelineRoutes(e, timelineHandler, svcs)

	// ── Frontend: media bytes, static assets, PWA, SPA fallback ───────────────
	// These match paths outside /api, so they are registered last.
	//
	// Resolve the JS bundle directory once: the release bundle (frontend/js), or
	// the debug bundle (frontend/js-debug) when FRONTEND_DEBUG is set and built.
	// The chunk map MUST come from the same directory we serve so plugin chunk
	// hashes match the bundle the browser loads.
	jsDir := resolveJSDir(cfg.FrontendDir, cfg.FrontendDebug)
	manifestDir := jsDir
	if manifestDir == "" {
		manifestDir = filepath.Join(cfg.FrontendDir, "js")
	}
	fe := frontendAssets{
		Dir:        cfg.FrontendDir,
		JSDir:      jsDir,
		Shell:      indexHTMLContent,
		AdminShell: indexHTMLAdmin,
		// Static build map (plugin id → hashed chunk filename). Empty in Phase 1
		// (no per-plugin chunks built yet), which makes every /assets/js/p/*
		// request 404 and every manifest Entry empty — the intended foundation
		// state.
		ChunkMap: plugins.LoadChunkMap(filepath.Join(manifestDir, "plugin-manifest.json")),
		CSSMap:   plugins.LoadCssMap(filepath.Join(cfg.FrontendDir, "css", "p")),
	}
	registerMediaFileRoutes(e, cfg, repo, svcs, fe)
	registerStaticRoutes(e, svcs, fe)
	registerPWARoutes(e, cfg)
	registerSPAFallback(e, svcs, fe, setupComplete)

	return e
}
