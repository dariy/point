package main

// Dependency wiring: where every service is constructed and handed its
// collaborators (initServices), and where the HTTP handlers that wrap those
// services are built (initHandlers). Nothing here registers a route or decides
// a URL — that is routes.go, driven from setupEcho.

import (
	"log"
	"log/slog"
	"os"
	"time"

	"point-api/internal/api"
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
	systemService := services.NewSystemService(repo, cfg.StoragePath, cfg.DatabaseURL).
		WithBackupHook(cfg.BackupHook, time.Duration(cfg.BackupHookTimeoutSeconds)*time.Second).
		WithHealth(healthRegistry)
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

// AppHandlers is every HTTP handler the router wires, built once from the
// services in AppServices. Construction is pure — no route is registered and no
// HTTP behaviour is decided here; routes.go turns these into endpoints.
type AppHandlers struct {
	Auth      *api.AuthHandler
	ApiKey    *api.ApiKeyHandler
	Tag       *api.TagHandler
	Post      *api.PostHandler
	Media     *api.MediaHandler
	Settings  *api.SettingsHandler
	Plugins   *api.PluginsHandler
	Theme     *api.ThemeHandler
	System    *api.SystemHandler
	Feeds     *api.FeedsHandler
	Pages     *api.PagesHandler
	Timeline  *api.TimelineHandler
	Setup     *api.SetupHandler
	NavMenu   *api.NavMenuHandler
	Instagram *api.InstagramHandler
	WebAuthn  *api.WebAuthnHandler
	Carousel  *api.CarouselHandler
}

// initHandlers constructs every handler in AppHandlers from the wired services.
//
// Two side effects live here rather than in setupEcho, next to the collaborators
// they belong to: the remark-comments supervisor goroutine is started (the
// settings handler holds the supervisor so an admin can restart it), and the
// WebAuthn service is built only when AppURL names an origin — passkeys need
// HTTPS and a known RP ID, so a bare install gets a nil service and a handler
// that reports the feature off.
func initHandlers(cfg config.Config, repo repository.Repository, svcs *AppServices) *AppHandlers {
	remarkSupervisor := services.NewRemarkSupervisor(svcs.Settings, repo).WithHealth(svcs.Health)
	go remarkSupervisor.Start()

	instagramImportService := services.NewInstagramImportService(svcs.Instagram, svcs.Media, svcs.Post)

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

	return &AppHandlers{
		Auth:      api.NewAuthHandler(svcs.Auth, &cfg, repo),
		ApiKey:    api.NewApiKeyHandler(svcs.ApiKey),
		Tag:       api.NewTagHandler(svcs.Tag, svcs.Settings),
		Post:      api.NewPostHandler(svcs.Post, svcs.Settings, svcs.Media, svcs.Tag),
		Media:     api.NewMediaHandler(svcs.Media, svcs.Settings),
		Settings:  api.NewSettingsHandler(svcs.Settings, remarkSupervisor),
		Plugins:   api.NewPluginsHandler(svcs.Settings),
		Theme:     api.NewThemeHandler(svcs.Theme),
		System:    api.NewSystemHandler(repo, svcs.Media, svcs.Post, svcs.Settings, svcs.Tag, svcs.System, svcs.Cache, svcs.Auth, cfg.StoragePath, cfg.AppVersion).WithHealth(svcs.Health).WithStorageQuotaMB(cfg.StorageQuotaMB),
		Feeds:     api.NewFeedsHandler(repo, svcs.Post, svcs.Tag, svcs.Settings, svcs.Cache),
		Pages:     api.NewPagesHandler(repo, svcs.Post, svcs.Tag, svcs.Media, svcs.Settings, svcs.Cache),
		Timeline:  api.NewTimelineHandler(svcs.Timeline, svcs.Settings),
		Setup:     api.NewSetupHandler(svcs.Auth, svcs.Settings, repo, &cfg),
		NavMenu:   api.NewNavMenuHandler(svcs.Settings, svcs.Tag),
		Instagram: api.NewInstagramHandler(svcs.Instagram, instagramImportService, svcs.Settings, &cfg),
		WebAuthn:  api.NewWebAuthnHandler(webauthnSvc, svcs.Auth, &cfg, repo),
		Carousel:  api.NewCarouselHandler(repo),
	}
}
