package main

// Dependency wiring: one place where every service is constructed and handed
// its collaborators. Nothing here talks to HTTP — the handlers that wrap these
// services are built in server.go.

import (
	"log"
	"os"

	"point-api/internal/config"
	"point-api/internal/metrics"
	"point-api/internal/repository"
	"point-api/internal/services"
)

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
	// Metrics is nil unless METRICS_ENABLED is set. Nil is the whole of the
	// off switch: every counter method is nil-safe, and setupEcho leaves the
	// instrumenting middleware out of the chain entirely, so a default install
	// carries no instrumentation rather than instrumentation nobody reads.
	Metrics *metrics.Registry
}

func initServices(cfg *config.Config, repo repository.Repository) *AppServices {
	// Built first: several services below take it at construction, and whether
	// it exists at all is what METRICS_ENABLED decides.
	var metricsRegistry *metrics.Registry
	if cfg.MetricsEnabled {
		metricsRegistry = metrics.New()
	}

	settingsService := services.NewSettingsService(repo)
	authService := services.NewAuthService(repo)
	apiKeyService := services.NewApiKeyService(repo)
	tagService := services.NewTagService(repo)
	instagramService := services.NewInstagramService(settingsService)
	// One registry, shared by everything that runs work outside a request, so
	// the admin health view has a single source rather than one per service.
	healthRegistry := services.NewHealthRegistry()
	// Built before the post/tag services so both can be handed it: a write to
	// either invalidates the rendered public pages (see onPostsChanged /
	// TagService.Invalidate).
	cacheService := services.NewCacheService(cfg.StoragePath).
		WithBudgetMB(cfg.PageCacheBudgetMB).
		WithMetrics(metricsRegistry)
	tagService.WithCache(cacheService)
	postService := services.NewPostService(repo, settingsService, instagramService, tagService, cfg.AppURL).
		WithHealth(healthRegistry).
		WithCache(cacheService).
		WithMetrics(metricsRegistry)
	mediaService := services.NewMediaService(repo, cfg, settingsService, tagService).
		WithCache(cacheService)
	systemService := services.NewSystemService(repo, cfg.StoragePath, cfg.DatabaseURL)
	// Drop any half-written backup left by a process that was interrupted mid-backup.
	systemService.CleanupPartialBackups()
	themeService := services.NewThemeService(cfg, settingsService)
	timelineService := services.NewTimelineService(repo)
	schedulerService := services.NewSchedulerService(authService, postService, systemService, mediaService, settingsService, instagramService).WithHealth(healthRegistry).WithMetrics(metricsRegistry)

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
		Metrics:     metricsRegistry,
	}
}
