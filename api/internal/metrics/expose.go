package metrics

import (
	"bytes"
	"io"
	"math"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Task is one background job's outcome history, as the exposition needs it.
// It is filled from services.HealthRegistry, which has recorded exactly this
// since long before there was a /metrics — the scheduler is not counted twice.
type Task struct {
	Name        string
	Runs        int64
	Failures    int64
	LastSuccess time.Time
}

// maxTasks caps how many task series the exposition will emit.
//
// The task label is the one label value in this package that does not come from
// a Go enum: it is a map key in the health registry, written by callers that all
// pass string literals. The cap is there because "all callers pass literals" is
// a property of today's code rather than of the type system, and an unbounded
// label is exactly the failure this package exists to prevent. Seven tasks exist;
// hitting this would mean something started minting names.
const maxTasks = 32

// Storage is the on-disk and in-database state, read at scrape time.
type Storage struct {
	UsedBytes  int64
	QuotaBytes int64 // 0 when the operator set no quota; then it is not emitted
	DBBytes    int64 // 0 when the database file could not be stat'd; not emitted
	Published  int64
	Draft      int64
	OtherPosts int64
	Media      int64
}

// Sources are the values read at scrape time rather than counted as they
// happen. Each one is owned by something that already tracks it — the health
// registry, the repository, the post service — so the exposition reads that
// owner instead of keeping a second copy that could drift from it.
//
// Every field is optional; a nil func omits its metrics rather than emitting a
// zero, because "not collected" and "zero" must not look the same on a graph.
type Sources struct {
	Version      string
	Uptime       func() time.Duration
	Tasks        func() []Task
	Storage      func() (Storage, bool)
	ViewsPending func() int
}

// writer accumulates the exposition and counts the series in it. The count is
// what metrics_test.go asserts a ceiling on: content alone would not catch a
// cardinality regression, since a wrong label looks perfectly well-formed.
type writer struct {
	b       bytes.Buffer
	samples int
}

func (w *writer) family(name, typ, help string) {
	w.b.WriteString("# HELP ")
	w.b.WriteString(name)
	w.b.WriteByte(' ')
	w.b.WriteString(help)
	w.b.WriteString("\n# TYPE ")
	w.b.WriteString(name)
	w.b.WriteByte(' ')
	w.b.WriteString(typ)
	w.b.WriteByte('\n')
}

// sample writes one series. labels are name/value pairs; an odd tail is
// ignored, which cannot happen from this file's call sites.
func (w *writer) sample(name string, value float64, labels ...string) {
	w.b.WriteString(name)
	for i := 0; i+1 < len(labels); i += 2 {
		if i == 0 {
			w.b.WriteByte('{')
		} else {
			w.b.WriteByte(',')
		}
		w.b.WriteString(labels[i])
		w.b.WriteString(`="`)
		w.b.WriteString(escapeLabel(labels[i+1]))
		w.b.WriteByte('"')
	}
	if len(labels) >= 2 {
		w.b.WriteByte('}')
	}
	w.b.WriteByte(' ')
	w.b.WriteString(formatValue(value))
	w.b.WriteByte('\n')
	w.samples++
}

// escapeLabel applies the three escapes the text format defines for a label
// value. Only the task label can carry anything but an enum name, but the
// escaping is unconditional: a value that slipped through unescaped would make
// the whole scrape unparseable, not just its own line.
func escapeLabel(s string) string {
	if !strings.ContainsAny(s, `\"`+"\n") {
		return s
	}
	r := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`)
	return r.Replace(s)
}

// formatValue renders a float the way the text format wants it: shortest
// round-tripping form, with the three special values spelled out.
func formatValue(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "+Inf"
	case math.IsInf(v, -1):
		return "-Inf"
	}
	return strconv.FormatFloat(v, 'g', -1, 64)
}

// ContentType is the exposition's media type, as Prometheus expects it.
const ContentType = "text/plain; version=0.0.4; charset=utf-8"

// Handler serves the exposition. It is mounted on a listener of its own — see
// cmd/api/metrics.go — so it never touches the main server's middleware chain.
func Handler(reg *Registry, src Sources) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		var buf bytes.Buffer
		if _, err := Render(&buf, reg, src); err != nil {
			http.Error(w, "failed to render metrics", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", ContentType)
		_, _ = w.Write(buf.Bytes())
	})
}

// Render writes the whole exposition to w and returns the number of series it
// contains.
func Render(w io.Writer, reg *Registry, src Sources) (int, error) {
	ew := &writer{}
	writeProcess(ew, src)
	writeHTTP(ew, reg)
	writeCounters(ew, reg)
	writeTasks(ew, src)
	writeStorage(ew, src)
	writeViews(ew, reg, src)
	if _, err := w.Write(ew.b.Bytes()); err != nil {
		return ew.samples, err
	}
	return ew.samples, nil
}

func writeProcess(w *writer, src Sources) {
	if src.Version != "" {
		w.family("point_build_info", "gauge", "Build information; the value is always 1.")
		w.sample("point_build_info", 1, "version", src.Version)
	}
	if src.Uptime != nil {
		w.family("point_uptime_seconds", "gauge", "Seconds since this process started serving.")
		w.sample("point_uptime_seconds", src.Uptime().Seconds())
	}

	w.family("point_goroutines", "gauge", "Goroutines currently running.")
	w.sample("point_goroutines", float64(runtime.NumGoroutine()))

	// ReadMemStats stops the world for the microseconds it takes to copy the
	// stats. At a scrape interval measured in seconds that is not worth the
	// runtime/metrics histogram arithmetic the alternative would need.
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	w.family("point_heap_alloc_bytes", "gauge", "Heap bytes allocated and still in use.")
	w.sample("point_heap_alloc_bytes", float64(ms.HeapAlloc))
	w.family("point_gc_pause_seconds_total", "counter", "Cumulative stop-the-world GC pause time.")
	w.sample("point_gc_pause_seconds_total", float64(ms.PauseTotalNs)/1e9)
}

func writeHTTP(w *writer, reg *Registry) {
	if reg == nil {
		return
	}

	// Zero rows are skipped for the two label-bearing HTTP families: fourteen
	// classes times four status classes is 56 possible series, of which a real
	// instance ever touches a dozen. Prometheus handles a series that appears
	// mid-life; a scrape carrying 44 permanent zeroes is just waste.
	w.family("point_http_requests_total", "counter", "HTTP requests by route class and status class.")
	for c := RouteClass(0); c < numRouteClass; c++ {
		for s := StatusClass(0); s < numStatusClass; s++ {
			if n := reg.httpRequests[c][s].Load(); n != 0 {
				w.sample("point_http_requests_total", float64(n),
					"route_class", c.String(), "status_class", s.String())
			}
		}
	}

	w.family("point_http_route_seconds_total", "counter",
		"Cumulative request latency by route class. Divide by point_http_requests_total for a mean.")
	for c := RouteClass(0); c < numRouteClass; c++ {
		if ns := reg.httpNanos[c].Load(); ns != 0 {
			w.sample("point_http_route_seconds_total", float64(ns)/1e9, "route_class", c.String())
		}
	}

	// The one histogram, unlabelled. Its _sum and _count carry no labels either:
	// within a metric family every series must have the same label names, so a
	// per-class _sum could not share this family — which is why per-class
	// latency lives in point_http_route_seconds_total above instead.
	w.family("point_http_request_duration_seconds", "histogram", "Request latency across all routes.")
	var cumulative int64
	for i, ub := range latencyBuckets {
		cumulative += reg.httpBuckets[i].Load()
		w.sample("point_http_request_duration_seconds_bucket", float64(cumulative),
			"le", formatValue(ub))
	}
	cumulative += reg.httpBuckets[len(latencyBuckets)].Load()
	w.sample("point_http_request_duration_seconds_bucket", float64(cumulative), "le", "+Inf")
	w.sample("point_http_request_duration_seconds_sum", float64(reg.httpNanosAll.Load())/1e9)
	w.sample("point_http_request_duration_seconds_count", float64(reg.httpCountAll.Load()))

	w.family("point_http_in_flight", "gauge", "Requests currently being served.")
	w.sample("point_http_in_flight", float64(reg.httpInFlight.Load()))
}

// writeCounters emits the small closed families in full, zeroes included: eight
// series between them, and an absent point_panics_total reads as "no panics
// recorded" only if you already know the metric exists.
func writeCounters(w *writer, reg *Registry) {
	if reg == nil {
		return
	}
	w.family("point_panics_total", "counter", "Panics recovered, by the site that recovered them.")
	for i := PanicSite(0); i < numPanicSite; i++ {
		w.sample("point_panics_total", float64(reg.panics[i].Load()), "site", panicSiteNames[i])
	}

	w.family("point_page_cache_total", "counter", "Public page renders by cache outcome.")
	for i := CacheResult(0); i < numCacheResult; i++ {
		w.sample("point_page_cache_total", float64(reg.pageCache[i].Load()), "result", cacheResultNames[i])
	}

	w.family("point_ratelimit_rejected_total", "counter", "Requests rejected by a rate limiter.")
	for i := Limiter(0); i < numLimiter; i++ {
		w.sample("point_ratelimit_rejected_total", float64(reg.limited[i].Load()), "limiter", limiterNames[i])
	}
}

func writeTasks(w *writer, src Sources) {
	if src.Tasks == nil {
		return
	}
	tasks := src.Tasks()
	if len(tasks) > maxTasks {
		tasks = tasks[:maxTasks]
	}
	w.family("point_task_runs_total", "counter", "Background job executions since this process started.")
	for _, t := range tasks {
		w.sample("point_task_runs_total", float64(t.Runs), "task", t.Name)
	}
	w.family("point_task_failures_total", "counter", "Background job executions that returned an error or panicked.")
	for _, t := range tasks {
		w.sample("point_task_failures_total", float64(t.Failures), "task", t.Name)
	}
	// A job that has never succeeded in this process has no timestamp at all
	// rather than one at the epoch — "never" and "in 1970" would otherwise fire
	// the same alert for very different reasons.
	w.family("point_task_last_success_timestamp_seconds", "gauge", "When each background job last succeeded.")
	for _, t := range tasks {
		if t.LastSuccess.IsZero() {
			continue
		}
		w.sample("point_task_last_success_timestamp_seconds", float64(t.LastSuccess.Unix()), "task", t.Name)
	}
}

func writeStorage(w *writer, src Sources) {
	if src.Storage == nil {
		return
	}
	s, ok := src.Storage()
	if !ok {
		// The database was unreachable this scrape. Emitting zeroes would say
		// the blog had lost every post.
		return
	}
	w.family("point_storage_used_bytes", "gauge", "Bytes of stored media.")
	w.sample("point_storage_used_bytes", float64(s.UsedBytes))
	if s.QuotaBytes > 0 {
		w.family("point_storage_quota_bytes", "gauge", "Operator-configured media storage allowance.")
		w.sample("point_storage_quota_bytes", float64(s.QuotaBytes))
	}
	if s.DBBytes > 0 {
		w.family("point_db_size_bytes", "gauge", "Size of the SQLite database and its write-ahead log.")
		w.sample("point_db_size_bytes", float64(s.DBBytes))
	}
	w.family("point_posts_total", "gauge", "Posts by status, excluding deleted ones.")
	w.sample("point_posts_total", float64(s.Published), "status", "published")
	w.sample("point_posts_total", float64(s.Draft), "status", "draft")
	w.sample("point_posts_total", float64(s.OtherPosts), "status", "other")
	w.family("point_media_total", "gauge", "Media items on record.")
	w.sample("point_media_total", float64(s.Media))
}

func writeViews(w *writer, reg *Registry, src Sources) {
	if reg != nil {
		w.family("point_view_flush_failures_total", "counter",
			"Buffered post view counts that could not be written back. Each one is permanently lost.")
		w.sample("point_view_flush_failures_total", float64(reg.viewFlushFailures.Load()))
	}
	if src.ViewsPending != nil {
		w.family("point_view_buffer_pending", "gauge", "Posts with view counts buffered in memory, unflushed.")
		w.sample("point_view_buffer_pending", float64(src.ViewsPending()))
	}
}
