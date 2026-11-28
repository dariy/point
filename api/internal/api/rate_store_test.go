package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

// TestQuietRateStore_NoRateLimitHeaders: echo v4 limiters sent no
// X-RateLimit-* or Retry-After headers; the wrapped v5 store must not either,
// on an allowed request and on a denied one.
func TestQuietRateStore_NoRateLimitHeaders(t *testing.T) {
	e := echo.New()
	e.Use(middleware.RateLimiterWithConfig(middleware.RateLimiterConfig{
		Store: QuietRateStore(middleware.NewRateLimiterMemoryStoreWithConfig(
			middleware.RateLimiterMemoryStoreConfig{Rate: 0.001, Burst: 1})),
	}))
	e.GET("/", func(c *echo.Context) error { return c.NoContent(http.StatusNoContent) })

	for i, want := range []int{http.StatusNoContent, http.StatusTooManyRequests} {
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/", nil))
		if rec.Code != want {
			t.Fatalf("request %d: status %d, want %d", i, rec.Code, want)
		}
		for _, h := range []string{"X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"} {
			if v := rec.Header().Get(h); v != "" {
				t.Errorf("request %d: %s = %q, want no header", i, h, v)
			}
		}
	}
}
