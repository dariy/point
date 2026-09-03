package main

// routes.go is the one place every HTTP route on this server is registered.
//
// One register*Routes function per domain. Each takes the echo instance, the
// handler(s) it serves, and the shared services the auth/plugin middleware
// needs. setupEcho (main.go) builds the handlers and the global middleware
// chain, then calls these in the order they appear below — and that order is
// load-bearing: `/:year/:month/:filename` has to come after the /api routes,
// the gated plugin-chunk route before the broad /assets/js static route, and
// the `/*` SPA fallback last of all. Keep new registrations in the section
// they belong to rather than appending at the end.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/mcp"
	"point-api/internal/metrics"
	"point-api/internal/plugins"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"golang.org/x/time/rate"
)

// ── Public, unauthenticated ────────────────────────────────────────────────

// registerHealthRoutes exposes the liveness probe. Ungated on purpose:
// container health checks and uptime monitors hit it before the install is
// configured, and publicLimiter skips it by path (see main.go).
func registerHealthRoutes(e *echo.Echo, cfg config.Config) {
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"status":  "ok",
			"version": cfg.AppVersion,
		})
	})
}

// registerFeedRoutes serves crawlers and feed readers. The two feed URLs are
// gated by the rss plugin; sitemap.xml and robots.txt are always on.
func registerFeedRoutes(e *echo.Echo, h *api.FeedsHandler, svcs *AppServices) {
	rssGate := api.RequirePlugin(svcs.Settings, "rss")
	e.GET("/feed.xml", h.RSSFeed, rssGate)
	e.GET("/feed", h.RSSFeed, rssGate) // alias used by the public footer link
	e.GET("/sitemap.xml", h.Sitemap)
	e.GET("/robots.txt", h.RobotsTxt)
}

// registerSetupRoutes is the first-run wizard — unauthenticated, because there
// is no owner to authenticate against yet.
func registerSetupRoutes(e *echo.Echo, h *api.SetupHandler) {
	e.GET("/api/setup/status", h.SetupStatus)
	e.POST("/api/setup", h.Setup)
}

// ── Auth, sessions, passkeys ───────────────────────────────────────────────

// newCredentialLimiter builds the brute-force throttle for credential
// endpoints, keyed by client IP (the default identifier). One shared store →
// the bucket is spent across all of login/forgot/reset/passkey, so an attacker
// can't fan out across them. ~10 burst, refilling 1 every 6s (≈10/min
// sustained).
//
// Pass one instance to both registerAuthRoutes and registerWebAuthnRoutes:
// giving the passkey login its own limiter would hand an attacker a second,
// independent bucket for the same secret.
func newCredentialLimiter(reg *metrics.Registry) echo.MiddlewareFunc {
	return middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: middleware.NewRateLimiterMemoryStoreWithConfig(middleware.RateLimiterMemoryStoreConfig{
			Rate:      rate.Every(6 * time.Second),
			Burst:     10,
			ExpiresIn: 10 * time.Minute,
		}),
		DenyHandler: countRateLimited(reg, metrics.LimiterCredential),
	})
}

func registerAuthRoutes(e *echo.Echo, h *api.AuthHandler, keys *api.ApiKeyHandler, svcs *AppServices, credLimiter echo.MiddlewareFunc) {
	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", h.Login, credLimiter)
	authGroup.POST("/logout", h.Logout)
	authGroup.GET("/me", h.Me, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	authGroup.POST("/change-password", h.ChangePassword, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/change-email", h.ChangeEmail, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.GET("/sessions", h.ListSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions/:id", h.DeleteSession, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions", h.DeleteOtherSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/forgot-password", h.ForgotPassword, credLimiter)
	authGroup.POST("/reset-password", h.ResetPassword, credLimiter)

	// API Key Management — session-only: minting a key is not itself a key action.
	authGroup.GET("/api-keys", keys.ListKeys, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.POST("/api-keys", keys.CreateKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.POST("/api-keys/:id/revoke", keys.RevokeKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
	authGroup.DELETE("/api-keys/:id", keys.DeleteKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "api-keys"))
}

func registerWebAuthnRoutes(e *echo.Echo, h *api.WebAuthnHandler, svcs *AppServices, credLimiter echo.MiddlewareFunc) {
	webauthnGroup := e.Group("/api/auth/webauthn", api.RequirePlugin(svcs.Settings, "passkeys"))
	webauthnGroup.POST("/register/begin", h.BeginRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/register/finish", h.FinishRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/login/begin", h.BeginLogin, credLimiter)
	webauthnGroup.POST("/login/finish", h.FinishLogin, credLimiter)
	webauthnGroup.GET("/status", h.GetStatus, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	webauthnGroup.DELETE("/credential", h.DeleteCredential, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
}

// ── Content APIs ───────────────────────────────────────────────────────────

func registerPostRoutes(e *echo.Echo, h *api.PostHandler, svcs *AppServices) {
	// Public read endpoints carry visibilityCache so an anonymous GET is
	// edge-cacheable (see main.go). Applied per-route rather than group-wide
	// because this group also holds an admin GET (/analytics) and the secret
	// GET /preview/:token, neither of which should be cached.
	postsGroup := e.Group("/api/posts")
	postsGroup.GET("", h.ListPosts, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	postsGroup.GET("/analytics", h.GetPostAnalytics, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("", h.CreatePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/preview-render", h.PreviewRender, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/slug/:slug", h.GetPostBySlug, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	postsGroup.GET("/:slug/page", h.GetPostPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	postsGroup.GET("/:id", h.GetPostByID, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	postsGroup.PUT("/:id", h.UpdatePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.PATCH("/:id/status", h.UpdatePostStatus, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.PATCH("/:id/tags", h.UpdatePostTags, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.DELETE("/:id", h.DeletePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/restore", h.RestorePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.DELETE("/:id/permanent", h.PermanentlyDeletePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/:id/navigation", h.GetPostNavigation, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
	postsGroup.POST("/:id/publish", h.PublishPost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/withdraw", h.WithdrawPost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/preview/:token", h.GetPostByPreviewToken)
	postsGroup.POST("/:id/preview", h.GeneratePreviewLink, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/instagram/publish", h.PublishToInstagram, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

func registerTagRoutes(e *echo.Echo, h *api.TagHandler, svcs *AppServices) {
	// Every GET in this group is an OptionalAuth public read, so group-level
	// visibilityCache edge-caches anonymous reads; writes (POST/PUT/…) fall to
	// private,no-store via the method check.
	tagsGroup := e.Group("/api/tags", visibilityCache)
	tagsGroup.GET("", h.ListTags, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/cloud", h.GetTagCloud, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("", h.CreateTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/recalculate-counts", h.RecalculateCounts, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/id/:id", h.GetTagByID, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/slug/:slug", h.GetTagBySlug, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/slug/:slug/posts", h.GetPostsByTag, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.PUT("/:id", h.UpdateTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.PATCH("/:id", h.PatchTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.DELETE("/:id", h.DeleteTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.PUT("/:id/parents", h.SetTagParents, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.PUT("/:id/children", h.SetTagChildren, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/move", h.MoveTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/merge", h.MergeTags, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/reorder", h.ReorderTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/geocode", h.GeocodeTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

func registerMediaRoutes(e *echo.Echo, h *api.MediaHandler, svcs *AppServices) {
	mediaGroup := e.Group("/api/media")
	mediaGroup.GET("", h.ListMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/folders", h.GetMediaFolders, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/upload", h.UploadFile, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/upload/multiple", h.UploadMultiple, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/analyze", h.AnalyzeImage, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "ai-analysis"))
	mediaGroup.POST("/analyze-path", h.AnalyzeImageByPath, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "ai-analysis"))
	mediaGroup.GET("/stats", h.GetStorageStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/orphaned", h.ListOrphanedMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.DELETE("/orphaned", h.DeleteOrphanedMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/bulk-delete", h.BulkDeleteMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/thumbnails/rebuild", h.RebuildThumbnails, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/:id", h.GetMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PUT("/:id", h.UpdateMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PATCH("/:id", h.UpdateMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/rename", h.RenameMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/poster", h.SetVideoPoster, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/analyze", h.AnalyzeImageByID, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "ai-analysis"))
	mediaGroup.POST("/:id/reextract", h.ReextractEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PUT("/:id/exif", h.UpdateEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/revert-exif", h.RevertEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.DELETE("/:id", h.DeleteMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

func registerSettingsRoutes(e *echo.Echo, h *api.SettingsHandler, svcs *AppServices, setupComplete func(context.Context) bool) {
	settingsGroup := e.Group("/api/settings")
	// noStoreBeforeSetup is listed last so it runs after visibilityCache and can
	// override it: the empty settings of a not-yet-configured install must not
	// survive in a cache across the setup hand-off.
	settingsGroup.GET("/public", h.GetPublicSettings, visibilityCache, noStoreBeforeSetup(setupComplete))
	settingsGroup.GET("", h.GetSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.GET("/:key", h.GetSettingByKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.PUT("", h.UpdateSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.PATCH("", h.UpdateSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

func registerPluginRoutes(e *echo.Echo, h *api.PluginsHandler, svcs *AppServices) {
	pluginsGroup := e.Group("/api/plugins")
	pluginsGroup.GET("", h.ListPlugins, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	// Preset routes are registered before /:id so the static "presets" segment wins.
	pluginsGroup.GET("/presets", h.GetPresets, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	pluginsGroup.PUT("/presets/:id", h.UpdatePreset, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	pluginsGroup.POST("/presets/:id/apply", h.ApplyPreset, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	pluginsGroup.PATCH("/:id", h.TogglePlugin, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

// registerCarouselRoutes mounts the carousel plugin's document API. The post id
// rides in ?post=<id> on every verb. RequirePlugin runs before auth, so a
// disabled plugin 404s exactly like a route that was never registered instead
// of falling through to the SPA shell.
func registerCarouselRoutes(e *echo.Echo, h *api.CarouselHandler, svcs *AppServices) {
	g := e.Group("/api/carousel",
		api.RequirePlugin(svcs.Settings, "carousel"),
		api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	g.GET("", h.GetCarousel)
	g.PUT("", h.SaveCarousel)
	g.DELETE("", h.DeleteCarousel)
}

func registerInstagramRoutes(e *echo.Echo, h *api.InstagramHandler, svcs *AppServices) {
	igGroup := e.Group("/api/instagram", api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "instagram"))
	igGroup.GET("/connect", h.Connect)
	igGroup.GET("/callback", h.Callback)
	igGroup.POST("/disconnect", h.Disconnect)
	igGroup.GET("/status", h.Status)
	igGroup.POST("/import", h.StartImport)
	igGroup.GET("/import/status", h.GetImportStatus)
}

func registerThemeRoutes(e *echo.Echo, h *api.ThemeHandler, svcs *AppServices) {
	themesGroup := e.Group("/api/themes")
	themesGroup.GET("", h.ListThemes, visibilityCache)
	themesGroup.GET("/active", h.GetActiveTheme, visibilityCache)
	themesGroup.PUT("/active", h.SetActiveTheme, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	themesGroup.GET("/custom-css", h.GetCustomCSS, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "custom-css"))
	themesGroup.PUT("/custom-css", h.UpdateCustomCSS, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "custom-css"))
}

func registerSystemRoutes(e *echo.Echo, h *api.SystemHandler, svcs *AppServices) {
	systemGroup := e.Group("/api/system")
	systemGroup.GET("/stats", h.GetStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/health", h.GetHealth, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/disk", h.GetDiskInfo, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/logs", h.GetLogs, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/migrations", h.GetMigrations, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/cache/clear", h.ClearCache, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/map/update-coords", h.UpdateMapCoords, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/media/recalculate-visibility", h.RecalculateMediaVisibility, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/audit/post-links", h.AuditPostLinks, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/backup", h.CreateBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "backups"))
	systemGroup.GET("/backups", h.ListBackups, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "backups"))
	systemGroup.POST("/backups/:filename/restore", h.RestoreBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "backups"))
	systemGroup.DELETE("/backups/:filename", h.DeleteBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "backups"))
	// Move out: re-enter password to authorize, then a one-time-token GET streams the archive.
	systemGroup.POST("/backups/:filename/authorize-download", h.AuthorizeBackupDownload, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "backups"))
	systemGroup.GET("/backups/:filename/download", h.DownloadBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "backups"))
	// Move in: upload a local archive (password in X-Confirm-Password header) to overwrite everything.
	systemGroup.POST("/backups/upload", h.UploadBackupArchive, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware, api.RequirePlugin(svcs.Settings, "backups"))
	systemGroup.GET("/offline/stats", h.GetOfflineStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/offline/snapshot", h.GetOfflineSnapshot, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/media/scan", h.ScanMediaImport, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/photo-library", h.GetPhotoLibraryContents, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/photo-library/import", h.ImportSelectedPhotos, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/photo-library/file", h.GetPhotoLibraryFile, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/version", h.GetVersion, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "version-check"))
	// Manual re-check from the plugin's settings drawer: bypasses the 24h cache.
	systemGroup.POST("/version/check", h.CheckVersion, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "version-check"))
	// Restart the process in place (re-exec). Session-only: not an API-key action.
	systemGroup.POST("/restart", h.RestartServer, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
}

// ── Plugin surfaces and sidecars ───────────────────────────────────────────

// mcpHandlers is the set of REST handlers the MCP server reuses for all data
// access — it has no data path of its own (see mcp.Register / mcpServiceClient).
type mcpHandlers struct {
	Post     *api.PostHandler
	Tag      *api.TagHandler
	Media    *api.MediaHandler
	Theme    *api.ThemeHandler
	Settings *api.SettingsHandler
	System   *api.SystemHandler
}

// registerMCPRoutes mounts the in-process Model Context Protocol server: the
// streamable /mcp endpoint plus the OAuth 2.1 discovery and token routes. Gated
// by the "mcp" plugin inside mcp.Register.
func registerMCPRoutes(e *echo.Echo, cfg config.Config, repo repository.Repository, svcs *AppServices, h mcpHandlers) {
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
		Post:            h.Post,
		Tag:             h.Tag,
		Media:           h.Media,
		Theme:           h.Theme,
		Settings:        h.Settings,
		System:          h.System,
		Auth:            svcs.Auth,
		ApiKey:          svcs.ApiKey,
		SettingsService: svcs.Settings,
		Repo:            repo,
		OwnerUserID:     mcpOwnerID,
		BaseURL:         mcpBaseURL,
		Version:         cfg.AppVersion,
		UploadRoot:      cfg.PhotoLibraryPath,
		Metrics:         svcs.Metrics,
	})
}

// registerCommentRoutes wires the comments plugin to the remark42 sidecar that
// entrypoint.sh starts on loopback: a gated reverse proxy at /comments — its
// only external access path — plus the moderation endpoints the
// /light/comments admin page calls. ADMIN_PASSWD is generated and exported by
// entrypoint.sh when the sidecar is configured.
func registerCommentRoutes(e *echo.Echo, svcs *AppServices) {
	remark42URL, _ := url.Parse("http://127.0.0.1:8081")
	api.RegisterCommentsProxy(e, svcs.Settings, remark42URL)

	commentsAdmin := api.NewCommentsAdminHandler(remark42URL, os.Getenv("ADMIN_PASSWD"))
	commentsAdminGroup := e.Group("/api/admin/comments", api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "comments"))
	commentsAdminGroup.GET("/recent", commentsAdmin.Recent)
	commentsAdminGroup.GET("/blocked", commentsAdmin.Blocked)
	commentsAdminGroup.DELETE("/comment/:id", commentsAdmin.DeleteComment)
	commentsAdminGroup.PUT("/user/:id/block", commentsAdmin.SetBlock)
}

// registerNavMenuRoutes is the admin editor for the menu. The public read is
// GET /api/pages/nav (see registerPageRoutes).
func registerNavMenuRoutes(e *echo.Echo, h *api.NavMenuHandler, svcs *AppServices) {
	e.GET("/api/nav-menu", h.GetAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))
	e.PUT("/api/nav-menu", h.UpdateAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))
}

func registerUtilRoutes(e *echo.Echo, svcs *AppServices) {
	utilGroup := e.Group("/api/util")
	utilGroup.GET("/parse-maps-coords", api.ParseMapsCoords, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

// ── Compound page payloads for the SPA ─────────────────────────────────────

// registerPageRoutes serves the compound payloads the public SPA fetches to
// render a page in one call.
func registerPageRoutes(e *echo.Echo, h *api.PagesHandler, svcs *AppServices) {
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

	// visibilityCache is group-level: every route here is an OptionalAuth public
	// read, so an anonymous GET is edge-cacheable (authenticated reads and any
	// write get private,no-store). These are the compound payloads the public SPA
	// fetches to render a page, so caching them offloads the flood's follow-on
	// /api traffic alongside the HTML shell.
	pagesGroup := e.Group("/api/pages", visibilityCache)
	pagesGroup.GET("/home", h.GetHomePage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags/:slug", h.GetTagPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags", h.GetTagsPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/graph", h.GetTagsGraph, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), graphLimiter)
	pagesGroup.GET("/graph/tag/:id", h.GetTagCloud, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), graphLimiter)
	pagesGroup.GET("/map", h.GetMapPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/nav", h.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "nav-menu"))
}

func registerTimelineRoutes(e *echo.Echo, h *api.TimelineHandler, svcs *AppServices) {
	// Both routes are OptionalAuth public reads — group-level visibilityCache.
	timelineGroup := e.Group("/api/timeline", visibilityCache)
	timelineGroup.GET("", h.GetTimeline, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	timelineGroup.GET("/locations", h.GetTimelineLocations, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
}

// ── Media bytes, static assets, PWA, SPA fallback ──────────────────────────
//
// Everything below matches on paths that are not under /api, so it must be
// registered after every /api route (see registerMediaFileRoutes) and the `/*`
// fallback must be registered last of all.

// frontendAssets is the startup-computed frontend state these routes close
// over: the two index.html shells, the resolved JS bundle directory, and the
// plugin chunk/CSS maps. setupEcho builds it once; nothing here changes at
// runtime.
type frontendAssets struct {
	// Dir is cfg.FrontendDir — the root the static trees hang off.
	Dir string
	// JSDir is the bundle actually being served: frontend/js, or frontend/js-debug
	// under FRONTEND_DEBUG. Empty when the frontend was never built.
	JSDir string
	// Shell is the public index.html, version-stamped and with the CSS bundle
	// links rewritten to their content-addressed URLs. Empty when unbuilt, which
	// is what makes the SPA fallback answer 503.
	Shell string
	// AdminShell is the same shell minus the deployment-injected <head> markup.
	AdminShell string
	// ChunkMap maps a plugin id to its hashed chunk filename; CSSMap is the set
	// of plugin ids with a CSS partial on disk.
	ChunkMap map[string]string
	CSSMap   map[string]bool
}

// registerMediaFileRoutes serves the stored originals and thumbnails at
// /YYYY/MM/filename[?s=&v=]. Auth-gated: unauthenticated clients see 404 for
// non-public media. Registered after the /api routes to avoid collisions
// (e.g. /api/settings/public would otherwise match /:year/:month/:filename).
func registerMediaFileRoutes(e *echo.Echo, cfg config.Config, repo repository.Repository, svcs *AppServices, fe frontendAssets) {
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath, fe.Shell, repo, svcs.Media, svcs.S3Presigner, svcs.Settings, fe.ChunkMap, fe.CSSMap), api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey), visibilityCache)
}

// registerStaticRoutes mounts the built frontend's asset trees. Each is guarded
// by its own stat: a partial build serves what exists rather than 500ing, and a
// missing frontend registers nothing at all.
func registerStaticRoutes(e *echo.Echo, svcs *AppServices, fe frontendAssets) {
	if fi, err := os.Stat(fe.Dir); err != nil || !fi.IsDir() {
		return
	}
	cssDir := filepath.Join(fe.Dir, "css")
	imagesDir := filepath.Join(fe.Dir, "images")
	vendorDir := filepath.Join(fe.Dir, "vendor")

	if fi, err := os.Stat(cssDir); err == nil && fi.IsDir() {
		// Serves the whole tree: the bundles at the top level plus the
		// subdirectories under it, notably common/theme.css, which the
		// theme service rewrites at runtime. Content-addressed bundle URLs
		// (light.<hash>.css) have already been rewritten to the plain
		// on-disk name by the Pre middleware in setupEcho.
		e.Static("/assets/css", cssDir)
	}
	if fe.JSDir != "" {
		// Gated plugin-chunk handler: serves /assets/js/p/* only for ENABLED
		// plugins, so disabled code 404s even if a filename is guessed.
		// Registered before the broad /assets/js static route so the more
		// specific prefix wins. Chunks live under <jsDir>/p/.
		pluginChunkDir := filepath.Join(fe.JSDir, "p")
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
			if id, ok := plugins.PluginForChunk(fe.ChunkMap, name); ok {
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
		e.Static("/assets/js", fe.JSDir)
	}
	if fi, err := os.Stat(imagesDir); err == nil && fi.IsDir() {
		e.Static("/assets/images", imagesDir)
	}
	if fi, err := os.Stat(vendorDir); err == nil && fi.IsDir() {
		e.Static("/assets/vendor", vendorDir)
	}
}

// registerPWARoutes serves the web app manifest and the service worker at root
// scope. These must be real files (not index.html) and must be registered
// before the /* SPA fallback that would otherwise intercept them.
func registerPWARoutes(e *echo.Echo, cfg config.Config) {
	manifestPath := filepath.Join(cfg.FrontendDir, "manifest.webmanifest")
	if fi, err := os.Stat(manifestPath); err == nil && !fi.IsDir() {
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
	swPath := filepath.Join(cfg.FrontendDir, "sw.js")
	if fi, err := os.Stat(swPath); err == nil && !fi.IsDir() {
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
}

// registerSPAFallback serves the single-page app shell for every path no route
// above claimed. MUST be registered last — it matches everything.
func registerSPAFallback(e *echo.Echo, svcs *AppServices, fe frontendAssets, setupComplete func(context.Context) bool) {
	e.GET("/*", func(c echo.Context) error {
		if fe.Shell != "" {
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
			shell := fe.Shell
			if isAdminPath(path) || hasSession(c) {
				shell = fe.AdminShell
			}
			// What this URL is about, resolved server side and spliced into
			// the head: a crawler, an unfurler and the tab strip all read the
			// document before any JS runs. seo.go returns the zero value for a
			// route with nothing to say, which renders as the empty string and
			// leaves the shell's own placeholder head alone.
			//
			// The plugin manifest goes in the same splice, so every document —
			// described or not — still boots with __PLUGINS__ and __MEDIA__ set,
			// and the CSP names exactly one inline script hash.
			meta := shellMeta(c, svcs)
			htmlStr := meta.rewriteShell(shell)
			script, hash := bootstrapScript(c.Request().Context(), svcs.Settings, fe.ChunkMap, fe.CSSMap)
			htmlStr = strings.Replace(htmlStr, "</head>", meta.head()+script+"\n</head>", 1)

			csp := c.Response().Header().Get("Content-Security-Policy")
			csp = strings.Replace(csp, "script-src", "script-src 'sha256-"+hash+"'", 1)
			c.Response().Header().Set("Content-Security-Policy", csp)

			return c.HTML(http.StatusOK, htmlStr)
		}
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Frontend not available — build the frontend first",
		})
	}, visibilityCache)
}
