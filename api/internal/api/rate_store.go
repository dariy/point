package api

import "github.com/labstack/echo/v5/middleware"

// allowOnlyStore hides the AllowContext method of the wrapped store.
type allowOnlyStore struct{ s middleware.RateLimiterStore }

func (a allowOnlyStore) Allow(identifier string) (bool, error) { return a.s.Allow(identifier) }

// QuietRateStore wraps a rate limiter store so that the limiter calls only
// Allow. The echo/v5 RateLimiterMemoryStore also implements AllowContext,
// which adds X-RateLimit-Limit, X-RateLimit-Remaining and Retry-After to each
// response. echo v4 sent none of these headers; this keeps the responses
// unchanged.
func QuietRateStore(s middleware.RateLimiterStore) middleware.RateLimiterStore {
	return allowOnlyStore{s}
}
