# Observability

Two layers, and they answer different questions.

**Without configuring anything**, `/api/system/health` reports the last outcome of every
background job — the scheduler's five tasks, Instagram cross-posts, the comments sidecar,
the off-host backup copy (`BACKUP_HOOK`) — and the admin Health card renders it. It answers *"is anything quietly broken right
now"*, in memory, per process, with no scrape target and no retention policy. That is the
zero-configuration answer and it is not deprecated by anything below.

**With `METRICS_ENABLED=true`**, the engine additionally serves Prometheus text exposition
at `/metrics` on a **second listener**. That answers the questions the health endpoint
structurally cannot: rates over time, error rates by area, cache effectiveness, latency
distribution, and how any of it moved after a deploy.

## What is implemented

| Group | Metrics |
|---|---|
| build / process | `point_build_info{version}`, `point_uptime_seconds`, `point_goroutines`, `point_heap_alloc_bytes`, `point_gc_pause_seconds_total` |
| http | `point_http_requests_total{route_class,status_class}`, `point_http_route_seconds_total{route_class}`, `point_http_request_duration_seconds` (global histogram), `point_http_in_flight` |
| panics | `point_panics_total{site}` — `http`, `scheduler` |
| scheduler | `point_task_runs_total{task}`, `point_task_failures_total{task}`, `point_task_last_success_timestamp_seconds{task}` |
| page cache | `point_page_cache_total{result}` — `hit`, `miss`, `bypass` |
| rate limit | `point_ratelimit_rejected_total{limiter}` — `public`, `credential`, `mcp_oauth` |
| storage | `point_storage_used_bytes`, `point_storage_quota_bytes`, `point_db_size_bytes`, `point_posts_total{status}`, `point_media_total` |
| views | `point_view_flush_failures_total`, `point_view_buffer_pending` |

About 60 series on a live instance; ~74 in the test that drives traffic across every route
class. Configuration is three variables, documented in
[`build/.env.example`](../../build/.env.example):

```
METRICS_ENABLED=false     # off by default
METRICS_BIND=127.0.0.1    # this is the access policy — see below
METRICS_PORT=9101
```

## Key decisions

### Off by default, and off means nothing runs

`METRICS_ENABLED=false` leaves `AppServices.Metrics` nil. `setupEcho` then omits the
instrumenting middleware from the chain entirely, `main` never starts the listener, and
every counter method is nil-safe so no call site needs a branch. A self-hoster who sets
nothing runs the code the engine ran before this feature existed —
`TestMetricsDisabledChangesNothing` asserts it.

### A second listener, not a route

`/metrics` is served by its own `http.Server`, not by Echo. That buys four things at once:

- **No auth decision to get wrong.** A route on the public port would need either a token
  (one more secret to configure and rotate) or nothing at all (an unauthenticated leak of
  post counts, storage usage and error rates). Here `METRICS_BIND` *is* the access policy,
  and it defaults to loopback.
- **No interaction with the middleware chain** — gzip, CORS, CSP, the body limit and the
  HTTPS redirect all apply to the blog, none of them apply here.
- **No exemption in `publicLimiter.Skipper`**, which currently special-cases `/health` by
  exact path. A scrape every 15s against a burst budget shared with real visitors is a
  problem that simply never arises.
- **The scrape cannot be starved by the blog**, or vice versa: separate listeners,
  separate timeouts.

### Cardinality is the load-bearing constraint

The engine registers ~190 method+path pairs. A `path` label would mint several thousand
series per instance — more than a modest TSDB holds in total, for one blog. So:

- **`route_class` comes from a closed Go enum of 14 values** (`home`, `post`, `tag`,
  `media`, `assets`, `spa`, `feed`, `api_read`, `api_write`, `admin`, `mcp`, `auth`,
  `health`, `other`), mapped from `c.Path()` — the matched route *template*, never the
  URL. See `ClassifyRoute` in `api/internal/metrics/route_class.go`; the ordered rules are
  the definition of each class.
- **Every counter is a fixed-size array indexed by an enum**, not a map keyed by a string.
  A series that is not in an array literal cannot be created — not "should not", *cannot*.
  The ceiling is a property of the type system rather than of anybody's discipline.
- **`status_class` is `2xx|3xx|4xx|5xx`**, never the raw status. Four series where the
  codes behind them are forty.
- The one label that is not an enum is `task`, whose values are map keys in
  `services.HealthRegistry`. Every caller passes a string literal, but that is a property
  of today's code rather than of the type system, so the exposition caps it at
  `maxTasks` (32) as belt-and-braces.

Three tests hold this down, and the important one asserts a **count**, not content — a
cardinality regression is perfectly well-formed text, so every content assertion would
keep passing while the series count multiplied:

| Test | Claim |
|---|---|
| `TestRouteClassCoversEveryRegisteredRoute` | every route the server registers has a class, and none falls through to `other` |
| `TestMetricsCardinalityCeiling` | after driving 39 distinct routes, the exposition is under 150 series and every label name and `route_class` value is in the allow-list |
| `TestRouteClassSetIsClosed` | the allow-list itself has not grown |

`other` is reserved for a request that matched no route at all. A registered route landing
there would mean a new area of the API was being counted as an anomaly, which is why the
test fails on it rather than tolerating it.

### One histogram, unlabelled — and why per-class latency is a separate family

There is exactly one latency histogram, with eight buckets from 5ms (a page-cache hit) to
5s (an upload or a cold render), and it carries no labels. Bucketing per `route_class`
would be 14 × 9 = 126 series on its own, more than everything else here put together.

Per-class latency instead lives in `point_http_route_seconds_total{route_class}`, a
counter of cumulative seconds. Divide it by `point_http_requests_total` for a mean per
class:

```promql
rate(point_http_route_seconds_total[5m])
  / sum by (route_class) (rate(point_http_requests_total[5m]))
```

This is a *separate metric family* on purpose, not a labelled `_sum` on the histogram.
Within one family every series must carry the same label names, so an unlabelled
`point_http_request_duration_seconds_sum` and a labelled
`point_http_request_duration_seconds_sum{route_class="home"}` cannot coexist — that would
be invalid exposition, not merely untidy.

### Counting happens where the answer already is

Nothing here keeps a second copy of a number something else already owns:

| Signal | Read from |
|---|---|
| task runs / failures / last success | `services.HealthRegistry.Snapshot()` — a registry in all but name since long before `/metrics` |
| storage, post and media counts | `repo.GetSystemStats` (the same query the dashboard uses) |
| pending view counts | `PostService.PendingViewCounts()` — the buffer itself, not a mirror |
| uptime | `api.StartTime()`, shared with `/api/system/health` and `/api/system/stats` |

Those are read **at scrape time** through `metrics.Sources`. Only genuinely
event-shaped things (a request completed, a panic was recovered, a cache was missed) are
counted as they happen. A `Sources` func that is nil omits its metrics rather than
emitting a zero, because "not collected" and "zero" must not look the same on a graph —
likewise a failed `GetSystemStats` omits the storage gauges rather than reporting a blog
that has lost every post.

### Known blind spot: MCP tool calls

MCP tool calls re-enter the REST handlers **in-process**: `invoker.serve`
(`api/internal/mcp/invoke.go`) builds a synthetic `echo.Context` with `e.NewContext` and
calls the handler function directly, so the Echo middleware chain — including the metrics
middleware — never runs. A blog driven entirely through MCP will show its writes in
`point_posts_total` and its cache invalidations in `point_page_cache_total`, but **not** in
`point_http_requests_total`.

This is documented rather than fixed. Instrumenting at the handler would mean touching
every handler; instrumenting at the tool dispatch would produce a `route_class` for a call
that had no route. The one MCP surface that *is* counted is the OAuth password throttle,
because it is real middleware on a real route (`point_ratelimit_rejected_total{limiter="mcp_oauth"}`).

### Recovered panics now reach the app log

Instrumenting `middleware.Recover` surfaced a separate bug worth naming: Echo's default
recover handler writes the stack through `c.Logger()`, which this server never points at
`slog`. Panics therefore went to stderr in Echo's own format and never reached
`app.log` — the file the admin Logs page reads, and the only one visible from inside a
container. The `LogErrorFunc` that increments `point_panics_total` also logs through
`slog`, so they land there now. The response is unchanged: the error still goes to the
centralized handler and the client still gets its 500.

### Background goroutines recover too

`middleware.Recover` only covers the HTTP request goroutine. Detached work — the API-key
last-used touch, the Instagram import, the backup archive, the restart signal — runs in a
bare `go func()` with no such backstop, so a panic there took the **whole process** down
and left nothing in `app.log` to say why. Each now defers `utils.SafeGo` /
`utils.Recovered` (`api/internal/utils/recover.go`), which logs the panic and stack
through `slog` and lets the process live. The Instagram import additionally resets its
`running` flag from the recover so a later import can still start. The scheduler
(`SchedulerService.runTask`) and the Instagram cross-post already did this inline; the
helper is that same pattern. These sites are **not** counted in `point_panics_total` —
that counter is for the two middleware-style choke points, not every goroutine.

`safeImagingDecode` (`api/internal/services/media_service.go`) already turned decode
panics from crafted images into a returned error; it now also logs them at `warn` with a
stack, so a caller that swallows the error does not make the panic invisible.

## Log level

`LOG_LEVEL` (`debug`, `info`, `warn`, `error`; default `info`) sets the minimum slog
level. It is read once at startup in `api/cmd/api/main.go` (`parseLogLevel` →
`slog.HandlerOptions.Level`); an unrecognised value falls back to `info`. There is no
runtime switch. `DEBUG` used to be documented as a production toggle but was never wired
to anything — it has been removed.

## Considered and rejected

- **`prometheus/client_golang`.** The engine ships to strangers as one binary with no
  runtime service dependencies, and that promise is worth more than the convenience. The
  text format is a few hundred lines to write; the exposition writer in
  `api/internal/metrics/expose.go` is smaller than the dependency's own registry code.
  Hand-writing every line is also what keeps the label allow-list honest — with a client
  library, `WithLabelValues(path)` is one line away and nothing stops it.
- **`echo-contrib/echoprometheus`.** It labels by **URL path by default**, which is
  precisely the cardinality trap this design exists to avoid: it would have produced
  thousands of series per instance, and the failure mode is silent — everything works,
  the TSDB fills, and someone notices months later.
- **Per-`route_class` histogram buckets.** 126 series for a question that a ratio of two
  counters answers (see above). Rejected as ~80% of the total series budget for ~5% of the
  value.
- **Raw HTTP status codes as a label.** Ten times the series, and no query anyone writes
  needs to separate 502 from 503 on a single-binary blog. `status_class` it is.
- **A `/metrics` route on the main port, gated by an API key.** Adds a secret to
  configure, rotate and leak; adds an exemption to the rate limiter; puts the endpoint
  behind gzip and CSP for no reason. The second listener has none of those costs and a
  strictly better default (loopback).
- **Distributed tracing (OpenTelemetry).** Point is one process with one database and no
  network hops between components — a trace would be a call stack with extra steps, and
  the collector is exactly the runtime service dependency the engine promises not to
  need. The latency histogram plus the request log covers what a trace would be consulted
  for here.
- **Persisting metrics across restarts.** Prometheus already handles counter resets, and
  writing counters to SQLite on a timer would add write load in exchange for a graph
  Prometheus draws correctly without it.
- **Exporting per-post or per-tag counters.** Analytics is a product feature with its own
  storage and its own endpoints (`/api/posts/analytics`). Per-entity series in a metrics
  system is the same cardinality mistake as a `path` label, wearing a different hat.

## Files

| Path | Role |
|---|---|
| `api/internal/metrics/metrics.go` | the enums and the counter arrays — the cardinality ceiling itself |
| `api/internal/metrics/route_class.go` | `ClassifyRoute`, the ordered template → class rules |
| `api/internal/metrics/expose.go` | the text-format writer, `Sources`, and the HTTP handler |
| `api/cmd/api/metrics.go` | the request middleware, the scrape-time sources, the second listener |
| `api/cmd/api/server.go` | where the middleware, the recover counter and the limiter counters attach |
| `api/internal/config/config.go` | `METRICS_ENABLED` / `METRICS_BIND` / `METRICS_PORT` / `LOG_LEVEL` |
| `api/internal/utils/recover.go` | `SafeGo` / `Recovered` — the panic backstop for bare background goroutines |
| `api/cmd/api/main.go` | `parseLogLevel`, `installLogger` — where `LOG_LEVEL` becomes the slog level |
