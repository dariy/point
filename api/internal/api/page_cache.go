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

// gridPageSizes is the ladder a public grid's per_page is snapped down to, in
// ascending order.
//
// per_page on the home feed and the tag archives is not a user setting: the
// client measures the viewport and asks for exactly the columns x rows that
// fit, so every distinct window size is a distinct number, and a hand-written
// query string can be any int32 at all. Both land in the cache key. Unbucketed
// that means an entry per pixel-height of browser window — a cache that grows
// with the audience rather than with the content, and one an attacker can grow
// on purpose by walking per_page.
//
// The steps are fine at the bottom, where a phone's grid is one or two columns
// and a single card matters, and coarser at the top, where a fit that large
// implies five or six columns. Snapping *down* is what makes that safe: the
// client sized the grid so the paginator and footer stay on screen, and fewer
// posts than it asked for keeps that true, where more would push them off. The
// cost is at most a partial row of empty space, and the return is that the
// visitors either side of a boundary share one rendered entry instead of
// missing separately.
var gridPageSizes = []int32{1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 28, 32, 36, 40, 45, 50, 55, 60}

// clampGridPageSize snaps a requested per_page down to the nearest value the
// page cache is willing to key on.
//
// sitePerPage — the blog's own `posts_per_page` — is allowed through as-is
// alongside the ladder. It is what a client that sends no per_page at all gets
// handed, and silently serving nine posts to a blog configured for ten would be
// the clamp changing a setting rather than bounding a key space. It is one
// extra value, set by the owner, so it costs the key space nothing.
func clampGridPageSize(perPage, sitePerPage int32) int32 {
	if perPage < 1 {
		return 1
	}
	best := gridPageSizes[0]
	for _, v := range gridPageSizes {
		if v > perPage {
			break
		}
		best = v
	}
	if sitePerPage > best && sitePerPage <= perPage {
		best = sitePerPage
	}
	return best
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
