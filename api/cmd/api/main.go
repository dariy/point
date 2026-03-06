package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

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
	defer func() {
		if err := repo.Close(); err != nil {
			log.Printf("error closing repository: %v", err)
		}
	}()

	// Ensure media directories exist
	for _, dir := range []string{"originals", "thumbnails"} {
		path := filepath.Join(cfg.StoragePath, "media", dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			log.Printf("warning: could not create media dir %s: %v", path, err)
		}
	}

	// Apply pending DB migrations.
	ctx := context.Background()
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
	}
	for _, m := range migrations {
		if err := repo.ApplyMigration(ctx, m.name, m.sql); err != nil {
			log.Printf("warning: migration %q: %v", m.name, err)
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
	mediaService := services.NewMediaService(repo, &cfg, settingsService, tagService)

	// Handlers
	authHandler := api.NewAuthHandler(authService, &cfg)
	tagHandler := api.NewTagHandler(tagService, settingsService)
	postHandler := api.NewPostHandler(postService, settingsService, mediaService, tagService)
	mediaHandler := api.NewMediaHandler(mediaService, settingsService)
	settingsHandler := api.NewSettingsHandler(settingsService)
	systemHandler := api.NewSystemHandler(repo, mediaService, settingsService, tagService, cfg.StoragePath)
	feedsHandler := api.NewFeedsHandler(repo, postService, tagService, settingsService)
	pagesHandler := api.NewPagesHandler(repo, postService, tagService, settingsService)

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
		XSSProtection:      "1; mode=block",
		ContentTypeNosniff: "nosniff",
		XFrameOptions:      "DENY",
	}))
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

	// ── Preview route (public, but token-gated) ────────────────────────────────
	e.GET("/preview/:token", postHandler.GetPostByPreviewToken)

	// ── Media file serving: /YYYY/MM/filename[?thumb] ─────────────────────────
	// Auth-gated: unauthenticated clients see 404 for non-public media.
	e.GET("/:year/:month/:filename", serveSimplifiedMedia(cfg.StoragePath, indexHTML, repo), api.OptionalAuthMiddleware(authService))

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
	postsGroup.GET("/:slug/page", postHandler.GetPostPage, api.OptionalAuthMiddleware(authService))
	postsGroup.GET("/:id", postHandler.GetPostByID, api.OptionalAuthMiddleware(authService))
	postsGroup.PUT("/:id", postHandler.UpdatePost, api.AuthMiddleware(authService))
	postsGroup.PATCH("/:id/tags", postHandler.UpdatePostTags, api.AuthMiddleware(authService))
	postsGroup.DELETE("/:id", postHandler.DeletePost, api.AuthMiddleware(authService))
	postsGroup.GET("/:id/navigation", postHandler.GetPostNavigation, api.OptionalAuthMiddleware(authService))
	postsGroup.POST("/:id/publish", postHandler.PublishPost, api.AuthMiddleware(authService))
	postsGroup.POST("/:id/withdraw", postHandler.WithdrawPost, api.AuthMiddleware(authService))
	postsGroup.POST("/:id/preview", postHandler.GeneratePreviewLink, api.AuthMiddleware(authService))

		// ── Tag Routes ─────────────────────────────────────────────────────────────
	tagsGroup := e.Group("/api/tags")
	tagsGroup.GET("", tagHandler.ListTags, api.OptionalAuthMiddleware(authService))
	tagsGroup.GET("/cloud", tagHandler.GetTagCloud, api.OptionalAuthMiddleware(authService))
	tagsGroup.POST("", tagHandler.CreateTag, api.AuthMiddleware(authService))
	tagsGroup.POST("/recalculate-counts", tagHandler.RecalculateCounts, api.AuthMiddleware(authService))
	tagsGroup.GET("/id/:id", tagHandler.GetTagByID, api.OptionalAuthMiddleware(authService))
	tagsGroup.GET("/slug/:slug", tagHandler.GetTagBySlug, api.OptionalAuthMiddleware(authService))
	tagsGroup.GET("/slug/:slug/posts", tagHandler.GetPostsByTag, api.OptionalAuthMiddleware(authService))
	tagsGroup.PUT("/:id", tagHandler.UpdateTag, api.AuthMiddleware(authService))
	tagsGroup.DELETE("/:id", tagHandler.DeleteTag, api.AuthMiddleware(authService))
	tagsGroup.POST("/:id/reorder", tagHandler.ReorderTag, api.AuthMiddleware(authService))
	tagsGroup.POST("/:id/geocode", tagHandler.GeocodeTag, api.AuthMiddleware(authService))

	// ── Media Routes ───────────────────────────────────────────────────────────
	mediaGroup := e.Group("/api/media")
	mediaGroup.GET("", mediaHandler.ListMedia, api.AuthMiddleware(authService))
	mediaGroup.GET("/folders", mediaHandler.GetMediaFolders, api.AuthMiddleware(authService))
	mediaGroup.POST("/upload", mediaHandler.UploadFile, api.AuthMiddleware(authService))
	mediaGroup.POST("/upload/multiple", mediaHandler.UploadMultiple, api.AuthMiddleware(authService))
	mediaGroup.POST("/analyze", mediaHandler.AnalyzeImage, api.AuthMiddleware(authService))
	mediaGroup.POST("/analyze-path", mediaHandler.AnalyzeImageByPath, api.AuthMiddleware(authService))
	mediaGroup.GET("/stats", mediaHandler.GetStorageStats, api.AuthMiddleware(authService))
	mediaGroup.GET("/orphaned", mediaHandler.ListOrphanedMedia, api.AuthMiddleware(authService))
	mediaGroup.DELETE("/orphaned", mediaHandler.DeleteOrphanedMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/bulk-delete", mediaHandler.BulkDeleteMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/thumbnails/rebuild", mediaHandler.RebuildThumbnails, api.AuthMiddleware(authService))
	mediaGroup.GET("/:id", mediaHandler.GetMedia, api.AuthMiddleware(authService))
	mediaGroup.PUT("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(authService))
	mediaGroup.PATCH("/:id", mediaHandler.UpdateMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/:id/rename", mediaHandler.RenameMedia, api.AuthMiddleware(authService))
	mediaGroup.POST("/:id/analyze", mediaHandler.AnalyzeImageByID, api.AuthMiddleware(authService))
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
	systemGroup.POST("/map/update-coords", systemHandler.UpdateMapCoords, api.AuthMiddleware(authService))
	systemGroup.POST("/media/recalculate-visibility", systemHandler.RecalculateMediaVisibility, api.AuthMiddleware(authService))
	systemGroup.POST("/backup", systemHandler.CreateBackup, api.AuthMiddleware(authService))
	systemGroup.GET("/backups", systemHandler.ListBackups, api.AuthMiddleware(authService))
	systemGroup.POST("/backups/:filename/restore", systemHandler.RestoreBackup, api.AuthMiddleware(authService))
	systemGroup.DELETE("/backups/:filename", systemHandler.DeleteBackup, api.AuthMiddleware(authService))

	// ── Utility Routes ─────────────────────────────────────────────────────────
	utilGroup := e.Group("/api/util")
	utilGroup.GET("/parse-maps-coords", api.ParseMapsCoords, api.AuthMiddleware(authService))

	// ── Page compound data Routes (for SPA) ────────────────────────────────────
	pagesGroup := e.Group("/api/pages")
	pagesGroup.GET("/home", pagesHandler.GetHomePage, api.OptionalAuthMiddleware(authService))
	pagesGroup.GET("/tag/:slug", pagesHandler.GetTagPage, api.OptionalAuthMiddleware(authService))
	pagesGroup.GET("/tags", pagesHandler.GetTagsPage, api.OptionalAuthMiddleware(authService))
	pagesGroup.GET("/map", pagesHandler.GetMapPage, api.OptionalAuthMiddleware(authService))

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
func serveSimplifiedMedia(storagePath, indexHTML string, repo *repository.Repository) echo.HandlerFunc {
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
		if filename == "" || filename == ".." || filename == "." {
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
		if !media.IsPublic && !isAuthenticated {
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
		origFile := filepath.Join(origDir, filename)
		if _, err := os.Stat(origFile); err == nil {
			return c.File(origFile)
		}
		if m := checksumRe.FindStringSubmatch(filename); m != nil {
			matches, _ := filepath.Glob(filepath.Join(origDir, "*_"+m[1]+".*"))
			if len(matches) == 1 {
				return c.File(matches[0])
			}
		}

		return echo.NewHTTPError(http.StatusNotFound, "media not found")
	}
}
