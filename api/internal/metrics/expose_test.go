package metrics

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

// sample is one parsed exposition line.
type sample struct {
	name   string
	labels map[string]string
	value  string
}

// parseExposition is a deliberately strict reader of the text format: it fails
// the test on anything it does not understand, so a malformed line is caught
// here rather than by a scraper months later.
func parseExposition(t *testing.T, body string) []sample {
	t.Helper()
	var out []sample
	seenType := map[string]bool{}
	for _, line := range strings.Split(strings.TrimRight(body, "\n"), "\n") {
		if line == "" {
			t.Fatalf("blank line in exposition")
		}
		if strings.HasPrefix(line, "# TYPE ") {
			fields := strings.Fields(line)
			if len(fields) != 4 {
				t.Fatalf("malformed TYPE line: %q", line)
			}
			if seenType[fields[2]] {
				t.Errorf("metric family %q declared twice", fields[2])
			}
			seenType[fields[2]] = true
			continue
		}
		if strings.HasPrefix(line, "#") {
			continue
		}
		space := strings.LastIndexByte(line, ' ')
		if space < 0 {
			t.Fatalf("sample line has no value: %q", line)
		}
		series, value := line[:space], line[space+1:]
		switch value {
		case "NaN", "+Inf", "-Inf":
		default:
			if _, err := strconv.ParseFloat(value, 64); err != nil {
				t.Fatalf("sample %q has unparseable value %q", line, value)
			}
		}
		s := sample{name: series, labels: map[string]string{}, value: value}
		if i := strings.IndexByte(series, '{'); i >= 0 {
			if !strings.HasSuffix(series, "}") {
				t.Fatalf("unterminated label set: %q", line)
			}
			s.name = series[:i]
			for _, pair := range splitLabels(series[i+1 : len(series)-1]) {
				k, v, ok := strings.Cut(pair, "=")
				if !ok {
					t.Fatalf("malformed label %q in %q", pair, line)
				}
				s.labels[k] = strings.Trim(v, `"`)
			}
		}
		out = append(out, s)
	}
	return out
}

// splitLabels splits on commas that are not inside a quoted value.
func splitLabels(s string) []string {
	var out []string
	var cur strings.Builder
	inQuote := false
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '\\' && inQuote && i+1 < len(s):
			cur.WriteByte(s[i])
			i++
			cur.WriteByte(s[i])
		case s[i] == '"':
			inQuote = !inQuote
			cur.WriteByte(s[i])
		case s[i] == ',' && !inQuote:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteByte(s[i])
		}
	}
	if cur.Len() > 0 {
		out = append(out, cur.String())
	}
	return out
}

func render(t *testing.T, reg *Registry, src Sources) (string, int) {
	t.Helper()
	var buf bytes.Buffer
	n, err := Render(&buf, reg, src)
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	return buf.String(), n
}

func TestRenderIsWellFormed(t *testing.T) {
	reg := New()
	reg.ObserveRequest(ClassHome, 200, 30*time.Millisecond)
	reg.ObserveRequest(ClassAPIWrite, 404, 2*time.Second)
	reg.Panic(PanicHTTP)
	reg.PageCache(CacheHit)
	reg.RateLimited(LimiterPublic)
	reg.ViewFlushFailure()

	body, n := render(t, reg, Sources{
		Version:      "1.2.3",
		Uptime:       func() time.Duration { return 90 * time.Second },
		ViewsPending: func() int { return 4 },
	})
	samples := parseExposition(t, body)
	if len(samples) != n {
		t.Errorf("Render reported %d series, exposition has %d", n, len(samples))
	}

	// Every sample belongs to a declared family. A histogram's _bucket/_sum/
	// _count suffixes share their family's declaration.
	if !strings.Contains(body, `point_build_info{version="1.2.3"} 1`) {
		t.Errorf("build info missing:\n%s", body)
	}
	want := map[string]string{
		"point_uptime_seconds":                      "90",
		"point_http_request_duration_seconds_count": "2",
		"point_view_flush_failures_total":           "1",
		"point_view_buffer_pending":                 "4",
	}
	got := map[string]string{}
	for _, s := range samples {
		if _, ok := want[s.name]; ok && len(s.labels) == 0 {
			got[s.name] = s.value
		}
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
}

// TestHistogramIsCumulative is the one piece of exposition arithmetic that is
// easy to get wrong and impossible to notice by eye: buckets are counts of
// "at most le", not counts of "in this band".
func TestHistogramIsCumulative(t *testing.T) {
	reg := New()
	// One observation into the first bucket, one into the last finite one, one
	// past every bound.
	reg.ObserveRequest(ClassHome, 200, 1*time.Millisecond)
	reg.ObserveRequest(ClassHome, 200, 4*time.Second)
	reg.ObserveRequest(ClassHome, 200, 30*time.Second)

	body, _ := render(t, reg, Sources{})
	buckets := map[string]float64{}
	for _, s := range parseExposition(t, body) {
		if s.name != "point_http_request_duration_seconds_bucket" {
			continue
		}
		v, err := strconv.ParseFloat(s.value, 64)
		if err != nil {
			t.Fatalf("bucket %v: %v", s.labels, err)
		}
		buckets[s.labels["le"]] = v
	}
	if len(buckets) != len(latencyBuckets)+1 {
		t.Fatalf("got %d buckets, want %d", len(buckets), len(latencyBuckets)+1)
	}
	if buckets["0.005"] != 1 {
		t.Errorf("le=0.005 = %v, want 1", buckets["0.005"])
	}
	if buckets["5"] != 2 {
		t.Errorf("le=5 = %v, want 2 (cumulative)", buckets["5"])
	}
	if buckets["+Inf"] != 3 {
		t.Errorf("le=+Inf = %v, want 3", buckets["+Inf"])
	}
	// Monotonic, which is what "cumulative" means and what a scraper rejects
	// the whole histogram for lacking.
	prev := 0.0
	for _, ub := range latencyBuckets {
		v := buckets[formatValue(ub)]
		if v < prev {
			t.Errorf("bucket le=%v (%v) is below the previous one (%v)", ub, v, prev)
		}
		prev = v
	}
}

// TestZeroHTTPRowsAreSkipped: 14 route classes times 4 status classes is 56
// possible rows, and an idle instance must not pay for the 56 it never used.
func TestZeroHTTPRowsAreSkipped(t *testing.T) {
	reg := New()
	reg.ObserveRequest(ClassHome, 200, time.Millisecond)
	body, _ := render(t, reg, Sources{})
	n := strings.Count(body, "point_http_requests_total{")
	if n != 1 {
		t.Errorf("got %d point_http_requests_total rows for one request, want 1", n)
	}
}

// TestNilRegistryIsInert is what METRICS_ENABLED=false relies on at every call
// site: the nil check lives in the package, not in the callers.
func TestNilRegistryIsInert(t *testing.T) {
	var reg *Registry
	reg.ObserveRequest(ClassHome, 200, time.Second)
	reg.InFlight(1)
	reg.Panic(PanicHTTP)
	reg.PageCache(CacheMiss)
	reg.RateLimited(LimiterPublic)
	reg.ViewFlushFailure()

	body, _ := render(t, reg, Sources{})
	if strings.Contains(body, "point_http_requests_total{") {
		t.Error("a nil registry produced HTTP counters")
	}
	// The process gauges still render: they are read from the runtime, not
	// from the registry.
	if !strings.Contains(body, "point_goroutines") {
		t.Error("process gauges should render without a registry")
	}
}

// TestLabelEscaping guards the one label whose value is not a Go enum. An
// unescaped quote does not corrupt its own line, it corrupts the scrape.
func TestLabelEscaping(t *testing.T) {
	body, _ := render(t, New(), Sources{
		Tasks: func() []Task {
			return []Task{{Name: `we"ird\task` + "\n2", Runs: 1}}
		},
	})
	if !strings.Contains(body, `task="we\"ird\\task\n2"`) {
		t.Errorf("task label was not escaped:\n%s", body)
	}
	parseExposition(t, body) // must still parse
}

// TestTaskLabelIsCapped: the task label is a map key rather than an enum, so
// the cap is the only thing standing between a caller that mints names and an
// unbounded label.
func TestTaskLabelIsCapped(t *testing.T) {
	body, _ := render(t, New(), Sources{
		Tasks: func() []Task {
			out := make([]Task, maxTasks+50)
			for i := range out {
				out[i] = Task{Name: "task-" + strconv.Itoa(i), Runs: 1}
			}
			return out
		},
	})
	if n := strings.Count(body, "point_task_runs_total{"); n != maxTasks {
		t.Errorf("got %d task rows, want the cap of %d", n, maxTasks)
	}
}

// TestNeverSucceededTaskHasNoTimestamp: "never ran" and "succeeded in 1970"
// must not look the same, since an alert on staleness would fire for both.
func TestNeverSucceededTaskHasNoTimestamp(t *testing.T) {
	body, _ := render(t, New(), Sources{
		Tasks: func() []Task {
			return []Task{
				{Name: "never", Runs: 3, Failures: 3},
				{Name: "ok", Runs: 1, LastSuccess: time.Unix(1700000000, 0)},
			}
		},
	})
	if strings.Contains(body, `point_task_last_success_timestamp_seconds{task="never"}`) {
		t.Error("a job that never succeeded got a last-success timestamp")
	}
	if !strings.Contains(body, `point_task_last_success_timestamp_seconds{task="ok"} 1.7e+09`) {
		t.Errorf("expected a last-success timestamp for the healthy job:\n%s", body)
	}
}

// TestStorageOmittedWhenUnavailable: a scrape taken while the database is
// unreachable must not report a blog with zero posts.
func TestStorageOmittedWhenUnavailable(t *testing.T) {
	body, _ := render(t, New(), Sources{
		Storage: func() (Storage, bool) { return Storage{}, false },
	})
	if strings.Contains(body, "point_posts_total") {
		t.Error("post counts were emitted from a failed storage read")
	}
}

// TestOptionalGaugesOmitted: a quota of zero means "unlimited", not "no space
// left", and an unmeasurable database file means unknown, not empty.
func TestOptionalGaugesOmitted(t *testing.T) {
	body, _ := render(t, New(), Sources{
		Storage: func() (Storage, bool) {
			return Storage{UsedBytes: 10, Published: 2, Draft: 1, Media: 7}, true
		},
	})
	if strings.Contains(body, "point_storage_quota_bytes") {
		t.Error("an unset quota was emitted as 0")
	}
	if strings.Contains(body, "point_db_size_bytes") {
		t.Error("an unmeasurable database was emitted as 0")
	}
	for _, want := range []string{
		`point_posts_total{status="published"} 2`,
		`point_posts_total{status="draft"} 1`,
		`point_posts_total{status="other"} 0`,
		"point_media_total 7",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in:\n%s", want, body)
		}
	}
}

func TestHandlerServesOnlyMetricsPath(t *testing.T) {
	h := Handler(New(), Sources{Version: "1.0.0"})

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("/metrics = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != ContentType {
		t.Errorf("Content-Type = %q, want %q", ct, ContentType)
	}
	if !strings.Contains(rec.Body.String(), `point_build_info{version="1.0.0"} 1`) {
		t.Errorf("build info missing:\n%s", rec.Body.String())
	}

	// Nothing else is served: this listener has one job, and a second path is a
	// second thing to reason about the exposure of.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
	if rec.Code != http.StatusNotFound {
		t.Errorf("/ = %d, want 404", rec.Code)
	}
}

// TestStatusClassBoundaries pins the rounding, including the codes outside
// 200-599 that must still land inside the closed label set.
func TestStatusClassBoundaries(t *testing.T) {
	cases := map[int]StatusClass{
		0: Status2xx, 100: Status2xx, 200: Status2xx, 299: Status2xx,
		300: Status3xx, 399: Status3xx,
		400: Status4xx, 429: Status4xx, 499: Status4xx,
		500: Status5xx, 599: Status5xx, 999: Status5xx,
	}
	for code, want := range cases {
		if got := classifyStatus(code); got != want {
			t.Errorf("classifyStatus(%d) = %s, want %s", code, got, want)
		}
	}
}
