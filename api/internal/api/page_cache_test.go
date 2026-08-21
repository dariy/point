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
