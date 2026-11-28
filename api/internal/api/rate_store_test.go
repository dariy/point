package api

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

// TestQuietRateStore_RetryAfterOnly: an allowed request gets no rate limit
// header. A denied request gets Retry-After (a positive integer of seconds)
// and no X-RateLimit-* header.
func TestQuietRateStore_RetryAfterOnly(t *testing.T) {
	e := echo.New()
	e.Use(middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: QuietRateStore(middleware.NewRateLimiterMemoryStoreWithConfig(
			middleware.RateLimiterMemoryStoreConfig{Rate: 0.1, Burst: 1})),
	}))
	e.GET("/", func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) })

	for i, want := range []int{http.StatusNoContent, http.StatusTooManyRequests} {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != want {
			t.Fatalf("request %d: status %d, want %d", i, rec.Code, want)
		}
		assertRateLimitHeaders(t, rec)
	}
}

// fakeStore implements only Allow.
type fakeStore struct{ allow bool }

func (f fakeStore) Allow(string) (bool, error) { return f.allow, nil }

// TestQuietRateStore_PlainStore: a store without AllowContext still decides.
func TestQuietRateStore_PlainStore(t *testing.T) {
	e := echo.New()
	c := e.NewContext(httptest.NewRequest(http.MethodGet, "/", nil), httptest.NewRecorder())
	for _, want := range []bool{true, false} {
		got, err := QuietRateStore(fakeStore{want}).(middleware.RateLimiterStoreContext).AllowContext(c, "x")
		if err != nil || got != want {
			t.Errorf("AllowContext = %v, %v; want %v, nil", got, err, want)
		}
	}
}

// assertRateLimitHeaders checks the rate limit headers of a response: no
// X-RateLimit-* header on any response, and Retry-After (a positive integer
// of seconds) on a 429 only.
func assertRateLimitHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	for _, h := range []string{middleware.HeaderXRateLimitLimit, middleware.HeaderXRateLimitRemaining} {
		if v := rec.Header().Get(h); v != "" {
			t.Errorf("status %d: %s = %q, want no header", rec.Code, h, v)
		}
	}
	ra := rec.Header().Get(echo.HeaderRetryAfter)
	if rec.Code != http.StatusTooManyRequests {
		if ra != "" {
			t.Errorf("status %d: Retry-After = %q, want no header", rec.Code, ra)
		}
		return
	}
	if n, err := strconv.Atoi(ra); err != nil || n < 1 {
		t.Errorf("429: Retry-After = %q, want a positive integer of seconds", ra)
	}
}
