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

// maxGridPageSize is the most posts one feed request may ask for.
//
// It is a resource guard, not a layout decision: per_page reaches the query
// straight from the URL, so without a ceiling a hand-written ?per_page=2000000
// is a full-table scan rendered to JSON. Sixty is comfortably above any real
// viewport fit — six columns of ten rows — so no grid the client measures ever
// meets it, and the only requests it truncates are ones no browser produced.
//
// It also bounds the page cache's key space as a side effect. per_page is part
// of every feed cache key, and capping it means at most sixty values per page
// number rather than one per pixel of browser-window height. That is the whole
// of the server's interest in per_page: the number of posts to return is the
// client's business, because only the client knows its column count, and a
// server that returns eight for a nine-cell grid is making a layout decision it
// cannot see the inputs to.
const maxGridPageSize = 60

// clampGridPageSize bounds a requested per_page to something the server is
// willing to render. Within the ceiling the request is honoured exactly — a
// 3x3 grid asking for 9 gets 9, and a 2x4 and a 4x2 grid both asking for 8 get
// the same 8, because from here they are the same request.
func clampGridPageSize(perPage int32) int32 {
	if perPage < 1 {
		return 1
	}
	if perPage > maxGridPageSize {
		return maxGridPageSize
	}
	return perPage
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
