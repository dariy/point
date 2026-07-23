package main

// Route registration split out of setupEcho, one function per API
// domain (see point-main-go-decompose). Each takes the echo instance, its
// domain handler, and the shared services for auth/plugin middleware.

import (
	"point-api/internal/api"

	"github.com/labstack/echo/v4"
)

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
	mediaGroup.POST("/:id/analyze", h.AnalyzeImageByID, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.RequirePlugin(svcs.Settings, "ai-analysis"))
	mediaGroup.POST("/:id/reextract", h.ReextractEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.PUT("/:id/exif", h.UpdateEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.POST("/:id/revert-exif", h.RevertEXIF, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	mediaGroup.DELETE("/:id", h.DeleteMedia, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
}

func registerSettingsRoutes(e *echo.Echo, h *api.SettingsHandler, svcs *AppServices) {
	settingsGroup := e.Group("/api/settings")
	settingsGroup.GET("/public", h.GetPublicSettings, visibilityCache)
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
	systemGroup.GET("/version", h.GetVersion, api.AuthMiddleware(svcs.Auth, svcs.ApiKey))
	// Restart the process in place (re-exec). Session-only: not an API-key action.
	systemGroup.POST("/restart", h.RestartServer, api.AuthMiddleware(svcs.Auth, svcs.ApiKey), api.SessionOnlyMiddleware)
}
