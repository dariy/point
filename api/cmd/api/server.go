package main

// setupEcho assembles the HTTP server from the pieces built elsewhere: the
// services (wiring.go), the handlers (initHandlers), the middleware chain
// (middleware_stack.go), the CSP (csp.go), the HTML shells (loadHTMLShells) and
// the route tables (routes.go). It reads top to bottom as the order the Echo
// router needs; nothing here decides a URL or a header.

import (
	"path/filepath"

	"point-api/internal/config"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

func setupEcho(cfg config.Config, repo repository.Repository, svcs *AppServices) *echo.Echo {
	e := echo.New()
	e.HideBanner = true

	// Handlers wrapping the wired services (see initHandlers in wiring.go).
	h := initHandlers(cfg, repo, svcs)

	// Echo config + the global middleware chain (see middleware_stack.go). The
	// CSS manifest is loaded once here: the cache-control Pre filter needs it,
	// and so does the HTML shell rewrite below.
	cssManifest := loadCSSManifest(filepath.Join(cfg.FrontendDir, "css"))
	installMiddleware(e, cfg, svcs, cssManifest)

	// The two HTML shells (public + admin), stamped and CSS-rewritten once at
	// startup (see loadHTMLShells).
	shell, adminShell := loadHTMLShells(cfg, cssManifest)

	// ── Routes ────────────────────────────────────────────────────────────────
	// Every route this server answers is registered in routes.go. The calls below
	// are in the order the Echo router needs them — see the header comment there
	// before moving one.
	registerHealthRoutes(e, cfg)
	registerFeedRoutes(e, h.Feeds, svcs)
	registerSetupRoutes(e, h.Setup)

	// Blanket per-IP throttle for the whole surface. Added here — after the
	// health/feed/setup routes and last in the e.Use chain — so it sits
	// innermost, inside Recover and Gzip. See newPublicLimiter.
	e.Use(newPublicLimiter(svcs.Metrics))

	// One credential throttle instance, shared by the password and the passkey
	// login paths so the two can't be used as independent buckets against the
	// same secret (see newCredentialLimiter).
	credLimiter := newCredentialLimiter(svcs.Metrics)
	registerAuthRoutes(e, h.Auth, h.ApiKey, svcs, credLimiter)
	registerWebAuthnRoutes(e, h.WebAuthn, svcs, credLimiter)

	// Shared by the pre-setup no-store rule on /api/settings/public and the SPA
	// fallback's redirect to the wizard: one latch, so the "is this install
	// configured yet" query stops running the moment it has an answer.
	setupComplete := newSetupGate(repo)

	registerPostRoutes(e, h.Post, svcs)
	registerTagRoutes(e, h.Tag, svcs)
	registerMediaRoutes(e, h.Media, svcs)
	registerSettingsRoutes(e, h.Settings, svcs, setupComplete)
	registerPluginRoutes(e, h.Plugins, svcs)
	registerInstagramRoutes(e, h.Instagram, svcs)
	registerCarouselRoutes(e, h.Carousel, svcs)
	registerThemeRoutes(e, h.Theme, svcs)
	registerSystemRoutes(e, h.System, svcs)

	registerMCPRoutes(e, cfg, repo, svcs, mcpHandlers{
		Post:     h.Post,
		Tag:      h.Tag,
		Media:    h.Media,
		Theme:    h.Theme,
		Settings: h.Settings,
		System:   h.System,
	})
	registerCommentRoutes(e, svcs)
	registerNavMenuRoutes(e, h.NavMenu, svcs)
	registerUtilRoutes(e, svcs)
	registerPageRoutes(e, h.Pages, svcs)
	registerTimelineRoutes(e, h.Timeline, svcs)

	// ── Frontend: media bytes, static assets, PWA, SPA fallback ───────────────
	// These match paths outside /api, so they are registered last.
	fe := newFrontendAssets(cfg, shell, adminShell)
	registerMediaFileRoutes(e, cfg, repo, svcs, fe)
	registerStaticRoutes(e, svcs, fe)
	registerPWARoutes(e, cfg)
	registerSPAFallback(e, svcs, fe, setupComplete)

	return e
}
