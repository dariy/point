package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
)

// TestVisibilityCache_LiveCORSChain wires echo exactly as main.go does — global
// CORS (which adds `Vary: Origin`) with route-level visibilityCache inside it —
// and confirms the real chain leaves an anonymous GET edge-cacheable: Origin is
// gone from Vary. This is the empirical proof of the middleware ordering the
// strip depends on (global runs outside route middleware).
func TestVisibilityCache_LiveCORSChain(t *testing.T) {
	e := echo.New()
	e.Use(middleware.CORSWithConfig(middleware.CORSConfig{
		AllowOrigins: []string{"*"},
		AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders: []string{"*"},
	}))
	e.GET("/api/posts", func(c echo.Context) error { return c.NoContent(http.StatusOK) }, visibilityCache)

	req := httptest.NewRequest(http.MethodGet, "/api/posts", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if cc := rec.Header().Get("Cache-Control"); cc != guestCC {
		t.Fatalf("Cache-Control: expected %q, got %q", guestCC, cc)
	}
	for _, v := range rec.Header().Values("Vary") {
		if v == "Origin" {
			t.Errorf("Vary still contains Origin (uncacheable at CF): %v", rec.Header().Values("Vary"))
		}
	}
}

// runVisibilityCache drives the visibilityCache middleware for a request built
// from the given method/path/mutators and returns the Cache-Control it set. The
// wrapped handler is a no-op 200 so we observe only the header the middleware
// decides — mirroring how a real public read handler leaves Cache-Control alone.
func runVisibilityCache(t *testing.T, method, path string, mutate func(*http.Request)) string {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(method, path, nil)
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	h := visibilityCache(func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	if err := h(c); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return rec.Header().Get("Cache-Control")
}

func withSessionCookie(r *http.Request) {
	r.AddCookie(&http.Cookie{Name: "session", Value: "abc123"})
}

func withEmptySessionCookie(r *http.Request) {
	r.AddCookie(&http.Cookie{Name: "session", Value: ""})
}

func withBearer(r *http.Request) {
	r.Header.Set("Authorization", "Bearer sometoken")
}

const guestCC = "public, s-maxage=60, max-age=0"
const authedCC = "private, no-store"

func TestVisibilityCache_GuestGet_Public(t *testing.T) {
	if cc := runVisibilityCache(t, http.MethodGet, "/posts/hello", nil); cc != guestCC {
		t.Errorf("guest GET: expected %q, got %q", guestCC, cc)
	}
}

func TestVisibilityCache_GuestGet_PublicAPIPaths(t *testing.T) {
	// The real public read routes these changes attach visibilityCache to: an
	// anonymous GET on each must be edge-cacheable.
	for _, p := range []string{
		"/api/posts",
		"/api/posts/slug/hello",
		"/api/pages/home",
		"/api/timeline",
		"/api/tags",
		"/api/settings/public",
		"/api/themes/active",
	} {
		if cc := runVisibilityCache(t, http.MethodGet, p, nil); cc != guestCC {
			t.Errorf("guest GET %s: expected %q, got %q", p, guestCC, cc)
		}
	}
}

func TestVisibilityCache_MalformedAuthHeader_TreatedAsGuest(t *testing.T) {
	// isGuestRequest only rejects the exact "Bearer " prefix, matching the auth
	// middleware's case-sensitive parse (middleware.go). A non-Bearer or
	// wrong-case header is not a recognized credential, so the request is
	// effectively anonymous and its response is safe to share.
	for _, h := range []string{"Basic dXNlcjpwYXNz", "bearer lowercase", "Bearer"} {
		mutate := func(r *http.Request) { r.Header.Set("Authorization", h) }
		if cc := runVisibilityCache(t, http.MethodGet, "/api/posts", mutate); cc != guestCC {
			t.Errorf("Authorization %q: expected %q, got %q", h, guestCC, cc)
		}
	}
}

func TestVisibilityCache_EmptySessionCookie_TreatedAsGuest(t *testing.T) {
	// hasSession requires a non-empty value, so an empty session cookie is still a guest.
	if cc := runVisibilityCache(t, http.MethodGet, "/", withEmptySessionCookie); cc != guestCC {
		t.Errorf("empty-cookie GET: expected %q, got %q", guestCC, cc)
	}
}

func TestVisibilityCache_SessionCookie_NoStore(t *testing.T) {
	if cc := runVisibilityCache(t, http.MethodGet, "/", withSessionCookie); cc != authedCC {
		t.Errorf("session GET: expected %q, got %q", authedCC, cc)
	}
}

func TestVisibilityCache_BearerKey_NoStore(t *testing.T) {
	if cc := runVisibilityCache(t, http.MethodGet, "/api/posts", withBearer); cc != authedCC {
		t.Errorf("bearer GET: expected %q, got %q", authedCC, cc)
	}
}

func TestVisibilityCache_AdminPath_NoStore(t *testing.T) {
	// A guest requesting an admin path must not get a shareable response — the
	// admin shell differs from the public one (head_html gate).
	for _, p := range []string{"/light", "/light/posts", "/setup"} {
		if cc := runVisibilityCache(t, http.MethodGet, p, nil); cc != authedCC {
			t.Errorf("admin path %s: expected %q, got %q", p, authedCC, cc)
		}
	}
}

func TestVisibilityCache_NonGetMethods_NoStore(t *testing.T) {
	// Even an anonymous write is never marked public; only GET is edge-cacheable.
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete} {
		if cc := runVisibilityCache(t, m, "/api/posts", nil); cc != authedCC {
			t.Errorf("%s: expected %q, got %q", m, authedCC, cc)
		}
	}
}

// runVisibilityCacheVary drives the middleware with a pre-set Vary header
// (simulating the global CORS middleware having already run) and returns the
// resulting Vary values on the response.
func runVisibilityCacheVary(t *testing.T, mutate func(*http.Request), presetVary []string) []string {
	t.Helper()
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/api/posts", nil)
	if mutate != nil {
		mutate(req)
	}
	rec := httptest.NewRecorder()
	for _, v := range presetVary {
		rec.Header().Add("Vary", v)
	}
	c := e.NewContext(req, rec)
	h := visibilityCache(func(c echo.Context) error { return c.NoContent(http.StatusOK) })
	if err := h(c); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	return rec.Header().Values("Vary")
}

func TestVisibilityCache_Guest_StripsVaryOrigin(t *testing.T) {
	// CORS sets `Vary: Origin`; Cloudflare will not cache a response whose Vary
	// lists anything but Accept-Encoding, so the guest branch must drop Origin
	// while preserving Accept-Encoding.
	got := runVisibilityCacheVary(t, nil, []string{"Origin", "Accept-Encoding"})
	if len(got) != 1 || got[0] != "Accept-Encoding" {
		t.Errorf("guest Vary: expected [Accept-Encoding], got %v", got)
	}
}

func TestVisibilityCache_Guest_StripsVaryOrigin_Combined(t *testing.T) {
	// A single combined header value must also be split and filtered.
	got := runVisibilityCacheVary(t, nil, []string{"Origin, Accept-Encoding"})
	if len(got) != 1 || got[0] != "Accept-Encoding" {
		t.Errorf("guest combined Vary: expected [Accept-Encoding], got %v", got)
	}
}

func TestVisibilityCache_Guest_OriginOnlyVary_Removed(t *testing.T) {
	// If Origin is the only value, Vary is removed entirely (an empty Vary would
	// itself keep the response uncacheable on some caches).
	got := runVisibilityCacheVary(t, nil, []string{"Origin"})
	if len(got) != 0 {
		t.Errorf("guest Origin-only Vary: expected none, got %v", got)
	}
}

func TestVisibilityCache_Authed_VaryUntouched(t *testing.T) {
	// The strip is guest-only; an authed (no-store) response is left as-is. It is
	// never cached regardless, so there is no need to rewrite its Vary.
	got := runVisibilityCacheVary(t, withSessionCookie, []string{"Origin"})
	if len(got) != 1 || got[0] != "Origin" {
		t.Errorf("authed Vary: expected [Origin] untouched, got %v", got)
	}
}

func TestVisibilityCache_HandlerCacheControlWins(t *testing.T) {
	// serveSimplifiedMedia sets its own Cache-Control after the middleware; the
	// handler's value must survive (middleware sets before the handler runs).
	e := echo.New()
	req := httptest.NewRequest(http.MethodGet, "/2026/07/photo.jpg", nil)
	rec := httptest.NewRecorder()
	c := e.NewContext(req, rec)
	h := visibilityCache(func(c echo.Context) error {
		c.Response().Header().Set("Cache-Control", "public, max-age=300, s-maxage=86400")
		return c.NoContent(http.StatusOK)
	})
	if err := h(c); err != nil {
		t.Fatalf("handler error: %v", err)
	}
	const want = "public, max-age=300, s-maxage=86400"
	if cc := rec.Header().Get("Cache-Control"); cc != want {
		t.Errorf("handler override: expected %q, got %q", want, cc)
	}
}
