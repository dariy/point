package main

// Process lifecycle: logging, the pre-database recovery steps, migrations, then
// the server and its shutdown (or in-place restart). Everything it calls lives
// beside it — subcommands in cli.go, services in wiring.go, the Echo server in
// server.go.

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/repository"
	"point-api/internal/services"
	"point-api/internal/utils"
)

// Version is set at build time via -ldflags="-X main.Version=..."
var Version = "dev"

func init() {
	if Version == "dev" {
		Version = "dev-" + time.Now().Format("20060102-150405")
	}
}

// installLogger points slog (and the legacy log package) at w, filtering below
// level.
func installLogger(w io.Writer, level slog.Level) {
	logger := slog.New(slog.NewJSONHandler(w, &slog.HandlerOptions{
		Level: level,
	}))
	slog.SetDefault(logger)

	// Redirect standard log to slog to handle legacy log.Printf calls
	log.SetOutput(slog.NewLogLogger(logger.Handler(), slog.LevelInfo).Writer())
	log.SetFlags(0)
}

// parseLogLevel maps a LOG_LEVEL string to an slog.Level, defaulting to Info
// for the empty string or anything unrecognised.
func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func main() {
	// Start on stdout alone: the log file lives under the storage path, which
	// isn't known until the config is loaded below.
	installLogger(os.Stdout, slog.LevelInfo)

	// Check for CLI commands early — setup, reset-password and --version each
	// exit the process; this returns only when we are meant to serve.
	runEarlyCLI()

	// Load configuration
	cfg, err := config.LoadConfig(".")
	if err != nil {
		slog.Error("failed to load config", "error", err)
		os.Exit(1)
	}
	if cfg.AppVersion == "" || cfg.AppVersion == "dev" {
		cfg.AppVersion = Version
	}

	// Now that the storage path is known, tee logging to disk as well. stdout
	// stays authoritative (docker logs, journald); the file is what the admin
	// Logs page reads, which is otherwise unreachable inside a container.
	logFile := utils.NewRotatingFile(
		filepath.Join(cfg.StoragePath, "logs", "app.log"),
		utils.LogMaxBytes, utils.LogMaxBackups,
	)
	defer func() { _ = logFile.Close() }()
	installLogger(io.MultiWriter(os.Stdout, logFile), parseLogLevel(cfg.LogLevel))

	// Apply any backup restore scheduled from the admin UI. This must run BEFORE
	// the database is opened: extracting a backup over an open SQLite file corrupts
	// it, so the restore is deferred to here.
	sysBoot := services.NewSystemService(nil, cfg.StoragePath, cfg.DatabaseURL)
	if applied, err := sysBoot.ApplyPendingRestore(); err != nil {
		slog.Error("failed to apply pending backup restore", "error", err)
	} else if applied {
		slog.Info("applied pending backup restore before opening database")
	}

	// Finish a pre-migration snapshot restore that a crash or a kill interrupted.
	// Same rule as above — it swaps the database file, so it has to happen before
	// anything opens it. Unlike a scheduled restore this one is not allowed to
	// fail quietly: the file at point.db may be the one a failed migration left.
	if applied, err := sysBoot.ApplyPendingMigrationRestore(); err != nil {
		slog.Error("could not finish an interrupted pre-migration restore — refusing to start", "error", err)
		os.Exit(1)
	} else if applied {
		slog.Warn("finished an interrupted pre-migration restore before opening database")
	}

	// Initialize repository
	repo, err := repository.NewRepository(cfg.DatabaseURL)
	if err != nil {
		slog.Error("failed to initialize repository", "error", err)
		os.Exit(1)
	}
	defer func() {
		if err := repo.Close(); err != nil {
			slog.Error("error closing repository", "error", err)
		}
	}()

	svcs := initServices(&cfg, repo)

	// API Key Creation CLI fallback
	if name := parseCreateAPIKeyName(os.Args[1:]); name != "" {
		runCreateAPIKeyCLI(svcs, name)
	}

	// Ensure media directories exist
	// "thumbnails" holds client-captured video posters; "variants" holds the
	// derived ladder. They are separate roots so purging the derived tree can
	// never reach a poster (see services.VariantsRoot).
	for _, dir := range []string{"originals", "thumbnails", services.VariantsRoot} {
		path := filepath.Join(cfg.StoragePath, "media", dir)
		if err := os.MkdirAll(path, 0755); err != nil {
			slog.Warn("could not create media dir", "path", path, "error", err)
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Apply DB schema + data migrations (see internal/migrations). A failure
	// here means the database is not at the schema this build expects, so we
	// stop rather than serve against it — the alternative is failing later,
	// somewhere unrelated, on whatever the mismatch happens to break. The guard
	// snapshots the database first and puts it back on failure, so stopping
	// leaves it at its pre-upgrade state rather than half-migrated.
	if restored, err := runMigrationsGuarded(ctx, repo, svcs.System, cfg); err != nil {
		slog.Error("database migrations failed — refusing to start",
			"error", err, "database_restored", restored)
		os.Exit(1)
	}

	// Sync env-var secrets into blog_secrets so they're available at runtime.
	if cfg.GeminiAPIKey != "" {
		if err := svcs.Settings.SetSecret(ctx, "gemini_api_key", cfg.GeminiAPIKey); err != nil {
			slog.Warn("failed to sync gemini_api_key to secrets", "error", err)
		}
	}
	if cfg.PhotoLibraryPath != "" {
		if err := svcs.Settings.SetSecret(ctx, "photo_library_path", cfg.PhotoLibraryPath); err != nil {
			slog.Warn("failed to sync photo_library_path to secrets", "error", err)
		}
	}

	// Synchronize active theme with public theme.css for the frontend
	if err := svcs.Theme.SyncActiveTheme(ctx); err != nil {
		slog.Warn("failed to sync active theme", "error", err)
	}

	e := setupEcho(cfg, repo, svcs)

	// Start background scheduler (goroutines honor ctx cancellation)
	svcs.Scheduler.Start(ctx)

	// Prometheus exposition on a listener of its own, or nil when
	// METRICS_ENABLED is off — which is the default, and then nothing below
	// this line runs at all.
	metricsSrv := startMetricsServer(cfg, repo, svcs)

	// Start server
	address := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	slog.Info("Point API starting", "address", address)
	go func() {
		if err := e.Start(address); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("failed to start server", "error", err)
			os.Exit(1)
		}
	}()

	// Wait for interrupt or SIGTERM
	<-ctx.Done()
	stop()

	slog.Info("shutting down...")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := e.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown error", "error", err)
	}
	// Closed before the re-exec below, not just at exit: a restart that left
	// this port held would fail to rebind it in the new process.
	if metricsSrv != nil {
		if err := metricsSrv.Shutdown(shutdownCtx); err != nil {
			slog.Error("metrics listener shutdown error", "error", err)
		}
	}
	slog.Info("graceful shutdown complete")

	// A UI-triggered restart re-execs this binary in place: same PID and container,
	// a fresh program that re-runs initialization (including applying any pending
	// backup restore before the DB opens). No external supervisor is required. The
	// DB/listener fds are O_CLOEXEC, so they close automatically across the exec.
	if api.RestartRequested.Load() {
		exe, err := os.Executable()
		if err != nil {
			exe = os.Args[0]
		}
		slog.Info("restart requested: re-executing in place", "exe", exe)
		// Re-executing this very binary (os.Executable), not a caller-named one.
		if err := syscall.Exec(exe, os.Args, os.Environ()); err != nil { //nolint:gosec // G204: exec of self
			slog.Error("re-exec failed; exiting so a supervisor can restart instead", "error", err)
			os.Exit(1)
		}
	}
}
