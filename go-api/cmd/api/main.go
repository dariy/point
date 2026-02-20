package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/repository"
	"point-api/internal/services"
)

func main() {
	// Load configuration
	cfg, err := config.LoadConfig(".")
	if err != nil {
		log.Fatalf("failed to load config: %v", err)
	}

	// Initialize repository
	repo, err := repository.NewRepository(cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("failed to initialize repository: %v", err)
	}
	defer repo.Close()

	// Ensure media directories exist
	for _, dir := range []string{"originals", "thumbnails"} {
		path := filepath.Join(cfg.StoragePath, "media", dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			log.Printf("warning: could not create media dir %s: %v", path, err)
		}
	}

	// Initialize Echo
	e := echo.New()
	e.HideBanner = true

	// Services
	settingsService := services.NewSettingsService(repo)
	authService := services.NewAuthService(repo)
	tagService := services.NewTagService(repo)
	postService := services.NewPostService(repo)
	mediaService := services.NewMediaService(repo, &cfg, settingsService)

	// Handlers
	authHandler := api.NewAuthHandler(authService, &cfg)
	tagHandler := api.NewTagHandler(tagService, settingsService)
	postHandler := api.NewPostHandler(postService, settingsService, mediaService)
	mediaHandler := api.NewMediaHandler(mediaService, settingsService)
	settingsHandler := api.NewSettingsHandler(settingsService)
	systemHandler := api.NewSystemHandler(repo, mediaService, settingsService, tagService, cfg.StoragePath)
	feedsHandler := api.NewFeedsHandler(repo, postService, settingsService)
	pagesHandler := api.NewPagesHandler(repo, postService, tagService, settingsService)

	// Global middleware
	e.Use(middleware.Logger())
	e.Use(middleware.Recover())
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins:     []string{"*"},
		AllowMethods:     []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders:     []string{"*"},
		AllowCredentials: true,
	}))
	e.Use(middleware.SecureWithConfig(middleware.SecureConfig{
		XSSProtection:      "1; mode=block",
		ContentTypeNosniff: "nosniff",
		XFrameOptions:      "DENY",
	}))

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

	// ── Preview route (public, but token-gated) ────────────────────────────────
	e.GET("/preview/:token", postHandler.GetPostByPreviewToken)

	// ── Simplified media URL: /YYYY/MM/filename ────────────────────────────────
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath))

	// ── Auth Routes ────────────────────────────────────────────────────────────
	authGroup := e.Group("/api/auth")
	authGroup.POST("/login", authHandler.Login)
	authGroup.POST("/logout", authHandler.Logout)
	authGroup.GET("/me", authHandler.Me, api.AuthMiddleware(authService))
	authGroup.POST("/change-password", authHandler.ChangePassword, api.AuthMiddleware(authService))
	authGroup.GET("/sessions", authHandler.ListSessions, api.AuthMiddleware(authService))
	authGroup.DELETE("/sessions/:id", authHandler.DeleteSession, api.AuthMiddleware(authService))
	authGroup.DELETE("/sessions", authHandler.DeleteOtherSessions, api.AuthMiddleware(authService))

	// ── Post Routes ────────────────────────────────────────────────────────────
	postsGroup := e.Group("/api/posts")
	postsGroup.GET("", postHandler.ListPosts, api.OptionalAuthMiddleware(authService))
	postsGroup.POST("", postHandler.CreatePost, api.AuthMiddleware(authService))
	postsGroup.POST("/audio", postHandler.CreateAudioPost, api.AuthMiddleware(authService))
	postsGroup.GET("/slug/:slug", postHandler.GetPostBySlug, api.OptionalAuthMiddleware(authService))
	postsGroup.GET("/:id", postHandler.GetPostByID, api.OptionalAuthMiddleware(authService))
	postsGroup.PUT("/:id", postHandler.UpdatePost, api.AuthMiddleware(authService))
	postsGroup.DELETE("/:id", postHandler.DeletePost, api.AuthMiddleware(authService))
	postsGroup.POST("/:id/publish", postHandler.PublishPost, api.AuthMiddleware(authService))
	postsGroup.POST("/:id/withdraw", postHandler.WithdrawPost, api.AuthMiddleware(authService))
	postsGroup.POST("/:id/preview", postHandler.GeneratePreviewLink, api.AuthMiddleware(authService))

	// ── Tag Routes ─────────────────────────────────────────────────────────────
	tagsGroup := e.Group("/api/tags")
	tagsGroup.GET("", tagHandler.ListTags)
	tagsGroup.GET("/cloud", tagHandler.GetTagCloud)
	tagsGroup.POST("", tagHandler.CreateTag, api.AuthMiddleware(authService))
	tagsGroup.POST("/recalculate-counts", tagHandler.RecalculateCounts, api.AuthMiddleware(authService))
	tagsGroup.GET("/id/:id", tagHandler.GetTagByID)
	tagsGroup.GET("/slug/:slug", tagHandler.GetTagBySlug)
	tagsGroup.GET("/slug/:slug/posts", tagHandler.GetPostsByTag, api.OptionalAuthMiddleware(authService))
	tagsGroup.PUT("/:id", tagHandler.UpdateTag, api.AuthMiddleware(authService))
	tagsGroup.DELETE("/:id", tagHandler.DeleteTag, api.AuthMiddleware(authService))

	// ── Media Routes ───────────────────────────────────────────────────────────
	mediaGroup := e.Group("/api/media")
	mediaGroup.GET("", mediaHandler.ListMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/upload", mediaHandler.UploadFile, api.AuthMiddleware(authService))
	mediaGroup.POST("/upload/multiple", mediaHandler.UploadMultiple, api.AuthMiddleware(authService))
	mediaGroup.POST("/analyze", mediaHandler.AnalyzeImage, api.AuthMiddleware(authService))
	mediaGroup.GET("/stats", mediaHandler.GetStorageStats, api.AuthMiddleware(authService))
	mediaGroup.GET("/orphaned", mediaHandler.ListOrphanedMedia, api.AuthMiddleware(authService))
	mediaGroup.DELETE("/orphaned", mediaHandler.DeleteOrphanedMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/bulk-delete", mediaHandler.BulkDeleteMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/thumbnails/rebuild", mediaHandler.RebuildThumbnails, api.AuthMiddleware(authService))
	mediaGroup.GET("/:id", mediaHandler.GetMedia, api.AuthMiddleware(authService))
	mediaGroup.PUT("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(authService))
	mediaGroup.PATCH("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/:id/rename", mediaHandler.RenameMedia, api.AuthMiddleware(authService))
	mediaGroup.DELETE("/:id", mediaHandler.DeleteMedia, api.AuthMiddleware(authService))

	// ── Settings Routes ────────────────────────────────────────────────────────
	settingsGroup := e.Group("/api/settings")
	settingsGroup.GET("/public", settingsHandler.GetPublicSettings)
	settingsGroup.GET("", settingsHandler.GetSettings, api.AuthMiddleware(authService))
	settingsGroup.GET("/:key", settingsHandler.GetSettingByKey, api.AuthMiddleware(authService))
	settingsGroup.PUT("", settingsHandler.UpdateSettings, api.AuthMiddleware(authService))
	settingsGroup.PATCH("", settingsHandler.UpdateSettings, api.AuthMiddleware(authService))

	// ── System Routes ──────────────────────────────────────────────────────────
	systemGroup := e.Group("/api/system")
	systemGroup.GET("/stats", systemHandler.GetStats, api.AuthMiddleware(authService))
	systemGroup.GET("/logs", systemHandler.GetLogs, api.AuthMiddleware(authService))
	systemGroup.GET("/migrations", systemHandler.GetMigrations, api.AuthMiddleware(authService))
	systemGroup.POST("/cache/clear", systemHandler.ClearCache, api.AuthMiddleware(authService))
	systemGroup.POST("/backup", systemHandler.CreateBackup, api.AuthMiddleware(authService))
	systemGroup.GET("/backups", systemHandler.ListBackups, api.AuthMiddleware(authService))
	systemGroup.POST("/backups/:filename/restore", systemHandler.RestoreBackup, api.AuthMiddleware(authService))
	systemGroup.DELETE("/backups/:filename", systemHandler.DeleteBackup, api.AuthMiddleware(authService))

	// ── Page compound data Routes (for SPA) ────────────────────────────────────
	pagesGroup := e.Group("/api/pages")
	pagesGroup.GET("/home", pagesHandler.GetHomePage)
	pagesGroup.GET("/tag/:slug", pagesHandler.GetTagPage)
	pagesGroup.GET("/tags", pagesHandler.GetTagsPage)

	// ── Media static file serving ──────────────────────────────────────────────
	mediaPath := filepath.Join(cfg.StoragePath, "media")
	e.Static("/media", mediaPath)

	// ── Frontend SPA + static assets ──────────────────────────────────────────
	frontendDir := cfg.FrontendDir
	if fi, err := os.Stat(frontendDir); err == nil && fi.IsDir() {
		cssDir := filepath.Join(frontendDir, "css")
		srcDir := filepath.Join(frontendDir, "src")
		imagesDir := filepath.Join(frontendDir, "images")
		vendorDir := filepath.Join(frontendDir, "vendor")

		if fi, err := os.Stat(cssDir); err == nil && fi.IsDir() {
			e.Static("/assets/css", cssDir)
		}
		if fi, err := os.Stat(srcDir); err == nil && fi.IsDir() {
			e.Static("/assets/js", srcDir)
		}
		if fi, err := os.Stat(imagesDir); err == nil && fi.IsDir() {
			e.Static("/assets/images", imagesDir)
		}
		if fi, err := os.Stat(vendorDir); err == nil && fi.IsDir() {
			e.Static("/assets/vendor", vendorDir)
		}
	}

	// ── SPA fallback — must be last ────────────────────────────────────────────
	indexHTML := filepath.Join(cfg.FrontendDir, "index.html")
	e.GET("/*", func(c echo.Context) error {
		if _, err := os.Stat(indexHTML); err == nil {
			return c.File(indexHTML)
		}
		return c.JSON(http.StatusServiceUnavailable, map[string]string{
			"detail": "Frontend not available — build the frontend first",
		})
	})

	// Start server
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	log.Printf("Point API starting on %s", address)
	if err := e.Start(address); err != nil && err != http.ErrServerClosed {
		log.Fatalf("failed to start server: %v", err)
	}
}

// serveSimplifiedMedia handles /YYYY/MM/filename shortcut for media files.
func serveSimplifiedMedia(storagePath string) echo.HandlerFunc {
	return func(c echo.Context) error {
		year := c.Param("year")
		month := c.Param("month")
		filename := c.Param("filename")

		// Basic validation to prevent path traversal
		for _, seg := range []string{year, month, filename} {
			if seg == "" || seg == ".." || seg == "." {
				return echo.NewHTTPError(http.StatusBadRequest, "invalid path")
			}
		}

		filePath := filepath.Join(storagePath, "media", "originals", year, month, filename)
		if _, err := os.Stat(filePath); os.IsNotExist(err) {
			return echo.NewHTTPError(http.StatusNotFound, "media not found")
		}

		return c.File(filePath)
	}
}
