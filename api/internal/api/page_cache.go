package api

import (
	"context"
	"crypto/sha256"
	"fmt"
	"net/http"
	"time"

	"point-api/internal/services"

	"github.com/labstack/echo/v4"
)

// pageCacheTTL is how long a rendered public page stays servable. It is short
// because it is a backstop: every write that could change what a guest sees
// calls InvalidatePublicPages, so the TTL only has to bound the drift from the
// things that do not — settings edits, and the clock passing a scheduled post's
// publish time.
const pageCacheTTL = 15 * time.Minute

// pageContentType is what a BFF page payload is served as, cached or not. Echo
// has deprecated its charset-bearing constant, but this is the exact value the
// cache-hit path has always emitted and there is no reason for a hit and a miss
// to differ.
const pageContentType = "application/json; charset=utf-8"

// pageCacheKey turns a composed cache identity into a filename-safe key.
//
// The identity carries user-controlled input — a tag slug, the breadcrumb
// `path` chain — which cannot be embedded in a filename directly: CacheService
// rejects any key containing a separator, and it rejected every path-scoped tag
// page for exactly that reason, silently, because both Get and Set errors were
// discarded. Hashing keeps the key opaque and fixed-width, and leaves
// CacheService's traversal guard as belt-and-braces rather than load-bearing.
//
// The prefix stays readable so the cache directory can still be reasoned about
// by eye.
func pageCacheKey(prefix, identity string) string {
	return fmt.Sprintf("%s_%x.json", prefix, sha256.Sum256([]byte(identity)))
}

// servePageJSON answers a BFF page request with render's payload, going through
// the shared cache when cacheable says every anonymous visitor would get the
// same bytes.
//
// One call site per handler is the point. The cache used to be a lookup at the
// top and a write two hundred lines below it, with the key composed twice and
// both errors discarded — which is how a tag-page key that could never be
// stored stayed dead without anyone noticing. Here the key is named once, and
// the miss path is CacheService's problem, coalescing included.
func servePageJSON(c echo.Context, cache *services.CacheService, key string, cacheable bool, render func(context.Context) ([]byte, error)) error {
	ctx := c.Request().Context()

	var data []byte
	var err error
	if cacheable {
		data, err = cache.GetOrRender(ctx, key, pageCacheTTL, render)
	} else {
		data, err = render(ctx)
	}
	if err != nil {
		return err
	}
	return c.Blob(http.StatusOK, pageContentType, data)
}
