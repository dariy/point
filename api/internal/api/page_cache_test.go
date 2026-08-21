package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// TestPageCacheKey pins the two properties the key composition has to hold:
// the key is filename-safe whatever the visitor typed, and two different
// identities never collide onto one entry.
func TestPageCacheKey(t *testing.T) {
	dirty := pageCacheKey("tagpage", "kyiv_path-location/ukraine_p1_pp12")
	if strings.ContainsAny(dirty, "/\\") {
		t.Errorf("key must not contain a separator, got %q", dirty)
	}
	if !strings.HasPrefix(dirty, "tagpage_") || !strings.HasSuffix(dirty, ".json") {
		t.Errorf("key lost its readable prefix or suffix: %q", dirty)
	}
	if same := pageCacheKey("tagpage", "kyiv_path-location/ukraine_p1_pp12"); same != dirty {
		t.Errorf("key is not stable: %q vs %q", same, dirty)
	}
	if other := pageCacheKey("tagpage", "kyiv_path-_p1_pp12"); other == dirty {
		t.Error("distinct identities collided onto one key")
	}
	if home := pageCacheKey("homepage", "kyiv_path-location/ukraine_p1_pp12"); home == dirty {
		t.Error("distinct prefixes collided onto one key")
	}
}

// TestClampGridPageSize pins the two things the clamp has to get right: it
// never hands back more posts than were asked for (a grid sized to keep the
// footer on screen must not be overfilled), and it collapses the continuum of
// viewport-fitted values onto a small set so the cache is keyed by bucket
// rather than by browser-window height.
func TestClampGridPageSize(t *testing.T) {
	const site = 10

	tests := []struct {
		name       string
		perPage    int32
		sitePerPag int32
		want       int32
	}{
		{"exact ladder value passes through", 12, site, 12},
		{"between ladder values snaps down", 17, site, 15},
		{"just under a step snaps down", 59, site, 55},
		{"small fits are exact", 4, site, 4},
		{"one is the floor", 1, site, 1},
		{"non-positive is floored", 0, site, 1},
		{"above the ladder is capped", 1000000, site, 60},
		{"max int32 is capped", 2147483647, site, 60},
		{"site setting passes through even off-ladder", 7, 7, 7},
		{"site setting does not raise a smaller request", 5, 7, 5},
		{"site setting is not preferred over a higher ladder value", 9, 7, 8},
		{"site setting above the ladder is honoured", 100, 100, 100},
		{"site setting above the ladder still caps a bigger request", 500, 100, 100},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := clampGridPageSize(tt.perPage, tt.sitePerPag)
			if got != tt.want {
				t.Errorf("clampGridPageSize(%d, %d) = %d, want %d", tt.perPage, tt.sitePerPag, got, tt.want)
			}
			if tt.perPage >= 1 && got > tt.perPage {
				t.Errorf("clamp returned %d for a request of %d — a grid must never be overfilled", got, tt.perPage)
			}
		})
	}
}

// The key space the cache has to hold is the point of the clamp: without it,
// every per_page a client can name is its own entry.
func TestClampGridPageSize_BoundsTheKeySpace(t *testing.T) {
	seen := map[int32]bool{}
	for pp := int32(1); pp <= 5000; pp++ {
		seen[clampGridPageSize(pp, 10)] = true
	}
	if len(seen) > len(gridPageSizes) {
		t.Errorf("clamp produced %d distinct values from 5000 inputs, ladder has %d", len(seen), len(gridPageSizes))
	}
}

// TestServePageJSON covers the two routes through the one call site each page
// handler now has: a cacheable request is stored and served from the cache on
// the next visit, an uncacheable one renders every time and leaves nothing
// behind.
func TestServePageJSON(t *testing.T) {
	e := echo.New()
	key := pageCacheKey("homepage", "p1_pp12")

	serve := func(cache *services.CacheService, cacheable bool, render func(context.Context) ([]byte, error)) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		c := e.NewContext(httptest.NewRequest(http.MethodGet, "/api/pages/home", nil), rec)
		if err := servePageJSON(c, cache, key, cacheable, render); err != nil {
			t.Fatalf("servePageJSON: %v", err)
		}
		return rec
	}

	t.Run("cacheable request renders once and is stored", func(t *testing.T) {
		dir := t.TempDir()
		cache := services.NewCacheService(dir)
		renders := 0
		render := func(context.Context) ([]byte, error) {
			renders++
			return []byte(`{"posts":[]}`), nil
		}

		rec := serve(cache, true, render)
		if rec.Body.String() != `{"posts":[]}` {
			t.Errorf("body = %q", rec.Body.String())
		}
		if ct := rec.Header().Get(echo.HeaderContentType); ct != pageContentType {
			t.Errorf("content type = %q, want %q", ct, pageContentType)
		}
		if _, err := os.ReadFile(filepath.Join(dir, "cache", key)); err != nil {
			t.Fatalf("cache entry not written: %v", err)
		}

		serve(cache, true, render)
		if renders != 1 {
			t.Errorf("rendered %d times, want 1 — the second request should have hit the cache", renders)
		}
	})

	t.Run("uncacheable request is never stored", func(t *testing.T) {
		dir := t.TempDir()
		cache := services.NewCacheService(dir)
		renders := 0
		render := func(context.Context) ([]byte, error) {
			renders++
			return []byte(`{"posts":[]}`), nil
		}

		serve(cache, false, render)
		serve(cache, false, render)

		if renders != 2 {
			t.Errorf("rendered %d times, want 2 — an owner view must not be cached", renders)
		}
		if entries, err := os.ReadDir(filepath.Join(dir, "cache")); err != nil || len(entries) != 0 {
			t.Errorf("cache dir should be empty, got %v (err %v)", entries, err)
		}
	})

	t.Run("a render failure reaches the caller", func(t *testing.T) {
		dir := t.TempDir()
		cache := services.NewCacheService(dir)
		rec := httptest.NewRecorder()
		c := e.NewContext(httptest.NewRequest(http.MethodGet, "/api/pages/home", nil), rec)

		want := echo.NewHTTPError(http.StatusNotFound, "Tag not found")
		err := servePageJSON(c, cache, key, true, func(context.Context) ([]byte, error) {
			return nil, want
		})
		if !errors.Is(err, want) {
			t.Errorf("err = %v, want %v", err, want)
		}
		if entries, _ := os.ReadDir(filepath.Join(dir, "cache")); len(entries) != 0 {
			t.Error("a failed render must not leave a cache entry behind")
		}
	})
}
