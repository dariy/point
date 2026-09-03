package main

// Echo's own configuration and the global middleware chain: everything that
// wraps every route regardless of which register* call added it. setupEcho
// calls installMiddleware once, before any route is registered; the only
// middleware added later is the public rate limiter (newPublicLimiter), which
// must sit after the health/feed/setup routes.
//
// Order is the contract. The sequence of e.Use / e.Pre calls below is the order
// they run in, and main_test.go pins the resulting header set.

import (
	"fmt"
	"log/slog"
	"net/http"
	"path"
	"path/filepath"
	"strings"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/metrics"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

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

func installMiddleware(e *echo.Echo, cfg config.Config, svcs *AppServices, cssManifest map[string]string) {
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

	// Metrics goes on first, which makes it the outermost wrapper: it is the
	// only position from which the recorded latency is the whole of what the
	// client waited for, and the only one that sees a rate-limiter rejection.
	// Absent entirely when METRICS_ENABLED is off, so the default install pays
	// nothing — not even a nil check.
	if svcs.Metrics != nil {
		e.Use(metricsMiddleware(svcs.Metrics))
	}
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
	e.Use(middleware.RecoverWithConfig(middleware.RecoverConfig{
		// The response is unchanged from middleware.Recover(): returning err
		// from LogErrorFunc still hands it to the centralized error handler,
		// so the client gets the same 500 it always did.
		//
		// What changes is where the panic is reported. Echo's default writes
		// the stack through c.Logger(), which this server never points at slog
		// — so panics went to stderr in Echo's own format and never reached
		// app.log, which is the file the admin Logs page reads and the only one
		// visible from inside a container. They land there now, and they are
		// counted: a recovered panic is otherwise indistinguishable from a
		// failed query, because both are a 500.
		LogErrorFunc: func(c echo.Context, err error, stack []byte) error {
			svcs.Metrics.Panic(metrics.PanicHTTP)
			slog.Error("recovered panic",
				"method", c.Request().Method,
				"uri", c.Request().RequestURI,
				"error", err,
				"stack", string(stack),
			)
			return err
		},
	}))
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
	// The enforcing CSP is assembled once, at startup — the inline-script hashes
	// come from the shell on disk (see csp.go). The per-request bootstrap
	// script's hash is spliced in where index.html is served (see bootstrapScript).
	csp := buildContentSecurityPolicy(
		filepath.Join(cfg.FrontendDir, "index.html"),
		cfg.CSPScriptSrc,
		cfg.CSPConnectSrc,
	)
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
		ContentSecurityPolicy: csp,
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
}

// newPublicLimiter builds the blanket per-IP throttle for the whole surface.
//
// Nothing bounded the public read surface before: /api/posts, /api/pages/*,
// /api/timeline and media byte-serving were all unlimited. Sized to be
// invisible to a real visitor and a real admin — a page load costs a handful
// of API calls plus its images, so 200 burst refilling at 10/s (600/min) is
// far above human use while still bounding a scraper. It applies to
// authenticated requests too: the alternative is keying the exemption off a
// session cookie, which any client can simply present, turning the limiter
// into a formality.
//
// Static assets are skipped: they are plain file serves behind long cache
// headers, and a first page load pulls dozens of them, which would otherwise
// consume the budget the API calls need.
//
// setupEcho adds this last in the e.Use chain, which puts it innermost, inside
// Recover and Gzip.
func newPublicLimiter(reg *metrics.Registry) echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Skipper: func(c echo.Context) bool {
			p := c.Request().URL.Path
			return strings.HasPrefix(p, "/assets/") || p == "/health"
		},
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(100 * time.Millisecond),
			Burst:     200,
			ExpiresIn: 3 * time.Minute,
		}),
		DenyHandler: countRateLimited(reg, metrics.LimiterPublic),
	})
}
