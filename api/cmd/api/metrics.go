package main

// The /metrics listener and the glue that feeds it: the request middleware, the
// scrape-time sources, and the second HTTP server they are served from.
//
// Everything here is inert unless METRICS_ENABLED is set. svcs.Metrics is nil
// otherwise, setupEcho leaves the middleware out of the chain, and main never
// calls startMetricsServer — so a default install runs the same code path it
// ran before this file existed.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"point-api/internal/api"
	"point-api/internal/config"
	"point-api/internal/metrics"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

// metricsMiddleware records one series of observations per request.
//
// It is registered first, which makes it the outermost middleware: it measures
// the whole chain, including gzip, the rate limiter's rejections, and the 500
// that Recover turns a panic into.
//
// The status needs care. Echo runs HTTPErrorHandler after the entire middleware
// chain returns, so a handler that returns an error leaves the response status
// still at 200 when this middleware sees it — the status has to come from the
// *echo.HTTPError instead. Getting that wrong would file every 404 as a 2xx,
// which is the sort of bug a metric can carry for a year.
func metricsMiddleware(reg *metrics.Registry) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			start := time.Now()
			reg.InFlight(1)
			err := next(c)
			reg.InFlight(-1)

			// c.Path() is the matched route template, not the URL — that is the
			// whole reason the label set stays finite. It is read after next(c)
			// because a route that rewrites it (the /assets Pre handler) has
			// finished by then; an unmatched request leaves it empty, which
			// ClassifyRoute maps to "other".
			class := metrics.ClassifyRoute(c.Request().Method, c.Path())
			reg.ObserveRequest(class, statusOf(c, err), time.Since(start))
			return err
		}
	}
}

// statusOf is the status the client will actually receive.
func statusOf(c echo.Context, err error) int {
	if err == nil {
		return c.Response().Status
	}
	var he *echo.HTTPError
	if errors.As(err, &he) {
		return he.Code
	}
	return http.StatusInternalServerError
}

// countRateLimited returns a DenyHandler that records the rejection and then
// answers exactly as Echo's default would. Wrapping rather than replacing
// matters: the limiter's response body and status are part of the API.
func countRateLimited(reg *metrics.Registry, l metrics.Limiter) func(echo.Context, string, error) error {
	return func(c echo.Context, identifier string, err error) error {
		reg.RateLimited(l)
		return &echo.HTTPError{
			Code:     http.StatusTooManyRequests,
			Message:  "rate limit exceeded",
			Internal: err,
		}
	}
}

// metricsSources builds the scrape-time half of the exposition: values read
// from whoever already owns them, rather than counted a second time here.
func metricsSources(cfg config.Config, repo repository.Repository, svcs *AppServices) metrics.Sources {
	return metrics.Sources{
		Version: cfg.AppVersion,
		Uptime:  func() time.Duration { return time.Since(api.StartTime()) },
		Tasks: func() []metrics.Task {
			snap := svcs.Health.Snapshot()
			out := make([]metrics.Task, 0, len(snap))
			for _, t := range snap {
				out = append(out, metrics.Task{
					Name:        t.Name,
					Runs:        t.Runs,
					Failures:    t.Failures,
					LastSuccess: t.LastSuccess,
				})
			}
			return out
		},
		Storage: func() (metrics.Storage, bool) {
			// The counts are a handful of indexed SELECT COUNT(*)s against
			// SQLite. The timeout is there so a locked database costs the
			// scrape its storage gauges rather than hanging the listener.
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			stats, err := repo.GetSystemStats(ctx)
			if err != nil {
				slog.Warn("metrics: system stats unavailable", "error", err)
				return metrics.Storage{}, false
			}
			return metrics.Storage{
				UsedBytes:  stats.StorageBytes,
				QuotaBytes: int64(cfg.StorageQuotaMB) * 1024 * 1024,
				DBBytes:    dbFileBytes(cfg.DatabaseURL),
				Published:  stats.PublishedCount,
				Draft:      stats.DraftCount,
				OtherPosts: stats.PostCount - stats.PublishedCount - stats.DraftCount,
				Media:      stats.MediaCount,
			}, true
		},
		ViewsPending: svcs.Post.PendingViewCounts,
	}
}

// dbFileBytes is the size of the SQLite database plus its write-ahead log, or 0
// when there is no file to measure (an in-memory database, a path that has
// moved). The WAL counts: in WAL mode it holds committed pages that have not
// been checkpointed yet, and a WAL that stops shrinking is one of the few
// SQLite problems worth an alert.
func dbFileBytes(databaseURL string) int64 {
	path := databaseURL
	// The DSN is handed to the driver as a filename, optionally with a scheme
	// and the connection PRAGMAs appended as a query string.
	for _, scheme := range []string{"sqlite://", "sqlite:", "file:"} {
		if strings.HasPrefix(path, scheme) {
			path = strings.TrimPrefix(path, scheme)
			break
		}
	}
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if path == "" || strings.Contains(path, ":memory:") || strings.Contains(path, "mode=memory") {
		return 0
	}
	var total int64
	for _, p := range []string{path, path + "-wal"} {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() {
			total += fi.Size()
		}
	}
	return total
}

// startMetricsServer starts the second listener and returns it for shutdown.
// Returns nil when metrics are disabled, so the caller needs no second flag.
//
// A listener of its own, not a route on the main port, is the security design:
// /metrics carries post counts, storage usage and error rates, and putting it
// on the public port would mean either an auth decision (one more thing to get
// wrong) or an unauthenticated leak. Here the bind address is the whole access
// policy, and it defaults to loopback.
func startMetricsServer(cfg config.Config, repo repository.Repository, svcs *AppServices) *http.Server {
	if !cfg.MetricsEnabled || svcs.Metrics == nil {
		return nil
	}
	addr := fmt.Sprintf("%s:%d", cfg.MetricsBind, cfg.MetricsPort)
	srv := &http.Server{
		Addr:    addr,
		Handler: metrics.Handler(svcs.Metrics, metricsSources(cfg, repo, svcs)),
		// A scrape is a plain GET with no body; these bound a stuck client
		// without any risk to a legitimate one.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	slog.Info("metrics listener starting", "address", addr, "path", "/metrics")
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			// Deliberately not fatal: a blog that cannot export its metrics
			// should still serve its blog.
			slog.Error("metrics listener stopped", "address", addr, "error", err)
		}
	}()
	return srv
}
