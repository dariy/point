package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/config"
	"point-api/internal/metrics"
	"point-api/internal/repository"

	"github.com/labstack/echo/v4"
)

// metricsEnv builds a server with metrics turned on, over an in-memory database
// and a minimal built frontend (so the /assets and SPA routes exist).
type metricsEnv struct {
	cfg  config.Config
	repo repository.Repository
	svcs *AppServices
	e    *echo.Echo
}

func newMetricsEnv(t *testing.T, enabled bool) *metricsEnv {
	t.Helper()
	root := t.TempDir()
	jsDir := filepath.Join(root, "js")
	if err := os.MkdirAll(jsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(jsDir, "app.js"), []byte("export const app=1;"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"),
		[]byte(`<html><head><title>t</title></head><body></body></html>`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg := config.Config{
		AppVersion:     "1.2.3",
		FrontendDir:    root,
		StoragePath:    t.TempDir(),
		DatabaseURL:    ":memory:",
		MetricsEnabled: enabled,
		MetricsBind:    "127.0.0.1",
		MetricsPort:    0,
	}
	repo, err := repository.NewRepository(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	svcs := initServices(&cfg, repo)
	return &metricsEnv{cfg: cfg, repo: repo, svcs: svcs, e: setupEcho(cfg, repo, svcs)}
}

func (env *metricsEnv) render(t *testing.T) (string, int) {
	t.Helper()
	var buf bytes.Buffer
	n, err := metrics.Render(&buf, env.svcs.Metrics, metricsSources(env.cfg, env.repo, env.svcs))
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	return buf.String(), n
}

// TestRouteClassCoversEveryRegisteredRoute is the totality half of the
// cardinality guarantee: every route this server actually registers has a class,
// and none of them falls through to "other".
//
// "other" is reserved for a request that matched nothing. A registered route
// landing there means a new area of the API is being counted as an anomaly, and
// nobody would notice from the graphs.
func TestRouteClassCoversEveryRegisteredRoute(t *testing.T) {
	env := newMetricsEnv(t, true)

	known := map[string]bool{}
	for _, name := range metrics.RouteClasses() {
		known[name] = true
	}

	seen := map[string]bool{}
	for _, r := range env.e.Routes() {
		class := metrics.ClassifyRoute(r.Method, r.Path).String()
		if !known[class] {
			t.Fatalf("%s %s produced class %q, which is not in the allow-list", r.Method, r.Path, class)
		}
		if class == "other" {
			t.Errorf("%s %s falls through to \"other\" — give it a class in ClassifyRoute", r.Method, r.Path)
		}
		seen[class] = true
	}
	if len(env.e.Routes()) < 100 {
		t.Fatalf("only %d routes registered; the test is not exercising the real router", len(env.e.Routes()))
	}
	// The classes that only exist because a specific route does. If one stops
	// appearing, a route was renamed out from under ClassifyRoute.
	for _, want := range []string{"home", "post", "tag", "media", "assets", "spa", "feed", "auth", "mcp", "admin", "api_read", "api_write", "health"} {
		if !seen[want] {
			t.Errorf("no registered route maps to class %q any more", want)
		}
	}
}

// driveTraffic hits one URL per route class, plus a spread of others, so the
// exposition under test is the widest one real traffic could produce.
func driveTraffic(t *testing.T, env *metricsEnv) int {
	t.Helper()
	reqs := []struct{ method, path string }{
		{http.MethodGet, "/health"},
		{http.MethodGet, "/feed.xml"},
		{http.MethodGet, "/robots.txt"},
		{http.MethodGet, "/sitemap.xml"},
		{http.MethodGet, "/assets/js/app.js"},
		{http.MethodGet, "/assets/js/missing.js"},
		{http.MethodGet, "/2024/01/photo.jpg"},
		{http.MethodGet, "/some/public/page"},
		{http.MethodGet, "/another/public/page"},
		{http.MethodGet, "/api/pages/home"},
		{http.MethodGet, "/api/pages/tags"},
		{http.MethodGet, "/api/pages/map"},
		{http.MethodGet, "/api/tags"},
		{http.MethodGet, "/api/tags/slug/travel"},
		{http.MethodGet, "/api/tags/slug/food"},
		{http.MethodGet, "/api/posts/slug/first-post"},
		{http.MethodGet, "/api/posts/slug/second-post"},
		{http.MethodGet, "/api/posts/preview/abc123"},
		{http.MethodGet, "/api/posts"},
		{http.MethodGet, "/api/timeline"},
		{http.MethodGet, "/api/settings/public"},
		{http.MethodGet, "/api/plugins"},
		{http.MethodGet, "/api/nav-menu"},
		{http.MethodGet, "/api/themes"},
		{http.MethodPost, "/api/posts"},
		{http.MethodPut, "/api/settings"},
		{http.MethodDelete, "/api/media/7"},
		{http.MethodGet, "/api/system/stats"},
		{http.MethodGet, "/api/system/health"},
		{http.MethodPost, "/api/system/backup"},
		{http.MethodGet, "/api/admin/comments/recent"},
		{http.MethodGet, "/api/instagram/status"},
		{http.MethodPost, "/api/auth/login"},
		{http.MethodGet, "/api/auth/me"},
		{http.MethodGet, "/api/setup/status"},
		{http.MethodPost, "/oauth/token"},
		{http.MethodGet, "/.well-known/oauth-protected-resource"},
		{http.MethodPost, "/mcp"},
		{http.MethodGet, "/mcp/"},
	}
	for _, r := range reqs {
		req := httptest.NewRequest(r.method, r.path, nil)
		env.e.ServeHTTP(httptest.NewRecorder(), req)
	}
	return len(reqs)
}

// TestMetricsCardinalityCeiling asserts the *count* of series, not just their
// content — because a cardinality regression is perfectly well-formed. Adding a
// `path` label would leave every line valid and every test about content
// passing, while multiplying this number by fifty.
//
// The ceiling is deliberately well above what a real instance produces (~60)
// and well below what any per-path labelling could stay under.
func TestMetricsCardinalityCeiling(t *testing.T) {
	const ceiling = 150

	env := newMetricsEnv(t, true)
	// Task series are the one label not drawn from a Go enum; include some.
	for _, name := range []string{"session cleanup", "scheduled publishing", "view count flushing", "backups"} {
		env.svcs.Health.Record(name, nil)
	}
	routes := driveTraffic(t, env)

	body, n := env.render(t)
	t.Logf("exposition: %d series after %d distinct routes (ceiling %d)", n, routes, ceiling)
	if n > ceiling {
		t.Errorf("exposition has %d series after %d distinct routes, ceiling is %d:\n%s",
			n, routes, ceiling, body)
	}
	if n < 40 {
		t.Errorf("exposition has only %d series; the traffic did not reach the middleware", n)
	}

	// Every label the exposition carries must come from the closed sets. This
	// is what catches a URL, a post ID or a tag slug leaking into a label.
	allowedLabels := map[string]bool{
		"route_class": true, "status_class": true, "le": true,
		"site": true, "result": true, "limiter": true,
		"task": true, "status": true, "version": true,
	}
	routeClasses := map[string]bool{}
	for _, c := range metrics.RouteClasses() {
		routeClasses[c] = true
	}
	for _, line := range strings.Split(body, "\n") {
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		lbrace := strings.IndexByte(line, '{')
		if lbrace < 0 {
			continue
		}
		rbrace := strings.LastIndexByte(line, '}')
		for _, pair := range strings.Split(line[lbrace+1:rbrace], ",") {
			k, v, _ := strings.Cut(pair, "=")
			if !allowedLabels[k] {
				t.Errorf("unexpected label %q in %q", k, line)
			}
			if k == "route_class" && !routeClasses[strings.Trim(v, `"`)] {
				t.Errorf("route_class %s is outside the allow-list, in %q", v, line)
			}
		}
	}
}

// TestMiddlewareRecordsStatusFromError: Echo runs its error handler after the
// whole middleware chain, so a handler that returns an error leaves the
// response at 200 when the metrics middleware reads it. Getting this wrong
// files every 401 and 404 as a success — quietly, and forever.
func TestMiddlewareRecordsStatusFromError(t *testing.T) {
	env := newMetricsEnv(t, true)

	// Unauthenticated admin read: the handler returns an *echo.HTTPError.
	req := httptest.NewRequest(http.MethodGet, "/api/system/stats", nil)
	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("precondition: /api/system/stats = %d, want 401", rec.Code)
	}

	body, _ := env.render(t)
	want := `point_http_requests_total{route_class="admin",status_class="4xx"} 1`
	if !strings.Contains(body, want) {
		t.Errorf("missing %q in:\n%s", want, body)
	}
	if strings.Contains(body, `point_http_requests_total{route_class="admin",status_class="2xx"}`) {
		t.Error("a 401 was recorded as a 2xx")
	}
}

// TestMetricsDisabledChangesNothing: METRICS_ENABLED=false must leave no
// registry, no listener and no instrumentation — the default install runs the
// code it ran before this feature existed.
func TestMetricsDisabledChangesNothing(t *testing.T) {
	env := newMetricsEnv(t, false)
	if env.svcs.Metrics != nil {
		t.Error("a registry was built with metrics disabled")
	}
	if srv := startMetricsServer(env.cfg, env.repo, env.svcs); srv != nil {
		t.Error("a listener was started with metrics disabled")
		_ = srv.Close()
	}

	// The server still serves, and the disabled registry swallows every
	// observation the (absent) middleware would have made.
	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("/health = %d with metrics off, want 200", rec.Code)
	}
	body, _ := env.render(t)
	if strings.Contains(body, "point_http_requests_total{") {
		t.Errorf("requests were counted with metrics disabled:\n%s", body)
	}
}

// TestMetricsListenerServesExposition boots the real second listener and
// scrapes it, which is the only way to prove the bind/port plumbing works.
func TestMetricsListenerServesExposition(t *testing.T) {
	env := newMetricsEnv(t, true)
	// Port 0 would be ideal but the server reports no address back; use a port
	// the OS picks for us by binding first.
	srv := startMetricsServer(env.cfg, env.repo, env.svcs)
	if srv == nil {
		t.Fatal("no listener started with metrics enabled")
	}
	t.Cleanup(func() { _ = srv.Close() })

	// Serve one request through the handler the listener was built with rather
	// than racing its goroutine onto a fixed port.
	rec := httptest.NewRecorder()
	srv.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
	for _, want := range []string{
		`point_build_info{version="1.2.3"}`,
		"point_uptime_seconds",
		"point_posts_total",
		"point_page_cache_total",
	} {
		if !strings.Contains(rec.Body.String(), want) {
			t.Errorf("missing %q in exposition:\n%s", want, rec.Body.String())
		}
	}
}

// TestDBFileBytes covers the DSN shapes the config can carry.
func TestDBFileBytes(t *testing.T) {
	dir := t.TempDir()
	db := filepath.Join(dir, "point.db")
	if err := os.WriteFile(db, bytes.Repeat([]byte("x"), 100), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(db+"-wal", bytes.Repeat([]byte("y"), 50), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := dbFileBytes(db); got != 150 {
		t.Errorf("dbFileBytes(plain path) = %d, want 150 (db + wal)", got)
	}
	if got := dbFileBytes("sqlite:" + db); got != 150 {
		t.Errorf("dbFileBytes(sqlite: prefix) = %d, want 150", got)
	}
	if got := dbFileBytes(db + "?_pragma=busy_timeout(5000)"); got != 150 {
		t.Errorf("dbFileBytes(with pragmas) = %d, want 150", got)
	}
	if got := dbFileBytes(":memory:"); got != 0 {
		t.Errorf("dbFileBytes(:memory:) = %d, want 0", got)
	}
	if got := dbFileBytes(filepath.Join(dir, "gone.db")); got != 0 {
		t.Errorf("dbFileBytes(missing) = %d, want 0", got)
	}
}

// TestPanicIsCounted: a recovered panic looks exactly like any other 500 from
// outside the process, so the counter is the only thing that distinguishes
// "this query failed" from "this handler is broken".
func TestPanicIsCounted(t *testing.T) {
	env := newMetricsEnv(t, true)
	env.e.GET("/api/util/panic-probe", func(echo.Context) error {
		panic("probe")
	})

	rec := httptest.NewRecorder()
	env.e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/util/panic-probe", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panicking route = %d, want 500 (Recover must still answer)", rec.Code)
	}

	body, _ := env.render(t)
	if !strings.Contains(body, `point_panics_total{site="http"} 1`) {
		t.Errorf("panic not counted:\n%s", body)
	}
	if !strings.Contains(body, `point_http_requests_total{route_class="api_read",status_class="5xx"} 1`) {
		t.Errorf("the resulting 500 was not recorded as one:\n%s", body)
	}
}

// TestRateLimitRejectionIsCounted drives the public limiter past its burst.
// Rejections are invisible in the request log's error field — they are a
// well-formed 429 — so a scraper is being blocked and a real visitor being
// blocked look the same until this counter separates them.
func TestRateLimitRejectionIsCounted(t *testing.T) {
	env := newMetricsEnv(t, true)

	// Burst is 200; a few over it is enough and stays fast.
	var rejected int
	for i := 0; i < 230; i++ {
		rec := httptest.NewRecorder()
		env.e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/settings/public", nil))
		if rec.Code == http.StatusTooManyRequests {
			rejected++
		}
	}
	if rejected == 0 {
		t.Fatal("precondition: the public limiter never rejected anything")
	}

	body, _ := env.render(t)
	want := "point_ratelimit_rejected_total{limiter=\"public\"} " + itoa(rejected)
	if !strings.Contains(body, want) {
		t.Errorf("missing %q (saw %d rejections) in:\n%s", want, rejected, body)
	}
}

// TestPageCacheOutcomesAreCounted: miss, then hit on the same key, plus a
// render that was never eligible for the cache.
func TestPageCacheOutcomesAreCounted(t *testing.T) {
	env := newMetricsEnv(t, true)

	get := func(path string) {
		rec := httptest.NewRecorder()
		env.e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", path, rec.Code)
		}
	}
	get("/api/pages/home") // miss: nothing cached yet
	get("/api/pages/home") // hit: same key, within the TTL
	// A year-range scope is a one-off that is never shared between visitors, so
	// the handler routes around the cache entirely.
	get("/api/pages/home?year_from=2020&year_to=2021")

	body, _ := env.render(t)
	for _, want := range []string{
		`point_page_cache_total{result="hit"} 1`,
		`point_page_cache_total{result="miss"} 1`,
		`point_page_cache_total{result="bypass"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

// itoa keeps the assertions above readable without importing strconv for one call.
func itoa(n int) string { return fmt.Sprintf("%d", n) }
