// Package metrics is the engine's Prometheus exposition, hand-written against
// the text format with nothing but the standard library.
//
// Two decisions shape everything here.
//
// The first is that there is no client library. Point ships to strangers as one
// binary with no runtime service dependencies, and that promise is worth more
// than the convenience of prometheus/client_golang. The exposition format is a
// few hundred lines of text; writing it out is cheaper than the dependency.
//
// The second is that every label value comes from a closed Go enum, and every
// counter lives in a fixed-size array indexed by it. This is the load-bearing
// constraint. The engine registers ~190 method+path pairs, so a `path` label
// would mint thousands of series per instance — more than a modest TSDB holds
// in total. Here a series that is not in an array literal cannot be created:
// not "should not", cannot. The ceiling is a property of the type system rather
// than of anybody's discipline, and metrics_test.go asserts the arithmetic.
//
// A nil *Registry is usable and does nothing, which is what makes
// METRICS_ENABLED=false cost one nil check per request instead of a branch at
// every call site.
package metrics

import (
	"sync/atomic"
	"time"
)

// RouteClass is the bucket a matched route template falls into. It is the only
// route dimension the exposition carries — see ClassifyRoute for the mapping
// and why it is a closed list.
type RouteClass uint8

const (
	ClassHome RouteClass = iota
	ClassPost
	ClassTag
	ClassMedia
	ClassAssets
	ClassSPA
	ClassFeed
	ClassAPIRead
	ClassAPIWrite
	ClassAdmin
	ClassMCP
	ClassAuth
	ClassHealth
	ClassOther
	numRouteClass
)

var routeClassNames = [numRouteClass]string{
	ClassHome:     "home",
	ClassPost:     "post",
	ClassTag:      "tag",
	ClassMedia:    "media",
	ClassAssets:   "assets",
	ClassSPA:      "spa",
	ClassFeed:     "feed",
	ClassAPIRead:  "api_read",
	ClassAPIWrite: "api_write",
	ClassAdmin:    "admin",
	ClassMCP:      "mcp",
	ClassAuth:     "auth",
	ClassHealth:   "health",
	ClassOther:    "other",
}

func (c RouteClass) String() string {
	if c >= numRouteClass {
		return routeClassNames[ClassOther]
	}
	return routeClassNames[c]
}

// RouteClasses returns every value the route_class label may take, in exposition
// order. The test that asserts the label set is closed reads it from here.
func RouteClasses() []string {
	out := make([]string, 0, numRouteClass)
	for i := RouteClass(0); i < numRouteClass; i++ {
		out = append(out, i.String())
	}
	return out
}

// StatusClass is the response status rounded to its hundred. Never the raw
// status: 4xx is four series where the codes behind it are forty.
type StatusClass uint8

const (
	Status2xx StatusClass = iota
	Status3xx
	Status4xx
	Status5xx
	numStatusClass
)

var statusClassNames = [numStatusClass]string{
	Status2xx: "2xx",
	Status3xx: "3xx",
	Status4xx: "4xx",
	Status5xx: "5xx",
}

func (s StatusClass) String() string { return statusClassNames[s] }

// classifyStatus is total over the int range: anything below 300 — including
// the 1xx codes Echo never produces and a zero from a hijacked response — reads
// as 2xx rather than falling out of the label set.
func classifyStatus(code int) StatusClass {
	switch {
	case code >= 500:
		return Status5xx
	case code >= 400:
		return Status4xx
	case code >= 300:
		return Status3xx
	default:
		return Status2xx
	}
}

// PanicSite names a place that recovers panics. Both sites exist because a
// panic there is survivable and therefore silent — the HTTP one is swallowed by
// middleware.Recover, the scheduler one by runTask.
type PanicSite uint8

const (
	PanicHTTP PanicSite = iota
	PanicScheduler
	numPanicSite
)

var panicSiteNames = [numPanicSite]string{
	PanicHTTP:      "http",
	PanicScheduler: "scheduler",
}

// CacheResult is the outcome of a page render against the on-disk page cache.
// bypass is a render that was never cacheable (a logged-in view, a query the
// cache does not key on), which is worth separating from a miss: a rising
// bypass rate is a routing change, a rising miss rate is an eviction problem.
type CacheResult uint8

const (
	CacheHit CacheResult = iota
	CacheMiss
	CacheBypass
	numCacheResult
)

var cacheResultNames = [numCacheResult]string{
	CacheHit:    "hit",
	CacheMiss:   "miss",
	CacheBypass: "bypass",
}

// Limiter names a rate limiter that can reject a request.
type Limiter uint8

const (
	LimiterPublic Limiter = iota
	LimiterCredential
	LimiterMCPOAuth
	numLimiter
)

var limiterNames = [numLimiter]string{
	LimiterPublic:     "public",
	LimiterCredential: "credential",
	LimiterMCPOAuth:   "mcp_oauth",
}

// latencyBuckets are the upper bounds of the global request histogram, in
// seconds. Eight of them, plus the implicit +Inf.
//
// There is exactly one histogram and it carries no labels. Bucketing per
// route_class would be 14 x 9 = 126 series on its own — more than everything
// else in this file put together — for a question ("which class is slow")
// that point_http_route_seconds_total answers as a ratio against
// point_http_requests_total. The spread runs from 5ms (a cache hit) to 5s
// (an upload or a cold render) because that is the range this engine actually
// produces.
var latencyBuckets = [8]float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5}

// Registry holds every counter the process increments as work happens.
//
// Gauges are deliberately absent: a value that can be read at scrape time
// (goroutines, storage bytes, task health) is read then, from whoever already
// owns it, rather than mirrored into a counter that could drift. Those arrive
// through Sources.
//
// Every field is an atomic in a fixed-size array, so the whole struct is safe
// to touch from any goroutine without a lock, and writing a metric costs one
// atomic add on the request path.
type Registry struct {
	httpRequests [numRouteClass][numStatusClass]atomic.Int64
	// httpNanos accumulates request latency per class as nanoseconds. Kept as
	// an integer so the add is atomic; divided into seconds at scrape. int64
	// nanoseconds overflows after 292 years of accumulated latency.
	httpNanos    [numRouteClass]atomic.Int64
	httpBuckets  [len(latencyBuckets) + 1]atomic.Int64 // last element is +Inf
	httpNanosAll atomic.Int64
	httpCountAll atomic.Int64
	httpInFlight atomic.Int64

	panics    [numPanicSite]atomic.Int64
	pageCache [numCacheResult]atomic.Int64
	limited   [numLimiter]atomic.Int64

	viewFlushFailures atomic.Int64
}

// New builds a registry. Callers that have metrics disabled hold a nil
// *Registry instead and never call this.
func New() *Registry { return &Registry{} }

// ObserveRequest records one completed HTTP request.
func (r *Registry) ObserveRequest(class RouteClass, status int, d time.Duration) {
	if r == nil {
		return
	}
	if class >= numRouteClass {
		class = ClassOther
	}
	r.httpRequests[class][classifyStatus(status)].Add(1)

	ns := d.Nanoseconds()
	if ns < 0 {
		// A clock that went backwards must not corrupt a monotonic counter.
		ns = 0
	}
	r.httpNanos[class].Add(ns)
	r.httpNanosAll.Add(ns)
	r.httpCountAll.Add(1)

	secs := d.Seconds()
	i := 0
	for ; i < len(latencyBuckets); i++ {
		if secs <= latencyBuckets[i] {
			break
		}
	}
	// i == len(latencyBuckets) lands on the +Inf slot.
	r.httpBuckets[i].Add(1)
}

// InFlight adds delta to the in-flight request gauge. The middleware calls it
// with +1 on entry and -1 on exit.
func (r *Registry) InFlight(delta int64) {
	if r == nil {
		return
	}
	r.httpInFlight.Add(delta)
}

// Panic records a recovered panic at site.
func (r *Registry) Panic(site PanicSite) {
	if r == nil || site >= numPanicSite {
		return
	}
	r.panics[site].Add(1)
}

// PageCache records one page render against the on-disk cache.
func (r *Registry) PageCache(result CacheResult) {
	if r == nil || result >= numCacheResult {
		return
	}
	r.pageCache[result].Add(1)
}

// RateLimited records one request rejected by limiter l.
func (r *Registry) RateLimited(l Limiter) {
	if r == nil || l >= numLimiter {
		return
	}
	r.limited[l].Add(1)
}

// ViewFlushFailure records one post whose buffered view count could not be
// written back. Each failure is a permanently lost count, so it is the one
// scheduler outcome that deserves a counter of its own rather than only the
// task's pass/fail.
func (r *Registry) ViewFlushFailure() {
	if r == nil {
		return
	}
	r.viewFlushFailures.Add(1)
}
