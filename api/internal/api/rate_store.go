package api

import (
	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

// quietStore passes the decision to the wrapped store and removes the
// X-RateLimit-* headers that the wrapped store sets.
type quietStore struct{ s middleware.RateLimiterStore }

func (q quietStore) Allow(identifier string) (bool, error) { return q.s.Allow(identifier) }

// AllowContext lets the wrapped store set its headers, then removes the
// X-RateLimit-* headers. Retry-After stays: the store sets it only on a
// denied request, as an integer number of seconds.
func (q quietStore) AllowContext(c *echo.Context, identifier string) (bool, error) {
	sc, ok := q.s.(middleware.RateLimiterStoreContext)
	if !ok {
		return q.s.Allow(identifier)
	}
	allow, err := sc.AllowContext(c, identifier)
	h := c.Response().Header()
	h.Del(middleware.HeaderXRateLimitLimit)
	h.Del(middleware.HeaderXRateLimitRemaining)
	return allow, err
}

// QuietRateStore wraps a rate limiter store so that a 429 tells the client
// when to try again, but no response tells the client its limit or budget.
//
// The echo/v5 RateLimiterMemoryStore sets X-RateLimit-Limit and
// X-RateLimit-Remaining on each response, and Retry-After on a 429. Point
// keeps Retry-After (it helps API and MCP clients back off) and removes the
// X-RateLimit-* headers (they tell a scraper its budget). Decision of
// 2026-11-28, bead p-rhx6i.
func QuietRateStore(s middleware.RateLimiterStore) middleware.RateLimiterStore {
	return quietStore{s}
}
