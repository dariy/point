package main

import (
	"context"
	"fmt"
	"html"
	"log"
	"net/http"
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
	"point-api/internal/repository"
	"point-api/internal/services"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
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
func resolveJSDir(frontendDir string) string {
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
}

func initServices(cfg *config.Config, repo repository.Repository) *AppServices {
	settingsService := services.NewSettingsService(repo)
	authService := services.NewAuthService(repo)
	apiKeyService := services.NewApiKeyService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService)
	systemService := services.NewSystemService(repo, cfg.StoragePath)
	cacheService := services.NewCacheService(cfg.StoragePath)
	schedulerService := services.NewSchedulerService(authService, postService, systemService, mediaService, settingsService)
	themeService := services.NewThemeService(cfg, settingsService)
	timelineService := services.NewTimelineService(repo)

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
	}
}

func setupEcho(cfg config.Config, repo repository.Repository, svcs *AppServices) *echo.Echo {
	// Initialize Echo

	e := echo.New()
	e.HideBanner = true
	e.HTTPErrorHandler = api.CustomHTTPErrorHandler

	// Handlers
	authHandler := api.NewAuthHandler(svcs.Auth, &cfg, repo)
	apiKeyHandler := api.NewApiKeyHandler(svcs.ApiKey)
	tagHandler := api.NewTagHandler(svcs.Tag, svcs.Settings)
	postHandler := api.NewPostHandler(svcs.Post, svcs.Settings, svcs.Media, svcs.Tag)
	mediaHandler := api.NewMediaHandler(svcs.Media, svcs.Settings)
	settingsHandler := api.NewSettingsHandler(svcs.Settings)
	themeHandler := api.NewThemeHandler(svcs.Theme)
	systemHandler := api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, cfg.StoragePath, cfg.AppVersion)
	feedsHandler := api.NewFeedsHandler(repo, svcs.Post, svcs.Tag, svcs.Settings, svcs.Cache)
	pagesHandler := api.NewPagesHandler(repo, svcs.Post, svcs.Tag, svcs.Media, svcs.Settings, svcs.Cache)
	timelineHandler := api.NewTimelineHandler(svcs.Timeline, svcs.Settings)
	setupHandler := api.NewSetupHandler(svcs.Auth, svcs.Settings, repo)
	navMenuHandler := api.NewNavMenuHandler(svcs.Settings)

	// WebAuthn handler — nil service if AppURL is not configured (passkeys require HTTPS + known origin)
	var webauthnSvc *services.WebAuthnService
	if cfg.AppURL != "" {
		origin := services.SanitizeOrigin(cfg.AppURL)
		rpID := services.GetRPIDFromURL(cfg.AppURL)
		if origin != "" && rpID != "" {
			var waErr error
			webauthnSvc, waErr = services.NewWebAuthnService(repo, rpID, cfg.AppName, origin)
			if waErr != nil {
				log.Printf("warning: WebAuthn service init failed: %v", waErr)
			}
		}
	}
	webAuthnHandler := api.NewWebAuthnHandler(webauthnSvc, svcs.Auth, &cfg)

	// Global middleware
	e.Use(middleware.RequestLogger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"*"},
		AllowCredentials: true,
	}))
	e.Use(middleware.SecureWithConfig(middleware.SecureConfig{
		XSSProtection:         "1; mode=block",
		ContentTypeNosniff:    "nosniff",
		XFrameOptions:         "DENY",
		ContentSecurityPolicy: "default-src 'self'; script-src 'self' 'sha256-+20twPiohHfGLZsSvahDBaYeh7l+te5yNz5UDCAfqsA='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.basemaps.cartocdn.com; media-src 'self' blob:; connect-src 'self' https://*.basemaps.cartocdn.com; frame-ancestors 'none'",
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

	// Resolve index.html path once — used by the SPA fallback and the media shortcut.
	indexHTML := filepath.Join(cfg.FrontendDir, "index.html")

	// ── Public health check ────────────────────────────────────────────────────
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{
			"status":  "ok",
			"version": cfg.AppVersion,
		})
	})

	// ── Feed routes (crawlers & feed readers) ──────────────────────────────────
	e.GET("/feed.xml", feedsHandler.RSSFeed)
	e.GET("/sitemap.xml", feedsHandler.Sitemap)
	e.GET("/robots.txt", feedsHandler.RobotsTxt)

	// ── Setup Routes (unauthenticated — first-run wizard) ──────────────────────
	e.GET("/api/setup/status", setupHandler.SetupStatus)
	e.POST("/api/setup", setupHandler.Setup)

	// ── Auth Routes ────────────────────────────────────────────────────────────
	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", authHandler.Login)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.GET("/me", authHandler.Me, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	authGroup.POST("/change-password", authHandler.ChangePassword, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.GET("/sessions", authHandler.ListSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions/:id", authHandler.DeleteSession, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/sessions", authHandler.DeleteOtherSessions, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/forgot-password", authHandler.ForgotPassword)
	authGroup.POST("/reset-password", authHandler.ResetPassword)

	// API Key Management
	authGroup.GET("/api-keys", apiKeyHandler.ListKeys, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/api-keys", apiKeyHandler.CreateKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.POST("/api-keys/:id/revoke", apiKeyHandler.RevokeKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	authGroup.DELETE("/api-keys/:id", apiKeyHandler.DeleteKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)

	// ── WebAuthn / Passkey Routes ──────────────────────────────────────────────
	webauthnGroup := e.Group("/api/auth/webauthn")
	webauthnGroup.POST("/register/begin", webAuthnHandler.BeginRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/register/finish", webAuthnHandler.FinishRegistration, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
	webauthnGroup.POST("/login/begin", webAuthnHandler.BeginLogin)
	webauthnGroup.POST("/login/finish", webAuthnHandler.FinishLogin)
	webauthnGroup.GET("/status", webAuthnHandler.GetStatus, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	webauthnGroup.DELETE("/credential", webAuthnHandler.DeleteCredential, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)

	// ── Post Routes ────────────────────────────────────────────────────────────
	postsGroup := e.Group("/api/posts")
	postsGroup.GET("", postHandler.ListPosts, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/analytics", postHandler.GetPostAnalytics, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("", postHandler.CreatePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/audio", postHandler.CreateAudioPost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/slug/:slug", postHandler.GetPostBySlug, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/:slug/page", postHandler.GetPostPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/:id", postHandler.GetPostByID, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.PUT("/:id", postHandler.UpdatePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.PATCH("/:id/tags", postHandler.UpdatePostTags, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.DELETE("/:id", postHandler.DeletePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/restore", postHandler.RestorePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.DELETE("/:id/permanent", postHandler.PermanentlyDeletePost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/:id/navigation", postHandler.GetPostNavigation, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/publish", postHandler.PublishPost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.POST("/:id/withdraw", postHandler.WithdrawPost, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	postsGroup.GET("/preview/:token", postHandler.GetPostByPreviewToken)
	postsGroup.POST("/:id/preview", postHandler.GeneratePreviewLink, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Tag Routes ─────────────────────────────────────────────────────────────
	tagsGroup := e.Group("/api/tags")
	tagsGroup.GET("", tagHandler.ListTags, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/cloud", tagHandler.GetTagCloud, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("", tagHandler.CreateTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/recalculate-counts", tagHandler.RecalculateCounts, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/id/:id", tagHandler.GetTagByID, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/slug/:slug", tagHandler.GetTagBySlug, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.GET("/slug/:slug/posts", tagHandler.GetPostsByTag, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.PUT("/:id", tagHandler.UpdateTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.DELETE("/:id", tagHandler.DeleteTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/reorder", tagHandler.ReorderTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	tagsGroup.POST("/:id/geocode", tagHandler.GeocodeTag, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Media Routes ───────────────────────────────────────────────────────────
	mediaGroup := e.Group("/api/media")
	mediaGroup.GET("", mediaHandler.ListMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/folders", mediaHandler.GetMediaFolders, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/upload", mediaHandler.UploadFile, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/upload/multiple", mediaHandler.UploadMultiple, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/analyze", mediaHandler.AnalyzeImage, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/analyze-path", mediaHandler.AnalyzeImageByPath, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/stats", mediaHandler.GetStorageStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/orphaned", mediaHandler.ListOrphanedMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.DELETE("/orphaned", mediaHandler.DeleteOrphanedMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/bulk-delete", mediaHandler.BulkDeleteMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/thumbnails/rebuild", mediaHandler.RebuildThumbnails, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.GET("/:id", mediaHandler.GetMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PUT("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PATCH("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/rename", mediaHandler.RenameMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/analyze", mediaHandler.AnalyzeImageByID, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/reextract", mediaHandler.ReextractEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PUT("/:id/exif", mediaHandler.UpdateEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/revert-exif", mediaHandler.RevertEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.DELETE("/:id", mediaHandler.DeleteMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Settings Routes ────────────────────────────────────────────────────────
	settingsGroup := e.Group("/api/settings")
	settingsGroup.GET("/public", settingsHandler.GetPublicSettings)
	settingsGroup.GET("", settingsHandler.GetSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.GET("/:key", settingsHandler.GetSettingByKey, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.PUT("", settingsHandler.UpdateSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	settingsGroup.PATCH("", settingsHandler.UpdateSettings, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Themes Routes ──────────────────────────────────────────────────────────
	themesGroup := e.Group("/api/themes")
	themesGroup.GET("", themeHandler.ListThemes)
	themesGroup.GET("/active", themeHandler.GetActiveTheme)
	themesGroup.PUT("/active", themeHandler.SetActiveTheme, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── System Routes ──────────────────────────────────────────────────────────
	systemGroup := e.Group("/api/system")
	systemGroup.GET("/stats", systemHandler.GetStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/disk", systemHandler.GetDiskInfo, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/logs", systemHandler.GetLogs, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/migrations", systemHandler.GetMigrations, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/cache/clear", systemHandler.ClearCache, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/map/update-coords", systemHandler.UpdateMapCoords, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/media/recalculate-visibility", systemHandler.RecalculateMediaVisibility, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/backup", systemHandler.CreateBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/backups", systemHandler.ListBackups, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/backups/:filename/restore", systemHandler.RestoreBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.DELETE("/backups/:filename", systemHandler.DeleteBackup, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/offline/stats", systemHandler.GetOfflineStats, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/offline/snapshot", systemHandler.GetOfflineSnapshot, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/media/scan", systemHandler.ScanMediaImport, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/photo-library", systemHandler.GetPhotoLibraryContents, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.POST("/photo-library/import", systemHandler.ImportSelectedPhotos, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/photo-library/file", systemHandler.GetPhotoLibraryFile, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	systemGroup.GET("/version", systemHandler.GetVersion, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Nav Menu Routes (admin) ────────────────────────────────────────────────
	e.GET("/api/nav-menu", navMenuHandler.GetAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	e.PUT("/api/nav-menu", navMenuHandler.UpdateAdminNavMenu, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Utility Routes ─────────────────────────────────────────────────────────
	utilGroup := e.Group("/api/util")
	utilGroup.GET("/parse-maps-coords", api.ParseMapsCoords, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Page compound data Routes (for SPA) ────────────────────────────────────
	pagesGroup := e.Group("/api/pages")
	pagesGroup.GET("/home", pagesHandler.GetHomePage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags/:slug", pagesHandler.GetTagPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/tags", pagesHandler.GetTagsPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/map", pagesHandler.GetMapPage, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	pagesGroup.GET("/nav", pagesHandler.GetNavMenu, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Timeline Routes ────────────────────────────────────────────────────────
	timelineGroup := e.Group("/api/timeline")
	timelineGroup.GET("", timelineHandler.GetTimeline, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))
	timelineGroup.GET("/locations", timelineHandler.GetTimelineLocations, api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Media file serving: /YYYY/MM/filename[?thumb] ─────────────────────────
	// Auth-gated: unauthenticated clients see 404 for non-public media.
	// Registered after /api routes to avoid collisions (e.g. /api/settings/public).
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath, indexHTML, repo), api.OptionalAuthMiddleware(svcs.Auth, svcs.ApiKey))

	// ── Frontend SPA + static assets ──────────────────────────────────────────
	frontendDir := cfg.FrontendDir
	if fi, err := os.Stat(frontendDir); err == nil && fi.IsDir() {
		cssDir := filepath.Join(frontendDir, "css")
		imagesDir := filepath.Join(frontendDir, "images")
		vendorDir := filepath.Join(frontendDir, "vendor")

		if fi, err := os.Stat(cssDir); err == nil && fi.IsDir() {
			e.Static("/assets/css", cssDir)
		}
		if jsDir := resolveJSDir(frontendDir); jsDir != "" {
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
			return c.File(manifestPath)
		})
	}
	if fi, err := os.Stat(filepath.Join(cfg.FrontendDir, "sw.js")); err == nil && !fi.IsDir() {
		swPath := filepath.Join(cfg.FrontendDir, "sw.js")
		e.GET("/sw.js", func(c echo.Context) error {
			c.Response().Header().Set("Cache-Control", "no-cache")
			return c.File(swPath)
		})
	}

	// ── SPA fallback — must be last ────────────────────────────────────────────
	e.GET("/*", func(c echo.Context) error {
		if _, err := os.Stat(indexHTML); err == nil {
			path := c.Request().URL.Path
			if slug, ok := strings.CutPrefix(path, "/posts/"); ok {
				post, err := svcs.Post.GetPostBySlug(c.Request().Context(), slug)
				if err == nil && strings.EqualFold(post.Status, "published") {
					b, err := os.ReadFile(indexHTML)
					if err == nil {
						htmlStr := string(b)
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
						}

						sb.WriteString("\n  <meta property=\"og:type\" content=\"article\">")
						fmt.Fprintf(&sb, "\n  <meta property=\"og:title\" content=\"%s\">", html.EscapeString(post.Title))

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
							fmt.Fprintf(&sb, "\n  <meta property=\"og:image\" content=\"%s\">", html.EscapeString(imgURL))
						}

						sb.WriteString("\n</head>")
						htmlStr = strings.Replace(htmlStr, "</head>", sb.String(), 1)
						return c.HTML(http.StatusOK, htmlStr)
					}
				}
			}
			return c.File(indexHTML)
		}
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Frontend not available — build the frontend first",
		})
	})

	return e
}

func main() {
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
		log.Println("[INFO] CLI Setup command detected. Initializing...")
		cfg, err := config.LoadConfig(".")
		if err != nil {
			log.Fatalf("setup: failed to load config: %v", err)
		}
		log.Printf("[DEBUG] DATABASE_URL: %q", cfg.DatabaseURL)
		log.Printf("[DEBUG] STORAGE_PATH: %q", cfg.StoragePath)

		repo, err := repository.NewRepository(cfg.DatabaseURL)
		if err != nil {
			log.Fatalf("setup: failed to initialize repository: %v", err)
		}
		svcs := initServices(&cfg, repo)
		log.Println("[INFO] Running CLI setup...")
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
		log.Fatalf("failed to load config: %v", err)
	}
	if cfg.AppVersion == "" || cfg.AppVersion == "dev" {
		cfg.AppVersion = Version
	}

	// Initialize repository
	repo, err := repository.NewRepository(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("failed to initialize repository: %v", err)
	}
	defer func() {
		if err := repo.Close(); err != nil {
			log.Printf("error closing repository: %v", err)
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
			log.Printf("warning: could not create media dir %s: %v", path, err)
		}
	}

	// Apply pending DB migrations.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	migrations := []struct{ name, sql string }{
		{
			"add_tags_include_in_breadcrumbs",
			`ALTER TABLE tags ADD COLUMN include_in_breadcrumbs BOOLEAN NOT NULL DEFAULT 1`,
		},
		{
			"add_tags_sort_order",
			`ALTER TABLE tags ADD COLUMN sort_order INTEGER`,
		},
		{
			"add_media_is_public",
			`ALTER TABLE media ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`,
		},
		{
			"add_media_metadata",
			`ALTER TABLE media ADD COLUMN metadata TEXT`,
		},
		{
			"add_media_original_metadata",
			`ALTER TABLE media ADD COLUMN original_metadata TEXT`,
		},
		{
			"create_media_visibility_log",
			`CREATE TABLE IF NOT EXISTS media_visibility_log (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				media_id   INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
				is_public  INTEGER NOT NULL,
				changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				post_id    INTEGER REFERENCES posts(id) ON DELETE SET NULL
			)`,
		},
		{
			"create_media_visibility_log_index",
			`CREATE INDEX IF NOT EXISTS idx_media_visibility_log_media_id ON media_visibility_log(media_id)`,
		},
		{
			"create_tag_locations_table",
			`CREATE TABLE IF NOT EXISTS tag_locations (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				tag_id INTEGER NOT NULL UNIQUE REFERENCES tags(id) ON DELETE CASCADE,
				latitude FLOAT NOT NULL,
				longitude FLOAT NOT NULL
			)`,
		},
		{
			"create_tag_locations_index",
			`CREATE INDEX IF NOT EXISTS idx_tag_locations_tag_id ON tag_locations(tag_id)`,
		},
		{
			"normalize_post_status_case",
			`UPDATE posts SET status = LOWER(status) WHERE status != LOWER(status)`,
		},
		{
			"add_tags_show_in_ancestors",
			`ALTER TABLE tags ADD COLUMN show_in_ancestors INTEGER NOT NULL DEFAULT 1`,
		},
		{
			"drop_tags_show_in_ancestors",
			`ALTER TABLE tags DROP COLUMN show_in_ancestors`,
		},
		{
			"seed_no_ancestors_system_tag",
			`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
			 VALUES ('_no_ancestors', '_no_ancestors', NULL, 0, CURRENT_TIMESTAMP)`,
		},
		{
			"link_no_ancestors_to_system",
			`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT s.id, c.id FROM tags s, tags c
			 WHERE s.slug = '_system' AND c.slug = '_no_ancestors'`,
		},
		{
			"add_scheduled_at_to_posts",
			`ALTER TABLE posts ADD COLUMN scheduled_at DATETIME`,
		},
		{
			"add_scheduled_at_to_posts_index",
			`CREATE INDEX IF NOT EXISTS idx_posts_scheduled_at ON posts(scheduled_at)`,
		},
		{
			"create_blog_secrets_table",
			`CREATE TABLE IF NOT EXISTS blog_secrets (
				key        VARCHAR(100) PRIMARY KEY,
				value      TEXT,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
		},
		{
			"migrate_gemini_key_to_secrets",
			`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT 'gemini_api_key', value, updated_at FROM blog_settings WHERE key = 'GEMINI_API_KEY'`,
		},
		{
			"migrate_secret_key_to_secrets",
			`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT key, value, updated_at FROM blog_settings WHERE key = '_secret_key'`,
		},
		{
			"migrate_photo_library_path_to_secrets",
			`INSERT OR IGNORE INTO blog_secrets (key, value, updated_at)
			 SELECT 'photo_library_path', value, updated_at FROM blog_settings WHERE key = 'media_import_path'`,
		},
		{
			"cleanup_settings_secrets_keys",
			`DELETE FROM blog_settings WHERE key IN ('GEMINI_API_KEY', '_secret_key', 'media_import_path', 'genai_api_endpoint')`,
		},
		{
			"rename_show_map_to_map_mode",
			`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 SELECT 'map_mode', value, value_type, updated_at FROM blog_settings WHERE key = 'show_map'`,
		},
		{
			"cleanup_show_map_key",
			`DELETE FROM blog_settings WHERE key = 'show_map'`,
		},
		{
			"add_in_timeline_system_tag",
			`INSERT OR IGNORE INTO tags (name, slug, sort_order, post_count, created_at)
			 VALUES ('in_timeline', '_in_timeline', NULL, 0, CURRENT_TIMESTAMP)`,
		},
		{
			"add_in_timeline_to_system",
			`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT s.id, c.id FROM tags s, tags c
			 WHERE s.slug = '_system' AND c.slug = '_in_timeline'`,
		},
		{
			"add_timeline_mode_setting",
			`INSERT OR IGNORE INTO blog_settings (key, value, value_type, updated_at)
			 VALUES ('timeline_mode', 'off', 'string', CURRENT_TIMESTAMP)`,
		},
		{
			"link_year_tags_to_in_timeline",
			`INSERT OR IGNORE INTO tag_relationships (parent_id, child_id)
			 SELECT p.id, t.id FROM tags p, tags t
			 WHERE p.slug = '_in_timeline'
			   AND (t.slug GLOB '[0-9][0-9][0-9][0-9]' OR t.slug GLOB '[0-9][0-9][0-9][0-9]s')`,
		},
		{
			"add_deleted_at_to_posts",
			`ALTER TABLE posts ADD COLUMN deleted_at DATETIME`,
		},
		{
			"add_deleted_at_to_posts_index",
			`CREATE INDEX IF NOT EXISTS idx_posts_deleted_at ON posts(deleted_at)`,
		},
		{
			"create_webauthn_credentials_table",
			`CREATE TABLE IF NOT EXISTS webauthn_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
				credential_id BLOB NOT NULL UNIQUE,
				public_key BLOB NOT NULL,
				aaguid BLOB NOT NULL,
				sign_count INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				last_used_at DATETIME
			)`,
		},
		{
			"create_webauthn_credentials_user_id_index",
			`CREATE INDEX IF NOT EXISTS idx_webauthn_user_id ON webauthn_credentials(user_id)`,
		},
		{
			"add_webauthn_backup_eligible_column",
			`ALTER TABLE webauthn_credentials ADD COLUMN backup_eligible INTEGER NOT NULL DEFAULT 0`,
		},
		{
			"add_webauthn_backup_state_column",
			`ALTER TABLE webauthn_credentials ADD COLUMN backup_state INTEGER NOT NULL DEFAULT 0`,
		},
	}
	for _, m := range migrations {
		if err := repo.ApplyMigration(ctx, m.name, m.sql); err != nil {
			log.Printf("warning: migration %q: %v", m.name, err)
		}
	}

	// Phase A: seed system tags and migrate old boolean flag data into tag_relationships.
	if err := repo.MigrateFlagsToSystemTags(ctx); err != nil {
		log.Printf("warning: system_tags_phase_a: %v", err)
	}
	// Phase B: rebuild tags table to drop the now-migrated boolean columns.
	if err := repo.RebuildTagsTableDropBooleans(ctx); err != nil {
		log.Printf("warning: system_tags_phase_b: %v", err)
	}

	// Ensure all required system tags exist.
	if err := repo.EnsureSystemTags(ctx); err != nil {
		log.Printf("warning: ensure_system_tags: %v", err)
	}

	// Rename all system tags so that name == slug (e.g. "_root", "_pending").
	// This was the first pass — kept so the migration_history entry is preserved.
	if err := repo.ApplyMigration(ctx, "rename_system_tags_to_slug",
		`UPDATE tags SET name = slug WHERE slug LIKE '\_%%' ESCAPE '\'`); err != nil {
		log.Printf("warning: migration %q: %v", "rename_system_tags_to_slug", err)
	}

	// Strip the leading '_' from system tag display names so the UI shows
	// "root", "pending", "hidden", etc. instead of "_root", "_pending".
	if err := repo.ApplyMigration(ctx, "rename_system_tags_names_no_underscore",
		`UPDATE tags SET name = LTRIM(slug, '_') WHERE slug LIKE '\_%%' ESCAPE '\'`); err != nil {
		log.Printf("warning: migration %q: %v", "rename_system_tags_names_no_underscore", err)
	}

	// Drop the UNIQUE constraint from tags.name so that a user tag (e.g. slug="root")
	// can share its name with the system tag (slug="_root"). Only slug stays unique.
	if err := repo.DropTagNameUnique(ctx); err != nil {
		log.Printf("warning: drop_tags_name_unique: %v", err)
	}

	// Ensure a secret key is available for session signing.
	if err := svcs.Settings.EnsureSecretKey(ctx, &cfg); err != nil {
		log.Fatalf("failed to ensure secret key: %v", err)
	}

	// Sync env-var secrets into blog_secrets so they're available at runtime.
	if cfg.GeminiAPIKey != "" {
		if err := svcs.Settings.SetSecret(ctx, "gemini_api_key", cfg.GeminiAPIKey); err != nil {
			log.Printf("warning: failed to sync gemini_api_key to secrets: %v", err)
		}
	}
	if cfg.PhotoLibraryPath != "" {
		if err := svcs.Settings.SetSecret(ctx, "photo_library_path", cfg.PhotoLibraryPath); err != nil {
			log.Printf("warning: failed to sync photo_library_path to secrets: %v", err)
		}
	}

	// Synchronize active theme with public theme.css for the frontend
	if err := svcs.Theme.SyncActiveTheme(ctx); err != nil {
		log.Printf("warning: failed to sync active theme: %v", err)
	}

	e := setupEcho(cfg, repo, svcs)

	// Start background scheduler (goroutines honor ctx cancellation)
	svcs.Scheduler.Start(ctx)

	// Start server
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("Point API starting on %s", address)
	go func() {
		if err := e.Start(address); err != nil && err != http.ErrServerClosed {
			log.Fatalf("failed to start server: %v", err)
		}
	}()

	// Wait for interrupt or SIGTERM
	<-ctx.Done()
	stop()

	log.Println("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown error: %v", err)
	}
	log.Println("graceful shutdown complete")
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
//   - ?thumb serves the thumbnail (media/thumbnails/…) when one exists.
//   - No query param serves the original (media/originals/…).
//
// Non-numeric year/month segments are SPA routes — index.html is served instead.
func serveSimplifiedMedia(storagePath, indexHTML string, repo repository.Repository) echo.HandlerFunc {
	return func(c echo.Context) error {
		year := c.Param("year")
		month := c.Param("month")
		filename := c.Param("filename")

		// Validate year/month are numeric — non-numeric means this is an SPA route.
		yearInt, yearErr := strconv.Atoi(year)
		monthInt, monthErr := strconv.Atoi(month)
		if yearErr != nil || monthErr != nil || yearInt < 1000 || yearInt > 9999 || monthInt < 1 || monthInt > 12 {
			if _, err := os.Stat(indexHTML); err == nil {
				return c.File(indexHTML)
			}
			return c.JSON(http.StatusServiceUnavailable, map[string]string{
				"detail": "Frontend not available — build the frontend first",
			})
		}

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

		// Determine which file to serve.
		_, wantThumb := c.Request().URL.Query()["thumb"]
		if wantThumb {
			if !media.ThumbnailPath.Valid {
				return echo.NewHTTPError(http.StatusNotFound, "no thumbnail available")
			}
			thumbFile := filepath.Join(storagePath, "media", media.ThumbnailPath.String)
			if _, err := os.Stat(thumbFile); err != nil {
				return echo.NewHTTPError(http.StatusNotFound, "thumbnail file missing")
			}
			return c.File(thumbFile)
		}

		// Serve original — try exact path first, then checksum-glob fallback.
		origDir := filepath.Join(storagePath, "media", "originals", year, month)
		origFile := filepath.Clean(filepath.Join(origDir, filename))
		dirPrefix := origDir + string(os.PathSeparator)
		if !strings.HasPrefix(origFile, dirPrefix) {
			return echo.NewHTTPError(http.StatusBadRequest, "invalid path")
		}
		if _, err := os.Stat(origFile); err == nil {
			return c.File(origFile)
		}
		if m := checksumRe.FindStringSubmatch(filename); m != nil {
			matches, _ := filepath.Glob(filepath.Join(origDir, "*_"+m[1]+".*"))
			if len(matches) == 1 {
				matchFile := filepath.Clean(matches[0])
				if !strings.HasPrefix(matchFile, dirPrefix) {
					return echo.NewHTTPError(http.StatusBadRequest, "invalid path")
				}
				return c.File(matchFile)
			}
		}

		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
}
