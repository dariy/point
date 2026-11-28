package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"point-api/internal/plugins"

	"github.com/labstack/echo/v5"
	"github.com/labstack/echo/v5/middleware"
)

// TestRateLimitHeaders_EachLimiter drives each rate limiter past its burst.
// Decision of bead p-rhx6i: a 429 has Retry-After (an integer number of
// seconds), and no response has X-RateLimit-*. A response that is not a 429
// has no rate limit header.
func TestRateLimitHeaders_EachLimiter(t *testing.T) {
	repo, cfg := newEchoWithRepo(t)
	svcs := initServices(&cfg, repo)
	if err := svcs.Settings.SetSetting(context.Background(), plugins.EnabledKey("mcp"), "true", "string"); err != nil {
		t.Fatalf("enable mcp plugin: %v", err)
	}
	e := setupEcho(cfg, repo, svcs)

	for _, tc := range []struct {
		name, method, path, ip string
		max                    int
	}{
		{"public", http.MethodGet, "/api/settings/public", "203.0.113.20:5555", 260},
		{"credential", http.MethodPost, "/api/auth/login", "203.0.113.21:5555", 30},
		{"graph", http.MethodGet, "/api/pages/graph", "203.0.113.22:5555", 40},
		{"mcp-oauth", http.MethodPost, "/oauth/authorize", "203.0.113.23:5555", 30},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for i := 0; i < tc.max; i++ {
				var body *strings.Reader
				if tc.method == http.MethodPost {
					body = strings.NewReader("{}")
				} else {
					body = strings.NewReader("")
				}
				req := httptest.NewRequest(tc.method, tc.path, body)
				req.Header.Set(echo.HeaderContentType, echo.MIMEApplicationJSON)
				req.RemoteAddr = tc.ip
				rec := httptest.NewRecorder()
				e.ServeHTTP(rec, req)
				checkRateLimitHeaders(t, rec)
				if rec.Code == http.StatusTooManyRequests {
					if i == 0 {
						t.Fatal("first request got 429")
					}
					return
				}
			}
			t.Fatalf("no 429 after %d requests", tc.max)
		})
	}
}

func checkRateLimitHeaders(t *testing.T, rec *httptest.ResponseRecorder) {
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
